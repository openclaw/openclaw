import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { InboxEntry, ReefDeliveryRejection } from "./types.js";

type ResolveAgentRouteParams = Parameters<
  PluginRuntime["channel"]["routing"]["resolveAgentRoute"]
>[0];

export interface ReefOwnerNotice {
  text: string;
  contextKey: string;
  peer?: string;
  wakeAgent?: boolean;
}

const MAX_REJECTION_PEERS = 1_024;
const REJECTION_WAKE_COOLDOWN_MS = 15 * 60 * 1_000;
const REJECTION_NOTICE_RETRY_MS = 1_000;

interface ReefReceiptNotifierOptions {
  now?: () => number;
  schedule?: (task: () => Promise<void>, delayMs: number) => void;
  onError?: (error: unknown, receiptId: string) => void;
}

interface ReefPeerNoticeState {
  lastRejectionAt?: number;
  lastWakeAt?: number;
  retry?: ReefNoticeRetry;
}

type ReefNoticeRetry =
  | {
      kind: "notify";
      generation: symbol;
      rejection: ReefDeliveryRejection;
      notice: ReefOwnerNotice;
      covered: ReefDeliveryRejection[];
      cleanup: ReefDeliveryRejection[];
    }
  | {
      kind: "complete";
      generation: symbol;
      pending: ReefDeliveryRejection[];
    };

function scheduleNoticeRetry(task: () => Promise<void>, delayMs: number): void {
  setTimeout(() => void task(), delayMs).unref();
}

export class ReefReceiptNotifier {
  private readonly noticed = new Set<string>();
  private readonly peerStates = new Map<string, ReefPeerNoticeState>();
  private readonly peerQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly notify: (notice: ReefOwnerNotice) => Promise<void>,
    private readonly complete: (rejection: ReefDeliveryRejection) => void,
    private readonly options: ReefReceiptNotifierOptions = {},
  ) {}

  async notifyRejections(rejections: readonly ReefDeliveryRejection[]): Promise<void> {
    for (const rejection of rejections) {
      await this.runForPeer(rejection.peer, () => this.notifyRejection(rejection));
    }
  }

  private async notifyRejection(rejection: ReefDeliveryRejection): Promise<void> {
    if (this.noticed.has(rejection.id)) {
      return;
    }
    // Flow already atomically bound this rejection to a durable outbound record.
    // This secondary bound prevents a duplicate callback from waking twice.
    this.noticed.add(rejection.id);
    if (this.noticed.size > MAX_REJECTION_PEERS) {
      const oldest = this.noticed.values().next().value;
      if (oldest !== undefined) {
        this.noticed.delete(oldest);
      }
    }
    const now = this.now();
    const state = this.touchPeerState(rejection.peer);
    const previousRetry = state.retry;
    state.retry = undefined;
    const covered =
      previousRetry?.kind === "notify"
        ? this.uniqueRejections([...previousRetry.covered, previousRetry.rejection])
        : [];
    const cleanup =
      previousRetry?.kind === "notify"
        ? previousRetry.cleanup
        : previousRetry?.kind === "complete"
          ? previousRetry.pending
          : [];
    const repeatedRejection =
      state.lastRejectionAt !== undefined &&
      now - state.lastRejectionAt < REJECTION_WAKE_COOLDOWN_MS;
    const wakeAgent =
      state.lastWakeAt === undefined || now - state.lastWakeAt >= REJECTION_WAKE_COOLDOWN_MS;
    state.lastRejectionAt = now;
    const guardRejected = rejection.category === "guard_deny";
    const notice: ReefOwnerNotice = {
      text: guardRejected
        ? repeatedRejection
          ? `Another Reef message to @${rejection.peer} was rejected by the peer's inbound guard (message ${rejection.id}). Stop automatic retries and wait for owner guidance.`
          : `Your Reef message to @${rejection.peer} was rejected by the peer's inbound guard (message ${rejection.id}). Rephrase it at most once and resend if still appropriate; do not retry unchanged text. If that retry is also rejected, stop and wait for owner guidance.`
        : repeatedRejection
          ? `Another Reef message to @${rejection.peer} was rejected before delivery (message ${rejection.id}). Stop automatic retries and wait for owner guidance.`
          : `Your Reef message to @${rejection.peer} was rejected before delivery (message ${rejection.id}).`,
      peer: rejection.peer,
      contextKey: `reef:delivery-rejected:${rejection.id}`,
      wakeAgent,
    };
    if (!(await this.notifyOnce(notice, rejection.id))) {
      this.scheduleNotifyRetry(rejection.peer, state, notice, rejection, covered, cleanup);
      return;
    }
    this.commitWake(state, notice);
    const pending = this.completeRejections([...cleanup, ...covered, rejection]);
    if (pending.length > 0) {
      this.scheduleCompletionRetry(rejection.peer, state, pending);
    }
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }

  private touchPeerState(peer: string): ReefPeerNoticeState {
    const state = this.peerStates.get(peer) ?? {};
    this.peerStates.delete(peer);
    this.peerStates.set(peer, state);
    if (this.peerStates.size > MAX_REJECTION_PEERS) {
      const oldest = this.peerStates.keys().next().value;
      if (oldest !== undefined) {
        this.peerStates.delete(oldest);
      }
    }
    return state;
  }

  private runForPeer(peer: string, task: () => Promise<void>): Promise<void> {
    const previous = this.peerQueues.get(peer) ?? Promise.resolve();
    const current = previous.then(task, task);
    this.peerQueues.set(peer, current);
    return current.finally(() => {
      if (this.peerQueues.get(peer) === current) {
        this.peerQueues.delete(peer);
      }
    });
  }

  private commitWake(state: ReefPeerNoticeState, notice: ReefOwnerNotice): void {
    if (notice.wakeAgent) {
      // The cooldown starts only after the event and heartbeat are accepted.
      // Failed notice delivery must leave the next receipt eligible to wake.
      state.lastWakeAt = this.now();
    }
  }

  private async notifyOnce(notice: ReefOwnerNotice, receiptId: string): Promise<boolean> {
    try {
      await this.notify(notice);
      return true;
    } catch (error) {
      this.reportError(error, receiptId);
      return false;
    }
  }

  private completeRejections(
    rejections: readonly ReefDeliveryRejection[],
  ): ReefDeliveryRejection[] {
    const pending: ReefDeliveryRejection[] = [];
    for (const rejection of this.uniqueRejections(rejections)) {
      try {
        this.complete(rejection);
      } catch (error) {
        this.reportError(error, rejection.id);
        pending.push(rejection);
      }
    }
    return pending;
  }

  private uniqueRejections(rejections: readonly ReefDeliveryRejection[]): ReefDeliveryRejection[] {
    const unique = new Map<string, ReefDeliveryRejection>();
    for (const rejection of rejections) {
      unique.set(`${rejection.peer}\n${rejection.id}`, rejection);
    }
    return [...unique.values()];
  }

  private scheduleNotifyRetry(
    peer: string,
    state: ReefPeerNoticeState,
    notice: ReefOwnerNotice,
    rejection: ReefDeliveryRejection,
    covered: ReefDeliveryRejection[],
    cleanup: ReefDeliveryRejection[],
  ): void {
    const retryGeneration = Symbol(rejection.id);
    state.retry = {
      kind: "notify",
      generation: retryGeneration,
      rejection,
      notice,
      covered,
      cleanup,
    };
    const schedule = this.options.schedule ?? scheduleNoticeRetry;
    try {
      schedule(
        () =>
          this.runForPeer(peer, async () => {
            if (
              this.peerStates.get(peer) !== state ||
              state.retry?.generation !== retryGeneration
            ) {
              return;
            }
            state.retry = undefined;
            const remainingCleanup = this.completeRejections(cleanup);
            if (!(await this.notifyOnce(notice, rejection.id))) {
              this.noticed.delete(rejection.id);
              for (const coveredRejection of covered) {
                this.noticed.delete(coveredRejection.id);
              }
              return;
            }
            this.commitWake(state, notice);
            const pending = this.completeRejections([...remainingCleanup, ...covered, rejection]);
            if (pending.length > 0) {
              this.scheduleCompletionRetry(peer, state, pending);
            }
          }),
        REJECTION_NOTICE_RETRY_MS,
      );
    } catch (scheduleError) {
      if (state.retry?.generation === retryGeneration) {
        state.retry = undefined;
      }
      this.noticed.delete(rejection.id);
      for (const coveredRejection of covered) {
        this.noticed.delete(coveredRejection.id);
      }
      this.reportError(scheduleError, rejection.id);
    }
  }

  private scheduleCompletionRetry(
    peer: string,
    state: ReefPeerNoticeState,
    pending: ReefDeliveryRejection[],
  ): void {
    const retryGeneration = Symbol("reef-notice-completion");
    state.retry = { kind: "complete", generation: retryGeneration, pending };
    const schedule = this.options.schedule ?? scheduleNoticeRetry;
    try {
      schedule(
        () =>
          this.runForPeer(peer, async () => {
            if (
              this.peerStates.get(peer) !== state ||
              state.retry?.generation !== retryGeneration
            ) {
              return;
            }
            state.retry = undefined;
            this.completeRejections(pending);
          }),
        REJECTION_NOTICE_RETRY_MS,
      );
    } catch (scheduleError) {
      if (state.retry?.generation === retryGeneration) {
        state.retry = undefined;
      }
      this.reportError(scheduleError, pending[0]?.id ?? "unknown");
    }
  }

  private reportError(error: unknown, receiptId: string): void {
    try {
      this.options.onError?.(error, receiptId);
    } catch {
      // Owner-notice failures never block the relay inbox cursor.
    }
  }
}

export async function processReefInboxEntriesInOrder(params: {
  entries: readonly InboxEntry[];
  processEntries: (entries: InboxEntry[]) => Promise<ReefDeliveryRejection[]>;
  notifyRejections: (rejections: readonly ReefDeliveryRejection[]) => Promise<void>;
  onNoticeError?: (error: unknown) => void;
}): Promise<void> {
  for (const entry of params.entries) {
    const rejections = await params.processEntries([entry]);
    try {
      await params.notifyRejections(rejections);
    } catch (error) {
      try {
        params.onNoticeError?.(error);
      } catch {
        // Notification diagnostics cannot hold the durable inbox cursor open.
      }
    }
  }
}

export function createReefOwnerNoticeHandler(params: {
  runtime: PluginRuntime;
  cfg: ResolveAgentRouteParams["cfg"];
  accountId: string;
  handle: string;
}): (notice: ReefOwnerNotice) => Promise<void> {
  return async (notice) => {
    const route = params.runtime.channel.routing.resolveAgentRoute({
      cfg: params.cfg,
      channel: "reef",
      accountId: params.accountId,
      peer: { kind: "direct", id: notice.peer ?? params.handle },
    });
    const queued = params.runtime.system.enqueueSystemEvent(notice.text, {
      sessionKey: route.sessionKey,
      contextKey: notice.contextKey,
    });
    if (!queued || !notice.wakeAgent) {
      return;
    }
    params.runtime.system.requestHeartbeat({
      source: "other",
      intent: "immediate",
      reason: "reef:delivery-rejected",
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });
  };
}
