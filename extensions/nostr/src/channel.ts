import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  buildPassiveChannelStatusSummary,
  buildTrafficStatusSummary,
} from "openclaw/plugin-sdk/extension-shared";
import {
  buildComputedAccountStatusSnapshot,
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createPreCryptoDirectDmAuthorizer,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  dispatchInboundDirectDmWithRuntime,
  formatPairingApproveHint,
  resolveInboundDirectDmAccessWithRuntime,
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
  cfg: Parameters<typeof resolveInboundDirectDmAccessWithRuntime>[0]["cfg"];
  accountId: string;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom: Array<string | number> | undefined;
  senderPubkey: string;
  rawBody: string;
  runtime: Parameters<typeof resolveInboundDirectDmAccessWithRuntime>[0]["runtime"];
}) {
  return resolveInboundDirectDmAccessWithRuntime({
    cfg: params.cfg,
    channel: "nostr",
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
    allowFrom: params.allowFrom,
    senderId: params.senderPubkey,
    rawBody: params.rawBody,
    isSenderAllowed: isNostrSenderAllowed,
    runtime: params.runtime,
    modeWhenAccessGroupsOff: "configured",
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

export const nostrPlugin: ChannelPlugin<ResolvedNostrAccount> = createChatChannelPlugin({
  base: {
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
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            publicKey: account.publicKey,
          },
        }),
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
    status: {
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
      buildChannelSummary: ({ snapshot }) =>
        buildPassiveChannelStatusSummary(snapshot, {
          publicKey: snapshot.publicKey ?? null,
        }),
      buildAccountSnapshot: ({ account, runtime }) =>
        buildComputedAccountStatusSnapshot(
          {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.configured,
            runtime,
          },
          {
            publicKey: account.publicKey,
            profile: account.profile,
            ...buildTrafficStatusSummary(runtime),
          },
        ),
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
        const resolveInboundAccess = async (senderPubkey: string, rawBody: string) =>
          await resolveNostrDirectAccess({
            cfg: ctx.cfg,
            accountId: account.accountId,
            dmPolicy: account.config.dmPolicy ?? "pairing",
            allowFrom: account.config.allowFrom,
            senderPubkey,
            rawBody,
            runtime: {
              shouldComputeCommandAuthorized:
                runtime.channel.commands.shouldComputeCommandAuthorized,
              resolveCommandAuthorizedFromAuthorizers:
                runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers,
            },
          });

        // Track bus handle for metrics callback
        let busHandle: NostrBusHandle | null = null;

        const authorizeSender = createPreCryptoDirectDmAuthorizer({
          resolveAccess: async (senderPubkey) => await resolveInboundAccess(senderPubkey, ""),
          issuePairingChallenge: async ({ senderId, reply }) => {
            await pairing.issueChallenge({
              senderId,
              senderIdLine: `Your Nostr pubkey: ${senderId}`,
              sendPairingReply: reply,
              onCreated: () => {
                ctx.log?.debug?.(`[${account.accountId}] nostr pairing request sender=${senderId}`);
              },
              onReplyError: (err) => {
                ctx.log?.warn?.(
                  `[${account.accountId}] nostr pairing reply failed for ${senderId}: ${String(err)}`,
                );
              },
            });
          },
          onBlocked: ({ senderId, reason }) => {
            ctx.log?.debug?.(`[${account.accountId}] blocked Nostr sender ${senderId} (${reason})`);
          },
        });

        const bus = await startNostrBus({
          accountId: account.accountId,
          privateKey: account.privateKey,
          relays: account.relays,
          authorizeSender: async ({ senderPubkey, reply }) =>
            await authorizeSender({ senderId: senderPubkey, reply }),
          onMessage: async (senderPubkey, text, reply, meta) => {
            const resolvedAccess = await resolveInboundAccess(senderPubkey, text);
            if (resolvedAccess.access.decision !== "allow") {
              ctx.log?.warn?.(
                `[${account.accountId}] dropping Nostr DM after preflight drift (${senderPubkey}, ${resolvedAccess.access.reason})`,
              );
              return;
            }

            await dispatchInboundDirectDmWithRuntime({
              cfg: ctx.cfg,
              runtime,
              channel: "nostr",
              channelLabel: "Nostr",
              accountId: account.accountId,
              peer: {
                kind: "direct",
                id: senderPubkey,
              },
              senderId: senderPubkey,
              senderAddress: `nostr:${senderPubkey}`,
              recipientAddress: `nostr:${account.publicKey}`,
              conversationLabel: senderPubkey,
              rawBody: text,
              messageId: meta.eventId,
              timestamp: meta.createdAt * 1000,
              commandAuthorized: resolvedAccess.commandAuthorized,
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
                  accountId: account.accountId,
                });
                await reply(runtime.channel.text.convertMarkdownTables(outboundText, tableMode));
              },
              onRecordError: (err) => {
                ctx.log?.error?.(
                  `[${account.accountId}] failed recording Nostr inbound session: ${String(err)}`,
                );
              },
              onDispatchError: (err, info) => {
                ctx.log?.error?.(
                  `[${account.accountId}] Nostr ${info.kind} reply failed: ${String(err)}`,
                );
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
});

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
