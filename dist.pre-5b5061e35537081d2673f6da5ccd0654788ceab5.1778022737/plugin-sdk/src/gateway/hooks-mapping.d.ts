import type { HooksConfig } from "../config/types.hooks.js";
import type { HookMessageChannel } from "./hooks.types.js";
export type HookMappingResolved = {
    id: string;
    matchPath?: string;
    matchSource?: string;
    action: "wake" | "agent";
    wakeMode?: "now" | "next-heartbeat";
    name?: string;
    agentId?: string;
    sessionKey?: string;
    messageTemplate?: string;
    textTemplate?: string;
    deliver?: boolean;
    allowUnsafeExternalContent?: boolean;
    channel?: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    transform?: HookMappingTransformResolved;
};
type HookMappingTransformResolved = {
    modulePath: string;
    exportName?: string;
};
type HookMappingContext = {
    payload: Record<string, unknown>;
    headers: Record<string, string>;
    url: URL;
    path: string;
};
type HookAction = {
    kind: "wake";
    text: string;
    mode: "now" | "next-heartbeat";
} | {
    kind: "agent";
    message: string;
    name?: string;
    agentId?: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey?: string;
    sessionKeySource?: "static" | "templated";
    deliver?: boolean;
    allowUnsafeExternalContent?: boolean;
    channel?: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
};
type HookMappingResult = {
    ok: true;
    action: HookAction;
} | {
    ok: true;
    action: null;
    skipped: true;
} | {
    ok: false;
    error: string;
};
export declare function resolveHookMappings(hooks?: HooksConfig, opts?: {
    configDir?: string;
}): HookMappingResolved[];
export declare function applyHookMappings(mappings: HookMappingResolved[], ctx: HookMappingContext): Promise<HookMappingResult | null>;
export declare function hasHookTemplateExpressions(template: string): boolean;
export {};
