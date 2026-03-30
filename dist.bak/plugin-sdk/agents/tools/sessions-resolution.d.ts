import type { OpenClawConfig } from "../../config/config.js";
export declare function resolveMainSessionAlias(cfg: OpenClawConfig): {
    mainKey: string;
    alias: string;
    scope: import("../../config/types.base.ts").SessionScope;
};
export declare function resolveDisplaySessionKey(params: {
    key: string;
    alias: string;
    mainKey: string;
}): string;
export declare function resolveInternalSessionKey(params: {
    key: string;
    alias: string;
    mainKey: string;
}): string;
export declare function listSpawnedSessionKeys(params: {
    requesterSessionKey: string;
    limit?: number;
}): Promise<Set<string>>;
export declare function isRequesterSpawnedSessionVisible(params: {
    requesterSessionKey: string;
    targetSessionKey: string;
    limit?: number;
}): Promise<boolean>;
export declare function shouldVerifyRequesterSpawnedSessionVisibility(params: {
    requesterSessionKey: string;
    targetSessionKey: string;
    restrictToSpawned: boolean;
    resolvedViaSessionId: boolean;
}): boolean;
export declare function isResolvedSessionVisibleToRequester(params: {
    requesterSessionKey: string;
    targetSessionKey: string;
    restrictToSpawned: boolean;
    resolvedViaSessionId: boolean;
    limit?: number;
}): Promise<boolean>;
export declare function looksLikeSessionId(value: string): boolean;
export declare function looksLikeSessionKey(value: string): boolean;
export declare function shouldResolveSessionIdInput(value: string): boolean;
export type SessionReferenceResolution = {
    ok: true;
    key: string;
    displayKey: string;
    resolvedViaSessionId: boolean;
} | {
    ok: false;
    status: "error" | "forbidden";
    error: string;
};
export declare function resolveSessionReference(params: {
    sessionKey: string;
    alias: string;
    mainKey: string;
    requesterInternalKey?: string;
    restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution>;
export declare function normalizeOptionalKey(value?: string): string | undefined;
