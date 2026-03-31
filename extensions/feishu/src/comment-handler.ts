import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  createChannelPairingController,
  resolveAgentOutboundIdentity,
  type ClawdbotConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuCommentReplyDispatcher } from "./comment-dispatcher.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import {
  parseFeishuDriveCommentNoticeEventPayload,
  resolveDriveCommentEventTurn,
  type FeishuDriveCommentNoticeEvent,
} from "./monitor.comment.js";
import { resolveFeishuAllowlistMatch } from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";
import type { DynamicAgentCreationConfig } from "./types.js";

type HandleFeishuCommentEventParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  event: FeishuDriveCommentNoticeEvent;
  botOpenId?: string;
};

type HandleFeishuCommentNoticePayloadParams = Omit<HandleFeishuCommentEventParams, "event"> & {
  payload: unknown;
};

function buildCommentSessionKey(params: {
  core: ReturnType<typeof getFeishuRuntime>;
  route: ResolvedAgentRoute;
  fileToken: string;
  commentId: string;
}): string {
  return params.core.channel.routing.buildAgentSessionKey({
    agentId: params.route.agentId,
    channel: "feishu",
    accountId: params.route.accountId,
    peer: {
      kind: "direct",
      id: `comment:${params.fileToken}:${params.commentId}`,
    },
    dmScope: "per-account-channel-peer",
  });
}

function parseTimestampMs(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export async function handleFeishuCommentEvent(
  params: HandleFeishuCommentEventParams,
): Promise<void> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  const feishuCfg = account.config;
  const core = getFeishuRuntime();
  const log = params.runtime?.log ?? console.log;
  const error = params.runtime?.error ?? console.error;
  const runtime = (params.runtime ?? { log, error }) as RuntimeEnv;

  const turn = await resolveDriveCommentEventTurn({
    cfg: params.cfg,
    accountId: account.accountId,
    event: params.event,
    botOpenId: params.botOpenId,
    logger: log,
  });
  if (!turn) {
    log(
      `feishu[${account.accountId}]: drive comment notice skipped ` +
        `event=${params.event.event_id ?? "unknown"} comment=${params.event.comment_id ?? "unknown"}`,
    );
    return;
  }

  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const pairing = createChannelPairingController({
    core,
    channel: "feishu",
    accountId: account.accountId,
  });
  const storeAllowFrom =
    dmPolicy !== "allowlist" && dmPolicy !== "open"
      ? await pairing.readAllowFromStore().catch(() => [])
      : [];
  const effectiveDmAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const senderAllowed = resolveFeishuAllowlistMatch({
    allowFrom: effectiveDmAllowFrom,
    senderId: turn.senderId,
  }).allowed;
  if (dmPolicy !== "open" && !senderAllowed) {
    log(
      `feishu[${account.accountId}]: blocked unauthorized comment sender ${turn.senderId} ` +
        `(dmPolicy=${dmPolicy}, comment=${turn.commentId})`,
    );
    return;
  }

  let effectiveCfg = params.cfg;
  let route = core.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "feishu",
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: turn.senderId,
    },
  });
  if (route.matchedBy === "default") {
    const dynamicCfg = feishuCfg?.dynamicAgentCreation as DynamicAgentCreationConfig | undefined;
    if (dynamicCfg?.enabled) {
      const dynamicResult = await maybeCreateDynamicAgent({
        cfg: params.cfg,
        runtime: core,
        senderOpenId: turn.senderId,
        dynamicCfg,
        log: (message) => log(message),
      });
      if (dynamicResult.created) {
        effectiveCfg = dynamicResult.updatedCfg;
        route = core.channel.routing.resolveAgentRoute({
          cfg: dynamicResult.updatedCfg,
          channel: "feishu",
          accountId: account.accountId,
          peer: {
            kind: "direct",
            id: turn.senderId,
          },
        });
        log(
          `feishu[${account.accountId}]: dynamic agent created for comment flow, route=${route.sessionKey}`,
        );
      }
    }
  }

  const commentSessionKey = buildCommentSessionKey({
    core,
    route,
    fileToken: turn.fileToken,
    commentId: turn.commentId,
  });
  const bodyForAgent = `[message_id: ${turn.messageId}]\n${turn.prompt}`;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    RawBody: turn.targetReplyText ?? turn.rootCommentText ?? turn.prompt,
    CommandBody: turn.targetReplyText ?? turn.rootCommentText ?? turn.prompt,
    From: `feishu-comment:${turn.senderId}`,
    To: `comment:${turn.fileToken}:${turn.commentId}`,
    SessionKey: commentSessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: turn.documentTitle
      ? `Feishu comment · ${turn.documentTitle}`
      : "Feishu comment",
    SenderName: turn.senderId,
    SenderId: turn.senderId,
    Provider: "feishu",
    Surface: "feishu-comment",
    MessageSid: turn.messageId,
    Timestamp: parseTimestampMs(turn.timestamp),
    WasMentioned: turn.isMentioned,
    CommandAuthorized: false,
    OriginatingTo: `comment:${turn.fileToken}:${turn.commentId}`,
  });

  const storePath = core.channel.session.resolveStorePath(effectiveCfg.session?.store, {
    agentId: route.agentId,
  });
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: commentSessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      error(
        `feishu[${account.accountId}]: failed to record comment inbound session ${commentSessionKey}: ${String(err)}`,
      );
    },
  });

  const identity = resolveAgentOutboundIdentity(effectiveCfg, route.agentId);
  const { dispatcher, replyOptions, markDispatchIdle } = createFeishuCommentReplyDispatcher({
    cfg: effectiveCfg,
    agentId: route.agentId,
    runtime,
    accountId: account.accountId,
    identity,
    fileToken: turn.fileToken,
    fileType: turn.fileType,
    commentId: turn.commentId,
  });

  log(
    `feishu[${account.accountId}]: dispatching drive comment to agent ` +
      `(session=${commentSessionKey} comment=${turn.commentId} type=${turn.noticeType})`,
  );
  const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
    dispatcher,
    onSettled: () => {
      markDispatchIdle();
    },
    run: () =>
      core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg: effectiveCfg,
        dispatcher,
        replyOptions,
      }),
  });
  log(
    `feishu[${account.accountId}]: drive comment dispatch complete ` +
      `(queuedFinal=${queuedFinal}, replies=${counts.final}, session=${commentSessionKey})`,
  );
}

export async function handleFeishuCommentNoticePayload(
  params: HandleFeishuCommentNoticePayloadParams,
): Promise<void> {
  const event = parseFeishuDriveCommentNoticeEventPayload(params.payload);
  if (!event) {
    const error = params.runtime?.error ?? console.error;
    error(`feishu[${params.accountId}]: ignoring malformed drive comment notice payload`);
    return;
  }
  await handleFeishuCommentEvent({
    cfg: params.cfg,
    accountId: params.accountId,
    runtime: params.runtime,
    event,
    botOpenId: params.botOpenId,
  });
}
