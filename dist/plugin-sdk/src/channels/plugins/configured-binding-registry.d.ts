import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import type { ConfiguredBindingRecordResolution, ConfiguredBindingResolution } from "./binding-types.js";
export declare function primeConfiguredBindingRegistry(params: {
    cfg: OpenClawConfig;
}): {
    bindingCount: number;
    channelCount: number;
};
export declare function resolveConfiguredBindingRecord(params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
}): ConfiguredBindingRecordResolution | null;
export declare function resolveConfiguredBindingRecordForConversation(params: {
    cfg: OpenClawConfig;
    conversation: ConversationRef;
}): ConfiguredBindingRecordResolution | null;
export declare function resolveConfiguredBinding(params: {
    cfg: OpenClawConfig;
    conversation: ConversationRef;
}): ConfiguredBindingResolution | null;
export declare function resolveConfiguredBindingRecordBySessionKey(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
}): ConfiguredBindingRecordResolution | null;
