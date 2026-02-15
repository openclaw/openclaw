import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  MessengerConfigSchema,
  messengerOnboardingAdapter,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type OpenClawConfig,
  type MessengerConfig,
  type ResolvedMessengerAccount,
} from "openclaw/plugin-sdk";
import { getMessengerRuntime } from "./runtime.js";

const meta = {
  id: "messenger",
  label: "Messenger",
  selectionLabel: "Facebook Messenger (Graph API)",
  detailLabel: "Messenger Bot",
  docsPath: "/channels/messenger",
  docsLabel: "messenger",
  blurb: "Facebook Messenger bot via Meta Graph API.",
  systemImage: "message.fill",
};

export const messengerPlugin: ChannelPlugin<ResolvedMessengerAccount> = {
  id: "messenger",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  onboarding: messengerOnboardingAdapter,
  pairing: {
    idLabel: "messengerUserId",
    normalizeAllowEntry: (entry) => {
      return entry.replace(/^messenger:/i, "");
    },
    notifyApproval: async ({ cfg, id }) => {
      const messenger = getMessengerRuntime().channel.messenger;
      const account = messenger.resolveMessengerAccount({ cfg });
      if (!account.pageAccessToken) {
        throw new Error("Messenger page access token not configured");
      }
      await messenger.sendMessageMessenger(id, "OpenClaw: your access has been approved.", {
        pageAccessToken: account.pageAccessToken,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.messenger"] },
  configSchema: buildChannelConfigSchema(MessengerConfigSchema),
  config: {
    listAccountIds: (cfg) => getMessengerRuntime().channel.messenger.listMessengerAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      getMessengerRuntime().channel.messenger.resolveMessengerAccount({
        cfg,
        accountId: accountId ?? undefined,
      }),
    defaultAccountId: (cfg) =>
      getMessengerRuntime().channel.messenger.resolveDefaultMessengerAccountId(cfg) ??
      DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const messengerConfig = (cfg.channels?.messenger ?? {}) as MessengerConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            messenger: {
              ...messengerConfig,
              enabled,
            },
          },
        };
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          messenger: {
            ...messengerConfig,
            accounts: {
              ...messengerConfig.accounts,
              [accountId]: {
                ...messengerConfig.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const messengerConfig = (cfg.channels?.messenger ?? {}) as MessengerConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        // oxlint-disable-next-line no-unused-vars
        const { pageAccessToken, appSecret, verifyToken, tokenFile, secretFile, ...rest } =
          messengerConfig;
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            messenger: rest,
          },
        };
      }
      const accounts = { ...messengerConfig.accounts };
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          messenger: {
            ...messengerConfig,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) =>
      Boolean(
        account.pageAccessToken?.trim() && account.appSecret?.trim() && account.verifyToken?.trim(),
      ),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(
        account.pageAccessToken?.trim() && account.appSecret?.trim() && account.verifyToken?.trim(),
      ),
      tokenSource: account.tokenSource,
      pageAccessToken: account.pageAccessToken,
      appSecret: account.appSecret,
      verifyToken: account.verifyToken,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (
        getMessengerRuntime().channel.messenger.resolveMessengerAccount({
          cfg,
          accountId: accountId ?? undefined,
        }).config.allowFrom ?? []
      ).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^messenger:/i, "")),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg.channels?.messenger as MessengerConfig | undefined)?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.messenger.accounts.${resolvedAccountId}.`
        : "channels.messenger.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: "openclaw pairing approve messenger <code>",
        normalizeEntry: (raw) => raw.replace(/^messenger:/i, ""),
      };
    },
    collectWarnings: () => [],
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) {
        return undefined;
      }
      return trimmed.replace(/^messenger:/i, "");
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        if (!trimmed) {
          return false;
        }
        // Messenger PSIDs are numeric strings
        return /^\d+$/.test(trimmed) || /^messenger:/i.test(trimmed);
      },
      hint: "<PSID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  setup: {
    resolveAccountId: ({ accountId }) =>
      getMessengerRuntime().channel.messenger.normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => {
      const messengerConfig = (cfg.channels?.messenger ?? {}) as MessengerConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            messenger: {
              ...messengerConfig,
              name,
            },
          },
        };
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          messenger: {
            ...messengerConfig,
            accounts: {
              ...messengerConfig.accounts,
              [accountId]: {
                ...messengerConfig.accounts?.[accountId],
                name,
              },
            },
          },
        },
      };
    },
    validateInput: ({ accountId, input }) => {
      const typedInput = input as {
        useEnv?: boolean;
        pageAccessToken?: string;
        appSecret?: string;
        verifyToken?: string;
        tokenFile?: string;
        secretFile?: string;
      };
      if (typedInput.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "MESSENGER_PAGE_ACCESS_TOKEN can only be used for the default account.";
      }
      if (!typedInput.useEnv && !typedInput.pageAccessToken && !typedInput.tokenFile) {
        return "Messenger requires pageAccessToken or --token-file (or --use-env).";
      }
      if (!typedInput.useEnv && !typedInput.appSecret && !typedInput.secretFile) {
        return "Messenger requires appSecret or --secret-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const typedInput = input as {
        name?: string;
        useEnv?: boolean;
        pageAccessToken?: string;
        appSecret?: string;
        verifyToken?: string;
        tokenFile?: string;
        secretFile?: string;
      };
      const messengerConfig = (cfg.channels?.messenger ?? {}) as MessengerConfig;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            messenger: {
              ...messengerConfig,
              enabled: true,
              ...(typedInput.name ? { name: typedInput.name } : {}),
              ...(typedInput.useEnv
                ? {}
                : typedInput.tokenFile
                  ? { tokenFile: typedInput.tokenFile }
                  : typedInput.pageAccessToken
                    ? { pageAccessToken: typedInput.pageAccessToken }
                    : {}),
              ...(typedInput.useEnv
                ? {}
                : typedInput.secretFile
                  ? { secretFile: typedInput.secretFile }
                  : typedInput.appSecret
                    ? { appSecret: typedInput.appSecret }
                    : {}),
              ...(typedInput.verifyToken ? { verifyToken: typedInput.verifyToken } : {}),
            },
          },
        };
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          messenger: {
            ...messengerConfig,
            enabled: true,
            accounts: {
              ...messengerConfig.accounts,
              [accountId]: {
                ...messengerConfig.accounts?.[accountId],
                enabled: true,
                ...(typedInput.name ? { name: typedInput.name } : {}),
                ...(typedInput.tokenFile
                  ? { tokenFile: typedInput.tokenFile }
                  : typedInput.pageAccessToken
                    ? { pageAccessToken: typedInput.pageAccessToken }
                    : {}),
                ...(typedInput.secretFile
                  ? { secretFile: typedInput.secretFile }
                  : typedInput.appSecret
                    ? { appSecret: typedInput.appSecret }
                    : {}),
                ...(typedInput.verifyToken ? { verifyToken: typedInput.verifyToken } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getMessengerRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: 2000, // Messenger allows up to 2000 characters per text message
    sendPayload: async ({ to, payload, accountId, cfg }) => {
      const runtime = getMessengerRuntime();
      const send = runtime.channel.messenger.sendMessageMessenger;
      const sendMedia = runtime.channel.messenger.sendMediaMessenger;

      const chunkLimit =
        runtime.channel.text.resolveTextChunkLimit?.(cfg, "messenger", accountId ?? undefined, {
          fallbackLimit: 2000,
        }) ?? 2000;

      const text = payload.text?.trim() ?? "";
      const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);

      let lastResult: { messageId: string; chatId: string } | null = null;

      // Send media
      for (const url of mediaUrls) {
        if (url?.trim()) {
          lastResult = await sendMedia(to, url.trim(), {
            accountId: accountId ?? undefined,
          });
        }
      }

      // Send text in chunks
      if (text) {
        const chunks = runtime.channel.text.chunkMarkdownText(text, chunkLimit);
        for (const chunk of chunks) {
          lastResult = await send(to, chunk, {
            accountId: accountId ?? undefined,
          });
        }
      }

      if (lastResult) {
        return { channel: "messenger", ...lastResult };
      }
      return { channel: "messenger", messageId: "empty", chatId: to };
    },
    sendText: async ({ to, text, accountId }) => {
      const runtime = getMessengerRuntime();
      const result = await runtime.channel.messenger.sendMessageMessenger(to, text, {
        accountId: accountId ?? undefined,
      });
      return { channel: "messenger", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const runtime = getMessengerRuntime();
      const result = await runtime.channel.messenger.sendMessageMessenger(to, text, {
        mediaUrl,
        accountId: accountId ?? undefined,
      });
      return { channel: "messenger", ...result };
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
    collectStatusIssues: (accounts) => {
      const issues: ChannelStatusIssue[] = [];
      for (const account of accounts) {
        const accountId = account.accountId ?? DEFAULT_ACCOUNT_ID;
        if (!account.pageAccessToken?.trim()) {
          issues.push({
            channel: "messenger",
            accountId,
            kind: "config",
            message: "Messenger page access token not configured",
          });
        }
        if (!account.appSecret?.trim()) {
          issues.push({
            channel: "messenger",
            accountId,
            kind: "config",
            message: "Messenger app secret not configured",
          });
        }
        if (!account.verifyToken?.trim()) {
          issues.push({
            channel: "messenger",
            accountId,
            kind: "config",
            message: "Messenger verify token not configured (webhook verification will fail)",
          });
        }
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      getMessengerRuntime().channel.messenger.probeMessengerPage(
        account.pageAccessToken,
        timeoutMs,
      ),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.pageAccessToken?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: "webhook",
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.pageAccessToken?.trim();
      const secret = account.appSecret?.trim();
      const verify = account.verifyToken?.trim();
      if (!token || !secret || !verify) {
        const missing = [
          !token && "pageAccessToken",
          !secret && "appSecret",
          !verify && "verifyToken",
        ]
          .filter(Boolean)
          .join(", ");
        throw new Error(
          `[${account.accountId}] cannot start Messenger provider: missing ${missing}`,
        );
      }

      let pageLabel = "";
      try {
        const probe = await getMessengerRuntime().channel.messenger.probeMessengerPage(token, 2500);
        const pageName = probe.ok ? probe.page?.name?.trim() : null;
        if (pageName) {
          pageLabel = ` (${pageName})`;
        }
      } catch (err) {
        if (getMessengerRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] page probe failed: ${String(err)}`);
        }
      }

      ctx.log?.info(`[${account.accountId}] starting Messenger provider${pageLabel}`);

      return getMessengerRuntime().channel.messenger.monitorMessengerProvider({
        pageAccessToken: token,
        appSecret: secret,
        verifyToken: verify,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const envToken = process.env.MESSENGER_PAGE_ACCESS_TOKEN?.trim() ?? "";
      const nextCfg = { ...cfg } as OpenClawConfig;
      const messengerConfig = (cfg.channels?.messenger ?? {}) as MessengerConfig;
      const nextMessenger = { ...messengerConfig };
      let cleared = false;
      let changed = false;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        if (
          nextMessenger.pageAccessToken ||
          nextMessenger.appSecret ||
          nextMessenger.verifyToken ||
          nextMessenger.tokenFile ||
          nextMessenger.secretFile
        ) {
          delete nextMessenger.pageAccessToken;
          delete nextMessenger.appSecret;
          delete nextMessenger.verifyToken;
          delete nextMessenger.tokenFile;
          delete nextMessenger.secretFile;
          cleared = true;
          changed = true;
        }
      }

      const accounts = nextMessenger.accounts ? { ...nextMessenger.accounts } : undefined;
      if (accounts && accountId in accounts) {
        const entry = accounts[accountId];
        if (entry && typeof entry === "object") {
          const nextEntry = { ...entry } as Record<string, unknown>;
          if (
            "pageAccessToken" in nextEntry ||
            "appSecret" in nextEntry ||
            "verifyToken" in nextEntry ||
            "tokenFile" in nextEntry ||
            "secretFile" in nextEntry
          ) {
            cleared = true;
            delete nextEntry.pageAccessToken;
            delete nextEntry.appSecret;
            delete nextEntry.verifyToken;
            delete nextEntry.tokenFile;
            delete nextEntry.secretFile;
            changed = true;
          }
          if (Object.keys(nextEntry).length === 0) {
            delete accounts[accountId];
            changed = true;
          } else {
            accounts[accountId] = nextEntry as typeof entry;
          }
        }
      }

      if (accounts) {
        if (Object.keys(accounts).length === 0) {
          delete nextMessenger.accounts;
          changed = true;
        } else {
          nextMessenger.accounts = accounts;
        }
      }

      if (changed) {
        if (Object.keys(nextMessenger).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, messenger: nextMessenger };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete (nextChannels as Record<string, unknown>).messenger;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
        await getMessengerRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = getMessengerRuntime().channel.messenger.resolveMessengerAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";

      return { cleared, envToken: Boolean(envToken), loggedOut };
    },
  },
};
