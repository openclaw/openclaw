export type ScreenRecordPayload = {
    format: string;
    base64: string;
    durationMs?: number;
    fps?: number;
    screenIndex?: number;
    hasAudio?: boolean;
};
export declare function parseScreenRecordPayload(value: unknown): ScreenRecordPayload;
export declare function screenRecordTempPath(opts: {
    ext: string;
    tmpDir?: string;
    id?: string;
}): string;
export declare function writeScreenRecordToFile(filePath: string, base64: string): Promise<{
    path: string;
    bytes: number;
}>;
