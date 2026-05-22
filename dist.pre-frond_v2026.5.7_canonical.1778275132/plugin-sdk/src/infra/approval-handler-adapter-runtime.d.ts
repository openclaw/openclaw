import type { ChannelApprovalNativeAvailabilityAdapter, ChannelApprovalNativeRuntimeAdapter } from "./approval-handler-runtime-types.js";
import type { ExecApprovalChannelRuntimeEventKind } from "./exec-approval-channel-runtime.types.js";
export declare const CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY = "approval.native";
export declare function createLazyChannelApprovalNativeRuntimeAdapter<TPendingPayload = unknown, TPreparedTarget = unknown, TPendingEntry = unknown, TBinding = unknown, TFinalPayload = unknown>(params: {
    load: () => Promise<ChannelApprovalNativeRuntimeAdapter<TPendingPayload, TPreparedTarget, TPendingEntry, TBinding, TFinalPayload>>;
    isConfigured: ChannelApprovalNativeAvailabilityAdapter["isConfigured"];
    shouldHandle: ChannelApprovalNativeAvailabilityAdapter["shouldHandle"];
    eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
    resolveApprovalKind?: ChannelApprovalNativeRuntimeAdapter["resolveApprovalKind"];
}): ChannelApprovalNativeRuntimeAdapter<TPendingPayload, TPreparedTarget, TPendingEntry, TBinding, TFinalPayload>;
