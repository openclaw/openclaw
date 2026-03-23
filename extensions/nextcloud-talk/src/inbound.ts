import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  createChannelPairingController,
  deliverFormattedTextWithAttachments,
  dispatchInboundReplyWithBase,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithCommandGate,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OpenClawConfig,
  type OutboundReplyPayload,
  type RuntimeEnv,
} from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkGroupAllow,
  resolveNextcloudTalkMentionGate,
  resolveNextcloudTalkRequireMention,
  resolveNextcloudTalkRoomMatch,
} from "./policy.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

export type NextcloudTalkMentionEntry = {
  key: string;
  type?: string;
  id?: string;
  mentionId?: string;
  name?: string;
};

export type ParsedNextcloudTalkBody = {
  /** Human-readable text with `{mentionN}` placeholders stripped. */
  text: string;
  /** True when the original message was structured JSON (as opposed to plain text). */
  structured: boolean;
  mentionEntries: NextcloudTalkMentionEntry[];
};

export function parseStructuredNextcloudTalkBody(raw: string): ParsedNextcloudTalkBody {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return { text: raw, structured: false, mentionEntries: [] };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown;
      parameters?: Record<
        string,
        {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          "mention-id"?: unknown;
          mentionId?: unknown;
        }
      >;
    };
    const rawMessage = typeof parsed.message === "string" ? parsed.message : raw;
    const parameters =
      parsed.parameters && typeof parsed.parameters === "object" ? parsed.parameters : {};
    const mentionEntries = Object.entries(parameters).map(([key, value]) => ({
      key,
      type: typeof value?.type === "string" ? value.type : undefined,
      id: typeof value?.id === "string" ? value.id : undefined,
      mentionId:
        typeof value?.["mention-id"] === "string"
          ? value["mention-id"]
          : typeof value?.mentionId === "string"
            ? value.mentionId
            : undefined,
      name: typeof value?.name === "string" ? value.name : undefined,
    }));
    // Strip placeholder tokens like `{mention0}` or `{mention-user1}` injected by
    // Nextcloud Talk so that command parsing and agent dispatch see clean text.
    const placeholderKeys = Object.keys(parameters);
    const text =
      placeholderKeys.length > 0
        ? placeholderKeys
            .reduce((acc, key) => acc.replace(new RegExp(`\\{${key}\\}`, "g"), ""), rawMessage)
            .trim()
        : rawMessage.trim();
    return { text, structured: true, mentionEntries };
  } catch {
    return { text: raw, structured: false, mentionEntries: [] };
  }
}

export function resolveExplicitNextcloudTalkMention(params: {
  mentionEntries: NextcloudTalkMentionEntry[];
  account: ResolvedNextcloudTalkAccount;
}): boolean {
  const configuredApiUser = params.account.config.apiUser?.trim().toLowerCase();
  const configuredName = params.account.name?.trim().toLowerCase();
  const accountId = params.account.accountId.trim().toLowerCase();
  const expectedIds = new Set<string>();
  if (accountId) {
    expectedIds.add(accountId);
  }
  if (configuredApiUser) {
    expectedIds.add(configuredApiUser);
    const apiLocalPart = configuredApiUser.split("@")[0]?.trim();
    if (apiLocalPart) {
      expectedIds.add(apiLocalPart.toLowerCase());
    }
  }
  if (configuredName) {
    expectedIds.add(configuredName);
  }

  return params.mentionEntries.some((entry) => {
    if ((entry.type ?? "").toLowerCase() !== "user") {
      return false;
    }
    const candidates = [entry.id, entry.mentionId, entry.name]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase());
    return candidates.some((candidate) => expectedIds.has(candidate));
  });
}

const CHANNEL_ID = "nextcloud-talk" as const;

async function deliverNextcloudTalkReply(params: {
  cfg: CoreConfig;
  payload: OutboundReplyPayload;
  roomToken: string;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { cfg, payload, roomToken, accountId, statusSink } = params;
  await deliverFormattedTextWithAttachments({
    payload,
    send: async ({ text, replyToId }) => {
      await sendMessageNextcloudTalk(roomToken, text, {
        cfg,
        accountId,
        replyTo: replyToId,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

export async function handleNextcloudTalkInbound(params: {
  message: NextcloudTalkInboundMessage;
  account: ResolvedNextcloudTalkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getNextcloudTalkRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }
  const parsedBody = parseStructuredNextcloudTalkBody(rawBody);
  // For structured bodies, use the stripped text; fall back to rawBody for plain text.
  const effectiveBody = parsedBody.structured ? parsedBody.text : rawBody;
  if (!effectiveBody) {
    return;
  }

  const roomKind = await resolveNextcloudTalkRoomKind({
    account,
    roomToken: message.roomToken,
    runtime,
  });
  const isGroup = roomKind === "direct" ? false : roomKind === "group" ? true : message.isGroupChat;
  const senderId = message.senderId;
  const senderName = message.senderName;
  const roomToken = message.roomToken;
  const roomName = message.roomName;

  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config as OpenClawConfig);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent:
        ((config.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"] ??
          undefined) !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "nextcloud-talk",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => runtime.log?.(message),
  });

  const configAllowFrom = normalizeNextcloudTalkAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeNextcloudTalkAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const storeAllowList = normalizeNextcloudTalkAllowlist(storeAllowFrom);

  const roomMatch = resolveNextcloudTalkRoomMatch({
    rooms: account.config.rooms,
    roomToken,
  });
  const roomConfig = roomMatch.roomConfig;
  if (isGroup && !roomMatch.allowed) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (not allowlisted)`);
    return;
  }
  if (roomConfig?.enabled === false) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (disabled)`);
    return;
  }

  const roomAllowFrom = normalizeNextcloudTalkAllowlist(roomConfig?.allowFrom);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups =
    (config.commands as Record<string, unknown> | undefined)?.useAccessGroups !== false;
  const hasControlCommand = core.channel.text.hasControlCommand(
    effectiveBody,
    config as OpenClawConfig,
  );
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom: storeAllowList,
    isSenderAllowed: (allowFrom) =>
      resolveNextcloudTalkAllowlistMatch({
        allowFrom,
        senderId,
      }).allowed,
    command: {
      useAccessGroups,
      allowTextCommands,
      hasControlCommand,
    },
  });
  const commandAuthorized = access.commandAuthorized;
  const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;

  if (isGroup) {
    if (access.decision !== "allow") {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (reason=${access.reason})`);
      return;
    }
    const groupAllow = resolveNextcloudTalkGroupAllow({
      groupPolicy,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: roomAllowFrom,
      senderId,
    });
    if (!groupAllow.allowed) {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (access.decision !== "allow") {
      if (access.decision === "pairing") {
        await pairing.issueChallenge({
          senderId,
          senderIdLine: `Your Nextcloud user id: ${senderId}`,
          meta: { name: senderName || undefined },
          sendPairingReply: async (text) => {
            await sendMessageNextcloudTalk(roomToken, text, {
              cfg: config,
              accountId: account.accountId,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          onReplyError: (err) => {
            runtime.error?.(`nextcloud-talk: pairing reply failed for ${senderId}: ${String(err)}`);
          },
        });
      }
      runtime.log?.(`nextcloud-talk: drop DM sender ${senderId} (reason=${access.reason})`);
      return;
    }
  }

  if (access.shouldBlockControlCommand) {
    logInboundDrop({
      log: (message) => runtime.log?.(message),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  // A structured message that is nothing but mention placeholders produces an empty
  // effectiveBody after stripping.  Treat it as a mention-only ping with no actionable
  // content and drop it silently — the agent has nothing to respond to.
  if (parsedBody.structured && effectiveBody === "") {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (mention-only, no message body)`);
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const explicitMention = resolveExplicitNextcloudTalkMention({
    mentionEntries: parsedBody.mentionEntries,
    account,
  });
  const wasMentioned =
    explicitMention ||
    (mentionRegexes.length
      ? core.channel.mentions.matchesMentionPatterns(effectiveBody, mentionRegexes)
      : false);
  const shouldRequireMention = isGroup
    ? resolveNextcloudTalkRequireMention({
        roomConfig,
        wildcardConfig: roomMatch.wildcardConfig,
      })
    : false;
  const mentionGate = resolveNextcloudTalkMentionGate({
    isGroup,
    requireMention: shouldRequireMention,
    wasMentioned,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  });
  if (isGroup && mentionGate.shouldSkip) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (no mention)`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? roomToken : senderId,
    },
  });

  const fromLabel = isGroup ? `room:${roomName || roomToken}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    (config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    {
      agentId: route.agentId,
    },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Nextcloud Talk",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = normalizeOptionalString(roomConfig?.systemPrompt);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: effectiveBody,
    RawBody: effectiveBody,
    CommandBody: effectiveBody,
    From: isGroup ? `nextcloud-talk:room:${roomToken}` : `nextcloud-talk:${senderId}`,
    To: `nextcloud-talk:${roomToken}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    GroupSubject: isGroup ? roomName || roomToken : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `nextcloud-talk:${roomToken}`,
    CommandAuthorized: commandAuthorized,
  });

  await dispatchInboundReplyWithBase({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route,
    storePath,
    ctxPayload,
    core,
    deliver: async (payload) => {
      await deliverNextcloudTalkReply({
        cfg: config,
        payload,
        roomToken,
        accountId: account.accountId,
        statusSink,
      });
    },
    onRecordError: (err) => {
      runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`nextcloud-talk ${info.kind} reply failed: ${String(err)}`);
    },
    replyOptions: {
      skillFilter: roomConfig?.skills,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
