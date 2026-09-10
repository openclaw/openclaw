import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ChannelOutboundTargetMode,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAgentDeliveryPlanWithSessionRoute,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
} from "../../utils/message-channel.js";
import type { AgentRunSessionTarget } from "../run-session-target.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { AgentCommandOpts } from "./types.js";

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
  const resolved = resolveAgentOutboundTarget({
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

/** Delivery is prepared once; the command retains its mutable opts and run context. */
export function createCurrentRunDeliveryPreparer(params: {
  prepared: PreparedAgentCommandExecution;
  getOpts: () => AgentCommandOpts;
  assertCurrent: () => void;
  onWarning: (message: string) => void;
  onPrepared: (delivery: PreparedCurrentRunDelivery, opts: AgentCommandOpts) => void;
}) {
  let currentRunDeliveryPrepared = false;
  return async (sessionEntry?: SessionEntry) => {
    const opts = params.getOpts();
    if (currentRunDeliveryPrepared || opts.deliver !== true) {
      return;
    }
    currentRunDeliveryPrepared = true;
    let preparedDelivery: PreparedCurrentRunDelivery | undefined;
    try {
      preparedDelivery = await prepareCurrentRunDelivery({
        cfg: params.prepared.cfg,
        opts,
        agentId: params.prepared.sessionAgentId,
        currentSessionKey: params.prepared.sessionKey,
        sessionEntry,
      });
    } catch (error) {
      if (params.getOpts().bestEffortDeliver !== true) {
        throw error;
      }
      params.onWarning(
        `delivery preflight failed; continuing model run with requested delivery intent because bestEffortDeliver is enabled: ${coerceErrorMessage(error)}`,
      );
    }
    params.assertCurrent();
    if (preparedDelivery) {
      params.onPrepared(preparedDelivery, {
        ...params.getOpts(),
        replyChannel: preparedDelivery.context.channel,
        replyTo: preparedDelivery.context.to,
        replyAccountId: preparedDelivery.context.accountId,
        threadId: preparedDelivery.context.threadId,
        deliveryTargetMode: preparedDelivery.targetMode,
      });
    }
  };
}
