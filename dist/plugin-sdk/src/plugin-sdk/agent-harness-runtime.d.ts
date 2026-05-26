import type { CodexBundleMcpThreadConfig, LoadCodexBundleMcpThreadConfigParams } from "../agents/codex-mcp-config.types.js";
import type { EmbeddedRunAttemptResult } from "../agents/pi-embedded-runner/run/types.js";
import { abortEmbeddedPiRun, clearActiveEmbeddedRun, resolveActiveEmbeddedRunSessionId, setActiveEmbeddedRun, type EmbeddedPiQueueMessageOptions } from "../agents/pi-embedded-runner/runs.js";
export declare const TOOL_PROGRESS_OUTPUT_MAX_CHARS = 8000;
export type { AgentMessage } from "@earendil-works/pi-agent-core";
export type { AgentHarness, AgentHarnessAttemptParams, AgentHarnessAttemptResult, AgentHarnessCompactParams, AgentHarnessCompactResult, AgentHarnessDeliveryDefaults, AgentHarnessResultClassification, AgentHarnessSideQuestionParams, AgentHarnessSideQuestionResult, AgentHarnessResetParams, AgentHarnessSupport, AgentHarnessSupportContext, } from "../agents/harness/types.js";
export type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult, } from "../agents/pi-embedded-runner/run/types.js";
export type { ContextEngine as HarnessContextEngine, ContextEngineHostCapability, ContextEngineOperation, ContextEngineProjection, } from "../context-engine/types.js";
export type { CompactEmbeddedPiSessionParams } from "../agents/pi-embedded-runner/compact.js";
export type { EmbeddedPiCompactResult } from "../agents/pi-embedded-runner/types.js";
export type { AnyAgentTool } from "../agents/tools/common.js";
export type { MessagingToolSend, MessagingToolSourceReplyPayload, } from "../agents/pi-embedded-messaging.types.js";
export type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
export type { AgentApprovalEventData, AgentEventPayload } from "../infra/agent-events.js";
export type { ExecApprovalDecision } from "../infra/exec-approvals.js";
export type { NormalizedUsage } from "../agents/usage.js";
export type { AgentToolResultMiddleware, AgentToolResultMiddlewareContext, AgentToolResultMiddlewareEvent, AgentToolResultMiddlewareHarness, AgentToolResultMiddlewareOptions, AgentToolResultMiddlewareResult, AgentToolResultMiddlewareRuntime, OpenClawAgentToolResult, } from "../plugins/agent-tool-result-middleware-types.js";
export type { CodexAppServerExtensionContext, CodexAppServerExtensionFactory, CodexAppServerExtensionRuntime, CodexAppServerToolResultEvent, CodexAppServerToolResultHandlerResult, } from "../plugins/codex-app-server-extension-types.js";
export type { NativeHookRelayEvent, NativeHookRelayProcessResponse, NativeHookRelayProvider, NativeHookRelayRegistrationHandle, } from "../agents/harness/native-hook-relay.js";
export { VERSION as OPENCLAW_VERSION } from "../version.js";
export { formatErrorMessage } from "../infra/errors.js";
export { formatApprovalDisplayPath } from "../infra/approval-display-paths.js";
export { buildAgentHookContextChannelFields } from "../plugins/hook-agent-context.js";
export { emitAgentEvent, onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
export { runAgentCleanupStep } from "../agents/run-cleanup-timeout.js";
export { log as embeddedAgentLog } from "../agents/pi-embedded-runner/logger.js";
export { buildAgentRuntimePlan } from "../agents/runtime-plan/build.js";
export { classifyEmbeddedPiRunResultForModelFallback } from "../agents/pi-embedded-runner/result-fallback-classifier.js";
export { resolveEmbeddedAgentRuntime } from "../agents/pi-embedded-runner/runtime.js";
export { resolveUserPath } from "../utils.js";
export { callGatewayTool } from "../agents/tools/gateway.js";
export type { NodeListNode } from "../agents/tools/nodes-utils.js";
export { listNodes, resolveNodeIdFromList, selectDefaultNodeFromList, } from "../agents/tools/nodes-utils.js";
export { formatToolAggregate } from "../auto-reply/tool-meta.js";
export { HEARTBEAT_RESPONSE_TOOL_NAME, normalizeHeartbeatToolResponse, } from "../auto-reply/heartbeat-tool-response.js";
export { isMessagingTool, isMessagingToolSendAction } from "../agents/pi-embedded-messaging.js";
export { extractToolResultMediaArtifact, filterToolResultMediaUrls, } from "../agents/pi-embedded-subscribe.tools.js";
export { normalizeUsage } from "../agents/usage.js";
export { resolveOpenClawAgentDir } from "./agent-dir-compat.js";
export { resolveAgentDir, resolveDefaultAgentDir, resolveSessionAgentIds, } from "../agents/agent-scope.js";
export { resolveModelAuthMode } from "../agents/model-auth.js";
export { supportsModelTools } from "../agents/model-tool-support.js";
export { resolveAttemptSpawnWorkspaceDir } from "../agents/pi-embedded-runner/run/attempt.thread-helpers.js";
export { buildEmbeddedAttemptToolRunContext } from "../agents/pi-embedded-runner/run/attempt.tool-run-context.js";
export { abortEmbeddedPiRun as abortAgentHarnessRun, clearActiveEmbeddedRun, resolveActiveEmbeddedRunSessionId, setActiveEmbeddedRun, };
/**
 * @deprecated Active-run queueing is an internal runtime concern. This legacy
 * boolean API only reports immediate queue eligibility and cannot observe async
 * runtime rejection; runtime-owned delivery paths should use acceptance-aware
 * steering instead of public SDK queueing.
 */
export declare function queueAgentHarnessMessage(sessionId: string, text: string, options?: EmbeddedPiQueueMessageOptions): boolean;
export { disposeRegisteredAgentHarnesses } from "../agents/harness/registry.js";
export { logAgentRuntimeToolDiagnostics, normalizeAgentRuntimeTools, } from "../agents/runtime-plan/tools.js";
export type { CodexBundleMcpThreadConfig, LoadCodexBundleMcpThreadConfigParams, } from "../agents/codex-mcp-config.types.js";
export { normalizeProviderToolSchemas } from "../agents/pi-embedded-runner/tool-schema-runtime.js";
export declare function loadCodexBundleMcpThreadConfig(params: LoadCodexBundleMcpThreadConfigParams): Promise<CodexBundleMcpThreadConfig>;
export { resolveSandboxContext } from "../agents/sandbox.js";
export { hasSandboxBindContainerPathAliases, hasSandboxBindReadonlyHostShadows, resolveWritableSandboxBindHostRoots, } from "../agents/sandbox/fs-paths.js";
export { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
export type { EmbeddedContextFile } from "../agents/pi-embedded-helpers/types.js";
export { isSubagentSessionKey } from "../routing/session-key.js";
export { acquireSessionWriteLock, resolveSessionWriteLockAcquireTimeoutMs, resolveSessionWriteLockOptions, type SessionWriteLockAcquireTimeoutConfig, } from "../agents/session-write-lock.js";
export { appendSessionTranscriptMessage } from "../config/sessions/transcript-append.js";
export { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
export { hasBeforeToolCallPolicy, isToolWrappedWithBeforeToolCallHook, runBeforeToolCallHook, setBeforeToolCallDiagnosticsEnabled, wrapToolWithBeforeToolCallHook, } from "../agents/pi-tools.before-tool-call.js";
export { resolveAgentHarnessBeforePromptBuildResult, runAgentHarnessAfterCompactionHook, runAgentHarnessBeforeCompactionHook, } from "../agents/harness/prompt-compaction-hook-helpers.js";
export { createCodexAppServerToolResultExtensionRunner } from "../agents/harness/codex-app-server-extensions.js";
export { createAgentToolResultMiddlewareRunner } from "../agents/harness/tool-result-middleware.js";
export { assertContextEngineHostSupport, CODEX_APP_SERVER_CONTEXT_ENGINE_HOST, } from "../context-engine/host-compat.js";
export { assembleHarnessContextEngine, bootstrapHarnessContextEngine, buildHarnessContextEngineRuntimeContext, buildHarnessContextEngineRuntimeContextFromUsage, finalizeHarnessContextEngineTurn, isActiveHarnessContextEngine, runHarnessContextEngineMaintenance, } from "../agents/harness/context-engine-lifecycle.js";
export { compactContextEngineWithSafetyTimeout, resolveCompactionTimeoutMs, } from "../agents/pi-embedded-runner/compaction-safety-timeout.js";
export { estimateRenderedLlmBoundaryTokenPressure, formatPrePromptPrecheckLog, PREEMPTIVE_OVERFLOW_ERROR_TEXT, shouldPreemptivelyCompactBeforePrompt, type LlmBoundaryTokenPressure, type PreemptiveCompactionDecision, } from "../agents/pi-embedded-runner/run/preemptive-compaction.js";
export { resolveContextEngineOwnerPluginId } from "../context-engine/registry.js";
export { runAgentHarnessAfterToolCallHook, runAgentHarnessBeforeMessageWriteHook, } from "../agents/harness/hook-helpers.js";
export { awaitAgentHarnessAgentEndHook, runAgentHarnessBeforeAgentFinalizeHook, runAgentHarnessAgentEndHook, runAgentHarnessLlmInputHook, runAgentHarnessLlmOutputHook, } from "../agents/harness/lifecycle-hook-helpers.js";
export { buildNativeHookRelayCommand, hasNativeHookRelayInvocation, invokeNativeHookRelay, testing as nativeHookRelayTesting, registerNativeHookRelay, } from "../agents/harness/native-hook-relay.js";
/**
 * Derive the same compact user-facing tool detail that Pi uses for progress logs.
 */
export type ToolProgressDetailMode = "explain" | "raw";
export declare function inferToolMetaFromArgs(toolName: string, args: unknown, options?: {
    detailMode?: ToolProgressDetailMode;
}): string | undefined;
/**
 * Prepare verbose tool output for user-facing progress messages.
 */
export declare function formatToolProgressOutput(output: string, options?: {
    maxChars?: number;
}): string | undefined;
export type AgentHarnessTerminalOutcomeInput = {
    assistantTexts: readonly string[];
    reasoningText?: string | null;
    planText?: string | null;
    promptError?: unknown;
    turnCompleted: boolean;
};
export type AgentHarnessTerminalOutcomeClassification = NonNullable<EmbeddedRunAttemptResult["agentHarnessResultClassification"]>;
/**
 * Classify terminal harness turns that completed without assistant output that
 * should advance fallback. Deliberate silent replies such as NO_REPLY count as
 * intentional output, while whitespace-only text remains fallback-eligible.
 * This is intentionally SDK-level so plugin harness adapters such as Codex
 * preserve the same OpenClaw-owned fallback signals as the built-in PI path
 * without re-implementing terminal-result policy.
 */
export declare function classifyAgentHarnessTerminalOutcome(params: AgentHarnessTerminalOutcomeInput): AgentHarnessTerminalOutcomeClassification | undefined;
