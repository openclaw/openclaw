import { onAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { scopedHeartbeatWakeOptions } from "../routing/session-key.js";

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const DEFAULT_MAX_RELAY_LIFETIME_MS = 6 * 60 * 60 * 1000;
const RESULT_TEXT_MAX_CHARS = 8_000;

async function captureCompletionReply(sessionKey: string): Promise<string | undefined> {
  const { captureSubagentCompletionReply } = await import("./subagent-announce.js");
  return await captureSubagentCompletionReply(sessionKey);
}

export function startAcpSpawnCompletionRelay(params: {
  runId: string;
  parentSessionKey: string;
  childSessionKey: string;
  agentId: string;
  maxRelayLifetimeMs?: number;
}): AcpSpawnCompletionRelayHandle {
  const runId = params.runId.trim();
  const parentSessionKey = params.parentSessionKey.trim();
  const childSessionKey = params.childSessionKey.trim();
  if (!runId || !parentSessionKey || !childSessionKey) {
    return { dispose: () => {} };
  }

  const relayLabel = truncate(compactWhitespace(params.agentId), 40) || "ACP child";
  const maxRelayLifetimeMs =
    typeof params.maxRelayLifetimeMs === "number" && Number.isFinite(params.maxRelayLifetimeMs)
      ? Math.max(1_000, Math.floor(params.maxRelayLifetimeMs))
      : DEFAULT_MAX_RELAY_LIFETIME_MS;
  const contextPrefix = `acp-spawn-completion:${runId}`;

  let disposed = false;
  let resolvingCompletion = false;

  const wake = () => {
    requestHeartbeatNow(
      scopedHeartbeatWakeOptions(parentSessionKey, {
        reason: "acp:spawn:completion",
      }),
    );
  };

  const emit = (text: string, contextKey: string) => {
    const cleaned = text.trim();
    if (!cleaned) {
      return;
    }
    enqueueSystemEvent(cleaned, { sessionKey: parentSessionKey, contextKey });
    wake();
  };

  const emitCompletion = async () => {
    if (disposed || resolvingCompletion) {
      return;
    }
    resolvingCompletion = true;
    try {
      const resultText = await captureCompletionReply(childSessionKey);
      const cleanedResult = resultText?.trim();
      if (cleanedResult) {
        emit(
          `${relayLabel} completed:\n\n${truncate(cleanedResult, RESULT_TEXT_MAX_CHARS)}`,
          `${contextPrefix}:done`,
        );
      } else {
        emit(`${relayLabel} completed.`, `${contextPrefix}:done`);
      }
    } finally {
      dispose();
    }
  };

  const unsubscribe = onAgentEvent((event) => {
    if (disposed || event.runId !== runId || event.stream !== "lifecycle") {
      return;
    }
    const phase = toTrimmedString((event.data as { phase?: unknown } | undefined)?.phase);
    if (phase === "end") {
      void emitCompletion();
      return;
    }
    if (phase === "error") {
      const errorText = toTrimmedString((event.data as { error?: unknown } | undefined)?.error);
      const startedAt = toFiniteNumber(
        (event.data as { startedAt?: unknown } | undefined)?.startedAt,
      );
      const endedAt = toFiniteNumber((event.data as { endedAt?: unknown } | undefined)?.endedAt);
      const durationMs =
        startedAt != null && endedAt != null && endedAt >= startedAt ? endedAt - startedAt : 0;
      const durationSuffix =
        durationMs > 0 ? ` after ${Math.max(1, Math.round(durationMs / 1000))}s` : "";
      emit(
        errorText
          ? `${relayLabel} failed${durationSuffix}: ${errorText}`
          : `${relayLabel} failed${durationSuffix}.`,
        `${contextPrefix}:error`,
      );
      dispose();
    }
  });

  const timeout = setTimeout(() => {
    if (disposed) {
      return;
    }
    emit(
      `${relayLabel} completion relay timed out after ${Math.max(1, Math.round(maxRelayLifetimeMs / 1000))}s.`,
      `${contextPrefix}:timeout`,
    );
    dispose();
  }, maxRelayLifetimeMs);
  timeout.unref?.();

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(timeout);
    unsubscribe();
  };

  return { dispose };
}

export type AcpSpawnCompletionRelayHandle = {
  dispose: () => void;
};
