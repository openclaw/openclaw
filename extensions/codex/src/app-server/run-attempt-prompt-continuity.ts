import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
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

/** Visible local conversation a resumed native thread has not seen yet. */
export function selectCodexStaleBindingDelta(
  messages: readonly AgentMessage[],
  binding: { threadId: string; historyCoveredThrough?: string },
) {
  const cutoff = Date.parse(binding.historyCoveredThrough ?? "");
  const nativeThreadPrefix = `codex-app-server:${binding.threadId}:`;
  return messages.filter((message) => {
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      !isCodexDurableCustomMessage(message)
    ) {
      return false;
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
      Number.isFinite(timestamp) &&
      timestamp > (Number.isFinite(cutoff) ? cutoff : 0)
    );
  });
}
