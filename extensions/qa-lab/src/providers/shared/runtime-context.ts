// Mirror the runtime wire delimiters so producer drift still fails through QA.
const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

export function isInternalRuntimeContextCarrierText(text: string) {
  const trimmed = text.trim();
  // Subagent tasks sit between two closed scaffolding blocks. Only a single
  // complete carrier is transparent to the current user turn.
  return (
    trimmed.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN) &&
    trimmed.indexOf(INTERNAL_RUNTIME_CONTEXT_END) ===
      trimmed.length - INTERNAL_RUNTIME_CONTEXT_END.length
  );
}
