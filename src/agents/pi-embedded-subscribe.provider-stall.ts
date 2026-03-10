const PROVIDER_STALL_WARN_MS = 45_000;
const GOOGLE_GEMINI_CLI_PROVIDER = "google-gemini-cli";

type ProviderProgressState = {
  lastProviderProgressAtMs?: number;
  lastProviderProgressPhase?: "agent_start" | "tool_result" | "stall_warning";
};

type ProviderProgressParams = {
  runId: string;
  provider?: string;
  modelId?: string;
};

type ProviderProgressLogger = {
  warn: (message: string) => void;
};

type ProviderProgressContext = {
  params: ProviderProgressParams;
  state: ProviderProgressState;
  log: ProviderProgressLogger;
};

export function noteProviderProgress(
  ctx: ProviderProgressContext,
  phase: "agent_start" | "tool_result",
  nowMs = Date.now(),
): void {
  ctx.state.lastProviderProgressAtMs = nowMs;
  ctx.state.lastProviderProgressPhase = phase;
}

export function maybeWarnProviderStall(
  ctx: ProviderProgressContext,
  params: {
    phase: "before_tool" | "before_agent_end";
    toolName?: string;
    toolCallId?: string;
    nowMs?: number;
  },
): void {
  if (ctx.params.provider !== GOOGLE_GEMINI_CLI_PROVIDER) {
    return;
  }

  const lastAt = ctx.state.lastProviderProgressAtMs;
  if (typeof lastAt !== "number" || !Number.isFinite(lastAt)) {
    return;
  }

  const nowMs = params.nowMs ?? Date.now();
  const gapMs = nowMs - lastAt;
  if (!Number.isFinite(gapMs) || gapMs < PROVIDER_STALL_WARN_MS) {
    return;
  }

  const sincePhase = ctx.state.lastProviderProgressPhase ?? "unknown";

  const parts = [
    `embedded run provider stall: runId=${ctx.params.runId}`,
    `provider=${ctx.params.provider}`,
    `model=${ctx.params.modelId ?? "unknown"}`,
    `gapMs=${Math.round(gapMs)}`,
    `since=${sincePhase}`,
    `phase=${params.phase}`,
  ];
  if (params.toolName) {
    parts.push(`tool=${params.toolName}`);
  }
  if (params.toolCallId) {
    parts.push(`toolCallId=${params.toolCallId}`);
  }
  parts.push(
    "hint=possible upstream google-gemini-cli retry/backoff (for example HTTP 429) before OpenClaw received the next lifecycle event",
  );

  ctx.state.lastProviderProgressAtMs = nowMs;
  ctx.state.lastProviderProgressPhase = "stall_warning";

  ctx.log.warn(parts.join(" "));
}
