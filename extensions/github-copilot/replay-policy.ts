import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Build the replay policy for a Copilot-routed model.
 *
 * Copilot's transport routing (see `resolveCopilotTransportApi`):
 *   - Claude-family model IDs → `anthropic-messages`
 *   - Gemini-family model IDs → `openai-completions`
 *   - everything else (GPT-family, `o*` reasoning models, future synthetic
 *     IDs)            → `openai-responses`
 *
 * The policy returned here is consumed by `resolveTranscriptPolicy` and
 * ultimately controls what the embedded runner strips from history before
 * each replay.
 *
 * Rationale per family:
 *
 *  - Claude (anthropic-messages): drop legacy `thinking` blocks from history.
 *    Older Claude versions (pre-4.5) don't preserve thinking blocks across
 *    turns, so re-sending them is a noop at best and an error at worst.
 *
 *  - GPT / o-series on Copilot (openai-responses): drop reasoning items from
 *    history while preserving the current tool-turn reasoning. Copilot's
 *    OpenAI-compatible `/responses` endpoint serializes prior `thinking`
 *    blocks (via `thinkingSignature`) back into the input as `reasoning`
 *    items carrying `encrypted_content` + `id`. Those tokens are bound to
 *    the originating connection/turn and are rejected on replay with
 *    `400 The encrypted content for item rs_<id> could not be verified`
 *    (see https://github.com/openclaw/openclaw/issues/78867).
 *
 *    Native OpenAI Responses replay is unaffected: this hook only fires when
 *    the github-copilot provider is selected. `dropReasoningFromHistory`
 *    keeps reasoning attached to the current tool turn so multi-step
 *    function-call flows on o-series models still continue correctly.
 *
 *  - Gemini on Copilot (openai-completions): routed through Chat Completions,
 *    which doesn't surface `encrypted_content` reasoning items, so the
 *    history-drop is a no-op for the wire payload. We still apply it for
 *    consistency with the catch-all branch below and to keep behavior stable
 *    if a future Gemini model is ever moved onto Responses.
 */
export function buildGithubCopilotReplayPolicy(modelId?: string) {
  const id = normalizeLowercaseStringOrEmpty(modelId);
  if (id.includes("claude")) {
    return {
      dropThinkingBlocks: true,
    };
  }
  // Catch-all for non-Claude Copilot models. The GPT-family / `o*` branch
  // (which routes to openai-responses) is the one that actually rejects
  // replayed `encrypted_content` from prior turns; strip cross-turn reasoning
  // while keeping current-turn tool-call reasoning intact. Gemini IDs (routed
  // to openai-completions) fall through here as a no-op for the wire payload.
  return {
    dropReasoningFromHistory: true,
  };
}
