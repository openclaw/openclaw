import type { EmbeddingInput } from "./embedding-inputs.js";
export declare function estimateUtf8Bytes(text: string): number;
export declare function estimateStructuredEmbeddingInputBytes(input: EmbeddingInput): number;
export declare function splitTextToUtf8ByteLimit(text: string, maxUtf8Bytes: number): string[];
