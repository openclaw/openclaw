import {
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
  type PluginRuntime,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  listConvosAccountIds,
  resolveConvosAccount,
  resolveDefaultConvosAccountId,
  type CoreConfig,
  type ResolvedConvosAccount,
} from "./accounts.js";
import { ConvosSDKClient, type InboundMessage } from "./sdk-client.js";
import { convosChannelConfigSchema } from "./config-schema.js";
import { convosOnboardingAdapter } from "./onboarding.js";
import { convosOutbound, setClientForAccount } from "./outbound.js";
import { getConvosRuntime } from "./runtime.js";

type RuntimeLogger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

const meta = {
  id: "convos",
  label: "Convos",
  selectionLabel: "Convos (XMTP)",
  docsPath: "/channels/convos",
  docsLabel: "convos",
  blurb: "E2E encrypted messaging via XMTP",
  systemImage: "lock.shield.fill",
  order: 75,
  quickstartAllowFrom: false,
};

// Track SDK clients per account
const clients = new Map<string, ConvosSDKClient>();

function normalizeConvosMessagingTarget(raw: string): string | undefined {
  let normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }
  const lowered = normalized.toLowerCase();
  if (lowered.startsWith("convos:")) {
    normalized = normalized.slice("convos:".length).trim();
  }
  return normalized || undefined;
}

export const convosPlugin: ChannelPlugin<ResolvedConvosAccount> = {
  id: "convos",
  meta,
  capabilities: {
    chatTypes: ["group"],
    reactions: true,
    threads: false,
    media: false,
  },
  reload: { configPrefixes: ["channels.convos"] },
  configSchema: convosChannelConfigSchema,
  onboarding: convosOnboardingAdapter,
  config: {
    listAccountIds: (cfg) => listConvosAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveConvosAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultConvosAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "convos",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "convos",
        accountId,
        clearBaseFields: ["name", "privateKey", "env", "debug", "ownerConversationId"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      env: account.env,
    }),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.convos.dmPolicy",
      allowFromPath: "channels.convos.allowFrom",
    }),
  },
  pairing: {
    idLabel: "inbox ID",
    normalizeAllowEntry: (entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return trimmed;
      // Remove convos: prefix if present for storage
      if (trimmed.toLowerCase().startsWith("convos:")) {
        return trimmed.slice("convos:".length).trim();
      }
      return trimmed;
    },
    notifyApproval: async ({ cfg, id, runtime }) => {
      const account = resolveConvosAccount({ cfg: cfg as CoreConfig });
      const client = clients.get(account.accountId);
      if (!client || !account.ownerConversationId) {
        return;
      }
      try {
        await client.sendMessage(
          account.ownerConversationId,
          `✅ Device paired successfully (inbox: ${id.slice(0, 12)}...)`,
        );
      } catch {
        // Ignore notification errors
      }
    },
  },
  messaging: {
    normalizeTarget: normalizeConvosMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        // Convos conversation IDs are UUIDs or conversation slugs
        return /^[0-9a-f-]{36}$/i.test(trimmed) || trimmed.includes("/");
      },
      hint: "<conversationId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [], // Convos doesn't have a user directory
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveConvosAccount({ cfg: cfg as CoreConfig, accountId });
      const client = clients.get(account.accountId);
      if (!client) {
        return [];
      }
      try {
        const conversations = await client.listConversations();
        const q = query?.trim().toLowerCase() ?? "";
        return conversations
          .filter((conv) => !q || conv.displayName.toLowerCase().includes(q))
          .slice(0, limit ?? 50)
          .map((conv) => ({
            kind: "group" as const,
            id: conv.id,
            name: conv.displayName,
          }));
      } catch {
        return [];
      }
    },
  },
  outbound: convosOutbound,
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
            channel: "convos",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      env: snapshot.env ?? "production",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      // For SDK-based client, we verify by checking if we can create a client
      // If privateKey is set, the account is considered healthy
      if (!account.privateKey) {
        return {
          ok: false,
          error: "Not configured: no private key. Run 'openclaw configure' to set up Convos.",
        };
      }

      try {
        // Create a temporary client to verify connectivity
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 10000);

        const tempClient = await ConvosSDKClient.create({
          privateKey: account.privateKey,
          env: account.env,
          debug: account.debug,
        });

        clearTimeout(timeout);
        await tempClient.stop();

        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      env: account.env,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, setStatus, log } = ctx;
      const runtime = getConvosRuntime();

      if (!account.privateKey) {
        throw new Error(
          "Convos not configured: no private key. Run 'openclaw configure' to set up Convos.",
        );
      }

      setStatus({
        accountId: account.accountId,
        env: account.env,
      });

      log?.info(`[${account.accountId}] starting Convos provider (env: ${account.env})`);

      // Create SDK client with message handling
      const client = await ConvosSDKClient.create({
        privateKey: account.privateKey,
        env: account.env,
        debug: account.debug,
        onMessage: (msg: InboundMessage) => {
          // Handle async message processing with error logging
          handleInboundMessage(account, msg, runtime, log).catch((err) => {
            log?.error(`[${account.accountId}] Message handling failed: ${String(err)}`);
          });
        },
        onInvite: async (inviteCtx) => {
          // Auto-accept invites for now
          // TODO: Add policy-based handling
          log?.info(`[${account.accountId}] Auto-accepting invite request`);
          await inviteCtx.accept();
        },
      });

      // Store client for outbound use
      clients.set(account.accountId, client);
      setClientForAccount(account.accountId, client);

      // Start listening for messages
      await client.start();

      log?.info(`[${account.accountId}] Convos provider started`);

      // Cleanup on abort
      abortSignal?.addEventListener("abort", () => {
        stopClient(account.accountId, log);
      });

      return { client };
    },
    stopAccount: async (ctx) => {
      const { account, log } = ctx;
      log?.info(`[${account.accountId}] stopping Convos provider`);
      await stopClient(account.accountId, log);
    },
  },
};

/**
 * Handle inbound messages from SDK - dispatches to the reply pipeline
 */
async function handleInboundMessage(
  account: ResolvedConvosAccount,
  msg: InboundMessage,
  runtime: PluginRuntime,
  log?: RuntimeLogger,
) {
  if (account.debug) {
    log?.info(
      `[${account.accountId}] Inbound message from ${msg.senderId}: ${msg.content.slice(0, 50)}`,
    );
  }

  const cfg = runtime.config.loadConfig() as OpenClawConfig;
  const rawBody = msg.content;

  // Resolve agent route to get session key for conversation tracking
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "convos",
    accountId: account.accountId,
    peer: {
      kind: "group",
      id: msg.conversationId,
    },
  });

  // Get store path for session recording
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  // Get previous timestamp for envelope formatting
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Format the agent envelope (adds channel/timestamp context)
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "Convos",
    from: msg.senderName || msg.senderId.slice(0, 12),
    timestamp: msg.timestamp.getTime(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  // Build the finalized inbound context with all required fields
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `convos:${msg.senderId}`,
    To: `convos:${msg.conversationId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    ConversationLabel: msg.conversationId.slice(0, 12),
    SenderName: msg.senderName || undefined,
    SenderId: msg.senderId,
    Provider: "convos",
    Surface: "convos",
    MessageSid: msg.messageId,
    OriginatingChannel: "convos",
    OriginatingTo: `convos:${msg.conversationId}`,
  });

  // Record the inbound session for conversation history
  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      log?.error(`[${account.accountId}] Failed updating session meta: ${String(err)}`);
    },
  });

  // Resolve markdown table mode for reply formatting
  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "convos",
    accountId: account.accountId,
  });

  // Dispatch to the reply pipeline with buffered block dispatcher
  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: ReplyPayload) => {
        await deliverConvosReply({
          payload,
          conversationId: msg.conversationId,
          accountId: account.accountId,
          runtime,
          log,
          tableMode,
        });
      },
      onError: (err, info) => {
        log?.error(`[${account.accountId}] Convos ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

/**
 * Deliver a reply to a Convos conversation
 */
async function deliverConvosReply(params: {
  payload: ReplyPayload;
  conversationId: string;
  accountId: string;
  runtime: PluginRuntime;
  log?: RuntimeLogger;
  tableMode?: "off" | "plain" | "markdown" | "bullets" | "code";
}): Promise<void> {
  const { payload, conversationId, accountId, runtime, log, tableMode = "code" } = params;

  const client = clients.get(accountId);
  if (!client) {
    throw new Error("Convos client not available");
  }

  // Convert markdown tables if needed
  const text = runtime.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

  if (text) {
    // Chunk the text if needed (Convos/XMTP has message size limits)
    const chunkLimit = runtime.channel.text.resolveTextChunkLimit({
      cfg: runtime.config.loadConfig() as OpenClawConfig,
      channel: "convos",
      accountId,
    });
    const chunks = runtime.channel.text.chunkText(text, chunkLimit);

    for (const chunk of chunks) {
      try {
        await client.sendMessage(conversationId, chunk);
      } catch (err) {
        log?.error(`[${accountId}] Failed to send message: ${String(err)}`);
        throw err;
      }
    }
  }
}

/**
 * Stop SDK client for an account
 */
async function stopClient(accountId: string, log?: RuntimeLogger) {
  const client = clients.get(accountId);
  if (client) {
    try {
      await client.stop();
    } catch (err) {
      log?.error(`[${accountId}] Error stopping client: ${String(err)}`);
    }
    clients.delete(accountId);
    setClientForAccount(accountId, null);
  }
}
