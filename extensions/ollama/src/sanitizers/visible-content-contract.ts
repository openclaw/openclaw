export type OllamaVisibleContentStreamResolution =
  | { kind: "visible"; text: string }
  | { kind: "pending" };

export type OllamaVisibleContentSanitizer = {
  // Only identity sanitizers can reuse input deltas without comparing growing prefixes.
  preservesStreamText?: true;
  resolveStreamText(params: { text: string; final: boolean }): OllamaVisibleContentStreamResolution;
  sanitizeFinalText(text: string): string;
};
