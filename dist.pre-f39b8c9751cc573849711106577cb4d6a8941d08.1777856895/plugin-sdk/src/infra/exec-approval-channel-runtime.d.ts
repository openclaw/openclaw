import type { GatewayReconnectPausedInfo } from "../gateway/client.js";
import type { ExecApprovalChannelRuntime, ExecApprovalChannelRuntimeAdapter } from "./exec-approval-channel-runtime.types.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";
export type { ExecApprovalChannelRuntime, ExecApprovalChannelRuntimeAdapter, ExecApprovalChannelRuntimeEventKind, } from "./exec-approval-channel-runtime.types.js";
type ApprovalRequestEvent = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolvedEvent = ExecApprovalResolved | PluginApprovalResolved;
export declare class ExecApprovalChannelRuntimeTerminalStartError extends Error {
    readonly detailCode: string | null;
    constructor(info: GatewayReconnectPausedInfo, cause?: unknown);
}
export declare function isExecApprovalChannelRuntimeTerminalStartError(error: unknown): error is ExecApprovalChannelRuntimeTerminalStartError;
export declare function createExecApprovalChannelRuntime<TPending, TRequest extends ApprovalRequestEvent = ExecApprovalRequest, TResolved extends ApprovalResolvedEvent = ExecApprovalResolved>(adapter: ExecApprovalChannelRuntimeAdapter<TPending, TRequest, TResolved>): ExecApprovalChannelRuntime<TRequest, TResolved>;
