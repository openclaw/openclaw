// Keep model ID normalization dependency-free so config parsing and other
// startup-only paths do not pull in provider discovery or plugin loading.
export function normalizeGoogleModelId(id: string): string {
  if (id === "gemini-3-pro") {
    return "gemini-3-pro-preview";
  }
  if (id === "gemini-3-flash") {
    return "gemini-3-flash-preview";
  }
  if (id === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  if (id === "gemini-3.1-flash-lite") {
    return "gemini-3.1-flash-lite-preview";
  }
  // Preserve compatibility with earlier OpenClaw docs/config that pointed at a
  // non-existent Gemini Flash preview ID. The bare shorthand `gemini-3.1-flash`
  // is not a real Google model string; map it to the correct preview slug.
  // Note: `gemini-3.1-flash-preview` is now a real model ID — do NOT remap it.
  if (id === "gemini-3.1-flash") {
    return "gemini-3-flash-preview";
  }
  return id;
}

export function normalizeXaiModelId(id: string): string {
  if (id === "grok-4-fast-reasoning") {
    return "grok-4-fast";
  }
  if (id === "grok-4-1-fast-reasoning") {
    return "grok-4-1-fast";
  }
  if (id === "grok-4.20-experimental-beta-0304-reasoning") {
    return "grok-4.20-beta-latest-reasoning";
  }
  if (id === "grok-4.20-experimental-beta-0304-non-reasoning") {
    return "grok-4.20-beta-latest-non-reasoning";
  }
  if (id === "grok-4.20-reasoning") {
    return "grok-4.20-beta-latest-reasoning";
  }
  if (id === "grok-4.20-non-reasoning") {
    return "grok-4.20-beta-latest-non-reasoning";
  }
  return id;
}
