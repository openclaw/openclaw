export type LogTailPayload = {
    file: string;
    cursor: number;
    size: number;
    lines: string[];
    truncated: boolean;
    reset: boolean;
};
export declare function resolveLogFile(file: string): Promise<string>;
export declare function readConfiguredLogTail(params?: {
    cursor?: number;
    limit?: number;
    maxBytes?: number;
}): Promise<LogTailPayload>;
