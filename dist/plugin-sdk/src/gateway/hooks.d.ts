import type { IncomingMessage } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookExternalContentSource } from "../security/external-content.js";
import { type HookMappingResolved } from "./hooks-mapping.js";
import type { HookMessageChannel } from "./hooks.types.js";
export type HooksConfigResolved = {
    basePath: string;
    token: string;
    maxBodyBytes: number;
    mappings: HookMappingResolved[];
    agentPolicy: HookAgentPolicyResolved;
    sessionPolicy: HookSessionPolicyResolved;
};
type HookAgentPolicyResolved = {
    defaultAgentId: string;
    knownAgentIds: Set<string>;
    allowedAgentIds?: Set<string>;
};
type HookSessionPolicyResolved = {
    defaultSessionKey?: string;
    allowRequestSessionKey: boolean;
    allowedSessionKeyPrefixes?: string[];
};
type HookSessionKeySource = "request" | "mapping-static" | "mapping-templated";
export declare function resolveHooksConfig(cfg: OpenClawConfig): HooksConfigResolved | null;
export declare function isSessionKeyAllowedByPrefix(sessionKey: string, prefixes: string[]): boolean;
export declare function extractHookToken(req: IncomingMessage): string | undefined;
export declare function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<{
    ok: true;
    value: unknown;
} | {
    ok: false;
    error: string;
}>;
export declare function normalizeHookHeaders(req: IncomingMessage): Record<string, string>;
export declare function normalizeWakePayload(payload: Record<string, unknown>): {
    ok: true;
    value: {
        text: string;
        mode: "now" | "next-heartbeat";
    };
} | {
    ok: false;
    error: string;
};
type HookAgentPayload = {
    message: string;
    name: string;
    agentId?: string;
    idempotencyKey?: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey?: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
};
export type HookAgentDispatchPayload = Omit<HookAgentPayload, "sessionKey"> & {
    sessionKey: string;
    sourcePath: string;
    allowUnsafeExternalContent?: boolean;
    externalContentSource?: HookExternalContentSource;
};
export type { HookMessageChannel } from "./hooks.types.js";
export declare const getHookChannelError: () => string;
export declare function resolveHookChannel(raw: unknown): HookMessageChannel | null;
export declare function resolveHookDeliver(raw: unknown): boolean;
export declare function resolveHookIdempotencyKey(params: {
    payload: Record<string, unknown>;
    headers?: Record<string, string>;
}): string | undefined;
export declare function resolveHookTargetAgentId(hooksConfig: HooksConfigResolved, agentId: string | undefined): string | undefined;
export declare function isHookAgentAllowed(hooksConfig: HooksConfigResolved, agentId: string | undefined): boolean;
export declare const getHookAgentPolicyError: () => string;
export declare const getHookSessionKeyPrefixError: (prefixes: string[]) => string;
export declare function resolveHookSessionKey(params: {
    hooksConfig: HooksConfigResolved;
    source: HookSessionKeySource;
    sessionKey?: string;
    idFactory?: () => string;
}): {
    ok: true;
    value: string;
} | {
    ok: false;
    error: string;
};
export declare function normalizeHookDispatchSessionKey(params: {
    sessionKey: string;
    targetAgentId: string | undefined;
}): string;
export declare function normalizeAgentPayload(payload: Record<string, unknown>): {
    ok: true;
    value: HookAgentPayload;
} | {
    ok: false;
    error: string;
};
