// Keep these helpers dependency-free so config/model parsing can use them
// without pulling in provider discovery or auth-profile graphs.
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
  // non-existent Gemini Flash preview ID. Google's current Flash text model is
  // `gemini-3-flash-preview`.
  if (id === "gemini-3.1-flash" || id === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  return id;
}
