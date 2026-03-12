export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: "session" | "llm_call" | "tool_call" | "subagent";
  name: string;
  agentId?: string;
  sessionKey?: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  attributes: Record<string, string | number | boolean>;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  childSessionKey?: string;
  childAgentId?: string;
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
};

export type TracingConfig = {
  enabled?: boolean;
  retentionDays?: number;
  redactToolParams?: boolean;
};
