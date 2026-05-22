import type { ChannelApprovalCapability, ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY, createLazyChannelApprovalNativeRuntimeAdapter } from "./approval-handler-adapter-runtime.js";
import type { ApprovalRequest, ApprovalResolved, ChannelApprovalKind, ChannelApprovalNativeRuntimeAdapter, ChannelApprovalNativeRuntimeSpec } from "./approval-handler-runtime-types.js";
import type { ChannelNativeApprovalDeliveryCallbacks, ChannelNativeApprovalTransportSpec } from "./approval-native-runtime-types.js";
import type { ExpiredApprovalView, PendingApprovalView, ResolvedApprovalView } from "./approval-view-model.types.js";
import type { ExecApprovalChannelRuntime } from "./exec-approval-channel-runtime.js";
import type { ExecApprovalChannelRuntimeEventKind } from "./exec-approval-channel-runtime.types.js";
export type { ApprovalActionView, ApprovalMetadataView, ApprovalViewModel, ExecApprovalExpiredView, ExecApprovalPendingView, ExecApprovalResolvedView, ExpiredApprovalView, PendingApprovalView, PluginApprovalExpiredView, PluginApprovalPendingView, PluginApprovalResolvedView, ResolvedApprovalView, } from "./approval-view-model.types.js";
export { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY, createLazyChannelApprovalNativeRuntimeAdapter, };
export type { ChannelApprovalCapabilityHandlerContext, ChannelApprovalNativeAvailabilityAdapter, ChannelApprovalNativeFinalAction, ChannelApprovalNativeInteractionAdapter, ChannelApprovalNativeObserveAdapter, ChannelApprovalNativePresentationAdapter, ChannelApprovalNativeRuntimeAdapter, ChannelApprovalNativeRuntimeSpec, ChannelApprovalNativeTransportAdapter, } from "./approval-handler-runtime-types.js";
export type ChannelApprovalHandler<TRequest extends ApprovalRequest = ApprovalRequest, TResolved extends ApprovalResolved = ApprovalResolved> = ExecApprovalChannelRuntime<TRequest, TResolved>;
export declare function createChannelApprovalNativeRuntimeAdapter<TPendingPayload, TPreparedTarget, TPendingEntry, TBinding = unknown, TFinalPayload = unknown, TPendingView extends PendingApprovalView = PendingApprovalView, TResolvedView extends ResolvedApprovalView = ResolvedApprovalView, TExpiredView extends ExpiredApprovalView = ExpiredApprovalView>(spec: ChannelApprovalNativeRuntimeSpec<TPendingPayload, TPreparedTarget, TPendingEntry, TBinding, TFinalPayload, TPendingView, TResolvedView, TExpiredView>): ChannelApprovalNativeRuntimeAdapter<TPendingPayload, TPreparedTarget, TPendingEntry, TBinding, TFinalPayload>;
type ChannelApprovalHandlerRuntimeSpec<TRequest extends ApprovalRequest> = {
    label: string;
    clientDisplayName: string;
    cfg: OpenClawConfig;
    gatewayUrl?: string;
    eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
    channel?: string;
    channelLabel?: string;
    accountId?: string | null;
    nativeAdapter?: ChannelApprovalNativeAdapter | null;
    resolveApprovalKind?: (request: TRequest) => ChannelApprovalKind;
    isConfigured: () => boolean;
    shouldHandle: (request: TRequest) => boolean;
    nowMs?: () => number;
};
type ChannelApprovalHandlerContentSpec<TPendingContent, TRequest extends ApprovalRequest = ApprovalRequest> = {
    buildPendingContent: (params: {
        request: TRequest;
        approvalKind: ChannelApprovalKind;
        nowMs: number;
    }) => TPendingContent | Promise<TPendingContent>;
};
type ChannelApprovalHandlerTransportSpec<TPendingEntry, TPreparedTarget, TPendingContent, TRequest extends ApprovalRequest = ApprovalRequest> = ChannelNativeApprovalTransportSpec<TPendingEntry, TPreparedTarget, TPendingContent, TRequest>;
type ChannelApprovalHandlerLifecycleSpec<TPendingEntry, TPreparedTarget, TPendingContent, TRequest extends ApprovalRequest = ApprovalRequest, TResolved extends ApprovalResolved = ApprovalResolved> = ChannelNativeApprovalDeliveryCallbacks<TPendingEntry, TPreparedTarget, TPendingContent, TRequest> & {
    finalizeResolved: (params: {
        request: TRequest;
        resolved: TResolved;
        entries: TPendingEntry[];
    }) => Promise<void>;
    finalizeExpired?: (params: {
        request: TRequest;
        entries: TPendingEntry[];
    }) => Promise<void>;
    onStopped?: () => Promise<void> | void;
};
export type ChannelApprovalHandlerAdapter<TPendingEntry, TPreparedTarget, TPendingContent, TRequest extends ApprovalRequest = ApprovalRequest, TResolved extends ApprovalResolved = ApprovalResolved> = {
    runtime: ChannelApprovalHandlerRuntimeSpec<TRequest>;
    content: ChannelApprovalHandlerContentSpec<TPendingContent, TRequest>;
    transport: ChannelApprovalHandlerTransportSpec<TPendingEntry, TPreparedTarget, TPendingContent, TRequest>;
    lifecycle: ChannelApprovalHandlerLifecycleSpec<TPendingEntry, TPreparedTarget, TPendingContent, TRequest, TResolved>;
};
export declare function createChannelApprovalHandler<TPendingEntry, TPreparedTarget, TPendingContent, TRequest extends ApprovalRequest = ApprovalRequest, TResolved extends ApprovalResolved = ApprovalResolved>(adapter: ChannelApprovalHandlerAdapter<TPendingEntry, TPreparedTarget, TPendingContent, TRequest, TResolved>): ChannelApprovalHandler<TRequest, TResolved>;
export declare function createChannelApprovalHandlerFromCapability(params: {
    capability?: Pick<ChannelApprovalCapability, "native" | "nativeRuntime"> | null;
    label: string;
    clientDisplayName: string;
    channel: string;
    channelLabel: string;
    cfg: OpenClawConfig;
    accountId?: string | null;
    gatewayUrl?: string;
    context?: unknown;
    nowMs?: () => number;
}): Promise<ChannelApprovalHandler | null>;
