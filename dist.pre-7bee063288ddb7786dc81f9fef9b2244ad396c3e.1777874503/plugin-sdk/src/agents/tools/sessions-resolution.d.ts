import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { listSpawnedSessionKeys } from "../../plugin-sdk/session-visibility.js";
import { looksLikeSessionId } from "../../sessions/session-id.js";
type GatewayCaller = typeof callGateway;
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
    requesterInternalKey?: string;
}): string;
export declare function resolveCurrentSessionClientAlias(params: {
    key: string;
    requesterInternalKey?: string;
}): string | undefined;
export { listSpawnedSessionKeys };
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
export { looksLikeSessionId };
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
export type VisibleSessionReferenceResolution = {
    ok: true;
    key: string;
    displayKey: string;
} | {
    ok: false;
    status: "forbidden";
    error: string;
    displayKey: string;
};
export declare function resolveSessionReference(params: {
    sessionKey: string;
    alias: string;
    mainKey: string;
    requesterInternalKey?: string;
    restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution>;
export declare function resolveVisibleSessionReference(params: {
    resolvedSession: Extract<SessionReferenceResolution, {
        ok: true;
    }>;
    requesterSessionKey: string;
    restrictToSpawned: boolean;
    visibilitySessionKey: string;
}): Promise<VisibleSessionReferenceResolution>;
export declare const normalizeOptionalKey: (value?: string) => string | undefined;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<{
        callGateway: GatewayCaller;
    }>): void;
};
