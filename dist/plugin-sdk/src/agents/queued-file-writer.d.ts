import { resolveRegularFileAppendFlags } from "../infra/fs-safe.js";
export type QueuedFileWriteResult = "queued" | "dropped";
export type QueuedFileWriterDiagnostics = {
    pendingWrites: number;
    queuedBytes: number;
    activeOperation: "idle" | "mkdir" | "yield" | "file-append";
    activeWriteBytes?: number;
    maxFileBytes?: number;
    maxQueuedBytes?: number;
    yieldBeforeWrite: boolean;
};
export type QueuedFileWriter = {
    filePath: string;
    write: (line: string) => unknown;
    flush: () => Promise<void>;
    describeQueue?: () => QueuedFileWriterDiagnostics;
};
type QueuedFileWriterOptions = {
    maxFileBytes?: number;
    maxQueuedBytes?: number;
    yieldBeforeWrite?: boolean;
};
export declare const resolveQueuedFileAppendFlags: typeof resolveRegularFileAppendFlags;
export declare function getQueuedFileWriter(writers: Map<string, QueuedFileWriter>, filePath: string, options?: QueuedFileWriterOptions): QueuedFileWriter;
export {};
