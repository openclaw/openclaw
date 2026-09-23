import { stableStringify } from "@openclaw/normalization-core";
import {
  getAgentToolResultMiddlewareMatcherScope,
  listAgentToolResultMiddlewares,
} from "../../plugins/agent-tool-result-middleware.js";
import { getGlobalHookRunnerRegistry } from "../../plugins/hook-runner-global-state.js";
import { hasGlobalHooks } from "../../plugins/hook-runner-global.js";
import { getToolHookMatcherScope } from "../../plugins/hooks.js";
import { mergePluginToolMatcherScopes } from "../../plugins/tool-hook-matcher.js";
import { getTrustedToolPolicyMatcherScope } from "../../plugins/trusted-tool-policy.js";
import {
  cancelDeferredPluginToolApproval,
  hasBeforeToolCallPolicy,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { payloadTextResult } from "../tools/common.js";
import { runAgentHarnessAfterToolCallHook } from "./hook-helpers.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "./lifecycle-hook-helpers.js";
import {
  nativeHookRelayParamsWereRewritten,
  normalizeNativeHookToolName,
  readNativeHookRelayApprovalMode,
} from "./native-hook-relay-codec.js";
import {
  runNativeHookRelayPermissionRequest,
  setNativeHookRelayPreToolUseApproval,
} from "./native-hook-relay-permissions.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayEvent,
  NativeHookRelayExecutionAdmission,
  NativeHookRelayInvocation,
  NativeHookRelayProcessResponse,
  NativeHookRelayProviderAdapter,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";
import { createAgentToolResultMiddlewareRunner } from "./tool-result-middleware.js";

function getGlobalToolHookMatcherScope(hookName: "before_tool_call" | "after_tool_call") {
  const registry = getGlobalHookRunnerRegistry();
  return registry ? getToolHookMatcherScope(registry, hookName) : undefined;
}

type NativeHookRelayPolicy = Pick<
  ActiveNativeHookRelayRegistration,
  "preToolUseLoopDetection" | "sessionKey" | "config" | "agentId"
> & { executionAdmissionToolNames?: readonly string[] };

/** Snapshot the same canonical native tool family for planning and receipt admission. */
export function snapshotNativeHookRelayExecutionAdmission(
  admission: NativeHookRelayExecutionAdmission | undefined,
): NativeHookRelayExecutionAdmission | undefined {
  return admission
    ? {
        toolNames: [...new Set(admission.toolNames.map(normalizeNativeHookToolName))],
        admit: admission.admit,
      }
    : undefined;
}

function nativePreToolUseMayRunLoopDetection(registration: NativeHookRelayPolicy): boolean {
  if (!registration.preToolUseLoopDetection || !registration.sessionKey) {
    return false;
  }
  const loopDetection = resolveToolLoopDetectionConfig({
    cfg: registration.config,
    agentId: registration.agentId,
  });
  return loopDetection?.enabled === true;
}

export function nativeHookRelayEventHasLocalWork(
  registration: NativeHookRelayPolicy,
  event: NativeHookRelayEvent,
): boolean {
  if (event === "pre_tool_use") {
    return (
      Boolean(registration.executionAdmissionToolNames?.length) ||
      hasBeforeToolCallPolicy() ||
      nativePreToolUseMayRunLoopDetection(registration)
    );
  }
  if (event === "post_tool_use") {
    return hasGlobalHooks("after_tool_call") || listAgentToolResultMiddlewares("codex").length > 0;
  }
  if (event === "before_agent_finalize") {
    return hasGlobalHooks("before_agent_finalize");
  }
  return true;
}

export function nativeHookRelayEventToolMatcher(
  registration: NativeHookRelayPolicy,
  event: NativeHookRelayEvent,
): readonly string[] | undefined {
  if (event === "pre_tool_use") {
    if (nativePreToolUseMayRunLoopDetection(registration)) {
      return undefined;
    }
    // Relay selection and policy execution must read the same scoped/root registry.
    const policyRegistry = getGlobalHookRunnerRegistry();
    const scope = mergePluginToolMatcherScopes([
      getGlobalToolHookMatcherScope("before_tool_call"),
      getTrustedToolPolicyMatcherScope(policyRegistry),
      registration.executionAdmissionToolNames?.length
        ? { matchAll: false, toolNames: registration.executionAdmissionToolNames }
        : undefined,
    ]);
    return scope?.matchAll ? undefined : scope?.toolNames;
  }
  if (event === "post_tool_use") {
    const scope = mergePluginToolMatcherScopes([
      getGlobalToolHookMatcherScope("after_tool_call"),
      getAgentToolResultMiddlewareMatcherScope("codex"),
    ]);
    return scope?.matchAll ? undefined : scope?.toolNames;
  }
  return undefined;
}

export async function processNativeHookRelayInvocation(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
  executionAdmission?: NativeHookRelayExecutionAdmission;
  assertExecutionAdmissionCurrent: () => void;
}): Promise<NativeHookRelayProcessResponse> {
  if (params.invocation.event === "pre_tool_use") {
    return runNativeHookRelayPreToolUse(params);
  }
  if (params.invocation.event === "post_tool_use") {
    return runNativeHookRelayPostToolUse(params);
  }
  if (params.invocation.event === "before_agent_finalize") {
    return runNativeHookRelayBeforeAgentFinalize(params);
  }
  return runNativeHookRelayPermissionRequest(params);
}

async function runNativeHookRelayPreToolUse(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
  executionAdmission?: NativeHookRelayExecutionAdmission;
  assertExecutionAdmissionCurrent: () => void;
}): Promise<NativeHookRelayProcessResponse> {
  const toolName = normalizeNativeHookToolName(params.invocation.toolName);
  const toolInput = params.adapter.readToolInput(params.invocation.rawPayload);
  const originalToolInputFingerprint = stableStringify(toolInput);
  const approvalMode = readNativeHookRelayApprovalMode(params.invocation.rawPayload);
  const policyRequest = {
    toolName,
    params: toolInput,
    ...(params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {}),
    signal: params.registration.signal,
  };
  const outcome = params.registration.runBeforeToolCall
    ? await params.registration.runBeforeToolCall({
        ...policyRequest,
        ...(approvalMode === "report" ? { approvalMode: "defer" } : {}),
        ...(params.invocation.cwd ? { nativeOperation: { cwd: params.invocation.cwd } } : {}),
      })
    : await runBeforeToolCallHook({
        ...policyRequest,
        ...(approvalMode === "report" ? { approvalMode: "defer" } : {}),
        ctx: {
          ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
          sessionId: params.registration.sessionId,
          ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
          ...(params.registration.config ? { config: params.registration.config } : {}),
          runId: params.registration.runId,
          ...(params.registration.channelId ? { channelId: params.registration.channelId } : {}),
          ...(params.registration.requester ? { requester: params.registration.requester } : {}),
          ...params.registration.approvalContext,
          ...(params.invocation.cwd
            ? { cwd: params.invocation.cwd, workspaceDir: params.invocation.cwd }
            : {}),
        },
      });
  try {
    params.registration.signal?.throwIfAborted();
    params.registration.assertActive?.();
  } catch (error) {
    // A disconnected request cannot leave an approval for a later tool to consume.
    if (!outcome.blocked && outcome.deferredApproval) {
      cancelDeferredPluginToolApproval(outcome.deferredApproval);
    }
    throw error;
  }
  if (outcome.blocked) {
    return params.adapter.renderPreToolUseBlockResponse(
      outcome.reason,
      outcome.kind === "failure" && outcome.disposition !== "blocked"
        ? outcome.disposition
        : undefined,
    );
  }
  if (
    !outcome.deferredApproval &&
    nativeHookRelayParamsWereRewritten(originalToolInputFingerprint, outcome.params)
  ) {
    // Native execution must not retain custody of rewritten inputs it will not use.
    return params.adapter.renderPreToolUseBlockResponse(
      "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
    );
  }
  try {
    if (params.executionAdmission?.toolNames.includes(toolName)) {
      // Accepted execution outlives the one-shot hook transport, while this
      // request must still be current before returning or publishing approval.
      params.executionAdmission.admit(params.invocation, params.assertExecutionAdmissionCurrent);
      params.registration.signal?.throwIfAborted();
      params.registration.assertActive?.();
    }
  } catch (error) {
    if (outcome.deferredApproval) {
      cancelDeferredPluginToolApproval(outcome.deferredApproval);
    }
    throw error;
  }
  if (outcome.deferredApproval) {
    if (
      !setNativeHookRelayPreToolUseApproval({
        relayId: params.registration.relayId,
        toolUseId: params.invocation.toolUseId,
        deferredApproval: outcome.deferredApproval,
        originalParamsFingerprint: originalToolInputFingerprint,
      })
    ) {
      cancelDeferredPluginToolApproval(outcome.deferredApproval);
      return params.adapter.renderPreToolUseBlockResponse(
        "Plugin approval required but Codex tool id unavailable.",
      );
    }
    return params.adapter.renderNoopResponse(params.invocation.event);
  }
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function runNativeHookRelayPostToolUse(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const toolName = normalizeNativeHookToolName(params.invocation.toolName);
  const toolCallId =
    params.invocation.toolUseId ?? `${params.invocation.event}:${params.invocation.receivedAt}`;
  const startArgs = params.adapter.readToolInput(params.invocation.rawPayload);
  const rawResult = params.adapter.readToolResponse(params.invocation.rawPayload);
  // Native results are observe-only for middleware: codex-rs PostToolUse hooks
  // cannot replace tool_response (PostToolUseOutcome has no result field), so a
  // transformed result reaches only after_tool_call observers, never the model.
  const hasToolResultMiddleware = listAgentToolResultMiddlewares("codex").length > 0;
  const result = !hasToolResultMiddleware
    ? rawResult
    : await createAgentToolResultMiddlewareRunner({
        runtime: "codex",
        ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
        sessionId: params.registration.sessionId,
        ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
        runId: params.registration.runId,
      }).applyToolResultMiddleware({
        turnId: params.invocation.turnId,
        toolCallId,
        toolName,
        args: startArgs,
        ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
        result: payloadTextResult(rawResult),
      });
  await runAgentHarnessAfterToolCallHook({
    toolName,
    toolCallId,
    runId: params.registration.runId,
    ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
    sessionId: params.registration.sessionId,
    ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
    ...(params.registration.channelId ? { channelId: params.registration.channelId } : {}),
    startArgs,
    result,
  });
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function runNativeHookRelayBeforeAgentFinalize(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const outcome = await runAgentHarnessBeforeAgentFinalizeHook({
    event: {
      runId: params.registration.runId,
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      ...(params.invocation.turnId ? { turnId: params.invocation.turnId } : {}),
      provider: params.registration.provider,
      ...(params.invocation.model ? { model: params.invocation.model } : {}),
      ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
      ...(params.invocation.transcriptPath
        ? { transcriptPath: params.invocation.transcriptPath }
        : {}),
      stopHookActive: params.invocation.stopHookActive === true,
      ...(params.invocation.lastAssistantMessage
        ? { lastAssistantMessage: params.invocation.lastAssistantMessage }
        : {}),
    },
    ctx: {
      ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      runId: params.registration.runId,
      ...(params.registration.channelId ? { channelId: params.registration.channelId } : {}),
      ...(params.invocation.cwd ? { workspaceDir: params.invocation.cwd } : {}),
      ...(params.invocation.model ? { modelId: params.invocation.model } : {}),
    },
  });
  if (outcome.action === "revise") {
    return params.adapter.renderBeforeAgentFinalizeReviseResponse(outcome.reason);
  }
  if (outcome.action === "finalize") {
    return params.adapter.renderBeforeAgentFinalizeStopResponse(outcome.reason);
  }
  return params.adapter.renderNoopResponse(params.invocation.event);
}
