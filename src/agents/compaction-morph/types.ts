/** Message format for the Morph compact API. */
export type MorphCompactMessage = {
  role: "user" | "assistant";
  content: string;
};

export type MorphCompactResponseMessage = {
  role: string;
  content: string;
  name?: string | null;
  compacted_line_ranges: { start: number; end: number }[];
};

export type MorphCompactUsage = {
  input_tokens: number;
  output_tokens: number;
  compression_ratio: number;
  processing_time_ms: number;
};

export type MorphCompactResponse = {
  id: string;
  object?: string;
  created?: number;
  model: string;
  output: string;
  messages: MorphCompactResponseMessage[];
  usage: MorphCompactUsage;
};

export type MorphCompactConfig = {
  apiUrl: string;
  apiKey: string;
  model: string;
  compressionRatio: number;
  timeout: number;
};
