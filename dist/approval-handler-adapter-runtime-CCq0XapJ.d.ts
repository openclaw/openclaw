import { i as ChannelApprovalNativeAvailabilityAdapter, j as ExecApprovalChannelRuntimeEventKind, l as ChannelApprovalNativeRuntimeAdapter } from "./approval-handler-runtime-types-Ba9ef56t.js";

//#region src/infra/approval-handler-adapter-runtime.d.ts
declare const CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY = "approval.native";
declare function createLazyChannelApprovalNativeRuntimeAdapter<TPendingPayload = unknown, TPreparedTarget = unknown, TPendingEntry = unknown, TBinding = unknown, TFinalPayload = unknown>(params: {
  load: () => Promise<ChannelApprovalNativeRuntimeAdapter<TPendingPayload, TPreparedTarget, TPendingEntry, TBinding, TFinalPayload>>;
  isConfigured: ChannelApprovalNativeAvailabilityAdapter["isConfigured"];
  shouldHandle: ChannelApprovalNativeAvailabilityAdapter["shouldHandle"];
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  resolveApprovalKind?: ChannelApprovalNativeRuntimeAdapter["resolveApprovalKind"];
}): ChannelApprovalNativeRuntimeAdapter<TPendingPayload, TPreparedTarget, TPendingEntry, TBinding, TFinalPayload>;
//#endregion
export { createLazyChannelApprovalNativeRuntimeAdapter as n, CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY as t };