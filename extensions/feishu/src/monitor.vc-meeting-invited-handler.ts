import * as crypto from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { normalizeOptionalString as pickString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { handleFeishuMessage } from "./bot.js";
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

function parseInviteTimestamp(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now();
  }
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
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
      const invite = data as FeishuVcMeetingInvitedEvent;
      const meetingNo = pickString(invite.meeting?.meeting_no);
      const id = invite.inviter?.id;
      const openId = pickString(id?.open_id);
      const userId = pickString(id?.user_id);
      const unionId = pickString(id?.union_id);
      const senderId = openId ?? userId;
      if (!meetingNo || !FEISHU_MEETING_NUMBER_PATTERN.test(meetingNo) || !senderId) {
        log(
          `feishu[${accountId}]: vc meeting invited event has invalid meeting_no ` +
            "or inviter identity, skipping",
        );
        return;
      }
      const eventId = pickString(invite.event_id);
      const inviteTime = pickString(invite.invite_time);
      const callId = pickString(invite.call_id);
      const turnId = eventId
        ? `vc-invited:event:${eventId}`
        : `vc-invited:${meetingNo}:${inviteTime ?? crypto.randomUUID()}`;
      const basePrompt = `Use the available tool to join the meeting with meeting number ${meetingNo} immediately. Do not ask for confirmation.`;
      const prompt = callId
        ? `${basePrompt} If the join tool supports a call_id parameter, pass call_id=${JSON.stringify(callId)}; otherwise join by meeting number only.`
        : basePrompt;
      runtime?.log?.(
        `feishu[${accountId}]: vc meeting invited, dispatching synthetic p2p message sender=${senderId} meeting_no=${meetingNo}`,
      );
      const event = setFeishuSyntheticDirectPreDispatchTarget(
        {
          sender: {
            sender_id: {
              ...(openId ? { open_id: openId } : {}),
              ...(userId ? { user_id: userId } : {}),
              ...(unionId ? { union_id: unionId } : {}),
            },
          },
          message: {
            message_id: turnId,
            chat_id: senderId,
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: prompt }),
            create_time: String(parseInviteTimestamp(inviteTime)),
            suppress_reply_target: true,
          },
        },
        `user:${senderId}`,
      );
      const claim = await claimUnprocessedFeishuMessage({
        messageId: resolveFeishuMessageDedupeKey(event),
        namespace: accountId,
        log,
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
          cfg,
          accountId,
          event,
          runtime,
          channelRuntime: params.channelRuntime,
          turnAdoptionLifecycle: adoption.lifecycle,
        });
      } catch (error) {
        await adoption.lifecycle.onAbandoned();
        throw error;
      } finally {
        await adoption.finish();
      }
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
