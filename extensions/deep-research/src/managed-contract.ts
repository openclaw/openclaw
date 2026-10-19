/** Plugin-local convention over trusted provider-owned Gateway RPC, not a host SDK capability.
 * Providers validate ingress/native responses; loaded plugin replies use the normal by-reference boundary.
 */
export type ResearchAdapterSnapshot = {
  state: "running" | "completed" | "partial" | "failed" | "cancelled" | "blocked" | "indeterminate";
  handle: Record<string, string>;
  report?: string;
  citations: Array<{ url: string; title?: string; startByte?: number; endByte?: number }>;
  usageTokens?: number;
  reason?: string;
  retryAfterMs?: number;
};
export type ResearchAdapterRequest = { version: 1 } & (
  | { action: "describe" }
  | { action: "start"; question: string; output?: string; asOf?: string }
  | { action: "poll" | "cancel"; handle: ResearchAdapterSnapshot["handle"] }
);
export type ResearchAdapterDescriptor = {
  version: 1;
  kind: "managed-research";
  provider: string;
  agent: string;
  authModes: string[];
  citationEvidence: "provider-attributed";
  storageRequired: boolean;
  hardBudgets: { model: boolean; search: boolean; tokens: boolean };
  idempotentStart: boolean;
};
export type ResearchAdapterReply =
  | { version: 1; ok: true; value: ResearchAdapterDescriptor | ResearchAdapterSnapshot }
  | {
      version: 1;
      ok: false;
      state: "blocked" | "failed" | "indeterminate";
      reason: string;
      handle?: ResearchAdapterSnapshot["handle"];
      retryAfterMs?: number;
    };
