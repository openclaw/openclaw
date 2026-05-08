import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Build the replay policy for a Copilot-routed model.
 *
 * Copilot routes Claude models to `anthropic-messages` and everything else
 * (GPT, o-series, Gemini, ...) to `openai-responses`. The policy returned here
 * is consumed by `resolveTranscriptPolicy` and ultimately controls what the
 * embedded runner strips from history before each replay.
 *
 * Rationale per family:
 *
 *  - Claude (anthropic-messages): drop legacy `thinking` blocks from history.
 *    Older Claude versions (pre-4.5) don't preserve thinking blocks across
 *    turns, so re-sending them is a noop at best and an error at worst.
 *
 *  - GPT / o-series / Gemini on Copilot (openai-responses): drop reasoning
 *    items from history while preserving the current tool-turn reasoning.
 *    Copilot's OpenAI-compatible `/responses` endpoint serializes prior
 *    `thinking` blocks (via `thinkingSignature`) back into the input as
 *    `reasoning` items carrying `encrypted_content` + `id`. Those tokens are
 *    bound to the originating connection/turn and are rejected on replay with
 *    `400 The encrypted content for item rs_<id> could not be verified`
 *    (see https://github.com/openclaw/openclaw/issues/78867).
 *
 *    Native OpenAI Responses replay is unaffected: this hook only fires when
 *    the github-copilot provider is selected. `dropReasoningFromHistory`
 *    keeps reasoning attached to the current tool turn so multi-step
 *    function-call flows on o-series models still continue correctly.
 */
export function buildGithubCopilotReplayPolicy(modelId?: string) {
  const id = normalizeLowercaseStringOrEmpty(modelId);
  if (id.includes("claude")) {
    return {
      dropThinkingBlocks: true,
    };
  }
  // All non-Claude Copilot models route through openai-responses, where
  // replayed `encrypted_content` from prior turns is rejected. Strip cross-turn
  // reasoning while keeping current-turn tool-call reasoning intact.
  return {
    dropReasoningFromHistory: true,
  };
}
