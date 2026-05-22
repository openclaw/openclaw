import type { DatabaseSync } from "node:sqlite";
import type { CaptureBlobRecord, CaptureEventRecord, CaptureQueryPreset, CaptureQueryRow, CaptureSessionCoverageSummary, CaptureSessionRecord, CaptureSessionSummary } from "./types.js";
export declare class DebugProxyCaptureStore {
    readonly dbPath: string;
    readonly blobDir: string;
    readonly db: DatabaseSync;
    private readonly walMaintenance;
    private closed;
    constructor(dbPath: string, blobDir: string);
    close(): void;
    get isClosed(): boolean;
    upsertSession(session: CaptureSessionRecord): void;
    endSession(sessionId: string, endedAt?: number): void;
    persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord;
    recordEvent(event: CaptureEventRecord): void;
    listSessions(limit?: number): CaptureSessionSummary[];
    getSessionEvents(sessionId: string, limit?: number): Array<Record<string, unknown>>;
    summarizeSessionCoverage(sessionId: string): CaptureSessionCoverageSummary;
    readBlob(blobId: string): string | null;
    queryPreset(preset: CaptureQueryPreset, sessionId?: string): CaptureQueryRow[];
    purgeAll(): {
        sessions: number;
        events: number;
        blobs: number;
    };
    deleteSessions(sessionIds: string[]): {
        sessions: number;
        events: number;
        blobs: number;
    };
}
export declare function getDebugProxyCaptureStore(dbPath: string, blobDir: string): DebugProxyCaptureStore;
export declare function closeDebugProxyCaptureStore(): void;
export declare function acquireDebugProxyCaptureStore(dbPath: string, blobDir: string): {
    store: DebugProxyCaptureStore;
    release: () => void;
};
export declare function persistEventPayload(store: DebugProxyCaptureStore, params: {
    data?: Buffer | string | null;
    contentType?: string;
    previewLimit?: number;
}): {
    dataText?: string;
    dataBlobId?: string;
    dataSha256?: string;
};
export declare function safeJsonString(value: unknown): string | undefined;
