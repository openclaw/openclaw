export declare function isMissingEmbeddingApiKeyError(err: unknown): boolean;
export declare function sanitizeEmbeddingCacheHeaders(headers: Record<string, string>, excludedHeaderNames: string[]): Array<[string, string]>;
export declare function mapBatchEmbeddingsByIndex(byCustomId: Map<string, number[]>, count: number): number[][];
