import type { SessionWriterDeliveryAuthority } from "../../auto-reply/reply-payload.js";
import { assertSessionWriterDeliveryAuthorized } from "../../auto-reply/reply/session-writer-delivery-authority.js";
import { messageToolOwnsVisibleReply } from "../../auto-reply/source-reply-delivery-mode.js";
import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import type {
  CurrentTurnDeliveryAuthority,
  CurrentTurnDeliveryConstruction,
  CurrentTurnDeliveryToolRef,
} from "../current-turn-delivery.js";
import { createCurrentTurnReplyCompletionOwner } from "../current-turn-reply-completion.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { supportsModelTools } from "../model-tool-support.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import { registerTrustedToolNoStartError } from "../tool-result-error.js";
import { resolveAgentToolSurfacePlan } from "../tool-surface-plan.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { AgentHarnessToolResultCapabilities } from "./host-capability-types.js";

type HostAttempt = Partial<EmbeddedRunAttemptParams>;

type HostCurrentTurnDeliveryOwner = Readonly<{
  authority: CurrentTurnDeliveryAuthority;
  completionOwner: object;
  create: (
    resultCapabilities?: AgentHarnessToolResultCapabilities,
  ) => CurrentTurnDeliveryConstruction;
}>;

export function createHostCurrentTurnDeliveryOwner(params: {
  abortSignal: AbortSignal;
  assertActive: () => void;
  attempt: HostAttempt;
  sessionTarget: HostAttempt["sessionTarget"];
}): HostCurrentTurnDeliveryOwner {
  const target = params.sessionTarget;
  const completionOwner = createCurrentTurnReplyCompletionOwner(
    params.attempt.assistantErrorTranscript,
  );
  const sessionWriterAuthority: SessionWriterDeliveryAuthority | undefined =
    target?.sessionId && target.sessionKey && target.storePath && target.expectedWriterRunId
      ? {
          agentId: target.agentId,
          expectedLifecycleRevision: target.expectedLifecycleRevision,
          expectedSessionId: target.sessionId,
          expectedWriterRunId: target.expectedWriterRunId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
        }
      : undefined;
  const codeModeControlsEnabled =
    params.attempt.model !== undefined &&
    resolveAgentToolSurfacePlan({
      config: params.attempt.config,
      agentId: params.attempt.agentId,
      sessionKey: params.attempt.sessionKey,
      forceDirectMessageTool: messageToolOwnsVisibleReply(params.attempt),
      model: params.attempt.model,
      modelProvider: params.attempt.provider,
      modelId: params.attempt.modelId,
      codeModeOverride: params.attempt.codeModeOverride,
      toolsEnabled: supportsModelTools(params.attempt.model),
      disableTools: params.attempt.disableTools,
      isRawModelRun: params.attempt.modelRun === true || params.attempt.promptMode === "none",
      toolsAllow: params.attempt.toolsAllow,
      forceCodeModeControls: params.attempt.forceCodeModeTools,
    }).codeModeControlsEnabled;
  const deliveryAuthority: CurrentTurnDeliveryAuthority = Object.freeze({
    abortSignal: params.abortSignal,
    assertActive: () => {
      params.assertActive();
      assertSessionWriterDeliveryAuthorized(sessionWriterAuthority);
    },
  });
  const terminalReplyAuthority: CurrentTurnDeliveryAuthority | undefined = sessionWriterAuthority
    ? Object.freeze({
        abortSignal: params.abortSignal,
        assertActive: () => {
          params.assertActive();
          assertSessionWriterDeliveryAuthorized(sessionWriterAuthority);
        },
      })
    : undefined;
  return Object.freeze({
    authority: deliveryAuthority,
    completionOwner,
    create: (resultCapabilities) => {
      const toolRef: CurrentTurnDeliveryToolRef | undefined =
        terminalReplyAuthority &&
        codeModeControlsEnabled &&
        resultCapabilities?.terminalCompletion === "per-result" &&
        !params.attempt.forceRestartSafeTools
          ? {}
          : undefined;
      return {
        deliveryAuthority,
        ...(toolRef && terminalReplyAuthority
          ? { terminalReply: { authority: terminalReplyAuthority, toolRef, completionOwner } }
          : {}),
      };
    },
  });
}

export function gateAgentHarnessHostTool(
  tool: AnyAgentTool,
  assertActive: () => void,
  observeResult: (result: unknown) => void,
): AnyAgentTool {
  const execute = tool.execute;
  const sourcePreparer = getInternalToolExecutionPreparer(tool);
  if (!execute && !sourcePreparer) {
    return tool;
  }
  const gated: AnyAgentTool = {
    ...tool,
    ...(execute
      ? {
          execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) => {
            try {
              assertActive();
            } catch (error) {
              // Revocation precedes dispatch, so terminal evidence must not claim a start.
              throw registerTrustedToolNoStartError(error);
            }
            const result = await execute(...args);
            assertActive();
            observeResult(result);
            return result;
          },
        }
      : {}),
  };
  copyAgentToolMetadata(tool, gated);
  if (sourcePreparer) {
    attachInternalToolExecutionPreparer(gated, async (preparationParams) => {
      assertActive();
      const prepared = await sourcePreparer(preparationParams);
      try {
        assertActive();
      } catch (error) {
        prepared.dispose();
        throw error;
      }
      if (prepared.kind === "immediate") {
        if (prepared.outcome.kind === "result") {
          observeResult(prepared.outcome.result);
        }
        return prepared;
      }
      return {
        ...prepared,
        execute: async (onImplementationStart) => {
          assertActive();
          const result = await prepared.execute(onImplementationStart);
          assertActive();
          observeResult(result);
          return result;
        },
      };
    });
  }
  return gated;
}
