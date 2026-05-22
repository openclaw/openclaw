type ParsedTranscriptRecord = Record<string, unknown>;
export type IndexedTranscriptEntry = {
    seq: number;
    id?: string;
    offset: number;
    byteLength: number;
    record: ParsedTranscriptRecord;
};
type SessionTranscriptIndex = {
    filePath: string;
    mtimeMs: number;
    size: number;
    hasTreeEntries: boolean;
    leafId?: string;
    entries: IndexedTranscriptEntry[];
};
export declare function clearSessionTranscriptIndexCache(): void;
export declare function readSessionTranscriptIndex(filePath: string): Promise<SessionTranscriptIndex | null>;
export {};
