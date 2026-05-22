import nodeFs from "node:fs";
export type QueuedFileWriteResult = "queued" | "dropped";
export type QueuedFileWriter = {
    filePath: string;
    write: (line: string) => unknown;
    flush: () => Promise<void>;
};
type QueuedFileWriterOptions = {
    maxFileBytes?: number;
    maxQueuedBytes?: number;
    yieldBeforeWrite?: boolean;
};
type QueuedFileAppendFlagConstants = Pick<typeof nodeFs.constants, "O_APPEND" | "O_CREAT" | "O_WRONLY"> & Partial<Pick<typeof nodeFs.constants, "O_NOFOLLOW">>;
export declare function resolveQueuedFileAppendFlags(constants?: QueuedFileAppendFlagConstants): number;
export declare function getQueuedFileWriter(writers: Map<string, QueuedFileWriter>, filePath: string, options?: QueuedFileWriterOptions): QueuedFileWriter;
export {};
