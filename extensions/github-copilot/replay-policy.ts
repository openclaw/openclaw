import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function buildGithubCopilotReplayPolicy(modelId?: string) {
  // Copilot's Claude proxy rejects any persisted `thinking` / `redacted_thinking`
  // content blocks on follow-up turns (HTTP 400), regardless of whether they
  // belong to a prior or the latest assistant message. Unlike the direct
  // Anthropic Messages API, Copilot exposes no signed-thinking replay protocol,
  // so we must strip those blocks from every assistant turn before replay.
  // See: https://github.com/openclaw/openclaw/issues/81520
  return normalizeLowercaseStringOrEmpty(modelId).includes("claude")
    ? {
        dropAllThinkingBlocks: true,
      }
    : {};
}
