import type {
  ChannelGroupContext,
  ChannelPlugin,
  GroupToolPolicyConfig,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk";
import {
  listSimplexAccountIds,
  resolveDefaultSimplexAccountId,
  resolveSimplexAccount,
} from "./accounts.js";
import { simplexMessageActions } from "./actions.js";
import { SimplexChannelConfigSchema } from "./config-schema.js";
import { simplexOnboardingAdapter } from "./onboarding.js";
import { startSimplexCli } from "./simplex-cli.js";
import { buildSendMessagesCommand, type SimplexComposedMessage } from "./simplex-commands.js";
import {
  listSimplexDirectoryGroups,
  listSimplexDirectoryPeers,
  listSimplexGroupMembers,
  resolveSimplexSelf,
  resolveSimplexTargets,
} from "./simplex-directory.js";
import { resolveSimplexCommandError } from "./simplex-errors.js";
import { buildComposedMessages } from "./simplex-media.js";
import { startSimplexMonitor } from "./simplex-monitor.js";
import { formatSimplexAllowFrom, resolveSimplexAllowFrom } from "./simplex-security.js";
import { SimplexWsClient } from "./simplex-ws-client.js";
import type { ResolvedSimplexAccount } from "./types.js";

const activeClients = new Map<string, SimplexWsClient>();
const SIMPLEX_LINK_REGEX = /\b(simplex:\/\/[^\s"'<>]+|https?:\/\/[^\s"'<>]+)/gi;

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStrings(entry, out));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((entry) => collectStrings(entry, out));
  }
}

function extractSimplexAddressLink(resp: unknown): string | null {
  const strings: string[] = [];
  collectStrings(resp, strings);
  const matches: string[] = [];
  for (const str of strings) {
    for (const match of str.matchAll(SIMPLEX_LINK_REGEX)) {
      const raw = match[0];
      const cleaned = raw.replace(/[),.\]]+$/g, "");
      matches.push(cleaned);
    }
  }
  const preferred = matches.find((entry) => /simplex/i.test(entry));
  return preferred ?? matches[0] ?? null;
}

function extractSimplexWsUrlFromApplication(application: unknown): string | undefined {
  if (!application || typeof application !== "object") {
    return undefined;
  }
  const value = (application as { wsUrl?: unknown }).wsUrl;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSimplexMessageId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

function stripSimplexPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("simplex:")
    ? trimmed.slice("simplex:".length).trim()
    : trimmed;
}

function stripLeadingAt(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

async function sleep(ms: number, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) {
    throw new Error("SimpleX connect aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("SimpleX connect aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", onAbort);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForSimplexWs(params: {
  account: ResolvedSimplexAccount;
  abortSignal: AbortSignal;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
  };
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}): Promise<void> {
  const attempts = params.attempts ?? 6;
  let delayMs = params.baseDelayMs ?? 300;
  const maxDelayMs = params.maxDelayMs ?? 2_000;
  const connectTimeoutMs = Math.min(
    2_000,
    params.account.config.connection?.connectTimeoutMs ?? 2_000,
  );

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (params.abortSignal.aborted) {
      throw new Error("SimpleX connect aborted");
    }
    const client = new SimplexWsClient({ url: params.account.wsUrl, connectTimeoutMs });
    try {
      await client.connect();
      await client.close().catch(() => undefined);
      return;
    } catch (err) {
      await client.close().catch(() => undefined);
      if (attempt >= attempts) {
        throw err;
      }
      params.log?.debug?.(
        `[${params.account.accountId}] SimpleX preflight failed (attempt ${attempt}/${attempts}): ${String(
          err,
        )}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs, params.abortSignal);
      delayMs = Math.min(maxDelayMs, delayMs * 2);
    }
  }
}

function resolveSimplexGroupRequireMention(params: ChannelGroupContext): boolean | undefined {
  const account = resolveSimplexAccount({ cfg: params.cfg, accountId: params.accountId });
  const groups = account.config.groups ?? {};
  const groupId = params.groupId?.trim();
  const entry = groupId ? groups[groupId] : undefined;
  const fallback = groups["*"];
  if (typeof entry?.requireMention === "boolean") {
    return entry.requireMention;
  }
  if (typeof fallback?.requireMention === "boolean") {
    return fallback.requireMention;
  }
  return undefined;
}

function resolveSimplexGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const account = resolveSimplexAccount({ cfg: params.cfg, accountId: params.accountId });
  const groups = account.config.groups ?? {};
  const groupId = params.groupId?.trim();
  const candidates = [groupId, "*"].filter((value): value is string => Boolean(value));
  for (const key of candidates) {
    const entry = groups[key];
    if (entry?.tools) {
      return entry.tools;
    }
  }
  return undefined;
}

function normalizeSimplexContactRef(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("@")) {
    return trimmed;
  }
  const lowered = trimmed.toLowerCase();
  if (
    lowered.startsWith("contact:") ||
    lowered.startsWith("user:") ||
    lowered.startsWith("member:") ||
    lowered.startsWith("simplex:")
  ) {
    return `@${trimmed.slice(trimmed.indexOf(":") + 1).trim()}`;
  }
  return `@${trimmed}`;
}

async function withSimplexClient<T>(
  account: ResolvedSimplexAccount,
  fn: (client: SimplexWsClient) => Promise<T>,
): Promise<T> {
  const existing = activeClients.get(account.accountId);
  if (existing) {
    await existing.connect();
    return await fn(existing);
  }
  const client = new SimplexWsClient({
    url: account.wsUrl,
    connectTimeoutMs: account.config.connection?.connectTimeoutMs,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function sendComposedMessages(params: {
  account: ResolvedSimplexAccount;
  chatRef: string;
  composedMessages: SimplexComposedMessage[];
}): Promise<{ messageId?: string }> {
  if (params.composedMessages.length === 0) {
    return {};
  }
  const cmd = buildSendMessagesCommand({
    chatRef: params.chatRef,
    composedMessages: params.composedMessages,
  });
  const response = await withSimplexClient(params.account, (client) => client.sendCommand(cmd));
  const resp = response.resp as {
    type?: string;
    chatError?: { errorType?: { type?: string; message?: string } };
    chatItems?: Array<{ chatItem?: { meta?: { itemId?: unknown } } }>;
    itemId?: unknown;
    messageId?: unknown;
  };
  const commandError = resolveSimplexCommandError(resp);
  if (commandError) {
    throw new Error(commandError);
  }
  const messageId =
    normalizeSimplexMessageId(resp.chatItems?.[0]?.chatItem?.meta?.itemId) ??
    normalizeSimplexMessageId(resp.messageId) ??
    normalizeSimplexMessageId(resp.itemId);
  return { messageId };
}

function assertSimplexOutboundAccountReady(account: ResolvedSimplexAccount): void {
  if (!account.enabled) {
    throw new Error(`SimpleX account "${account.accountId}" is disabled`);
  }
  if (!account.configured) {
    throw new Error(`SimpleX account "${account.accountId}" is not configured`);
  }
}

export const simplexPlugin: ChannelPlugin<ResolvedSimplexAccount> = {
  id: "simplex",
  meta: {
    id: "simplex",
    label: "SimpleX",
    selectionLabel: "SimpleX (CLI)",
    docsPath: "/channels/simplex",
    blurb: "SimpleX Chat via local CLI WebSocket API",
    order: 95,
    quickstartAllowFrom: true,
  },
  onboarding: simplexOnboardingAdapter,
  pairing: {
    idLabel: "simplexContactId",
    normalizeAllowEntry: (entry) => stripLeadingAt(stripSimplexPrefix(entry)),
    notifyApproval: async ({ cfg, id }) => {
      const accountId = resolveDefaultSimplexAccountId(cfg);
      const account = resolveSimplexAccount({ cfg, accountId });
      assertSimplexOutboundAccountReady(account);
      const composedMessages = await buildComposedMessages({
        cfg,
        accountId,
        text: PAIRING_APPROVED_MESSAGE,
      });
      await sendComposedMessages({
        account,
        chatRef: normalizeSimplexContactRef(id),
        composedMessages,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    unsend: true,
    reply: true,
    groupManagement: true,
  },
  reload: { configPrefixes: ["channels.simplex"] },
  configSchema: SimplexChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listSimplexAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSimplexAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSimplexAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      mode: account.mode,
      application: {
        wsUrl: account.wsUrl,
      },
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveSimplexAllowFrom({ cfg, accountId }),
    formatAllowFrom: ({ allowFrom }) => formatSimplexAllowFrom(allowFrom),
  },
  messaging: {
    normalizeTarget: (raw) => stripSimplexPrefix(raw),
    targetResolver: {
      looksLikeId: (input) => input.trim().startsWith("@") || input.trim().startsWith("#"),
      hint: "@<contactId> or #<groupId>",
    },
  },
  actions: simplexMessageActions,
  directory: {
    self: async ({ cfg, accountId, runtime }) => resolveSimplexSelf({ cfg, accountId, runtime }),
    listPeers: async (params) => listSimplexDirectoryPeers(params),
    listGroups: async (params) => listSimplexDirectoryGroups(params),
    listGroupMembers: async (params) => listSimplexGroupMembers(params),
    listPeersLive: async (params) => listSimplexDirectoryPeers(params),
    listGroupsLive: async (params) => listSimplexDirectoryGroups(params),
  },
  resolver: {
    resolveTargets: async (params) => resolveSimplexTargets(params),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.simplex?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.simplex.accounts.${resolvedAccountId}.`
        : "channels.simplex.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("simplex"),
        normalizeEntry: (raw) => stripLeadingAt(stripSimplexPrefix(raw)),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- SimpleX groups: groupPolicy="open" allows any member to trigger the bot. Set channels.simplex.groupPolicy="allowlist" + channels.simplex.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: resolveSimplexGroupRequireMention,
    resolveToolPolicy: resolveSimplexGroupToolPolicy,
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendPayload: async ({ cfg, to, payload, accountId }) => {
      const account = resolveSimplexAccount({ cfg, accountId });
      assertSimplexOutboundAccountReady(account);
      const composedMessages = await buildComposedMessages({
        cfg,
        accountId,
        text: payload.text,
        mediaUrls: payload.mediaUrls,
        mediaUrl: payload.mediaUrl,
        audioAsVoice: payload.audioAsVoice,
      });
      const result = await sendComposedMessages({
        account,
        chatRef: to,
        composedMessages,
      });
      return {
        channel: "simplex",
        messageId: result.messageId ?? "unknown",
        chatId: to,
      };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveSimplexAccount({ cfg, accountId });
      assertSimplexOutboundAccountReady(account);
      const composedMessages = await buildComposedMessages({
        cfg,
        accountId,
        text,
      });
      const result = await sendComposedMessages({ account, chatRef: to, composedMessages });
      return {
        channel: "simplex",
        messageId: result.messageId ?? "unknown",
        chatId: to,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      if (!mediaUrl) {
        return { channel: "simplex", messageId: "empty", chatId: to };
      }
      const account = resolveSimplexAccount({ cfg, accountId });
      assertSimplexOutboundAccountReady(account);
      const composedMessages = await buildComposedMessages({
        cfg,
        accountId,
        text,
        mediaUrl,
      });
      const result = await sendComposedMessages({ account, chatRef: to, composedMessages });
      return {
        channel: "simplex",
        messageId: result.messageId ?? "unknown",
        chatId: to,
        meta: { mediaUrl },
      };
    },
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
            channel: "simplex",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot, account }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      mode: snapshot.mode ?? null,
      wsUrl: extractSimplexWsUrlFromApplication(snapshot.application) ?? account.wsUrl ?? null,
    }),
    buildAccountSnapshot: async ({ account, runtime }) => {
      let addressLink: string | null = null;
      const shouldProbeAddress =
        account.enabled && account.configured && (runtime?.running ?? false);
      if (shouldProbeAddress) {
        try {
          const response = await withSimplexClient(account, (client) =>
            client.sendCommand("/show_address"),
          );
          addressLink = extractSimplexAddressLink(response);
        } catch {
          // Keep status snapshot resilient when CLI/WebSocket is unavailable.
        }
      }
      const wsUrl = extractSimplexWsUrlFromApplication(runtime?.application) ?? account.wsUrl;
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: runtime?.mode ?? account.mode,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
        application: {
          addressLink,
          wsUrl,
        },
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        mode: account.mode,
        application: { wsUrl: account.wsUrl },
      });

      let cliHandle: ReturnType<typeof startSimplexCli> | null = null;
      if (account.mode === "managed") {
        cliHandle = startSimplexCli({
          cliPath: account.cliPath,
          wsPort: account.wsPort,
          dataDir: account.dataDir,
          log: ctx.log,
        });
        let cliReady = false;
        try {
          await cliHandle.ready;
          cliReady = true;
          await waitForSimplexWs({ account, abortSignal: ctx.abortSignal, log: ctx.log });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          ctx.setStatus({
            accountId: account.accountId,
            running: false,
            lastError: cliReady
              ? `SimpleX CLI not ready: ${detail}`
              : `SimpleX CLI failed: ${detail}`,
          });
          await cliHandle.stop().catch(() => undefined);
          throw err;
        }
      }

      const monitor = await startSimplexMonitor({
        account,
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });

      activeClients.set(account.accountId, monitor.client);

      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });

      activeClients.delete(account.accountId);
      await monitor.client.close().catch(() => undefined);
      await cliHandle?.stop().catch(() => undefined);
    },
    stopAccount: async (ctx) => {
      const client = activeClients.get(ctx.account.accountId);
      if (client) {
        await client.close();
        activeClients.delete(ctx.account.accountId);
      }
    },
  },
};
