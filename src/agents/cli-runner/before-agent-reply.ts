import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../../plugins/before-agent-reply.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./log.js";
import type { RunCliAgentParams } from "./types.js";

export async function runCliBeforeAgentReply(
  params: RunCliAgentParams,
  assertCurrent?: () => void,
): Promise<EmbeddedAgentRunResult | undefined> {
  const hookStartedAt = Date.now();
  // Prompt-only inference cannot enter agent hooks: they may replace the turn
  // or add side effects before the exact zero-tool process even starts.
  const hookResult =
    params.isolatedCompletion || params.controlOperation
      ? undefined
      : await runBeforeAgentReplyForTurn({
          runId: params.runId,
          trigger: params.trigger,
          assertCurrent,
          event: { cleanedBody: params.prompt },
          context: {
            runId: params.runId,
            jobId: params.jobId,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            workspaceDir: params.workspaceDir,
            trigger: params.trigger,
            ...buildAgentHookContextChannelFields(params),
            ...buildAgentHookContextIdentityFields({
              trigger: params.trigger,
              senderId: params.senderId,
              chatId: params.chatId,
              channelContext: params.channelContext,
            }),
          },
          onDispatch: () =>
            params.onExecutionPhase?.({
              phase: "before_agent_reply",
              provider: params.provider,
              model: params.model ?? "",
            }),
          onDeclined: () =>
            params.onExecutionPhase?.({
              phase: "runtime_plugins",
              provider: params.provider,
              model: params.model ?? "",
            }),
        });
  if (hookResult?.handled) {
    const finalText = hookResult.reply?.text ?? SILENT_REPLY_TOKEN;
    const syntheticBackend = resolveCliBackendConfig(params.provider, params.config, {
      agentId: params.agentId,
    });
    const sessionBindingDisabled = syntheticBackend?.config.sessionMode === "none";
    cliBackendLog.info(
      `cli synthetic turn: provider=${params.provider} model=<synthetic> requestedModel=${params.model ?? ""} durationMs=${Date.now() - hookStartedAt} ${formatCliBackendOutputDigest(finalText)}`,
    );
    return {
      payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply),
      meta: {
        durationMs: Date.now() - hookStartedAt,
        agentMeta: {
          sessionId: "",
          provider: params.modelProvider ?? params.provider,
          model: params.model ?? "",
          ...(sessionBindingDisabled ? { clearCliSessionBinding: true } : {}),
        },
        finalAssistantVisibleText: finalText,
        finalAssistantRawText: finalText,
      },
    };
  }
  return undefined;
}
