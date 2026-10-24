import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { getSessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";
import {
  resolveMatrixApprovalReactionTargetWithPersistence,
  unregisterMatrixApprovalReactionTargetsForApproval,
} from "../../approval-reactions.js";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { extractMatrixReactionAnnotation } from "../reaction-common.js";
import { resolveMatrixThreadRootId } from "../relations.js";
import type { MatrixClient } from "../sdk.js";
import { resolveMatrixInboundRouteAsync } from "./route.js";
import { resolveMatrixThreadRouting } from "./threads.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";

const loadApprovalReactionAuth = createLazyRuntimeModule(
  () => import("../../approval-reaction-auth.js"),
);

const loadExecApprovalResolver = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/approval-gateway-runtime"),
);

const loadMatrixSend = createLazyRuntimeModule(() => import("../send.js"));

function buildMatrixApprovalTerminalText(result: ApprovalResolveResult): string {
  const approval = result.approval;
  const terminalLabel =
    approval.status === "allowed"
      ? approval.decision === "allow-always"
        ? "Allowed always"
        : "Allowed once"
      : approval.status === "denied"
        ? "Denied"
        : approval.status === "expired"
          ? "Expired"
          : "Cancelled";
  return `${result.applied ? "Resolved" : "Already resolved"}: ${terminalLabel}\n\nID: ${approval.id}`;
}

function resolveMatrixReactionNotificationMode(cfg: CoreConfig, accountId: string) {
  return (
    resolveMatrixAccountConfig({ cfg, accountId }).reactionNotifications ??
    cfg.channels?.matrix?.reactionNotifications ??
    "own"
  );
}

/**
 * Whether the reaction handler could act on this reaction at all: it resolves a
 * pending approval, or reaction notifications are on and it targets one of the
 * bot's own messages. Shared with the media hold, which must release held
 * attachments only for reactions that may start work. A failed target lookup
 * counts as "may start work" so delivery order is preserved.
 */
export async function resolveMatrixReactionMayStartWork(params: {
  client: Pick<MatrixClient, "getEvent">;
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  event: MatrixRawEvent;
  selfUserId: string;
}): Promise<boolean> {
  const reaction = extractMatrixReactionAnnotation(params.event.content);
  if (!reaction?.eventId || params.event.sender === params.selfUserId) {
    return false;
  }
  const approvalTarget = await resolveMatrixApprovalReactionTargetWithPersistence({
    accountId: params.accountId,
    roomId: params.roomId,
    eventId: reaction.eventId,
    reactionKey: reaction.key,
  });
  if (approvalTarget) {
    return true;
  }
  if (resolveMatrixReactionNotificationMode(params.cfg, params.accountId) === "off") {
    return false;
  }
  const target = await params.client.getEvent(params.roomId, reaction.eventId).catch(() => null);
  if (!target) {
    return true;
  }
  return typeof target.sender === "string" && target.sender.trim() === params.selfUserId;
}

export async function handleInboundMatrixReaction(params: {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  event: MatrixRawEvent;
  senderId: string;
  senderLabel: string;
  selfUserId: string;
  isDirectMessage: boolean;
  logVerboseMessage: (message: string) => void;
}): Promise<void> {
  const reaction = extractMatrixReactionAnnotation(params.event.content);
  if (!reaction?.eventId) {
    return;
  }
  if (params.senderId === params.selfUserId) {
    return;
  }
  const approvalTarget = await resolveMatrixApprovalReactionTargetWithPersistence({
    accountId: params.accountId,
    roomId: params.roomId,
    eventId: reaction.eventId,
    reactionKey: reaction.key,
  });
  const { cfg, accountId, senderId, client, roomId, logVerboseMessage } = params;
  const targetEventId = reaction.eventId;
  if (
    await (async () => {
      if (!approvalTarget) {
        return false;
      }
      const { isMatrixApprovalReactionAuthorizedSender } = await loadApprovalReactionAuth();
      if (
        !isMatrixApprovalReactionAuthorizedSender({
          cfg,
          accountId,
          senderId,
          approvalKind: approvalTarget.approvalKind,
        })
      ) {
        return false;
      }
      const { resolveApprovalOverGateway } = await loadExecApprovalResolver();
      try {
        const result = await resolveApprovalOverGateway({
          cfg,
          approvalId: approvalTarget.approvalId,
          approvalKind: approvalTarget.approvalKind,
          decision: approvalTarget.decision,
          channel: "matrix",
          accountId,
          senderId,
        });
        // Retire every delivered anchor; losing surfaces also need the canonical
        // terminal presentation because their original resolved event may have raced.
        const retiredAccountId = normalizeAccountId(accountId);
        const registeredTargets = await unregisterMatrixApprovalReactionTargetsForApproval({
          accountId: retiredAccountId,
          approvalId: approvalTarget.approvalId,
          approvalKind: approvalTarget.approvalKind,
        });
        const targets = new Map<string, { accountId: string; roomId: string; eventId: string }>();
        for (const target of [
          ...registeredTargets,
          { accountId: retiredAccountId, roomId, eventId: targetEventId },
        ]) {
          targets.set(JSON.stringify([target.accountId, target.roomId, target.eventId]), target);
        }
        const { editMessageMatrix } = await loadMatrixSend();
        const terminalText = buildMatrixApprovalTerminalText(result);
        const updates = await Promise.allSettled(
          Array.from(targets.values(), async (target) => {
            await editMessageMatrix(target.roomId, target.eventId, terminalText, {
              cfg,
              accountId: target.accountId,
              client,
            });
          }),
        );
        const failedUpdates = updates.filter((update) => update.status === "rejected").length;
        if (failedUpdates > 0) {
          logVerboseMessage(
            `matrix: failed to terminalize ${failedUpdates} approval prompt(s) id=${approvalTarget.approvalId}`,
          );
        }
        const canonicalDecision = "decision" in result.approval ? result.approval.decision : "none";
        logVerboseMessage(
          `matrix: approval reaction resolved id=${approvalTarget.approvalId} sender=${senderId} applied=${result.applied} status=${result.approval.status} decision=${canonicalDecision}`,
        );
        return true;
      } catch (err) {
        if (isApprovalNotFoundError(err)) {
          await unregisterMatrixApprovalReactionTargetsForApproval({
            accountId,
            approvalId: approvalTarget.approvalId,
            approvalKind: approvalTarget.approvalKind,
          });
          logVerboseMessage(
            `matrix: approval reaction ignored for expired approval id=${approvalTarget.approvalId} sender=${senderId}`,
          );
          return true;
        }
        logVerboseMessage(
          `matrix: approval reaction failed id=${approvalTarget.approvalId} sender=${senderId}: ${String(err)}`,
        );
        throw err;
      }
    })()
  ) {
    return;
  }
  const notificationMode = resolveMatrixReactionNotificationMode(params.cfg, params.accountId);
  if (notificationMode === "off") {
    return;
  }

  const targetEvent = await params.client
    .getEvent(params.roomId, reaction.eventId)
    .catch((err: unknown) => {
      params.logVerboseMessage(
        `matrix: failed resolving reaction target room=${params.roomId} id=${reaction.eventId}: ${String(err)}`,
      );
      return null;
    });
  const targetSender =
    targetEvent && typeof targetEvent.sender === "string" ? targetEvent.sender.trim() : "";
  if (!targetSender) {
    return;
  }
  if (notificationMode === "own" && targetSender !== params.selfUserId) {
    return;
  }

  const targetContent =
    targetEvent && targetEvent.content && typeof targetEvent.content === "object"
      ? (targetEvent.content as RoomMessageEventContent)
      : undefined;
  const threadRootId = targetContent ? resolveMatrixThreadRootId(targetContent) : undefined;
  const accountConfig = resolveMatrixAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const thread = resolveMatrixThreadRouting({
    isDirectMessage: params.isDirectMessage,
    threadReplies: accountConfig.threadReplies ?? "inbound",
    dmThreadReplies: accountConfig.dm?.threadReplies,
    messageId: reaction.eventId,
    threadRootId,
  });
  const { route, runtimeBindingId } = await resolveMatrixInboundRouteAsync({
    cfg: params.cfg,
    accountId: params.accountId,
    roomId: params.roomId,
    senderId: params.senderId,
    isDirectMessage: params.isDirectMessage,
    dmSessionScope: accountConfig.dm?.sessionScope ?? "per-user",
    threadId: thread.threadId,
    resolveAgentRoute: params.core.channel.routing.resolveAgentRoute,
  });
  if (runtimeBindingId) {
    await getSessionBindingService().touchAsync(runtimeBindingId, params.event.origin_server_ts, {
      channel: "matrix",
      accountId: params.accountId,
    });
  }
  const text = `Matrix reaction added: ${reaction.key} by ${params.senderLabel} on msg ${reaction.eventId}`;
  params.core.system.enqueueSystemEvent(text, {
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    contextKey: `matrix:reaction:add:${params.roomId}:${reaction.eventId}:${params.senderId}:${reaction.key}`,
  });
  params.logVerboseMessage(
    `matrix: reaction event enqueued room=${params.roomId} target=${reaction.eventId} sender=${params.senderId} emoji=${reaction.key}`,
  );
}
