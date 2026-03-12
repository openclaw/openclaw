export type ArchiveKind = "tar" | "zip";
export type ArchiveLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
export type ArchiveExtractLimits = {
    /**
     * Max archive file bytes (compressed). Primarily protects zip extraction
     * because we currently read the whole archive into memory for parsing.
     */
    maxArchiveBytes?: number;
    /** Max number of extracted entries (files + dirs). */
    maxEntries?: number;
    /** Max extracted bytes (sum of all files). */
    maxExtractedBytes?: number;
    /** Max extracted bytes for a single file entry. */
    maxEntryBytes?: number;
};
export type ArchiveSecurityErrorCode = "destination-not-directory" | "destination-symlink" | "destination-symlink-traversal";
export declare class ArchiveSecurityError extends Error {
    code: ArchiveSecurityErrorCode;
    constructor(code: ArchiveSecurityErrorCode, message: string, options?: ErrorOptions);
}
/** @internal */
export declare const DEFAULT_MAX_ARCHIVE_BYTES_ZIP: number;
/** @internal */
export declare const DEFAULT_MAX_ENTRIES = 50000;
/** @internal */
export declare const DEFAULT_MAX_EXTRACTED_BYTES: number;
/** @internal */
export declare const DEFAULT_MAX_ENTRY_BYTES: number;
export declare function resolveArchiveKind(filePath: string): ArchiveKind | null;
export declare function resolvePackedRootDir(extractDir: string): Promise<string>;
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T>;
export declare function extractArchive(params: {
    archivePath: string;
    destDir: string;
    timeoutMs: number;
    kind?: ArchiveKind;
    stripComponents?: number;
    tarGzip?: boolean;
    limits?: ArchiveExtractLimits;
    logger?: ArchiveLogger;
}): Promise<void>;
export declare function fileExists(filePath: string): Promise<boolean>;
export declare function readJsonFile<T>(filePath: string): Promise<T>;
