export declare function rewriteSessionFileForNewSessionId(params: {
    sessionFile?: string;
    previousSessionId: string;
    nextSessionId: string;
}): string | undefined;
export declare function canonicalizeAbsoluteSessionFilePath(filePath: string): string;
