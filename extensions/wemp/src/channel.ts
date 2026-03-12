import { createHash } from "node:crypto";
import type { ChannelPlugin, ChannelGatewayContext, ChannelStatusIssue, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  PAIRING_APPROVED_MESSAGE,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
} from "openclaw/plugin-sdk";
import { wempConfigSchema } from "./config-schema.js";
import { listWempAccountIds, resolveDefaultWempAccountId, resolveWempAccount, validateResolvedWempAccount, validateWempChannelConfig } from "./config.js";
import { defaultRuntime, markRuntimeConnected, markRuntimeError, mergeRuntimeSnapshot } from "./status.js";
import { resolveDmPolicy, collectWarnings } from "./security.js";
import {
  registerWempWebhook,
  unregisterWempWebhook,
  unregisterWempWebhookByAccountId,
} from "./webhook.js";
import { sendText } from "./outbound.js";
import {
  getAccessToken,
  uploadTempMedia,
  sendCustomFileMessage,
  sendCustomImageMessage,
  sendCustomVideoMessage,
  sendCustomVoiceMessage,
} from "./api.js";
import {
  applyWechatMenuConfig,
  buildAccountConfigSignature,
  buildMenuConfigSignature,
  normalizeMenuFeature,
  type MenuFeatureConfig,
} from "./features/menu.js";
import { createWempOnboarding } from "./onboarding.js";
import { flushPairingNotificationsToExternal } from "./pairing.js";
import { flushHandoffNotificationsToExternal } from "./features/handoff-notify.js";
import { clearWempRuntime, setWempRuntime } from "./runtime.js";
import { attachOpenClawLogBridge, detachOpenClawLogBridge } from "./log.js";
import { withTimeoutStatus } from "./timeout.js";
import { toRecord } from "./utils.js";
import type { ResolvedWempAccount } from "./types.js";

const activeAccounts = new Set<string>();
const appliedAccountStateByAccount = new Map<string, {
  signature: string;
  account: ResolvedWempAccount;
}>();
const stopAccountHandlersByAccount = new Map<string, () => void>();

interface MenuSyncState {
  accountSignature: string;
  menuSignature: string;
  lastSuccessfulMenu: Required<MenuFeatureConfig>;
}

const menuSyncStateByAccount = new Map<string, MenuSyncState>();
const PAIRING_NOTIFY_PUMP_INTERVAL_MS = Math.max(1_000, Number(process.env.WEMP_PAIRING_NOTIFY_PUMP_INTERVAL_MS || 5_000));
const HANDOFF_NOTIFY_PUMP_INTERVAL_MS = Math.max(1_000, Number(process.env.WEMP_HANDOFF_NOTIFY_PUMP_INTERVAL_MS || 5_000));
let pairingNotifyPumpTimer: ReturnType<typeof setInterval> | null = null;
let handoffNotifyPumpTimer: ReturnType<typeof setInterval> | null = null;

function startPairingNotifyPump(): void {
  if (pairingNotifyPumpTimer) return;
  pairingNotifyPumpTimer = setInterval(() => {
    void flushPairingNotificationsToExternal();
  }, PAIRING_NOTIFY_PUMP_INTERVAL_MS);
  (pairingNotifyPumpTimer as any)?.unref?.();
}

function stopPairingNotifyPump(): void {
  if (!pairingNotifyPumpTimer) return;
  clearInterval(pairingNotifyPumpTimer);
  pairingNotifyPumpTimer = null;
}

function startHandoffNotifyPump(): void {
  if (handoffNotifyPumpTimer) return;
  handoffNotifyPumpTimer = setInterval(() => {
    void flushHandoffNotificationsToExternal();
  }, HANDOFF_NOTIFY_PUMP_INTERVAL_MS);
  (handoffNotifyPumpTimer as any)?.unref?.();
}

function stopHandoffNotifyPump(): void {
  if (!handoffNotifyPumpTimer) return;
  clearInterval(handoffNotifyPumpTimer);
  handoffNotifyPumpTimer = null;
}

function extractMessageIdFromData(data: unknown): string | null {
  const record = toRecord(data);
  const fields = ["msgid", "msg_id", "messageId", "message_id", "msgId"];
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function extractMessageIdsFromOutboundResults(results: Array<{ data?: unknown }>): string[] {
  const ids = results
    .map((item) => extractMessageIdFromData(item?.data))
    .filter((id): id is string => Boolean(id));
  return Array.from(new Set(ids));
}

function buildTextReceiptMessageId(result: {
  accountId: string;
  target: string;
  chunks: string[];
  results: Array<{ ok: boolean; data?: unknown }>;
}): string {
  const upstreamIds = extractMessageIdsFromOutboundResults(result.results);
  if (upstreamIds.length > 0) {
    return `${result.accountId}:${result.target}:${upstreamIds.join(",")}`;
  }
  const hashSeed = [
    result.accountId,
    result.target,
    String(result.chunks.length),
    ...result.chunks,
    ...result.results.map((item) => String(item.ok)),
  ].join("\u001f");
  const digest = createHash("sha1").update(hashSeed).digest("hex").slice(0, 16);
  return `${result.accountId}:${result.target}:h${digest}`;
}

function firstOutboundFailure(result: {
  results: Array<{ ok: boolean; errcode?: number; errmsg?: string }>;
}): { errcode: number | string; errmsg: string } {
  const failed = result.results.find((item) => !item.ok);
  return {
    errcode: failed?.errcode ?? "unknown",
    errmsg: failed?.errmsg ?? "unknown",
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "unknown_error";
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return "unknown_error";
  return String(error);
}

type WempOutboundMediaType = "image" | "voice" | "video" | "file";

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isBlockedIpv4Host(hostname: string): boolean {
  const ip = parseIpv4(hostname);
  if (!ip) return false;
  const [a, b] = ip;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isBlockedIpv6Host(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase().split("%")[0] || "";
  if (!normalized) return false;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (
    normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
  ) return true;
  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.slice("::ffff:".length);
    return isBlockedIpv4Host(mappedIpv4);
  }
  return false;
}

function isBlockedLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (!normalized) return true;
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized.endsWith(".local")) return true;
  if (normalized === "host.docker.internal" || normalized === "gateway.docker.internal") return true;
  return false;
}

function validateOutboundMediaUrl(input: string): URL {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("wemp_media_url_rejected:empty_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("wemp_media_url_rejected:invalid_url");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`wemp_media_url_rejected:unsupported_protocol:${parsed.protocol}`);
  }
  const hostname = String(parsed.hostname || "").trim().toLowerCase();
  if (!hostname) {
    throw new Error("wemp_media_url_rejected:missing_host");
  }
  if (isBlockedLocalHostname(hostname)) {
    throw new Error(`wemp_media_url_rejected:blocked_host:${hostname}`);
  }
  if (isBlockedIpv4Host(hostname)) {
    throw new Error(`wemp_media_url_rejected:blocked_ipv4:${hostname}`);
  }
  if (hostname.includes(":") && isBlockedIpv6Host(hostname)) {
    throw new Error(`wemp_media_url_rejected:blocked_ipv6:${hostname}`);
  }
  if (hostname.startsWith("[") && isBlockedIpv6Host(hostname)) {
    throw new Error(`wemp_media_url_rejected:blocked_ipv6:${hostname}`);
  }
  return parsed;
}

function normalizeContentType(contentType: string): string {
  return String(contentType || "").split(";")[0]!.trim().toLowerCase();
}

function inferMediaTypeFromPathname(pathname: string): WempOutboundMediaType | null {
  const fileName = pathname.split("/").pop() || "";
  const suffix = fileName.includes(".") ? fileName.split(".").pop() : "";
  const ext = String(suffix || "").trim().toLowerCase();
  if (!ext) return null;
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext)) return "image";
  if (["amr", "mp3", "wav", "m4a", "aac", "ogg", "opus"].includes(ext)) return "voice";
  if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return "video";
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "zip"].includes(ext)) return "file";
  return null;
}

function resolveOutboundMediaType(contentType: string, pathname: string): WempOutboundMediaType {
  const normalizedContentType = normalizeContentType(contentType);
  if (normalizedContentType.startsWith("image/")) return "image";
  if (normalizedContentType.startsWith("audio/")) return "voice";
  if (normalizedContentType.startsWith("video/")) return "video";
  if (normalizedContentType === "application/pdf") return "file";
  if (normalizedContentType.startsWith("text/")) return "file";
  if (normalizedContentType.includes("officedocument")) return "file";
  const guessed = inferMediaTypeFromPathname(pathname);
  if (guessed) return guessed;
  if (normalizedContentType.startsWith("application/")) return "file";
  // 与既有行为兼容：未知类型默认按图片路径发送。
  return "image";
}

function sanitizeFileName(name: string): string {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.slice(0, 120);
}

function resolveOutboundFilename(pathname: string, mediaType: WempOutboundMediaType): string {
  const rawName = pathname.split("/").pop() || "";
  const sanitized = sanitizeFileName(rawName);
  if (sanitized) return sanitized;
  if (mediaType === "image") return "media.jpg";
  if (mediaType === "voice") return "media.amr";
  if (mediaType === "video") return "media.mp4";
  return "media.bin";
}

async function sendCustomMediaMessage(
  account: ResolvedWempAccount,
  target: string,
  mediaType: WempOutboundMediaType,
  mediaId: string,
) {
  if (mediaType === "voice") return sendCustomVoiceMessage(account, target, mediaId);
  if (mediaType === "video") return sendCustomVideoMessage(account, target, mediaId);
  if (mediaType === "file") return sendCustomFileMessage(account, target, mediaId);
  return sendCustomImageMessage(account, target, mediaId);
}

async function probeWempAccount(account: ResolvedWempAccount, timeoutMs: number): Promise<{
  ok: boolean;
  timedOut: boolean;
  elapsedMs: number;
  message?: string;
}> {
  const probeStart = Date.now();
  const timeout = Math.max(500, Math.floor(timeoutMs || 3_000));
  const probe = await withTimeoutStatus(getAccessToken(account, false), timeout);
  if (probe.timedOut || !probe.value) {
    return {
      ok: false,
      timedOut: true,
      elapsedMs: Date.now() - probeStart,
      message: "probe_timeout",
    };
  }
  return {
    ok: true,
    timedOut: false,
    elapsedMs: Date.now() - probeStart,
  };
}

function collectWempStatusIssues(accounts: Array<{
  accountId?: string;
  enabled?: boolean;
  configured?: boolean;
  running?: boolean;
  connected?: boolean;
  lastError?: string | null;
}>): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const account of accounts) {
    const accountId = String(account.accountId || "default");
    if (account.enabled && account.configured === false) {
      issues.push({
        channel: "wemp",
        accountId,
        kind: "config",
        message: "WeChat MP account is enabled but not configured",
      });
    }
    if (account.enabled && account.running && account.connected === false) {
      issues.push({
        channel: "wemp",
        accountId,
        kind: "runtime",
        message: "WeChat MP account is running but currently disconnected",
      });
    }
    if (account.lastError) {
      issues.push({
        channel: "wemp",
        accountId,
        kind: "runtime",
        message: `WeChat MP runtime error: ${account.lastError}`,
      });
    }
  }
  return issues;
}

interface AccountLifecycleContext {
  log?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  getStatus: () => Record<string, unknown>;
  setStatus: (status: Record<string, unknown>) => void;
}

function cloneAccountState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rememberAppliedAccount(account: ResolvedWempAccount): void {
  appliedAccountStateByAccount.set(account.accountId, {
    signature: buildAccountConfigSignature(account),
    account: cloneAccountState(account),
  });
}

function forgetAppliedAccount(accountId: string): void {
  appliedAccountStateByAccount.delete(accountId);
}

function restorePreviousAccount(accountId: string): ResolvedWempAccount | null {
  const previous = appliedAccountStateByAccount.get(accountId);
  if (!previous?.account?.enabled) return null;
  return cloneAccountState(previous.account);
}

function stopAccountRuntime(accountId: string): boolean {
  const stop = stopAccountHandlersByAccount.get(accountId);
  if (!stop) return false;
  stopAccountHandlersByAccount.delete(accountId);
  stop();
  forgetAppliedAccount(accountId);
  return true;
}

function syncMenuForAccount(account: ResolvedWempAccount, ctx: AccountLifecycleContext): void {
  const menuFeature = normalizeMenuFeature(account.features.menu);
  const accountSignature = buildAccountConfigSignature(account);
  const menuSignature = buildMenuConfigSignature(menuFeature);
  const previousMenuSyncState = menuSyncStateByAccount.get(account.accountId);
  const accountConfigChanged = !previousMenuSyncState || previousMenuSyncState.accountSignature !== accountSignature;
  const menuConfigChanged = !previousMenuSyncState || previousMenuSyncState.menuSignature !== menuSignature;
  const shouldSyncMenu = menuFeature.enabled
    ? accountConfigChanged || menuConfigChanged
    : Boolean(previousMenuSyncState && menuConfigChanged);
  if (!shouldSyncMenu) return;

  void (async () => {
    try {
      const syncResult = await applyWechatMenuConfig(account, menuFeature, {
        deleteWhenDisabled: !menuFeature.enabled || menuFeature.items.length === 0,
      });
      if (syncResult.ok) {
        menuSyncStateByAccount.set(account.accountId, {
          accountSignature,
          menuSignature,
          lastSuccessfulMenu: normalizeMenuFeature(menuFeature),
        });
        return;
      }

      const syncError = `menu_sync_failed:${syncResult.errcode ?? "unknown"}:${syncResult.errmsg ?? "unknown"}`;
      const rollbackMenu = previousMenuSyncState?.lastSuccessfulMenu;
      const shouldRollback = Boolean(rollbackMenu);
      if (shouldRollback && rollbackMenu) {
        const rollbackMenuSignature = buildMenuConfigSignature(rollbackMenu);
        const rollbackResult = await applyWechatMenuConfig(account, rollbackMenu, {
          deleteWhenDisabled: !rollbackMenu.enabled || rollbackMenu.items.length === 0,
        });
        if (rollbackResult.ok) {
          if (rollbackMenuSignature === menuSignature) {
            menuSyncStateByAccount.set(account.accountId, {
              accountSignature,
              menuSignature,
              lastSuccessfulMenu: normalizeMenuFeature(menuFeature),
            });
          }
          const rollbackMessage = `${syncError};rolled_back`;
          ctx.log?.warn?.(`[wemp:${account.accountId}] ${rollbackMessage}`);
          const nextSnapshot = markRuntimeError(account.accountId, rollbackMessage);
          ctx.setStatus({
            ...ctx.getStatus(),
            ...nextSnapshot,
          });
          return;
        }
        const rollbackError = `${syncError};rollback_failed:${rollbackResult.errcode ?? "unknown"}:${rollbackResult.errmsg ?? "unknown"}`;
        ctx.log?.warn?.(`[wemp:${account.accountId}] ${rollbackError}`);
        const nextSnapshot = markRuntimeError(account.accountId, rollbackError);
        ctx.setStatus({
          ...ctx.getStatus(),
          ...nextSnapshot,
        });
        return;
      }

      ctx.log?.warn?.(`[wemp:${account.accountId}] ${syncError}`);
      const nextSnapshot = markRuntimeError(account.accountId, syncError);
      ctx.setStatus({
        ...ctx.getStatus(),
        ...nextSnapshot,
      });
    } catch (error) {
      const unexpectedError = error instanceof Error ? error.message : String(error);
      const syncError = `menu_sync_failed:unexpected:${unexpectedError}`;
      ctx.log?.warn?.(`[wemp:${account.accountId}] ${syncError}`);
      const nextSnapshot = markRuntimeError(account.accountId, syncError);
      ctx.setStatus({
        ...ctx.getStatus(),
        ...nextSnapshot,
      });
    }
  })();
}

interface AccountActivationContext extends AccountLifecycleContext {
  runtime?: unknown;
}

function applyDisabledAccountState(accountId: string, ctx: AccountLifecycleContext): void {
  unregisterWempWebhookByAccountId(accountId);
  menuSyncStateByAccount.delete(accountId);
  forgetAppliedAccount(accountId);
  const disconnectedSnapshot = markRuntimeConnected(accountId, false);
  const errorSnapshot = markRuntimeError(accountId, "account_disabled");
  ctx.setStatus({
    ...ctx.getStatus(),
    ...disconnectedSnapshot,
    ...errorSnapshot,
    running: false,
    connected: false,
  });
}

function activateAccountRuntime(
  account: ResolvedWempAccount,
  ctx: AccountActivationContext,
  phase: "startAccount" | "reloadAccount",
): void {
  const runtimeCandidate = ctx.runtime || ctx;
  if (runtimeCandidate && typeof (runtimeCandidate as Record<string, unknown>).channel === "object") {
    setWempRuntime(runtimeCandidate as import("openclaw/plugin-sdk").PluginRuntime);
  } else {
    ctx.log?.warn?.(`[wemp:${account.accountId}] runtime dispatchInbound unavailable on ${phase} context`);
  }
  const registered = registerWempWebhook(account);
  mergeRuntimeSnapshot(account.accountId, ctx.getStatus());
  const connectedSnapshot = markRuntimeConnected(account.accountId, true, Date.now());
  ctx.setStatus({
    ...ctx.getStatus(),
    ...connectedSnapshot,
  });
  rememberAppliedAccount(account);
  const actionLabel = phase === "reloadAccount" ? "account reloaded" : "webhook registered";
  ctx.log?.info?.(`[wemp:${account.accountId}] ${actionLabel} at ${registered.path}`);
  syncMenuForAccount(account, ctx);
}

export const wempPlugin: ChannelPlugin<ResolvedWempAccount> = {
  id: "wemp",
  meta: {
    id: "wemp",
    label: "微信公众号",
    selectionLabel: "微信公众号 (plugin)",
    docsPath: "/channels/wemp",
    docsLabel: "wemp",
    blurb: "Official-style WeChat MP channel with paired/unpaired routing.",
    aliases: ["wechat"],
    order: 86,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.wemp"] },
  configSchema: wempConfigSchema,
  pairing: {
    idLabel: "wempOpenId",
    normalizeAllowEntry: (entry: string) => String(entry || "").trim(),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveWempAccount(cfg);
      if (!account.configured) return;
      const { sendCustomTextMessage } = await import("./api.js");
      await sendCustomTextMessage(account, id, PAIRING_APPROVED_MESSAGE);
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => (accountId || "default").trim(),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({ cfg, channelKey: "wemp", accountId, name }),
    validateInput: ({ cfg, accountId, input }) => {
      const current = resolveWempAccount(cfg, accountId);
      const nextAppId = String(input.appId || current.appId || "").trim();
      const nextAppSecret = String(input.appSecret || current.appSecret || "").trim();
      const nextToken = String(input.token || current.token || "").trim();
      if (!nextToken) {
        return "WeChat MP requires a verification token (--token).";
      }
      if (!nextAppId) {
        return "WeChat MP requires appId (--app-id).";
      }
      if (!nextAppSecret) {
        return "WeChat MP requires appSecret (--app-secret).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "wemp",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== "default"
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "wemp" })
          : namedConfig;
      const accountPatch: Record<string, unknown> = { enabled: true };
      if (input.appId) accountPatch.appId = input.appId;
      if (input.appSecret) accountPatch.appSecret = input.appSecret;
      if (input.token) accountPatch.token = input.token;
      if (input.encodingAESKey) accountPatch.encodingAESKey = input.encodingAESKey;
      if (input.webhookPath) accountPatch.webhookPath = input.webhookPath;
      if (accountId === "default") {
        return {
          ...next,
          channels: {
            ...next.channels,
            wemp: { ...(next.channels as Record<string, unknown>)?.wemp as Record<string, unknown>, ...accountPatch },
          },
        };
      }
      const existingWemp = (next.channels as Record<string, unknown>)?.wemp as Record<string, unknown> ?? {};
      const existingAccounts = (existingWemp.accounts ?? {}) as Record<string, unknown>;
      return {
        ...next,
        channels: {
          ...next.channels,
          wemp: {
            ...existingWemp,
            enabled: true,
            accounts: {
              ...existingAccounts,
              [accountId]: { ...(existingAccounts[accountId] as Record<string, unknown>), ...accountPatch },
            },
          },
        },
      };
    },
  },
  config: {
    listAccountIds: (cfg: OpenClawConfig) => listWempAccountIds(cfg),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string) => {
      const account = resolveWempAccount(cfg, accountId);
      const accountIssues = validateResolvedWempAccount(account);
      const channelIssues = validateWempChannelConfig(cfg);
      if (accountIssues.length || channelIssues.length) {
        account.configured = false;
      }
      return account;
    },
    defaultAccountId: (cfg: OpenClawConfig) => resolveDefaultWempAccountId(cfg),
    isConfigured: (account: { configured: boolean }) => account.configured,
    isEnabled: (account: ResolvedWempAccount) => account.enabled,
    disabledReason: () => "disabled in config (channels.wemp.enabled)",
    unconfiguredReason: (account: ResolvedWempAccount) => {
      const missing: string[] = [];
      if (!account.appId) missing.push("appId");
      if (!account.appSecret) missing.push("appSecret");
      if (!account.token) missing.push("token");
      return missing.length ? `missing ${missing.join(", ")}` : "not configured";
    },
    describeAccount: (account: ResolvedWempAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      webhookPath: account.webhookPath,
    }),
    setAccountEnabled: ({ cfg, accountId, enabled }: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) =>
      setAccountEnabledInConfigSection({ cfg, channelKey: "wemp", accountId, enabled }),
    deleteAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
      deleteAccountFromConfigSection({ cfg, channelKey: "wemp", accountId }),
    resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => {
      const account = resolveWempAccount(cfg, accountId ?? undefined);
      return account.dm.allowFrom;
    },
  },
  security: {
    resolveDmPolicy: ({ account }: { account: ResolvedWempAccount }) => resolveDmPolicy(account),
    collectWarnings: ({ account }: { account: ResolvedWempAccount }) => collectWarnings(account),
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 600,
    resolveTarget: ({ to }: { to?: string }) => {
      const target = String(to || "").trim();
      if (!target) return { ok: false as const, error: new Error("empty target openId") };
      return { ok: true as const, to: target };
    },
    sendText: async ({ cfg, to, text, accountId }: { cfg: OpenClawConfig; to: string; text: string; accountId?: string | null }) => {
      const account = resolveWempAccount(cfg, accountId ?? undefined);
      const result = await sendText(account, to, text);
      if (!result.ok) {
        const failure = firstOutboundFailure(result);
        throw new Error(`wemp_outbound_text_failed:${failure.errcode}:${failure.errmsg}`);
      }
      return {
        channel: "wemp" as const,
        messageId: buildTextReceiptMessageId(result),
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }: { cfg: OpenClawConfig; to: string; text: string; mediaUrl?: string; accountId?: string | null }) => {
      const account = resolveWempAccount(cfg, accountId ?? undefined);
      let mediaOnlyMessageId: string | null = null;
      if (mediaUrl) {
        const validatedUrl = validateOutboundMediaUrl(mediaUrl);
        let mediaResponse: Response;
        try {
          mediaResponse = await fetch(validatedUrl.toString(), { redirect: "error" });
        } catch (error) {
          throw new Error(`wemp_media_download_failed:${error instanceof Error ? error.message : String(error)}`);
        }
        if (!mediaResponse.ok) {
          throw new Error(`wemp_media_download_failed:http_${mediaResponse.status}`);
        }

        const mediaType = resolveOutboundMediaType(
          mediaResponse.headers.get("content-type") || "",
          validatedUrl.pathname,
        );
        const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
        const filename = resolveOutboundFilename(validatedUrl.pathname, mediaType);
        const uploaded = await uploadTempMedia(account, mediaType, bytes, filename);
        if (!uploaded.ok) {
          throw new Error(`wemp_media_upload_failed:${uploaded.errcode ?? "unknown"}:${uploaded.errmsg ?? "unknown"}`);
        }
        const mediaId = uploaded.data?.media_id;
        if (!mediaId) {
          throw new Error("wemp_media_upload_failed:missing_media_id");
        }

        const sent = await sendCustomMediaMessage(account, to, mediaType, mediaId);
        if (!sent.ok) {
          throw new Error(`wemp_media_send_failed:${sent.errcode ?? "unknown"}:${sent.errmsg ?? "unknown"}`);
        }
        const upstreamMediaId = extractMessageIdFromData(sent.data);
        mediaOnlyMessageId = upstreamMediaId
          ? `${account.accountId}:${to}:${upstreamMediaId}`
          : `${account.accountId}:${to}:media:${mediaId}`;
      }
      if (text) {
        const result = await sendText(account, to, text);
        if (!result.ok) {
          const failure = firstOutboundFailure(result);
          throw new Error(`wemp_outbound_text_failed:${failure.errcode}:${failure.errmsg}`);
        }
        return {
          channel: "wemp" as const,
          messageId: buildTextReceiptMessageId(result),
        };
      }
      return {
        channel: "wemp" as const,
        messageId: mediaOnlyMessageId ?? `${account.accountId}:${to}:media`,
      };
    },
  },
  gateway: {
    startAccount: async (ctx: ChannelGatewayContext<ResolvedWempAccount>) => {
      const account = ctx.account;
      const accountId = account.accountId;
      attachOpenClawLogBridge(accountId, ctx.log);
      activeAccounts.add(accountId);
      startPairingNotifyPump();
      startHandoffNotifyPump();

      const cleanupAccountContext = () => {
        detachOpenClawLogBridge(accountId);
        activeAccounts.delete(accountId);
        stopAccountHandlersByAccount.delete(accountId);
        forgetAppliedAccount(accountId);
        if (activeAccounts.size === 0) {
          stopPairingNotifyPump();
          stopHandoffNotifyPump();
          clearWempRuntime();
        }
      };

      const waitForAbort = (beforeCleanup?: () => void) => {
        let cleaned = false;
        let resolver: (() => void) | null = null;
        const runCleanup = () => {
          if (cleaned) return;
          cleaned = true;
          try {
            beforeCleanup?.();
          } finally {
            cleanupAccountContext();
            resolver?.();
            resolver = null;
          }
        };
        stopAccountHandlersByAccount.set(accountId, runCleanup);
        if (ctx.abortSignal.aborted) {
          runCleanup();
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          resolver = resolve;
          ctx.abortSignal.addEventListener("abort", () => {
            runCleanup();
          }, { once: true });
        });
      };

      const accountIssues = validateResolvedWempAccount(account);
      if (accountIssues.length) {
        const message = `invalid_account_config:${accountIssues.join("; ")}`;
        const snapshot = markRuntimeError(account.accountId, message);
        ctx.setStatus({
          ...ctx.getStatus(),
          ...snapshot,
          running: false,
          connected: false,
        });
        ctx.log?.error?.(`[wemp:${account.accountId}] ${message}`);
        return waitForAbort();
      }

      if (!account.enabled) {
        applyDisabledAccountState(account.accountId, ctx);
        ctx.log?.info?.(`[wemp:${account.accountId}] account disabled, skip webhook registration`);
        return waitForAbort(() => {
          unregisterWempWebhookByAccountId(account.accountId);
        });
      }

      activateAccountRuntime(account, ctx, "startAccount");
      return waitForAbort(() => {
        unregisterWempWebhook(account);
        const stopped = markRuntimeConnected(account.accountId, false);
        ctx.setStatus({
          ...ctx.getStatus(),
          ...stopped,
        });
      });
    },
    reloadAccount: async (ctx: ChannelGatewayContext<ResolvedWempAccount>) => {
      const account = ctx.account;
      const accountId = account.accountId;
      attachOpenClawLogBridge(accountId, ctx.log);
      const nextSignature = buildAccountConfigSignature(account);
      const previousApplied = appliedAccountStateByAccount.get(accountId);
      if (previousApplied?.signature === nextSignature) {
        ctx.log?.info?.(`[wemp:${accountId}] reload skipped, config unchanged`);
        return;
      }

      const accountIssues = validateResolvedWempAccount(account);
      if (accountIssues.length) {
        const message = `invalid_account_config:${accountIssues.join("; ")}`;
        const rollbackAccount = restorePreviousAccount(accountId);
        if (rollbackAccount) {
          const registered = registerWempWebhook(rollbackAccount);
          const connectedSnapshot = markRuntimeConnected(accountId, true, Date.now());
          const rollbackMessage = `reload_rolled_back:${message}`;
          const errorSnapshot = markRuntimeError(accountId, rollbackMessage);
          ctx.setStatus({
            ...ctx.getStatus(),
            ...connectedSnapshot,
            ...errorSnapshot,
          });
          ctx.log?.warn?.(`[wemp:${accountId}] ${rollbackMessage}; restored webhook ${registered.path}`);
          return;
        }
        unregisterWempWebhookByAccountId(accountId);
        const snapshot = markRuntimeError(accountId, message);
        ctx.setStatus({
          ...ctx.getStatus(),
          ...snapshot,
          running: false,
          connected: false,
        });
        ctx.log?.error?.(`[wemp:${accountId}] ${message}`);
        return;
      }

      if (!account.enabled) {
        applyDisabledAccountState(accountId, ctx);
        ctx.log?.info?.(`[wemp:${accountId}] account disabled on reload, webhook unregistered`);
        return;
      }

      activateAccountRuntime(account, ctx, "reloadAccount");
    },
    stopAccount: async (ctx: ChannelGatewayContext<ResolvedWempAccount>) => {
      const accountId = String(ctx?.account?.accountId || "").trim();
      if (!accountId) return;
      const stopped = stopAccountRuntime(accountId);
      unregisterWempWebhookByAccountId(accountId);
      menuSyncStateByAccount.delete(accountId);
      const disconnectedSnapshot = markRuntimeConnected(accountId, false);
      const errorSnapshot = markRuntimeError(accountId, "account_stopped");
      ctx.setStatus?.({
        ...(ctx.getStatus?.() || {}),
        ...disconnectedSnapshot,
        ...errorSnapshot,
        running: false,
        connected: false,
      });
      if (!stopped) {
        detachOpenClawLogBridge(accountId);
      }
      ctx.log?.info?.(`[wemp:${accountId}] account stopped`);
    },
  },
  status: {
    defaultRuntime: defaultRuntime(),
    collectStatusIssues: (accounts) => collectWempStatusIssues(accounts),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      webhookPath: snapshot.webhookPath ?? null,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      try {
        return await probeWempAccount(account, timeoutMs);
      } catch (error) {
        return {
          ok: false,
          timedOut: false,
          elapsedMs: 0,
          message: toErrorMessage(error),
        };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }: { account: ResolvedWempAccount; runtime?: unknown; probe?: unknown }) => {
      const mergedRuntime = mergeRuntimeSnapshot(account.accountId, runtime);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        webhookPath: account.webhookPath,
        running: mergedRuntime.running,
        connected: mergedRuntime.connected,
        lastConnectedAt: mergedRuntime.lastConnectedAt,
        lastInboundAt: mergedRuntime.lastInboundAt,
        lastOutboundAt: mergedRuntime.lastOutboundAt,
        lastError: mergedRuntime.lastError,
        probe,
      };
    },
  },
  messaging: {
    normalizeTarget: (target: string) => String(target || "").trim(),
    targetResolver: {
      looksLikeId: (value: string) => /^[a-zA-Z0-9_-]{10,}$/.test(String(value || "").trim()),
      hint: "<openId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveWempAccount(cfg, accountId);
      const q = query?.trim().toLowerCase() || "";
      const peers = Array.from(
        new Set(
          account.dm.allowFrom
            .map((entry: string) => String(entry).trim())
            .filter((entry: string) => Boolean(entry) && entry !== "*"),
        ),
      )
        .filter((id: string) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id: string) => ({ kind: "user" as const, id }));
      return peers;
    },
    listGroups: async () => [],
  },
  onboarding: createWempOnboarding(),
};
