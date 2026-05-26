export declare const REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT = "__OPENCLAW_REDACTED__";
export declare const SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS: readonly ["name", "encoding", "mimeType"];
export declare function normalizeAllowedToolNames(allowedToolNames?: Iterable<string>): Set<string> | null;
export declare function isAllowedToolCallName(name: unknown, allowedToolNames: Set<string> | null): boolean;
export declare function isRedactedSessionsSpawnAttachment(item: unknown): boolean;
type SessionsSpawnAttachmentToolCallBlock = {
    name?: unknown;
    input?: unknown;
    arguments?: unknown;
};
export declare function hasUnredactedSessionsSpawnAttachments(block: SessionsSpawnAttachmentToolCallBlock): boolean;
export {};
