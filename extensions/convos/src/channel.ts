import {
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
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
import { convosMessageActions } from "./actions.js";
import { convosChannelConfigSchema } from "./config-schema.js";
import { convosOnboardingAdapter } from "./onboarding.js";
import { convosOutbound, getConvosInstance, setConvosInstance } from "./outbound.js";
import { getConvosRuntime } from "./runtime.js";
import { ConvosInstance, type InboundMessage } from "./sdk-client.js";

type RuntimeLogger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
  warn?: (msg: string) => void;
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
  actions: convosMessageActions,
  agentPrompt: {
    messageToolHints: () => [
      "- To send a Convos message: use `action=send` with `message`.",
      "- For reactions: use `action=react` with `messageId` and `emoji`.",
    ],
  },
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
        clearBaseFields: ["name", "identityId", "env", "debug", "ownerConversationId"],
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
      if (!trimmed) {
        return trimmed;
      }
      if (trimmed.toLowerCase().startsWith("convos:")) {
        return trimmed.slice("convos:".length).trim();
      }
      return trimmed;
    },
    notifyApproval: async ({ id }) => {
      const inst = getConvosInstance();
      if (!inst) {
        return;
      }
      try {
        await inst.sendMessage(`Device paired successfully (inbox: ${id.slice(0, 12)}...)`);
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
        // Convos conversation IDs are hex strings (32 chars) or UUIDs (36 chars with dashes)
        return (
          /^[0-9a-f]{32}$/i.test(trimmed) ||
          /^[0-9a-f-]{36}$/i.test(trimmed) ||
          trimmed.includes("/")
        );
      },
      hint: "<conversationId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async ({ query }) => {
      const inst = getConvosInstance();
      if (!inst) {
        return [];
      }
      const name = inst.label ?? inst.conversationId.slice(0, 8);
      const q = query?.trim().toLowerCase() ?? "";
      if (q && !name.toLowerCase().includes(q)) {
        return [];
      }
      return [{ kind: "group" as const, id: inst.conversationId, name }];
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
    probeAccount: async ({ account }) => {
      if (!account.ownerConversationId) {
        return {
          ok: false,
          error: "Not configured. Run 'openclaw configure' to set up Convos.",
        };
      }
      const inst = getConvosInstance();
      if (inst?.isRunning()) {
        return { ok: true };
      }
      return {
        ok: false,
        error: "Convos instance not running. Restart the gateway.",
      };
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

      if (!account.ownerConversationId) {
        throw new Error("Convos not configured. Run 'openclaw configure' to set up.");
      }

      setStatus({
        accountId: account.accountId,
        env: account.env,
      });

      log?.info(`[${account.accountId}] starting Convos provider (env: ${account.env})`);

      // Restore instance from config — the CLI manages identities on disk
      const inst = ConvosInstance.fromExisting(
        account.ownerConversationId,
        account.identityId ?? "",
        account.env,
        {
          debug: account.debug,
          onMessage: (msg: InboundMessage) => {
            handleInboundMessage(account, msg, runtime, log).catch((err) => {
              log?.error(`[${account.accountId}] Message handling failed: ${String(err)}`);
            });
          },
          onJoinAccepted: (info) => {
            log?.info(`[${account.accountId}] Join accepted: ${info.joinerInboxId}`);
          },
        },
      );

      setConvosInstance(inst);
      await inst.start();

      log?.info(
        `[${account.accountId}] Convos provider started (conversation: ${inst.conversationId.slice(0, 12)}...)`,
      );

      // Block until abort signal fires
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          void stopInstance(account.accountId, log).finally(resolve);
        };
        if (abortSignal?.aborted) {
          onAbort();
          return;
        }
        abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    stopAccount: async (ctx) => {
      const { account, log } = ctx;
      log?.info(`[${account.accountId}] stopping Convos provider`);
      await stopInstance(account.accountId, log);
    },
  },
};

/**
 * Handle inbound messages from CLI stream — dispatches to the reply pipeline
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

  // Safety assertion: in 1:1, all messages should be from our conversation
  if (msg.conversationId !== getConvosInstance()?.conversationId) {
    log?.warn?.(
      `[${account.accountId}] Message from unexpected conversation: ${msg.conversationId}`,
    );
    return;
  }

  const cfg = runtime.config.loadConfig();
  const rawBody = msg.content;

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "convos",
    accountId: account.accountId,
    peer: {
      kind: "group",
      id: msg.conversationId,
    },
  });

  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "Convos",
    from: msg.senderName || msg.senderId.slice(0, 12),
    timestamp: msg.timestamp.getTime(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

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

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      log?.error(`[${account.accountId}] Failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "convos",
    accountId: account.accountId,
  });

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: ReplyPayload) => {
        await deliverConvosReply({
          payload,
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
 * Deliver a reply to the Convos conversation
 */
async function deliverConvosReply(params: {
  payload: ReplyPayload;
  accountId: string;
  runtime: PluginRuntime;
  log?: RuntimeLogger;
  tableMode?: "off" | "plain" | "markdown" | "bullets" | "code";
}): Promise<void> {
  const { payload, accountId, runtime, log, tableMode = "code" } = params;

  const inst = getConvosInstance();
  if (!inst) {
    throw new Error("Convos instance not available");
  }

  const text = runtime.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

  if (text) {
    const cfg = runtime.config.loadConfig();
    const chunkLimit = runtime.channel.text.resolveTextChunkLimit({
      cfg,
      channel: "convos",
      accountId,
    });

    const chunks = runtime.channel.text.chunkMarkdownText(text, chunkLimit);

    for (const chunk of chunks) {
      try {
        await inst.sendMessage(chunk);
      } catch (err) {
        log?.error(`[${accountId}] Send failed: ${String(err)}`);
        throw err;
      }
    }
  }
}

/**
 * Create a fully-wired ConvosInstance and start it.
 * Used by HTTP routes to start message handling immediately after creating/joining.
 */
export async function startWiredInstance(params: {
  conversationId: string;
  identityId: string;
  env: "production" | "dev";
  debug?: boolean;
  /** If set, rename the conversation profile when a joiner is accepted. */
  name?: string;
}): Promise<void> {
  const runtime = getConvosRuntime();
  const cfg = runtime.config.loadConfig();
  const account = resolveConvosAccount({ cfg: cfg as CoreConfig });

  const inst = ConvosInstance.fromExisting(params.conversationId, params.identityId, params.env, {
    debug: params.debug ?? account.debug,
    onMessage: (msg: InboundMessage) => {
      handleInboundMessage(account, msg, runtime).catch((err) => {
        console.error(`[convos] Message handling failed: ${String(err)}`);
      });
    },
    onJoinAccepted: (info) => {
      console.log(`[convos] Join accepted: ${info.joinerInboxId}`);
      if (params.name) {
        inst.rename(params.name).catch((err) => {
          console.error(`[convos] Rename after join failed: ${String(err)}`);
        });
      }
    },
  });

  setConvosInstance(inst);
  await inst.start();
}

async function stopInstance(accountId: string, log?: RuntimeLogger) {
  const inst = getConvosInstance();
  if (inst) {
    try {
      await inst.stop();
    } catch (err) {
      log?.error(`[${accountId}] Error stopping instance: ${String(err)}`);
    }
    setConvosInstance(null);
  }
}
