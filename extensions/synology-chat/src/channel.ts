// Import the correct function for getting replies from the agent system
import { getReplyFromConfig } from "../../../src/auto-reply/reply.js";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type OpenClawConfig,
} from "../../../src/plugin-sdk/index.js";
import {
  SynologyChatConfigSchema,
  type SynologyChatConfigSchemaType,
} from "../../../src/synology-chat/config-schema.js";
import { getSynologyChatRuntime } from "./runtime.js";

type SynologyChatConfig = SynologyChatConfigSchemaType;

type ResolvedSynologyChatAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  config: SynologyChatConfig;
  channelAccessToken?: string;
  tokenSource: string;
};

// Synology Chat channel metadata
const meta = {
  id: "synology-chat",
  label: "Synology Chat",
  selectionLabel: "Synology Chat (Webhook)",
  detailLabel: "Synology Chat Bot",
  docsPath: "/channels/synology-chat",
  docsLabel: "synology-chat",
  blurb: "Synology Chat integration via incoming/outgoing webhooks.",
  systemImage: "message.fill",
};

export const synologyChatPlugin: ChannelPlugin<ResolvedSynologyChatAccount> = {
  id: "synology-chat",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "userId",
    normalizeAllowEntry: (entry) => {
      // Normalize user ID entries
      return entry.replace(/^synology-chat:(?:user:)?/i, "");
    },
    notifyApproval: async ({ cfg, id: _id }) => {
      const _runtime = getSynologyChatRuntime();
      const account = synologyChatPlugin.config.resolveAccount(cfg, DEFAULT_ACCOUNT_ID);
      if (!account.config.nasIncomingWebhookUrl) {
        throw new Error("Synology Chat webhook URL not configured");
      }
      await sendMessageToSynologyChat(
        account.config.nasIncomingWebhookUrl,
        "OpenClaw: your access has been approved.",
      );
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.synology-chat"] },
  configSchema: buildChannelConfigSchema(SynologyChatConfigSchema),
  config: {
    listAccountIds: (cfg) => {
      const synologyChatConfig = cfg.channels?.["synology-chat"] as SynologyChatConfig | undefined;
      if (!synologyChatConfig) {
        return [DEFAULT_ACCOUNT_ID];
      }
      return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
      const baseConfig = cfg.channels?.["synology-chat"] as SynologyChatConfig | undefined;
      const defaultConfig: SynologyChatConfig = {
        nasIncomingWebhookUrl: "",
        token: undefined,
        channelAccessToken: undefined,
        botName: "openclaw",
        incomingWebhookPath: "/synology-chat",
        port: undefined,
        botToken: undefined,
        incomingWebhookToken: undefined,
        incomingWebhookVerifySsl: true,
        allowFrom: [],
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
      };

      let accountConfig: SynologyChatConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        accountConfig = {
          ...defaultConfig,
          ...baseConfig,
        };
      } else {
        const accounts = baseConfig?.accounts;
        // Make sure accountId is a valid string before using as index
        const validAccountId = accountId && typeof accountId === "string" ? accountId : "";
        accountConfig = {
          ...defaultConfig,
          ...accounts?.[validAccountId],
        };
      }

      return {
        accountId: accountId || DEFAULT_ACCOUNT_ID,
        name: `Synology Chat ${accountId || "Default"}`,
        enabled: baseConfig?.enabled !== false,
        config: accountConfig,
        channelAccessToken: accountConfig.token,
        tokenSource: accountConfig.token ? "config" : "none",
      } as ResolvedSynologyChatAccount;
    },
    defaultAccountId: (_cfg) => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const synologyChatConfig = (cfg.channels?.["synology-chat"] ?? {}) as
        | SynologyChatConfig
        | Record<string, unknown>;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            "synology-chat": {
              ...synologyChatConfig,
              enabled,
            },
          },
        };
      }
      const accountsObj = (synologyChatConfig as Record<string, unknown>).accounts as
        | Record<string, unknown>
        | undefined;
      const accounts = accountsObj ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "synology-chat": {
            ...synologyChatConfig,
            accounts: {
              ...accounts,
              [accountId]: {
                enabled,
                ...(accounts?.[accountId] as Record<string, unknown> | undefined),
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const synologyChatConfig = (cfg.channels?.["synology-chat"] ?? {}) as
        | SynologyChatConfig
        | Record<string, unknown>;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        // Remove the entire synology-chat config
        const newChannels = { ...cfg.channels };
        delete newChannels["synology-chat"];
        return {
          ...cfg,
          channels: newChannels,
        };
      }
      const accountsObj = (synologyChatConfig as Record<string, unknown>).accounts as
        | Record<string, unknown>
        | undefined;
      const accounts = accountsObj ? { ...accountsObj } : {};
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "synology-chat": {
            ...synologyChatConfig,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => Boolean(account.config.nasIncomingWebhookUrl?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.config.nasIncomingWebhookUrl?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = synologyChatPlugin.config.resolveAccount(cfg, accountId);
      return (account.config.allowFrom ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry: unknown) => String(entry).trim())
        .filter(Boolean)
        .map((entry: string) => {
          return entry.replace(/^synology-chat:(?:user:)?/i, "");
        }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const synologyChatConfig = cfg.channels?.["synology-chat"] as SynologyChatConfig | undefined;
      const useAccountPath = Boolean(synologyChatConfig?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.synology-chat.accounts.${resolvedAccountId}.`
        : "channels.synology-chat.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: "openclaw pairing approve synology-chat <code>",
        normalizeEntry: (raw) => raw.replace(/^synology-chat:(?:user:)?/i, ""),
      };
    },
    collectWarnings: ({ account: _account, cfg: _cfg }) => {
      return []; // No specific warnings for Synology Chat
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = synologyChatPlugin.config.resolveAccount(cfg, accountId);
      const groups = account.config.groups;
      if (!groups) {
        return false;
      }
      const groupConfig = groups[groupId] ?? groups["*"];
      return groupConfig?.requireMention ?? false;
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) {
        return undefined;
      }
      const result = trimmed
        .replace(/^synology-chat:(group|room|user):/i, "")
        .replace(/^synology-chat:/i, "");
      return result || undefined;
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        if (!trimmed) {
          return false;
        }
        // Synology Chat user IDs are typically numeric or alphanumeric
        return /^[a-zA-Z0-9_-]+$/.test(trimmed) || /^synology-chat:/i.test(trimmed);
      },
      hint: "<userId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  setup: {
    resolveAccountId: ({ accountId }) => accountId || DEFAULT_ACCOUNT_ID,
    applyAccountName: ({ cfg, accountId, name }) => {
      const synologyChatConfig = (cfg.channels?.["synology-chat"] ?? {}) as
        | SynologyChatConfig
        | Record<string, unknown>;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            "synology-chat": {
              ...synologyChatConfig,
              name,
            },
          },
        };
      }
      const accountsObj = (synologyChatConfig as Record<string, unknown>).accounts as
        | Record<string, unknown>
        | undefined;
      const accounts = accountsObj ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "synology-chat": {
            ...synologyChatConfig,
            accounts: {
              ...accounts,
              [accountId]: {
                ...(accounts?.[accountId] as Record<string, unknown> | undefined),
                name,
              },
            },
          },
        },
      };
    },
    validateInput: ({ accountId: _accountId, input }) => {
      const typedInput = input as {
        nasIncomingWebhookUrl?: string;
        token?: string;
        botName?: string;
      };

      if (!typedInput.nasIncomingWebhookUrl) {
        return "Synology Chat requires nasIncomingWebhookUrl.";
      }

      try {
        new URL(typedInput.nasIncomingWebhookUrl);
      } catch {
        return "Invalid webhook URL provided.";
      }

      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const typedInput = input as {
        nasIncomingWebhookUrl: string;
        token?: string;
        botName?: string;
        incomingWebhookPath?: string;
      };

      const synologyChatConfig = (cfg.channels?.["synology-chat"] ?? {}) as
        | SynologyChatConfig
        | Record<string, unknown>;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            "synology-chat": {
              ...synologyChatConfig,
              enabled: true,
              nasIncomingWebhookUrl: typedInput.nasIncomingWebhookUrl,
              token: typedInput.token,
              botName: typedInput.botName || "openclaw",
              incomingWebhookPath: typedInput.incomingWebhookPath || "/synology-chat",
            },
          },
        };
      }

      const accountsObj = (synologyChatConfig as Record<string, unknown>).accounts as
        | Record<string, unknown>
        | undefined;
      const accounts = accountsObj ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "synology-chat": {
            ...synologyChatConfig,
            enabled: true,
            accounts: {
              ...accounts,
              [accountId]: {
                ...(accounts?.[accountId] as Record<string, unknown> | undefined),
                enabled: true,
                nasIncomingWebhookUrl: typedInput.nasIncomingWebhookUrl,
                token: typedInput.token,
                botName: typedInput.botName || "openclaw",
                incomingWebhookPath: typedInput.incomingWebhookPath || "/synology-chat",
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, _limit) => [text], // Simple chunker for basic implementation
    textChunkLimit: 5000, // Reasonable limit for Synology Chat
    sendPayload: async ({ to, payload, accountId, cfg }) => {
      const _runtime = getSynologyChatRuntime();
      const account = synologyChatPlugin.config.resolveAccount(
        cfg,
        accountId ?? DEFAULT_ACCOUNT_ID,
      );

      if (!account.config.nasIncomingWebhookUrl) {
        throw new Error("Synology Chat webhook URL not configured");
      }

      const text = payload.text || "";
      await sendMessageToSynologyChat(account.config.nasIncomingWebhookUrl, text);

      return { channel: "synology-chat", messageId: "sent", chatId: to };
    },
    sendText: async ({ to, text, accountId }) => {
      const _runtime = getSynologyChatRuntime();
      const cfg = _runtime.config.loadConfig ? _runtime.config.loadConfig() : {};
      const account = synologyChatPlugin.config.resolveAccount(
        cfg,
        accountId ?? DEFAULT_ACCOUNT_ID,
      );

      if (!account.config.nasIncomingWebhookUrl) {
        throw new Error("Synology Chat webhook URL not configured");
      }

      await sendMessageToSynologyChat(account.config.nasIncomingWebhookUrl, text);

      return { channel: "synology-chat", messageId: "sent", chatId: to };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const _runtime = getSynologyChatRuntime();
      const cfg = _runtime.config.loadConfig ? _runtime.config.loadConfig() : {};
      const account = synologyChatPlugin.config.resolveAccount(
        cfg,
        accountId ?? DEFAULT_ACCOUNT_ID,
      );

      if (!account.config.nasIncomingWebhookUrl) {
        throw new Error("Synology Chat webhook URL not configured");
      }

      // For basic implementation, send text with media URL
      const message = text ? `${text}\n\n${mediaUrl}` : mediaUrl;
      await sendMessageToSynologyChat(account.config.nasIncomingWebhookUrl, message);

      return { channel: "synology-chat", messageId: "sent", chatId: to };
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
        if (!account.config.nasIncomingWebhookUrl?.trim()) {
          issues.push({
            channel: "synology-chat",
            accountId,
            kind: "config",
            message: "Synology Chat webhook URL not configured",
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
    probeAccount: async ({ account, timeoutMs: _timeoutMs }) => {
      // Simple probe by checking if webhook URL is configured
      if (!account.config.nasIncomingWebhookUrl?.trim()) {
        return { ok: false, error: "Webhook URL not configured" };
      }

      try {
        // Try sending a test message
        await sendMessageToSynologyChat(account.config.nasIncomingWebhookUrl, "Test connection");
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.config.nasIncomingWebhookUrl?.trim());
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
      const port = account.config.port || 9000; // Default to port 9000, but configurable
      const webhookPath = account.config.incomingWebhookPath || "/synology-chat";

      ctx.log?.info(
        `[${account.accountId}] starting Synology Chat provider on port ${port} with webhook path: ${webhookPath}`,
      );
      ctx.log?.info(
        `Current config: incomingWebhookPath=${account.config.incomingWebhookPath}, nasIncomingWebhookUrl=${account.config.nasIncomingWebhookUrl}, botName=${account.config.botName}, botToken=${!!account.config.botToken}, incomingWebhookToken=${!!account.config.incomingWebhookToken}`,
      );

      // Create Express app to handle webhook requests on its own port
      const express = (await import("express")).default;
      const app = express();

      // Middleware to parse form data (what Synology Chat sends)
      app.use(express.urlencoded({ extended: true }));

      // Register the webhook handler on the specific path
      app.post(webhookPath, createSynologyChatWebhookHandler(ctx));

      // Start server on the designated port
      const server = app.listen(port, "0.0.0.0", () => {
        ctx.log?.info(
          `Synology Chat webhook server running on port ${port} with path: ${webhookPath}`,
        );
      });

      // Handle server errors
      server.on("error", (err) => {
        ctx.log?.error(`Synology Chat webhook server error on port ${port}:`, err);
      });

      // Store server reference in context for potential cleanup - removed to fix TypeScript error

      return {
        stop: async () => {
          // Close the server when stopping
          return new Promise<void>((resolve, _reject) => {
            ctx.log?.info(`Stopping Synology Chat webhook server on port ${port}...`);

            server.close((err) => {
              if (err) {
                ctx.log?.error(`Synology Chat webhook server error on port ${port}:`, err);
                // Still resolve despite error as the server is closed
                resolve();
              } else {
                ctx.log?.info(`Synology Chat webhook server stopped on port ${port}`);
                resolve();
              }
            });
          });
        },
      };
    },
    logoutAccount: async ({ accountId, cfg }) => {
      // Clear configuration
      const envToken = process.env.SYNOLOGY_CHAT_TOKEN?.trim() ?? "";
      const nextCfg = { ...cfg } as OpenClawConfig;
      const synologyChatConfig = (cfg.channels?.["synology-chat"] ?? {}) as
        | SynologyChatConfig
        | Record<string, unknown>;
      const nextSynologyChat = { ...synologyChatConfig };
      let cleared = false;
      let changed = false;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        if (
          (nextSynologyChat as Record<string, unknown>).nasIncomingWebhookUrl ||
          (nextSynologyChat as Record<string, unknown>).token
        ) {
          delete (nextSynologyChat as Record<string, unknown>).nasIncomingWebhookUrl;
          delete (nextSynologyChat as Record<string, unknown>).token;
          cleared = true;
          changed = true;
        }
      }

      const accounts = (nextSynologyChat as Record<string, unknown>).accounts
        ? { ...((nextSynologyChat as Record<string, unknown>).accounts as Record<string, unknown>) }
        : undefined;
      if (accounts && accountId in accounts) {
        const entry = accounts[accountId];
        if (entry && typeof entry === "object") {
          const nextEntry = { ...entry } as Record<string, unknown>;
          if ("nasIncomingWebhookUrl" in nextEntry || "token" in nextEntry) {
            cleared = true;
            delete nextEntry.nasIncomingWebhookUrl;
            delete nextEntry.token;
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
          delete (nextSynologyChat as Record<string, unknown>).accounts;
          changed = true;
        } else {
          (nextSynologyChat as Record<string, unknown>).accounts = accounts;
        }
      }

      if (changed) {
        if (Object.keys(nextSynologyChat).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, "synology-chat": nextSynologyChat };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete (nextChannels as Record<string, unknown>)["synology-chat"];
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
        const runtime = getSynologyChatRuntime();
        await runtime.config.writeConfigFile(nextCfg);
      }

      const resolved = synologyChatPlugin.config.resolveAccount(changed ? nextCfg : cfg, accountId);
      const loggedOut = resolved.tokenSource === "none";

      return { cleared, envToken: Boolean(envToken), loggedOut };
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "",
      "### Synology Chat Messages",
      "Send messages to Synology Chat using webhook integration.",
      "",
      "The bot responds directly through HTTP response when receiving messages.",
    ],
  },
};

/**
 * Send a message to Synology Chat via webhook
 *
 * @param webhookUrl - The Synology Chat incoming webhook URL
 * @param text - The message text to send
 * @param verifySsl - Whether to verify SSL certificates (default: true)
 * @returns Promise resolving to the response data or throwing an error on failure
 */
async function sendMessageToSynologyChat(
  webhookUrl: string,
  text: string,
  verifySsl: boolean = true,
): Promise<unknown> {
  const payload = {
    text: text,
  };

  const data = {
    payload: JSON.stringify(payload),
  };

  try {
    // Use undici for better control over TLS/SSL options
    // This allows skipping certificate verification for self-signed certs
    const { fetch: undiciFetch, Agent } = await import("undici");
    const agent = new Agent({
      connect: {
        rejectUnauthorized: verifySsl,
      },
    });

    const response = await undiciFetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(data).toString(),
      dispatcher: agent,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  } catch (error) {
    throw new Error(
      `Failed to send message to Synology Chat: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

// Define types for webhook handler
interface SynologyChatWebhookContext {
  account: ResolvedSynologyChatAccount;
  cfg?: OpenClawConfig;
  log?: {
    info?: (message: string, ...args: unknown[]) => void;
    error?: (message: string, ...args: unknown[]) => void;
  };
}

interface SynologyChatWebhookRequest {
  body?: Record<string, string>;
  rawBody?: Uint8Array;
}

interface SynologyChatWebhookResponse {
  writeHead: (statusCode: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
}

// Function to create webhook handler for receiving messages
function createSynologyChatWebhookHandler(ctx: SynologyChatWebhookContext) {
  return async (req: SynologyChatWebhookRequest, res: SynologyChatWebhookResponse) => {
    try {
      // Parse form data (Synology Chat sends form-encoded data)
      const formData: Record<string, string> = {};

      // This is a simplified implementation - in a real scenario,
      // we'd need to properly parse the form data from the request
      if (req.body) {
        // If body is already parsed
        Object.assign(formData, req.body);
      } else if (req.rawBody) {
        // Parse form data from raw body
        const textDecoder = new TextDecoder();
        const bodyText = textDecoder.decode(req.rawBody);
        const params = new URLSearchParams(bodyText);
        for (const [key, value] of params.entries()) {
          formData[key] = value;
        }
      }

      console.log("SYNOLOGY CHAT MESSAGE RECEIVED:");
      console.log(JSON.stringify(formData, null, 2));

      // Get configuration values
      const providedToken = formData.token;
      const botToken = ctx.account.config.botToken;
      const incomingWebhookToken = ctx.account.config.incomingWebhookToken;
      const nasIncomingWebhookUrl = ctx.account.config.nasIncomingWebhookUrl;

      // Determine which mode we're in based on the token
      let isIncomingWebhookMode = false;

      if (incomingWebhookToken && providedToken === incomingWebhookToken) {
        // NAS outgoing webhook mode - has trigger_word, send reply to nasIncomingWebhookUrl
        isIncomingWebhookMode = true;
      } else if (botToken && providedToken !== botToken) {
        // botToken is configured but provided token doesn't match
        console.error(`Invalid token received: ${providedToken}, expected: ${botToken}`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: Invalid token" }));
        return;
      }

      // Get message content and user info
      let text = formData.text || "";
      const triggerWord = formData.trigger_word || "";
      const username = formData.username || "";
      const userId = formData.user_id || "";

      // If trigger_word is present (incoming webhook mode), remove it from the text
      if (triggerWord && text.toLowerCase().startsWith(triggerWord.toLowerCase())) {
        text = text.slice(triggerWord.length).trim();
        console.log(`Removed trigger_word "${triggerWord}", remaining text: ${text}`);
      }

      // Ignore messages from the bot itself
      if (username.toLowerCase() === ctx.account.config.botName.toLowerCase()) {
        console.log("Ignored message from bot itself");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // Create context for the agent system
      const agentContext = {
        Body: text,
        From: `synology-chat:${userId || username}`,
        To: `synology-chat:bot`,
        SessionKey: `synology-chat-${userId || username}`,
        AccountId: ctx.account?.accountId || DEFAULT_ACCOUNT_ID,
        MessageSid: Date.now().toString(),
        ChatType: "direct",
        ConversationLabel: `synology-chat-${userId || username}`,
        SenderName: username,
        SenderId: userId,
        Provider: "synology-chat",
        Surface: "synology-chat",
        OriginatingChannel: "synology-chat",
        OriginatingTo: `synology-chat:${userId || username}`,
      };

      // Process the message with the OpenClaw agent system
      // Use the configuration passed in via ctx.cfg (standard approach used by other channels)
      const cfg = ctx.cfg;

      // Use the actual OpenClaw agent system to process the message
      const replyResult = await getReplyFromConfig(agentContext, undefined, cfg);

      // Extract text from reply result - handle both single payload and array of payloads
      let replyText = "";
      if (Array.isArray(replyResult)) {
        // If it's an array of payloads, get text from the first one that has text
        const firstPayloadWithText = (replyResult as unknown[]).find(
          (payload: unknown) =>
            payload &&
            typeof payload === "object" &&
            "text" in payload &&
            typeof (payload as Record<string, unknown>).text === "string",
        );
        replyText =
          firstPayloadWithText &&
          typeof firstPayloadWithText === "object" &&
          "text" in firstPayloadWithText
            ? (firstPayloadWithText as Record<string, string>).text
            : `Processed: ${text}`;
      } else if (replyResult && typeof replyResult === "object" && "text" in replyResult) {
        // If it's a single payload with text property
        replyText = replyResult.text || `Processed: ${text}`;
      } else {
        // Fallback
        if (replyResult) {
          replyText = typeof replyResult === "string" ? replyResult : `Received: ${text}`;
        } else {
          replyText = `Received: ${text}`;
        }
      }

      const reply = replyText;

      // Important: Respond with the reply
      const responseData = {
        text: reply,
      };

      console.log(`Sending reply: ${reply}`);

      if (isIncomingWebhookMode && nasIncomingWebhookUrl) {
        // Incoming webhook mode - send reply via nasIncomingWebhookUrl
        console.log(`Incoming webhook mode - sending reply via nasIncomingWebhookUrl`);
        const verifySsl = ctx.account.config.incomingWebhookVerifySsl ?? true;
        await sendMessageToSynologyChat(nasIncomingWebhookUrl, reply, verifySsl);
        // For incoming webhook mode, just acknowledge without returning the reply
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } else {
        // Original mode - respond directly in HTTP response
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseData));
      }
    } catch (error) {
      console.error("Error handling Synology Chat webhook:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  };
}
