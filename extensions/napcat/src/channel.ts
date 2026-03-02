import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelAccountSnapshot,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { waitForAbortSignal } from "./abort-signal.js";
import {
  listNapCatAccountIds,
  resolveDefaultNapCatAccountId,
  resolveNapCatAccount,
} from "./accounts.js";
import { NapCatConfigSchema } from "./config-schema.js";
import { normalizeNapCatAllowFrom, processNapCatEvent } from "./inbound.js";
import { startNapCatHttpMonitor } from "./monitor-http.js";
import { startNapCatWsMonitor } from "./monitor-ws.js";
import { napcatOnboardingAdapter } from "./onboarding.js";
import { sendNapCatMedia, sendNapCatText } from "./send.js";
import { normalizeNapCatAllowEntry, parseNapCatTarget, resolveNapCatTarget } from "./targets.js";
import { getNapCatRuntime } from "./runtime.js";
import type { NapCatConfig, ResolvedNapCatAccount } from "./types.js";

const meta = {
  id: "napcat",
  label: "NapCat",
  selectionLabel: "NapCat (QQ / OneBot11)",
  detailLabel: "NapCat QQ",
  docsPath: "/channels/napcat",
  docsLabel: "napcat",
  blurb: "QQ via NapCat OneBot11 with HTTP and WebSocket inbound support.",
  aliases: ["qq", "onebot", "onebot11"],
  order: 72,
  quickstartAllowFrom: true,
};

function setNapCatEnabled(cfg: OpenClawConfig, enabled: boolean): OpenClawConfig {
  const section = (cfg.channels?.napcat as NapCatConfig | undefined) ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      napcat: {
        ...section,
        enabled,
      },
    },
  };
}

function deleteNapCatSection(cfg: OpenClawConfig): OpenClawConfig {
  const next = { ...cfg } as OpenClawConfig;
  if (!next.channels) {
    return next;
  }
  const channels = { ...next.channels } as Record<string, unknown>;
  delete channels.napcat;
  if (Object.keys(channels).length === 0) {
    delete next.channels;
    return next;
  }
  next.channels = channels as OpenClawConfig["channels"];
  return next;
}

export const napcatPlugin: ChannelPlugin<ResolvedNapCatAccount> = {
  id: "napcat",
  meta,
  onboarding: napcatOnboardingAdapter,
  pairing: {
    idLabel: "qqUserId",
    normalizeAllowEntry: (entry) => normalizeNapCatAllowEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveNapCatAccount({ cfg });
      if (!account.configured) {
        return;
      }
      await sendNapCatText({
        account,
        to: `user:${normalizeNapCatAllowEntry(id)}`,
        text: "OpenClaw: your access has been approved.",
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.napcat"] },
  configSchema: buildChannelConfigSchema(NapCatConfigSchema),
  config: {
    listAccountIds: (cfg) => listNapCatAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNapCatAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNapCatAccountId(cfg),
    setAccountEnabled: ({ cfg, enabled }) => setNapCatEnabled(cfg, enabled),
    deleteAccount: ({ cfg }) => deleteNapCatSection(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      tokenSource: account.tokenSource,
      baseUrl: account.apiBaseUrl ? "[set]" : "[missing]",
      mode: `${account.transport.http.enabled ? "http" : ""}${account.transport.ws.enabled ? "+ws" : ""}`,
    }),
    resolveAllowFrom: ({ cfg }) =>
      (resolveNapCatAccount({ cfg }).config.dm?.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) => normalizeNapCatAllowFrom(allowFrom),
    resolveDefaultTo: ({ cfg }) => resolveNapCatAccount({ cfg }).config.defaultTo?.trim() || undefined,
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dm?.policy ?? "pairing",
      allowFrom: account.config.dm?.allowFrom ?? [],
      policyPath: "channels.napcat.dm.policy",
      allowFromPath: "channels.napcat.dm.allowFrom",
      approveHint: formatPairingApproveHint("napcat"),
      normalizeEntry: (raw) => normalizeNapCatAllowEntry(raw),
    }),
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      if (!account.token?.trim()) {
        warnings.push("- NapCat token is missing. Set channels.napcat.token.");
      }
      if (!account.apiBaseUrl?.trim()) {
        warnings.push("- NapCat apiBaseUrl is missing. Set channels.napcat.apiBaseUrl.");
      }
      if (!account.transport.http.enabled && !account.transport.ws.enabled) {
        warnings.push("- NapCat inbound is disabled. Enable transport.http or transport.ws.");
      }
      if (account.config.dm?.policy === "open") {
        warnings.push(
          '- NapCat DMs are open to anyone. Set channels.napcat.dm.policy="pairing" or "allowlist".',
        );
      }
      if (account.config.groupPolicy === "open") {
        warnings.push(
          '- NapCat groups use groupPolicy="open". Consider "allowlist" for production safety.',
        );
      }
      if (cfg.channels?.napcat && account.transport.http.enabled && account.transport.http.host !== "127.0.0.1") {
        warnings.push(
          `- NapCat HTTP webhook binds to ${account.transport.http.host}. Prefer 127.0.0.1 unless you need remote ingress.`,
        );
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, groupId }) => {
      const account = resolveNapCatAccount({ cfg });
      if (!groupId) {
        return true;
      }
      const exact = account.config.groups?.[groupId];
      const wildcard = account.config.groups?.["*"];
      return exact?.requireMention ?? wildcard?.requireMention ?? true;
    },
  },
  threading: {
    resolveReplyToMode: ({ cfg }) =>
      (resolveNapCatAccount({ cfg }).config.replyToMode as "off" | "first" | "all" | undefined) ??
      "off",
  },
  messaging: {
    normalizeTarget: (raw) => parseNapCatTarget(raw)?.to,
    targetResolver: {
      looksLikeId: (raw) => Boolean(parseNapCatTarget(raw)),
      hint: "<user:qq|group:qq>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit }) => {
      const account = resolveNapCatAccount({ cfg });
      const q = query?.trim().toLowerCase() || "";
      const ids = normalizeNapCatAllowFrom(account.config.dm?.allowFrom)
        .filter((entry) => entry !== "*")
        .map((entry) => `user:${entry}`);
      return ids
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
    },
    listGroups: async ({ cfg, query, limit }) => {
      const account = resolveNapCatAccount({ cfg });
      const q = query?.trim().toLowerCase() || "";
      const ids = Object.keys(account.config.groups ?? {})
        .filter((id) => id !== "*")
        .map((id) => `group:${id}`);
      return ids
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "napcat",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.token?.trim()) {
        return "NapCat requires --token.";
      }
      if (!input.url?.trim()) {
        return "NapCat requires --url (NapCat API base URL).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const section = (cfg.channels?.napcat as NapCatConfig | undefined) ?? {};
      const httpHost = input.httpHost?.trim();
      const httpPort = input.httpPort ? Number.parseInt(input.httpPort, 10) : undefined;
      const webhookPath = input.webhookPath?.trim();
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          napcat: {
            ...section,
            enabled: true,
            token: input.token?.trim() || section.token,
            apiBaseUrl: input.url?.trim() || section.apiBaseUrl,
            transport: {
              ...section.transport,
              http: {
                ...section.transport?.http,
                ...(httpHost ? { host: httpHost } : {}),
                ...(typeof httpPort === "number" && Number.isInteger(httpPort) ? { port: httpPort } : {}),
                ...(webhookPath ? { path: webhookPath } : {}),
              },
              ws: {
                ...section.transport?.ws,
              },
            },
          } as NapCatConfig,
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getNapCatRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 1800,
    resolveTarget: ({ to, mode, allowFrom }) => resolveNapCatTarget({ to, mode, allowFrom }),
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const account = resolveNapCatAccount({ cfg, accountId });
      const sent = await sendNapCatText({
        account,
        to,
        text,
        replyToId,
      });
      return {
        channel: "napcat",
        messageId: sent.messageId,
        chatId: sent.target.id,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
      if (!mediaUrl) {
        throw new Error("NapCat mediaUrl is required");
      }
      const account = resolveNapCatAccount({ cfg, accountId });
      const sent = await sendNapCatMedia({
        account,
        to,
        mediaUrl,
        caption: text,
        replyToId,
      });
      return {
        channel: "napcat",
        messageId: sent.messageId,
        chatId: sent.target.id,
      };
    },
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      reconnectAttempts: snapshot.reconnectAttempts ?? 0,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastDisconnect: snapshot.lastDisconnect ?? null,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      tokenSource: account.tokenSource,
      baseUrl: account.apiBaseUrl ? "[set]" : "[missing]",
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      reconnectAttempts: runtime?.reconnectAttempts ?? 0,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("napcat", accounts),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.enabled) {
        return;
      }
      if (!account.token?.trim()) {
        throw new Error("NapCat token is missing");
      }
      if (!account.apiBaseUrl?.trim()) {
        throw new Error("NapCat apiBaseUrl is missing");
      }
      if (!account.transport.http.enabled && !account.transport.ws.enabled) {
        throw new Error("NapCat inbound transport disabled (enable http or ws)");
      }

      ctx.setStatus({
        accountId: ctx.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      let httpConnected = false;
      let wsConnected = false;
      // Aggregate transport connectivity so a single transport outage does not
      // mark the account unhealthy while the other inbound path is still live.
      const resolveConnected = () => {
        if (account.transport.http.enabled && account.transport.ws.enabled) {
          return httpConnected || wsConnected;
        }
        if (account.transport.http.enabled) {
          return httpConnected;
        }
        if (account.transport.ws.enabled) {
          return wsConnected;
        }
        return false;
      };
      const statusSink = (patch: Partial<ChannelAccountSnapshot>) => {
        ctx.setStatus({
          accountId: ctx.accountId,
          ...patch,
        });
      };
      const makeTransportStatusSink = (transport: "http" | "ws") => {
        return (patch: Partial<ChannelAccountSnapshot>) => {
          const nextPatch: Partial<ChannelAccountSnapshot> = { ...patch };
          let shouldRecomputeConnected = false;

          if (transport === "http") {
            if (typeof patch.connected === "boolean") {
              httpConnected = patch.connected;
              shouldRecomputeConnected = true;
            }
          } else {
            if (typeof patch.connected === "boolean") {
              wsConnected = patch.connected;
              shouldRecomputeConnected = true;
            } else if (patch.lastDisconnect !== undefined) {
              wsConnected = false;
              shouldRecomputeConnected = true;
            } else if (typeof patch.lastConnectedAt === "number") {
              wsConnected = true;
              shouldRecomputeConnected = true;
            } else if (typeof patch.reconnectAttempts === "number" && patch.reconnectAttempts > 0) {
              wsConnected = false;
              shouldRecomputeConnected = true;
            }
          }

          if (shouldRecomputeConnected) {
            nextPatch.connected = resolveConnected();
          }

          statusSink(nextPatch);
        };
      };

      const stoppers: Array<() => void | Promise<void>> = [];
      let fatalError: unknown;

      try {
        if (account.transport.http.enabled) {
          ctx.log?.info(
            `[${account.accountId}] napcat http inbound listening on ${account.transport.http.host}:${account.transport.http.port}${account.transport.http.path}`,
          );
          const httpHandle = await startNapCatHttpMonitor({
            account,
            config: ctx.cfg,
            runtime: ctx.runtime,
            statusSink: makeTransportStatusSink("http"),
          });
          stoppers.push(async () => {
            await httpHandle.stop();
          });
        }

        if (account.transport.ws.enabled) {
          ctx.log?.info(`[${account.accountId}] napcat ws inbound connecting to ${account.transport.ws.url}`);
          const wsHandle = startNapCatWsMonitor({
            account,
            config: ctx.cfg,
            runtime: ctx.runtime,
            statusSink: makeTransportStatusSink("ws"),
          });
          stoppers.push(() => wsHandle.stop());
        }

        await waitForAbortSignal(ctx.abortSignal);
      } catch (err) {
        fatalError = err;
        throw err;
      } finally {
        for (const stop of stoppers.reverse()) {
          try {
            await stop();
          } catch (err) {
            ctx.runtime.error?.(`[napcat] stop failed: ${String(err)}`);
          }
        }
        ctx.setStatus({
          accountId: ctx.accountId,
          running: false,
          connected: false,
          lastStopAt: Date.now(),
          ...(fatalError ? { lastError: String(fatalError) } : {}),
        });
      }
    },
    stopAccount: async (ctx) => {
      ctx.setStatus({
        accountId: ctx.accountId,
        running: false,
        connected: false,
      });
    },
  },
};
