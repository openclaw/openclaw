import { RequestClient } from "@buape/carbon";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import {
  buildWhatsAppInboundEnvelope,
  buildDiscordInboundEnvelope,
  buildTelegramCallbackInboundEnvelope,
  buildTelegramInboundEnvelope,
  collectOutboundMediaUrls,
  type MuxInboundAttachment,
  type MuxPayload,
  readOutboundOperation,
  readOutboundRaw,
  readOutboundText,
} from "./mux-envelope.js";
import { createRuntimeJwtSigner, hasScope } from "./runtime-jwt.js";

type SendResult = {
  statusCode: number;
  bodyText: string;
};

type InflightEntry = {
  fingerprint: string;
  promise: Promise<SendResult>;
};

type TenantSeed = {
  id: string;
  name: string;
  apiKey: string;
  inboundUrl?: string;
  inboundTimeoutMs: number;
};

type TenantIdentity = {
  id: string;
  name: string;
  authToken: string;
  authKind: "api-key" | "runtime-jwt" | "admin";
};

type PairingCodeSeed = {
  code: string;
  channel: string;
  routeKey: string;
  scope: string;
  expiresAtMs: number;
};

type CachedIdempotencyRow = {
  request_fingerprint: string;
  response_status: number;
  response_body: string;
};

type PairingCodeRow = {
  channel: string;
  route_key: string;
  scope: string;
  expires_at_ms: number;
  claimed_by_tenant_id: string | null;
};

type PairingTokenRow = {
  tenant_id: string;
  channel: string;
  session_key: string | null;
};

type ActiveBindingRow = {
  binding_id: string;
  channel: string;
  scope: string;
  route_key: string;
};

type ExistingBindingRow = {
  binding_id: string;
  status?: string;
};

type SessionRouteBindingRow = {
  binding_id: string;
  route_key: string;
  channel_context_json?: string | null;
};

type SessionRouteByBindingRow = {
  session_key?: unknown;
  channel_context_json?: unknown;
};

type ActiveBindingLookupRow = {
  tenant_id: string;
  binding_id: string;
};

type LiveBindingLookupRow = {
  tenant_id: string;
  binding_id: string;
  status: string;
};

type ActiveDiscordBindingRow = {
  tenant_id: string;
  binding_id: string;
  route_key: string;
  status: string;
};

type WhatsAppInboundQueueRow = {
  id: number;
  dedupe_key: string;
  payload_json: string;
  attempt_count: number;
};

type TelegramBoundRoute = {
  chatId: string;
  topicId?: number;
};

type DiscordBoundRoute =
  | {
      kind: "dm";
      userId: string;
    }
  | {
      kind: "guild";
      guildId: string;
      channelId?: string;
      threadId?: string;
    };

type DiscordOutboundTarget =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

type WhatsAppBoundRoute = {
  accountId: string;
  chatJid: string;
};

type TenantInboundTarget = {
  url: string;
  timeoutMs: number;
  openclawId: string;
};

type WebInboundMessage = {
  id?: string;
  from: string;
  to: string;
  accountId: string;
  body: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentionedJids?: string[];
  mediaPath?: string;
  mediaType?: string;
  mediaUrl?: string;
};

type ActiveWebListener = {
  close?: () => Promise<void>;
};

type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

type WebMonitorListener = ActiveWebListener & {
  close: () => Promise<void>;
  onClose: Promise<WebListenerCloseReason>;
};

type WhatsAppRuntimeHealth = {
  listenerActive: boolean;
  loopStartedAtMs: number | null;
  lastListenerStartAtMs: number | null;
  lastListenerCloseAtMs: number | null;
  lastListenerCloseStatus: number | null;
  lastListenerClosedLoggedOut: boolean | null;
  lastListenerErrorAtMs: number | null;
  lastListenerError: string | null;
  lastInboundSeenAtMs: number | null;
};

type WebRuntimeModules = {
  monitorWebInbox: (options: {
    verbose: boolean;
    accountId: string;
    authDir: string;
    onMessage: (msg: WebInboundMessage) => Promise<void>;
    resolveAccessControl?: (params: {
      accountId: string;
      from: string;
      selfE164: string | null;
      senderE164: string | null;
      group: boolean;
      pushName?: string;
      isFromMe: boolean;
      messageTimestampMs?: number;
      connectedAtMs?: number;
      sock: {
        sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
      };
      remoteJid: string;
    }) => Promise<{
      allowed: boolean;
      shouldMarkRead: boolean;
      isSelfChat: boolean;
      resolvedAccountId: string;
    }>;
    mediaMaxMb?: number;
    sendReadReceipts?: boolean;
    debounceMs?: number;
    shouldDebounce?: (msg: WebInboundMessage) => boolean;
  }) => Promise<WebMonitorListener>;
  sendMessageWhatsApp: (
    to: string,
    body: string,
    options: {
      verbose: boolean;
      mediaUrl?: string;
      gifPlayback?: boolean;
      accountId?: string;
    },
  ) => Promise<{ messageId: string; toJid: string }>;
  sendTypingWhatsApp: (to: string, options: { accountId?: string }) => Promise<void>;
  setActiveWebListener: (accountId: string | null | undefined, listener: unknown) => void;
};

type DiscordRuntimeModules = {
  sendMessageDiscord: (
    to: string,
    text: string,
    opts: {
      token?: string;
      rest?: RequestClient;
      mediaUrl?: string;
      verbose?: boolean;
      replyTo?: string;
    },
  ) => Promise<{ messageId: string; channelId: string }>;
};

type TelegramIncomingMessage = {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  animation?: TelegramAnimation;
  from?: { id?: number };
  chat?: { id?: number; type?: string; is_forum?: boolean };
};

type TelegramPhotoSize = {
  file_id?: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
};

type TelegramDocument = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramVideo = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration?: number;
  file_size?: number;
};

type TelegramAnimation = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration?: number;
  file_size?: number;
};

type TelegramInboundAttachment = MuxInboundAttachment;

type TelegramInboundMediaSummary = {
  kind: string;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  filePath?: string;
};

type DiscordInboundAttachment = MuxInboundAttachment;

type DiscordInboundMediaSummary = {
  id?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  url?: string;
};

type WhatsAppInboundAttachment = MuxInboundAttachment;

type WhatsAppInboundMediaSummary = {
  mediaPath?: string;
  mediaType?: string;
  sizeBytes?: number;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramIncomingMessage;
  edited_message?: TelegramIncomingMessage;
  callback_query?: TelegramCallbackQuery;
};

type BotControlCommand =
  | {
      kind: "help";
    }
  | {
      kind: "status";
    }
  | {
      kind: "unpair";
    }
  | {
      kind: "switch";
      token?: string;
    };

type NoticeChannel = "telegram" | "discord" | "whatsapp";
type TelegramParseMode = "HTML";
type StyledNotice = {
  text: string;
  parseMode?: TelegramParseMode;
};

type TelegramCallbackQuery = {
  id?: string;
  from?: { id?: number };
  data?: string;
  message?: TelegramIncomingMessage;
};

function resolveDefaultWhatsAppAuthDir(): string {
  const stateDirRaw =
    process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  const stateDir = stateDirRaw ? path.resolve(stateDirRaw) : path.join(os.homedir(), ".openclaw");
  const oauthDirRaw = process.env.OPENCLAW_OAUTH_DIR?.trim();
  const oauthDir = oauthDirRaw ? path.resolve(oauthDirRaw) : path.join(stateDir, "credentials");
  return path.join(oauthDir, "whatsapp", "default");
}

let webRuntimeModulesPromise: Promise<WebRuntimeModules> | null = null;
let discordRuntimeModulesPromise: Promise<DiscordRuntimeModules> | null = null;

async function loadWebRuntimeModules(): Promise<WebRuntimeModules> {
  if (!webRuntimeModulesPromise) {
    webRuntimeModulesPromise = (async () => {
      const inboundModulePath = "../../src/web/inbound.js";
      const outboundModulePath = "../../src/web/outbound.js";
      const activeListenerModulePath = "../../src/web/active-listener.js";
      const inboundModule = (await import(inboundModulePath)) as {
        monitorWebInbox?: WebRuntimeModules["monitorWebInbox"];
      };
      const outboundModule = (await import(outboundModulePath)) as {
        sendMessageWhatsApp?: WebRuntimeModules["sendMessageWhatsApp"];
        sendTypingWhatsApp?: WebRuntimeModules["sendTypingWhatsApp"];
      };
      const activeListenerModule = (await import(activeListenerModulePath)) as {
        setActiveWebListener?: WebRuntimeModules["setActiveWebListener"];
      };
      if (
        typeof inboundModule.monitorWebInbox !== "function" ||
        typeof outboundModule.sendMessageWhatsApp !== "function" ||
        typeof outboundModule.sendTypingWhatsApp !== "function" ||
        typeof activeListenerModule.setActiveWebListener !== "function"
      ) {
        throw new Error("failed to load WhatsApp runtime modules");
      }
      return {
        monitorWebInbox: inboundModule.monitorWebInbox,
        sendMessageWhatsApp: outboundModule.sendMessageWhatsApp,
        sendTypingWhatsApp: outboundModule.sendTypingWhatsApp,
        setActiveWebListener: activeListenerModule.setActiveWebListener,
      };
    })();
  }
  return await webRuntimeModulesPromise;
}

async function loadDiscordRuntimeModules(): Promise<DiscordRuntimeModules> {
  if (!discordRuntimeModulesPromise) {
    discordRuntimeModulesPromise = (async () => {
      const outboundModulePath = "../../src/discord/send.outbound.js";
      const outboundModule = (await import(outboundModulePath)) as {
        sendMessageDiscord?: DiscordRuntimeModules["sendMessageDiscord"];
      };
      if (typeof outboundModule.sendMessageDiscord !== "function") {
        throw new Error("failed to load Discord runtime modules");
      }
      return {
        sendMessageDiscord: outboundModule.sendMessageDiscord,
      };
    })();
  }
  return await discordRuntimeModulesPromise;
}

const host = process.env.MUX_HOST || "127.0.0.1";
const port = Number(process.env.MUX_PORT || 18891);
const muxPublicUrl = (process.env.MUX_PUBLIC_URL || `http://${host}:${port}`).replace(/\/+$/, "");
const TELEGRAM_GENERAL_TOPIC_ID = 1;
const muxAdminToken = readNonEmptyString(process.env.MUX_ADMIN_TOKEN);
const muxRegisterKey = readNonEmptyString(process.env.MUX_REGISTER_KEY);
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const discordBotToken = process.env.DISCORD_BOT_TOKEN;
const logPath =
  process.env.MUX_LOG_PATH || path.resolve(process.cwd(), "mux-server", "logs", "mux-server.log");
const dbPath =
  process.env.MUX_DB_PATH || path.resolve(process.cwd(), "mux-server", "data", "mux-server.sqlite");
const idempotencyTtlMs = Number(process.env.MUX_IDEMPOTENCY_TTL_MS || 10 * 60 * 1000);
const telegramApiBaseUrl = (
  process.env.MUX_TELEGRAM_API_BASE_URL || "https://api.telegram.org"
).replace(/\/+$/, "");
const discordApiBaseUrl = (
  process.env.MUX_DISCORD_API_BASE_URL || "https://discord.com/api/v10"
).replace(/\/+$/, "");
// OpenClaw account id for mux-routed inbound events. Keep this separate from
// platform account ids so direct channel bots can remain unchanged.
const openclawMuxAccountId = readNonEmptyString(process.env.MUX_OPENCLAW_ACCOUNT_ID) || "default";
const whatsappAccountId = readNonEmptyString(process.env.MUX_WHATSAPP_ACCOUNT_ID) || "default";
const whatsappAuthDir =
  readNonEmptyString(process.env.MUX_WHATSAPP_AUTH_DIR) || resolveDefaultWhatsAppAuthDir();

const telegramInboundEnabled = Boolean(readNonEmptyString(telegramBotToken));
const telegramPollTimeoutSec = Number(process.env.MUX_TELEGRAM_POLL_TIMEOUT_SEC || 25);
const telegramPollRetryMs = Number(process.env.MUX_TELEGRAM_POLL_RETRY_MS || 1_000);
const telegramBootstrapLatest = process.env.MUX_TELEGRAM_BOOTSTRAP_LATEST !== "false";
const discordInboundEnabled = Boolean(readNonEmptyString(discordBotToken));
const discordPollIntervalMs = Number(process.env.MUX_DISCORD_POLL_INTERVAL_MS || 2_000);
const discordBootstrapLatest = process.env.MUX_DISCORD_BOOTSTRAP_LATEST !== "false";
const discordPendingGcEnabled = process.env.MUX_DISCORD_PENDING_GC_ENABLED === "true";
// TODO(phala): simplify to gateway-only Discord DM ingestion and remove
// MUX_DISCORD_GATEWAY_DM_ENABLED plus DM polling fallback.
const discordGatewayDmEnabled = process.env.MUX_DISCORD_GATEWAY_DM_ENABLED !== "false";
const discordGatewayGuildEnabled = process.env.MUX_DISCORD_GATEWAY_GUILD_ENABLED !== "false";
const discordGatewayDefaultIntents = discordGatewayGuildEnabled
  ? 37_377 // Guilds + GuildMessages + DirectMessages + MessageContent
  : 36_864; // DirectMessages + MessageContent
const discordGatewayIntents = Number(
  process.env.MUX_DISCORD_GATEWAY_INTENTS ||
    process.env.MUX_DISCORD_GATEWAY_DM_INTENTS ||
    discordGatewayDefaultIntents,
);
const discordGatewayReconnectInitialMs = Number(
  process.env.MUX_DISCORD_GATEWAY_RECONNECT_INITIAL_MS || 1_000,
);
const discordGatewayReconnectMaxMs = Number(
  process.env.MUX_DISCORD_GATEWAY_RECONNECT_MAX_MS || 30_000,
);
const whatsappInboundEnabled = fs.existsSync(path.join(whatsappAuthDir, "creds.json"));
const whatsappInboundRetryMs = Number(process.env.MUX_WHATSAPP_INBOUND_RETRY_MS || 1_000);
const whatsappQueuePollMs = Number(process.env.MUX_WHATSAPP_QUEUE_POLL_MS || 500);
const whatsappQueueRetryInitialMs = Number(
  process.env.MUX_WHATSAPP_QUEUE_RETRY_INITIAL_MS || 1_000,
);
const whatsappQueueRetryMaxMs = Number(process.env.MUX_WHATSAPP_QUEUE_RETRY_MAX_MS || 60_000);
const whatsappQueueBatchSize = Number(process.env.MUX_WHATSAPP_QUEUE_BATCH_SIZE || 20);
const pairingTokenTtlSec = Number(process.env.MUX_PAIRING_TOKEN_TTL_SEC || 15 * 60);
const pairingTokenMaxTtlSec = Number(process.env.MUX_PAIRING_TOKEN_MAX_TTL_SEC || 60 * 60);
const telegramBotUsername = readNonEmptyString(process.env.MUX_TELEGRAM_BOT_USERNAME);
const pairingSuccessTextOverride = readNonEmptyString(process.env.MUX_PAIRING_SUCCESS_TEXT);
const pairingInvalidTextOverride = readNonEmptyString(process.env.MUX_PAIRING_INVALID_TEXT);
const botControlHelpTextOverride = readNonEmptyString(process.env.MUX_BOT_HELP_TEXT);
const botUnpairSuccessTextOverride = readNonEmptyString(process.env.MUX_BOT_UNPAIR_SUCCESS_TEXT);
const botNotPairedTextOverride = readNonEmptyString(process.env.MUX_BOT_NOT_PAIRED_TEXT);
const botSwitchUsageTextOverride = readNonEmptyString(process.env.MUX_BOT_SWITCH_USAGE_TEXT);
const configuredUnpairedHintText = readNonEmptyString(process.env.MUX_UNPAIRED_HINT_TEXT);
const requestBodyMaxBytes = (() => {
  const parsed = Number(process.env.MUX_MAX_BODY_BYTES || 10 * 1024 * 1024);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10 * 1024 * 1024;
  }
  return Math.trunc(parsed);
})();
const runtimeJwtAudienceMux = "mux-server";
const runtimeJwtAudienceOpenClaw = "openclaw-mux-inbound";
const runtimeTokenTtlSec = 86_400; // 1 day
const inboundTokenTtlSec = 5 * 60; // short-lived, per-delivery
const runtimeJwtSigner = createRuntimeJwtSigner();

let tenantSeeds: TenantSeed[] = [];
try {
  tenantSeeds = resolveTenantSeeds();
} catch (error) {
  console.error(`failed to resolve mux tenants: ${String(error)}`);
  process.exit(1);
}

let pairingCodeSeeds: PairingCodeSeed[] = [];
try {
  pairingCodeSeeds = resolvePairingCodeSeeds();
} catch (error) {
  console.error(`failed to resolve pairing code seeds: ${String(error)}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
initializeDatabase(db);
seedTenants(db, tenantSeeds);
seedPairingCodes(db, pairingCodeSeeds);

const stmtSelectTenantByHash = db.prepare(`
  SELECT id, name
  FROM tenants
  WHERE api_key_hash = ? AND status = 'active'
  LIMIT 1
`);

const stmtSelectTenantById = db.prepare(`
  SELECT id, name
  FROM tenants
  WHERE id = ? AND status = 'active'
  LIMIT 1
`);

const stmtUpsertTenantByRegister = db.prepare(`
  INSERT INTO tenants (
    id,
    name,
    api_key_hash,
    status,
    inbound_url,
    inbound_token,
    inbound_timeout_ms,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, 'active', ?, NULL, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    api_key_hash = excluded.api_key_hash,
    status = 'active',
    inbound_url = excluded.inbound_url,
    inbound_token = NULL,
    inbound_timeout_ms = excluded.inbound_timeout_ms,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtUpsertTenantInboundTargetByAdmin = db.prepare(`
  INSERT INTO tenants (
    id,
    name,
    api_key_hash,
    status,
    inbound_url,
    inbound_token,
    inbound_timeout_ms,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, 'active', ?, NULL, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    status = 'active',
    inbound_url = excluded.inbound_url,
    inbound_token = NULL,
    inbound_timeout_ms = excluded.inbound_timeout_ms,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtSelectTenantInboundTargetById = db.prepare(`
  SELECT inbound_url, inbound_token, inbound_timeout_ms
  FROM tenants
  WHERE id = ? AND status = 'active'
  LIMIT 1
`);

const stmtCountActiveTenantInboundTargets = db.prepare(`
  SELECT COUNT(*) AS count
  FROM tenants
  WHERE status = 'active'
    AND inbound_url IS NOT NULL
    AND TRIM(inbound_url) <> ''
`);

const stmtDeleteExpiredIdempotency = db.prepare(`
  DELETE FROM idempotency_keys
  WHERE expires_at_ms <= ?
`);

const stmtSelectCachedIdempotency = db.prepare(`
  SELECT request_fingerprint, response_status, response_body
  FROM idempotency_keys
  WHERE tenant_id = ? AND key = ? AND expires_at_ms > ?
  LIMIT 1
`);

const stmtUpsertIdempotency = db.prepare(`
  INSERT INTO idempotency_keys (
    tenant_id,
    key,
    request_fingerprint,
    response_status,
    response_body,
    expires_at_ms,
    created_at_ms
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(tenant_id, key) DO UPDATE SET
    request_fingerprint = excluded.request_fingerprint,
    response_status = excluded.response_status,
    response_body = excluded.response_body,
    expires_at_ms = excluded.expires_at_ms
`);

const stmtSelectPairingCodeByCode = db.prepare(`
  SELECT channel, route_key, scope, expires_at_ms, claimed_by_tenant_id
  FROM pairing_codes
  WHERE code = ?
  LIMIT 1
`);

const stmtClaimPairingCode = db.prepare(`
  UPDATE pairing_codes
  SET claimed_by_tenant_id = ?, claimed_at_ms = ?
  WHERE code = ? AND claimed_by_tenant_id IS NULL AND expires_at_ms > ?
`);

const stmtRevertPairingCodeClaim = db.prepare(`
  UPDATE pairing_codes
  SET claimed_by_tenant_id = NULL, claimed_at_ms = NULL
  WHERE code = ? AND claimed_by_tenant_id = ?
`);

const stmtDeleteExpiredPairingTokens = db.prepare(`
  DELETE FROM pairing_tokens
  WHERE expires_at_ms <= ?
`);

const stmtDeactivateStaleDiscordPendingBindings = db.prepare(`
  UPDATE bindings
  SET status = 'inactive', updated_at_ms = ?
  WHERE channel = 'discord'
    AND status = 'pending'
    AND NOT EXISTS (
      SELECT 1
      FROM pairing_tokens pt
      WHERE pt.tenant_id = bindings.tenant_id
        AND pt.channel = 'discord'
        AND pt.consumed_at_ms IS NULL
        AND pt.expires_at_ms > ?
    )
`);

const stmtInsertPairingToken = db.prepare(`
  INSERT INTO pairing_tokens (
    token_hash,
    tenant_id,
    channel,
    session_key,
    created_at_ms,
    expires_at_ms,
    consumed_at_ms,
    consumed_binding_id,
    consumed_route_key
  )
  VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
`);

const stmtSelectActivePairingTokenByHash = db.prepare(`
  SELECT tenant_id, channel, session_key
  FROM pairing_tokens
  WHERE token_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?
  LIMIT 1
`);

const stmtConsumePairingToken = db.prepare(`
  UPDATE pairing_tokens
  SET consumed_at_ms = ?
  WHERE token_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?
`);

const stmtAttachPairingTokenBinding = db.prepare(`
  UPDATE pairing_tokens
  SET consumed_binding_id = ?, consumed_route_key = ?
  WHERE token_hash = ?
`);

const stmtInsertBinding = db.prepare(`
  INSERT INTO bindings (
    binding_id,
    tenant_id,
    channel,
    scope,
    route_key,
    status,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
`);

const stmtInsertPendingBinding = db.prepare(`
  INSERT INTO bindings (
    binding_id,
    tenant_id,
    channel,
    scope,
    route_key,
    status,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
`);

const stmtActivatePendingBinding = db.prepare(`
  UPDATE bindings
  SET status = 'active', updated_at_ms = ?
  WHERE binding_id = ? AND tenant_id = ? AND status = 'pending'
`);

const stmtListActiveBindingsByTenant = db.prepare(`
  SELECT binding_id, channel, scope, route_key
  FROM bindings
  WHERE tenant_id = ? AND status = 'active'
  ORDER BY created_at_ms DESC
`);

const stmtUnbindActiveBinding = db.prepare(`
  UPDATE bindings
  SET status = 'inactive', updated_at_ms = ?
  WHERE binding_id = ? AND tenant_id = ? AND status = 'active'
`);

const stmtDeactivateLiveBinding = db.prepare(`
  UPDATE bindings
  SET status = 'inactive', updated_at_ms = ?
  WHERE binding_id = ? AND tenant_id = ? AND status IN ('active', 'pending')
`);

const stmtSetBindingPending = db.prepare(`
  UPDATE bindings
  SET status = 'pending', updated_at_ms = ?
  WHERE binding_id = ? AND tenant_id = ? AND status IN ('active', 'pending')
`);

const stmtDeleteSessionRoutesByBinding = db.prepare(`
  DELETE FROM session_routes
  WHERE binding_id = ? AND tenant_id = ?
`);

const stmtUpsertSessionRoute = db.prepare(`
  INSERT INTO session_routes (
    tenant_id,
    channel,
    session_key,
    binding_id,
    channel_context_json,
    updated_at_ms
  )
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(tenant_id, channel, session_key) DO UPDATE SET
    binding_id = excluded.binding_id,
    channel_context_json = excluded.channel_context_json,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtResolveSessionRouteBinding = db.prepare(`
  SELECT sr.binding_id, b.route_key, sr.channel_context_json
  FROM session_routes sr
  JOIN bindings b ON b.binding_id = sr.binding_id
  WHERE sr.tenant_id = ?
    AND sr.channel = ?
    AND sr.session_key = ?
    AND b.tenant_id = sr.tenant_id
    AND b.channel = sr.channel
    AND b.status = 'active'
  LIMIT 1
`);

const stmtListSessionRoutesByBinding = db.prepare(`
  SELECT session_key, channel_context_json
  FROM session_routes
  WHERE tenant_id = ? AND channel = ? AND binding_id = ?
  ORDER BY updated_at_ms DESC
`);

const stmtSelectSessionKeyByBinding = db.prepare(`
  SELECT session_key
  FROM session_routes
  WHERE tenant_id = ? AND channel = ? AND binding_id = ?
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const stmtSelectActiveBindingByRouteKey = db.prepare(`
  SELECT tenant_id, binding_id
  FROM bindings
  WHERE channel = ? AND route_key = ? AND status = 'active'
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const stmtSelectLiveBindingByRouteKey = db.prepare(`
  SELECT tenant_id, binding_id, status
  FROM bindings
  WHERE channel = ? AND route_key = ? AND status IN ('active', 'pending')
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const stmtSelectActiveBindingByTenantAndRoute = db.prepare(`
  SELECT binding_id, status
  FROM bindings
  WHERE tenant_id = ? AND channel = ? AND route_key = ? AND status IN ('active', 'pending')
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const stmtListActiveDiscordBindings = db.prepare(`
  SELECT tenant_id, binding_id, route_key, status
  FROM bindings
  WHERE channel = 'discord' AND status IN ('active', 'pending')
  ORDER BY updated_at_ms ASC
`);

const stmtSelectTelegramOffset = db.prepare(`
  SELECT last_update_id
  FROM telegram_offsets
  WHERE id = 1
`);

const stmtUpsertTelegramOffset = db.prepare(`
  INSERT INTO telegram_offsets (id, last_update_id, updated_at_ms)
  VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_update_id = excluded.last_update_id,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtSelectDiscordOffsetByBinding = db.prepare(`
  SELECT last_message_id
  FROM discord_offsets
  WHERE binding_id = ?
  LIMIT 1
`);

const stmtUpsertDiscordOffsetByBinding = db.prepare(`
  INSERT INTO discord_offsets (binding_id, last_message_id, updated_at_ms)
  VALUES (?, ?, ?)
  ON CONFLICT(binding_id) DO UPDATE SET
    last_message_id = excluded.last_message_id,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtInsertWhatsAppInboundQueue = db.prepare(`
  INSERT INTO whatsapp_inbound_queue (
    dedupe_key,
    payload_json,
    next_attempt_at_ms,
    attempt_count,
    last_error,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, 0, NULL, ?, ?)
  ON CONFLICT(dedupe_key) DO NOTHING
`);

const stmtSelectDueWhatsAppInboundQueue = db.prepare(`
  SELECT id, dedupe_key, payload_json, attempt_count
  FROM whatsapp_inbound_queue
  WHERE next_attempt_at_ms <= ?
  ORDER BY id ASC
  LIMIT ?
`);

const stmtDeleteWhatsAppInboundQueueById = db.prepare(`
  DELETE FROM whatsapp_inbound_queue
  WHERE id = ?
`);

const stmtDeferWhatsAppInboundQueueById = db.prepare(`
  UPDATE whatsapp_inbound_queue
  SET
    next_attempt_at_ms = ?,
    attempt_count = ?,
    last_error = ?,
    updated_at_ms = ?
  WHERE id = ?
`);

const stmtInsertAuditLog = db.prepare(`
  INSERT INTO audit_logs (tenant_id, event_type, payload_json, created_at_ms)
  VALUES (?, ?, ?, ?)
`);

const idempotencyInflight = new Map<string, InflightEntry>();
let discordGatewayReady = false;
const discordChannelInfoCache = new Map<
  string,
  {
    guildId: string | null;
    parentId: string | null;
    channelType: number | null;
    expiresAtMs: number;
  }
>();
const discordChannelGuildCacheTtlMs = 30_000;
const discordDmChannelCache = new Map<string, { channelId: string; expiresAtMs: number }>();
const discordDmChannelCacheTtlMs = 10 * 60_000;
let activeWhatsAppListener: ActiveWebListener | null = null;
const whatsappRuntimeHealth: WhatsAppRuntimeHealth = {
  listenerActive: false,
  loopStartedAtMs: null,
  lastListenerStartAtMs: null,
  lastListenerCloseAtMs: null,
  lastListenerCloseStatus: null,
  lastListenerClosedLoggedOut: null,
  lastListenerErrorAtMs: null,
  lastListenerError: null,
  lastInboundSeenAtMs: null,
};

function hashApiKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resolveBearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== "string") {
    return null;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function resolveOpenClawIdHeader(req: IncomingMessage): string | null {
  const raw = req.headers["x-openclaw-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return readNonEmptyString(value);
}

async function verifyRuntimeJwtForMuxApi(token: string): Promise<TenantIdentity | null> {
  const verified = await runtimeJwtSigner.verify({
    token,
    audience: runtimeJwtAudienceMux,
  });
  if (!verified.ok) {
    return null;
  }
  const payload = verified.payload;
  const sub = readNonEmptyString(payload.sub);
  if (!sub) {
    return null;
  }
  const scopeAllowsRuntime =
    hasScope(payload.scope, "mux:runtime") ||
    hasScope(payload.scope, "mux:outbound") ||
    hasScope(payload.scope, "mux:pairings") ||
    hasScope(payload.scope, "mux:control");
  if (!scopeAllowsRuntime) {
    return null;
  }
  const row = stmtSelectTenantById.get(sub) as { id?: unknown; name?: unknown } | undefined;
  if (!row) {
    return null;
  }
  const id = typeof row.id === "string" ? row.id : "";
  if (!id) {
    return null;
  }
  const name = typeof row.name === "string" && row.name.trim() ? row.name : id;
  return {
    id,
    name,
    authKind: "runtime-jwt",
    authToken: token,
  };
}

async function resolveTenantIdentity(req: IncomingMessage): Promise<TenantIdentity | null> {
  const token = resolveBearerToken(req.headers.authorization);
  if (!token) {
    return null;
  }
  const runtimeIdentity = await verifyRuntimeJwtForMuxApi(token);
  if (runtimeIdentity) {
    const headerOpenClawId = resolveOpenClawIdHeader(req);
    if (!headerOpenClawId || headerOpenClawId !== runtimeIdentity.id) {
      return null;
    }
    return runtimeIdentity;
  }
  const row = stmtSelectTenantByHash.get(hashApiKey(token)) as
    | { id?: unknown; name?: unknown }
    | undefined;
  if (!row) {
    return null;
  }
  const id = typeof row.id === "string" ? row.id : "";
  if (!id) {
    return null;
  }
  const name = typeof row.name === "string" && row.name.trim() ? row.name : id;
  return { id, name, authKind: "api-key", authToken: token };
}

function isAdminAuthorized(req: IncomingMessage): boolean {
  if (!muxAdminToken) {
    return false;
  }
  const token = resolveBearerToken(req.headers.authorization);
  return Boolean(token && token === muxAdminToken);
}

function isRegisterAuthorized(req: IncomingMessage): boolean {
  if (!muxRegisterKey) {
    return false;
  }
  const token = resolveBearerToken(req.headers.authorization);
  return Boolean(token && token === muxRegisterKey);
}

function resolveTenantInboundTarget(tenantId: string): TenantInboundTarget | null {
  const row = stmtSelectTenantInboundTargetById.get(tenantId) as
    | {
        inbound_url?: unknown;
        inbound_timeout_ms?: unknown;
      }
    | undefined;
  const url = readNonEmptyString(row?.inbound_url);
  if (!url) {
    return null;
  }
  const timeoutMs = readPositiveInt(row?.inbound_timeout_ms) ?? 15_000;
  return {
    url,
    timeoutMs,
    openclawId: tenantId,
  };
}

function resolveLiveBindingByRouteKey(
  channel: string,
  routeKey: string,
): LiveBindingLookupRow | null {
  const row = stmtSelectLiveBindingByRouteKey.get(channel, routeKey) as
    | LiveBindingLookupRow
    | undefined;
  if (!row?.tenant_id || !row?.binding_id || !row?.status) {
    return null;
  }
  return {
    tenant_id: String(row.tenant_id),
    binding_id: String(row.binding_id),
    status: String(row.status),
  };
}

function isRouteBoundByAnotherTenant(params: {
  channel: string;
  routeKey: string;
  tenantId: string;
}): boolean {
  const row = resolveLiveBindingByRouteKey(params.channel, params.routeKey);
  return Boolean(row && row.tenant_id !== params.tenantId);
}

function isSqliteUniqueConstraintError(error: unknown): boolean {
  const text = String(error);
  return text.includes("SQLITE_CONSTRAINT") && text.includes("UNIQUE");
}

function countActiveTenantInboundTargets(): number {
  const row = stmtCountActiveTenantInboundTargets.get() as { count?: unknown } | undefined;
  const count = Number(row?.count);
  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }
  return Math.trunc(count);
}

async function mintRuntimeJwt(params: {
  openclawId: string;
  scope: string;
  audiences: string[];
  ttlSec?: number;
  nowMs?: number;
}): Promise<string> {
  return await runtimeJwtSigner.mint({
    subject: params.openclawId,
    audiences: params.audiences,
    scope: params.scope,
    ttlSec: Math.max(1, Math.trunc(params.ttlSec ?? runtimeTokenTtlSec)),
    nowMs: params.nowMs,
  });
}

async function buildInboundAuthHeaders(
  target: TenantInboundTarget,
): Promise<Record<string, string>> {
  const runtimeJwt = await mintRuntimeJwt({
    openclawId: target.openclawId,
    scope: "mux:inbound",
    audiences: [runtimeJwtAudienceOpenClaw],
    ttlSec: inboundTokenTtlSec,
  });
  return {
    Authorization: `Bearer ${runtimeJwt}`,
    "X-OpenClaw-Id": target.openclawId,
  };
}

function resolveTenantSeeds(): TenantSeed[] {
  const raw = process.env.MUX_TENANTS_JSON?.trim();
  if (!raw) {
    const apiKey = readNonEmptyString(process.env.MUX_API_KEY);
    if (apiKey) {
      const inboundUrl = readNonEmptyString(process.env.MUX_OPENCLAW_INBOUND_URL) ?? undefined;
      const inboundTimeoutMs =
        readPositiveInt(process.env.MUX_OPENCLAW_INBOUND_TIMEOUT_MS) ?? 15_000;
      return [
        {
          id: "tenant-default",
          name: "default",
          apiKey,
          inboundUrl,
          inboundTimeoutMs,
        },
      ];
    }

    // Instance-centric mode: tenants are created via POST /v1/instances/register.
    if (muxRegisterKey) {
      return [];
    }

    throw new Error("Set MUX_API_KEY, MUX_TENANTS_JSON, or MUX_REGISTER_KEY");
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("MUX_TENANTS_JSON must be a non-empty JSON array");
  }

  const seeds: TenantSeed[] = [];
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();

  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw new Error("each tenant in MUX_TENANTS_JSON must be an object");
    }
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const apiKey = typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
    const name =
      typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : id;
    const inboundUrl =
      typeof candidate.inboundUrl === "string" && candidate.inboundUrl.trim()
        ? candidate.inboundUrl.trim()
        : undefined;
    const inboundTimeoutMs =
      typeof candidate.inboundTimeoutMs === "number" &&
      Number.isFinite(candidate.inboundTimeoutMs) &&
      candidate.inboundTimeoutMs > 0
        ? Math.trunc(candidate.inboundTimeoutMs)
        : 15_000;

    if (!id) {
      throw new Error("tenant.id is required");
    }
    if (!apiKey) {
      throw new Error(`tenant.apiKey is required for tenant ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`duplicate tenant.id: ${id}`);
    }
    const keyHash = hashApiKey(apiKey);
    if (seenHashes.has(keyHash)) {
      throw new Error(`duplicate tenant.apiKey detected for tenant ${id}`);
    }

    seenIds.add(id);
    seenHashes.add(keyHash);
    seeds.push({ id, name, apiKey, inboundUrl, inboundTimeoutMs });
  }

  return seeds;
}

function resolvePairingCodeSeeds(): PairingCodeSeed[] {
  const raw = process.env.MUX_PAIRING_CODES_JSON?.trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("MUX_PAIRING_CODES_JSON must be a JSON array");
  }

  const now = Date.now();
  const seeds: PairingCodeSeed[] = [];
  const seenCodes = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw new Error("each pairing code entry must be an object");
    }
    const candidate = item as Record<string, unknown>;
    const code = typeof candidate.code === "string" ? candidate.code.trim() : "";
    const channel = typeof candidate.channel === "string" ? candidate.channel.trim() : "";
    const routeKey = typeof candidate.routeKey === "string" ? candidate.routeKey.trim() : "";
    const scope = typeof candidate.scope === "string" ? candidate.scope.trim() : "";
    const expiresAtMs =
      typeof candidate.expiresAtMs === "number" &&
      Number.isFinite(candidate.expiresAtMs) &&
      candidate.expiresAtMs > 0
        ? Math.trunc(candidate.expiresAtMs)
        : now + 24 * 60 * 60 * 1000;

    if (!code) {
      throw new Error("pairing code entry requires code");
    }
    if (!channel) {
      throw new Error(`pairing code ${code} requires channel`);
    }
    if (!routeKey) {
      throw new Error(`pairing code ${code} requires routeKey`);
    }
    if (!scope) {
      throw new Error(`pairing code ${code} requires scope`);
    }
    if (seenCodes.has(code)) {
      throw new Error(`duplicate pairing code seed: ${code}`);
    }

    seenCodes.add(code);
    seeds.push({ code, channel, routeKey, scope, expiresAtMs });
  }

  return seeds;
}

function initializeDatabase(database: DatabaseSync) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      inbound_url TEXT,
      inbound_token TEXT,
      inbound_timeout_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      route_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      claimed_by_tenant_id TEXT,
      claimed_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pairing_codes_expires ON pairing_codes(expires_at_ms);

    CREATE TABLE IF NOT EXISTS pairing_tokens (
      token_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      session_key TEXT,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER,
      consumed_binding_id TEXT,
      consumed_route_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pairing_tokens_tenant_channel
      ON pairing_tokens(tenant_id, channel, expires_at_ms);

    CREATE TABLE IF NOT EXISTS bindings (
      binding_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      scope TEXT NOT NULL,
      route_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bindings_tenant_channel ON bindings(tenant_id, channel);
    CREATE INDEX IF NOT EXISTS idx_bindings_channel_route_status
      ON bindings(channel, route_key, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_channel_route_live_unique
      ON bindings(channel, route_key)
      WHERE status IN ('active', 'pending');

    CREATE TABLE IF NOT EXISTS session_routes (
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      session_key TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      channel_context_json TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, channel, session_key)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at_ms);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created
      ON audit_logs(tenant_id, created_at_ms);

    CREATE TABLE IF NOT EXISTS telegram_offsets (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_update_id INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discord_offsets (
      binding_id TEXT PRIMARY KEY,
      last_message_id TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_inbound_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      next_attempt_at_ms INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_queue_next_attempt
      ON whatsapp_inbound_queue(next_attempt_at_ms, id);
  `);
  ensureTenantInboundTargetColumns(database);
  ensurePairingTokenColumns(database);
}

function ensureTenantInboundTargetColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(tenants)").all() as Array<{ name?: unknown }>;
  const columnNames = new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")));
  if (!columnNames.has("inbound_url")) {
    database.exec("ALTER TABLE tenants ADD COLUMN inbound_url TEXT");
  }
  if (!columnNames.has("inbound_token")) {
    database.exec("ALTER TABLE tenants ADD COLUMN inbound_token TEXT");
  }
  if (!columnNames.has("inbound_timeout_ms")) {
    database.exec("ALTER TABLE tenants ADD COLUMN inbound_timeout_ms INTEGER");
  }
}

function ensurePairingTokenColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(pairing_tokens)").all() as Array<{
    name?: unknown;
  }>;
  const columnNames = new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")));
  if (!columnNames.has("consumed_binding_id")) {
    database.exec("ALTER TABLE pairing_tokens ADD COLUMN consumed_binding_id TEXT");
  }
  if (!columnNames.has("consumed_route_key")) {
    database.exec("ALTER TABLE pairing_tokens ADD COLUMN consumed_route_key TEXT");
  }
}

function seedTenants(database: DatabaseSync, tenants: TenantSeed[]) {
  const now = Date.now();
  const upsert = database.prepare(`
    INSERT INTO tenants (
      id,
      name,
      api_key_hash,
      status,
      inbound_url,
      inbound_token,
      inbound_timeout_ms,
      created_at_ms,
      updated_at_ms
    )
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      api_key_hash = excluded.api_key_hash,
      status = 'active',
      inbound_url = COALESCE(tenants.inbound_url, excluded.inbound_url),
      inbound_token = COALESCE(tenants.inbound_token, excluded.inbound_token),
      inbound_timeout_ms = COALESCE(tenants.inbound_timeout_ms, excluded.inbound_timeout_ms),
      updated_at_ms = excluded.updated_at_ms
  `);
  for (const tenant of tenants) {
    upsert.run(
      tenant.id,
      tenant.name,
      hashApiKey(tenant.apiKey),
      tenant.inboundUrl ?? null,
      tenant.apiKey,
      tenant.inboundTimeoutMs,
      now,
      now,
    );
  }
}

function seedPairingCodes(database: DatabaseSync, codes: PairingCodeSeed[]) {
  if (codes.length === 0) {
    return;
  }
  const insert = database.prepare(`
    INSERT INTO pairing_codes (
      code,
      channel,
      route_key,
      scope,
      expires_at_ms,
      claimed_by_tenant_id,
      claimed_at_ms
    )
    VALUES (?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(code) DO NOTHING
  `);
  for (const code of codes) {
    insert.run(code.code, code.channel, code.routeKey, code.scope, code.expiresAtMs);
  }
}

function log(entry: Record<string, unknown>) {
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): string {
  const bodyText = JSON.stringify(payload);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(bodyText);
  return bodyText;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function getWhatsAppCredentialHealth() {
  const authDir = whatsappAuthDir;
  const credsPath = path.join(authDir, "creds.json");
  const authDirExists = fs.existsSync(authDir);
  const credsPresent = fs.existsSync(credsPath);
  const fileCounts = {
    session: 0,
    senderKey: 0,
    preKey: 0,
    deviceList: 0,
    lidMapping: 0,
  };
  let scanError: string | null = null;

  if (authDirExists) {
    try {
      for (const entry of fs.readdirSync(authDir)) {
        if (entry.startsWith("session-")) {
          fileCounts.session += 1;
          continue;
        }
        if (entry.startsWith("sender-key-")) {
          fileCounts.senderKey += 1;
          continue;
        }
        if (entry.startsWith("pre-key-")) {
          fileCounts.preKey += 1;
          continue;
        }
        if (entry.startsWith("device-list-")) {
          fileCounts.deviceList += 1;
          continue;
        }
        if (entry.startsWith("lid-mapping-")) {
          fileCounts.lidMapping += 1;
        }
      }
    } catch (error) {
      scanError = String(error);
    }
  }

  let credsStat: { present: boolean; sizeBytes?: number; mtimeMs?: number } = {
    present: credsPresent,
  };
  let credsMeId: string | null = null;
  if (credsPresent) {
    try {
      const stat = fs.statSync(credsPath);
      credsStat = {
        present: true,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      const parsedCreds = JSON.parse(fs.readFileSync(credsPath, "utf8")) as {
        me?: { id?: unknown };
      };
      if (typeof parsedCreds.me?.id === "string" && parsedCreds.me.id.trim() !== "") {
        credsMeId = parsedCreds.me.id.trim();
      }
    } catch {
      credsStat = { present: true };
    }
  }

  let status = "disabled";
  if (whatsappInboundEnabled) {
    if (!authDirExists || !credsPresent) {
      status = "missing_credentials";
    } else if (whatsappRuntimeHealth.listenerActive) {
      status = "listening";
    } else if (whatsappRuntimeHealth.lastListenerErrorAtMs) {
      status = "listener_error";
    } else {
      status = "starting_or_idle";
    }
  }

  return {
    status,
    inboundEnabled: whatsappInboundEnabled,
    accountId: whatsappAccountId,
    openclawAccountId: openclawMuxAccountId,
    authDir,
    authDirExists,
    credsPath,
    creds: credsStat,
    credsMeId,
    fileCounts,
    runtime: {
      listenerActive: whatsappRuntimeHealth.listenerActive,
      loopStartedAtMs: whatsappRuntimeHealth.loopStartedAtMs,
      lastListenerStartAtMs: whatsappRuntimeHealth.lastListenerStartAtMs,
      lastListenerCloseAtMs: whatsappRuntimeHealth.lastListenerCloseAtMs,
      lastListenerCloseStatus: whatsappRuntimeHealth.lastListenerCloseStatus,
      lastListenerClosedLoggedOut: whatsappRuntimeHealth.lastListenerClosedLoggedOut,
      lastListenerErrorAtMs: whatsappRuntimeHealth.lastListenerErrorAtMs,
      lastListenerError: whatsappRuntimeHealth.lastListenerError,
      lastInboundSeenAtMs: whatsappRuntimeHealth.lastInboundSeenAtMs,
    },
    ...(scanError ? { scanError } : {}),
  };
}

function readUnsignedNumericString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

class HttpBodyError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpBodyError";
  }
}

async function readBody<T extends object>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += chunkBuffer.length;
    if (totalBytes > requestBodyMaxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunkBuffer);
  }
  if (tooLarge) {
    throw new HttpBodyError(413, "payload too large");
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {} as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpBodyError(400, "invalid JSON body");
  }
}

function requireTelegramBotToken(): string {
  const token = telegramBotToken?.trim();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for telegram transport");
  }
  return token;
}

function requireDiscordBotToken(): string {
  const token = discordBotToken?.trim();
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required for discord transport");
  }
  return token;
}

async function sendTelegram(
  method:
    | "sendMessage"
    | "sendPhoto"
    | "sendChatAction"
    | "editMessageText"
    | "answerCallbackQuery",
  body: Record<string, unknown>,
) {
  const token = requireTelegramBotToken();
  const response = await fetch(`${telegramApiBaseUrl}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  return { response, result };
}

function parseDiscordJsonBody(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw: trimmed };
  }
}

async function discordRequest(params: {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}): Promise<{ response: Response; result: Record<string, unknown> }> {
  const token = requireDiscordBotToken();
  const response = await fetch(`${discordApiBaseUrl}${params.path}`, {
    method: params.method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
  });
  const result = parseDiscordJsonBody(await response.text());
  return { response, result };
}

function parseDiscordGatewayPayload(raw: WebSocket.RawData): Record<string, unknown> | null {
  let text: string | null = null;
  if (typeof raw === "string") {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString("utf8");
  } else if (Array.isArray(raw)) {
    text = Buffer.concat(raw).toString("utf8");
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString("utf8");
  }
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

async function fetchDiscordGatewayUrl(): Promise<string> {
  const { response, result } = await discordRequest({
    method: "GET",
    path: "/gateway/bot",
  });
  if (!response.ok) {
    throw new Error(`discord gateway discovery failed (${response.status})`);
  }
  const rawUrl = readNonEmptyString(result.url) ?? "wss://gateway.discord.gg";
  const base = rawUrl.replace(/\/+$/, "");
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}v=10&encoding=json`;
}

async function resolveDiscordDmChannelId(userId: string): Promise<string> {
  const { response, result } = await discordRequest({
    method: "POST",
    path: "/users/@me/channels",
    body: { recipient_id: userId },
  });
  if (!response.ok) {
    throw new Error(`discord create dm failed (${response.status})`);
  }
  const channelId = readUnsignedNumericString(result.id);
  if (!channelId) {
    throw new Error("discord create dm returned invalid channel id");
  }
  return channelId;
}

async function resolveDiscordDmChannelIdCached(userId: string): Promise<string> {
  const now = Date.now();
  const cached = discordDmChannelCache.get(userId);
  if (cached && cached.expiresAtMs > now) {
    return cached.channelId;
  }
  const channelId = await resolveDiscordDmChannelId(userId);
  discordDmChannelCache.set(userId, {
    channelId,
    expiresAtMs: now + discordDmChannelCacheTtlMs,
  });
  return channelId;
}

async function resolveDiscordChannelInfo(channelId: string): Promise<{
  guildId: string | null;
  parentId: string | null;
  channelType: number | null;
}> {
  const now = Date.now();
  const cached = discordChannelInfoCache.get(channelId);
  if (cached && cached.expiresAtMs > now) {
    return {
      guildId: cached.guildId,
      parentId: cached.parentId,
      channelType: cached.channelType,
    };
  }
  const { response, result } = await discordRequest({
    method: "GET",
    path: `/channels/${channelId}`,
  });
  if (!response.ok) {
    throw new Error(`discord channel lookup failed (${response.status})`);
  }
  const guildId = readUnsignedNumericString(result.guild_id) ?? null;
  const parentId = readUnsignedNumericString(result.parent_id) ?? null;
  const channelType =
    typeof result.type === "number" && Number.isFinite(result.type)
      ? Math.trunc(result.type)
      : null;
  discordChannelInfoCache.set(channelId, {
    guildId,
    parentId,
    channelType,
    expiresAtMs: now + discordChannelGuildCacheTtlMs,
  });
  return { guildId, parentId, channelType };
}

async function resolveDiscordChannelGuildId(channelId: string): Promise<string | null> {
  const info = await resolveDiscordChannelInfo(channelId);
  return info.guildId;
}

async function resolveDiscordIncomingRouteFromMessage(params: {
  message: Record<string, unknown>;
  fromId: string;
  fallbackRoute?: DiscordBoundRoute;
  fallbackChannelId?: string;
}): Promise<{ route: DiscordBoundRoute; channelId: string } | null> {
  const channelId =
    readUnsignedNumericString(params.message.channel_id) ??
    readUnsignedNumericString(params.fallbackChannelId);
  if (!channelId) {
    return null;
  }
  const guildId = readUnsignedNumericString(params.message.guild_id);
  if (!guildId) {
    return {
      route: { kind: "dm", userId: params.fromId },
      channelId,
    };
  }

  if (
    params.fallbackRoute?.kind === "guild" &&
    params.fallbackRoute.threadId &&
    params.fallbackRoute.threadId === channelId
  ) {
    return {
      route: params.fallbackRoute,
      channelId,
    };
  }

  const rawThread = asRecord(params.message.thread);
  const threadIdFromPayload = readUnsignedNumericString(rawThread?.id);
  const threadParentIdFromPayload = readUnsignedNumericString(rawThread?.parent_id);
  if (threadIdFromPayload && threadIdFromPayload === channelId) {
    return {
      route: {
        kind: "guild",
        guildId,
        ...(threadParentIdFromPayload ? { channelId: threadParentIdFromPayload } : {}),
        threadId: threadIdFromPayload,
      },
      channelId,
    };
  }

  const channelInfo = await resolveDiscordChannelInfo(channelId);
  if (channelInfo.parentId) {
    return {
      route: {
        kind: "guild",
        guildId,
        channelId: channelInfo.parentId,
        threadId: channelId,
      },
      channelId,
    };
  }

  return {
    route: {
      kind: "guild",
      guildId,
      channelId,
    },
    channelId,
  };
}

function listDiscordRouteLookupKeys(route: DiscordBoundRoute): string[] {
  const keys: string[] = [];
  if (route.kind === "dm") {
    keys.push(buildDiscordDmRouteKey(route.userId));
    return keys;
  }
  if (route.threadId) {
    keys.push(
      buildDiscordGuildRouteKey({
        guildId: route.guildId,
        ...(route.channelId ? { channelId: route.channelId } : {}),
        threadId: route.threadId,
      }),
    );
    keys.push(
      buildDiscordGuildRouteKey({
        guildId: route.guildId,
        threadId: route.threadId,
      }),
    );
  }
  if (route.channelId) {
    keys.push(
      buildDiscordGuildRouteKey({
        guildId: route.guildId,
        channelId: route.channelId,
      }),
    );
  }
  keys.push(buildDiscordGuildRouteKey({ guildId: route.guildId }));
  return [...new Set(keys)];
}

function resolveDiscordBindingForIncoming(
  route: DiscordBoundRoute,
): { tenantId: string; bindingId: string; status: "active" | "pending"; routeKey: string } | null {
  const routeKeys = listDiscordRouteLookupKeys(route);
  for (const routeKey of routeKeys) {
    const row = resolveLiveBindingByRouteKey("discord", routeKey);
    if (!row) {
      continue;
    }
    return {
      tenantId: row.tenant_id,
      bindingId: row.binding_id,
      status: row.status === "pending" ? "pending" : "active",
      routeKey,
    };
  }
  return null;
}

async function sendDiscordTyping(params: {
  channelId: string;
}): Promise<{ response: Response; result: Record<string, unknown> }> {
  return await discordRequest({
    method: "POST",
    path: `/channels/${params.channelId}/typing`,
  });
}

function parseSnowflake(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    try {
      return BigInt(Math.trunc(value));
    } catch {
      return null;
    }
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

function sortDiscordMessagesAsc(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.toSorted((a, b) => {
    const aId = parseSnowflake(a.id);
    const bId = parseSnowflake(b.id);
    if (aId === null && bId === null) {
      return 0;
    }
    if (aId === null) {
      return -1;
    }
    if (bId === null) {
      return 1;
    }
    if (aId < bId) {
      return -1;
    }
    if (aId > bId) {
      return 1;
    }
    return 0;
  });
}

function listDiscordAttachmentCandidates(
  attachments: unknown,
): Array<{ id?: string; fileName?: string; mimeType?: string; url?: string; size?: number }> {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .map((item) => {
      const entry = item as Record<string, unknown>;
      return {
        id: readUnsignedNumericString(entry.id),
        fileName: readNonEmptyString(entry.filename) ?? undefined,
        mimeType: readNonEmptyString(entry.content_type)?.toLowerCase() ?? undefined,
        url: readNonEmptyString(entry.url) ?? undefined,
        size: readPositiveInt(entry.size),
      };
    })
    .filter((entry) => Boolean(entry.url));
}

async function extractDiscordInboundMedia(params: {
  message: Record<string, unknown>;
  messageId: string;
}): Promise<{ attachments: DiscordInboundAttachment[]; media: DiscordInboundMediaSummary[] }> {
  const summaries: DiscordInboundMediaSummary[] = [];
  const attachments: DiscordInboundAttachment[] = [];
  for (const item of listDiscordAttachmentCandidates(params.message.attachments)) {
    summaries.push({
      id: item.id,
      fileName: item.fileName,
      mimeType: item.mimeType,
      size: item.size,
      url: item.url,
    });
    if (!item.url) {
      continue;
    }
    const resolvedMime =
      item.mimeType ||
      inferMimeTypeFromPath(item.fileName ?? item.url) ||
      "application/octet-stream";
    attachments.push({
      type: resolvedMime.split("/")[0] || "file",
      mimeType: resolvedMime,
      fileName: item.fileName || item.id || `discord-${params.messageId}`,
      url: item.url,
    });
  }
  return { attachments, media: summaries };
}

function purgeExpiredIdempotency(now: number) {
  stmtDeleteExpiredIdempotency.run(now);
}

function resolveInflightKey(tenantId: string, idempotencyKey: string): string {
  return `${tenantId}:${idempotencyKey}`;
}

function loadCachedIdempotency(params: {
  tenantId: string;
  idempotencyKey: string;
  fingerprint: string;
  now: number;
}): SendResult | "mismatch" | null {
  const row = stmtSelectCachedIdempotency.get(params.tenantId, params.idempotencyKey, params.now) as
    | CachedIdempotencyRow
    | undefined;
  if (!row) {
    return null;
  }
  if (row.request_fingerprint !== params.fingerprint) {
    return "mismatch";
  }
  return {
    statusCode: Number(row.response_status),
    bodyText: String(row.response_body),
  };
}

function storeIdempotency(params: {
  tenantId: string;
  idempotencyKey: string;
  fingerprint: string;
  result: SendResult;
  now: number;
}) {
  stmtUpsertIdempotency.run(
    params.tenantId,
    params.idempotencyKey,
    params.fingerprint,
    params.result.statusCode,
    params.result.bodyText,
    params.now + idempotencyTtlMs,
    params.now,
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTtlSec(ttlSec: number): number {
  const safeDefault = Math.max(1, Math.trunc(pairingTokenTtlSec));
  const safeMax = Math.max(safeDefault, Math.trunc(pairingTokenMaxTtlSec));
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    return safeDefault;
  }
  return Math.min(Math.max(1, Math.trunc(ttlSec)), safeMax);
}

function generatePairingToken(): string {
  return `mpt_${randomBytes(24).toString("base64url")}`;
}

function hashPairingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function purgeExpiredPairingTokens(nowMs: number) {
  stmtDeleteExpiredPairingTokens.run(nowMs);
  if (discordPendingGcEnabled) {
    stmtDeactivateStaleDiscordPendingBindings.run(nowMs, nowMs);
  }
}

function runTokenClaimTransaction<T>(claim: () => T | null): T | null {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = claim();
    if (result === null) {
      db.exec("ROLLBACK");
      return null;
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures if transaction already closed.
    }
    throw error;
  }
}

function issuePairingTokenForTenant(params: {
  tenant: TenantIdentity;
  channel: string;
  sessionKey?: string;
  ttlSec?: number;
}) {
  if (
    params.channel !== "telegram" &&
    params.channel !== "discord" &&
    params.channel !== "whatsapp"
  ) {
    return {
      statusCode: 400,
      payload: { ok: false, error: "unsupported channel for token pairing" },
    };
  }

  const nowMs = Date.now();
  purgeExpiredPairingTokens(nowMs);
  const ttlSec = normalizeTtlSec(params.ttlSec ?? pairingTokenTtlSec);
  const token = generatePairingToken();
  const tokenHash = hashPairingToken(token);
  const expiresAtMs = nowMs + ttlSec * 1_000;
  const sessionKey = readNonEmptyString(params.sessionKey);

  if (params.channel === "discord" && !discordGatewayDmEnabled && !discordGatewayGuildEnabled) {
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: "discord token pairing requires gateway inbound enabled",
      },
    };
  }

  stmtInsertPairingToken.run(
    tokenHash,
    params.tenant.id,
    params.channel,
    sessionKey,
    nowMs,
    expiresAtMs,
  );

  const deepLink =
    params.channel === "telegram" && telegramBotUsername
      ? `https://t.me/${telegramBotUsername}?start=${encodeURIComponent(token)}`
      : null;

  writeAuditLog(
    params.tenant.id,
    "pairing_token_issued",
    {
      channel: params.channel,
      expiresAtMs,
      hasSessionKey: Boolean(sessionKey),
    },
    nowMs,
  );

  return {
    statusCode: 200,
    payload: {
      ok: true,
      channel: params.channel,
      token,
      expiresAtMs,
      startCommand: params.channel === "telegram" ? `/start ${token}` : null,
      deepLink,
    },
  };
}

function extractTokenFromStartCommand(input: string): string | null {
  const match = input.match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }
  return readNonEmptyString(match[1]);
}

function normalizeControlText(input: string | null): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBotControlCommand(input: string | null): BotControlCommand | null {
  const normalized = normalizeControlText(input);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(
    /^[/!](bot_help|bot_status|bot_unpair|bot_switch)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/i,
  );
  if (!match?.[1]) {
    return null;
  }
  const command = match[1].toLowerCase();
  if (command === "bot_help") {
    return { kind: "help" };
  }
  if (command === "bot_status") {
    return { kind: "status" };
  }
  if (command === "bot_unpair") {
    return { kind: "unpair" };
  }
  const arg = normalizeControlText(match[2] ?? null);
  const token = extractPairingTokenFromText(arg);
  return { kind: "switch", ...(token ? { token } : {}) };
}

function escapeTelegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function styleBold(channel: NoticeChannel, text: string): string {
  if (channel === "telegram") {
    return `<b>${escapeTelegramHtml(text)}</b>`;
  }
  return `**${text}**`;
}

function styleCode(channel: NoticeChannel, text: string): string {
  if (channel === "telegram") {
    return `<code>${escapeTelegramHtml(text)}</code>`;
  }
  return `\`${text}\``;
}

function styleText(channel: NoticeChannel, text: string): string {
  return channel === "telegram" ? escapeTelegramHtml(text) : text;
}

function buildStyledNotice(channel: NoticeChannel, lines: string[]): StyledNotice {
  if (channel === "telegram") {
    return { text: lines.join("\n"), parseMode: "HTML" };
  }
  return { text: lines.join("\n") };
}

function renderPairingSuccessNotice(channel: NoticeChannel): StyledNotice {
  if (pairingSuccessTextOverride) {
    return { text: pairingSuccessTextOverride };
  }
  return buildStyledNotice(channel, [
    styleBold(channel, "Paired successfully"),
    "",
    "You can chat now.",
  ]);
}

function renderPairingInvalidNotice(channel: NoticeChannel): StyledNotice {
  if (pairingInvalidTextOverride) {
    return { text: pairingInvalidTextOverride };
  }
  return buildStyledNotice(channel, [
    styleBold(channel, "Pairing link is invalid or expired"),
    "",
    "Request a new link from your dashboard.",
  ]);
}

function renderBotHelpNotice(channel: NoticeChannel): StyledNotice {
  if (botControlHelpTextOverride) {
    return { text: botControlHelpTextOverride };
  }
  const command = (value: string): string =>
    channel === "telegram" ? styleText(channel, value) : styleCode(channel, value);
  return buildStyledNotice(channel, [
    styleBold(channel, "Bot control commands"),
    "",
    `• ${command("/bot_help")} - Show bot control help.`,
    `• ${command("/bot_status")} - Show current pairing status.`,
    `• ${command("/bot_unpair")} - Unlink this chat from OpenClaw.`,
    `• ${command("/bot_switch <token>")} - Switch this chat to another OpenClaw.`,
    "",
    `After pairing, ${command("/help")} is provided by your OpenClaw instance.`,
  ]);
}

function renderBotUnpairSuccessNotice(channel: NoticeChannel): StyledNotice {
  if (botUnpairSuccessTextOverride) {
    return { text: botUnpairSuccessTextOverride };
  }
  return buildStyledNotice(channel, [
    styleBold(channel, "Unpaired successfully"),
    "",
    `Use ${styleCode(channel, "/bot_switch <token>")} to pair again.`,
  ]);
}

function renderBotNotPairedNotice(channel: NoticeChannel): StyledNotice {
  if (botNotPairedTextOverride) {
    return { text: botNotPairedTextOverride };
  }
  return buildStyledNotice(channel, [
    styleBold(channel, "This chat is not paired yet"),
    "",
    `Use ${styleCode(channel, "/bot_switch <token>")} to pair this chat.`,
  ]);
}

function renderBotSwitchUsageNotice(channel: NoticeChannel): StyledNotice {
  if (botSwitchUsageTextOverride) {
    return { text: botSwitchUsageTextOverride };
  }
  return buildStyledNotice(channel, [
    `Usage: ${styleCode(channel, "/bot_switch <pairing-token>")}`,
  ]);
}

function renderUnpairedHintNotice(channel: NoticeChannel): StyledNotice {
  if (configuredUnpairedHintText) {
    return { text: configuredUnpairedHintText };
  }
  const stepThree =
    channel === "telegram"
      ? `3) Send the token here (or use ${styleCode(channel, "/start <token>")}).`
      : "3) Send the token in this chat.";
  return buildStyledNotice(channel, [
    styleBold(channel, "OpenClaw: this chat is not paired yet"),
    "",
    styleBold(channel, "Pairing steps"),
    "1) Open your dashboard.",
    "2) Generate a pairing link/token for this channel.",
    stepThree,
    "",
    `After pairing, ${styleCode(channel, "/help")} is provided by your OpenClaw instance.`,
  ]);
}

function extractPairingTokenFromTelegramMessage(message: TelegramIncomingMessage): string | null {
  const rawText = typeof message.text === "string" ? message.text : undefined;
  const rawCaption = typeof message.caption === "string" ? message.caption : undefined;
  const text = normalizeControlText(rawText ?? rawCaption ?? null);
  if (text === null) {
    return null;
  }
  const fromStart = extractTokenFromStartCommand(text);
  if (fromStart && /^mpt_[A-Za-z0-9_-]{20,200}$/.test(fromStart)) {
    return fromStart;
  }
  const direct = text.match(/\b(mpt_[A-Za-z0-9_-]{20,200})\b/);
  return direct?.[1] ?? null;
}

function isTelegramCommandText(input: string | null): boolean {
  const normalized = normalizeControlText(input);
  if (!normalized) {
    return false;
  }
  return /^\/[A-Za-z0-9_]+/.test(normalized);
}

function hasTelegramMessageContent(message: TelegramIncomingMessage): boolean {
  if (normalizeControlText(message.text ?? message.caption ?? null)) {
    return true;
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    return true;
  }
  return Boolean(message.document || message.video || message.animation);
}

function extractPairingTokenFromText(input: string | null): string | null {
  const normalized = normalizeControlText(input);
  if (!normalized) {
    return null;
  }
  const direct = normalized.match(/\b(mpt_[A-Za-z0-9_-]{20,200})\b/);
  return direct?.[1] ?? null;
}

function extractPairingTokenFromDiscordMessage(message: Record<string, unknown>): string | null {
  const text = typeof message.content === "string" ? message.content : null;
  return extractPairingTokenFromText(text);
}

function extractPairingTokenFromWhatsAppMessage(message: WebInboundMessage): string | null {
  const text = typeof message.body === "string" ? message.body : null;
  return extractPairingTokenFromText(text);
}

function isDiscordCommandText(input: string): boolean {
  const normalized = normalizeControlText(input);
  if (!normalized) {
    return false;
  }
  return /^\/[A-Za-z0-9_]+/.test(normalized);
}

function hasDiscordMessageContent(message: Record<string, unknown>): boolean {
  const text = typeof message.content === "string" ? message.content : null;
  if (normalizeControlText(text)) {
    return true;
  }
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.some((attachment) => Boolean(attachment && typeof attachment === "object"))) {
    return true;
  }
  const snapshots = Array.isArray(message.message_snapshots) ? message.message_snapshots : [];
  return snapshots.length > 0;
}

function isWhatsAppCommandText(input: string): boolean {
  const normalized = normalizeControlText(input);
  if (!normalized) {
    return false;
  }
  return /^[/!][A-Za-z0-9_]+/.test(normalized);
}

function hasWhatsAppMessageContent(message: WebInboundMessage): boolean {
  if (normalizeControlText(message.body)) {
    return true;
  }
  return Boolean(
    readNonEmptyString(message.mediaPath) ||
    readNonEmptyString(message.mediaType) ||
    readNonEmptyString(message.mediaUrl),
  );
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".weba": "audio/webm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

function inferMimeTypeFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const ext = path.extname(filePath).toLowerCase();
  return ext ? MIME_BY_EXT[ext] : undefined;
}

function pickBestTelegramPhotoSize(
  sizes: TelegramPhotoSize[] | undefined,
): TelegramPhotoSize | null {
  if (!Array.isArray(sizes) || sizes.length === 0) {
    return null;
  }
  const candidates = sizes.filter((entry) => readNonEmptyString(entry.file_id));
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => {
    const aSize = readPositiveInt(a.file_size) ?? 0;
    const bSize = readPositiveInt(b.file_size) ?? 0;
    if (aSize !== bSize) {
      return bSize - aSize;
    }
    const aArea = (readPositiveInt(a.width) ?? 0) * (readPositiveInt(a.height) ?? 0);
    const bArea = (readPositiveInt(b.width) ?? 0) * (readPositiveInt(b.height) ?? 0);
    return bArea - aArea;
  });
  return candidates[0] ?? null;
}

async function resolveTelegramFilePath(fileId: string): Promise<string | null> {
  const token = requireTelegramBotToken();
  const response = await fetch(`${telegramApiBaseUrl}/bot${token}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!response.ok) {
    return null;
  }
  const result = (await response.json()) as {
    ok?: boolean;
    result?: { file_path?: unknown } | null;
  };
  if (result.ok !== true) {
    return null;
  }
  return readNonEmptyString(result.result?.file_path);
}

async function resolveTelegramAttachment(params: {
  updateId: number;
  kind: string;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSec?: number;
}): Promise<{ attachment?: TelegramInboundAttachment; summary: TelegramInboundMediaSummary }> {
  const summary: TelegramInboundMediaSummary = {
    kind: params.kind,
    fileId: params.fileId,
    fileName: params.fileName,
    mimeType: params.mimeType,
    fileSize: params.fileSize,
    width: params.width,
    height: params.height,
    durationSec: params.durationSec,
  };
  const inferredMime =
    inferMimeTypeFromPath(params.fileName) ?? inferMimeTypeFromPath(params.fileName);
  const resolvedMime = params.mimeType || inferredMime;
  summary.mimeType = resolvedMime || summary.mimeType;
  summary.fileName =
    summary.fileName || (params.fileId ? `${params.kind}-${params.fileId}` : undefined);
  const proxyUrl = `${muxPublicUrl}/v1/mux/files/telegram?fileId=${encodeURIComponent(params.fileId)}`;
  const attachment: TelegramInboundAttachment = {
    type: resolvedMime?.split("/")[0] || "file",
    mimeType: resolvedMime || "application/octet-stream",
    fileName: summary.fileName,
    url: proxyUrl,
  };
  return { attachment, summary };
}

async function extractTelegramInboundMedia(params: {
  message: TelegramIncomingMessage;
  updateId: number;
}): Promise<{ attachments: TelegramInboundAttachment[]; media: TelegramInboundMediaSummary[] }> {
  const attachments: TelegramInboundAttachment[] = [];
  const media: TelegramInboundMediaSummary[] = [];

  const bestPhoto = pickBestTelegramPhotoSize(params.message.photo);
  const photoFileId = readNonEmptyString(bestPhoto?.file_id);
  if (photoFileId) {
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "photo",
      fileId: photoFileId,
      mimeType: "image/jpeg",
      fileSize: readPositiveInt(bestPhoto?.file_size),
      width: readPositiveInt(bestPhoto?.width),
      height: readPositiveInt(bestPhoto?.height),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const document = params.message.document;
  const docFileId = readNonEmptyString(document?.file_id);
  const docMimeType = readNonEmptyString(document?.mime_type)?.toLowerCase();
  const docFileName = readNonEmptyString(document?.file_name);
  if (docFileId) {
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "document",
      fileId: docFileId,
      fileName: docFileName ?? undefined,
      mimeType: docMimeType ?? inferMimeTypeFromPath(docFileName ?? undefined),
      fileSize: readPositiveInt(document?.file_size),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const video = params.message.video;
  const videoFileId = readNonEmptyString(video?.file_id);
  if (videoFileId) {
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "video",
      fileId: videoFileId,
      fileName: readNonEmptyString(video?.file_name) ?? undefined,
      mimeType: readNonEmptyString(video?.mime_type)?.toLowerCase() ?? undefined,
      fileSize: readPositiveInt(video?.file_size),
      width: readPositiveInt(video?.width),
      height: readPositiveInt(video?.height),
      durationSec: readPositiveInt(video?.duration),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const animation = params.message.animation;
  const animationFileId = readNonEmptyString(animation?.file_id);
  if (animationFileId) {
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "animation",
      fileId: animationFileId,
      fileName: readNonEmptyString(animation?.file_name) ?? undefined,
      mimeType: readNonEmptyString(animation?.mime_type)?.toLowerCase() ?? undefined,
      fileSize: readPositiveInt(animation?.file_size),
      width: readPositiveInt(animation?.width),
      height: readPositiveInt(animation?.height),
      durationSec: readPositiveInt(animation?.duration),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  return { attachments, media };
}

async function sendTelegramPairingNotice(params: {
  chatId: string;
  topicId?: number;
  text: string;
  parseMode?: TelegramParseMode;
}) {
  const body: Record<string, unknown> = {
    chat_id: params.chatId,
    text: params.text,
  };
  if (params.parseMode) {
    body.parse_mode = params.parseMode;
  }
  if (params.topicId) {
    body.message_thread_id = params.topicId;
  }
  const { response, result } = await sendTelegram("sendMessage", body);
  if (!response.ok || result.ok !== true) {
    throw new Error(`telegram pairing notice failed (${response.status})`);
  }
}

async function answerTelegramCallbackQuery(params: {
  callbackQueryId: string;
  text?: string;
}): Promise<void> {
  const body: Record<string, unknown> = {
    callback_query_id: params.callbackQueryId,
  };
  const text = readNonEmptyString(params.text);
  if (text) {
    body.text = text;
  }
  const { response, result } = await sendTelegram("answerCallbackQuery", body);
  if (!response.ok || result.ok !== true) {
    throw new Error(`telegram answerCallbackQuery failed (${response.status})`);
  }
}

async function extractWhatsAppInboundMedia(params: {
  message: WebInboundMessage;
}): Promise<{ attachments: WhatsAppInboundAttachment[]; media: WhatsAppInboundMediaSummary[] }> {
  const attachments: WhatsAppInboundAttachment[] = [];
  const media: WhatsAppInboundMediaSummary[] = [];
  const mediaPath = readNonEmptyString(params.message.mediaPath) ?? undefined;
  const mediaType = readNonEmptyString(params.message.mediaType)?.toLowerCase() ?? undefined;
  if (!mediaPath) {
    return { attachments, media };
  }

  const summary: WhatsAppInboundMediaSummary = {
    mediaPath,
    mediaType,
  };
  let sizeBytes: number | undefined;
  try {
    const stat = fs.statSync(mediaPath);
    if (stat.isFile() && Number.isFinite(stat.size) && stat.size > 0) {
      sizeBytes = Math.trunc(stat.size);
      summary.sizeBytes = sizeBytes;
    }
  } catch (error) {
    log({
      type: "whatsapp_media_stat_error",
      mediaPath,
      error: String(error),
    });
  }
  media.push(summary);

  const resolvedMime = mediaType || inferMimeTypeFromPath(mediaPath) || "application/octet-stream";
  const proxyUrl = `${muxPublicUrl}/v1/mux/files/whatsapp?path=${encodeURIComponent(mediaPath)}`;
  attachments.push({
    type: resolvedMime.split("/")[0] || "file",
    mimeType: resolvedMime,
    fileName: path.basename(mediaPath),
    url: proxyUrl,
  });
  return { attachments, media };
}

async function sendWhatsAppPairingNotice(params: {
  chatJid: string;
  accountId: string;
  text: string;
}) {
  const { sendMessageWhatsApp } = await loadWebRuntimeModules();
  await sendMessageWhatsApp(params.chatJid, params.text, {
    verbose: false,
    accountId: params.accountId,
  });
}

function normalizeChannel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value.trim().toLowerCase();
}

function parseTelegramRouteKey(routeKey: string): TelegramBoundRoute | null {
  const match = routeKey.match(/^telegram:[^:]+:chat:([^:]+)(?::topic:([^:]+))?$/);
  if (!match) {
    return null;
  }
  const chatId = match[1]?.trim();
  if (!chatId) {
    return null;
  }
  const topicId = readPositiveInt(match[2]);
  return topicId ? { chatId, topicId } : { chatId };
}

function readRouteKeyFromSessionContext(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    return readNonEmptyString(record?.routeKey) ?? null;
  } catch {
    return null;
  }
}

function resolveBoundRouteKeyFromSession(row: SessionRouteBindingRow): string {
  return readRouteKeyFromSessionContext(row.channel_context_json) ?? String(row.route_key);
}

function resolveSessionKeyForBindingRoute(params: {
  tenantId: string;
  channel: "telegram" | "discord" | "whatsapp";
  bindingId: string;
  routeKey: string;
}): string | null {
  const rows = stmtListSessionRoutesByBinding.all(
    params.tenantId,
    params.channel,
    params.bindingId,
  ) as SessionRouteByBindingRow[];
  for (const row of rows) {
    const sessionKey = readNonEmptyString(row.session_key);
    if (!sessionKey) {
      continue;
    }
    const routeKey = readRouteKeyFromSessionContext(row.channel_context_json);
    if (routeKey === params.routeKey) {
      return sessionKey;
    }
  }
  return null;
}

function resolveLatestSessionKeyForBinding(params: {
  tenantId: string;
  channel: "telegram" | "discord" | "whatsapp";
  bindingId: string;
}): string | null {
  const row = stmtSelectSessionKeyByBinding.get(
    params.tenantId,
    params.channel,
    params.bindingId,
  ) as { session_key?: unknown } | undefined;
  return readNonEmptyString(row?.session_key);
}

function buildThreadScopedSessionKey(
  baseSessionKey: string,
  chatId: string,
  topicId: number,
): string {
  const normalizedBase = baseSessionKey.trim().replace(/:(thread|topic):[^:]+$/i, "");
  return chatId.startsWith("-")
    ? `${normalizedBase}:topic:${topicId}`
    : `${normalizedBase}:thread:${topicId}`;
}

function resolveTelegramInboundSessionKey(params: {
  tenantId: string;
  bindingId: string;
  chatId: string;
  topicId?: number;
}): string {
  const incomingRouteKey = buildTelegramRouteKey(params.chatId, params.topicId);
  const exactSessionKey = resolveSessionKeyForBindingRoute({
    tenantId: params.tenantId,
    channel: "telegram",
    bindingId: params.bindingId,
    routeKey: incomingRouteKey,
  });
  if (exactSessionKey) {
    return exactSessionKey;
  }

  if (params.topicId) {
    const chatRouteKey = buildTelegramRouteKey(params.chatId);
    const chatSessionKey =
      resolveSessionKeyForBindingRoute({
        tenantId: params.tenantId,
        channel: "telegram",
        bindingId: params.bindingId,
        routeKey: chatRouteKey,
      }) ??
      resolveLatestSessionKeyForBinding({
        tenantId: params.tenantId,
        channel: "telegram",
        bindingId: params.bindingId,
      }) ??
      deriveTelegramSessionKey(params.chatId);
    return buildThreadScopedSessionKey(chatSessionKey, params.chatId, params.topicId);
  }

  const chatRouteKey = buildTelegramRouteKey(params.chatId);
  return (
    resolveSessionKeyForBindingRoute({
      tenantId: params.tenantId,
      channel: "telegram",
      bindingId: params.bindingId,
      routeKey: chatRouteKey,
    }) ??
    resolveLatestSessionKeyForBinding({
      tenantId: params.tenantId,
      channel: "telegram",
      bindingId: params.bindingId,
    }) ??
    deriveTelegramSessionKey(params.chatId)
  );
}

function parseDiscordRouteKey(routeKey: string): DiscordBoundRoute | null {
  const dmMatch = routeKey.match(/^discord:[^:]+:dm:user:(\d+)$/);
  if (dmMatch?.[1]) {
    return { kind: "dm", userId: dmMatch[1] };
  }
  const guildMatch = routeKey.match(
    /^discord:[^:]+:guild:(\d+)(?::channel:(\d+))?(?::thread:(\d+))?$/,
  );
  if (!guildMatch?.[1]) {
    return null;
  }
  const guildId = guildMatch[1];
  const channelId = guildMatch[2];
  const threadId = guildMatch[3];
  return {
    kind: "guild",
    guildId,
    ...(channelId ? { channelId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function buildDiscordGuildRouteKey(params: {
  guildId: string;
  channelId?: string;
  threadId?: string;
}): string {
  const base = `discord:default:guild:${params.guildId}`;
  if (params.channelId && params.threadId) {
    return `${base}:channel:${params.channelId}:thread:${params.threadId}`;
  }
  if (params.threadId) {
    return `${base}:thread:${params.threadId}`;
  }
  if (params.channelId) {
    return `${base}:channel:${params.channelId}`;
  }
  return base;
}

function buildDiscordDmRouteKey(userId: string): string {
  return `discord:default:dm:user:${userId}`;
}

function buildDiscordRouteKey(route: DiscordBoundRoute): string {
  if (route.kind === "dm") {
    return buildDiscordDmRouteKey(route.userId);
  }
  return buildDiscordGuildRouteKey({
    guildId: route.guildId,
    ...(route.channelId ? { channelId: route.channelId } : {}),
    ...(route.threadId ? { threadId: route.threadId } : {}),
  });
}

function normalizeDiscordSessionAgentId(agentId: string | null | undefined): string {
  const trimmed = readNonEmptyString(agentId);
  return trimmed ? trimmed.toLowerCase() : "main";
}

function resolveDiscordSessionAgentIdFromKey(sessionKey: string | null | undefined): string {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return "main";
  }
  const match = trimmed.match(/^agent:([^:]+):/i);
  return normalizeDiscordSessionAgentId(match?.[1] ?? null);
}

function buildDiscordDirectSessionKey(userId: string, agentId = "main"): string {
  return `agent:${normalizeDiscordSessionAgentId(agentId)}:discord:direct:${userId}`;
}

function buildDiscordChannelSessionKey(channelId: string, agentId = "main"): string {
  return `agent:${normalizeDiscordSessionAgentId(agentId)}:discord:channel:${channelId}`;
}

function buildDiscordThreadScopedSessionKey(baseSessionKey: string, threadId: string): string {
  return buildDiscordChannelSessionKey(
    threadId,
    resolveDiscordSessionAgentIdFromKey(baseSessionKey),
  );
}

function resolveDiscordBindingRouteKeyForClaim(params: {
  incomingRoute: DiscordBoundRoute;
}): string {
  if (
    params.incomingRoute.kind === "guild" &&
    params.incomingRoute.threadId &&
    params.incomingRoute.channelId
  ) {
    return buildDiscordGuildRouteKey({
      guildId: params.incomingRoute.guildId,
      channelId: params.incomingRoute.channelId,
    });
  }
  return buildDiscordRouteKey(params.incomingRoute);
}

function resolveDiscordBindingScope(route: DiscordBoundRoute): string {
  if (route.kind === "dm") {
    return "dm";
  }
  if (route.threadId) {
    return "thread";
  }
  if (route.channelId) {
    return "channel";
  }
  return "guild";
}

function resolveDiscordInboundSessionKey(params: {
  tenantId: string;
  bindingId: string;
  route: DiscordBoundRoute;
  channelId: string;
}): string {
  const incomingRouteKey = buildDiscordRouteKey(params.route);
  const exactSessionKey = resolveSessionKeyForBindingRoute({
    tenantId: params.tenantId,
    channel: "discord",
    bindingId: params.bindingId,
    routeKey: incomingRouteKey,
  });
  if (exactSessionKey) {
    return exactSessionKey;
  }

  if (params.route.kind === "guild" && params.route.threadId) {
    const anchorRouteKey = params.route.channelId
      ? buildDiscordGuildRouteKey({
          guildId: params.route.guildId,
          channelId: params.route.channelId,
        })
      : null;
    const anchorSessionKey =
      (anchorRouteKey
        ? resolveSessionKeyForBindingRoute({
            tenantId: params.tenantId,
            channel: "discord",
            bindingId: params.bindingId,
            routeKey: anchorRouteKey,
          })
        : null) ??
      resolveLatestSessionKeyForBinding({
        tenantId: params.tenantId,
        channel: "discord",
        bindingId: params.bindingId,
      }) ??
      deriveDiscordSessionKey({
        route: {
          kind: "guild",
          guildId: params.route.guildId,
          ...(params.route.channelId ? { channelId: params.route.channelId } : {}),
        },
        channelId: params.route.channelId ?? params.channelId,
      });
    return buildDiscordThreadScopedSessionKey(anchorSessionKey, params.route.threadId);
  }

  return deriveDiscordSessionKey({
    route: params.route,
    channelId: params.channelId,
  });
}

function buildWhatsAppRouteKey(chatJid: string, accountId = "default"): string {
  return `whatsapp:${accountId}:chat:${chatJid}`;
}

function parseWhatsAppRouteKey(routeKey: string): WhatsAppBoundRoute | null {
  const match = routeKey.match(/^whatsapp:([^:]+):chat:(.+)$/);
  if (!match?.[1] || !match?.[2]) {
    return null;
  }
  const accountId = match[1].trim();
  const chatJid = match[2].trim();
  if (!accountId || !chatJid) {
    return null;
  }
  return { accountId, chatJid };
}

function normalizeWhatsAppDirectPeerId(value: string | undefined): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) {
    return null;
  }
  const withoutPrefix = raw.replace(/^whatsapp:/i, "").trim();

  const jidMatch = withoutPrefix.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/i);
  if (jidMatch?.[1]) {
    return `+${jidMatch[1]}`;
  }

  const lidMatch = withoutPrefix.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/i);
  if (lidMatch) {
    return null;
  }

  const digits = withoutPrefix.replace(/[^\d+]/g, "");
  if (!digits) {
    return null;
  }
  const normalized = digits.startsWith("+") ? `+${digits.slice(1)}` : `+${digits}`;
  return normalized.length > 1 ? normalized : null;
}

function deriveWhatsAppSessionKey(params: {
  chatJid: string;
  chatType: "direct" | "group";
  directPeerId?: string;
}): string {
  if (params.chatType === "group") {
    return `agent:main:whatsapp:group:${params.chatJid}`;
  }
  const peerId =
    normalizeWhatsAppDirectPeerId(params.directPeerId) ??
    normalizeWhatsAppDirectPeerId(params.chatJid) ??
    readNonEmptyString(params.directPeerId) ??
    params.chatJid;
  return `agent:main:whatsapp:direct:${peerId}`;
}

function parseDiscordOutboundTarget(value: unknown): DiscordOutboundTarget | null {
  const raw = readNonEmptyString(value);
  if (!raw) {
    return null;
  }
  const directChannel = raw.match(/^channel:(\d+)$/i);
  if (directChannel?.[1]) {
    return { kind: "channel", id: directChannel[1] };
  }
  const directUser = raw.match(/^user:(\d+)$/i);
  if (directUser?.[1]) {
    return { kind: "user", id: directUser[1] };
  }
  const discordChannel = raw.match(/^discord:channel:(\d+)$/i);
  if (discordChannel?.[1]) {
    return { kind: "channel", id: discordChannel[1] };
  }
  const discordUser = raw.match(/^discord:user:(\d+)$/i);
  if (discordUser?.[1]) {
    return { kind: "user", id: discordUser[1] };
  }
  const discordLegacy = raw.match(/^discord:(\d+)$/i);
  if (discordLegacy?.[1]) {
    return { kind: "user", id: discordLegacy[1] };
  }
  const userMention = raw.match(/^<@!?(\d+)>$/);
  if (userMention?.[1]) {
    return { kind: "user", id: userMention[1] };
  }
  const channelMention = raw.match(/^<#(\d+)>$/);
  if (channelMention?.[1]) {
    return { kind: "channel", id: channelMention[1] };
  }
  if (/^\d+$/.test(raw)) {
    return { kind: "channel", id: raw };
  }
  return null;
}

function resolveTelegramBoundRoute(params: {
  tenantId: string;
  channel: string;
  sessionKey: string;
}): TelegramBoundRoute | null {
  const row = stmtResolveSessionRouteBinding.get(
    params.tenantId,
    params.channel,
    params.sessionKey,
  ) as SessionRouteBindingRow | undefined;
  if (!row) {
    return null;
  }
  return parseTelegramRouteKey(resolveBoundRouteKeyFromSession(row));
}

function resolveDiscordBoundRoute(params: {
  tenantId: string;
  channel: string;
  sessionKey: string;
}): DiscordBoundRoute | null {
  const row = stmtResolveSessionRouteBinding.get(
    params.tenantId,
    params.channel,
    params.sessionKey,
  ) as SessionRouteBindingRow | undefined;
  if (!row) {
    return null;
  }
  return parseDiscordRouteKey(resolveBoundRouteKeyFromSession(row));
}

function resolveWhatsAppBoundRoute(params: {
  tenantId: string;
  channel: string;
  sessionKey: string;
}): WhatsAppBoundRoute | null {
  const row = stmtResolveSessionRouteBinding.get(
    params.tenantId,
    params.channel,
    params.sessionKey,
  ) as SessionRouteBindingRow | undefined;
  if (!row) {
    return null;
  }
  return parseWhatsAppRouteKey(resolveBoundRouteKeyFromSession(row));
}

async function resolveDiscordOutboundChannelId(params: {
  boundRoute: DiscordBoundRoute;
  requestedTo: unknown;
  requestedThreadId?: string;
}): Promise<{ ok: true; channelId: string } | { ok: false; statusCode: number; error: string }> {
  if (params.boundRoute.kind === "dm") {
    const channelId = await resolveDiscordDmChannelId(params.boundRoute.userId);
    return { ok: true, channelId };
  }

  let channelId =
    params.boundRoute.threadId ?? params.requestedThreadId ?? params.boundRoute.channelId;
  if (!channelId) {
    const target = parseDiscordOutboundTarget(params.requestedTo);
    if (target?.kind === "user") {
      return {
        ok: false,
        statusCode: 403,
        error: "discord route is guild-bound and cannot target DMs",
      };
    }
    channelId = target?.id;
  }
  if (!channelId) {
    return {
      ok: false,
      statusCode: 400,
      error: "discord guild-bound route requires channel target (to or routeKey channel)",
    };
  }

  const guildId = await resolveDiscordChannelGuildId(channelId);
  if (!guildId) {
    return {
      ok: false,
      statusCode: 403,
      error: "discord channel is not in a guild for guild-bound route",
    };
  }
  if (guildId !== params.boundRoute.guildId) {
    return {
      ok: false,
      statusCode: 403,
      error: "discord channel not allowed for this bound guild",
    };
  }
  return { ok: true, channelId };
}

function buildTelegramRouteKey(chatId: string, topicId?: number): string {
  if (topicId) {
    return `telegram:default:chat:${chatId}:topic:${topicId}`;
  }
  return `telegram:default:chat:${chatId}`;
}

function deriveTelegramSessionKey(chatId: string, topicId?: number): string {
  const isGroup = chatId.startsWith("-");
  const base = isGroup
    ? `agent:main:telegram:group:${chatId}`
    : `agent:main:telegram:direct:${chatId}`;
  if (!topicId) {
    return base;
  }
  return isGroup ? `${base}:topic:${topicId}` : `${base}:thread:${topicId}`;
}

function resolveTelegramIncomingTopicId(params: {
  isForum: boolean;
  messageThreadId: unknown;
}): number | undefined {
  const explicitTopicId = readPositiveInt(params.messageThreadId);
  if (explicitTopicId) {
    return explicitTopicId;
  }
  return params.isForum ? TELEGRAM_GENERAL_TOPIC_ID : undefined;
}

function resolveTelegramBindingForIncoming(
  chatId: string,
  topicId?: number,
): { tenantId: string; bindingId: string; routeKey: string } | null {
  const topicRouteKey = topicId ? buildTelegramRouteKey(chatId, topicId) : null;
  if (topicRouteKey) {
    const topicRow = stmtSelectActiveBindingByRouteKey.get("telegram", topicRouteKey) as
      | ActiveBindingLookupRow
      | undefined;
    if (topicRow?.tenant_id && topicRow?.binding_id) {
      return {
        tenantId: String(topicRow.tenant_id),
        bindingId: String(topicRow.binding_id),
        routeKey: topicRouteKey,
      };
    }
  }

  const chatRouteKey = buildTelegramRouteKey(chatId);
  const chatRow = stmtSelectActiveBindingByRouteKey.get("telegram", chatRouteKey) as
    | ActiveBindingLookupRow
    | undefined;
  if (!chatRow?.tenant_id || !chatRow?.binding_id) {
    return null;
  }
  return {
    tenantId: String(chatRow.tenant_id),
    bindingId: String(chatRow.binding_id),
    routeKey: chatRouteKey,
  };
}

function resolveWhatsAppBindingForIncoming(params: {
  chatJid: string;
  accountId: string;
}): { tenantId: string; bindingId: string; routeKey: string } | null {
  const routeKey = buildWhatsAppRouteKey(params.chatJid, params.accountId);
  const row = stmtSelectActiveBindingByRouteKey.get("whatsapp", routeKey) as
    | ActiveBindingLookupRow
    | undefined;
  if (!row?.tenant_id || !row?.binding_id) {
    return null;
  }
  return {
    tenantId: String(row.tenant_id),
    bindingId: String(row.binding_id),
    routeKey,
  };
}

function writeAuditLog(
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
  timestampMs = Date.now(),
) {
  stmtInsertAuditLog.run(tenantId, eventType, JSON.stringify(payload), timestampMs);
}

function deactivateLiveBinding(params: {
  tenantId: string;
  bindingId: string;
  auditEventType: string;
}): boolean {
  const now = Date.now();
  const update = stmtDeactivateLiveBinding.run(now, params.bindingId, params.tenantId);
  if (update.changes === 0) {
    return false;
  }
  stmtDeleteSessionRoutesByBinding.run(params.bindingId, params.tenantId);
  writeAuditLog(params.tenantId, params.auditEventType, { bindingId: params.bindingId }, now);
  return true;
}

function setBindingPending(params: {
  tenantId: string;
  bindingId: string;
  auditEventType: string;
}): boolean {
  const now = Date.now();
  const update = stmtSetBindingPending.run(now, params.bindingId, params.tenantId);
  if (update.changes === 0) {
    return false;
  }
  stmtDeleteSessionRoutesByBinding.run(params.bindingId, params.tenantId);
  writeAuditLog(params.tenantId, params.auditEventType, { bindingId: params.bindingId }, now);
  return true;
}

function resolveBindingSessionKey(params: {
  tenantId: string;
  channel: "telegram" | "discord" | "whatsapp";
  bindingId: string;
}): string | null {
  const row = stmtSelectSessionKeyByBinding.get(
    params.tenantId,
    params.channel,
    params.bindingId,
  ) as { session_key?: unknown } | undefined;
  return readNonEmptyString(row?.session_key);
}

function renderBotStatusNotice(params: {
  channel: NoticeChannel;
  paired: boolean;
  routeKey?: string;
  sessionKey?: string | null;
}): StyledNotice {
  const channelLabel =
    params.channel === "telegram"
      ? "telegram"
      : params.channel === "discord"
        ? "discord"
        : "whatsapp";
  const lines = [
    styleBold(params.channel, "Bot status"),
    `Channel: ${styleText(params.channel, channelLabel)}`,
    `Paired: ${params.paired ? "yes" : "no"}`,
  ];
  const sessionKey = readNonEmptyString(params.sessionKey ?? null);
  if (sessionKey) {
    lines.push(`Session key: ${styleCode(params.channel, sessionKey)}`);
  }
  if (params.routeKey) {
    lines.push(`Route: ${styleCode(params.channel, params.routeKey)}`);
  }
  lines.push(
    params.paired
      ? `Use ${styleCode(params.channel, "/bot_unpair")} to unlink this chat.`
      : `Use ${styleCode(params.channel, "/bot_switch <token>")} to pair this chat.`,
  );
  return buildStyledNotice(params.channel, lines);
}

function peekActivePairingToken(
  token: string,
  channel: "telegram" | "discord" | "whatsapp",
): PairingTokenRow | null {
  const now = Date.now();
  purgeExpiredPairingTokens(now);
  const tokenHash = hashPairingToken(token);
  const row = stmtSelectActivePairingTokenByHash.get(tokenHash, now) as PairingTokenRow | undefined;
  if (!row || String(row.channel) !== channel) {
    return null;
  }
  return row;
}

function claimPairingForTenant(tenant: TenantIdentity, code: string, sessionKey?: string) {
  const now = Date.now();
  const row = stmtSelectPairingCodeByCode.get(code) as PairingCodeRow | undefined;
  if (!row || Number(row.expires_at_ms) <= now) {
    return { statusCode: 404, payload: { ok: false, error: "pairing code not found or expired" } };
  }
  if (row.claimed_by_tenant_id) {
    return { statusCode: 409, payload: { ok: false, error: "pairing code already claimed" } };
  }
  if (
    isRouteBoundByAnotherTenant({
      channel: String(row.channel),
      routeKey: String(row.route_key),
      tenantId: tenant.id,
    })
  ) {
    return { statusCode: 409, payload: { ok: false, error: "route already bound" } };
  }

  const claimResult = stmtClaimPairingCode.run(tenant.id, now, code, now);
  if (claimResult.changes === 0) {
    const postCheck = stmtSelectPairingCodeByCode.get(code) as PairingCodeRow | undefined;
    if (!postCheck || Number(postCheck.expires_at_ms) <= now) {
      return {
        statusCode: 404,
        payload: { ok: false, error: "pairing code not found or expired" },
      };
    }
    return { statusCode: 409, payload: { ok: false, error: "pairing code already claimed" } };
  }

  const bindingId = `bind_${randomUUID()}`;
  try {
    stmtInsertBinding.run(
      bindingId,
      tenant.id,
      String(row.channel),
      String(row.scope),
      String(row.route_key),
      now,
      now,
    );
  } catch (error) {
    if (isSqliteUniqueConstraintError(error)) {
      stmtRevertPairingCodeClaim.run(code, tenant.id);
      return { statusCode: 409, payload: { ok: false, error: "route already bound" } };
    }
    throw error;
  }
  const resolvedSessionKey = readNonEmptyString(sessionKey);
  if (resolvedSessionKey) {
    stmtUpsertSessionRoute.run(
      tenant.id,
      String(row.channel),
      resolvedSessionKey,
      bindingId,
      JSON.stringify({ routeKey: String(row.route_key) }),
      now,
    );
  }
  writeAuditLog(tenant.id, "pairing_claimed", { bindingId, code, routeKey: row.route_key }, now);
  return {
    statusCode: 200,
    payload: {
      bindingId,
      channel: String(row.channel),
      scope: String(row.scope),
      routeKey: String(row.route_key),
      ...(resolvedSessionKey ? { sessionKey: resolvedSessionKey } : {}),
    },
  };
}

function claimTelegramPairingToken(params: {
  token: string;
  chatId: string;
  topicId?: number;
  chatType: "direct" | "group";
}): { tenantId: string; bindingId: string; routeKey: string; sessionKey: string } | null {
  return runTokenClaimTransaction(() => {
    const now = Date.now();
    purgeExpiredPairingTokens(now);
    const tokenHash = hashPairingToken(params.token);
    const row = stmtSelectActivePairingTokenByHash.get(tokenHash, now) as
      | PairingTokenRow
      | undefined;
    if (!row || String(row.channel) !== "telegram") {
      return null;
    }

    const tenantId = String(row.tenant_id);
    const claimRouteKey = buildTelegramRouteKey(params.chatId, params.topicId);
    const boundRouteKey =
      params.chatType === "direct"
        ? buildTelegramRouteKey(params.chatId)
        : buildTelegramRouteKey(params.chatId, params.topicId);
    if (isRouteBoundByAnotherTenant({ channel: "telegram", routeKey: boundRouteKey, tenantId })) {
      return null;
    }

    const existing = stmtSelectActiveBindingByTenantAndRoute.get(
      tenantId,
      "telegram",
      boundRouteKey,
    ) as ExistingBindingRow | undefined;

    const bindingId =
      (existing?.binding_id && String(existing.binding_id)) || `bind_${randomUUID()}`;
    if (!existing?.binding_id) {
      try {
        stmtInsertBinding.run(
          bindingId,
          tenantId,
          "telegram",
          boundRouteKey === claimRouteKey && params.topicId ? "topic" : "chat",
          boundRouteKey,
          now,
          now,
        );
      } catch (error) {
        if (isSqliteUniqueConstraintError(error)) {
          return null;
        }
        throw error;
      }
    }

    const preferredSessionKey = readNonEmptyString(row.session_key);
    const sessionKey =
      params.chatType === "direct" && params.topicId
        ? buildThreadScopedSessionKey(
            preferredSessionKey || deriveTelegramSessionKey(params.chatId),
            params.chatId,
            params.topicId,
          )
        : (preferredSessionKey ?? deriveTelegramSessionKey(params.chatId, params.topicId));
    stmtUpsertSessionRoute.run(
      tenantId,
      "telegram",
      sessionKey,
      bindingId,
      JSON.stringify({ routeKey: claimRouteKey }),
      now,
    );

    const consumeResult = stmtConsumePairingToken.run(now, tokenHash, now);
    if (consumeResult.changes === 0) {
      return null;
    }

    stmtAttachPairingTokenBinding.run(bindingId, boundRouteKey, tokenHash);
    writeAuditLog(tenantId, "pairing_token_claimed", { bindingId, routeKey: boundRouteKey }, now);
    return { tenantId, bindingId, routeKey: boundRouteKey, sessionKey };
  });
}

function claimDiscordPairingToken(params: {
  token: string;
  route: DiscordBoundRoute;
  channelId: string;
}): { tenantId: string; bindingId: string; routeKey: string; sessionKey: string } | null {
  return runTokenClaimTransaction(() => {
    const now = Date.now();
    purgeExpiredPairingTokens(now);
    const tokenHash = hashPairingToken(params.token);
    const row = stmtSelectActivePairingTokenByHash.get(tokenHash, now) as
      | PairingTokenRow
      | undefined;
    if (!row || String(row.channel) !== "discord") {
      return null;
    }
    const tenantId = String(row.tenant_id);
    if (!tenantId) {
      return null;
    }

    const claimRouteKey = buildDiscordRouteKey(params.route);
    const boundRouteKey = resolveDiscordBindingRouteKeyForClaim({
      incomingRoute: params.route,
    });
    const boundRoute = parseDiscordRouteKey(boundRouteKey);
    if (!boundRoute) {
      return null;
    }

    const liveBinding = resolveLiveBindingByRouteKey("discord", boundRouteKey);
    if (liveBinding && liveBinding.tenant_id !== tenantId) {
      stmtDeactivateLiveBinding.run(now, liveBinding.binding_id, liveBinding.tenant_id);
      stmtDeleteSessionRoutesByBinding.run(liveBinding.binding_id, liveBinding.tenant_id);
      writeAuditLog(
        liveBinding.tenant_id,
        "pairing_unbound_by_route_takeover",
        {
          bindingId: liveBinding.binding_id,
          routeKey: boundRouteKey,
          takeoverTenantId: tenantId,
        },
        now,
      );
    }

    const existing = stmtSelectActiveBindingByTenantAndRoute.get(
      tenantId,
      "discord",
      boundRouteKey,
    ) as ExistingBindingRow | undefined;
    if (existing?.status === "active") {
      return null;
    }
    const bindingId =
      (existing?.binding_id && String(existing.binding_id)) || `bind_${randomUUID()}`;
    if (!existing?.binding_id) {
      try {
        stmtInsertPendingBinding.run(
          bindingId,
          tenantId,
          "discord",
          resolveDiscordBindingScope(boundRoute),
          boundRouteKey,
          now,
          now,
        );
      } catch (error) {
        if (isSqliteUniqueConstraintError(error)) {
          return null;
        }
        throw error;
      }
    }

    const activateResult = stmtActivatePendingBinding.run(now, bindingId, tenantId);
    if (activateResult.changes === 0) {
      return null;
    }

    const preferredSessionKey = readNonEmptyString(row.session_key);
    const sessionKey =
      params.route.kind === "guild" && params.route.threadId
        ? buildDiscordThreadScopedSessionKey(
            preferredSessionKey ??
              deriveDiscordSessionKey({
                route:
                  boundRoute.kind === "guild"
                    ? {
                        kind: "guild",
                        guildId: boundRoute.guildId,
                        ...(boundRoute.channelId ? { channelId: boundRoute.channelId } : {}),
                      }
                    : boundRoute,
                channelId:
                  boundRoute.kind === "guild"
                    ? (boundRoute.channelId ??
                      (params.route.kind === "guild"
                        ? (params.route.channelId ?? params.channelId)
                        : params.channelId))
                    : params.channelId,
              }),
            params.route.threadId,
          )
        : (preferredSessionKey ??
          deriveDiscordSessionKey({
            route: params.route,
            channelId: params.channelId,
          }));
    stmtUpsertSessionRoute.run(
      tenantId,
      "discord",
      sessionKey,
      bindingId,
      JSON.stringify({ routeKey: claimRouteKey, channelId: params.channelId }),
      now,
    );

    const consumeResult = stmtConsumePairingToken.run(now, tokenHash, now);
    if (consumeResult.changes === 0) {
      return null;
    }

    stmtAttachPairingTokenBinding.run(bindingId, boundRouteKey, tokenHash);
    writeAuditLog(tenantId, "pairing_token_claimed", { bindingId, routeKey: boundRouteKey }, now);
    return {
      tenantId,
      bindingId,
      routeKey: boundRouteKey,
      sessionKey,
    };
  });
}

function claimWhatsAppPairingToken(params: {
  token: string;
  chatJid: string;
  accountId: string;
  chatType: "direct" | "group";
  directPeerId?: string;
}): { tenantId: string; bindingId: string; routeKey: string; sessionKey: string } | null {
  return runTokenClaimTransaction(() => {
    const now = Date.now();
    purgeExpiredPairingTokens(now);
    const tokenHash = hashPairingToken(params.token);
    const row = stmtSelectActivePairingTokenByHash.get(tokenHash, now) as
      | PairingTokenRow
      | undefined;
    if (!row || String(row.channel) !== "whatsapp") {
      return null;
    }

    const tenantId = String(row.tenant_id);
    const routeKey = buildWhatsAppRouteKey(params.chatJid, params.accountId);
    if (isRouteBoundByAnotherTenant({ channel: "whatsapp", routeKey, tenantId })) {
      return null;
    }

    const existing = stmtSelectActiveBindingByTenantAndRoute.get(tenantId, "whatsapp", routeKey) as
      | ExistingBindingRow
      | undefined;
    const bindingId =
      (existing?.binding_id && String(existing.binding_id)) || `bind_${randomUUID()}`;
    if (!existing?.binding_id) {
      try {
        stmtInsertBinding.run(
          bindingId,
          tenantId,
          "whatsapp",
          params.chatType === "group" ? "group" : "chat",
          routeKey,
          now,
          now,
        );
      } catch (error) {
        if (isSqliteUniqueConstraintError(error)) {
          return null;
        }
        throw error;
      }
    }

    const preferredSessionKey = readNonEmptyString(row.session_key);
    const sessionKey =
      preferredSessionKey ||
      deriveWhatsAppSessionKey({
        chatJid: params.chatJid,
        chatType: params.chatType,
        directPeerId: params.directPeerId,
      });
    stmtUpsertSessionRoute.run(
      tenantId,
      "whatsapp",
      sessionKey,
      bindingId,
      JSON.stringify({
        routeKey,
        accountId: params.accountId,
        chatJid: params.chatJid,
      }),
      now,
    );

    const consumeResult = stmtConsumePairingToken.run(now, tokenHash, now);
    if (consumeResult.changes === 0) {
      return null;
    }

    stmtAttachPairingTokenBinding.run(bindingId, routeKey, tokenHash);
    writeAuditLog(tenantId, "pairing_token_claimed", { bindingId, routeKey }, now);
    return { tenantId, bindingId, routeKey, sessionKey };
  });
}

async function sendDiscordPairingNotice(params: { channelId: string; text: string }) {
  const { response } = await discordRequest({
    method: "POST",
    path: `/channels/${params.channelId}/messages`,
    body: {
      content: params.text,
    },
  });
  if (!response.ok) {
    throw new Error(`discord pairing notice failed (${response.status})`);
  }
}

async function forwardDiscordMessageToTenant(params: {
  tenantId: string;
  bindingId: string;
  routeKey: string;
  route: DiscordBoundRoute;
  channelId: string;
  message: Record<string, unknown>;
  messageId: string;
  fromId: string;
  body: string;
}): Promise<"forwarded" | "ignored" | "deferred"> {
  const target = resolveTenantInboundTarget(params.tenantId);
  if (!target) {
    log({
      type: "discord_inbound_drop_no_target",
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      routeKey: params.routeKey,
    });
    return "deferred";
  }

  const inboundMedia = await extractDiscordInboundMedia({
    message: params.message,
    messageId: params.messageId,
  });

  const sessionKey = resolveDiscordInboundSessionKey({
    tenantId: params.tenantId,
    bindingId: params.bindingId,
    route: params.route,
    channelId: params.channelId,
  });

  stmtUpsertSessionRoute.run(
    params.tenantId,
    "discord",
    sessionKey,
    params.bindingId,
    JSON.stringify({ routeKey: params.routeKey, channelId: params.channelId }),
    Date.now(),
  );

  const timestampMs = (() => {
    const timestampRaw =
      typeof params.message.timestamp === "string" ? Date.parse(params.message.timestamp) : NaN;
    return Number.isFinite(timestampRaw) ? Math.trunc(timestampRaw) : Date.now();
  })();

  const payload = buildDiscordInboundEnvelope({
    messageId: params.messageId,
    sessionKey,
    accountId: openclawMuxAccountId,
    rawBody: params.body,
    fromId: params.fromId,
    channelId: params.channelId,
    guildId: params.route.kind === "guild" ? params.route.guildId : null,
    routeKey: params.routeKey,
    chatType: params.route.kind === "dm" ? "direct" : "group",
    timestampMs,
    threadId: params.route.kind === "guild" ? params.route.threadId : undefined,
    rawMessage: params.message,
    media: inboundMedia.media,
    attachments: inboundMedia.attachments,
  });
  const payloadWithIdentity = {
    ...payload,
    openclawId: params.tenantId,
  };

  let response: Response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers: {
        ...(await buildInboundAuthHeaders(target)),
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payloadWithIdentity),
      signal: AbortSignal.timeout(target.timeoutMs),
    });
  } catch (error) {
    log({
      type: "discord_inbound_retry_deferred",
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      messageId: params.messageId,
      error: String(error),
    });
    return "deferred";
  }
  if (!response.ok) {
    const bodyText = await response.text();
    log({
      type: "discord_inbound_retry_deferred",
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      messageId: params.messageId,
      error: `openclaw inbound failed (${response.status}): ${bodyText || "no body"}`,
    });
    return "deferred";
  }

  log({
    type: "discord_inbound_forwarded",
    tenantId: params.tenantId,
    bindingId: params.bindingId,
    channelId: params.channelId,
    sessionKey,
    messageId: params.messageId,
  });
  return "forwarded";
}

function listPairingsForTenant(tenant: TenantIdentity) {
  const rows = stmtListActiveBindingsByTenant.all(tenant.id) as ActiveBindingRow[];
  return {
    statusCode: 200,
    payload: {
      items: rows.map((row) => ({
        bindingId: String(row.binding_id),
        channel: String(row.channel),
        scope: String(row.scope),
        routeKey: String(row.route_key),
      })),
    },
  };
}

async function registerOpenClawInstance(input: {
  openclawId?: unknown;
  inboundUrl?: unknown;
  inboundTimeoutMs?: unknown;
}): Promise<{
  statusCode: number;
  payload: Record<string, unknown>;
}> {
  const openclawId = readNonEmptyString(input.openclawId);
  const inboundUrl = readNonEmptyString(input.inboundUrl);
  if (!openclawId || !inboundUrl) {
    return {
      statusCode: 400,
      payload: { ok: false, error: "openclawId and inboundUrl are required" },
    };
  }
  const inboundTimeoutMs = readPositiveInt(input.inboundTimeoutMs) ?? 15_000;
  const now = Date.now();
  const syntheticApiKey = `instance:${openclawId}`;
  try {
    stmtUpsertTenantByRegister.run(
      openclawId,
      openclawId,
      hashApiKey(syntheticApiKey),
      inboundUrl,
      inboundTimeoutMs,
      now,
      now,
    );
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: tenants.api_key_hash")) {
      return {
        statusCode: 409,
        payload: { ok: false, error: "instance id conflict" },
      };
    }
    throw error;
  }
  writeAuditLog(openclawId, "instance_registered", { inboundUrl, inboundTimeoutMs }, now);
  const runtimeToken = await mintRuntimeJwt({
    openclawId,
    scope: "mux:runtime mux:outbound mux:pairings mux:control",
    audiences: [runtimeJwtAudienceMux],
  });
  return {
    statusCode: 200,
    payload: {
      ok: true,
      openclawId,
      runtimeToken,
      tokenType: "Bearer",
      expiresAtMs: now + runtimeTokenTtlSec * 1_000,
    },
  };
}

function unbindPairingForTenant(tenant: TenantIdentity, bindingId: string) {
  const now = Date.now();
  const unbindResult = stmtUnbindActiveBinding.run(now, bindingId, tenant.id);
  if (unbindResult.changes === 0) {
    return { statusCode: 404, payload: { ok: false, error: "binding not found" } };
  }

  stmtDeleteSessionRoutesByBinding.run(bindingId, tenant.id);
  writeAuditLog(tenant.id, "pairing_unbound", { bindingId }, now);
  return { statusCode: 200, payload: { ok: true } };
}

function resolveStoredTelegramOffset(): number {
  const row = stmtSelectTelegramOffset.get() as { last_update_id?: unknown } | undefined;
  if (!row || typeof row.last_update_id !== "number" || !Number.isFinite(row.last_update_id)) {
    return 0;
  }
  return Math.trunc(row.last_update_id);
}

function storeTelegramOffset(lastUpdateId: number) {
  stmtUpsertTelegramOffset.run(lastUpdateId, Date.now());
}

function resolveStoredDiscordOffset(bindingId: string): string | null {
  const row = stmtSelectDiscordOffsetByBinding.get(bindingId) as
    | { last_message_id?: unknown }
    | undefined;
  const offset = readUnsignedNumericString(row?.last_message_id);
  return offset ?? null;
}

function storeDiscordOffset(bindingId: string, lastMessageId: string) {
  stmtUpsertDiscordOffsetByBinding.run(bindingId, lastMessageId, Date.now());
}

function computeWhatsAppQueueRetryDelayMs(attemptCount: number): number {
  const base = Math.max(100, Math.trunc(whatsappQueueRetryInitialMs));
  const maxDelay = Math.max(base, Math.trunc(whatsappQueueRetryMaxMs));
  const exp = Math.max(0, Math.min(10, Math.trunc(attemptCount)));
  const delay = base * 2 ** exp;
  return Math.min(maxDelay, delay);
}

function snapshotWhatsAppInboundMessage(message: WebInboundMessage): WebInboundMessage {
  return {
    id: readNonEmptyString(message.id) ?? undefined,
    from: typeof message.from === "string" ? message.from : "",
    to: typeof message.to === "string" ? message.to : "",
    accountId: readNonEmptyString(message.accountId) ?? whatsappAccountId,
    body: typeof message.body === "string" ? message.body : "",
    timestamp:
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? Math.trunc(message.timestamp)
        : undefined,
    chatType: message.chatType === "group" ? "group" : "direct",
    chatId: readNonEmptyString(message.chatId) ?? readNonEmptyString(message.from) ?? "",
    senderJid: readNonEmptyString(message.senderJid) ?? undefined,
    senderE164: readNonEmptyString(message.senderE164) ?? undefined,
    senderName: readNonEmptyString(message.senderName) ?? undefined,
    replyToId: readNonEmptyString(message.replyToId) ?? undefined,
    replyToBody: readNonEmptyString(message.replyToBody) ?? undefined,
    replyToSender: readNonEmptyString(message.replyToSender) ?? undefined,
    replyToSenderJid: readNonEmptyString(message.replyToSenderJid) ?? undefined,
    replyToSenderE164: readNonEmptyString(message.replyToSenderE164) ?? undefined,
    groupSubject: readNonEmptyString(message.groupSubject) ?? undefined,
    groupParticipants: Array.isArray(message.groupParticipants)
      ? message.groupParticipants.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    mentionedJids: Array.isArray(message.mentionedJids)
      ? message.mentionedJids.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    mediaPath: readNonEmptyString(message.mediaPath) ?? undefined,
    mediaType: readNonEmptyString(message.mediaType) ?? undefined,
    mediaUrl: readNonEmptyString(message.mediaUrl) ?? undefined,
  };
}

function enqueueWhatsAppInboundMessage(message: WebInboundMessage): void {
  const snapshot = snapshotWhatsAppInboundMessage(message);
  if (!snapshot.chatId) {
    return;
  }
  const now = Date.now();
  const messageId = readNonEmptyString(snapshot.id);
  const dedupeKey = messageId
    ? `${snapshot.accountId}:${snapshot.chatId}:${messageId}`
    : `${snapshot.accountId}:${snapshot.chatId}:noid:${now}:${randomUUID()}`;
  const insertResult = stmtInsertWhatsAppInboundQueue.run(
    dedupeKey,
    JSON.stringify(snapshot),
    now,
    now,
    now,
  );
  if (insertResult.changes > 0) {
    log({
      type: "whatsapp_inbound_queue_enqueued",
      dedupeKey,
      messageId: snapshot.id ?? null,
      chatJid: snapshot.chatId,
      accountId: snapshot.accountId,
    });
  }
}

function deriveDiscordSessionKey(params: {
  route: DiscordBoundRoute;
  channelId: string;
  agentId?: string;
}): string {
  const agentId = normalizeDiscordSessionAgentId(params.agentId ?? null);
  if (params.route.kind === "dm") {
    return buildDiscordDirectSessionKey(params.route.userId, agentId);
  }
  return buildDiscordChannelSessionKey(
    params.route.threadId ?? params.route.channelId ?? params.channelId,
    agentId,
  );
}

async function resolveDiscordInboundChannelId(route: DiscordBoundRoute): Promise<string | null> {
  if (route.kind === "dm") {
    return await resolveDiscordDmChannelIdCached(route.userId);
  }
  if (route.threadId) {
    return route.threadId;
  }
  if (route.channelId) {
    return route.channelId;
  }
  return null;
}

async function runOutboundAction(params: {
  tenant: TenantIdentity;
  channel: string;
  sessionKey: string;
  action?: string;
}): Promise<SendResult> {
  if (params.action !== "typing") {
    return {
      statusCode: 400,
      bodyText: JSON.stringify({
        ok: false,
        error: "unsupported action",
        action: params.action ?? null,
      }),
    };
  }

  if (params.channel === "telegram") {
    const boundRoute = resolveTelegramBoundRoute({
      tenantId: params.tenant.id,
      channel: params.channel,
      sessionKey: params.sessionKey,
    });
    if (!boundRoute) {
      return {
        statusCode: 403,
        bodyText: JSON.stringify({
          ok: false,
          error: "route not bound",
          code: "ROUTE_NOT_BOUND",
        }),
      };
    }
    const body: Record<string, unknown> = {
      chat_id: boundRoute.chatId,
      action: "typing",
    };
    if (boundRoute.topicId) {
      body.message_thread_id = boundRoute.topicId;
    }
    const { response, result } = await sendTelegram("sendChatAction", body);
    if (!response.ok || result.ok !== true) {
      return {
        statusCode: 502,
        bodyText: JSON.stringify({ ok: false, error: "telegram typing failed", details: result }),
      };
    }
    return {
      statusCode: 200,
      bodyText: JSON.stringify({ ok: true }),
    };
  }

  if (params.channel === "discord") {
    const boundRoute = resolveDiscordBoundRoute({
      tenantId: params.tenant.id,
      channel: params.channel,
      sessionKey: params.sessionKey,
    });
    if (!boundRoute) {
      return {
        statusCode: 403,
        bodyText: JSON.stringify({
          ok: false,
          error: "route not bound",
          code: "ROUTE_NOT_BOUND",
        }),
      };
    }
    const resolvedTarget = await resolveDiscordOutboundChannelId({
      boundRoute,
      requestedTo: undefined,
      requestedThreadId: undefined,
    });
    if (!resolvedTarget.ok) {
      return {
        statusCode: resolvedTarget.statusCode,
        bodyText: JSON.stringify({ ok: false, error: resolvedTarget.error }),
      };
    }
    const { response, result } = await sendDiscordTyping({
      channelId: resolvedTarget.channelId,
    });
    if (!response.ok) {
      return {
        statusCode: 502,
        bodyText: JSON.stringify({ ok: false, error: "discord typing failed", details: result }),
      };
    }
    return {
      statusCode: 200,
      bodyText: JSON.stringify({ ok: true }),
    };
  }

  if (params.channel === "whatsapp") {
    const boundRoute = resolveWhatsAppBoundRoute({
      tenantId: params.tenant.id,
      channel: params.channel,
      sessionKey: params.sessionKey,
    });
    if (!boundRoute) {
      return {
        statusCode: 403,
        bodyText: JSON.stringify({
          ok: false,
          error: "route not bound",
          code: "ROUTE_NOT_BOUND",
        }),
      };
    }
    const { sendTypingWhatsApp } = await loadWebRuntimeModules();
    try {
      await sendTypingWhatsApp(boundRoute.chatJid, {
        accountId: boundRoute.accountId,
      });
    } catch (error) {
      return {
        statusCode: 502,
        bodyText: JSON.stringify({
          ok: false,
          error: "whatsapp typing failed",
          details: String(error),
        }),
      };
    }
    return {
      statusCode: 200,
      bodyText: JSON.stringify({ ok: true }),
    };
  }

  return {
    statusCode: 400,
    bodyText: JSON.stringify({ ok: false, error: "unsupported channel" }),
  };
}

function extractTelegramMessage(update: TelegramUpdate): TelegramIncomingMessage | null {
  const candidate = update.message ?? update.edited_message;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  return candidate;
}

function extractTelegramCallbackQuery(update: TelegramUpdate): TelegramCallbackQuery | null {
  const candidate = update.callback_query;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  return candidate;
}

async function fetchTelegramUpdates(offset: number): Promise<TelegramUpdate[]> {
  const token = requireTelegramBotToken();
  const response = await fetch(`${telegramApiBaseUrl}/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      offset,
      timeout: Math.max(1, Math.trunc(telegramPollTimeoutSec)),
      allowed_updates: ["message", "edited_message", "callback_query"],
    }),
  });
  if (!response.ok) {
    throw new Error(`telegram getUpdates failed (${response.status})`);
  }
  const json = (await response.json()) as { ok?: boolean; result?: unknown };
  if (json.ok !== true || !Array.isArray(json.result)) {
    throw new Error("telegram getUpdates returned invalid payload");
  }
  return json.result as TelegramUpdate[];
}

async function bootstrapTelegramOffsetIfNeeded() {
  if (!telegramBootstrapLatest) {
    return;
  }
  const current = resolveStoredTelegramOffset();
  if (current > 0) {
    return;
  }
  const token = requireTelegramBotToken();
  const response = await fetch(`${telegramApiBaseUrl}/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      timeout: 0,
      limit: 1,
      allowed_updates: ["message", "edited_message", "callback_query"],
    }),
  });
  if (!response.ok) {
    throw new Error(`telegram bootstrap getUpdates failed (${response.status})`);
  }
  const json = (await response.json()) as { ok?: boolean; result?: unknown };
  if (json.ok !== true || !Array.isArray(json.result) || json.result.length === 0) {
    return;
  }
  const lastUpdate = json.result[json.result.length - 1] as TelegramUpdate;
  const updateId =
    typeof lastUpdate.update_id === "number" && Number.isFinite(lastUpdate.update_id)
      ? Math.trunc(lastUpdate.update_id)
      : 0;
  if (updateId > 0) {
    storeTelegramOffset(updateId);
  }
}

async function forwardTelegramCallbackQueryToTenant(params: {
  updateId: number;
  update: TelegramUpdate;
  callbackQuery: TelegramCallbackQuery;
}) {
  const callbackData = readNonEmptyString(params.callbackQuery.data);
  const callbackMessage =
    params.callbackQuery.message && typeof params.callbackQuery.message === "object"
      ? params.callbackQuery.message
      : null;
  const callbackQueryId = readNonEmptyString(params.callbackQuery.id);
  if (!callbackData || !callbackMessage) {
    if (callbackQueryId) {
      try {
        await answerTelegramCallbackQuery({ callbackQueryId });
      } catch (error) {
        log({
          type: "telegram_callback_answer_error",
          updateId: params.updateId,
          error: String(error),
        });
      }
    }
    return;
  }

  const chatId =
    typeof callbackMessage.chat?.id === "number" && Number.isFinite(callbackMessage.chat.id)
      ? String(Math.trunc(callbackMessage.chat.id))
      : "";
  if (!chatId) {
    return;
  }
  const isForum = callbackMessage.chat?.is_forum === true;
  const topicId = resolveTelegramIncomingTopicId({
    isForum,
    messageThreadId: callbackMessage.message_thread_id,
  });
  const binding = resolveTelegramBindingForIncoming(chatId, topicId);
  if (!binding) {
    if (callbackQueryId) {
      try {
        await answerTelegramCallbackQuery({
          callbackQueryId,
          text: "Pairing link is invalid or expired. Request a new link from your dashboard.",
        });
      } catch (error) {
        log({
          type: "telegram_callback_answer_error",
          updateId: params.updateId,
          error: String(error),
        });
      }
    }
    return;
  }

  const target = resolveTenantInboundTarget(binding.tenantId);
  if (!target) {
    log({
      type: "telegram_inbound_drop_no_target",
      tenantId: binding.tenantId,
      updateId: params.updateId,
      routeKey: binding.routeKey,
    });
    throw new Error(`telegram inbound target missing for tenant ${binding.tenantId}`);
  }

  const callbackMessageId =
    typeof callbackMessage.message_id === "number" && Number.isFinite(callbackMessage.message_id)
      ? String(Math.trunc(callbackMessage.message_id))
      : `tg-callback-msg:${params.updateId}`;
  const fromId =
    typeof params.callbackQuery.from?.id === "number" &&
    Number.isFinite(params.callbackQuery.from.id)
      ? String(Math.trunc(params.callbackQuery.from.id))
      : "unknown";
  const timestampMs =
    typeof callbackMessage.date === "number" && Number.isFinite(callbackMessage.date)
      ? Math.trunc(callbackMessage.date) * 1_000
      : Date.now();
  const chatType = callbackMessage.chat?.type === "private" ? "direct" : "group";
  const inboundRouteKey = buildTelegramRouteKey(chatId, topicId);
  const sessionKey = resolveTelegramInboundSessionKey({
    tenantId: binding.tenantId,
    bindingId: binding.bindingId,
    chatId,
    topicId,
  });

  stmtUpsertSessionRoute.run(
    binding.tenantId,
    "telegram",
    sessionKey,
    binding.bindingId,
    JSON.stringify({ routeKey: inboundRouteKey }),
    Date.now(),
  );

  const payload = buildTelegramCallbackInboundEnvelope({
    updateId: params.updateId,
    sessionKey,
    accountId: openclawMuxAccountId,
    rawBody: callbackData,
    fromId,
    chatId,
    topicId,
    chatType,
    messageId: callbackMessageId,
    timestampMs,
    routeKey: inboundRouteKey,
    callbackData,
    callbackQueryId: callbackQueryId ?? undefined,
    rawCallbackQuery: params.callbackQuery,
    rawMessage: callbackMessage,
    rawUpdate: params.update,
  });
  const payloadWithIdentity = {
    ...payload,
    openclawId: binding.tenantId,
  };

  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      ...(await buildInboundAuthHeaders(target)),
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payloadWithIdentity),
    signal: AbortSignal.timeout(target.timeoutMs),
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`openclaw inbound failed (${response.status}): ${bodyText || "no body"}`);
  }

  if (callbackQueryId) {
    try {
      await answerTelegramCallbackQuery({ callbackQueryId });
    } catch (error) {
      log({
        type: "telegram_callback_answer_error",
        updateId: params.updateId,
        error: String(error),
      });
    }
  }

  log({
    type: "telegram_callback_forwarded",
    tenantId: binding.tenantId,
    sessionKey,
    updateId: params.updateId,
    messageId: callbackMessageId,
    callbackData,
  });
}

async function handleTelegramBotControlCommand(params: {
  command: BotControlCommand;
  chatId: string;
  topicId?: number;
  chatType: "direct" | "group";
  binding: { tenantId: string; bindingId: string; routeKey: string } | null;
}) {
  if (params.command.kind === "help") {
    const notice = renderBotHelpNotice("telegram");
    await sendTelegramPairingNotice({
      chatId: params.chatId,
      topicId: params.topicId,
      text: notice.text,
      parseMode: notice.parseMode,
    });
    return;
  }
  if (params.command.kind === "status") {
    const notice = renderBotStatusNotice({
      channel: "telegram",
      paired: Boolean(params.binding),
      routeKey: params.binding?.routeKey,
      sessionKey: params.binding
        ? resolveBindingSessionKey({
            tenantId: params.binding.tenantId,
            channel: "telegram",
            bindingId: params.binding.bindingId,
          })
        : null,
    });
    await sendTelegramPairingNotice({
      chatId: params.chatId,
      topicId: params.topicId,
      text: notice.text,
      parseMode: notice.parseMode,
    });
    return;
  }
  if (params.command.kind === "unpair") {
    if (!params.binding) {
      const notice = renderBotNotPairedNotice("telegram");
      await sendTelegramPairingNotice({
        chatId: params.chatId,
        topicId: params.topicId,
        text: notice.text,
        parseMode: notice.parseMode,
      });
      return;
    }
    const removed = deactivateLiveBinding({
      tenantId: params.binding.tenantId,
      bindingId: params.binding.bindingId,
      auditEventType: "pairing_unbound_by_bot",
    });
    const notice = removed
      ? renderBotUnpairSuccessNotice("telegram")
      : renderBotNotPairedNotice("telegram");
    await sendTelegramPairingNotice({
      chatId: params.chatId,
      topicId: params.topicId,
      text: notice.text,
      parseMode: notice.parseMode,
    });
    return;
  }
  if (!params.command.token) {
    const notice = renderBotSwitchUsageNotice("telegram");
    await sendTelegramPairingNotice({
      chatId: params.chatId,
      topicId: params.topicId,
      text: notice.text,
      parseMode: notice.parseMode,
    });
    return;
  }
  const tokenRow = peekActivePairingToken(params.command.token, "telegram");
  if (!tokenRow) {
    const notice = renderPairingInvalidNotice("telegram");
    await sendTelegramPairingNotice({
      chatId: params.chatId,
      topicId: params.topicId,
      text: notice.text,
      parseMode: notice.parseMode,
    });
    return;
  }
  if (params.binding) {
    deactivateLiveBinding({
      tenantId: params.binding.tenantId,
      bindingId: params.binding.bindingId,
      auditEventType: "pairing_unbound_by_bot_switch",
    });
  }
  const claimed = claimTelegramPairingToken({
    token: params.command.token,
    chatId: params.chatId,
    topicId: params.topicId,
    chatType: params.chatType,
  });
  const notice = claimed
    ? renderPairingSuccessNotice("telegram")
    : renderPairingInvalidNotice("telegram");
  await sendTelegramPairingNotice({
    chatId: params.chatId,
    topicId: params.topicId,
    text: notice.text,
    parseMode: notice.parseMode,
  });
}

async function handleDiscordBotControlCommand(params: {
  command: BotControlCommand;
  channelId: string;
  routeKey: string;
  tenantId: string;
  bindingId: string;
  status: "active" | "pending";
}): Promise<{ routeReset: boolean; pending?: boolean }> {
  if (params.command.kind === "help") {
    const notice = renderBotHelpNotice("discord");
    await sendDiscordPairingNotice({
      channelId: params.channelId,
      text: notice.text,
    });
    return { routeReset: false };
  }
  if (params.command.kind === "status") {
    const notice = renderBotStatusNotice({
      channel: "discord",
      paired: params.status === "active",
      routeKey: params.routeKey,
      sessionKey:
        params.status === "active"
          ? resolveBindingSessionKey({
              tenantId: params.tenantId,
              channel: "discord",
              bindingId: params.bindingId,
            })
          : null,
    });
    await sendDiscordPairingNotice({
      channelId: params.channelId,
      text: notice.text,
    });
    return { routeReset: false };
  }
  if (params.command.kind === "unpair") {
    const removed = setBindingPending({
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      auditEventType: "pairing_unbound_by_bot",
    });
    const notice = removed
      ? renderBotUnpairSuccessNotice("discord")
      : renderBotNotPairedNotice("discord");
    await sendDiscordPairingNotice({
      channelId: params.channelId,
      text: notice.text,
    });
    return { routeReset: false, pending: true };
  }
  if (!params.command.token) {
    const notice = renderBotSwitchUsageNotice("discord");
    await sendDiscordPairingNotice({
      channelId: params.channelId,
      text: notice.text,
    });
    return { routeReset: false };
  }
  const tokenRow = peekActivePairingToken(params.command.token, "discord");
  const route = parseDiscordRouteKey(params.routeKey);
  if (!route || !tokenRow) {
    const notice = renderPairingInvalidNotice("discord");
    await sendDiscordPairingNotice({
      channelId: params.channelId,
      text: notice.text,
    });
    return { routeReset: false };
  }
  deactivateLiveBinding({
    tenantId: params.tenantId,
    bindingId: params.bindingId,
    auditEventType: "pairing_unbound_by_bot_switch",
  });
  const claimed = claimDiscordPairingToken({
    token: params.command.token,
    route,
    channelId: params.channelId,
  });
  const notice = claimed
    ? renderPairingSuccessNotice("discord")
    : renderPairingInvalidNotice("discord");
  await sendDiscordPairingNotice({
    channelId: params.channelId,
    text: notice.text,
  });
  return { routeReset: true, pending: false };
}

async function handleDiscordBotControlCommandUnbound(params: {
  command: BotControlCommand;
  channelId: string;
  routeKey: string;
}): Promise<void> {
  if (params.command.kind === "help") {
    const notice = renderBotHelpNotice("discord");
    await sendDiscordPairingNotice({
      channelId: params.channelId,
      text: notice.text,
    });
    return;
  }
  if (params.command.kind === "status") {
    const notice = renderBotStatusNotice({
      channel: "discord",
      paired: false,
      routeKey: params.routeKey,
      sessionKey: null,
    });
    await sendDiscordPairingNotice({
      channelId: params.channelId,
      text: notice.text,
    });
    return;
  }
  if (params.command.kind === "unpair") {
    const notice = renderBotNotPairedNotice("discord");
    await sendDiscordPairingNotice({
      channelId: params.channelId,
      text: notice.text,
    });
    return;
  }
  if (!params.command.token) {
    const notice = renderBotSwitchUsageNotice("discord");
    await sendDiscordPairingNotice({
      channelId: params.channelId,
      text: notice.text,
    });
    return;
  }
  const tokenRow = peekActivePairingToken(params.command.token, "discord");
  const route = parseDiscordRouteKey(params.routeKey);
  if (!route || !tokenRow) {
    const notice = renderPairingInvalidNotice("discord");
    await sendDiscordPairingNotice({
      channelId: params.channelId,
      text: notice.text,
    });
    return;
  }
  const claimed = claimDiscordPairingToken({
    token: params.command.token,
    route,
    channelId: params.channelId,
  });
  const notice = claimed
    ? renderPairingSuccessNotice("discord")
    : renderPairingInvalidNotice("discord");
  await sendDiscordPairingNotice({
    channelId: params.channelId,
    text: notice.text,
  });
}

async function handleWhatsAppBotControlCommand(params: {
  command: BotControlCommand;
  chatJid: string;
  accountId: string;
  chatType: "direct" | "group";
  directPeerId?: string;
  binding: { tenantId: string; bindingId: string; routeKey: string } | null;
}) {
  if (params.command.kind === "help") {
    const notice = renderBotHelpNotice("whatsapp");
    await sendWhatsAppPairingNotice({
      chatJid: params.chatJid,
      accountId: params.accountId,
      text: notice.text,
    });
    return;
  }
  if (params.command.kind === "status") {
    const notice = renderBotStatusNotice({
      channel: "whatsapp",
      paired: Boolean(params.binding),
      routeKey: params.binding?.routeKey,
      sessionKey: params.binding
        ? resolveBindingSessionKey({
            tenantId: params.binding.tenantId,
            channel: "whatsapp",
            bindingId: params.binding.bindingId,
          })
        : null,
    });
    await sendWhatsAppPairingNotice({
      chatJid: params.chatJid,
      accountId: params.accountId,
      text: notice.text,
    });
    return;
  }
  if (params.command.kind === "unpair") {
    if (!params.binding) {
      const notice = renderBotNotPairedNotice("whatsapp");
      await sendWhatsAppPairingNotice({
        chatJid: params.chatJid,
        accountId: params.accountId,
        text: notice.text,
      });
      return;
    }
    const removed = deactivateLiveBinding({
      tenantId: params.binding.tenantId,
      bindingId: params.binding.bindingId,
      auditEventType: "pairing_unbound_by_bot",
    });
    const notice = removed
      ? renderBotUnpairSuccessNotice("whatsapp")
      : renderBotNotPairedNotice("whatsapp");
    await sendWhatsAppPairingNotice({
      chatJid: params.chatJid,
      accountId: params.accountId,
      text: notice.text,
    });
    return;
  }
  if (!params.command.token) {
    const notice = renderBotSwitchUsageNotice("whatsapp");
    await sendWhatsAppPairingNotice({
      chatJid: params.chatJid,
      accountId: params.accountId,
      text: notice.text,
    });
    return;
  }
  const tokenRow = peekActivePairingToken(params.command.token, "whatsapp");
  if (!tokenRow) {
    const notice = renderPairingInvalidNotice("whatsapp");
    await sendWhatsAppPairingNotice({
      chatJid: params.chatJid,
      accountId: params.accountId,
      text: notice.text,
    });
    return;
  }
  if (params.binding) {
    deactivateLiveBinding({
      tenantId: params.binding.tenantId,
      bindingId: params.binding.bindingId,
      auditEventType: "pairing_unbound_by_bot_switch",
    });
  }
  const claimed = claimWhatsAppPairingToken({
    token: params.command.token,
    chatJid: params.chatJid,
    accountId: params.accountId,
    chatType: params.chatType,
    directPeerId: params.directPeerId,
  });
  const notice = claimed
    ? renderPairingSuccessNotice("whatsapp")
    : renderPairingInvalidNotice("whatsapp");
  await sendWhatsAppPairingNotice({
    chatJid: params.chatJid,
    accountId: params.accountId,
    text: notice.text,
  });
}

async function forwardTelegramUpdateToTenant(update: TelegramUpdate) {
  const updateId =
    typeof update.update_id === "number" && Number.isFinite(update.update_id)
      ? Math.trunc(update.update_id)
      : 0;
  if (updateId <= 0) {
    return;
  }

  const callbackQuery = extractTelegramCallbackQuery(update);
  if (callbackQuery) {
    await forwardTelegramCallbackQueryToTenant({
      updateId,
      update,
      callbackQuery,
    });
    return;
  }

  const message = extractTelegramMessage(update);
  if (!message) {
    return;
  }

  const chatId =
    typeof message.chat?.id === "number" && Number.isFinite(message.chat.id)
      ? String(Math.trunc(message.chat.id))
      : "";
  if (!chatId) {
    return;
  }
  const isForum = message.chat?.is_forum === true;
  const topicId = resolveTelegramIncomingTopicId({
    isForum,
    messageThreadId: message.message_thread_id,
  });
  const bodyText = typeof message.text === "string" ? message.text : null;
  const bodyCaption = typeof message.caption === "string" ? message.caption : null;
  const body = bodyText ?? bodyCaption ?? "";
  const chatType = message.chat?.type === "private" ? "direct" : "group";
  const binding = resolveTelegramBindingForIncoming(chatId, topicId);
  const botControlCommand = parseBotControlCommand(body);
  if (botControlCommand) {
    try {
      await handleTelegramBotControlCommand({
        command: botControlCommand,
        chatId,
        topicId,
        chatType,
        binding,
      });
    } catch (error) {
      log({
        type: "telegram_bot_control_error",
        updateId,
        chatId,
        topicId: topicId ?? null,
        error: String(error),
      });
    }
    return;
  }
  const pairingToken = extractPairingTokenFromTelegramMessage(message);
  if (!binding) {
    if (!pairingToken) {
      const shouldSendUnpairedNotice =
        isTelegramCommandText(body) ||
        (chatType === "direct" && hasTelegramMessageContent(message));
      if (shouldSendUnpairedNotice) {
        try {
          const notice = renderUnpairedHintNotice("telegram");
          await sendTelegramPairingNotice({
            chatId,
            topicId,
            text: notice.text,
            parseMode: notice.parseMode,
          });
        } catch (error) {
          log({
            type: "telegram_unpaired_command_notice_error",
            updateId,
            error: String(error),
          });
        }
      }
      return;
    }
    const claimed = claimTelegramPairingToken({
      token: pairingToken,
      chatId,
      topicId,
      chatType,
    });
    if (!claimed) {
      try {
        const notice = renderPairingInvalidNotice("telegram");
        await sendTelegramPairingNotice({
          chatId,
          topicId,
          text: notice.text,
          parseMode: notice.parseMode,
        });
      } catch (error) {
        log({
          type: "telegram_pairing_invalid_notice_error",
          updateId,
          error: String(error),
        });
      }
      log({
        type: "telegram_pairing_token_invalid",
        updateId,
        chatId,
        topicId: topicId ?? null,
      });
      return;
    }

    try {
      const notice = renderPairingSuccessNotice("telegram");
      await sendTelegramPairingNotice({
        chatId,
        topicId,
        text: notice.text,
        parseMode: notice.parseMode,
      });
    } catch (error) {
      log({
        type: "telegram_pairing_notice_error",
        tenantId: claimed.tenantId,
        updateId,
        error: String(error),
      });
    }
    log({
      type: "telegram_pairing_token_claimed",
      tenantId: claimed.tenantId,
      updateId,
      routeKey: claimed.routeKey,
      sessionKey: claimed.sessionKey,
    });
    return;
  }
  if (pairingToken) {
    log({
      type: "telegram_pairing_token_ignored_bound_route",
      tenantId: binding.tenantId,
      updateId,
      routeKey: binding.routeKey,
    });
    return;
  }

  const target = resolveTenantInboundTarget(binding.tenantId);
  if (!target) {
    log({
      type: "telegram_inbound_drop_no_target",
      tenantId: binding.tenantId,
      updateId,
      routeKey: binding.routeKey,
    });
    throw new Error(`telegram inbound target missing for tenant ${binding.tenantId}`);
  }

  const inboundMedia = await extractTelegramInboundMedia({ message, updateId });
  const forwardedBody = body ?? "";
  if (!forwardedBody && inboundMedia.attachments.length === 0) {
    return;
  }
  const messageId =
    typeof message.message_id === "number" && Number.isFinite(message.message_id)
      ? String(Math.trunc(message.message_id))
      : `tg-msg:${updateId}`;
  const fromId =
    typeof message.from?.id === "number" && Number.isFinite(message.from.id)
      ? String(Math.trunc(message.from.id))
      : "unknown";
  const timestampMs =
    typeof message.date === "number" && Number.isFinite(message.date)
      ? Math.trunc(message.date) * 1_000
      : Date.now();
  const inboundRouteKey = buildTelegramRouteKey(chatId, topicId);
  const sessionKey = resolveTelegramInboundSessionKey({
    tenantId: binding.tenantId,
    bindingId: binding.bindingId,
    chatId,
    topicId,
  });

  stmtUpsertSessionRoute.run(
    binding.tenantId,
    "telegram",
    sessionKey,
    binding.bindingId,
    JSON.stringify({ routeKey: inboundRouteKey }),
    Date.now(),
  );

  const payload = buildTelegramInboundEnvelope({
    updateId,
    sessionKey,
    accountId: openclawMuxAccountId,
    rawBody: forwardedBody,
    fromId,
    chatId,
    topicId,
    chatType,
    messageId,
    timestampMs,
    routeKey: inboundRouteKey,
    rawMessage: message,
    rawUpdate: update,
    media: inboundMedia.media,
    attachments: inboundMedia.attachments,
  });
  const payloadWithIdentity = {
    ...payload,
    openclawId: binding.tenantId,
  };

  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      ...(await buildInboundAuthHeaders(target)),
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payloadWithIdentity),
    signal: AbortSignal.timeout(target.timeoutMs),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`openclaw inbound failed (${response.status}): ${bodyText || "no body"}`);
  }

  log({
    type: "telegram_inbound_forwarded",
    tenantId: binding.tenantId,
    sessionKey,
    updateId,
    messageId,
  });
}

async function fetchDiscordChannelMessages(params: {
  channelId: string;
  afterMessageId?: string;
  limit?: number;
}): Promise<Record<string, unknown>[]> {
  const token = requireDiscordBotToken();
  const qs = new URLSearchParams();
  qs.set("limit", String(Math.max(1, Math.min(100, params.limit ?? 50))));
  if (params.afterMessageId) {
    qs.set("after", params.afterMessageId);
  }
  const response = await fetch(`${discordApiBaseUrl}/channels/${params.channelId}/messages?${qs}`, {
    method: "GET",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  const bodyText = await response.text();
  let parsed: unknown = [];
  if (bodyText.trim()) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = [];
    }
  }
  if (!response.ok) {
    throw new Error(`discord list messages failed (${response.status})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("discord list messages returned invalid payload");
  }
  return parsed.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object"),
  );
}

async function forwardDiscordBindingInbound(params: ActiveDiscordBindingRow) {
  const route = parseDiscordRouteKey(params.route_key);
  if (!route) {
    return;
  }
  let pending = params.status === "pending";

  const channelId = await resolveDiscordInboundChannelId(route);
  if (!channelId) {
    log({
      type: "discord_inbound_skip_unresolvable_route",
      tenantId: params.tenant_id,
      bindingId: params.binding_id,
      routeKey: params.route_key,
    });
    return;
  }

  const existingOffset = resolveStoredDiscordOffset(params.binding_id);
  if (!existingOffset && discordBootstrapLatest) {
    const latest = await fetchDiscordChannelMessages({ channelId, limit: 1 });
    const last = latest[0];
    const lastMessageId = readUnsignedNumericString(last?.id);
    if (lastMessageId) {
      storeDiscordOffset(params.binding_id, lastMessageId);
    }
    return;
  }

  const updates = await fetchDiscordChannelMessages({
    channelId,
    afterMessageId: existingOffset ?? undefined,
    limit: 50,
  });
  if (updates.length === 0) {
    return;
  }

  const sorted = sortDiscordMessagesAsc(updates);
  let lastAckedMessageId = existingOffset ?? null;

  for (const message of sorted) {
    const messageId = readUnsignedNumericString(message.id);
    if (!messageId) {
      continue;
    }

    const author =
      message.author && typeof message.author === "object"
        ? (message.author as Record<string, unknown>)
        : undefined;
    const fromId = readUnsignedNumericString(author?.id);
    const isBot = author?.bot === true;
    if (!fromId || isBot) {
      lastAckedMessageId = messageId;
      continue;
    }

    const body = typeof message.content === "string" ? message.content : "";
    const botControlCommand = parseBotControlCommand(body);
    if (botControlCommand) {
      try {
        const result = await handleDiscordBotControlCommand({
          command: botControlCommand,
          channelId,
          routeKey: params.route_key,
          tenantId: params.tenant_id,
          bindingId: params.binding_id,
          status: pending ? "pending" : "active",
        });
        lastAckedMessageId = messageId;
        if (typeof result.pending === "boolean") {
          pending = result.pending;
        }
        if (result.routeReset) {
          break;
        }
      } catch (error) {
        log({
          type: "discord_bot_control_error",
          tenantId: params.tenant_id,
          bindingId: params.binding_id,
          routeKey: params.route_key,
          messageId,
          error: String(error),
        });
      }
      continue;
    }
    const pairingToken = extractPairingTokenFromDiscordMessage(message);
    if (pending) {
      if (!pairingToken) {
        const shouldSendUnpairedNotice =
          isDiscordCommandText(body) || (route.kind === "dm" && hasDiscordMessageContent(message));
        if (shouldSendUnpairedNotice) {
          try {
            const notice = renderUnpairedHintNotice("discord");
            await sendDiscordPairingNotice({
              channelId,
              text: notice.text,
            });
          } catch (error) {
            log({
              type: "discord_unpaired_command_notice_error",
              tenantId: params.tenant_id,
              bindingId: params.binding_id,
              messageId,
              error: String(error),
            });
          }
        }
        lastAckedMessageId = messageId;
        continue;
      }
      const tokenRow = peekActivePairingToken(pairingToken, "discord");
      if (!tokenRow) {
        try {
          const notice = renderPairingInvalidNotice("discord");
          await sendDiscordPairingNotice({
            channelId,
            text: notice.text,
          });
        } catch (error) {
          log({
            type: "discord_pairing_invalid_notice_error",
            tenantId: params.tenant_id,
            bindingId: params.binding_id,
            messageId,
            error: String(error),
          });
        }
        log({
          type: "discord_pairing_token_invalid",
          tenantId: params.tenant_id,
          bindingId: params.binding_id,
          messageId,
          channelId,
        });
        lastAckedMessageId = messageId;
        continue;
      }
      const claimed = claimDiscordPairingToken({
        token: pairingToken,
        route,
        channelId,
      });
      if (!claimed) {
        try {
          const notice = renderPairingInvalidNotice("discord");
          await sendDiscordPairingNotice({
            channelId,
            text: notice.text,
          });
        } catch (error) {
          log({
            type: "discord_pairing_invalid_notice_error",
            tenantId: params.tenant_id,
            bindingId: params.binding_id,
            messageId,
            error: String(error),
          });
        }
        log({
          type: "discord_pairing_token_invalid",
          tenantId: params.tenant_id,
          bindingId: params.binding_id,
          messageId,
          channelId,
        });
        lastAckedMessageId = messageId;
        continue;
      }
      try {
        const notice = renderPairingSuccessNotice("discord");
        await sendDiscordPairingNotice({
          channelId,
          text: notice.text,
        });
      } catch (error) {
        log({
          type: "discord_pairing_notice_error",
          tenantId: params.tenant_id,
          bindingId: params.binding_id,
          messageId,
          error: String(error),
        });
      }
      log({
        type: "discord_pairing_token_claimed",
        tenantId: claimed.tenantId,
        bindingId: claimed.bindingId,
        routeKey: claimed.routeKey,
        sessionKey: claimed.sessionKey,
        channelId,
        messageId,
      });
      pending = false;
      lastAckedMessageId = messageId;
      continue;
    }

    if (pairingToken) {
      log({
        type: "discord_pairing_token_ignored_bound_route",
        tenantId: params.tenant_id,
        bindingId: params.binding_id,
        routeKey: params.route_key,
        messageId,
      });
      lastAckedMessageId = messageId;
      continue;
    }

    const forwardStatus = await forwardDiscordMessageToTenant({
      tenantId: params.tenant_id,
      bindingId: params.binding_id,
      routeKey: params.route_key,
      route,
      channelId,
      message,
      messageId,
      fromId,
      body,
    });
    if (forwardStatus === "deferred") {
      break;
    }
    lastAckedMessageId = messageId;
  }

  if (lastAckedMessageId && lastAckedMessageId !== existingOffset) {
    storeDiscordOffset(params.binding_id, lastAckedMessageId);
    log({
      type: "discord_inbound_ack_committed",
      tenantId: params.tenant_id,
      bindingId: params.binding_id,
      messageId: lastAckedMessageId,
    });
  }
}

async function runDiscordInboundPollPass() {
  const bindings = stmtListActiveDiscordBindings.all() as ActiveDiscordBindingRow[];
  for (const binding of bindings) {
    const route = parseDiscordRouteKey(binding.route_key);
    if (discordGatewayReady && discordGatewayDmEnabled && route?.kind === "dm") {
      continue;
    }
    if (discordGatewayReady && discordGatewayGuildEnabled && route?.kind === "guild") {
      continue;
    }
    try {
      await forwardDiscordBindingInbound(binding);
    } catch (error) {
      const err = error instanceof Error ? error : undefined;
      log({
        type: "discord_inbound_forward_error",
        tenantId: binding.tenant_id,
        bindingId: binding.binding_id,
        error: String(error),
        message: err?.message,
        cause: err?.cause instanceof Error ? err.cause.message : undefined,
        stack: err?.stack,
      });
    }
  }
}

async function runDiscordInboundLoop() {
  if (!discordInboundEnabled) {
    return;
  }
  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  const pollMs = Math.max(200, Math.trunc(discordPollIntervalMs));
  while (running) {
    try {
      await runDiscordInboundPollPass();
    } catch (error) {
      const err = error instanceof Error ? error : undefined;
      log({
        type: "discord_inbound_poll_error",
        error: String(error),
        message: err?.message,
        cause: err?.cause instanceof Error ? err.cause.message : undefined,
        stack: err?.stack,
      });
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
  }
}

async function handleDiscordGatewayMessage(message: Record<string, unknown>) {
  const messageId = readUnsignedNumericString(message.id);
  const author = asRecord(message.author);
  const fromId = readUnsignedNumericString(author?.id);
  const isBot = author?.bot === true;
  if (!messageId || !fromId || isBot) {
    return;
  }

  const incoming = await resolveDiscordIncomingRouteFromMessage({
    message,
    fromId,
  });
  if (!incoming) {
    return;
  }
  const route = incoming.route;
  const channelId = incoming.channelId;
  if (route.kind === "dm" && !discordGatewayDmEnabled) {
    return;
  }
  if (route.kind === "guild" && !discordGatewayGuildEnabled) {
    return;
  }

  const incomingRouteKey = buildDiscordRouteKey(route);
  const liveBinding = resolveDiscordBindingForIncoming(route);
  const body = typeof message.content === "string" ? message.content : "";

  const botControlCommand = parseBotControlCommand(body);
  if (botControlCommand) {
    try {
      if (!liveBinding) {
        await handleDiscordBotControlCommandUnbound({
          command: botControlCommand,
          channelId,
          routeKey: incomingRouteKey,
        });
      } else {
        await handleDiscordBotControlCommand({
          command: botControlCommand,
          channelId,
          routeKey: liveBinding.routeKey,
          tenantId: liveBinding.tenantId,
          bindingId: liveBinding.bindingId,
          status: liveBinding.status,
        });
      }
    } catch (error) {
      log({
        type: "discord_bot_control_error",
        tenantId: liveBinding?.tenantId,
        bindingId: liveBinding?.bindingId,
        routeKey: liveBinding?.routeKey ?? incomingRouteKey,
        messageId,
        error: String(error),
      });
    }
    return;
  }

  const pairingToken = extractPairingTokenFromDiscordMessage(message);
  if (!liveBinding || liveBinding.status === "pending") {
    if (!pairingToken) {
      const shouldSendUnpairedNotice =
        isDiscordCommandText(body) || (route.kind === "dm" && hasDiscordMessageContent(message));
      if (shouldSendUnpairedNotice) {
        try {
          const notice = renderUnpairedHintNotice("discord");
          await sendDiscordPairingNotice({
            channelId,
            text: notice.text,
          });
        } catch (error) {
          log({
            type: "discord_unpaired_command_notice_error",
            tenantId: liveBinding?.tenantId,
            bindingId: liveBinding?.bindingId,
            messageId,
            error: String(error),
          });
        }
      }
      return;
    }

    const tokenRow = peekActivePairingToken(pairingToken, "discord");
    if (!tokenRow) {
      try {
        const notice = renderPairingInvalidNotice("discord");
        await sendDiscordPairingNotice({
          channelId,
          text: notice.text,
        });
      } catch (error) {
        log({
          type: "discord_pairing_invalid_notice_error",
          tenantId: liveBinding?.tenantId,
          bindingId: liveBinding?.bindingId,
          messageId,
          error: String(error),
        });
      }
      log({
        type: "discord_pairing_token_invalid",
        tenantId: liveBinding?.tenantId,
        bindingId: liveBinding?.bindingId,
        messageId,
        channelId,
      });
      return;
    }

    const claimed = claimDiscordPairingToken({
      token: pairingToken,
      route,
      channelId,
    });
    try {
      const notice = claimed
        ? renderPairingSuccessNotice("discord")
        : renderPairingInvalidNotice("discord");
      await sendDiscordPairingNotice({
        channelId,
        text: notice.text,
      });
    } catch (error) {
      log({
        type: "discord_pairing_notice_error",
        tenantId: claimed?.tenantId ?? liveBinding?.tenantId,
        bindingId: claimed?.bindingId ?? liveBinding?.bindingId,
        messageId,
        error: String(error),
      });
    }
    if (claimed) {
      log({
        type: "discord_pairing_token_claimed",
        tenantId: claimed.tenantId,
        bindingId: claimed.bindingId,
        routeKey: claimed.routeKey,
        sessionKey: claimed.sessionKey,
        channelId,
        messageId,
      });
    }
    return;
  }

  if (pairingToken) {
    log({
      type: "discord_pairing_token_ignored_bound_route",
      tenantId: liveBinding.tenantId,
      bindingId: liveBinding.bindingId,
      routeKey: liveBinding.routeKey,
      messageId,
    });
    return;
  }

  await forwardDiscordMessageToTenant({
    tenantId: liveBinding.tenantId,
    bindingId: liveBinding.bindingId,
    routeKey: incomingRouteKey,
    route,
    channelId,
    message,
    messageId,
    fromId,
    body,
  });
}

async function runDiscordGatewayDmSession(): Promise<void> {
  const gatewayUrl = await fetchDiscordGatewayUrl();
  const token = requireDiscordBotToken();
  discordGatewayReady = false;
  const intents =
    Number.isFinite(discordGatewayIntents) && discordGatewayIntents > 0
      ? Math.trunc(discordGatewayIntents)
      : discordGatewayDefaultIntents;

  await new Promise<void>((resolve) => {
    let seq: number | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const ws = new WebSocket(gatewayUrl);

    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      discordGatewayReady = false;
      clearHeartbeat();
      resolve();
    };
    const sendHeartbeat = () => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        ws.send(JSON.stringify({ op: 1, d: seq }));
      } catch (error) {
        log({
          type: "discord_gateway_dm_heartbeat_error",
          error: String(error),
        });
      }
    };

    ws.on("open", () => {
      log({
        type: "discord_gateway_dm_open",
        intents,
      });
    });

    ws.on("message", (raw) => {
      const frame = parseDiscordGatewayPayload(raw);
      if (!frame) {
        return;
      }

      const op = Number(frame.op);
      if (Number.isFinite(Number(frame.s))) {
        seq = Math.trunc(Number(frame.s));
      }

      if (op === 10) {
        const hello = asRecord(frame.d);
        const heartbeatIntervalMs = readPositiveInt(hello?.heartbeat_interval) ?? 45_000;
        clearHeartbeat();
        heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
        sendHeartbeat();
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents,
              properties: {
                os: process.platform,
                browser: "openclaw-mux",
                device: "openclaw-mux",
              },
            },
          }),
        );
        return;
      }

      if (op === 1) {
        sendHeartbeat();
        return;
      }

      if (op === 7 || op === 9) {
        ws.close(4_000, op === 7 ? "gateway_reconnect" : "gateway_invalid_session");
        return;
      }

      if (op !== 0) {
        return;
      }

      const eventType = typeof frame.t === "string" ? frame.t : "";
      if (eventType === "READY") {
        const ready = asRecord(frame.d);
        discordGatewayReady = true;
        log({
          type: "discord_gateway_dm_ready",
          sessionId: readNonEmptyString(ready?.session_id) ?? null,
        });
        return;
      }
      if (eventType !== "MESSAGE_CREATE") {
        return;
      }

      const eventData = asRecord(frame.d);
      if (!eventData) {
        return;
      }
      void handleDiscordGatewayMessage(eventData).catch((error) => {
        log({
          type: "discord_gateway_dm_event_error",
          error: String(error),
        });
      });
    });

    ws.on("error", (error) => {
      log({
        type: "discord_gateway_dm_socket_error",
        error: String(error),
      });
    });

    ws.on("close", (code, reason) => {
      log({
        type: "discord_gateway_dm_close",
        code,
        reason: reason.toString(),
      });
      finish();
    });
  });
}

async function runDiscordGatewayDmLoop() {
  if (!discordInboundEnabled || (!discordGatewayDmEnabled && !discordGatewayGuildEnabled)) {
    return;
  }

  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  const reconnectInitial = Math.max(100, Math.trunc(discordGatewayReconnectInitialMs));
  const reconnectMax = Math.max(reconnectInitial, Math.trunc(discordGatewayReconnectMaxMs));
  let reconnectMs = reconnectInitial;

  while (running) {
    const startedAt = Date.now();
    try {
      await runDiscordGatewayDmSession();
    } catch (error) {
      log({
        type: "discord_gateway_dm_loop_error",
        error: String(error),
      });
    }
    if (!running) {
      break;
    }

    const lifetimeMs = Date.now() - startedAt;
    reconnectMs = lifetimeMs >= 60_000 ? reconnectInitial : Math.min(reconnectMs * 2, reconnectMax);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, reconnectMs));
  }
}

function parseQueuedWhatsAppInboundMessage(row: WhatsAppInboundQueueRow): WebInboundMessage | null {
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return snapshotWhatsAppInboundMessage(parsed as WebInboundMessage);
  } catch {
    return null;
  }
}

async function processWhatsAppInboundQueuePass(): Promise<void> {
  const now = Date.now();
  const batchSize = Math.max(1, Math.min(100, Math.trunc(whatsappQueueBatchSize)));
  const rows = stmtSelectDueWhatsAppInboundQueue.all(now, batchSize) as WhatsAppInboundQueueRow[];
  for (const row of rows) {
    const message = parseQueuedWhatsAppInboundMessage(row);
    if (!message) {
      stmtDeleteWhatsAppInboundQueueById.run(row.id);
      log({
        type: "whatsapp_inbound_queue_drop_invalid_payload",
        queueId: row.id,
        dedupeKey: row.dedupe_key,
      });
      continue;
    }

    try {
      await forwardWhatsAppInboundMessage(message);
      stmtDeleteWhatsAppInboundQueueById.run(row.id);
      log({
        type: "whatsapp_inbound_ack_committed",
        queueId: row.id,
        dedupeKey: row.dedupe_key,
        messageId: message.id ?? null,
      });
    } catch (error) {
      const attemptCount = Math.max(
        1,
        Number.isFinite(row.attempt_count) ? Math.trunc(row.attempt_count) + 1 : 1,
      );
      const retryDelayMs = computeWhatsAppQueueRetryDelayMs(attemptCount);
      const nextAttemptAtMs = Date.now() + retryDelayMs;
      stmtDeferWhatsAppInboundQueueById.run(
        nextAttemptAtMs,
        attemptCount,
        String(error).slice(0, 2_000),
        Date.now(),
        row.id,
      );
      log({
        type: "whatsapp_inbound_retry_deferred",
        queueId: row.id,
        dedupeKey: row.dedupe_key,
        messageId: message.id ?? null,
        attemptCount,
        retryDelayMs,
        nextAttemptAtMs,
        error: String(error),
      });
    }
  }
}

async function runWhatsAppInboundQueueLoop(shouldContinue: () => boolean): Promise<void> {
  const pollMs = Math.max(100, Math.trunc(whatsappQueuePollMs));
  while (shouldContinue()) {
    try {
      await processWhatsAppInboundQueuePass();
    } catch (error) {
      log({
        type: "whatsapp_inbound_queue_poll_error",
        error: String(error),
      });
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
  }
}

async function forwardWhatsAppInboundMessage(message: WebInboundMessage) {
  const chatJid = readNonEmptyString(message.chatId) ?? readNonEmptyString(message.from);
  if (!chatJid) {
    return;
  }
  const accountId = readNonEmptyString(message.accountId) ?? whatsappAccountId;
  const chatType = message.chatType === "group" ? "group" : "direct";
  const directPeerId =
    chatType === "direct"
      ? (readNonEmptyString(message.senderE164) ?? readNonEmptyString(message.from) ?? undefined)
      : undefined;
  const body = typeof message.body === "string" ? message.body : "";
  const binding = resolveWhatsAppBindingForIncoming({
    chatJid,
    accountId,
  });
  const botControlCommand = parseBotControlCommand(body);
  if (botControlCommand) {
    try {
      await handleWhatsAppBotControlCommand({
        command: botControlCommand,
        chatJid,
        accountId,
        chatType,
        directPeerId,
        binding,
      });
    } catch (error) {
      log({
        type: "whatsapp_bot_control_error",
        chatJid,
        accountId,
        error: String(error),
      });
    }
    return;
  }
  const pairingToken = extractPairingTokenFromWhatsAppMessage(message);

  if (!binding) {
    if (!pairingToken) {
      const shouldSendUnpairedNotice =
        isWhatsAppCommandText(body) ||
        (chatType === "direct" && hasWhatsAppMessageContent(message));
      if (shouldSendUnpairedNotice) {
        try {
          const notice = renderUnpairedHintNotice("whatsapp");
          await sendWhatsAppPairingNotice({
            chatJid,
            accountId,
            text: notice.text,
          });
        } catch (error) {
          log({
            type: "whatsapp_unpaired_command_notice_error",
            chatJid,
            error: String(error),
          });
        }
      }
      return;
    }

    const claimed = claimWhatsAppPairingToken({
      token: pairingToken,
      chatJid,
      accountId,
      chatType,
      directPeerId,
    });
    if (!claimed) {
      try {
        const notice = renderPairingInvalidNotice("whatsapp");
        await sendWhatsAppPairingNotice({
          chatJid,
          accountId,
          text: notice.text,
        });
      } catch (error) {
        log({
          type: "whatsapp_pairing_invalid_notice_error",
          chatJid,
          error: String(error),
        });
      }
      log({
        type: "whatsapp_pairing_token_invalid",
        chatJid,
        accountId,
      });
      return;
    }

    try {
      const notice = renderPairingSuccessNotice("whatsapp");
      await sendWhatsAppPairingNotice({
        chatJid,
        accountId,
        text: notice.text,
      });
    } catch (error) {
      log({
        type: "whatsapp_pairing_notice_error",
        tenantId: claimed.tenantId,
        chatJid,
        error: String(error),
      });
    }
    log({
      type: "whatsapp_pairing_token_claimed",
      tenantId: claimed.tenantId,
      routeKey: claimed.routeKey,
      sessionKey: claimed.sessionKey,
      accountId,
      chatJid,
    });
    return;
  }

  if (pairingToken) {
    log({
      type: "whatsapp_pairing_token_ignored_bound_route",
      tenantId: binding.tenantId,
      routeKey: binding.routeKey,
      accountId,
      chatJid,
    });
    return;
  }

  const target = resolveTenantInboundTarget(binding.tenantId);
  if (!target) {
    log({
      type: "whatsapp_inbound_drop_no_target",
      tenantId: binding.tenantId,
      routeKey: binding.routeKey,
      accountId,
      chatJid,
    });
    throw new Error(`whatsapp inbound target missing for tenant ${binding.tenantId}`);
  }

  const inboundMedia = await extractWhatsAppInboundMedia({ message });
  if (!body && inboundMedia.attachments.length === 0) {
    return;
  }

  const messageId = readNonEmptyString(message.id) ?? `wa:${Date.now()}:${randomUUID()}`;
  const fromId =
    readNonEmptyString(message.senderE164) ??
    readNonEmptyString(message.senderJid) ??
    readNonEmptyString(message.from) ??
    "unknown";
  const timestampMs =
    typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? Math.trunc(message.timestamp)
      : Date.now();
  const existingRoute = stmtSelectSessionKeyByBinding.get(
    binding.tenantId,
    "whatsapp",
    binding.bindingId,
  ) as { session_key?: unknown } | undefined;
  const sessionKey =
    (typeof existingRoute?.session_key === "string" && existingRoute.session_key.trim()) ||
    deriveWhatsAppSessionKey({
      chatJid,
      chatType,
      directPeerId,
    });
  stmtUpsertSessionRoute.run(
    binding.tenantId,
    "whatsapp",
    sessionKey,
    binding.bindingId,
    JSON.stringify({ routeKey: binding.routeKey, accountId, chatJid }),
    Date.now(),
  );

  const payload = buildWhatsAppInboundEnvelope({
    messageId,
    sessionKey,
    openclawAccountId: openclawMuxAccountId,
    rawBody: body,
    fromId,
    chatJid,
    routeKey: binding.routeKey,
    accountId,
    chatType,
    timestampMs,
    rawMessage: {
      id: message.id,
      from: message.from,
      to: message.to,
      body: message.body,
      accountId: message.accountId,
      timestamp: message.timestamp,
      chatType: message.chatType,
      chatId: message.chatId,
      senderJid: message.senderJid,
      senderE164: message.senderE164,
      senderName: message.senderName,
      replyToId: message.replyToId,
      replyToBody: message.replyToBody,
      replyToSender: message.replyToSender,
      replyToSenderJid: message.replyToSenderJid,
      replyToSenderE164: message.replyToSenderE164,
      groupSubject: message.groupSubject,
      groupParticipants: message.groupParticipants,
      mentionedJids: message.mentionedJids,
      mediaPath: message.mediaPath,
      mediaType: message.mediaType,
      mediaUrl: message.mediaUrl,
    },
    media: inboundMedia.media,
    attachments: inboundMedia.attachments,
  });
  const payloadWithIdentity = {
    ...payload,
    openclawId: binding.tenantId,
  };

  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      ...(await buildInboundAuthHeaders(target)),
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payloadWithIdentity),
    signal: AbortSignal.timeout(target.timeoutMs),
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`openclaw inbound failed (${response.status}): ${bodyText || "no body"}`);
  }

  log({
    type: "whatsapp_inbound_forwarded",
    tenantId: binding.tenantId,
    sessionKey,
    messageId,
    accountId,
    chatJid,
  });
}

async function runWhatsAppInboundLoop() {
  if (!whatsappInboundEnabled) {
    return;
  }

  const { monitorWebInbox, setActiveWebListener } = await loadWebRuntimeModules();
  whatsappRuntimeHealth.loopStartedAtMs = Date.now();
  let running = true;
  process.on("SIGINT", () => {
    running = false;
    whatsappRuntimeHealth.listenerActive = false;
    void activeWhatsAppListener?.close?.();
  });
  process.on("SIGTERM", () => {
    running = false;
    whatsappRuntimeHealth.listenerActive = false;
    void activeWhatsAppListener?.close?.();
  });

  const queueLoopPromise = runWhatsAppInboundQueueLoop(() => running);

  while (running) {
    let listener: WebMonitorListener | null = null;
    try {
      whatsappRuntimeHealth.lastListenerStartAtMs = Date.now();
      const monitored = await monitorWebInbox({
        verbose: false,
        accountId: whatsappAccountId,
        authDir: whatsappAuthDir,
        // Mux owns pairing and tenant routing. Keep inbox transport raw here
        // while still dropping outbound fromMe echoes to avoid loops.
        resolveAccessControl: async (params) => {
          const isSamePhone = params.from === params.selfE164;
          const isOutboundEcho = params.isFromMe && !isSamePhone;
          return {
            allowed: !isOutboundEcho,
            shouldMarkRead: true,
            isSelfChat: false,
            resolvedAccountId: params.accountId,
          };
        },
        onMessage: async (message) => {
          whatsappRuntimeHealth.lastInboundSeenAtMs = Date.now();
          enqueueWhatsAppInboundMessage(message);
        },
      });
      listener = monitored;
      activeWhatsAppListener = monitored;
      whatsappRuntimeHealth.listenerActive = true;
      whatsappRuntimeHealth.lastListenerError = null;
      whatsappRuntimeHealth.lastListenerErrorAtMs = null;
      setActiveWebListener(whatsappAccountId, monitored);
      const closeReason = await monitored.onClose;
      whatsappRuntimeHealth.lastListenerCloseAtMs = Date.now();
      whatsappRuntimeHealth.lastListenerCloseStatus =
        typeof closeReason.status === "number" && Number.isFinite(closeReason.status)
          ? Math.trunc(closeReason.status)
          : null;
      whatsappRuntimeHealth.lastListenerClosedLoggedOut = Boolean(closeReason.isLoggedOut);
      const listenerError =
        closeReason.error instanceof Error
          ? closeReason.error.message
          : typeof closeReason.error === "string"
            ? closeReason.error
            : undefined;
      if (closeReason.error != null) {
        whatsappRuntimeHealth.lastListenerErrorAtMs = Date.now();
        whatsappRuntimeHealth.lastListenerError = listenerError ?? "unknown listener error";
      }
      log({
        type: "whatsapp_inbound_listener_closed",
        status: closeReason.status,
        isLoggedOut: closeReason.isLoggedOut,
        error: listenerError,
      });
      if (closeReason.isLoggedOut) {
        running = false;
      }
    } catch (error) {
      whatsappRuntimeHealth.lastListenerErrorAtMs = Date.now();
      whatsappRuntimeHealth.lastListenerError = String(error);
      whatsappRuntimeHealth.listenerActive = false;
      log({
        type: "whatsapp_inbound_listener_error",
        error: String(error),
      });
    } finally {
      if (listener) {
        try {
          await listener.close();
        } catch (error) {
          log({
            type: "whatsapp_inbound_listener_close_error",
            error: String(error),
          });
        }
      }
      activeWhatsAppListener = null;
      whatsappRuntimeHealth.listenerActive = false;
      setActiveWebListener(whatsappAccountId, null);
    }

    if (!running) {
      break;
    }
    await new Promise((resolveSleep) =>
      setTimeout(resolveSleep, Math.max(100, Math.trunc(whatsappInboundRetryMs))),
    );
  }

  await queueLoopPromise;
}

async function runTelegramInboundLoop() {
  if (!telegramInboundEnabled) {
    return;
  }

  try {
    await bootstrapTelegramOffsetIfNeeded();
  } catch (error) {
    log({ type: "telegram_inbound_bootstrap_error", error: String(error) });
  }

  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  while (running) {
    try {
      const offset = resolveStoredTelegramOffset() + 1;
      const updates = await fetchTelegramUpdates(offset);
      for (const update of updates) {
        const updateId =
          typeof update.update_id === "number" && Number.isFinite(update.update_id)
            ? Math.trunc(update.update_id)
            : 0;
        if (updateId <= 0) {
          continue;
        }
        try {
          await forwardTelegramUpdateToTenant(update);
          storeTelegramOffset(updateId);
          // Avoid blocking the tight polling loop on sync IO (tests depend on quick follow-up polls).
          queueMicrotask(() => log({ type: "telegram_inbound_ack_committed", updateId }));
        } catch (error) {
          log({
            type: "telegram_inbound_retry_deferred",
            updateId,
            error: String(error),
          });
          break;
        }
      }
    } catch (error) {
      log({ type: "telegram_inbound_poll_error", error: String(error) });
      await new Promise((resolveSleep) =>
        setTimeout(resolveSleep, Math.max(100, Math.trunc(telegramPollRetryMs))),
      );
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;

    if (pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/.well-known/jwks.json") {
      sendJson(res, 200, runtimeJwtSigner.jwks());
      return;
    }

    if (req.method === "POST" && pathname === "/v1/instances/register") {
      if (!muxRegisterKey) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      if (!isRegisterAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const body = await readBody<Record<string, unknown>>(req);
      const result = await registerOpenClawInstance({
        openclawId: body.openclawId,
        inboundUrl: body.inboundUrl,
        inboundTimeoutMs: body.inboundTimeoutMs,
      });
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    if (req.method === "GET" && pathname === "/v1/admin/whatsapp/health") {
      if (!muxAdminToken) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      if (!isAdminAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      sendJson(res, 200, { ok: true, whatsapp: getWhatsAppCredentialHealth() });
      return;
    }

    if (req.method === "POST" && pathname === "/v1/admin/pairings/token") {
      if (!muxAdminToken) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      if (!isAdminAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const body = await readBody<Record<string, unknown>>(req);
      const openclawId = readNonEmptyString(body.openclawId);
      if (!openclawId) {
        sendJson(res, 400, { ok: false, error: "openclawId required" });
        return;
      }
      const channel = normalizeChannel(body.channel);
      if (!channel) {
        sendJson(res, 400, { ok: false, error: "channel required" });
        return;
      }
      const sessionKey = readNonEmptyString(body.sessionKey) ?? undefined;
      const ttlSec = readPositiveInt(body.ttlSec);

      const inboundUrl = readNonEmptyString(body.inboundUrl);
      const inboundTimeoutMs = readPositiveInt(body.inboundTimeoutMs);
      if (inboundUrl) {
        const now = Date.now();
        const syntheticApiKey = `instance:${openclawId}`;
        try {
          stmtUpsertTenantInboundTargetByAdmin.run(
            openclawId,
            openclawId,
            hashApiKey(syntheticApiKey),
            inboundUrl,
            inboundTimeoutMs ?? 15_000,
            now,
            now,
          );
        } catch (error) {
          if (String(error).includes("UNIQUE constraint failed: tenants.api_key_hash")) {
            sendJson(res, 409, { ok: false, error: "instance id conflict" });
            return;
          }
          throw error;
        }
      }

      const result = issuePairingTokenForTenant({
        tenant: {
          id: openclawId,
          name: openclawId,
          authToken: muxAdminToken,
          authKind: "admin",
        },
        channel,
        sessionKey,
        ttlSec,
      });
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    const tenant = await resolveTenantIdentity(req);
    if (!tenant) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && pathname === "/v1/pairings") {
      const result = listPairingsForTenant(tenant);
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    if (req.method === "POST" && pathname === "/v1/pairings/claim") {
      const body = await readBody<Record<string, unknown>>(req);
      const code = readNonEmptyString(body.code);
      if (!code) {
        sendJson(res, 400, { ok: false, error: "code required" });
        return;
      }
      const sessionKey = readNonEmptyString(body.sessionKey) ?? undefined;
      const result = claimPairingForTenant(tenant, code, sessionKey);
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    if (req.method === "POST" && pathname === "/v1/pairings/unbind") {
      const body = await readBody<Record<string, unknown>>(req);
      const bindingId = readNonEmptyString(body.bindingId);
      if (!bindingId) {
        sendJson(res, 400, { ok: false, error: "bindingId required" });
        return;
      }
      const result = unbindPairingForTenant(tenant, bindingId);
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    if (req.method === "POST" && pathname === "/v1/mux/outbound/typing") {
      const body = await readBody<Record<string, unknown>>(req);
      const channel = normalizeChannel(body.channel);
      const sessionKey = readNonEmptyString(body.sessionKey);
      const payloadOpenClawId = readNonEmptyString(body.openclawId);
      if (!channel) {
        sendJson(res, 400, { ok: false, error: "channel required" });
        return;
      }
      if (!sessionKey) {
        sendJson(res, 400, { ok: false, error: "sessionKey required" });
        return;
      }
      if (tenant.authKind === "runtime-jwt") {
        if (!payloadOpenClawId || payloadOpenClawId !== tenant.id) {
          sendJson(res, 401, { ok: false, error: "openclawId mismatch" });
          return;
        }
      }
      const typingResult = await runOutboundAction({
        tenant,
        channel,
        sessionKey,
        action: "typing",
      });
      res.writeHead(typingResult.statusCode, { "content-type": "application/json; charset=utf-8" });
      res.end(typingResult.bodyText);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/v1/mux/files/")) {
      const channel = pathname.slice("/v1/mux/files/".length).toLowerCase();
      if (channel === "telegram") {
        const fileId = requestUrl.searchParams.get("fileId");
        if (!fileId) {
          sendJson(res, 400, { ok: false, error: "fileId query param required" });
          return;
        }
        try {
          const filePath = await resolveTelegramFilePath(fileId);
          if (!filePath) {
            sendJson(res, 404, { ok: false, error: "file not found" });
            return;
          }
          const token = requireTelegramBotToken();
          const normalizedPath = filePath.replace(/^\/+/, "");
          const upstream = await fetch(`${telegramApiBaseUrl}/file/bot${token}/${normalizedPath}`);
          if (!upstream.ok || !upstream.body) {
            sendJson(res, 502, { ok: false, error: "upstream fetch failed" });
            return;
          }
          const mime =
            inferMimeTypeFromPath(filePath) ||
            upstream.headers.get("content-type") ||
            "application/octet-stream";
          const fileName = path.basename(filePath);
          res.writeHead(200, {
            "content-type": mime,
            "content-disposition": `inline; filename="${fileName}"`,
            ...(upstream.headers.get("content-length")
              ? { "content-length": upstream.headers.get("content-length")! }
              : {}),
          });
          const reader = upstream.body.getReader();
          const pump = async () => {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              res.write(value);
            }
            res.end();
          };
          await pump();
        } catch (error) {
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: String(error) });
          }
        }
        return;
      }
      if (channel === "whatsapp") {
        const filePath = requestUrl.searchParams.get("path");
        if (!filePath) {
          sendJson(res, 400, { ok: false, error: "path query param required" });
          return;
        }
        const resolved = path.resolve(filePath);
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isFile()) {
            sendJson(res, 404, { ok: false, error: "not a file" });
            return;
          }
          const mime = inferMimeTypeFromPath(resolved) || "application/octet-stream";
          const fileName = path.basename(resolved);
          res.writeHead(200, {
            "content-type": mime,
            "content-disposition": `inline; filename="${fileName}"`,
            "content-length": String(stat.size),
          });
          const stream = fs.createReadStream(resolved);
          stream.pipe(res);
        } catch (error) {
          log({ type: "whatsapp_file_proxy_error", filePath: resolved, error: String(error) });
          if (!res.headersSent) {
            sendJson(res, 404, { ok: false, error: "file not found" });
          }
        }
        return;
      }
      sendJson(res, 400, { ok: false, error: `unsupported channel: ${channel}` });
      return;
    }

    if (req.method !== "POST" || pathname !== "/v1/mux/outbound/send") {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    const payload = await readBody<MuxPayload>(req);
    const idempotencyKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : undefined;
    const fingerprint = JSON.stringify(payload);

    const now = Date.now();
    purgeExpiredIdempotency(now);
    if (idempotencyKey) {
      const cached = loadCachedIdempotency({
        tenantId: tenant.id,
        idempotencyKey,
        fingerprint,
        now,
      });
      if (cached === "mismatch") {
        sendJson(res, 409, {
          ok: false,
          error: "idempotency key reused with different payload",
        });
        return;
      }
      if (cached) {
        log({
          type: "idempotency_hit_cached",
          tenantId: tenant.id,
          idempotencyKey,
          status: cached.statusCode,
        });
        res.writeHead(cached.statusCode, { "content-type": "application/json; charset=utf-8" });
        res.end(cached.bodyText);
        return;
      }

      const inflightKey = resolveInflightKey(tenant.id, idempotencyKey);
      const inflight = idempotencyInflight.get(inflightKey);
      if (inflight) {
        if (inflight.fingerprint !== fingerprint) {
          sendJson(res, 409, {
            ok: false,
            error: "idempotency key reused with different payload",
          });
          return;
        }
        const result = await inflight.promise;
        log({
          type: "idempotency_hit_inflight",
          tenantId: tenant.id,
          idempotencyKey,
          status: result.statusCode,
        });
        res.writeHead(result.statusCode, { "content-type": "application/json; charset=utf-8" });
        res.end(result.bodyText);
        return;
      }
    }

    const runSend = async (): Promise<SendResult> => {
      log({
        type: "outbound_request",
        tenantId: tenant.id,
        tenantName: tenant.name,
        idempotencyKey,
        payload,
      });

      const channel = normalizeChannel(payload.channel);
      const sessionKey = readNonEmptyString(payload.sessionKey);
      const operation = readOutboundOperation(payload);
      const rawOutbound = readOutboundRaw(payload);
      const { text, hasText } = readOutboundText(payload);
      const mediaUrls = collectOutboundMediaUrls(payload);
      const requestedThreadId = readPositiveInt(payload.threadId);
      const requestedDiscordThreadId = readUnsignedNumericString(payload.threadId);
      const payloadOpenClawId = readNonEmptyString(payload.openclawId);

      if (tenant.authKind === "runtime-jwt") {
        if (!payloadOpenClawId || payloadOpenClawId !== tenant.id) {
          return {
            statusCode: 401,
            bodyText: JSON.stringify({
              ok: false,
              error: "openclawId mismatch",
            }),
          };
        }
      }

      if (!channel) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({ ok: false, error: "channel required" }),
        };
      }
      if (!sessionKey) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({ ok: false, error: "sessionKey required" }),
        };
      }
      if (operation.op === "action") {
        return await runOutboundAction({
          tenant,
          channel,
          sessionKey,
          action: operation.action,
        });
      }
      if (!hasText && mediaUrls.length === 0 && !rawOutbound) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({ ok: false, error: "text or mediaUrl(s) required" }),
        };
      }
      if (channel === "telegram") {
        const boundRoute = resolveTelegramBoundRoute({
          tenantId: tenant.id,
          channel,
          sessionKey,
        });
        if (!boundRoute) {
          return {
            statusCode: 403,
            bodyText: JSON.stringify({
              ok: false,
              error: "route not bound",
              code: "ROUTE_NOT_BOUND",
            }),
          };
        }

        const to = boundRoute.chatId;
        const messageThreadId = boundRoute.topicId ?? requestedThreadId;
        const isGeneralForumTopic =
          boundRoute.topicId === TELEGRAM_GENERAL_TOPIC_ID && to.startsWith("-");
        const telegramRaw = asRecord(rawOutbound?.telegram);
        const telegramRawMethod = readNonEmptyString(telegramRaw?.method);
        const telegramRawBody = asRecord(telegramRaw?.body);
        if (telegramRawMethod && telegramRawBody) {
          const telegramMethod =
            telegramRawMethod === "sendMessage" ||
            telegramRawMethod === "sendPhoto" ||
            telegramRawMethod === "sendChatAction" ||
            telegramRawMethod === "editMessageText" ||
            telegramRawMethod === "answerCallbackQuery"
              ? telegramRawMethod
              : null;
          if (!telegramMethod) {
            return {
              statusCode: 400,
              bodyText: JSON.stringify({
                ok: false,
                error: "unsupported telegram raw method",
              }),
            };
          }
          const finalBody: Record<string, unknown> = { ...telegramRawBody };
          if (telegramMethod !== "answerCallbackQuery") {
            finalBody.chat_id = to;
            const supportsThreadId =
              telegramMethod === "sendMessage" ||
              telegramMethod === "sendPhoto" ||
              telegramMethod === "sendChatAction";
            if (supportsThreadId) {
              if (boundRoute.topicId) {
                if (isGeneralForumTopic && telegramMethod !== "sendChatAction") {
                  delete finalBody.message_thread_id;
                } else {
                  finalBody.message_thread_id = boundRoute.topicId;
                }
              } else if (messageThreadId && !readPositiveInt(finalBody.message_thread_id)) {
                finalBody.message_thread_id = messageThreadId;
              }
            }
          }
          const { response, result } = await sendTelegram(telegramMethod, finalBody);
          if (!response.ok || result.ok !== true) {
            return {
              statusCode: 502,
              bodyText: JSON.stringify({
                ok: false,
                error: "telegram raw send failed",
                details: result,
              }),
            };
          }
          const resultData =
            typeof result.result === "object" && result.result
              ? (result.result as Record<string, unknown>)
              : {};
          const messageId =
            typeof resultData.message_id === "number" || typeof resultData.message_id === "string"
              ? String(resultData.message_id)
              : "unknown";
          return {
            statusCode: 200,
            bodyText: JSON.stringify({
              ok: true,
              messageId,
              providerMessageIds: [messageId],
              rawPassthrough: true,
            }),
          };
        }
        return {
          statusCode: 400,
          bodyText: JSON.stringify({
            ok: false,
            error: "telegram outbound requires raw.telegram.method and raw.telegram.body",
          }),
        };
      }

      if (channel === "discord") {
        const boundRoute = resolveDiscordBoundRoute({
          tenantId: tenant.id,
          channel,
          sessionKey,
        });
        if (!boundRoute) {
          return {
            statusCode: 403,
            bodyText: JSON.stringify({
              ok: false,
              error: "route not bound",
              code: "ROUTE_NOT_BOUND",
            }),
          };
        }

        const discordRaw = asRecord(rawOutbound?.discord);
        const discordRawBody = asRecord(discordRaw?.body);
        const discordRawSend = asRecord(discordRaw?.send);
        if (!discordRawBody && !discordRawSend) {
          return {
            statusCode: 400,
            bodyText: JSON.stringify({
              ok: false,
              error: "discord outbound requires raw.discord.body or raw.discord.send",
            }),
          };
        }

        const resolvedTarget = await resolveDiscordOutboundChannelId({
          boundRoute,
          requestedTo: payload.to,
          requestedThreadId: requestedDiscordThreadId,
        });
        if (!resolvedTarget.ok) {
          return {
            statusCode: resolvedTarget.statusCode,
            bodyText: JSON.stringify({ ok: false, error: resolvedTarget.error }),
          };
        }
        if (discordRawBody) {
          const { response, result } = await discordRequest({
            method: "POST",
            path: `/channels/${resolvedTarget.channelId}/messages`,
            body: discordRawBody,
          });
          if (!response.ok) {
            return {
              statusCode: 502,
              bodyText: JSON.stringify({
                ok: false,
                error: "discord raw send failed",
                details: result,
              }),
            };
          }
          const messageId = readUnsignedNumericString(result.id) ?? "unknown";
          const channelId =
            readUnsignedNumericString(result.channel_id) ?? resolvedTarget.channelId;
          return {
            statusCode: 200,
            bodyText: JSON.stringify({
              ok: true,
              messageId,
              channelId,
              providerMessageIds: [messageId],
              rawPassthrough: true,
            }),
          };
        }

        const { sendMessageDiscord } = await loadDiscordRuntimeModules();
        const outboundTarget = `channel:${resolvedTarget.channelId}`;
        const sendText =
          typeof discordRawSend?.text === "string"
            ? discordRawSend.text
            : typeof text === "string"
              ? text
              : "";
        const sendMediaUrl =
          readNonEmptyString(discordRawSend?.mediaUrl) ??
          (mediaUrls.length > 0 ? mediaUrls[0] : undefined);
        const sendReplyTo = readUnsignedNumericString(discordRawSend?.replyTo);
        const discordToken = requireDiscordBotToken();
        const discordRest = new RequestClient(discordToken, {
          baseUrl: discordApiBaseUrl,
          apiVersion: 10,
        });
        try {
          const sent = await sendMessageDiscord(outboundTarget, sendText, {
            token: discordToken,
            rest: discordRest,
            verbose: false,
            ...(sendMediaUrl ? { mediaUrl: sendMediaUrl } : {}),
            ...(sendReplyTo ? { replyTo: sendReplyTo } : {}),
          });
          const messageId = sent.messageId || "unknown";
          const channelId = sent.channelId || resolvedTarget.channelId;
          return {
            statusCode: 200,
            bodyText: JSON.stringify({
              ok: true,
              messageId,
              channelId,
              providerMessageIds: [messageId],
              rawPassthrough: true,
            }),
          };
        } catch (error) {
          return {
            statusCode: 502,
            bodyText: JSON.stringify({
              ok: false,
              error: "discord send failed",
              details: String(error),
            }),
          };
        }
      }

      if (channel === "whatsapp") {
        const boundRoute = resolveWhatsAppBoundRoute({
          tenantId: tenant.id,
          channel,
          sessionKey,
        });
        if (!boundRoute) {
          return {
            statusCode: 403,
            bodyText: JSON.stringify({
              ok: false,
              error: "route not bound",
              code: "ROUTE_NOT_BOUND",
            }),
          };
        }

        const { sendMessageWhatsApp } = await loadWebRuntimeModules();
        const whatsappRaw = asRecord(rawOutbound?.whatsapp);
        const whatsappRawSend = asRecord(whatsappRaw?.send);
        const whatsappText =
          typeof whatsappRawSend?.text === "string"
            ? whatsappRawSend.text
            : typeof text === "string"
              ? text
              : "";
        const whatsappRawSingleMedia = readNonEmptyString(whatsappRawSend?.mediaUrl);
        const whatsappRawMediaList =
          Array.isArray(whatsappRawSend?.mediaUrls) && whatsappRawSend
            ? (whatsappRawSend.mediaUrls as unknown[])
                .filter((item) => typeof item === "string")
                .map((item) => item.trim())
                .filter((item) => item.length > 0)
            : mediaUrls;
        const whatsappMediaUrls = (() => {
          const ordered = [
            ...(whatsappRawSingleMedia ? [whatsappRawSingleMedia] : []),
            ...whatsappRawMediaList,
          ];
          const seen = new Set<string>();
          const deduped: string[] = [];
          for (const media of ordered) {
            if (seen.has(media)) {
              continue;
            }
            seen.add(media);
            deduped.push(media);
          }
          return deduped;
        })();
        if (!whatsappText.trim() && whatsappMediaUrls.length === 0) {
          return {
            statusCode: 400,
            bodyText: JSON.stringify({
              ok: false,
              error: "whatsapp outbound requires text/media or raw.whatsapp.send",
            }),
          };
        }
        const whatsappGifPlayback = whatsappRawSend?.gifPlayback === true;

        const providerMessageIds: string[] = [];
        let firstMessageId = "unknown";
        let firstToJid = boundRoute.chatJid;
        try {
          if (whatsappMediaUrls.length === 0) {
            const sent = await sendMessageWhatsApp(boundRoute.chatJid, whatsappText, {
              verbose: false,
              accountId: boundRoute.accountId,
            });
            firstMessageId = sent.messageId || "unknown";
            firstToJid = sent.toJid || boundRoute.chatJid;
            providerMessageIds.push(firstMessageId);
          } else {
            const first = await sendMessageWhatsApp(boundRoute.chatJid, whatsappText, {
              verbose: false,
              mediaUrl: whatsappMediaUrls[0],
              ...(whatsappGifPlayback ? { gifPlayback: true } : {}),
              accountId: boundRoute.accountId,
            });
            firstMessageId = first.messageId || "unknown";
            firstToJid = first.toJid || boundRoute.chatJid;
            providerMessageIds.push(firstMessageId);
            for (const extraMediaUrl of whatsappMediaUrls.slice(1)) {
              const extra = await sendMessageWhatsApp(boundRoute.chatJid, "", {
                verbose: false,
                mediaUrl: extraMediaUrl,
                ...(whatsappGifPlayback ? { gifPlayback: true } : {}),
                accountId: boundRoute.accountId,
              });
              providerMessageIds.push(extra.messageId || "unknown");
            }
          }
        } catch (error) {
          return {
            statusCode: 502,
            bodyText: JSON.stringify({
              ok: false,
              error: "whatsapp send failed",
              details: String(error),
            }),
          };
        }

        return {
          statusCode: 200,
          bodyText: JSON.stringify({
            ok: true,
            messageId: firstMessageId,
            toJid: firstToJid,
            providerMessageIds,
            rawPassthrough: Boolean(whatsappRawSend),
          }),
        };
      }

      return {
        statusCode: 400,
        bodyText: JSON.stringify({ ok: false, error: "unsupported channel" }),
      };
    };

    const inflightKey = idempotencyKey ? resolveInflightKey(tenant.id, idempotencyKey) : undefined;
    const inflightEntry: InflightEntry = { fingerprint, promise: runSend() };
    if (inflightKey) {
      idempotencyInflight.set(inflightKey, inflightEntry);
    }

    const sendResult = await inflightEntry.promise;
    if (inflightKey && idempotencyKey) {
      idempotencyInflight.delete(inflightKey);
      storeIdempotency({
        tenantId: tenant.id,
        idempotencyKey,
        fingerprint,
        result: sendResult,
        now: Date.now(),
      });
    }

    res.writeHead(sendResult.statusCode, { "content-type": "application/json; charset=utf-8" });
    res.end(sendResult.bodyText);
  } catch (error) {
    if (error instanceof HttpBodyError) {
      sendJson(res, error.statusCode, { ok: false, error: error.message });
      return;
    }
    log({ type: "relay_error", error: String(error) });
    sendJson(res, 500, { ok: false, error: String(error) });
  }
});

server.listen(port, host, () => {
  const tenantTargetCount = countActiveTenantInboundTargets();
  log({
    type: "relay_started",
    host,
    port,
    dbPath,
    openclawMuxAccountId,
    tenantCount: tenantSeeds.length,
    pairingCodeSeedCount: pairingCodeSeeds.length,
  });
  console.log(`mux server listening on http://${host}:${port}`);
  if (whatsappInboundEnabled) {
    log({
      type: "whatsapp_inbound_started",
      tenantTargetCount,
      openclawAccountId: openclawMuxAccountId,
      accountId: whatsappAccountId,
      authDir: whatsappAuthDir,
      retryMs: Math.max(100, Math.trunc(whatsappInboundRetryMs)),
    });
    void runWhatsAppInboundLoop().catch((error) => {
      log({ type: "whatsapp_inbound_loop_fatal", error: String(error) });
    });
  }
  if (telegramInboundEnabled) {
    log({
      type: "telegram_inbound_started",
      tenantTargetCount,
      openclawAccountId: openclawMuxAccountId,
      pollTimeoutSec: Math.max(1, Math.trunc(telegramPollTimeoutSec)),
      pollRetryMs: Math.max(100, Math.trunc(telegramPollRetryMs)),
      bootstrapLatest: telegramBootstrapLatest,
    });
    void runTelegramInboundLoop().catch((error) => {
      log({ type: "telegram_inbound_loop_fatal", error: String(error) });
    });
  }
  if (discordInboundEnabled) {
    log({
      type: "discord_inbound_started",
      tenantTargetCount,
      openclawAccountId: openclawMuxAccountId,
      pollIntervalMs: Math.max(200, Math.trunc(discordPollIntervalMs)),
      bootstrapLatest: discordBootstrapLatest,
      gatewayDmEnabled: discordGatewayDmEnabled,
      gatewayGuildEnabled: discordGatewayGuildEnabled,
      gatewayIntents:
        Number.isFinite(discordGatewayIntents) && discordGatewayIntents > 0
          ? Math.trunc(discordGatewayIntents)
          : discordGatewayDefaultIntents,
    });
    void runDiscordInboundLoop().catch((error) => {
      log({ type: "discord_inbound_loop_fatal", error: String(error) });
    });
    if (discordGatewayDmEnabled || discordGatewayGuildEnabled) {
      void runDiscordGatewayDmLoop().catch((error) => {
        log({ type: "discord_gateway_dm_loop_fatal", error: String(error) });
      });
    }
  }
});
