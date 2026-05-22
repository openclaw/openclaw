export declare const SKILL_UPLOAD_TTL_MS: number;
export declare const MAX_SKILL_UPLOAD_CHUNK_BYTES: number;
export declare const MAX_SKILL_UPLOAD_BASE64_LENGTH: number;
export declare const MAX_ACTIVE_SKILL_UPLOADS = 32;
export declare const SKILL_UPLOAD_IDEMPOTENCY_KEY_MAX_LENGTH = 2048;
export declare class SkillUploadRequestError extends Error {
    constructor(message: string);
}
export type SkillUploadRecord = {
    version: 1;
    kind: "skill-archive";
    uploadId: string;
    slug: string;
    force: boolean;
    sizeBytes: number;
    sha256?: string;
    actualSha256?: string;
    receivedBytes: number;
    archivePath: string;
    createdAt: number;
    expiresAt: number;
    committed: boolean;
    committedAt?: number;
    idempotencyKeyHash?: string;
};
export type SkillUploadStore = ReturnType<typeof createSkillUploadStore>;
type BeginParams = {
    kind: "skill-archive";
    slug: string;
    sizeBytes: number;
    sha256?: string;
    force?: boolean;
    idempotencyKey?: string;
};
type ChunkParams = {
    uploadId: string;
    offset: number;
    dataBase64: string;
};
type CommitParams = {
    uploadId: string;
    sha256?: string;
};
export declare function normalizeSkillUploadSha256(value: string | undefined): string | undefined;
export declare function createSkillUploadStore(options?: {
    rootDir?: string;
    now?: () => number;
    ttlMs?: number;
}): {
    rootDir: string;
    begin(params: BeginParams): Promise<{
        uploadId: string;
        receivedBytes: number;
        expiresAt: number;
    }>;
    chunk(params: ChunkParams): Promise<{
        uploadId: string;
        receivedBytes: number;
        expiresAt: number;
    }>;
    commit(params: CommitParams): Promise<{
        uploadId: string;
        receivedBytes: number;
        sha256: string;
        expiresAt: number;
    }>;
    withCommittedUpload<T>(uploadIdRaw: string, action: (record: SkillUploadRecord, controls: {
        remove: () => Promise<void>;
    }) => Promise<T>): Promise<T>;
    remove(uploadIdRaw: string): Promise<void>;
};
export declare const defaultSkillUploadStore: {
    rootDir: string;
    begin(params: BeginParams): Promise<{
        uploadId: string;
        receivedBytes: number;
        expiresAt: number;
    }>;
    chunk(params: ChunkParams): Promise<{
        uploadId: string;
        receivedBytes: number;
        expiresAt: number;
    }>;
    commit(params: CommitParams): Promise<{
        uploadId: string;
        receivedBytes: number;
        sha256: string;
        expiresAt: number;
    }>;
    withCommittedUpload<T>(uploadIdRaw: string, action: (record: SkillUploadRecord, controls: {
        remove: () => Promise<void>;
    }) => Promise<T>): Promise<T>;
    remove(uploadIdRaw: string): Promise<void>;
};
export {};
