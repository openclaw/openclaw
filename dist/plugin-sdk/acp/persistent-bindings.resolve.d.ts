import type { OpenClawConfig } from "../config/config.js";
import { type ConfiguredAcpBindingSpec, type ResolvedConfiguredAcpBinding } from "./persistent-bindings.types.js";
export declare function resolveConfiguredAcpBindingSpecBySessionKey(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
}): ConfiguredAcpBindingSpec | null;
export declare function resolveConfiguredAcpBindingRecord(params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
}): ResolvedConfiguredAcpBinding | null;
