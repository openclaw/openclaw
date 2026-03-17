import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  mapAllowFromEntries
} from "openclaw/plugin-sdk/nostr";
import {
  buildPassiveChannelStatusSummary,
  buildTrafficStatusSummary
} from "../../shared/channel-status-summary.js";
import { NostrConfigSchema } from "./config-schema.js";
import { normalizePubkey, startNostrBus } from "./nostr-bus.js";
import { getNostrRuntime } from "./runtime.js";
import {
  listNostrAccountIds,
  resolveDefaultNostrAccountId,
  resolveNostrAccount
} from "./types.js";
const activeBuses = /* @__PURE__ */ new Map();
const metricsSnapshots = /* @__PURE__ */ new Map();
const nostrPlugin = {
  id: "nostr",
  meta: {
    id: "nostr",
    label: "Nostr",
    selectionLabel: "Nostr",
    docsPath: "/channels/nostr",
    docsLabel: "nostr",
    blurb: "Decentralized DMs via Nostr relays (NIP-04)",
    order: 100
  },
  capabilities: {
    chatTypes: ["direct"],
    // DMs only for MVP
    media: false
    // No media for MVP
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
      publicKey: account.publicKey
    }),
    resolveAllowFrom: ({ cfg, accountId }) => mapAllowFromEntries(resolveNostrAccount({ cfg, accountId }).config.allowFrom),
    formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => {
      if (entry === "*") {
        return "*";
      }
      try {
        return normalizePubkey(entry);
      } catch {
        return entry;
      }
    }).filter(Boolean)
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
      const bus = activeBuses.get(DEFAULT_ACCOUNT_ID);
      if (bus) {
        await bus.sendDm(id, "Your pairing request has been approved!");
      }
    }
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
        }
      };
    }
  },
  messaging: {
    normalizeTarget: (target) => {
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
      hint: "<npub|hex pubkey|nostr:npub...>"
    }
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4e3,
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
        accountId: aid
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      const normalizedTo = normalizePubkey(to);
      await bus.sendDm(normalizedTo, message);
      return {
        channel: "nostr",
        to: normalizedTo,
        messageId: `nostr-${Date.now()}`
      };
    }
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
    buildChannelSummary: ({ snapshot }) => buildPassiveChannelStatusSummary(snapshot, {
      publicKey: snapshot.publicKey ?? null
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
      ...buildTrafficStatusSummary(runtime)
    })
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        publicKey: account.publicKey
      });
      ctx.log?.info(
        `[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`
      );
      if (!account.configured) {
        throw new Error("Nostr private key not configured");
      }
      const runtime = getNostrRuntime();
      let busHandle = null;
      const bus = await startNostrBus({
        accountId: account.accountId,
        privateKey: account.privateKey,
        relays: account.relays,
        onMessage: async (senderPubkey, text, reply) => {
          ctx.log?.debug?.(
            `[${account.accountId}] DM from ${senderPubkey}: ${text.slice(0, 50)}...`
          );
          await runtime.channel.reply.handleInboundMessage?.({
            channel: "nostr",
            accountId: account.accountId,
            senderId: senderPubkey,
            chatType: "direct",
            chatId: senderPubkey,
            // For DMs, chatId is the sender's pubkey
            text,
            reply: async (responseText) => {
              await reply(responseText);
            }
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
        onMetric: (event) => {
          if (event.name.startsWith("event.rejected.")) {
            ctx.log?.debug?.(
              `[${account.accountId}] Metric: ${event.name} ${JSON.stringify(event.labels)}`
            );
          } else if (event.name === "relay.circuit_breaker.open") {
            ctx.log?.warn?.(
              `[${account.accountId}] Circuit breaker opened for relay: ${event.labels?.relay}`
            );
          } else if (event.name === "relay.circuit_breaker.close") {
            ctx.log?.info?.(
              `[${account.accountId}] Circuit breaker closed for relay: ${event.labels?.relay}`
            );
          } else if (event.name === "relay.error") {
            ctx.log?.debug?.(`[${account.accountId}] Relay error: ${event.labels?.relay}`);
          }
          if (busHandle) {
            metricsSnapshots.set(account.accountId, busHandle.getMetrics());
          }
        }
      });
      busHandle = bus;
      activeBuses.set(account.accountId, bus);
      ctx.log?.info(
        `[${account.accountId}] Nostr provider started, connected to ${account.relays.length} relay(s)`
      );
      return {
        stop: () => {
          bus.close();
          activeBuses.delete(account.accountId);
          metricsSnapshots.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] Nostr provider stopped`);
        }
      };
    }
  }
};
function getNostrMetrics(accountId = DEFAULT_ACCOUNT_ID) {
  const bus = activeBuses.get(accountId);
  if (bus) {
    return bus.getMetrics();
  }
  return metricsSnapshots.get(accountId);
}
function getActiveNostrBuses() {
  return new Map(activeBuses);
}
async function publishNostrProfile(accountId = DEFAULT_ACCOUNT_ID, profile) {
  const bus = activeBuses.get(accountId);
  if (!bus) {
    throw new Error(`Nostr bus not running for account ${accountId}`);
  }
  return bus.publishProfile(profile);
}
async function getNostrProfileState(accountId = DEFAULT_ACCOUNT_ID) {
  const bus = activeBuses.get(accountId);
  if (!bus) {
    return null;
  }
  return bus.getProfileState();
}
export {
  getActiveNostrBuses,
  getNostrMetrics,
  getNostrProfileState,
  nostrPlugin,
  publishNostrProfile
};
