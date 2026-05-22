import type { ResolvedQmdConfig } from "./backend-config.js";
export declare function isQmdScopeAllowed(scope: ResolvedQmdConfig["scope"], sessionKey?: string): boolean;
export declare function deriveQmdScopeChannel(key?: string): string | undefined;
export declare function deriveQmdScopeChatType(key?: string): "channel" | "group" | "direct" | undefined;
