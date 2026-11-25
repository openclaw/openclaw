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

type EmbeddingInputFormat = { query: string; document: string };

const MODEL_INPUT_FORMATS = [
  {
    pattern: /(?:^|[/\\])(?:text-embedding-)?embeddinggemma(?:[-:._]|$)/iu,
    query: formatEmbeddingTaskText("", "RETRIEVAL_QUERY"),
    document: formatEmbeddingTaskText("", "RETRIEVAL_DOCUMENT"),
    version: 1,
  },
  {
    pattern: /(?:^|[/\\])nemotron-3(?:\.5)?-embed(?:[-:._]|$)/iu,
    query: "query: ",
    document: "passage: ",
    version: 1,
  },
];

function resolveModelInputFormat(model: string) {
  return MODEL_INPUT_FORMATS.find(({ pattern }) => pattern.test(model.trim()));
}

/** Advance the model's revision when its input format changes, for index and cache upgrades. */
export function resolveEmbeddingInputFormatVersion(model: string): number {
  return resolveModelInputFormat(model)?.version ?? 0;
}

export function formatEmbeddingModelInput(
  input: string,
  model: string,
  role: "query" | "document",
  inputFormat?: EmbeddingInputFormat,
): string;
export function formatEmbeddingModelInput(
  input: EmbeddingInput,
  model: string,
  role: "query" | "document",
  inputFormat?: EmbeddingInputFormat,
): EmbeddingInput;
export function formatEmbeddingModelInput(
  input: string | EmbeddingInput,
  model: string,
  role: "query" | "document",
  inputFormat?: EmbeddingInputFormat,
): string | EmbeddingInput;
export function formatEmbeddingModelInput(
  input: string | EmbeddingInput,
  model: string,
  role: "query" | "document",
  inputFormat?: EmbeddingInputFormat,
): string | EmbeddingInput {
  const prefix = (inputFormat ?? resolveModelInputFormat(model))?.[role];
  if (prefix === undefined) {
    return input;
  }
  if (typeof input === "string") {
    return `${prefix}${input}`;
  }
  if (hasNonTextEmbeddingParts(input)) {
    return input;
  }
  return {
    ...input,
    text: `${prefix}${input.text}`,
    ...(input.parts
      ? {
          parts: input.parts.map((part, index) =>
            part.type === "text" && index === 0 ? { ...part, text: `${prefix}${part.text}` } : part,
          ),
        }
      : {}),
  };
}

/** Return true when a chunk needs structured provider handling, not text splitting. */
export function hasNonTextEmbeddingParts(input: EmbeddingInput | undefined): boolean {
  return input?.parts?.some((part) => part.type === "inline-data") ?? false;
}
