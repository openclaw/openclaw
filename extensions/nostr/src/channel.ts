import {
  buildChannelConfigSchema,
  createReplyPrefixContext,
  createTypingCallbacks,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  logTypingFailure,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { NostrProfile } from "./config-schema.js";
import type { MetricEvent, MetricsSnapshot } from "./metrics.js";
import type { ProfilePublishResult } from "./nostr-profile.js";
import { NostrConfigSchema } from "./config-schema.js";
import { normalizePubkey, startNostrBus, type NostrBusHandle } from "./nostr-bus.js";
import { getNostrRuntime } from "./runtime.js";
import {
  listNostrAccountIds,
  resolveDefaultNostrAccountId,
  resolveNostrAccount,
  type ResolvedNostrAccount,
} from "./types.js";

// Store active bus handles per account
const activeBuses = new Map<string, NostrBusHandle>();

// Store metrics snapshots per account (for status reporting)
const metricsSnapshots = new Map<string, MetricsSnapshot>();

export const nostrPlugin: ChannelPlugin<ResolvedNostrAccount> = {
  id: "nostr",
  meta: {
    id: "nostr",
    label: "Nostr",
    selectionLabel: "Nostr",
    docsPath: "/channels/nostr",
    docsLabel: "nostr",
    blurb: "Decentralized DMs via Nostr relays (NIP-04)",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"], // DMs only for MVP
    media: false, // No media for MVP
  },
  reload: { configPrefixes: ["channels.nostr"] },
  configSchema: buildChannelConfigSchema(NostrConfigSchema),

  config: {
    listAccountIds: (cfg) => listNostrAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNostrAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNostrAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveNostrAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => {
          if (entry === "*") {
            return "*";
          }
          try {
            return normalizePubkey(entry);
          } catch {
            return entry; // Keep as-is if normalization fails
          }
        })
        .filter(Boolean),
  },

  pairing: {
    idLabel: "nostrPubkey",
    normalizeAllowEntry: (entry) => {
      try {
        return normalizePubkey(entry.replace(/^nostr:/i, ""));
      } catch {
        return entry;
      }
    },
    notifyApproval: async ({ id }) => {
      // Get the default account's bus and send approval message
      const bus = activeBuses.get(DEFAULT_ACCOUNT_ID);
      if (bus) {
        await bus.sendDm(id, "Your pairing request has been approved!");
      }
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: "channels.nostr.dmPolicy",
        allowFromPath: "channels.nostr.allowFrom",
        approveHint: formatPairingApproveHint("nostr"),
        normalizeEntry: (raw) => {
          try {
            return normalizePubkey(raw.replace(/^nostr:/i, "").trim());
          } catch {
            return raw.trim();
          }
        },
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => {
      // Strip nostr: prefix if present
      const cleaned = target.replace(/^nostr:/i, "").trim();
      try {
        return normalizePubkey(cleaned);
      } catch {
        return cleaned;
      }
    },
    targetResolver: {
      looksLikeId: (input) => {
        const trimmed = input.trim();
        return trimmed.startsWith("npub1") || /^[0-9a-fA-F]{64}$/.test(trimmed);
      },
      hint: "<npub|hex pubkey|nostr:npub...>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const core = getNostrRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`Nostr bus not running for account ${aid}`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg: core.config.loadConfig(),
        channel: "nostr",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      const normalizedTo = normalizePubkey(to);
      await bus.sendDm(normalizedTo, message);
      return { channel: "nostr", to: normalizedTo };
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
            channel: "nostr",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      publicKey: snapshot.publicKey ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
      profile: account.profile,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        publicKey: account.publicKey,
      });
      ctx.log?.info(
        `[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`,
      );

      if (!account.configured) {
        throw new Error("Nostr private key not configured");
      }

      const runtime = getNostrRuntime();

      // Track bus handle for metrics callback
      let busHandle: NostrBusHandle | null = null;

      const bus = await startNostrBus({
        accountId: account.accountId,
        privateKey: account.privateKey,
        relays: account.relays,
        onMessage: async (senderPubkey, text, reply) => {
          ctx.log?.debug(`[${account.accountId}] DM from ${senderPubkey}: ${text.slice(0, 50)}...`);

          const cfg = runtime.config.loadConfig();

          // Resolve agent route for this message
          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "nostr",
            peer: {
              kind: "dm",
              id: senderPubkey,
            },
          });

          // Build envelope for agent context
          const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });
          const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
          const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
            storePath,
            sessionKey: route.sessionKey,
          });
          const timestamp = Date.now();
          const body = runtime.channel.reply.formatAgentEnvelope({
            channel: "Nostr",
            from: senderPubkey.slice(0, 12) + "...",
            timestamp,
            previousTimestamp,
            envelope: envelopeOptions,
            body: text,
          });

          // Check if sender is allowed (for command authorization)
          const allowFrom = account.config.allowFrom ?? [];
          const normalizedSender = normalizePubkey(senderPubkey);
          const senderAllowed = allowFrom.length === 0 || allowFrom.some((entry) => {
            if (entry === "*") return true;
            try {
              return normalizePubkey(String(entry)) === normalizedSender;
            } catch {
              return String(entry) === senderPubkey;
            }
          });

          // Check for control commands
          const hasControlCommand = runtime.channel.text.hasControlCommand(text, cfg);
          const allowTextCommands = runtime.channel.commands.shouldHandleTextCommands({
            cfg,
            surface: "nostr",
          });
          const commandAuthorized = allowTextCommands && senderAllowed && hasControlCommand;

          // Build the inbound context
          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Body: body,
            RawBody: text,
            CommandBody: text,
            From: `nostr:${senderPubkey}`,
            To: `nostr:${account.publicKey}`,
            SessionKey: route.sessionKey,
            AccountId: account.accountId,
            ChatType: "direct",
            ConversationLabel: senderPubkey.slice(0, 12) + "...",
            SenderName: senderPubkey.slice(0, 12) + "...",
            SenderId: senderPubkey,
            Provider: "nostr" as const,
            Surface: "nostr" as const,
            Timestamp: timestamp,
            CommandAuthorized: commandAuthorized,
            CommandSource: "text" as const,
            OriginatingChannel: "nostr" as const,
            OriginatingTo: `nostr:${account.publicKey}`,
          });

          // Record inbound session
          await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            updateLastRoute: {
              sessionKey: route.mainSessionKey,
              channel: "nostr",
              to: `nostr:${account.publicKey}`,
              accountId: account.accountId,
            },
            onRecordError: (err) => {
              ctx.log?.warn?.(`[${account.accountId}] failed updating session meta: ${String(err)}`);
            },
          });

          // Set up typing callbacks (Nostr doesn't support typing indicators, so these are no-ops)
          const typingCallbacks = createTypingCallbacks({
            start: () => Promise.resolve(),
            stop: () => Promise.resolve(),
            onStartError: (err) => {
              logTypingFailure({
                log: (msg) => ctx.log?.debug?.(msg),
                channel: "nostr",
                action: "start",
                error: err,
              });
            },
          });

          // Set up reply prefix context
          const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

          // Create reply dispatcher
          const tableMode = runtime.channel.text.resolveMarkdownTableMode({
            cfg,
            channel: "nostr",
            accountId: account.accountId,
          });
          const { dispatcher, replyOptions, markDispatchIdle } =
            runtime.channel.reply.createReplyDispatcherWithTyping({
              responsePrefix: prefixContext.responsePrefix,
              responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
              humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
              deliver: async (payload) => {
                const message = runtime.channel.text.convertMarkdownTables(
                  payload.text ?? "",
                  tableMode,
                );
                if (message.trim()) {
                  await reply(message);
                }
              },
              onError: (err, info) => {
                ctx.log?.error(`[${account.accountId}] Nostr ${info.kind} reply failed: ${String(err)}`);
              },
              onReplyStart: typingCallbacks.onReplyStart,
              onIdle: typingCallbacks.onIdle,
            });

          // Dispatch the message to the agent
          try {
            const { queuedFinal, counts } = await runtime.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg,
              dispatcher,
              replyOptions: {
                ...replyOptions,
                onModelSelected: prefixContext.onModelSelected,
              },
            });
            markDispatchIdle();
            if (queuedFinal) {
              const finalCount = counts.final;
              ctx.log?.debug?.(
                `[${account.accountId}] delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${senderPubkey}`,
              );
            }
          } catch (err) {
            markDispatchIdle();
            ctx.log?.error(`[${account.accountId}] Nostr dispatch failed: ${String(err)}`);
          }
        },
        onError: (error, context) => {
          ctx.log?.error(`[${account.accountId}] Nostr error (${context}): ${error.message}`);
        },
        onConnect: (relay) => {
          ctx.log?.debug(`[${account.accountId}] Connected to relay: ${relay}`);
        },
        onDisconnect: (relay) => {
          ctx.log?.debug(`[${account.accountId}] Disconnected from relay: ${relay}`);
        },
        onEose: (relays) => {
          ctx.log?.debug(`[${account.accountId}] EOSE received from relays: ${relays}`);
        },
        onMetric: (event: MetricEvent) => {
          // Log significant metrics at appropriate levels
          if (event.name.startsWith("event.rejected.")) {
            ctx.log?.debug(`[${account.accountId}] Metric: ${event.name}`, event.labels);
          } else if (event.name === "relay.circuit_breaker.open") {
            ctx.log?.warn(
              `[${account.accountId}] Circuit breaker opened for relay: ${event.labels?.relay}`,
            );
          } else if (event.name === "relay.circuit_breaker.close") {
            ctx.log?.info(
              `[${account.accountId}] Circuit breaker closed for relay: ${event.labels?.relay}`,
            );
          } else if (event.name === "relay.error") {
            ctx.log?.debug(`[${account.accountId}] Relay error: ${event.labels?.relay}`);
          }
          // Update cached metrics snapshot
          if (busHandle) {
            metricsSnapshots.set(account.accountId, busHandle.getMetrics());
          }
        },
      });

      busHandle = bus;

      // Store the bus handle
      activeBuses.set(account.accountId, bus);

      ctx.log?.info(
        `[${account.accountId}] Nostr provider started, connected to ${account.relays.length} relay(s)`,
      );

      // Return cleanup function
      return {
        stop: () => {
          bus.close();
          activeBuses.delete(account.accountId);
          metricsSnapshots.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] Nostr provider stopped`);
        },
      };
    },
  },
};

/**
 * Get metrics snapshot for a Nostr account.
 * Returns undefined if account is not running.
 */
export function getNostrMetrics(
  accountId: string = DEFAULT_ACCOUNT_ID,
): MetricsSnapshot | undefined {
  const bus = activeBuses.get(accountId);
  if (bus) {
    return bus.getMetrics();
  }
  return metricsSnapshots.get(accountId);
}

/**
 * Get all active Nostr bus handles.
 * Useful for debugging and status reporting.
 */
export function getActiveNostrBuses(): Map<string, NostrBusHandle> {
  return new Map(activeBuses);
}

/**
 * Publish a profile (kind:0) for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @param profile - Profile data to publish
 * @returns Publish results with successes and failures
 * @throws Error if account is not running
 */
export async function publishNostrProfile(
  accountId: string = DEFAULT_ACCOUNT_ID,
  profile: NostrProfile,
): Promise<ProfilePublishResult> {
  const bus = activeBuses.get(accountId);
  if (!bus) {
    throw new Error(`Nostr bus not running for account ${accountId}`);
  }
  return bus.publishProfile(profile);
}

/**
 * Get profile publish state for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @returns Profile publish state or null if account not running
 */
export async function getNostrProfileState(accountId: string = DEFAULT_ACCOUNT_ID): Promise<{
  lastPublishedAt: number | null;
  lastPublishedEventId: string | null;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
} | null> {
  const bus = activeBuses.get(accountId);
  if (!bus) {
    return null;
  }
  return bus.getProfileState();
}
