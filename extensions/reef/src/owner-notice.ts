import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { verifyReceipt } from "../protocol/index.js";
import type { ReefTrustStore } from "./trust-store.js";
import type { InboxEntry } from "./types.js";

type ResolveAgentRouteParams = Parameters<
  PluginRuntime["channel"]["routing"]["resolveAgentRoute"]
>[0];

export interface ReefOwnerNotice {
  text: string;
  contextKey: string;
  peer?: string;
  wakeAgent?: boolean;
}

const MAX_REJECTION_NOTICES = 1_024;
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
  retryToken?: symbol;
}

function scheduleNoticeRetry(task: () => Promise<void>, delayMs: number): void {
  setTimeout(() => void task(), delayMs).unref();
}

export class ReefReceiptNotifier {
  private readonly noticed = new Set<string>();
  private readonly peerStates = new Map<string, ReefPeerNoticeState>();
  private readonly peerQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly trust: ReefTrustStore,
    private readonly notify: (notice: ReefOwnerNotice) => Promise<void>,
    private readonly options: ReefReceiptNotifierOptions = {},
  ) {}

  async notifyVerified(entries: readonly InboxEntry[]): Promise<void> {
    for (const entry of entries) {
      if (entry.kind !== "receipt") {
        continue;
      }
      await this.runForPeer(entry.peer, () => this.notifyVerifiedReceipt(entry));
    }
  }

  private async notifyVerifiedReceipt(entry: InboxEntry & { kind: "receipt" }): Promise<void> {
    const receipt = entry.receipt;
    const friend = this.trust.get(entry.peer);
    if (
      !receipt ||
      receipt.status !== "rejected" ||
      !friend ||
      !verifyReceipt(receipt, friend.ed25519PublicKey) ||
      this.noticed.has(receipt.id)
    ) {
      return;
    }
    // Relay reconnects can replay signed receipts. A bounded per-process memory
    // prevents retry storms while preserving per-entry verification before wake.
    this.noticed.add(receipt.id);
    if (this.noticed.size > MAX_REJECTION_NOTICES) {
      const oldest = this.noticed.values().next().value;
      if (oldest !== undefined) {
        this.noticed.delete(oldest);
      }
    }
    const now = this.now();
    const state = this.touchPeerState(entry.peer);
    const repeatedRejection =
      state.lastRejectionAt !== undefined &&
      now - state.lastRejectionAt < REJECTION_WAKE_COOLDOWN_MS;
    const wakeAgent =
      state.lastWakeAt === undefined || now - state.lastWakeAt >= REJECTION_WAKE_COOLDOWN_MS;
    state.lastRejectionAt = now;
    state.retryToken = undefined;
    const guardRejected = receipt.category === "guard_deny";
    const notice: ReefOwnerNotice = {
      text: guardRejected
        ? repeatedRejection
          ? `Another Reef message to @${entry.peer} was rejected by the peer's inbound guard (message ${receipt.id}). Stop automatic retries and wait for owner guidance.`
          : `Your Reef message to @${entry.peer} was rejected by the peer's inbound guard (message ${receipt.id}). Rephrase it at most once and resend if still appropriate; do not retry unchanged text. If that retry is also rejected, stop and wait for owner guidance.`
        : repeatedRejection
          ? `Another Reef message to @${entry.peer} was rejected before delivery (message ${receipt.id}). Stop automatic retries and wait for owner guidance.`
          : `Your Reef message to @${entry.peer} was rejected before delivery (message ${receipt.id}).`,
      peer: entry.peer,
      contextKey: `reef:delivery-rejected:${receipt.id}`,
      wakeAgent,
    };
    if (await this.deliverNotice(notice, receipt.id)) {
      this.commitWake(state, notice);
      return;
    }
    this.scheduleRetry(entry.peer, state, notice, receipt.id);
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }

  private touchPeerState(peer: string): ReefPeerNoticeState {
    const state = this.peerStates.get(peer) ?? {};
    this.peerStates.delete(peer);
    this.peerStates.set(peer, state);
    if (this.peerStates.size > MAX_REJECTION_NOTICES) {
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

  private async deliverNotice(notice: ReefOwnerNotice, receiptId: string): Promise<boolean> {
    try {
      await this.notify(notice);
      return true;
    } catch (error) {
      this.reportError(error, receiptId);
      return false;
    }
  }

  private scheduleRetry(
    peer: string,
    state: ReefPeerNoticeState,
    notice: ReefOwnerNotice,
    receiptId: string,
  ): void {
    const retryToken = Symbol(receiptId);
    state.retryToken = retryToken;
    const schedule = this.options.schedule ?? scheduleNoticeRetry;
    try {
      schedule(
        () =>
          this.runForPeer(peer, async () => {
            if (this.peerStates.get(peer) !== state || state.retryToken !== retryToken) {
              return;
            }
            state.retryToken = undefined;
            if (await this.deliverNotice(notice, receiptId)) {
              this.commitWake(state, notice);
            }
          }),
        REJECTION_NOTICE_RETRY_MS,
      );
    } catch (scheduleError) {
      if (state.retryToken === retryToken) {
        state.retryToken = undefined;
      }
      this.reportError(scheduleError, receiptId);
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
  notifyVerified: (entries: readonly InboxEntry[]) => Promise<void>;
  processEntries: (entries: InboxEntry[]) => Promise<void>;
  onNoticeError?: (error: unknown) => void;
}): Promise<void> {
  for (const entry of params.entries) {
    try {
      await params.notifyVerified([entry]);
    } catch (error) {
      try {
        params.onNoticeError?.(error);
      } catch {
        // Notification diagnostics cannot hold the durable inbox cursor open.
      }
    }
    await params.processEntries([entry]);
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
