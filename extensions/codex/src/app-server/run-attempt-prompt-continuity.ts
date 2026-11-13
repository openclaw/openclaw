import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isCodexDurableCustomMessage } from "./context-engine-projection.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

/** Native continuity reported to authorized prompt hooks, decided by the thread binding owner. */
export function resolveCodexPromptContinuity(params: {
  initialNativeThreadId?: string;
  nativeThreadAction?: "started" | "resumed" | "forked";
  currentNativeThreadId?: string;
  historyIncluded: boolean;
}) {
  const resumed = params.nativeThreadAction
    ? params.nativeThreadAction !== "started"
    : Boolean(params.currentNativeThreadId);
  return {
    // A started thread replaced the binding this attempt began with: rotation or failed resume.
    state: resumed ? "resumed" : params.initialNativeThreadId ? "invalidated" : "fresh",
    history: params.historyIncluded ? "included" : "none",
  } as const;
}

function readIdempotencyKey(message: AgentMessage) {
  return "idempotencyKey" in message && typeof message.idempotencyKey === "string"
    ? message.idempotencyKey
    : undefined;
}

/** Names the host user row sent with a completed turn so the next turn can resume after it. */
export function buildCodexTranscriptCoverage(params: {
  message: AgentMessage | undefined;
  threadId: string;
  runId: string;
}) {
  const idempotencyKey =
    params.message?.role === "user" ? readIdempotencyKey(params.message) : undefined;
  return idempotencyKey
    ? { threadId: params.threadId, runId: params.runId, idempotencyKey }
    : undefined;
}

/** Visible local conversation a resumed native thread has not seen yet. */
export function selectCodexStaleBindingDelta(
  messages: readonly AgentMessage[],
  binding: {
    threadId: string;
    historyCoveredThrough?: string;
    transcriptCoverage?: { threadId: string; runId: string; idempotencyKey: string };
  },
) {
  // The exact host row sent with the last turn beats the completion time: a row
  // that arrived during that turn is older than the clock but still unseen.
  const coverage =
    binding.transcriptCoverage?.threadId === binding.threadId
      ? binding.transcriptCoverage
      : undefined;
  const anchor = coverage
    ? messages.findIndex(
        (message) =>
          message.role === "user" && readIdempotencyKey(message) === coverage.idempotencyKey,
      )
    : -1;
  const cutoff = Date.parse(binding.historyCoveredThrough ?? "");
  const nativeThreadPrefix = `codex-app-server:${binding.threadId}:`;
  return messages.filter((message, index) => {
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      !isCodexDurableCustomMessage(message)
    ) {
      return false;
    }
    if (anchor >= 0) {
      if (
        index <= anchor ||
        (message.role === "user" &&
          asOptionalRecord(Reflect.get(message, "__openclaw"))?.steerTargetRunId ===
            coverage?.runId)
      ) {
        return false;
      }
    }
    const mirrorIdentity = readMirrorIdentity(message);
    const timestamp =
      typeof message.timestamp === "number"
        ? message.timestamp
        : typeof message.timestamp === "string"
          ? Date.parse(message.timestamp)
          : Number.NaN;
    return (
      !(
        "idempotencyKey" in message &&
        typeof message.idempotencyKey === "string" &&
        message.idempotencyKey.startsWith(nativeThreadPrefix)
      ) &&
      // Origin alone does not imply coverage: temporary threads and host-admitted
      // user rows belong in the unseen delta. Unqualified rows rely on the cutoff.
      !mirrorIdentity?.startsWith(nativeThreadPrefix) &&
      (anchor >= 0 ||
        (Number.isFinite(timestamp) && timestamp > (Number.isFinite(cutoff) ? cutoff : 0)))
    );
  });
}
