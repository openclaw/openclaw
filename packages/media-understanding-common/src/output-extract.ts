function extractLastJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  // Gemini CLI can print logs before the final JSON response; parse only the
  // trailing object so noisy preamble text does not break extraction.
  const start = trimmed.lastIndexOf("{");
  if (start === -1) {
    return null;
  }
  const slice = trimmed.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

/** Extracts the final non-empty `response` string from Gemini CLI JSON output. */
export function extractGeminiResponse(raw: string): string | null {
  const payload = extractLastJsonObject(raw);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const response = (payload as { response?: unknown }).response;
  if (typeof response !== "string") {
    return null;
  }
  const trimmed = response.trim();
  return trimmed || null;
}
