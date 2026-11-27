import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import {
  acceptsAnnounceDeliveryResult,
  isDurableAnnounceDelivery,
  resolveAnnounceCleanupOutcome,
  type SubagentAnnounceFlowOutcome,
} from "./subagent-announce-obligation.js";

/** A committed transport receipt wins even when its persistence observer fails. */
type AnnounceObligation = {
  readonly outcome: SubagentAnnounceFlowOutcome;
  readonly reported: boolean;
  report(delivery: SubagentAnnounceDeliveryResult): Promise<void>;
  consume(): void;
};

type DetachedCompletionLifecycle<Completion> = {
  scope: object;
  key: string;
  isCurrent(): boolean;
  readiness(): "ready" | "waiting" | "blocked" | "unavailable";
  observeConsumption(assertCurrent: () => void): Promise<boolean>;
  deliver(
    completion: Completion,
    assertCurrent: () => void,
  ): Promise<SubagentAnnounceDeliveryResult & { recoveryBlocked?: true }>;
  retire(
    outcome: "consumed" | "undelivered" | "unavailable",
    assertCurrent: () => void,
  ): Promise<void>;
  settleExecution(): void;
  onError(error: unknown): void;
};

type DetachedCompletion<Completion> = {
  complete(completion: Completion): Promise<void>;
  consume(): void;
  join(): Promise<void>;
  isConsumed(): boolean;
  isRetiring(): boolean;
  release(): void;
};

export function createSubagentAnnounceObligation(
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void | Promise<void>,
): AnnounceObligation;
export function createSubagentAnnounceObligation<Completion>(
  onDeliveryResult: undefined,
  lifecycle: DetachedCompletionLifecycle<Completion>,
): DetachedCompletion<Completion>;
export function createSubagentAnnounceObligation<Completion>(
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void | Promise<void>,
  lifecycle?: DetachedCompletionLifecycle<Completion>,
): AnnounceObligation | DetachedCompletion<Completion> {
  let outcome: SubagentAnnounceFlowOutcome = "undelivered";
  let reported = false;
  const obligation: AnnounceObligation = {
    get outcome() {
      return outcome;
    },
    get reported() {
      return reported;
    },
    report: async (delivery: SubagentAnnounceDeliveryResult) => {
      if (reported) {
        return;
      }
      reported = true;
      outcome = delivery.delivered
        ? "delivered"
        : delivery.reason === "completion_handoff_pending" && delivery.path === "none"
          ? "requester_waiting"
          : delivery.path === "queued"
            ? "session_queued"
            : "undelivered";
      await onDeliveryResult?.(delivery);
    },
    consume() {
      outcome = resolveAnnounceCleanupOutcome(outcome, { delivered: true, handedOff: false });
      reported = true;
    },
  };
  return lifecycle ? registerDetachedCompletion(lifecycle, obligation) : obligation;
}

// Detached native results retain only delivery custody between attempts. Their
// six-delay budget predates the persisted registry's separate expiry policy.
const DETACHED_COMPLETION_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const detachedCompletionOwners = new WeakMap<object, Map<string, object>>();

function registerDetachedCompletion<Completion>(
  lifecycle: DetachedCompletionLifecycle<Completion>,
  obligation: AnnounceObligation,
): DetachedCompletion<Completion> {
  const owners = detachedCompletionOwners.get(lifecycle.scope) ?? new Map<string, object>();
  detachedCompletionOwners.set(lifecycle.scope, owners);
  const owner = {};
  let completion: Completion | undefined;
  let retiring = false;
  let released = false;
  let attemptCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const isConsumed = () => obligation.outcome === "delivered";
  const assertActive = () => {
    if (released || !lifecycle.isCurrent()) {
      throw new Error("Completion registration is no longer active");
    }
  };
  const claim = () => {
    if (released || !lifecycle.isCurrent()) {
      return false;
    }
    const current = owners.get(lifecycle.key);
    if (current && current !== owner) {
      return false;
    }
    owners.set(lifecycle.key, owner);
    return true;
  };
  const assertCurrent = () => {
    if (!claim()) {
      throw new Error("Completion delivery owner is no longer current");
    }
  };
  const release = () => {
    released = true;
    clearTimeout(timer);
    timer = undefined;
    if (owners.get(lifecycle.key) === owner) {
      owners.delete(lifecycle.key);
    }
  };
  const schedule = () => {
    if (released || timer || !lifecycle.isCurrent()) {
      return;
    }
    const delay =
      DETACHED_COMPLETION_RETRY_DELAYS_MS[
        Math.min(attemptCount, DETACHED_COMPLETION_RETRY_DELAYS_MS.length - 1)
      ]!;
    if (!retiring && !isConsumed()) {
      attemptCount += 1;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void resume();
    }, delay);
    timer.unref();
  };
  const retire = async () => {
    const consumed = isConsumed();
    try {
      await lifecycle.retire(consumed ? "consumed" : "undelivered", () => {
        assertCurrent();
        if (!consumed && isConsumed()) {
          throw new Error("Completion was consumed during retirement");
        }
      });
      release();
    } catch (error) {
      if (released || !lifecycle.isCurrent()) {
        return;
      }
      if (!consumed && isConsumed()) {
        await retire();
        return;
      }
      lifecycle.onError(error);
      schedule();
    }
  };
  const attempt = async () => {
    if (completion === undefined || released || timer || !lifecycle.isCurrent()) {
      return;
    }
    let waiting = false;
    try {
      if (!claim()) {
        await lifecycle.retire("unavailable", () => {});
        release();
        return;
      }
      if (lifecycle.readiness() === "blocked") {
        return;
      }
      if (await lifecycle.observeConsumption(assertCurrent)) {
        obligation.consume();
      }
      if (released || !lifecycle.isCurrent()) {
        return;
      }
      if (isConsumed()) {
        await retire();
        return;
      }
      if (retiring) {
        await retire();
        return;
      }
      const readiness = lifecycle.readiness();
      if (readiness === "unavailable") {
        await lifecycle.retire("unavailable", assertCurrent);
        release();
        return;
      }
      if (readiness === "waiting") {
        waiting = true;
        return;
      }
      const delivery = await lifecycle.deliver(completion, assertCurrent);
      if (released || !lifecycle.isCurrent()) {
        return;
      }
      if (isDurableAnnounceDelivery(delivery)) {
        obligation.consume();
      }
      if (!acceptsAnnounceDeliveryResult(delivery, { delivered: isConsumed(), handedOff: false })) {
        await retire();
        return;
      }
      retiring =
        delivery.recoveryBlocked === true ||
        attemptCount >= DETACHED_COMPLETION_RETRY_DELAYS_MS.length;
      if (retiring) {
        await retire();
      } else {
        schedule();
      }
    } catch (error) {
      if (!released && lifecycle.isCurrent()) {
        lifecycle.onError(error);
        retiring ||= attemptCount >= DETACHED_COMPLETION_RETRY_DELAYS_MS.length;
        if (retiring || isConsumed()) {
          await retire();
        } else {
          schedule();
        }
      }
    } finally {
      if (!waiting) {
        lifecycle.settleExecution();
      }
    }
  };
  const resume = (): Promise<void> => {
    if (inFlight) {
      return inFlight;
    }
    inFlight = Promise.resolve().then(attempt);
    const finished = () => {
      inFlight = undefined;
    };
    void inFlight.then(finished, finished);
    return inFlight;
  };
  return {
    complete(fact) {
      assertActive();
      completion = fact;
      return resume();
    },
    consume() {
      assertActive();
      if (!claim()) {
        return;
      }
      obligation.consume();
      clearTimeout(timer);
      timer = undefined;
      if (completion !== undefined) {
        void resume();
      }
    },
    join: async () => {
      await inFlight;
    },
    isConsumed,
    isRetiring: () => retiring,
    release,
  };
}
