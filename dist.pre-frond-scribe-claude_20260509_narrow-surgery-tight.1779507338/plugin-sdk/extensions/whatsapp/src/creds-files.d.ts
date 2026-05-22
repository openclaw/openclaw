export declare function resolveWebCredsPath(authDir: string): string;
export declare function resolveWebCredsBackupPath(authDir: string): string;
export declare function assertWebCredsPathRegularFileOrMissing(filePath: string): Promise<void>;
export declare function readWebCredsJsonRawSync(filePath: string): string | null;
export declare function readWebCredsJsonRaw(filePath: string): Promise<string | null>;
export declare function statWebCredsFileSync(filePath: string): {
    mtimeMs: number;
    size: number;
} | null;
export declare function hasWebCredsRegularFileSync(authDir: string): boolean;
export declare function hasWebCredsSync(authDir: string): boolean;
