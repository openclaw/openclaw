import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedCampfireAccount } from "./accounts.js";
import type { CampfireWebhookPayload } from "./types.js";
import { sendCampfireMessage, sendCampfireAttachment } from "./api.js";
import { getCampfireRuntime } from "./runtime.js";

export type CampfireRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type CampfireMonitorOptions = {
  account: ResolvedCampfireAccount;
  config: OpenClawConfig;
  runtime: CampfireRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
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
  mediaMaxMb: number;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function logVerbose(core: CampfireCoreRuntime, runtime: CampfireRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[campfire] ${message}`);
  }
}

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function resolveWebhookPath(webhookPath?: string): string {
  const trimmedPath = webhookPath?.trim();
  if (trimmedPath) {
    return normalizeWebhookPath(trimmedPath);
  }
  return "/campfire";
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    let resolved = false;
    const doResolve = (value: { ok: boolean; value?: unknown; error?: string }) => {
      if (resolved) {
        return;
      }
      resolved = true;
      req.removeAllListeners();
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        doResolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          doResolve({ ok: false, error: "empty payload" });
          return;
        }
        doResolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        doResolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      doResolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

export function registerCampfireWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

export async function handleCampfireWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);

  if (!targets || targets.length === 0) {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const raw = body.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
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
    return true;
  }

  // Use the first registered target (Campfire doesn't have authentication on webhooks)
  const selected = targets[0];
  if (!selected) {
    res.statusCode = 500;
    res.end("no target registered");
    return true;
  }

  selected.statusSink?.({ lastInboundAt: Date.now() });

  // Fire-and-forget: process message asynchronously AFTER sending response
  // CRITICAL: Campfire has a 7-second webhook timeout, so we must respond immediately
  processCampfireEvent(payload as CampfireWebhookPayload, selected).catch((err) => {
    selected?.runtime.error?.(
      `[${selected.account.accountId}] Campfire webhook failed: ${String(err)}`,
    );
  });

  // Return immediate acknowledgment - Campfire posts text/plain responses as messages
  // This gives users instant feedback while AI processing happens asynchronously
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Got it, working on a response...");
  return true;
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

function resolveGroupConfig(params: {
  groupId: number;
  groupName?: string | null;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
      allow?: boolean;
      enabled?: boolean;
      users?: Array<string | number>;
      systemPrompt?: string;
    }
  >;
}) {
  const { groupId, groupName, groups } = params;
  const entries = groups ?? {};
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return { entry: undefined, allowlistConfigured: false };
  }
  const normalizedName = groupName?.trim().toLowerCase();
  const groupIdStr = String(groupId);
  const candidates = [groupIdStr, groupName ?? "", normalizedName ?? ""].filter(Boolean);
  let entry = candidates.map((candidate) => entries[candidate]).find(Boolean);
  if (!entry && normalizedName) {
    entry = entries[normalizedName];
  }
  const fallback = entries["*"];
  return { entry: entry ?? fallback, allowlistConfigured: true, fallback };
}

async function processCampfireEvent(payload: CampfireWebhookPayload, target: WebhookTarget) {
  const { account, config, runtime, core, statusSink, mediaMaxMb } = target;
  const { user, room, message } = payload;

  const roomId = room.id;
  const roomName = room.name;
  // Campfire's webhook payload includes the full reply path with bot key
  // e.g., "/rooms/{room_id}/{bot_key}/messages" from room_bot_messages_path helper
  const roomPath = room.path;
  const senderId = user.id;
  const senderName = user.name;
  const messageText = (message.body.plain ?? "").trim();

  if (!messageText) {
    return;
  }

  // Campfire webhooks are triggered by @mentions, so treat all as group messages
  const isGroup = true;

  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
  const groupConfigResolved = resolveGroupConfig({
    groupId: roomId,
    groupName: roomName,
    groups: account.config.groups ?? undefined,
  });
  const groupEntry = groupConfigResolved.entry;
  const groupUsers = groupEntry?.users ?? account.config.groupAllowFrom ?? [];

  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, `drop message (groupPolicy=disabled, room=${roomId})`);
      return;
    }
    const groupAllowlistConfigured = groupConfigResolved.allowlistConfigured;
    const groupAllowed = Boolean(groupEntry) || Boolean((account.config.groups ?? {})["*"]);
    if (groupPolicy === "allowlist") {
      if (!groupAllowlistConfigured) {
        logVerbose(
          core,
          runtime,
          `drop message (groupPolicy=allowlist, no allowlist, room=${roomId})`,
        );
        return;
      }
      if (!groupAllowed) {
        logVerbose(core, runtime, `drop message (not allowlisted, room=${roomId})`);
        return;
      }
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
    isGroup &&
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
    WasMentioned: true, // Campfire only sends webhooks for @mentions
    CommandAuthorized: commandAuthorized,
    Provider: "campfire",
    Surface: "campfire",
    MessageSid: String(message.id),
    MessageSidFull: message.path,
    GroupSpace: roomName || undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
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
          mediaMaxMb,
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
  mediaMaxMb: number;
}): Promise<void> {
  const { payload, account, roomPath, runtime, core, config, statusSink, mediaMaxMb } = params;
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  // Send media attachments
  if (mediaList.length > 0) {
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? payload.text : undefined;
      first = false;
      try {
        const loaded = await core.channel.media.fetchRemoteMedia(mediaUrl, {
          maxBytes: mediaMaxMb * 1024 * 1024,
        });

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
          filename: loaded.filename ?? "attachment",
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

export function monitorCampfireProvider(options: CampfireMonitorOptions): () => void {
  const core = getCampfireRuntime();
  const webhookPath = resolveWebhookPath(options.webhookPath);

  const mediaMaxMb = options.account.config.mediaMaxMb ?? 20;

  const unregister = registerCampfireWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    statusSink: options.statusSink,
    mediaMaxMb,
  });

  return unregister;
}

export async function startCampfireMonitor(params: CampfireMonitorOptions): Promise<() => void> {
  return monitorCampfireProvider(params);
}

export function resolveCampfireWebhookPath(params: { account: ResolvedCampfireAccount }): string {
  return resolveWebhookPath(params.account.config.webhookPath);
}
