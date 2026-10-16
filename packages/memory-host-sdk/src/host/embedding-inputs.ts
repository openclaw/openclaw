// Public embedding input contract for text and inline multimodal parts.

/** Provider-facing input while preserving the plain text fallback. */
export type EmbeddingInput = {
  text: string;
  parts?: Array<
    { type: "text"; text: string } | { type: "inline-data"; mimeType: string; data: string }
  >;
};

const EMBEDDING_TASK_PREFIXES: Record<string, string> = {
  RETRIEVAL_QUERY: "task: search result | query:",
  RETRIEVAL_DOCUMENT: "title: none | text:",
  SEMANTIC_SIMILARITY: "task: sentence similarity | query:",
  CLASSIFICATION: "task: classification | query:",
  CLUSTERING: "task: clustering | query:",
  QUESTION_ANSWERING: "task: question answering | query:",
  FACT_VERIFICATION: "task: fact checking | query:",
};

export function formatEmbeddingTaskText(text: string, taskType: string): string {
  return `${EMBEDDING_TASK_PREFIXES[taskType]} ${text}`;
}

/** Advance the model's revision when its input format changes, for index and cache upgrades. */
export function resolveEmbeddingInputFormatVersion(model: string): number {
  return /(?:^|[/\\])(?:text-embedding-)?embeddinggemma(?:[-:._]|$)/iu.test(model.trim()) ? 1 : 0;
}

export function formatEmbeddingModelInput(
  input: string,
  model: string,
  role: "query" | "document",
): string;
export function formatEmbeddingModelInput(
  input: EmbeddingInput,
  model: string,
  role: "query" | "document",
): EmbeddingInput;
export function formatEmbeddingModelInput(
  input: string | EmbeddingInput,
  model: string,
  role: "query" | "document",
): string | EmbeddingInput;
export function formatEmbeddingModelInput(
  input: string | EmbeddingInput,
  model: string,
  role: "query" | "document",
): string | EmbeddingInput {
  if (!resolveEmbeddingInputFormatVersion(model)) {
    return input;
  }
  const taskType = role === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  if (typeof input === "string") {
    return formatEmbeddingTaskText(input, taskType);
  }
  if (hasNonTextEmbeddingParts(input)) {
    return input;
  }
  return {
    ...input,
    text: formatEmbeddingTaskText(input.text, taskType),
    ...(input.parts
      ? {
          parts: input.parts.map((part, index) =>
            part.type === "text" && index === 0
              ? { ...part, text: formatEmbeddingTaskText(part.text, taskType) }
              : part,
          ),
        }
      : {}),
  };
}

/** Return true when a chunk needs structured provider handling, not text splitting. */
export function hasNonTextEmbeddingParts(input: EmbeddingInput | undefined): boolean {
  return input?.parts?.some((part) => part.type === "inline-data") ?? false;
}
