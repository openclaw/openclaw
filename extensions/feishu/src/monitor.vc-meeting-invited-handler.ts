import * as crypto from "node:crypto";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { resolveFeishuDmIngressAccess } from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu } from "./send.js";

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

function buildSyntheticMessageEvent(turn: VcMeetingInvitedTurn): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        ...(turn.inviter.openId ? { open_id: turn.inviter.openId } : {}),
        ...(turn.inviter.userId ? { user_id: turn.inviter.userId } : {}),
        ...(turn.inviter.unionId ? { union_id: turn.inviter.unionId } : {}),
      },
    },
    message: {
      message_id: turn.turnId,
      chat_id: turn.inviter.senderId,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: turn.prompt }),
      create_time: String(parseInviteTimestamp(turn.inviteTime)),
      suppress_reply_target: true,
    },
  };
}

async function ensureVcInviteDmIngress(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  turn: VcMeetingInvitedTurn;
}): Promise<boolean> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  const feishuCfg = account.config;
  const dmPolicy = feishuCfg.dmPolicy ?? "pairing";
  const allowFrom = feishuCfg.allowFrom ?? [];
  const core = getFeishuRuntime();
  const log = params.runtime?.log ?? console.log;
  const pairing = createChannelPairingController({
    core,
    channel: "feishu",
    accountId: account.accountId,
  });
  const dmIngress = await resolveFeishuDmIngressAccess({
    cfg: params.cfg,
    accountId: account.accountId,
    dmPolicy,
    allowFrom,
    readAllowFromStore: pairing.readAllowFromStore,
    senderOpenId: params.turn.inviter.senderId,
    senderUserId: params.turn.inviter.userId,
    conversationId: params.turn.inviter.senderId,
    mayPair: true,
  });
  if (dmIngress.ingress.admission === "dispatch") {
    return true;
  }
  if (dmIngress.ingress.admission === "pairing-required") {
    await pairing.issueChallenge({
      senderId: params.turn.inviter.senderId,
      senderIdLine: `Your Feishu user id: ${params.turn.inviter.senderId}`,
      meta: { name: params.turn.inviter.name },
      onCreated: () => {
        log(
          `feishu[${account.accountId}]: vc invite pairing request sender=${params.turn.inviter.senderId}`,
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
          `feishu[${account.accountId}]: vc invite pairing reply failed for ${params.turn.inviter.senderId}: ${String(err)}`,
        );
      },
    });
    return false;
  }
  log(
    `feishu[${account.accountId}]: blocked unauthorized vc invite sender ${params.turn.inviter.senderId} (dmPolicy=${dmPolicy})`,
  );
  return false;
}

async function dispatchVcMeetingInvitedTurn(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  channelRuntime?: PluginRuntime["channel"];
  turn: VcMeetingInvitedTurn;
}): Promise<void> {
  params.runtime?.log?.(
    `feishu[${params.accountId}]: vc meeting invited, dispatching through Feishu DM ingress sender=${params.turn.inviter.senderId} meeting_no=${params.turn.meetingNo}`,
  );
  const admitted = await ensureVcInviteDmIngress({
    cfg: params.cfg,
    accountId: params.accountId,
    runtime: params.runtime,
    turn: params.turn,
  });
  if (!admitted) {
    return;
  }
  await handleFeishuMessage({
    cfg: params.cfg,
    accountId: params.accountId,
    event: buildSyntheticMessageEvent(params.turn),
    runtime: params.runtime,
    channelRuntime: params.channelRuntime,
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
      const promise = dispatchVcMeetingInvitedTurn({
        cfg,
        accountId,
        runtime,
        channelRuntime: params.channelRuntime,
        turn,
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
