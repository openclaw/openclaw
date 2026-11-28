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
  report: (delivery: SubagentAnnounceDeliveryResult) => Promise<void>;
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
  waitForDelivery(): Promise<void>;
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
type DetachedCompletionOwner = {
  obligation: AnnounceObligation;
  token?: object;
  wake: Set<() => void>;
  retiring: boolean;
  references: number;
};
const detachedCompletionOwners = new WeakMap<object, Map<string, DetachedCompletionOwner>>();

function registerDetachedCompletion<Completion>(
  lifecycle: DetachedCompletionLifecycle<Completion>,
  obligation: AnnounceObligation,
): DetachedCompletion<Completion> {
  const owners =
    detachedCompletionOwners.get(lifecycle.scope) ?? new Map<string, DetachedCompletionOwner>();
  detachedCompletionOwners.set(lifecycle.scope, owners);
  const shared: DetachedCompletionOwner = owners.get(lifecycle.key) ?? {
    obligation,
    wake: new Set(),
    retiring: false,
    references: 0,
  };
  owners.set(lifecycle.key, shared);
  shared.references += 1;
  const owner = {};
  let completion: Completion | undefined;
  let retiring = false;
  let released = false;
  let attemptCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const isConsumed = () => shared.obligation.outcome === "delivered";
  const assertActive = () => {
    if (released || !lifecycle.isCurrent()) {
      throw new Error("Completion registration is closed");
    }
  };
  const claim = () => {
    if (released || !lifecycle.isCurrent()) {
      return false;
    }
    if (shared.token && shared.token !== owner) {
      return false;
    }
    shared.token = owner;
    return true;
  };
  const assertCurrent = () => {
    if (!claim()) {
      throw new Error("Completion delivery owner is no longer current");
    }
  };
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    shared.wake.delete(wake);
    clearTimeout(timer);
    timer = undefined;
    if (shared.token === owner) {
      shared.token = undefined;
      for (const resumeObserver of shared.wake) {
        resumeObserver();
      }
    }
    if (--shared.references === 0 && owners.get(lifecycle.key) === shared) {
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
    // Native cleanup can release its handle before the persistence call returns.
    shared.retiring = true;
    const consumed = isConsumed();
    try {
      await lifecycle.retire(consumed ? "consumed" : "undelivered", () => {
        assertCurrent();
        if (!consumed && isConsumed()) {
          throw new Error("Completion was consumed during retirement");
        }
      });
      for (const resumeObserver of shared.wake) {
        resumeObserver();
      }
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
      if (shared.retiring && !shared.token && !isConsumed()) {
        await lifecycle.retire("unavailable", assertActive);
        release();
        return;
      }
      if (!claim()) {
        // A duplicate still observes native receipts while the delivery owner runs.
        if (isConsumed()) {
          await lifecycle.retire("consumed", assertActive);
          release();
        }
        return;
      }
      if (lifecycle.readiness() === "blocked") {
        return;
      }
      if (await lifecycle.observeConsumption(assertCurrent)) {
        shared.obligation.consume();
        for (const resumeObserver of shared.wake) {
          resumeObserver();
        }
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
        shared.obligation.consume();
        for (const resumeObserver of shared.wake) {
          resumeObserver();
        }
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
        if (lifecycle.readiness() === "unavailable") {
          await lifecycle.retire("unavailable", assertCurrent);
          release();
          return;
        }
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
  function wake() {
    clearTimeout(timer);
    timer = undefined;
    if (!released && completion !== undefined) {
      void resume();
    }
  }
  shared.wake.add(wake);
  return {
    complete(fact) {
      assertActive();
      completion = fact;
      return resume();
    },
    consume() {
      assertActive();
      shared.obligation.consume();
      for (const resumeObserver of shared.wake) {
        resumeObserver();
      }
    },
    waitForDelivery: async () => {
      await inFlight;
    },
    isConsumed,
    isRetiring: () => retiring,
    release,
  };
}
