/**
 * SoundChain Channel Plugin — OpenClaw Messaging Channel
 *
 * Turns SoundChain into an OpenClaw messaging channel. This means:
 * - OpenClaw agents can send DMs to SoundChain users via `sendText`
 * - Inbound messages are detected via 3s polling
 * - FURL replies via SMITH gateway (AI-powered, zero cost per user)
 *
 * Config (in openclaw config file under `channels.soundchain`):
 *   apiUrl:       GraphQL endpoint (default: https://api.soundchain.io)
 *   apiToken:     JWT for the bot account (required)
 *   accountName:  Display name (default: "SoundChain")
 *
 * Architecture:
 *   Pulse (PWA) ←→ SoundChain GraphQL ←→ OpenClaw Channel Plugin
 *                                              ↕
 *                                    OpenClaw Gateway (WebSocket)
 *                                              ↕
 *                                    WhatsApp / Telegram / Nostr
 */

import type { ChannelPlugin } from "../runtime-api.js";
import { createMessagingClient, type MessagingClient } from "./messaging.js";
import { generateReply } from "./responder.js";

// ---------------------------------------------------------------------------
// Account types
// ---------------------------------------------------------------------------

const DEFAULT_ACCOUNT_ID = "default";
const POLL_INTERVAL_MS = 3_000; // 3s — balanced between responsiveness and API load
const MAX_SEEN_IDS = 5_000;

export interface ResolvedSoundChainAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  apiUrl: string;
  apiToken: string;
  autoFollow: boolean;
}

// ---------------------------------------------------------------------------
// Module-level state (mirrors Nostr channel pattern)
// ---------------------------------------------------------------------------

/** Active messaging clients per account — used by outbound.sendText */
const activeClients = new Map<string, MessagingClient>();

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function extractChannelConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  return (channels.soundchain ?? {}) as Record<string, unknown>;
}

function resolveAccount(
  cfg: Record<string, unknown>,
  accountId?: string,
): ResolvedSoundChainAccount {
  const sc = extractChannelConfig(cfg);
  const apiUrl =
    typeof sc.apiUrl === "string" && sc.apiUrl ? sc.apiUrl : "https://api.soundchain.io";
  const apiToken = typeof sc.apiToken === "string" ? sc.apiToken : "";
  const accountName =
    typeof sc.accountName === "string" && sc.accountName ? sc.accountName : "SoundChain";
  const autoFollow = sc.autoFollow === true; // Opt-in, defaults to false

  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    name: accountName,
    enabled: !!apiToken,
    configured: !!apiToken,
    apiUrl,
    apiToken,
    autoFollow,
  };
}

// ---------------------------------------------------------------------------
// Channel plugin
// ---------------------------------------------------------------------------

export const soundchainChannelPlugin: ChannelPlugin<ResolvedSoundChainAccount> = {
  id: "soundchain",

  meta: {
    id: "soundchain",
    label: "SoundChain",
    selectionLabel: "SoundChain",
    docsPath: "/channels/soundchain",
    docsLabel: "soundchain",
    blurb: "DMs via SoundChain — decentralized music social network",
    order: 200,
  },

  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },

  reload: { configPrefixes: ["channels.soundchain"] },

  // ---------------------------------------------------------------------------
  // Config adapter — account resolution from OpenClaw config
  // ---------------------------------------------------------------------------

  config: {
    listAccountIds: (cfg) => {
      const sc = extractChannelConfig(cfg);
      return sc.apiToken ? [DEFAULT_ACCOUNT_ID] : [];
    },

    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId ?? undefined),

    defaultAccountId: () => DEFAULT_ACCOUNT_ID,

    isConfigured: (account) => account.configured,

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },

  // ---------------------------------------------------------------------------
  // Messaging adapter — target normalization
  // ---------------------------------------------------------------------------

  messaging: {
    normalizeTarget: (target) => target.trim(),
    targetResolver: {
      looksLikeId: (input) => {
        const trimmed = input.trim();
        // SoundChain profile IDs are MongoDB ObjectIds (24 hex chars)
        return /^[0-9a-fA-F]{24}$/.test(trimmed);
      },
      hint: "<SoundChain profile ID (24-char hex)>",
    },
  },

  // ---------------------------------------------------------------------------
  // Outbound adapter — send DMs via SoundChain GraphQL
  // ---------------------------------------------------------------------------

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 2000,

    sendText: async ({ to, text, accountId }) => {
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const client = activeClients.get(aid);

      if (!client) {
        throw new Error(`SoundChain messaging client not running for account ${aid}`);
      }

      const result = await client.sendMessage(to, text ?? "");

      return {
        channel: "soundchain" as const,
        to,
        messageId: result.id ?? `sc-${Date.now()}`,
      };
    },
  },

  // ---------------------------------------------------------------------------
  // Gateway adapter — lifecycle + inbound message polling
  // ---------------------------------------------------------------------------

  gateway: {
    startAccount: (ctx) => {
      const account = ctx.account;

      if (!account.configured) {
        throw new Error("SoundChain API token not configured — set channels.soundchain.apiToken");
      }

      // Return a long-running Promise that stays pending while the channel
      // is active. The OpenClaw gateway auto-restarts channels whose
      // startAccount Promise resolves — so we must block until aborted.
      return new Promise<void>((resolve, reject) => {
        void (async () => {
          // Handle already-aborted signal before starting any work
          if (ctx.abortSignal.aborted) { resolve(); return; }

          ctx.log?.info(`[${account.accountId}] Starting SoundChain channel (${account.name})`);

          // Create and store the messaging client
          const client = createMessagingClient(account.apiUrl, account.apiToken);
          activeClients.set(account.accountId, client);

          // Track last seen message timestamp per conversation.
          // The chats query returns one entry per conversation (id = conversation ID),
          // so we compare createdAt to detect new messages in existing conversations.
          const lastSeen = new Map<string, string>();
          let interval: ReturnType<typeof setInterval> | undefined;
          let followInterval: ReturnType<typeof setInterval> | undefined;
          let aborted = false;

          // Cleanup helper
          const cleanup = () => {
            aborted = true;
            if (interval) clearInterval(interval);
            if (followInterval) clearInterval(followInterval);
            activeClients.delete(account.accountId);
            ctx.log?.info(`[${account.accountId}] SoundChain channel stopped`);
          };

          // Listen for gateway abort signal (manual stop or shutdown)
          ctx.abortSignal.addEventListener(
            "abort",
            () => {
              cleanup();
              resolve();
            },
            { once: true },
          );

          // Seed with current chat timestamps so we don't replay history
          // MUST complete before polling starts to avoid duplicate replies on cold start
          try {
            const seedChats = await client.getChats();
            for (const chat of seedChats) {
              if (chat.id) {
                lastSeen.set(chat.id, chat.createdAt ?? "");
              }
            }
            ctx.log?.debug?.(
              `[${account.accountId}] Seeded ${lastSeen.size} existing conversations`,
            );
          } catch (err) {
            ctx.log?.warn?.(`[${account.accountId}] Initial chat seed failed: ${err}`);
          }

          // If aborted during seed, stop here — don't register timers
          if (aborted) return;

          // Auto-follow all users on startup, then re-check every 5 minutes
          const autoFollowAll = async () => {
            try {
              const users = await client.getAllUsers();
              if (aborted) return;
              let followed = 0;
              for (const user of users) {
                if (aborted) break;
                if (!user.isFollowed) {
                  try {
                    await client.followUser(user.id);
                    followed++;
                  } catch {
                    // skip individual follow errors (already following, etc)
                  }
                }
              }
              if (followed > 0) {
                ctx.log?.info(
                  `[${account.accountId}] Auto-followed ${followed} new users (${users.length} total)`,
                );
              }
            } catch (err) {
              ctx.log?.warn?.(`[${account.accountId}] Auto-follow error: ${err}`);
            }
          };

          // Auto-follow is opt-in (channels.soundchain.autoFollow: true)
          if (account.autoFollow) {
            autoFollowAll();
            followInterval = setInterval(autoFollowAll, 5 * 60 * 1000);
          }

          // Poll for new inbound messages (starts AFTER seed completes)
          // Single-flight guard prevents overlapping iterations
          let polling = false;
          interval = setInterval(async () => {
            if (polling || aborted) return;
            polling = true;
            try {
              const chats = await client.getChats();
              if (aborted) { polling = false; return; }

              for (const chat of chats) {
                if (!chat.id || aborted) continue;

                const prevTimestamp = lastSeen.get(chat.id);
                const currentTimestamp = chat.createdAt ?? "";

                // Skip if we've already seen this exact message
                if (prevTimestamp === currentTimestamp) continue;

                // Skip read messages (only process unread)
                if (!chat.unread) continue;

                // Cap tracked conversations to prevent unbounded growth
                if (lastSeen.size > MAX_SEEN_IDS) {
                  const entries = Array.from(lastSeen.keys());
                  for (let i = 0; i < entries.length - MAX_SEEN_IDS; i++) {
                    lastSeen.delete(entries[i]);
                  }
                }

                const sender = chat.profile?.displayName ?? "unknown";
                const preview = chat.message?.slice(0, 80) ?? "";

                ctx.log?.info(
                  `[${account.accountId}] New DM from ${sender}: ${preview}${(chat.message?.length ?? 0) > 80 ? "..." : ""}`,
                );

                // Generate AI reply via SMITH gateway and send back
                const profileId = chat.profile?.id;
                if (profileId && chat.message) {
                  try {
                    ctx.log?.info(`[${account.accountId}] Generating reply for ${sender}...`);
                    const reply = await generateReply(sender, chat.message);
                    if (aborted) break;
                    await client.sendMessage(profileId, reply);
                    // Only update timestamp AFTER successful reply (retry on failure)
                    lastSeen.set(chat.id, currentTimestamp);
                    ctx.log?.info(
                      `[${account.accountId}] Replied to ${sender}: ${reply.slice(0, 80)}${reply.length > 80 ? "..." : ""}`,
                    );
                  } catch (err) {
                    ctx.log?.warn?.(`[${account.accountId}] Reply failed for ${sender}: ${err}`);
                  }
                }
              }
            } catch (err) {
              ctx.log?.warn?.(`[${account.accountId}] Poll error: ${err}`);
            } finally {
              polling = false;
            }
          }, POLL_INTERVAL_MS);

          ctx.log?.info(
            `[${account.accountId}] SoundChain channel started — polling every ${POLL_INTERVAL_MS / 1000}s`,
          );
        })();
      });
    },
  },
};
