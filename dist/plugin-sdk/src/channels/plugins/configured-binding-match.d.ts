import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import type { CompiledConfiguredBinding, ConfiguredBindingChannel, ConfiguredBindingRecordResolution } from "./binding-types.js";
import type { ChannelConfiguredBindingConversationRef, ChannelConfiguredBindingMatch } from "./types.adapters.js";
export declare function resolveAccountMatchPriority(match: string | undefined, actual: string): 0 | 1 | 2;
export declare function resolveCompiledBindingChannel(raw: string): ConfiguredBindingChannel | null;
export declare function toConfiguredBindingConversationRef(conversation: ConversationRef): {
    channel: ConfiguredBindingChannel;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
} | null;
export declare function materializeConfiguredBindingRecord(params: {
    rule: CompiledConfiguredBinding;
    accountId: string;
    conversation: ChannelConfiguredBindingConversationRef;
}): ConfiguredBindingRecordResolution;
export declare function resolveMatchingConfiguredBinding(params: {
    rules: CompiledConfiguredBinding[];
    conversation: ReturnType<typeof toConfiguredBindingConversationRef>;
}): {
    rule: CompiledConfiguredBinding;
    match: ChannelConfiguredBindingMatch;
} | null;
