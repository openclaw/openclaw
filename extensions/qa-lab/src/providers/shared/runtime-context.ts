// Accept the current label plus shipped delimiter envelopes during upgrade QA.
const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const RUNTIME_CONTEXT_HEADER = "OpenClaw runtime context:";

export function isInternalRuntimeContextCarrierText(text: string) {
  const trimmed = text.trim();
  const legacyEndIndex = trimmed.indexOf(INTERNAL_RUNTIME_CONTEXT_END);
  // Subagent tasks sit between two closed scaffolding blocks. Only the current
  // label or one complete legacy carrier is transparent to the user turn.
  return (
    trimmed.startsWith(`${RUNTIME_CONTEXT_HEADER}\n`) ||
    (trimmed.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN) &&
      legacyEndIndex >= 0 &&
      legacyEndIndex + INTERNAL_RUNTIME_CONTEXT_END.length === trimmed.length)
  );
}
