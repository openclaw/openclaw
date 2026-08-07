import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import type {
  AgentHarnessApprovalOperations,
  AgentHarnessPluginApprovalResult,
  NativeHookRelayApprovalAuthority,
} from "./agent-harness-approval-authority.types.js";
import {
  requestDeferredPluginToolApproval,
  runBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { resolveEmbeddedAttemptExecutionAttribution } from "./embedded-agent-runner/run/attempt-execution-attribution.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import type {
  NativeHookRelayRegistrationHandle,
  RegisterNativeHookRelayParams,
} from "./harness/native-hook-relay-types.js";
import { registerNativeHookRelayWithApprovalAuthority } from "./harness/native-hook-relay.js";
import { resolveAgentHarnessSideQuestionExecutionAttribution } from "./harness/side-question-execution-attribution.js";
import type { AgentHarnessSideQuestionParams } from "./harness/types.js";
import {
  captureGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  type GatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import { callGatewayTool } from "./tools/gateway.js";

/** Structured approval operations available only to a host-admitted harness request. */
export type AgentHarnessApprovalAuthority = AgentHarnessApprovalOperations & {
  registerNativeHookRelay: (
    request: RegisterNativeHookRelayParams,
  ) => NativeHookRelayRegistrationHandle;
};

export type {
  AgentHarnessBeforeToolCallApprovalRequest,
  AgentHarnessPluginApprovalRequest,
  AgentHarnessPluginApprovalResult,
} from "./agent-harness-approval-authority.types.js";

type ApprovalCaller = {
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  identity?: GatewayToolCallerIdentity;
};

function createAgentHarnessApprovalAuthority(
  caller: ApprovalCaller,
): AgentHarnessApprovalAuthority {
  const withCaller = <T>(run: () => Promise<T> | T) =>
    withGatewayToolCallerIdentity(caller.identity, run);
  const requestPluginApproval: AgentHarnessApprovalAuthority["requestPluginApproval"] = async (
    request,
  ) =>
    await withCaller(
      async () =>
        (await callGatewayTool(
          "plugin.approval.request",
          { timeoutMs: request.gatewayTimeoutMs },
          {
            pluginId: request.pluginId,
            title: request.title,
            description: request.description,
            severity: request.severity,
            toolName: request.toolName,
            toolCallId: request.toolCallId,
            agentId: caller.agentId,
            sessionKey: caller.sessionKey,
            turnSourceChannel: caller.turnSourceChannel,
            turnSourceTo: caller.turnSourceTo,
            turnSourceAccountId: caller.turnSourceAccountId,
            turnSourceThreadId: caller.turnSourceThreadId,
            timeoutMs: request.timeoutMs,
            twoPhase: true,
            ...(request.allowedDecisions ? { allowedDecisions: request.allowedDecisions } : {}),
          },
          { expectFinal: false },
        )) as AgentHarnessPluginApprovalResult | undefined,
    );
  const waitForPluginApprovalDecision: AgentHarnessApprovalAuthority["waitForPluginApprovalDecision"] =
    async (request) =>
      await withCaller(
        async () =>
          (await callGatewayTool(
            "plugin.approval.waitDecision",
            { timeoutMs: request.gatewayTimeoutMs },
            { id: request.approvalId },
          )) as AgentHarnessPluginApprovalResult | null | undefined,
      );
  const runBeforeToolCallApproval: AgentHarnessApprovalAuthority["runBeforeToolCallApproval"] =
    async (request) => await withCaller(async () => await runBeforeToolCallHook(request));
  const nativeAuthority: NativeHookRelayApprovalAuthority = Object.freeze({
    requestPluginApproval,
    waitForPluginApprovalDecision,
    runBeforeToolCallApproval,
    resolveDeferredToolApproval: async (request) =>
      await withCaller(async () => await requestDeferredPluginToolApproval(request)),
  });
  return Object.freeze({
    requestPluginApproval,
    waitForPluginApprovalDecision,
    runBeforeToolCallApproval,
    registerNativeHookRelay: (request) =>
      registerNativeHookRelayWithApprovalAuthority(request, nativeAuthority),
  });
}

function captureAttemptCaller(attempt: EmbeddedRunAttemptParams): ApprovalCaller {
  const attribution = resolveEmbeddedAttemptExecutionAttribution(attempt);
  const turnSourceChannel = attempt.messageChannel ?? attempt.messageProvider;
  const turnSourceTo = attempt.currentMessagingTarget ?? attempt.currentChannelId;
  return {
    agentId: attempt.agentId,
    sessionKey: attempt.sessionKey,
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId: attempt.agentAccountId,
    turnSourceThreadId: attempt.currentThreadTs,
    identity: captureGatewayToolCallerIdentity(
      attempt.agentId,
      {
        agentSessionKey: attempt.sessionKey,
        agentChannel: turnSourceChannel,
        agentAccountId: attempt.agentAccountId,
        currentMessagingTarget: attempt.currentMessagingTarget,
        currentChannelId: attempt.currentChannelId,
        currentThreadTs: attempt.currentThreadTs,
      },
      {
        attribution,
        executionIdentityEnabled: isExecutionIdentityCollectionEnabled(attempt.config),
      },
    ),
  };
}

function captureSideQuestionCaller(params: AgentHarnessSideQuestionParams): ApprovalCaller {
  const attribution = resolveAgentHarnessSideQuestionExecutionAttribution(params);
  const turnSourceChannel = params.messageChannel ?? params.messageProvider;
  const turnSourceTo = params.currentChannelId ?? params.messageTo;
  return {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId: params.agentAccountId,
    turnSourceThreadId: params.messageThreadId,
    identity: captureGatewayToolCallerIdentity(
      params.agentId,
      {
        agentSessionKey: params.sessionKey,
        agentChannel: turnSourceChannel,
        agentAccountId: params.agentAccountId,
        agentTo: params.messageTo,
        agentThreadId: params.messageThreadId,
        currentChannelId: params.currentChannelId,
      },
      {
        attribution,
        executionIdentityEnabled: isExecutionIdentityCollectionEnabled(params.cfg),
      },
    ),
  };
}

export function createApprovalAuthorityForAgentHarnessAttempt(
  attempt: EmbeddedRunAttemptParams,
): AgentHarnessApprovalAuthority {
  return createAgentHarnessApprovalAuthority(captureAttemptCaller(attempt));
}

export function createApprovalAuthorityForAgentHarnessSideQuestion(
  params: AgentHarnessSideQuestionParams,
): AgentHarnessApprovalAuthority {
  return createAgentHarnessApprovalAuthority(captureSideQuestionCaller(params));
}
