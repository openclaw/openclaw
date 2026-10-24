import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAgentDeliveryPlanWithSessionRoute,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
} from "../../utils/message-channel.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import type { InternalSessionEffectsTarget } from "../internal-session-effects.js";
import type { AgentRunSessionTarget } from "../run-session-target.types.js";
import type { RunEmbeddedAgentAttemptParams } from "./run-embedded-attempt.types.js";
import type { AgentCommandOpts } from "./types.js";

export function prepareCommandUserTurnTranscript(
  params: Pick<
    RunEmbeddedAgentAttemptParams,
    "prepared" | "opts" | "suppressVisibleSessionEffects"
  >,
  internalSessionTarget: InternalSessionEffectsTarget | undefined,
  sessionEntry: SessionEntry | undefined,
) {
  const {
    cfg,
    transcriptBody,
    sessionId,
    sessionKey,
    sessionAgentId,
    sessionStore,
    storePath,
    cwd,
    workspaceDir,
  } = params.prepared;
  const transcriptMedia = params.opts.transcriptMedia ?? [];
  const hasTranscriptMedia = transcriptMedia.length > 0;
  const suppressUserTurnPersistence =
    params.opts.suppressPromptPersistence === true ||
    (params.opts.transcriptMessage === "" && !hasTranscriptMedia);
  const recorderTranscriptText = transcriptBody || undefined;
  const userTurnTranscriptRecorder =
    (internalSessionTarget ? undefined : params.opts.userTurnTranscriptRecorder) ??
    createUserTurnTranscriptRecorder({
      ...(!suppressUserTurnPersistence && (recorderTranscriptText || hasTranscriptMedia)
        ? {
            input: {
              text: recorderTranscriptText,
              ...(hasTranscriptMedia ? { media: transcriptMedia } : {}),
              senderIsOwner: params.opts.senderIsOwner,
              ...(params.opts.inputProvenance ? { provenance: params.opts.inputProvenance } : {}),
            },
          }
        : {}),
      target: {
        sessionId: internalSessionTarget?.sessionId ?? sessionId,
        agentId: internalSessionTarget?.agentId ?? sessionAgentId,
        sessionKey: internalSessionTarget?.sessionKey ?? sessionKey ?? sessionId,
        sessionEntry: internalSessionTarget?.sessionEntry ?? sessionEntry,
        sessionStore: params.suppressVisibleSessionEffects ? undefined : sessionStore,
        storePath: internalSessionTarget?.storePath ?? storePath,
        cwd: cwd ?? workspaceDir,
        config: cfg,
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      errorContext: "agent command user turn transcript",
    });
  if (suppressUserTurnPersistence) {
    userTurnTranscriptRecorder.markBlocked();
  }
  return { suppressUserTurnPersistence, userTurnTranscriptRecorder };
}

export function clearPendingFinalDelivery(entry: SessionEntry, updatedAt: number): SessionEntry {
  return {
    ...entry,
    pendingFinalDelivery: undefined,
    restartRecoveryForceSafeTools: undefined,
    restartRecoveryDeliveryMediaUrls: undefined,
    restartRecoveryDisableMessageTool: undefined,
    restartRecoverySuppressTextDelivery: undefined,
    updatedAt,
  };
}

type PreparedCurrentRunDelivery = {
  context: DeliveryContext;
  targetMode: ChannelOutboundTargetMode;
};

export async function prepareCurrentRunDelivery(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  agentId: string;
  currentSessionKey?: string;
  sessionEntry?: SessionEntry;
}): Promise<PreparedCurrentRunDelivery | undefined> {
  const { cfg, opts, sessionEntry } = params;
  if (opts.deliver !== true) {
    return undefined;
  }
  const buildPlan = async (requestedChannel: string | undefined, preparedPlugin?: ChannelPlugin) =>
    await resolveAgentDeliveryPlanWithSessionRoute({
      cfg,
      agentId: params.agentId,
      currentSessionKey: params.currentSessionKey,
      sessionEntry,
      requestedChannel,
      explicitTo: opts.replyTo ?? opts.to,
      explicitThreadId: opts.threadId,
      accountId: opts.replyAccountId ?? opts.accountId,
      wantsDelivery: true,
      turnSourceChannel: opts.runContext?.messageChannel ?? opts.messageChannel,
      turnSourceTo: opts.runContext?.currentChannelId ?? opts.to,
      turnSourceAccountId: opts.runContext?.accountId ?? opts.accountId,
      turnSourceThreadId: opts.runContext?.currentThreadTs ?? opts.threadId,
      preparedPlugin,
    });
  let deliveryPlan = await buildPlan(opts.replyChannel ?? opts.channel);
  const explicitChannelHint = normalizeOptionalString(opts.replyChannel ?? opts.channel);
  const explicitThreadId =
    opts.threadId != null && opts.threadId !== "" ? opts.threadId : undefined;
  if (deliveryPlan.resolvedChannel === INTERNAL_MESSAGE_CHANNEL && !explicitChannelHint) {
    const selection = await resolveMessageChannelSelection({ cfg });
    deliveryPlan = await buildPlan(selection.channel, selection.plugin);
  }
  if (deliveryPlan.targetResolutionError) {
    throw deliveryPlan.targetResolutionError;
  }
  if (!isDeliverableMessageChannel(deliveryPlan.resolvedChannel)) {
    throw new Error(
      "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
    );
  }
  const targetMode =
    opts.deliveryTargetMode ??
    deliveryPlan.deliveryTargetMode ??
    ((opts.replyTo ?? opts.to) ? "explicit" : "implicit");
  const resolved = await resolveAgentOutboundTarget({
    cfg,
    plan: deliveryPlan,
    targetMode,
    validateExplicitTarget: true,
  });
  if (resolved.resolvedTarget && !resolved.resolvedTarget.ok) {
    throw resolved.resolvedTarget.error;
  }
  const resolvedTo = resolved.resolvedTo;
  if (!resolvedTo) {
    throw new Error(`delivery target is required for ${deliveryPlan.resolvedChannel}`);
  }
  const threadId =
    targetMode === "explicit"
      ? (explicitThreadId ??
        (deliveryPlan.baseDelivery.threadIdSource === "explicit"
          ? deliveryPlan.resolvedThreadId
          : undefined))
      : deliveryPlan.resolvedThreadId;
  const context = normalizeDeliveryContext({
    channel: deliveryPlan.resolvedChannel,
    to: resolvedTo,
    accountId: deliveryPlan.resolvedAccountId,
    threadId,
  });
  return context ? { context, targetMode } : undefined;
}

export function resolveInternalSessionEffectsSource(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}):
  | Required<Pick<AgentRunSessionTarget, "agentId" | "sessionId" | "sessionKey" | "storePath">>
  | undefined {
  if (!params.storePath || !params.sessionKey) {
    return undefined;
  }
  return {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
}
