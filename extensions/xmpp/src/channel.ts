import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
  createTypingCallbacks,
  loadWebMedia,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk";
import type { CoreConfig, ResolvedXmppAccount } from "./types.js";
import { xmppMessageActions, setXmppClientsRegistry } from "./actions.js";
import {
  XmppClient,
  getBareJid,
  isGroupJid,
  type XmppMessage,
  type XmppRoomMessage,
} from "./client.js";
import { XmppConfigSchema } from "./config-schema.js";
import { xmppOnboardingAdapter } from "./onboarding.js";
import { probeXmpp } from "./probe.js";
import { getXmppRuntime } from "./runtime.js";
import { uploadToSlot } from "./xep0363.js";

const meta = {
  id: "xmpp",
  label: "XMPP",
  selectionLabel: "XMPP (plugin)",
  docsPath: "/channels/xmpp",
  docsLabel: "xmpp",
  blurb: "XMPP/Jabber protocol; supports 1:1 chat and MUC rooms.",
  order: 75,
  quickstartAllowFrom: true,
};

// Active XMPP clients keyed by accountId
export const clients: Map<string, XmppClient> = new Map();

// Initialize the clients registry for actions
setXmppClientsRegistry(clients);

function listXmppAccountIds(cfg: CoreConfig): string[] {
  const xmppCfg = cfg.channels?.xmpp;
  // Single account mode for now
  if (xmppCfg?.jid) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

function resolveXmppAccount(cfg: CoreConfig, accountId?: string | null): ResolvedXmppAccount {
  const xmppCfg = cfg.channels?.xmpp ?? {};
  const enabled = xmppCfg.enabled !== false;
  const hasJid = Boolean(xmppCfg.jid);
  const hasPassword = Boolean(xmppCfg.password);
  const hasServer = Boolean(xmppCfg.server);
  const configured = hasJid && hasPassword && hasServer;

  return {
    accountId: normalizeAccountId(accountId) || DEFAULT_ACCOUNT_ID,
    enabled,
    name: xmppCfg.name,
    configured,
    jid: xmppCfg.jid,
    password: xmppCfg.password,
    server: xmppCfg.server,
    resource: xmppCfg.resource ?? "openclaw",
    config: xmppCfg,
  };
}

function isConfigured(account: ResolvedXmppAccount): boolean {
  return account.configured;
}

/**
 * Check if a JID matches an allowlist pattern.
 * Supports:
 * - "*" for wildcard (matches all)
 * - "*@domain" for domain wildcard (matches any user at domain)
 * - "user@domain" for exact JID match
 */
export function jidMatchesPattern(jid: string, pattern: string): boolean {
  const normalizedJid = jid.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();

  // Full wildcard
  if (normalizedPattern === "*") {
    return true;
  }

  // Exact match
  if (normalizedJid === normalizedPattern) {
    return true;
  }

  // Domain wildcard: *@example.com
  if (normalizedPattern.startsWith("*@")) {
    const domain = normalizedPattern.slice(2);
    if (domain && normalizedJid.endsWith(`@${domain}`)) {
      return true;
    }
  }

  return false;
}

async function startAccount(ctx: {
  account: ResolvedXmppAccount;
  accountId?: string;
  cfg: CoreConfig;
  log?: { info: (msg: string) => void };
}): Promise<{ stop: () => Promise<void> }> {
  const account = ctx.account;
  const accountId = ctx.accountId || DEFAULT_ACCOUNT_ID;
  const cfg = ctx.cfg;
  const log = ctx.log?.info || console.log;

  if (!account.configured || !account.jid || !account.password || !account.server) {
    throw new Error(`[XMPP] Account "${accountId}" is not properly configured`);
  }

  log(`[XMPP] Starting account "${accountId}" as ${account.jid}`);

  const client = new XmppClient({
    jid: account.jid,
    password: account.password,
    server: account.server,
    resource: account.resource,
  });
  await client.connect();

  clients.set(accountId, client);
  log(`[XMPP] Connected as ${account.jid}`);

  // Wait longer for session to be fully established before joining rooms
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Join configured MUC rooms
  const xmppCfg = cfg.channels?.xmpp;
  if (xmppCfg?.rooms) {
    for (const roomJid of xmppCfg.rooms) {
      try {
        const nick = account.jid.split("@")[0] || "openclaw";
        await client.joinRoom(roomJid, nick);
        log(`[XMPP] Joined room: ${roomJid}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log(`[XMPP] Failed to join room ${roomJid}: ${errorMsg}`);
      }
    }
  }

  // Subscribe to messages
  client.onMessage((message: XmppMessage | XmppRoomMessage) => {
    void handleInboundMessage(accountId, message, cfg, log);
  });

  // Subscribe to presence subscription requests
  client.onSubscriptionRequest(async (jid: string) => {
    await handleSubscriptionRequest(accountId, jid, cfg, log, client);
  });

  log(`[XMPP] Account "${accountId}" ready, listening for messages`);

  return {
    stop: async () => {
      log(`[XMPP] Stopping account "${accountId}"`);
      await client.disconnect();
      clients.delete(accountId);
      log(`[XMPP] Account "${accountId}" disconnected`);
    },
  };
}

async function handleSubscriptionRequest(
  accountId: string,
  jid: string,
  cfg: CoreConfig,
  log: (msg: string) => void,
  client: XmppClient,
): Promise<void> {
  const core = getXmppRuntime();
  const xmppCfg = cfg.channels?.xmpp;
  const bareJid = getBareJid(jid);

  // Check if JID is in allowFrom list
  const allowFrom = xmppCfg?.allowFrom ?? [];
  const isAllowed = allowFrom.some((entry) => {
    return jidMatchesPattern(bareJid, String(entry));
  });

  // Check pairing store
  const storeAllowFrom = await core.channel.pairing.readAllowFromStore("xmpp").catch(() => []);
  const isInStore = storeAllowFrom.some((entry) => {
    return jidMatchesPattern(bareJid, String(entry));
  });

  const dmPolicy = xmppCfg?.dmPolicy ?? "pairing";

  if (dmPolicy === "disabled") {
    log(`[XMPP] Rejected subscription from ${bareJid} (dmPolicy=disabled)`);
    await client.rejectSubscription(jid);
    return;
  }

  if (dmPolicy === "open" || isAllowed || isInStore) {
    log(`[XMPP] Accepted subscription from ${bareJid}`);
    await client.acceptSubscription(jid);
    return;
  }

  if (dmPolicy === "pairing") {
    const { code, created } = await core.channel.pairing.upsertPairingRequest({
      channel: "xmpp",
      id: bareJid,
      meta: { name: bareJid },
    });

    if (created) {
      log(`[XMPP] Pairing request from ${bareJid}, code: ${code}`);
    }

    // For now, accept the subscription but messages will be gated by pairing
    await client.acceptSubscription(jid);

    // Send pairing instructions
    try {
      await client.sendMessage(
        bareJid,
        [
          "OpenClaw: access not configured.",
          "",
          `Pairing code: ${code}`,
          "",
          "Ask the bot owner to approve with:",
          "openclaw pairing approve xmpp <code>",
        ].join("\n"),
        "chat",
        undefined,
      );
    } catch (err) {
      log(`[XMPP] Failed to send pairing instructions to ${bareJid}: ${String(err)}`);
    }
    return;
  }

  if (dmPolicy === "allowlist") {
    log(`[XMPP] Rejected subscription from ${bareJid} (not in allowlist)`);
    await client.rejectSubscription(jid);
  }
}

async function handleInboundMessage(
  accountId: string,
  message: XmppMessage | XmppRoomMessage,
  cfg: CoreConfig,
  log: (msg: string) => void,
): Promise<void> {
  const core = getXmppRuntime();
  const xmppCfg = cfg.channels?.xmpp;
  const isRoom = message.type === "groupchat";
  const senderJid = getBareJid(message.from);
  const nick = isRoom && "nick" in message ? message.nick : undefined;
  const displayName = nick || senderJid;
  const conversationJid = isRoom && "roomJid" in message ? message.roomJid : senderJid;

  // Extract thread ID for conversation context
  const threadId = message.thread?.trim() || undefined;

  // Access control checks
  if (isRoom) {
    const groupPolicy = xmppCfg?.groupPolicy ?? "open";
    if (groupPolicy === "disabled") {
      log(`[XMPP] Ignoring message from ${conversationJid} (groupPolicy=disabled)`);
      return;
    }

    // Check group allowlist
    if (groupPolicy === "allowlist") {
      const mucRooms = xmppCfg?.mucRooms ?? {};
      const roomConfig = mucRooms[conversationJid];

      if (!roomConfig || roomConfig.enabled === false) {
        log(`[XMPP] Ignoring message from ${conversationJid} (not in allowlist)`);
        return;
      }

      // Check per-room user allowlist
      const roomUsers = roomConfig.users ?? [];
      if (roomUsers.length > 0) {
        const isUserAllowed = roomUsers.some((entry) => {
          return jidMatchesPattern(senderJid, String(entry));
        });

        if (!isUserAllowed) {
          log(
            `[XMPP] Ignoring message from ${senderJid} in ${conversationJid} (user not in room allowlist)`,
          );
          return;
        }
      }

      // Check groupAllowFrom
      const groupAllowFrom = xmppCfg?.groupAllowFrom ?? [];
      if (groupAllowFrom.length > 0 && roomUsers.length === 0) {
        const isSenderAllowed = groupAllowFrom.some((entry) => {
          return jidMatchesPattern(senderJid, String(entry));
        });

        if (!isSenderAllowed) {
          log(`[XMPP] Ignoring message from ${senderJid} (not in groupAllowFrom)`);
          return;
        }
      }
    }
  } else {
    // Direct message access control
    const dmPolicy = xmppCfg?.dmPolicy ?? "pairing";

    if (dmPolicy === "disabled") {
      log(`[XMPP] Ignoring DM from ${senderJid} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowFrom = xmppCfg?.allowFrom ?? [];
      const isAllowed = allowFrom.some((entry) => {
        return jidMatchesPattern(senderJid, String(entry));
      });

      // Check pairing store
      const storeAllowFrom = await core.channel.pairing.readAllowFromStore("xmpp").catch(() => []);
      const isInStore = storeAllowFrom.some((entry) => {
        return jidMatchesPattern(senderJid, String(entry));
      });

      if (!isAllowed && !isInStore) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "xmpp",
            id: senderJid,
            meta: { name: senderJid },
          });

          if (created) {
            log(`[XMPP] Pairing request from ${senderJid}, code: ${code}`);
          }

          // Proactively request subscription from user (so we can send them messages)
          const client = clients.get(accountId);
          if (client) {
            try {
              // Request subscription first
              await client.requestSubscription(senderJid);
              log(`[XMPP] Requested presence subscription from ${senderJid}`);

              // Then try to send pairing instructions
              // Note: This might fail if subscription isn't established yet
              // User will see the subscription request in their client and can accept
              // Once they accept, they can message the bot again to get instructions
              try {
                await client.sendMessage(
                  senderJid,
                  [
                    "OpenClaw: access not configured.",
                    "",
                    `Pairing code: ${code}`,
                    "",
                    "Ask the bot owner to approve with:",
                    "openclaw pairing approve xmpp <code>",
                  ].join("\n"),
                  "chat",
                  undefined,
                );
                log(`[XMPP] Sent pairing instructions to ${senderJid}`);
              } catch {
                log(
                  `[XMPP] Could not send pairing instructions to ${senderJid} yet (subscription pending)`,
                );
                log(`[XMPP] User will see subscription request and can accept, then message again`);
              }
            } catch (err) {
              log(`[XMPP] Failed to request subscription from ${senderJid}: ${String(err)}`);
            }
          }
        }
        log(`[XMPP] Ignoring message from ${senderJid} (dmPolicy=${dmPolicy}, not authorized)`);
        return;
      }
    }
  }

  let rawBody = message.body || "";

  // Handle media links from XEP-0066 (Out of Band Data)
  if (message.links && message.links.length > 0) {
    const mediaUrls = message.links
      .filter((link) => link.url)
      .map((link) => {
        const desc = link.description ? ` (${link.description})` : "";
        return `${link.url}${desc}`;
      })
      .join("\n");

    if (mediaUrls) {
      rawBody = rawBody ? `${rawBody}\n\n${mediaUrls}` : mediaUrls;
    }
  }

  // Handle reactions from XEP-0444 (Message Reactions)
  if (message.reactions) {
    const reactionText = `[Reacted to message ${message.reactions.id}: ${message.reactions.reactions.join(" ")}]`;
    rawBody = rawBody ? `${rawBody}\n\n${reactionText}` : reactionText;
  }

  // Embed message ID in body for agent reference (like Matrix/Discord pattern)
  if (message.id) {
    const conversationJid = isRoom && "roomJid" in message ? message.roomJid : senderJid;
    rawBody = `${rawBody}\n[xmpp message id: ${message.id} conversation: ${conversationJid}]`;
  }

  if (!rawBody.trim()) {
    return;
  }

  try {
    // Resolve agent route
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "xmpp",
      accountId,
      peer: {
        kind: isRoom ? "group" : "dm",
        id: conversationJid,
      },
    });

    if (!route) {
      log(`[XMPP] No agent route for ${senderJid} in ${conversationJid}, ignoring`);
      return;
    }

    log(`[XMPP] Route resolved: agent="${route.agentId}", session="${route.sessionKey}"`);

    // Format envelope body for the agent
    const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = core.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "XMPP",
      from: displayName,
      timestamp: message.timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: rawBody,
    });

    // Finalize inbound context
    const fromAddr = isRoom ? `xmpp:group:${conversationJid}` : `xmpp:${senderJid}`;
    const toAddr = isRoom ? `xmpp:group:${conversationJid}` : `xmpp:${senderJid}`;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: rawBody,
      CommandBody: rawBody,
      From: fromAddr,
      To: toAddr,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isRoom ? "group" : "direct",
      ConversationLabel: displayName,
      SenderName: displayName,
      SenderId: senderJid,
      Provider: "xmpp",
      Surface: "xmpp",
      MessageSid: message.id || String(Date.now()),
      MessageThreadId: threadId,
      Timestamp: message.timestamp.getTime(),
      OriginatingChannel: "xmpp",
      OriginatingTo: toAddr,
    });

    // Record session
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !isRoom
        ? {
            sessionKey: route.mainSessionKey,
            channel: "xmpp",
            to: toAddr,
            accountId: route.accountId,
          }
        : undefined,
      onRecordError: (err: unknown) => {
        log(`[XMPP] Session record error: ${String(err)}`);
      },
    });

    // Setup typing indicators
    const client = clients.get(accountId);
    const messageType = isRoom ? "groupchat" : "chat";
    const target = isRoom ? conversationJid : senderJid;

    const typingCallbacks = client
      ? createTypingCallbacks({
          start: async () => {
            await client.sendChatState(target, "composing", messageType);
          },
          stop: async () => {
            await client.sendChatState(target, "active", messageType);
          },
          onStartError: (err) => {
            log(`[XMPP] Failed to send typing indicator: ${String(err)}`);
          },
          onStopError: (err) => {
            log(`[XMPP] Failed to clear typing indicator: ${String(err)}`);
          },
        })
      : undefined;

    // Dispatch for AI reply with deliver callback
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string; mediaUrl?: string }) => {
          const client = clients.get(accountId);
          if (!client) {
            log(`[XMPP] Cannot deliver reply: client not connected for "${accountId}"`);
            return;
          }

          let finalMediaUrl = payload.mediaUrl;

          // Handle media URL: HTTP/HTTPS URLs are used directly, local files are uploaded
          if (payload.mediaUrl) {
            const isHttpUrl = /^https?:\/\//i.test(payload.mediaUrl);

            if (isHttpUrl) {
              // HTTP/HTTPS URL - use directly in OOB, no upload needed
              log(`[XMPP] Using HTTP URL directly: ${payload.mediaUrl.substring(0, 60)}...`);
              finalMediaUrl = payload.mediaUrl;
            } else {
              // Local file path - download and upload via HTTP File Upload
              try {
                log(`[XMPP] Uploading local file: ${payload.mediaUrl.substring(0, 60)}...`);

                // Determine media size limit
                const mediaMaxBytes =
                  resolveChannelMediaMaxBytes({
                    cfg,
                    resolveChannelLimitMb: ({ cfg }) =>
                      (cfg as CoreConfig).channels?.xmpp?.mediaMaxMb,
                  }) ?? 100 * 1024 * 1024; // Default 100MB

                // Load local media file
                const media = await loadWebMedia(payload.mediaUrl, mediaMaxBytes);
                log(
                  `[XMPP] Loaded local file: ${media.fileName || "file"} (${(media.buffer.length / 1024).toFixed(2)} KB)`,
                );

                // Request HTTP upload slot
                const slot = await client.requestUploadSlot(
                  {
                    filename: media.fileName || "file",
                    size: media.buffer.length,
                    contentType: media.contentType || "application/octet-stream",
                  },
                  cfg.channels?.xmpp?.blockedMediaTypes,
                );
                log(`[XMPP] Received upload slot: ${slot.putUrl.substring(0, 60)}...`);

                // Upload to slot
                await uploadToSlot(slot, media.buffer, media.contentType);
                log(`[XMPP] Upload complete: ${slot.getUrl}`);

                // Use the uploaded URL
                finalMediaUrl = slot.getUrl;
              } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                log(`[XMPP] Media upload failed: ${errorMsg}`);
                // Fall back to sending just text without media
                finalMediaUrl = undefined;
              }
            }
          }

          if (payload.text) {
            await client.sendMessage(target, payload.text, messageType, {
              mediaUrl: finalMediaUrl,
              threadId: threadId,
            });
            log(
              `[XMPP] Delivered ${messageType} reply to ${target}${threadId ? ` (thread: ${threadId})` : ""}${finalMediaUrl ? " with media" : ""}: ${payload.text.substring(0, 60)}...`,
            );
          }
        },
        onError: (err: unknown, info?: { kind?: string }) => {
          log(`[XMPP] Reply delivery failed (${info?.kind ?? "unknown"}): ${String(err)}`);
        },
        onReplyStart: typingCallbacks?.onReplyStart,
        onIdle: typingCallbacks?.onIdle,
      },
    });

    log(`[XMPP] Processed message from ${displayName} via agent "${route.agentId}"`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`[XMPP] Error routing inbound message from ${senderJid}: ${error}`);
  }
}

async function sendMessageXmpp(
  to: string,
  text: string,
  accountId?: string,
  options?: { threadId?: string },
): Promise<void> {
  const id = normalizeAccountId(accountId) || DEFAULT_ACCOUNT_ID;
  const client = clients.get(id);

  if (!client) {
    throw new Error(`XMPP client not connected for account "${id}"`);
  }

  const isRoom = isGroupJid(to);
  const messageType = isRoom ? "groupchat" : "chat";

  await client.sendMessage(to, text, messageType, options);
}

export const xmppPlugin: ChannelPlugin<ResolvedXmppAccount> = {
  id: "xmpp",
  meta,
  onboarding: xmppOnboardingAdapter,
  pairing: {
    idLabel: "xmppJid",
    normalizeAllowEntry: (entry) => entry.replace(/^xmpp:/i, "").toLowerCase(),
    notifyApproval: async ({ id }) => {
      try {
        await sendMessageXmpp(id, PAIRING_APPROVED_MESSAGE);
        console.log(`[XMPP] Sent pairing approval notification to ${id}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(`[XMPP] Failed to send pairing approval notification to ${id}: ${errorMsg}`);
        // Don't throw - user might not have subscription yet, but log the issue
      }
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    threads: true,
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        return undefined;
      }
      // Remove xmpp: prefix
      const withoutPrefix = trimmed.replace(/^xmpp:/i, "").trim();
      return withoutPrefix || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        // Remove xmpp: prefix for checking
        const withoutPrefix = trimmed.replace(/^xmpp:/i, "").trim();
        // XMPP JID format: local@domain or local@domain/resource
        // Must contain @ symbol
        return withoutPrefix.includes("@");
      },
      hint: "Use full JID format: user@domain or room@conference.domain",
    },
  },
  actions: xmppMessageActions,
  reload: { configPrefixes: ["channels.xmpp"] },
  configSchema: buildChannelConfigSchema(XmppConfigSchema),
  config: {
    listAccountIds: (cfg) => listXmppAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveXmppAccount(cfg as CoreConfig, accountId),
    isConfigured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.server,
      jid: account.jid,
    }),
  },
  gateway: {
    startAccount: (ctx) =>
      startAccount({
        account: ctx.account,
        accountId: ctx.accountId,
        cfg: ctx.cfg as CoreConfig,
        log: ctx.log,
      }),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "xmpp",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ timeoutMs, account }) => {
      if (!account.configured || !account.jid || !account.password || !account.server) {
        return {
          ok: false,
          error: "Account not configured",
          elapsedMs: 0,
        };
      }

      return await probeXmpp({
        jid: account.jid,
        password: account.password,
        server: account.server,
        resource: account.resource,
        timeoutMs,
      });
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.server,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      const { to, text, mediaUrl, accountId: acctId } = ctx;
      const log = console.log;
      const id = normalizeAccountId(acctId ?? undefined) || DEFAULT_ACCOUNT_ID;
      const client = clients.get(id);

      if (!client) {
        throw new Error(`XMPP client not connected for account "${id}"`);
      }

      const isRoom = isGroupJid(to);
      const messageType = isRoom ? "groupchat" : "chat";

      const messageId = await client.sendMessage(to, text, messageType, { mediaUrl });

      if (mediaUrl) {
        log(
          `[XMPP] Sent ${messageType} message with media to ${to}: ${text.substring(0, 40)}... [${mediaUrl}]`,
        );
      } else {
        log(`[XMPP] Sent ${messageType} message to ${to}: ${text.substring(0, 60)}...`);
      }

      return {
        channel: "xmpp",
        messageId,
        toJid: to,
      };
    },
    sendMedia: async (ctx) => {
      const { to, mediaUrl, text, accountId: acctId, cfg } = ctx;
      const log = console.log;
      const id = normalizeAccountId(acctId ?? undefined) || DEFAULT_ACCOUNT_ID;
      const client = clients.get(id);

      if (!client) {
        throw new Error(`XMPP client not connected for account "${id}"`);
      }

      if (!mediaUrl) {
        throw new Error("No mediaUrl provided");
      }

      const mediaMaxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg }) => {
          const xmppCfg = (cfg as CoreConfig).channels?.xmpp;
          return xmppCfg?.mediaMaxMb;
        },
        accountId: acctId,
      });

      let finalMediaUrl = mediaUrl;

      try {
        // Check if mediaUrl is HTTP/HTTPS or a local file path
        const isHttpUrl = /^https?:\/\//i.test(mediaUrl);

        if (isHttpUrl) {
          // HTTP/HTTPS URL - use directly in OOB, no upload needed
          finalMediaUrl = mediaUrl;
          log(`[XMPP] Using HTTP URL directly: ${mediaUrl}`);
        } else {
          // Local file path - load and upload via HTTP File Upload (XEP-0363)
          log(`[XMPP] Loading local file: ${mediaUrl}`);
          const media = await loadWebMedia(mediaUrl, mediaMaxBytes);

          log(`[XMPP] Requesting HTTP upload slot (${media.buffer.length} bytes)`);
          const slot = await client.requestUploadSlot(
            {
              filename: media.fileName || "file",
              size: media.buffer.length,
              contentType: media.contentType,
            },
            cfg.channels?.xmpp?.blockedMediaTypes,
          );

          log(`[XMPP] Uploading to ${slot.putUrl}`);
          await uploadToSlot(slot, media.buffer, media.contentType);

          finalMediaUrl = slot.getUrl;
          log(`[XMPP] Upload complete, GET URL: ${finalMediaUrl}`);
        }

        // Send message with media URL via XEP-0066 Out of Band Data
        const isRoom = isGroupJid(to);
        const messageType = isRoom ? "groupchat" : "chat";
        const messageText = text || "";

        const messageId = await client.sendMessage(to, messageText, messageType, {
          mediaUrl: finalMediaUrl,
        });

        log(`[XMPP] Sent ${messageType} message with media to ${to}: ${finalMediaUrl}`);

        return {
          channel: "xmpp",
          messageId,
          toJid: to,
          mediaUrl: finalMediaUrl,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`[XMPP] Failed to send media to ${to}: ${errorMsg}`);
        throw new Error(`Failed to send media: ${errorMsg}`, { cause: error });
      }
    },
  },
};
