import type {
  MarkdownTableMode,
  OpenClawConfig,
  OutboundReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import {
  createScopedPairingAccess,
  createReplyPrefixOptions,
  resolveOutboundMediaUrls,
  mergeAllowlist,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveSenderCommandAuthorization,
  sendMediaWithLeadingCaption,
  summarizeMapping,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk";
import { getZalouserRuntime } from "./runtime.js";
import { sendMessageZalouser } from "./send.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";
import { listZaloFriends, listZaloGroups, startZaloListener } from "./zalo-js.js";

export type ZalouserMonitorOptions = {
  account: ResolvedZalouserAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type ZalouserMonitorResult = {
  stop: () => void;
};

const ZALOUSER_TEXT_LIMIT = 2000;

function normalizeZalouserEntry(entry: string): string {
  return entry.replace(/^(zalouser|zlu):/i, "").trim();
}

function buildNameIndex<T>(items: T[], nameFn: (item: T) => string | undefined): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const name = nameFn(item)?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const list = index.get(name) ?? [];
    list.push(item);
    index.set(name, list);
  }
  return index;
}

type ZalouserCoreRuntime = ReturnType<typeof getZalouserRuntime>;

function logVerbose(core: ZalouserCoreRuntime, runtime: RuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log(`[zalouser] ${message}`);
  }
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(zalouser|zlu):/i, "");
    return normalized === normalizedSenderId;
  });
}

function normalizeGroupSlug(raw?: string | null): string {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isGroupAllowed(params: {
  groupId: string;
  groupName?: string | null;
  groups: Record<string, { allow?: boolean; enabled?: boolean }>;
}): boolean {
  const groups = params.groups ?? {};
  const keys = Object.keys(groups);
  if (keys.length === 0) {
    return false;
  }
  const candidates = [
    params.groupId,
    `group:${params.groupId}`,
    params.groupName ?? "",
    normalizeGroupSlug(params.groupName ?? ""),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const entry = groups[candidate];
    if (!entry) {
      continue;
    }
    return entry.allow !== false && entry.enabled !== false;
  }
  const wildcard = groups["*"];
  if (wildcard) {
    return wildcard.allow !== false && wildcard.enabled !== false;
  }
  return false;
}

async function processMessage(
  message: ZaloInboundMessage,
  account: ResolvedZalouserAccount,
  config: OpenClawConfig,
  core: ZalouserCoreRuntime,
  runtime: RuntimeEnv,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
): Promise<void> {
  const pairing = createScopedPairingAccess({
    core,
    channel: "zalouser",
    accountId: account.accountId,
  });

  const rawBody = message.content?.trim();
  if (!rawBody) {
    return;
  }

  const isGroup = message.isGroup;
  const senderId = message.senderId;
  const senderName = message.senderName ?? "";
  const groupName = message.groupName ?? "";
  const chatId = message.threadId;

  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: config.channels?.zalouser !== undefined,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy,
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "zalouser",
    accountId: account.accountId,
    log: (entry) => logVerbose(core, runtime, entry),
  });

  const groups = account.config.groups ?? {};
  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, `zalouser: drop group ${chatId} (groupPolicy=disabled)`);
      return;
    }
    if (groupPolicy === "allowlist") {
      const allowed = isGroupAllowed({ groupId: chatId, groupName, groups });
      if (!allowed) {
        logVerbose(core, runtime, `zalouser: drop group ${chatId} (not allowlisted)`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const { senderAllowedForCommands, commandAuthorized } = await resolveSenderCommandAuthorization({
    cfg: config,
    rawBody,
    isGroup,
    dmPolicy,
    configuredAllowFrom: configAllowFrom,
    senderId,
    isSenderAllowed,
    readAllowFromStore: pairing.readAllowFromStore,
    shouldComputeCommandAuthorized: (body, cfg) =>
      core.channel.commands.shouldComputeCommandAuthorized(body, cfg),
    resolveCommandAuthorizedFromAuthorizers: (params) =>
      core.channel.commands.resolveCommandAuthorizedFromAuthorizers(params),
  });

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(core, runtime, `Blocked zalouser DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await pairing.upsertPairingRequest({
            id: senderId,
            meta: { name: senderName || undefined },
          });

          if (created) {
            logVerbose(core, runtime, `zalouser pairing request sender=${senderId}`);
            try {
              await sendMessageZalouser(
                chatId,
                core.channel.pairing.buildPairingReply({
                  channel: "zalouser",
                  idLine: `Your Zalo user id: ${senderId}`,
                  code,
                }),
                { profile: account.profile },
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                core,
                runtime,
                `zalouser pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized zalouser sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(
      core,
      runtime,
      `zalouser: drop control command from unauthorized sender ${senderId}`,
    );
    return;
  }

  const peer = isGroup
    ? { kind: "group" as const, id: chatId }
    : { kind: "group" as const, id: senderId };

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "zalouser",
    accountId: account.accountId,
    peer: {
      // Use "group" kind to avoid dmScope=main collapsing all DMs into the main session.
      kind: peer.kind,
      id: peer.id,
    },
  });

  const fromLabel = isGroup ? groupName || `group:${chatId}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Zalo Personal",
    from: fromLabel,
    timestamp: message.timestampMs,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `zalouser:group:${chatId}` : `zalouser:${senderId}`,
    To: `zalouser:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "zalouser",
    Surface: "zalouser",
    MessageSid: message.msgId ?? message.cliMsgId ?? `${message.timestampMs}`,
    OriginatingChannel: "zalouser",
    OriginatingTo: `zalouser:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`zalouser: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "zalouser",
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await deliverZalouserReply({
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          profile: account.profile,
          chatId,
          isGroup,
          runtime,
          core,
          config,
          accountId: account.accountId,
          statusSink,
          tableMode: core.channel.text.resolveMarkdownTableMode({
            cfg: config,
            channel: "zalouser",
            accountId: account.accountId,
          }),
        });
      },
      onError: (err, info) => {
        runtime.error(`[${account.accountId}] Zalouser ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

async function deliverZalouserReply(params: {
  payload: OutboundReplyPayload;
  profile: string;
  chatId: string;
  isGroup: boolean;
  runtime: RuntimeEnv;
  core: ZalouserCoreRuntime;
  config: OpenClawConfig;
  accountId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const { payload, profile, chatId, isGroup, runtime, core, config, accountId, statusSink } =
    params;
  const tableMode = params.tableMode ?? "code";
  const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

  const sentMedia = await sendMediaWithLeadingCaption({
    mediaUrls: resolveOutboundMediaUrls(payload),
    caption: text,
    send: async ({ mediaUrl, caption }) => {
      logVerbose(core, runtime, `Sending media to ${chatId}`);
      await sendMessageZalouser(chatId, caption ?? "", {
        profile,
        mediaUrl,
        isGroup,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
    onError: (error) => {
      runtime.error(`Zalouser media send failed: ${String(error)}`);
    },
  });
  if (sentMedia) {
    return;
  }

  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "zalouser", accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      text,
      ZALOUSER_TEXT_LIMIT,
      chunkMode,
    );
    logVerbose(core, runtime, `Sending ${chunks.length} text chunk(s) to ${chatId}`);
    for (const chunk of chunks) {
      try {
        await sendMessageZalouser(chatId, chunk, { profile, isGroup });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error(`Zalouser message send failed: ${String(err)}`);
      }
    }
  }
}

export async function monitorZalouserProvider(
  options: ZalouserMonitorOptions,
): Promise<ZalouserMonitorResult> {
  let { account, config } = options;
  const { abortSignal, statusSink, runtime } = options;

  const core = getZalouserRuntime();

  try {
    const profile = account.profile;
    const allowFromEntries = (account.config.allowFrom ?? [])
      .map((entry) => normalizeZalouserEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");

    if (allowFromEntries.length > 0) {
      const friends = await listZaloFriends(profile);
      const byName = buildNameIndex(friends, (friend) => friend.displayName);
      const additions: string[] = [];
      const mapping: string[] = [];
      const unresolved: string[] = [];
      for (const entry of allowFromEntries) {
        if (/^\d+$/.test(entry)) {
          additions.push(entry);
          continue;
        }
        const matches = byName.get(entry.toLowerCase()) ?? [];
        const match = matches[0];
        const id = match?.userId ? String(match.userId) : undefined;
        if (id) {
          additions.push(id);
          mapping.push(`${entry}→${id}`);
        } else {
          unresolved.push(entry);
        }
      }
      const allowFrom = mergeAllowlist({ existing: account.config.allowFrom, additions });
      account = {
        ...account,
        config: {
          ...account.config,
          allowFrom,
        },
      };
      summarizeMapping("zalouser users", mapping, unresolved, runtime);
    }

    const groupsConfig = account.config.groups ?? {};
    const groupKeys = Object.keys(groupsConfig).filter((key) => key !== "*");
    if (groupKeys.length > 0) {
      const groups = await listZaloGroups(profile);
      const byName = buildNameIndex(groups, (group) => group.name);
      const mapping: string[] = [];
      const unresolved: string[] = [];
      const nextGroups = { ...groupsConfig };
      for (const entry of groupKeys) {
        const cleaned = normalizeZalouserEntry(entry);
        if (/^\d+$/.test(cleaned)) {
          if (!nextGroups[cleaned]) {
            nextGroups[cleaned] = groupsConfig[entry];
          }
          mapping.push(`${entry}→${cleaned}`);
          continue;
        }
        const matches = byName.get(cleaned.toLowerCase()) ?? [];
        const match = matches[0];
        const id = match?.groupId ? String(match.groupId) : undefined;
        if (id) {
          if (!nextGroups[id]) {
            nextGroups[id] = groupsConfig[entry];
          }
          mapping.push(`${entry}→${id}`);
        } else {
          unresolved.push(entry);
        }
      }
      account = {
        ...account,
        config: {
          ...account.config,
          groups: nextGroups,
        },
      };
      summarizeMapping("zalouser groups", mapping, unresolved, runtime);
    }
  } catch (err) {
    runtime.log?.(`zalouser resolve failed; using config entries. ${String(err)}`);
  }

  let listenerStop: (() => void) | null = null;
  let stopped = false;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    listenerStop?.();
    listenerStop = null;
  };

  const listener = await startZaloListener({
    accountId: account.accountId,
    profile: account.profile,
    abortSignal,
    onMessage: (msg) => {
      if (stopped) {
        return;
      }
      logVerbose(core, runtime, `[${account.accountId}] inbound message`);
      statusSink?.({ lastInboundAt: Date.now() });
      processMessage(msg, account, config, core, runtime, statusSink).catch((err) => {
        runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
      });
    },
    onError: (err) => {
      if (stopped || abortSignal.aborted) {
        return;
      }
      runtime.error(`[${account.accountId}] Zalo listener error: ${String(err)}`);
    },
  });

  listenerStop = listener.stop;

  await new Promise<void>((resolve) => {
    abortSignal.addEventListener(
      "abort",
      () => {
        stop();
        resolve();
      },
      { once: true },
    );
  });

  return { stop };
}

export const __testing = {
  processMessage: async (params: {
    message: ZaloInboundMessage;
    account: ResolvedZalouserAccount;
    config: OpenClawConfig;
    runtime: RuntimeEnv;
    statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  }) => {
    await processMessage(
      params.message,
      params.account,
      params.config,
      getZalouserRuntime(),
      params.runtime,
      params.statusSink,
    );
  },
};
