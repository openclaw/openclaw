import { createHash } from "node:crypto";
import { createDurableInboundReceiveJournalFromQueue } from "openclaw/plugin-sdk/channel-outbound";
import { getAgentMailRuntime } from "./runtime.js";
import type { AgentMailIngressRecord } from "./types.js";

export const AGENTMAIL_DURABLE_PENDING_MAX_ENTRIES = 450;
export const AGENTMAIL_DURABLE_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AGENTMAIL_DURABLE_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createAgentMailDurableInboundId(params: {
  accountId: string;
  inboxId: string;
  messageId: string;
}): string {
  return digest(`${params.accountId}\n${params.inboxId}\n${params.messageId}`);
}

export function createAgentMailDurableInboundReceiveJournal(params: {
  accountId: string;
  inboxId: string;
}) {
  const runtime = getAgentMailRuntime();
  const queue = runtime.state.openChannelIngressQueue<AgentMailIngressRecord, undefined, undefined>(
    {
      accountId: digest(`${params.accountId}\n${params.inboxId}`).slice(0, 24),
      stateDir: runtime.state.resolveStateDir(),
    },
  );
  return createDurableInboundReceiveJournalFromQueue({
    queue,
    admission: { pendingMaxEntries: AGENTMAIL_DURABLE_PENDING_MAX_ENTRIES },
    retention: {
      pendingTtlMs: AGENTMAIL_DURABLE_PENDING_TTL_MS,
      completedTtlMs: AGENTMAIL_DURABLE_COMPLETED_TTL_MS,
      failedTtlMs: AGENTMAIL_DURABLE_PENDING_TTL_MS,
      failedMaxEntries: AGENTMAIL_DURABLE_PENDING_MAX_ENTRIES,
    },
  });
}
