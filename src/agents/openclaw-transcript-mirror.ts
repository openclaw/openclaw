// `provider:"openclaw"` assistant entries with these models are user-visible
// transcript records, not model output:
// - `delivery-mirror`: written by the channel-delivery transcript mirror, see
//   `src/config/sessions/transcript.ts`.
// - `gateway-injected`: written by the Gateway transcript-inject helper, see
//   `src/gateway/server-methods/chat-transcript-inject.ts`.
// Surfaces that present "real assistant turns" — provider replay and the
// `sessions_history` tool / dashboard session viewer — must skip them; the
// docs claim under `docs/reference/transcript-hygiene.md` is the explicit
// contract this set defends.
export const TRANSCRIPT_ONLY_OPENCLAW_MODELS = new Set<string>([
  "delivery-mirror",
  "gateway-injected",
]);

export function isTranscriptOnlyOpenclawAssistant(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as { role?: unknown; provider?: unknown; model?: unknown };
  if (entry.role !== "assistant") {
    return false;
  }
  const model = entry.model;
  return (
    entry.provider === "openclaw" &&
    typeof model === "string" &&
    TRANSCRIPT_ONLY_OPENCLAW_MODELS.has(model)
  );
}
