import * as crypto from "node:crypto";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { createChannelPairingController } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import {
  claimUnprocessedFeishuMessage,
  forgetProcessedFeishuMessage,
  recordProcessedFeishuMessage,
  releaseFeishuMessageProcessing,
} from "./dedup.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import { resolveFeishuDmIngressAccess } from "./policy.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu } from "./send.js";
import type { DynamicAgentCreationConfig } from "./types.js";

type FeishuVcIdentity = {
  open_id?: string | null;
  user_id?: string | null;
  union_id?: string | null;
};

export type FeishuVcMeetingInvitedEvent = {
  event_id?: string;
  call_id?: string;
  meeting?: {
    meeting_no?: string;
    topic?: string;
  };
  inviter?: {
    id?: FeishuVcIdentity;
    user_name?: string;
  };
  invite_time?: string;
};

type ResolvedVcInviter = {
  senderId: string;
  openId?: string;
  userId?: string;
  unionId?: string;
  name?: string;
};

type VcMeetingInvitedTurn = {
  turnId: string;
  meetingNo: string;
  topic?: string;
  inviteTime?: string;
  inviter: ResolvedVcInviter;
  prompt: string;
};

function pickString(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function resolveVcInviter(event: FeishuVcMeetingInvitedEvent): ResolvedVcInviter | null {
  const id = event.inviter?.id;
  const openId = pickString(id?.open_id);
  const userId = pickString(id?.user_id);
  const unionId = pickString(id?.union_id);
  const senderId = openId ?? userId;
  if (!senderId) {
    return null;
  }
  const name = pickString(event.inviter?.user_name);
  return {
    senderId,
    ...(openId ? { openId } : {}),
    ...(userId ? { userId } : {}),
    ...(unionId ? { unionId } : {}),
    ...(name ? { name } : {}),
  };
}

function buildJoinPrompt(params: { meetingNo: string; callId?: string }): string {
  const base = `Use the available tool to join the meeting with meeting number ${params.meetingNo} immediately. Do not ask for confirmation.`;
  return params.callId
    ? `${base} If the join tool supports a call_id parameter, pass call_id="${params.callId}"; otherwise join by meeting number only.`
    : base;
}

export function resolveVcMeetingInvitedTurn(
  event: FeishuVcMeetingInvitedEvent,
  uuid: () => string = () => crypto.randomUUID(),
): VcMeetingInvitedTurn | null {
  const meetingNo = pickString(event.meeting?.meeting_no);
  const inviter = resolveVcInviter(event);
  if (!meetingNo || !inviter) {
    return null;
  }

  const eventId = pickString(event.event_id);
  const inviteTime = pickString(event.invite_time);
  const callId = pickString(event.call_id);
  const topic = pickString(event.meeting?.topic);
  const turnId = eventId
    ? `vc-invited:event:${eventId}`
    : `vc-invited:${meetingNo}:${inviteTime ?? uuid()}`;
  const prompt = buildJoinPrompt({ meetingNo, callId });

  return {
    turnId,
    meetingNo,
    inviter,
    prompt,
    ...(topic ? { topic } : {}),
    ...(inviteTime ? { inviteTime } : {}),
  };
}

function parseInviteTimestamp(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now();
  }
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

async function dispatchVcMeetingInvitedTurn(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  channelRuntime?: PluginRuntime["channel"];
  turn: VcMeetingInvitedTurn;
}): Promise<void> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  const feishuCfg = account.config;
  const feishuRuntime = getFeishuRuntime();
  const core = { channel: params.channelRuntime ?? feishuRuntime.channel } as ReturnType<
    typeof getFeishuRuntime
  >;
  const log = params.runtime?.log ?? console.log;
  const error = params.runtime?.error ?? console.error;
  const runtime: RuntimeEnv = params.runtime ?? {
    log,
    error,
    exit: (code) => process.exit(code),
  };
  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const pairing = createChannelPairingController({
    core,
    channel: "feishu",
    accountId: account.accountId,
  });
  const dmIngress = await resolveFeishuDmIngressAccess({
    cfg: params.cfg,
    accountId: account.accountId,
    dmPolicy,
    allowFrom: configAllowFrom,
    readAllowFromStore: pairing.readAllowFromStore,
    senderOpenId: params.turn.inviter.senderId,
    senderUserId: params.turn.inviter.userId,
    conversationId: params.turn.inviter.senderId,
    mayPair: true,
  });
  if (dmIngress.ingress.admission !== "dispatch") {
    if (dmIngress.ingress.admission === "pairing-required") {
      await pairing.issueChallenge({
        senderId: params.turn.inviter.senderId,
        senderIdLine: `Your Feishu user id: ${params.turn.inviter.senderId}`,
        meta: { name: params.turn.inviter.name },
        onCreated: () => {
          log(
            `feishu[${account.accountId}]: vc meeting inviter pairing request ` +
              `sender=${params.turn.inviter.senderId}`,
          );
        },
        sendPairingReply: async (text) => {
          await sendMessageFeishu({
            cfg: params.cfg,
            to: `user:${params.turn.inviter.senderId}`,
            text,
            accountId: account.accountId,
          });
        },
        onReplyError: (err) => {
          log(
            `feishu[${account.accountId}]: vc meeting pairing reply failed for ${params.turn.inviter.senderId}: ${String(err)}`,
          );
        },
      });
    } else {
      log(
        `feishu[${account.accountId}]: blocked unauthorized vc meeting inviter ${params.turn.inviter.senderId} (dmPolicy=${dmPolicy})`,
      );
    }
    return;
  }

  let effectiveCfg = params.cfg;
  let route = core.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "feishu",
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: params.turn.inviter.senderId,
    },
  });
  if (route.matchedBy === "default") {
    const dynamicCfg = feishuCfg?.dynamicAgentCreation as DynamicAgentCreationConfig | undefined;
    if (dynamicCfg?.enabled) {
      const dynamicResult = await maybeCreateDynamicAgent({
        cfg: params.cfg,
        runtime: feishuRuntime,
        senderOpenId: params.turn.inviter.senderId,
        dynamicCfg,
        configWritesAllowed: resolveChannelConfigWrites({
          cfg: params.cfg,
          channelId: "feishu",
          accountId: account.accountId,
        }),
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
            id: params.turn.inviter.senderId,
          },
        });
      }
    }
  }

  const conversation = {
    channel: "feishu",
    accountId: account.accountId,
    conversationId: params.turn.inviter.senderId,
  };
  const configuredRoute = resolveConfiguredBindingRoute({
    cfg: effectiveCfg,
    route,
    conversation,
  });
  let configuredBinding = configuredRoute.bindingResolution;
  route = configuredRoute.route;

  const runtimeRoute = resolveRuntimeConversationBindingRoute({
    route,
    conversation,
  });
  route = runtimeRoute.route;
  if (runtimeRoute.bindingRecord) {
    configuredBinding = null;
    log(
      runtimeRoute.boundSessionKey
        ? `feishu[${account.accountId}]: routed vc meeting invite via bound conversation ${params.turn.inviter.senderId} -> ${runtimeRoute.boundSessionKey}`
        : `feishu[${account.accountId}]: plugin-bound vc meeting invite conversation ${params.turn.inviter.senderId}`,
    );
  }

  if (configuredBinding) {
    const ensured = await ensureConfiguredBindingRouteReady({
      cfg: effectiveCfg,
      bindingResolution: configuredBinding,
    });
    if (!ensured.ok) {
      await sendMessageFeishu({
        cfg: effectiveCfg,
        to: `user:${params.turn.inviter.openId ?? params.turn.inviter.senderId}`,
        text: `⚠️ Failed to initialize the configured ACP session for this Feishu conversation: ${ensured.error}`,
        accountId: account.accountId,
      }).catch((err: unknown) => {
        log(
          `feishu[${account.accountId}]: failed to send VC invite ACP init error reply: ${String(err)}`,
        );
      });
      return;
    }
  }

  const bodyForAgent = `[message_id: ${params.turn.turnId}]\n${params.turn.inviter.name ?? params.turn.inviter.senderId}: ${params.turn.prompt}`;
  const timestamp = parseInviteTimestamp(params.turn.inviteTime);
  const replyTarget = `user:${params.turn.inviter.senderId}`;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    RawBody: params.turn.prompt,
    CommandBody: params.turn.prompt,
    From: `feishu:${params.turn.inviter.senderId}`,
    To: replyTarget,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: params.turn.topic
      ? `Feishu meeting invite · ${params.turn.topic}`
      : "Feishu meeting invite",
    SenderName: params.turn.inviter.name ?? params.turn.inviter.senderId,
    SenderId: params.turn.inviter.senderId,
    Provider: "feishu",
    Surface: "feishu-vc-meeting-invited",
    MessageSid: params.turn.turnId,
    Timestamp: timestamp,
    WasMentioned: true,
    CommandAuthorized: false,
    OriginatingChannel: "feishu",
    OriginatingTo: replyTarget,
  });
  const storePath = core.channel.session.resolveStorePath(effectiveCfg.session?.store, {
    agentId: route.agentId,
  });
  const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
    cfg: effectiveCfg,
    agentId: route.agentId,
    runtime,
    chatId: replyTarget,
    accountId: route.accountId,
    messageCreateTimeMs: timestamp,
    sessionKey: route.sessionKey,
  });

  log(
    `feishu[${account.accountId}]: vc meeting invited, dispatching synthetic inbound sender=${params.turn.inviter.senderId} meeting_no=${params.turn.meetingNo}`,
  );
  await core.channel.inbound.run({
    channel: "feishu",
    accountId: route.accountId,
    raw: params.turn,
    adapter: {
      ingest: () => ({
        id: params.turn.turnId,
        timestamp,
        rawText: params.turn.prompt,
        textForAgent: bodyForAgent,
        textForCommands: params.turn.prompt,
        raw: params.turn,
      }),
      resolveTurn: () => ({
        channel: "feishu",
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: core.channel.session.recordInboundSession,
        record: {
          onRecordError: (err: unknown) => {
            error(
              `feishu[${account.accountId}]: failed to record vc meeting inbound session ${route.sessionKey}: ${String(err)}`,
            );
          },
        },
        runDispatch: () =>
          core.channel.reply.withReplyDispatcher({
            dispatcher,
            onSettled: () => markDispatchIdle(),
            run: () =>
              core.channel.reply.dispatchReplyFromConfig({
                ctx: ctxPayload,
                cfg: effectiveCfg,
                dispatcher,
                replyOptions,
              }),
          }),
      }),
    },
  });
}

export function createFeishuVcMeetingInvitedHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  channelRuntime?: PluginRuntime["channel"];
  fireAndForget?: boolean;
}): (data: unknown) => Promise<void> {
  const { cfg, accountId, runtime, fireAndForget } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  return async (data) => {
    try {
      const turn = resolveVcMeetingInvitedTurn(data as FeishuVcMeetingInvitedEvent);
      if (!turn) {
        log(
          `feishu[${accountId}]: vc meeting invited event missing meeting_no ` +
            "or inviter identity, skipping",
        );
        return;
      }
      const claim = await claimUnprocessedFeishuMessage({
        messageId: turn.turnId,
        namespace: accountId,
        log,
      });
      if (claim === "duplicate") {
        log(`feishu[${accountId}]: dropping duplicate vc meeting event ${turn.turnId}`);
        return;
      }
      if (claim === "inflight") {
        log(`feishu[${accountId}]: dropping in-flight vc meeting event ${turn.turnId}`);
        return;
      }
      const promise = dispatchVcMeetingInvitedTurn({
        cfg,
        accountId,
        runtime,
        channelRuntime: params.channelRuntime,
        turn,
      })
        .then(async () => {
          await recordProcessedFeishuMessage(turn.turnId, accountId, log);
        })
        .catch(async (err: unknown) => {
          await forgetProcessedFeishuMessage(turn.turnId, accountId, log);
          throw err;
        })
        .finally(() => {
          releaseFeishuMessageProcessing(turn.turnId, accountId);
        });
      if (fireAndForget) {
        promise.catch((err: unknown) => {
          error(`feishu[${accountId}]: error handling vc meeting invited event: ${String(err)}`);
        });
        return;
      }
      await promise;
    } catch (err) {
      error(`feishu[${accountId}]: error handling vc meeting invited event: ${String(err)}`);
    }
  };
}
