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

export class ReefReceiptNotifier {
  private readonly noticed = new Set<string>();

  constructor(
    private readonly trust: ReefTrustStore,
    private readonly notify: (notice: ReefOwnerNotice) => Promise<void>,
  ) {}

  async notifyVerified(entries: readonly InboxEntry[]): Promise<void> {
    for (const entry of entries) {
      const receipt = entry.receipt;
      const friend = entry.kind === "receipt" ? this.trust.get(entry.peer) : undefined;
      if (
        entry.kind !== "receipt" ||
        !receipt ||
        receipt.status !== "rejected" ||
        !friend ||
        !verifyReceipt(receipt, friend.ed25519PublicKey) ||
        this.noticed.has(receipt.id)
      ) {
        continue;
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
      try {
        const guardRejected = receipt.category === "guard_deny";
        await this.notify({
          text: guardRejected
            ? `Your Reef message to @${entry.peer} was rejected by the peer's inbound guard (message ${receipt.id}). Rephrase it once and resend if still appropriate; do not retry unchanged text.`
            : `Your Reef message to @${entry.peer} was rejected before delivery (message ${receipt.id}).`,
          peer: entry.peer,
          contextKey: `reef:delivery-rejected:${receipt.id}`,
          wakeAgent: true,
        });
      } catch (error) {
        this.noticed.delete(receipt.id);
        throw error;
      }
    }
  }
}

export async function processReefInboxEntriesInOrder(params: {
  entries: readonly InboxEntry[];
  notifyVerified: (entries: readonly InboxEntry[]) => Promise<void>;
  processEntries: (entries: InboxEntry[]) => Promise<void>;
}): Promise<void> {
  let noticeFailed = false;
  let firstNoticeError: unknown;
  for (const entry of params.entries) {
    try {
      await params.notifyVerified([entry]);
    } catch (error) {
      if (!noticeFailed) {
        noticeFailed = true;
        firstNoticeError = error;
      }
    }
    await params.processEntries([entry]);
  }
  if (noticeFailed) {
    // Keep the inbox cursor retryable without letting a failed owner wake
    // starve valid messages later in the same relay batch.
    throw firstNoticeError;
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
