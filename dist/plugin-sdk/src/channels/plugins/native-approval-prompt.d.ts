import type { ChannelPlugin } from "./types.plugin.js";
export declare const NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY = "nativeApprovals";
export declare function channelPluginHasNativeApprovalPromptUi(plugin?: Pick<ChannelPlugin, "approvalCapability"> | null): boolean;
export declare function isKnownNativeApprovalPromptChannel(channel?: string | null): boolean;
export declare function hasNativeApprovalPromptRuntimeCapability(capabilities?: readonly string[] | null): boolean;
