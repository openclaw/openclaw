import {
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth";
import {
  buildPassiveChannelStatusSummary,
  buildTrafficStatusSummary,
} from "openclaw/plugin-sdk/extension-shared";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import {
  buildChannelConfigSchema,
  createChannelReplyPipeline,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "../runtime-api.js";
import type { NostrProfile } from "./config-schema.js";
import { NostrConfigSchema } from "./config-schema.js";
import type { MetricEvent, MetricsSnapshot } from "./metrics.js";
import { normalizePubkey, startNostrBus, type NostrBusHandle } from "./nostr-bus.js";
import type { ProfilePublishResult } from "./nostr-profile.js";
import { getNostrRuntime } from "./runtime.js";
import { resolveNostrOutboundSessionRoute } from "./session-route.js";
import { nostrSetupAdapter, nostrSetupWizard } from "./setup-surface.js";
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

function normalizeNostrAllowEntry(entry: string): string | "*" | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  try {
    return normalizePubkey(trimmed.replace(/^nostr:/i, ""));
  } catch {
    return null;
  }
}

function isNostrSenderAllowed(senderPubkey: string, allowFrom: string[]): boolean {
  const normalizedSender = normalizePubkey(senderPubkey);
  for (const entry of allowFrom) {
    const normalized = normalizeNostrAllowEntry(entry);
    if (normalized === "*") {
      return true;
    }
    if (normalized === normalizedSender) {
      return true;
    }
  }
  return false;
}

async function resolveNostrDirectAccess(params: {
  accountId: string;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom: Array<string | number> | undefined;
  senderPubkey: string;
}) {
  const storeAllowFrom =
    params.dmPolicy === "pairing"
      ? await readStoreAllowFromForDmPolicy({
          provider: "nostr",
          accountId: params.accountId,
          dmPolicy: params.dmPolicy,
        })
      : [];

  return resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy: params.dmPolicy,
    allowFrom: params.allowFrom,
    storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowEntries) => isNostrSenderAllowed(params.senderPubkey, allowEntries),
  });
}

const resolveNostrDmPolicy = createScopedDmSecurityResolver<ResolvedNostrAccount>({
  channelKey: "nostr",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  approveHint: formatPairingApproveHint("nostr"),
  normalizeEntry: (raw) => {
    try {
      return normalizePubkey(raw.trim().replace(/^nostr:/i, ""));
    } catch {
      return raw.trim();
    }
  },
});

const nostrConfigAdapter = createTopLevelChannelConfigAdapter<ResolvedNostrAccount>({
  sectionKey: "nostr",
  resolveAccount: (cfg) => resolveNostrAccount({ cfg }),
  listAccountIds: listNostrAccountIds,
  defaultAccountId: resolveDefaultNostrAccountId,
  deleteMode: "clear-fields",
  clearBaseFields: [
    "name",
    "defaultAccount",
    "privateKey",
    "relays",
    "dmPolicy",
    "allowFrom",
    "profile",
  ],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
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
          return entry;
        }
      })
      .filter(Boolean),
});

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
  setup: nostrSetupAdapter,
  setupWizard: nostrSetupWizard,

  config: {
    ...nostrConfigAdapter,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
    }),
  },

  pairing: {
    idLabel: "nostrPubkey",
    normalizeAllowEntry: (entry) => {
      try {
        return normalizePubkey(entry.trim().replace(/^nostr:/i, ""));
      } catch {
        return entry.trim();
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
    resolveDmPolicy: resolveNostrDmPolicy,
  },

  messaging: {
    normalizeTarget: (target) => {
      // Strip nostr: prefix if present
      const cleaned = target.trim().replace(/^nostr:/i, "");
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
    resolveOutboundSessionRoute: (params) => resolveNostrOutboundSessionRoute(params),
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId }) => {
      const core = getNostrRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`Nostr bus not running for account ${aid}`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "nostr",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      const normalizedTo = normalizePubkey(to);
      await bus.sendDm(normalizedTo, message);
      return attachChannelToResult("nostr", {
        to: normalizedTo,
        messageId: `nostr-${Date.now()}`,
      });
    },
  },

  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
    buildChannelSummary: ({ snapshot }) =>
      buildPassiveChannelStatusSummary(snapshot, {
        publicKey: snapshot.publicKey ?? null,
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
      ...buildTrafficStatusSummary(runtime),
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
      const pairing = createChannelPairingController({
        core: runtime,
        channel: "nostr",
        accountId: account.accountId,
      });

      // Track bus handle for metrics callback
      let busHandle: NostrBusHandle | null = null;

      const bus = await startNostrBus({
        accountId: account.accountId,
        privateKey: account.privateKey,
        relays: account.relays,
        authorizeSender: async ({ senderPubkey, reply }) => {
          const dmPolicy = account.config.dmPolicy ?? "pairing";
          const access = await resolveNostrDirectAccess({
            accountId: account.accountId,
            dmPolicy,
            allowFrom: account.config.allowFrom,
            senderPubkey,
          });
          if (access.decision === "allow") {
            return "allow";
          }
          if (access.decision === "pairing") {
            await pairing.issueChallenge({
              senderId: senderPubkey,
              senderIdLine: `Your Nostr pubkey: ${senderPubkey}`,
              sendPairingReply: reply,
              onCreated: () => {
                ctx.log?.debug?.(
                  `[${account.accountId}] nostr pairing request sender=${senderPubkey}`,
                );
              },
              onReplyError: (err) => {
                ctx.log?.warn?.(
                  `[${account.accountId}] nostr pairing reply failed for ${senderPubkey}: ${String(err)}`,
                );
              },
            });
            return "pairing";
          }
          ctx.log?.debug?.(
            `[${account.accountId}] blocked Nostr sender ${senderPubkey} (${access.reason})`,
          );
          return "block";
        },
        onMessage: async (senderPubkey, text, reply, meta) => {
          const dmPolicy = account.config.dmPolicy ?? "pairing";
          const access = await resolveNostrDirectAccess({
            accountId: account.accountId,
            dmPolicy,
            allowFrom: account.config.allowFrom,
            senderPubkey,
          });
          if (access.decision !== "allow") {
            ctx.log?.warn?.(
              `[${account.accountId}] dropping Nostr DM after preflight drift (${senderPubkey}, ${access.reason})`,
            );
            return;
          }

          const shouldComputeAuth = runtime.channel.commands.shouldComputeCommandAuthorized(
            text,
            ctx.cfg,
          );
          const senderAllowedForCommands = isNostrSenderAllowed(
            senderPubkey,
            access.effectiveAllowFrom,
          );
          const commandAuthorized = shouldComputeAuth
            ? dmPolicy === "open"
              ? true
              : resolveCommandAuthorizedFromAuthorizers({
                  useAccessGroups: ctx.cfg.commands?.useAccessGroups !== false,
                  authorizers: [
                    {
                      configured: access.effectiveAllowFrom.length > 0,
                      allowed: senderAllowedForCommands,
                    },
                  ],
                  modeWhenAccessGroupsOff: "configured",
                })
            : undefined;

          const route = runtime.channel.routing.resolveAgentRoute({
            cfg: ctx.cfg,
            channel: "nostr",
            accountId: account.accountId,
            peer: {
              kind: "direct",
              id: senderPubkey,
            },
          });
          const storePath = runtime.channel.session.resolveStorePath(ctx.cfg.session?.store, {
            agentId: route.agentId,
          });
          const body = runtime.channel.reply.formatAgentEnvelope({
            channel: "Nostr",
            from: senderPubkey,
            timestamp: meta.createdAt * 1000,
            envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(ctx.cfg),
            body: text,
          });
          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Body: body,
            BodyForAgent: text,
            RawBody: text,
            CommandBody: text,
            From: `nostr:${senderPubkey}`,
            To: `nostr:${account.publicKey}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "direct",
            ConversationLabel: senderPubkey,
            SenderId: senderPubkey,
            Provider: "nostr",
            Surface: "nostr",
            MessageSid: meta.eventId,
            MessageSidFull: meta.eventId,
            CommandAuthorized: commandAuthorized,
            OriginatingChannel: "nostr",
            OriginatingTo: `nostr:${account.publicKey}`,
          });
          await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            onRecordError: (err) => {
              ctx.log?.error?.(
                `[${account.accountId}] failed recording Nostr inbound session: ${String(err)}`,
              );
            },
          });

          const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
            cfg: ctx.cfg,
            agentId: route.agentId,
            channel: "nostr",
            accountId: route.accountId,
          });
          await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg: ctx.cfg,
            dispatcherOptions: {
              ...replyPipeline,
              deliver: async (payload) => {
                const outboundText =
                  payload && typeof payload === "object" && "text" in payload
                    ? String((payload as { text?: string }).text ?? "")
                    : "";
                if (!outboundText.trim()) {
                  return;
                }
                const tableMode = runtime.channel.text.resolveMarkdownTableMode({
                  cfg: ctx.cfg,
                  channel: "nostr",
                  accountId: route.accountId,
                });
                await reply(runtime.channel.text.convertMarkdownTables(outboundText, tableMode));
              },
              onError: (err, info) => {
                ctx.log?.error?.(
                  `[${account.accountId}] Nostr ${info.kind} reply failed: ${String(err)}`,
                );
              },
            },
            replyOptions: {
              onModelSelected,
            },
          });
        },
        onError: (error, context) => {
          ctx.log?.error?.(`[${account.accountId}] Nostr error (${context}): ${error.message}`);
        },
        onConnect: (relay) => {
          ctx.log?.debug?.(`[${account.accountId}] Connected to relay: ${relay}`);
        },
        onDisconnect: (relay) => {
          ctx.log?.debug?.(`[${account.accountId}] Disconnected from relay: ${relay}`);
        },
        onEose: (relays) => {
          ctx.log?.debug?.(`[${account.accountId}] EOSE received from relays: ${relays}`);
        },
        onMetric: (event: MetricEvent) => {
          // Log significant metrics at appropriate levels
          if (event.name.startsWith("event.rejected.")) {
            ctx.log?.debug?.(
              `[${account.accountId}] Metric: ${event.name} ${JSON.stringify(event.labels)}`,
            );
          } else if (event.name === "relay.circuit_breaker.open") {
            ctx.log?.warn?.(
              `[${account.accountId}] Circuit breaker opened for relay: ${event.labels?.relay}`,
            );
          } else if (event.name === "relay.circuit_breaker.close") {
            ctx.log?.info?.(
              `[${account.accountId}] Circuit breaker closed for relay: ${event.labels?.relay}`,
            );
          } else if (event.name === "relay.error") {
            ctx.log?.debug?.(`[${account.accountId}] Relay error: ${event.labels?.relay}`);
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
