import type { PluginHookReplyDispatchContext, PluginHookReplyDispatchEvent, PluginHookReplyDispatchResult } from "../plugins/types.js";
export { AcpRuntimeError, isAcpRuntimeError } from "../acp/runtime/errors.js";
export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export { getAcpRuntimeBackend, registerAcpRuntimeBackend, requireAcpRuntimeBackend, unregisterAcpRuntimeBackend, } from "../acp/runtime/registry.js";
export type { AcpRuntime, AcpRuntimeCapabilities, AcpRuntimeDoctorReport, AcpRuntimeEnsureInput, AcpRuntimeEvent, AcpRuntimeHandle, AcpRuntimeStatus, AcpRuntimeTurnAttachment, AcpRuntimeTurnInput, AcpSessionUpdateTag, } from "../acp/runtime/types.js";
export declare function tryDispatchAcpReplyHook(event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext): Promise<PluginHookReplyDispatchResult | void>;
