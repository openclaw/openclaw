export type TranscriptStreamOptions = {
    signal?: AbortSignal;
};
export type TranscriptReverseStreamOptions = TranscriptStreamOptions & {
    /** Bytes read per reverse scan chunk. Clamped to [1KiB, 1MiB]. */
    chunkBytes?: number;
};
/**
 * Stream the non-empty, trimmed JSONL lines of a transcript file in order.
 *
 * Returns an empty async iterator if the file does not exist, is empty, or is
 * not a regular file. Honours `options.signal` between lines so long scans can
 * cooperate with abort signals.
 */
export declare function streamSessionTranscriptLines(filePath: string, options?: TranscriptStreamOptions): AsyncGenerator<string>;
/**
 * Stream the non-empty, trimmed JSONL lines of a transcript file in reverse
 * (newest-first) order.
 *
 * Returns an empty async iterator if the file cannot be opened, is empty, or is
 * not a regular file. The implementation splits on newline bytes before UTF-8
 * decoding so multibyte characters survive arbitrary chunk boundaries.
 */
export declare function streamSessionTranscriptLinesReverse(filePath: string, options?: TranscriptReverseStreamOptions): AsyncGenerator<string>;
