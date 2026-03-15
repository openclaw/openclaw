import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/campfire";
import {
  applyBasicWebhookRequestGuards,
  readJsonWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
  resolveChannelMediaMaxBytes,
  resolveOutboundMediaUrls,
  resolveWebhookPath,
  resolveWebhookTargets,
} from "openclaw/plugin-sdk/campfire";
import type { ResolvedCampfireAccount } from "./accounts.js";
import { sendCampfireMessage, sendCampfireAttachment } from "./api.js";
import { getCampfireRuntime } from "./runtime.js";
import type { CampfireRuntimeEnv, CampfireWebhookPayload } from "./types.js";

export type CampfireMonitorOptions = {
  account: ResolvedCampfireAccount;
  config: OpenClawConfig;
  runtime: CampfireRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type CampfireCoreRuntime = ReturnType<typeof getCampfireRuntime>;

type WebhookTarget = {
  account: ResolvedCampfireAccount;
  config: OpenClawConfig;
  runtime: CampfireRuntimeEnv;
  core: CampfireCoreRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function logVerbose(core: CampfireCoreRuntime, runtime: CampfireRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[campfire] ${message}`);
  }
}

async function handleCampfireWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const match = resolveWebhookTargets(req, webhookTargets);
  if (!match) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  const ok = applyBasicWebhookRequestGuards({
    req,
    res,
    allowMethods: ["POST"],
  });
  if (!ok) {
    return;
  }

  const body = await readJsonWebhookBodyOrReject({
    req,
    res,
    profile: "post-auth",
    invalidJsonMessage: "invalid payload",
  });
  if (!body.ok) {
    return;
  }

  const raw = body.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return;
  }

  // Validate Campfire webhook payload structure
  const payload = raw as Partial<CampfireWebhookPayload>;
  if (
    !payload.user ||
    typeof payload.user.id !== "number" ||
    !payload.room ||
    typeof payload.room.id !== "number" ||
    !payload.message ||
    typeof payload.message.id !== "number"
  ) {
    res.statusCode = 400;
    res.end("invalid payload structure");
    return;
  }

  // Use the first registered target (Campfire doesn't have authentication on webhooks)
  const selected = match.targets[0];
  if (!selected) {
    res.statusCode = 500;
    res.end("no target registered");
    return;
  }

  selected.statusSink?.({ lastInboundAt: Date.now() });

  // Fire-and-forget: process message asynchronously AFTER sending response
  // CRITICAL: Campfire has a 7-second webhook timeout, so we must respond immediately
  processCampfireEvent(payload as CampfireWebhookPayload, selected).catch((err) => {
    selected?.runtime.error?.(
      `[${selected.account.accountId}] Campfire webhook failed: ${String(err)}`,
    );
  });

  // Silent ACK — avoid text/plain to prevent Campfire from posting the body as a bot message
  res.statusCode = 200;
  res.end();
}

function normalizeUserId(raw?: number | string | null): string {
  if (raw == null) {
    return "";
  }
  return String(raw).trim().toLowerCase();
}

export function isSenderAllowed(
  senderId: number,
  senderName: string | undefined,
  allowFrom: Array<string | number>,
): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeUserId(senderId);
  const normalizedName = senderName?.trim().toLowerCase() ?? "";
  return allowFrom.some((entry) => {
    const normalized = String(entry).trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized === normalizedSenderId) {
      return true;
    }
    if (normalizedName && normalized === normalizedName) {
      return true;
    }
    if (normalized.replace(/^campfire:/i, "") === normalizedSenderId) {
      return true;
    }
    return false;
  });
}

type GroupEntry = {
  requireMention?: boolean;
  allow?: boolean;
  enabled?: boolean;
  users?: Array<string | number>;
  systemPrompt?: string;
};

/** @internal Exported for testing. */
export function resolveGroupConfig(params: {
  groupId: number;
  groupName?: string | null;
  groups?: Record<string, GroupEntry>;
}): { entry: GroupEntry | undefined; allowlistConfigured: boolean } {
  const { groupId, groupName, groups } = params;
  const entries = groups ?? {};
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return { entry: undefined, allowlistConfigured: false };
  }
  const normalizedName = groupName?.trim().toLowerCase();
  const groupIdStr = String(groupId);
  const entry =
    entries[groupIdStr] ??
    (groupName?.trim() ? entries[groupName.trim()] : undefined) ??
    (normalizedName ? entries[normalizedName] : undefined) ??
    // Fallback: "*" acts as a catch-all wildcard matching any room.
    entries["*"];
  return { entry, allowlistConfigured: true };
}

async function processCampfireEvent(payload: CampfireWebhookPayload, target: WebhookTarget) {
  const { account, config, runtime, core, statusSink } = target;
  const { user, room, message } = payload;

  const roomId = room.id;
  const roomName = room.name;

  if (!account.botKey) {
    runtime.error?.(`[${account.accountId}] Campfire bot key not configured, skipping message`);
    return;
  }

  // Reconstruct the reply path from trusted server-side values instead of
  // trusting room.path from the webhook payload (no signature verification).
  const roomPath = `/rooms/${roomId}/${account.botKey}/messages`;
  const senderId = user.id;
  const senderName = user.name;
  const messageText = (message.body.plain ?? "").trim();

  if (!messageText) {
    return;
  }

  // Campfire webhooks are triggered by @mentions — all messages are group messages
  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
  const groupConfigResolved = resolveGroupConfig({
    groupId: roomId,
    groupName: roomName,
    groups: account.config.groups ?? undefined,
  });
  const groupEntry = groupConfigResolved.entry;
  const groupUsers = groupEntry?.users ?? account.config.groupAllowFrom ?? [];

  if (groupPolicy === "disabled") {
    logVerbose(core, runtime, `drop message (groupPolicy=disabled, room=${roomId})`);
    return;
  }
  if (groupPolicy === "allowlist" && !groupEntry) {
    const reason = groupConfigResolved.allowlistConfigured
      ? `not allowlisted, room=${roomId}`
      : `no allowlist configured, room=${roomId}`;
    logVerbose(core, runtime, `drop message (groupPolicy=allowlist, ${reason})`);
    return;
  }
  if (groupEntry?.enabled === false || groupEntry?.allow === false) {
    logVerbose(core, runtime, `drop message (room disabled, room=${roomId})`);
    return;
  }

  if (groupUsers.length > 0) {
    const ok = isSenderAllowed(senderId, senderName, groupUsers);
    if (!ok) {
      logVerbose(core, runtime, `drop message (sender not allowed, ${senderId})`);
      return;
    }
  }

  // Check command authorization
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(
    messageText,
    config,
  );
  const commandAllowFrom = groupUsers.map((v) => String(v));
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, senderName, commandAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (
    core.channel.commands.isControlCommandMessage(messageText, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `campfire: drop control command from ${senderId}`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "campfire",
    accountId: account.accountId,
    peer: {
      kind: "group",
      id: String(roomId),
    },
  });

  const fromLabel = roomName || `room:${roomId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Campfire",
    from: `${senderName} in ${fromLabel}`,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: messageText,
  });

  const groupSystemPrompt = groupConfigResolved.entry?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: messageText,
    CommandBody: messageText,
    From: `campfire:${senderId}`,
    To: `campfire:${roomId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "channel",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: String(senderId),
    WasMentioned: true,
    CommandAuthorized: commandAuthorized,
    Provider: "campfire",
    Surface: "campfire",
    MessageSid: String(message.id),
    MessageSidFull: /^\/[\w\/\-]+$/.test(message.path) ? message.path : `msg-${message.id}`,
    GroupSpace: roomName || undefined,
    GroupSystemPrompt: groupSystemPrompt,
    OriginatingChannel: "campfire",
    OriginatingTo: `campfire:${roomId}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`campfire: failed updating session meta: ${String(err)}`);
    });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (replyPayload) => {
        await deliverCampfireReply({
          payload: replyPayload,
          account,
          roomPath,
          runtime,
          core,
          config,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] Campfire ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
  });
}

async function deliverCampfireReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  account: ResolvedCampfireAccount;
  roomPath: string;
  runtime: CampfireRuntimeEnv;
  core: CampfireCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, roomPath, runtime, core, config, statusSink } = params;
  const mediaList = resolveOutboundMediaUrls(payload);

  // Send media attachments
  if (mediaList.length > 0) {
    const maxBytes = resolveChannelMediaMaxBytes({
      cfg: config,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        (
          cfg.channels?.["campfire"] as
            | { accounts?: Record<string, { mediaMaxMb?: number }>; mediaMaxMb?: number }
            | undefined
        )?.accounts?.[accountId]?.mediaMaxMb ??
        (cfg.channels?.["campfire"] as { mediaMaxMb?: number } | undefined)?.mediaMaxMb,
      accountId: account.accountId,
    });
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? payload.text : undefined;
      first = false;
      try {
        const loaded = await core.channel.media.fetchRemoteMedia({ url: mediaUrl, maxBytes });

        // Send caption as text first if present
        if (caption?.trim()) {
          const textResult = await sendCampfireMessage({
            account,
            roomPath,
            text: caption,
          });
          if (!textResult.ok) {
            runtime.error?.(`Campfire caption send failed: ${textResult.error}`);
          }
          statusSink?.({ lastOutboundAt: Date.now() });
        }

        // Send attachment
        const result = await sendCampfireAttachment({
          account,
          roomPath,
          buffer: loaded.buffer,
          filename: loaded.fileName ?? "attachment",
          contentType: loaded.contentType,
        });
        if (!result.ok) {
          runtime.error?.(`Campfire attachment send failed: ${result.error}`);
        }
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Campfire attachment send failed: ${String(err)}`);
      }
    }
    return;
  }

  // Send text message
  if (payload.text) {
    const chunkLimit = account.config.textChunkLimit ?? 4000;
    const chunkMode = core.channel.text.resolveChunkMode(config, "campfire", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (const chunk of chunks) {
      try {
        const result = await sendCampfireMessage({
          account,
          roomPath,
          text: chunk,
        });
        if (!result.ok) {
          runtime.error?.(`Campfire message send failed: ${result.error}`);
        }
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Campfire message send failed: ${String(err)}`);
      }
    }
  }
}

function registerCampfireWebhookTarget(target: WebhookTarget): () => void {
  return registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "campfire",
      source: "campfire-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        await handleCampfireWebhookRequest(req, res);
      },
    },
  }).unregister;
}

export function startCampfireMonitor(options: CampfireMonitorOptions): () => void {
  const core = getCampfireRuntime();
  const webhookPath = resolveCampfireWebhookPath({ account: options.account });

  return registerCampfireWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    statusSink: options.statusSink,
  });
}

export function resolveCampfireWebhookPath(params: { account: ResolvedCampfireAccount }): string {
  // defaultPath guarantees a non-null return
  return resolveWebhookPath({
    webhookPath: params.account.config.webhookPath,
    defaultPath: "/campfire",
  })!;
}
