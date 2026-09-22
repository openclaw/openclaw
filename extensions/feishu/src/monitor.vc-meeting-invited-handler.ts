import * as crypto from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { claimUnprocessedFeishuMessage, type FeishuMessageProcessingClaim } from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import { setFeishuSyntheticDirectPreDispatchTarget } from "./synthetic-event-target.js";

const FEISHU_MEETING_NUMBER_PATTERN = /^\d{9}$/;

type FeishuVcIdentity = {
  open_id?: string | null;
  user_id?: string | null;
  union_id?: string | null;
};

type FeishuVcMeetingInvitedEvent = {
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
    ? `${base} If the join tool supports a call_id parameter, pass call_id=${JSON.stringify(params.callId)}; otherwise join by meeting number only.`
    : base;
}

function resolveVcMeetingInvitedTurn(
  event: FeishuVcMeetingInvitedEvent,
  uuid: () => string = () => crypto.randomUUID(),
): VcMeetingInvitedTurn | null {
  const meetingNo = pickString(event.meeting?.meeting_no);
  const inviter = resolveVcInviter(event);
  if (!meetingNo || !FEISHU_MEETING_NUMBER_PATTERN.test(meetingNo) || !inviter) {
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

function createVcInviteAdoption(params: {
  claim: FeishuMessageProcessingClaim;
  abortSignal?: AbortSignal;
  isAccountActive?: () => boolean;
  trackTask?: (task: Promise<void>) => void;
}): { lifecycle: FeishuIngressLifecycle; finish: () => Promise<void> } {
  const cancellation = new AbortController();
  const settled = createDeferred<void>();
  let handedOff = false;
  let released = false;
  let adoption: Promise<void> | undefined;
  const abandon = () => {
    if (released || adoption) {
      return;
    }
    released = true;
    params.abortSignal?.removeEventListener("abort", abandon);
    const error =
      params.abortSignal?.reason ?? new Error("Feishu VC invitation abandoned before adoption");
    // Cancel queued ownership before making this logical identity available again.
    cancellation.abort(error);
    params.claim.release({ error });
    settled.resolve();
  };
  params.trackTask?.(settled.promise);
  params.abortSignal?.addEventListener("abort", abandon, { once: true });
  if (params.abortSignal?.aborted) {
    abandon();
  }
  return {
    lifecycle: {
      abortSignal: cancellation.signal,
      onAdopted: () => {
        if (adoption) {
          return adoption;
        }
        if (params.isAccountActive?.() === false) {
          abandon();
        }
        cancellation.signal.throwIfAborted();
        handedOff = true;
        // Adoption retires source cancellation; a started commit owns its completion.
        params.abortSignal?.removeEventListener("abort", abandon);
        adoption = Promise.resolve()
          .then(async () => {
            await params.claim.commit();
          })
          .finally(() => settled.resolve());
        return adoption;
      },
      onDeferred: () => {
        handedOff = true;
      },
      onAdoptionFinalizing: () => {
        handedOff = true;
      },
      onAbandoned: abandon,
    },
    finish: async () => {
      if (!handedOff) {
        abandon();
      }
      await adoption;
    },
  };
}

async function dispatchVcMeetingInvitedTurn(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  channelRuntime?: PluginRuntime["channel"];
  turn: VcMeetingInvitedTurn;
  abortSignal?: AbortSignal;
  isAccountActive?: () => boolean;
  trackTask?: (task: Promise<void>) => void;
}): Promise<void> {
  params.runtime?.log?.(
    `feishu[${params.accountId}]: vc meeting invited, dispatching synthetic p2p message sender=${params.turn.inviter.senderId} meeting_no=${params.turn.meetingNo}`,
  );
  const event = setFeishuSyntheticDirectPreDispatchTarget(
    buildSyntheticMessageEvent(params.turn),
    `user:${params.turn.inviter.senderId}`,
  );
  const claim = await claimUnprocessedFeishuMessage({
    messageId: resolveFeishuMessageDedupeKey(event),
    namespace: params.accountId,
    log: params.runtime?.log ?? console.log,
  });
  if (claim.kind !== "claimed") {
    return;
  }
  if (params.abortSignal?.aborted || params.isAccountActive?.() === false) {
    claim.handle.release({ error: new Error("Feishu account stopped before VC dispatch") });
    return;
  }
  const adoption = createVcInviteAdoption({
    claim: claim.handle,
    abortSignal: params.abortSignal,
    isAccountActive: params.isAccountActive,
    trackTask: params.trackTask,
  });
  try {
    await handleFeishuMessage({
      trackTask: params.trackTask,
      cfg: params.cfg,
      accountId: params.accountId,
      event,
      runtime: params.runtime,
      channelRuntime: params.channelRuntime,
      turnAdoptionLifecycle: adoption.lifecycle,
    });
  } catch (error) {
    await adoption.lifecycle.onAbandoned();
    throw error;
  } finally {
    await adoption.finish();
  }
}

export function createFeishuVcMeetingInvitedHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  channelRuntime?: PluginRuntime["channel"];
  fireAndForget?: boolean;
  autoJoin: boolean;
  abortSignal?: AbortSignal;
  isAccountActive?: () => boolean;
  trackTask?: (task: Promise<void>) => void;
}): (data: unknown) => Promise<void> {
  const { cfg, accountId, runtime, fireAndForget, autoJoin } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const handle = async (data: unknown) => {
    if (params.abortSignal?.aborted || params.isAccountActive?.() === false) {
      return;
    }
    // Meeting invitations represent remote intent, but joining changes the bot's live presence.
    // Keep the event inert unless this account explicitly opts into unattended joins.
    if (!autoJoin) {
      log(`feishu[${accountId}]: ignoring vc meeting invite (vcAutoJoin=false)`);
      return;
    }
    try {
      const turn = resolveVcMeetingInvitedTurn(data as FeishuVcMeetingInvitedEvent);
      if (!turn) {
        log(
          `feishu[${accountId}]: vc meeting invited event has invalid meeting_no ` +
            "or inviter identity, skipping",
        );
        return;
      }
      await dispatchVcMeetingInvitedTurn({
        trackTask: params.trackTask,
        cfg,
        accountId,
        runtime,
        channelRuntime: params.channelRuntime,
        turn,
        abortSignal: params.abortSignal,
        isAccountActive: params.isAccountActive,
      });
    } catch (err) {
      error(`feishu[${accountId}]: error handling vc meeting invited event: ${String(err)}`);
    }
  };
  return (data) => {
    const task = handle(data);
    params.trackTask?.(task);
    return fireAndForget ? Promise.resolve() : task;
  };
}
