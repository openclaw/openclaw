import nodeFs from "node:fs";
export type QueuedFileWriter = {
    filePath: string;
    write: (line: string) => void;
    flush: () => Promise<void>;
};
export type QueuedFileWriterOptions = {
    maxFileBytes?: number;
};
type QueuedFileAppendFlagConstants = Pick<typeof nodeFs.constants, "O_APPEND" | "O_CREAT" | "O_WRONLY"> & Partial<Pick<typeof nodeFs.constants, "O_NOFOLLOW">>;
export declare function resolveQueuedFileAppendFlags(constants?: QueuedFileAppendFlagConstants): number;
export declare function getQueuedFileWriter(writers: Map<string, QueuedFileWriter>, filePath: string, options?: QueuedFileWriterOptions): QueuedFileWriter;
export {};
