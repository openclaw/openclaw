/** Detects Google-owned embedded runtime APIs. */
export function isGoogleModelApi(api?: string | null): boolean {
  return (
    api === "google-gemini-cli" || api === "google-generative-ai" || api === "google-interactions"
  );
}
