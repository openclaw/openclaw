import { resolveChannelImplicitMentions } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  implicitMentionKindWhen,
  resolveBotThreadMentionPolicy,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TlonSettingsStore } from "../settings.js";
import { normalizeShip } from "../targets.js";
import type { TlonResolvedAccount } from "../types.js";
import { resolveChannelAuthorization } from "./authorization.js";
import { fetchThreadRootAuthor } from "./history.js";
import { isBotMentioned } from "./utils.js";

function resolveTlonGroupMentionDecision(params: {
  cfg: OpenClawConfig;
  accountId: string;
  wasMentioned: boolean;
  botParticipatedInThread: boolean;
  isBotOwnedThread?: boolean;
  requireMentionInBotThreads?: boolean;
}) {
  const implicitMentions = resolveChannelImplicitMentions({
    cfg: params.cfg,
    channel: "tlon",
    accountId: params.accountId,
  });
  const threadPolicy = resolveBotThreadMentionPolicy({
    isBotOwnedThread: params.isBotOwnedThread === true,
    requireMentionInBotThreads: params.requireMentionInBotThreads,
    requireMention: true,
    implicitMentionKinds: implicitMentionKindWhen(
      "bot_thread_participant",
      params.botParticipatedInThread,
    ),
  });
  return resolveInboundMentionDecision({
    facts: {
      canDetectMention: true,
      wasMentioned: params.wasMentioned,
      implicitMentionKinds: threadPolicy.implicitMentionKinds,
    },
    policy: {
      isGroup: true,
      requireMention: threadPolicy.requireMention,
      implicitMentions,
      allowTextCommands: false,
      hasControlCommand: false,
      commandAuthorized: false,
    },
  });
}

export async function prepareTlonGroupAdmission(params: {
  cfg: OpenClawConfig;
  account: Pick<TlonResolvedAccount, "accountId" | "requireMentionInBotThreads">;
  api: { scry: (path: string) => Promise<unknown> };
  channelNest: string;
  senderShip: string;
  isOwner: (ship: string) => boolean;
  botShipName: string;
  botNickname: string | null;
  rawText: string;
  messageSeal: Record<string, unknown> | null;
  isThreadReply: boolean;
  hasParticipatedInThread: (parentId: string) => boolean;
  getSettings: () => TlonSettingsStore;
  runtime: RuntimeEnv;
}) {
  const { cfg, account, channelNest, botShipName, runtime } = params;
  const parentId =
    readStringField(params.messageSeal, "parent-id") ??
    readStringField(params.messageSeal, "parent") ??
    null;
  const mentioned = isBotMentioned(params.rawText, botShipName, params.botNickname ?? undefined);
  const configuredThreadMention =
    resolveChannelAuthorization(cfg, channelNest, params.getSettings())
      .requireMentionInBotThreads ?? account.requireMentionInBotThreads;
  const botParticipatedInThread = Boolean(
    params.isThreadReply && parentId && params.hasParticipatedInThread(parentId),
  );
  // Participation can admit a reply before settings make bot-owned threads mention-only.
  const threadRootAuthor =
    !mentioned &&
    params.isThreadReply &&
    parentId &&
    (configuredThreadMention !== undefined || botParticipatedInThread)
      ? await fetchThreadRootAuthor(params.api, channelNest, parentId, runtime)
      : null;
  const isBotOwnedThread = Boolean(
    threadRootAuthor && normalizeShip(threadRootAuthor) === botShipName,
  );
  const resolveCurrentAdmission = () => {
    const authorization = resolveChannelAuthorization(cfg, channelNest, params.getSettings());
    return {
      ...authorization,
      senderAllowed:
        params.isOwner(params.senderShip) ||
        authorization.mode === "open" ||
        authorization.allowedShips.some((ship) => normalizeShip(ship) === params.senderShip),
      mentionDecision: resolveTlonGroupMentionDecision({
        cfg,
        accountId: account.accountId,
        wasMentioned: mentioned,
        botParticipatedInThread,
        isBotOwnedThread,
        requireMentionInBotThreads:
          authorization.requireMentionInBotThreads ?? account.requireMentionInBotThreads,
      }),
    };
  };
  const admission = resolveCurrentAdmission();
  const { mentionDecision } = admission;
  if (mentionDecision.implicitMention && !mentioned && !mentionDecision.shouldSkip) {
    runtime.log?.(`[tlon] Responding to thread we participated in (no mention): ${parentId}`);
  }
  return {
    ...admission,
    parentId,
    isAdmissionAllowed: () => {
      const current = resolveCurrentAdmission();
      return current.senderAllowed && !current.mentionDecision.shouldSkip;
    },
  };
}
