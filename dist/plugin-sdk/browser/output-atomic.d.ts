export declare function writeViaSiblingTempPath(params: {
    rootDir: string;
    targetPath: string;
    writeTemp: (tempPath: string) => Promise<void>;
}): Promise<void>;
