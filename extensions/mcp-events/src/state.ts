import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ApplicationEvent, EventDefinition } from "./protocol.js";

export type SubscriptionBinding = {
  version: 1;
  bindingId: string;
  jobId: string;
  sourceIdentity: string;
  serverName: string;
  accountId: string;
  principalId: string;
  arguments: Record<string, unknown>;
  definition: EventDefinition;
  callbackUrl: string;
  secret: string;
  previousSecret?: { value: string; until: number };
  pendingSecret?: string;
  status: "pending" | "active" | "revoked";
  remoteId?: string;
  refreshBefore?: number;
  cursor: string | null;
  cursorRevision: number;
  truncated: boolean;
  nextAttemptAt: number;
  failures: number;
  cleanupPending: boolean;
  retiredAt?: number;
  lastError?: "subscribe_failed" | "cleanup_failed" | "source_unavailable" | "state_unavailable";
  updatedAt: number;
};

export type QueuedEvent = {
  jobId: string;
  sourceIdentity: string;
  eventId: string;
  receivedAtMs: number;
  payload: { profile: string; bindingId: string; event: ApplicationEvent };
};

export type McpEventsRuntime = {
  state: Pick<
    OpenClawPluginApi["runtime"]["state"],
    "openKeyedStore" | "openChannelIngressQueue" | "openChannelIngressDrain"
  >;
};

export function createMcpEventsState(runtime: McpEventsRuntime) {
  const bindings = runtime.state.openKeyedStore<SubscriptionBinding>({
    namespace: "subscriptions-v1",
    maxEntries: 4096,
    overflowPolicy: "reject-new",
  });
  if (!bindings.withCurrent) {
    throw new Error("MCP Events requires current-authority plugin state writes; update OpenClaw");
  }
  return {
    bindings,
    withCurrent: bindings.withCurrent.bind(bindings),
    openQueue: (accountId: string) =>
      runtime.state.openChannelIngressQueue<QueuedEvent>({ accountId }),
  };
}
export type McpEventsState = ReturnType<typeof createMcpEventsState>;
