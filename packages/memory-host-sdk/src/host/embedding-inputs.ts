// Public embedding input contract for text and inline multimodal parts.

/** Provider-facing input while preserving the plain text fallback. */
export type EmbeddingInput = {
  text: string;
  parts?: Array<
    { type: "text"; text: string } | { type: "inline-data"; mimeType: string; data: string }
  >;
};

/** Return true when a chunk needs structured provider handling, not text splitting. */
export function hasNonTextEmbeddingParts(input: EmbeddingInput | undefined): boolean {
  return input?.parts?.some((part) => part.type === "inline-data") ?? false;
}
