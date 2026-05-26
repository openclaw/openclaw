import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
declare const NATIVE_HOOK_RELAY_EVENTS: readonly ["pre_tool_use", "post_tool_use", "permission_request", "before_agent_finalize"];
declare const NATIVE_HOOK_RELAY_PROVIDERS: readonly ["codex"];
export type NativeHookRelayEvent = (typeof NATIVE_HOOK_RELAY_EVENTS)[number];
export type NativeHookRelayProvider = (typeof NATIVE_HOOK_RELAY_PROVIDERS)[number];
export type NativeHookRelayInvocation = {
    provider: NativeHookRelayProvider;
    relayId: string;
    event: NativeHookRelayEvent;
    nativeEventName?: string;
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    runId: string;
    cwd?: string;
    model?: string;
    turnId?: string;
    transcriptPath?: string;
    permissionMode?: string;
    stopHookActive?: boolean;
    lastAssistantMessage?: string;
    toolName?: string;
    toolUseId?: string;
    rawPayload: JsonValue;
    receivedAt: string;
};
export type NativeHookRelayProcessResponse = {
    stdout: string;
    stderr: string;
    exitCode: number;
};
export type NativeHookRelayRegistration = {
    relayId: string;
    provider: NativeHookRelayProvider;
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    config?: OpenClawConfig;
    runId: string;
    allowedEvents: readonly NativeHookRelayEvent[];
    expiresAtMs: number;
    signal?: AbortSignal;
};
export type NativeHookRelayRegistrationHandle = NativeHookRelayRegistration & {
    commandForEvent: (event: NativeHookRelayEvent) => string;
    unregister: () => void;
};
export type RegisterNativeHookRelayParams = {
    provider: NativeHookRelayProvider;
    relayId?: string;
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    config?: OpenClawConfig;
    runId: string;
    allowedEvents?: readonly NativeHookRelayEvent[];
    ttlMs?: number;
    command?: NativeHookRelayCommandOptions;
    signal?: AbortSignal;
};
export type NativeHookRelayCommandOptions = {
    executable?: string;
    nodeExecutable?: string;
    timeoutMs?: number;
};
export type InvokeNativeHookRelayParams = {
    provider: unknown;
    relayId: unknown;
    event: unknown;
    rawPayload: unknown;
};
export type InvokeNativeHookRelayBridgeParams = InvokeNativeHookRelayParams & {
    registrationTimeoutMs?: number;
    timeoutMs?: number;
};
type NativeHookRelayPermissionDecision = "allow" | "deny";
type NativeHookRelayPermissionApprovalResult = NativeHookRelayPermissionDecision | "allow-always" | "defer";
type NativeHookRelayPermissionApprovalRequest = {
    provider: NativeHookRelayProvider;
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    runId: string;
    toolName: string;
    toolCallId?: string;
    cwd?: string;
    model?: string;
    toolInput: Record<string, JsonValue>;
    signal?: AbortSignal;
};
type NativeHookRelayPermissionApprovalRequester = (request: NativeHookRelayPermissionApprovalRequest) => Promise<NativeHookRelayPermissionApprovalResult>;
export declare function registerNativeHookRelay(params: RegisterNativeHookRelayParams): NativeHookRelayRegistrationHandle;
export declare function buildNativeHookRelayCommand(params: {
    provider: NativeHookRelayProvider;
    relayId: string;
    event: NativeHookRelayEvent;
    timeoutMs?: number;
    executable?: string;
    nodeExecutable?: string;
}): string;
export declare function invokeNativeHookRelay(params: InvokeNativeHookRelayParams): Promise<NativeHookRelayProcessResponse>;
export declare function invokeNativeHookRelayBridge(params: InvokeNativeHookRelayBridgeParams): Promise<NativeHookRelayProcessResponse>;
export declare function renderNativeHookRelayUnavailableResponse(params: {
    provider: unknown;
    event: unknown;
    message?: string;
}): NativeHookRelayProcessResponse;
export declare const __testing: {
    clearNativeHookRelaysForTests(): void;
    getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[];
    getNativeHookRelayRegistrationForTests(relayId: string): NativeHookRelayRegistration | undefined;
    getNativeHookRelayBridgeDirForTests(): string;
    getNativeHookRelayBridgeRegistryPathForTests(relayId: string): string;
    getNativeHookRelayBridgeRecordForTests(relayId: string): Record<string, unknown> | undefined;
    formatPermissionApprovalDescriptionForTests(request: NativeHookRelayPermissionApprovalRequest): string;
    permissionRequestContentFingerprintForTests(request: NativeHookRelayPermissionApprovalRequest): string;
    permissionRequestToolInputKeyFingerprintForTests(toolInput: Record<string, unknown>): string;
    setNativeHookRelayPermissionApprovalRequesterForTests(requester: NativeHookRelayPermissionApprovalRequester): void;
};
export {};
