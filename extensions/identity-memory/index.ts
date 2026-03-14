/**
 * OpenClaw plugin: cross-platform identity linking + multi-layer memory.
 *
 * Adds three capabilities that OpenClaw lacks:
 * 1. Cross-platform identity — link the same person across Feishu, Telegram,
 *    Discord, etc., with verification-code-based linking.
 * 2. Episodic memory — per-user journal of interaction summaries, searchable
 *    by tags and keywords, with automatic compression.
 * 3. Semantic memory — evolving user profiles (preferences, expertise, topics)
 *    built from conversation history.
 *
 * Integration points:
 * - `message_received` hook: resolve sender identity on every inbound message.
 * - `before_prompt_build` hook: inject memory context into agent prompts.
 * - `agent_end` hook: record interaction and update profile.
 * - Agent tools: identity_link, identity_search, memory_recall, memory_record.
 * - Service: manages store lifecycle (load on start, periodic save).
 */

import { Type } from "@sinclair/typebox";
import type {
  OpenClawPluginApi,
  PluginHookMessageReceivedEvent,
  PluginHookMessageContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginCommandContext,
} from "openclaw/plugin-sdk/identity-memory";
import { buildMemoryContext } from "./src/context-builder.js";
import { IdentityStore } from "./src/identity-store.js";
import { MemoryStore } from "./src/memory-store.js";
import type { IdentityMemoryConfig } from "./src/types.js";

function parseConfig(value: unknown): IdentityMemoryConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    maxEpisodicEntries: typeof raw.maxEpisodicEntries === "number" ? raw.maxEpisodicEntries : 800,
    verificationTtlSec: typeof raw.verificationTtlSec === "number" ? raw.verificationTtlSec : 600,
    maxVerificationAttempts:
      typeof raw.maxVerificationAttempts === "number" ? raw.maxVerificationAttempts : 5,
    injectMemoryContext:
      typeof raw.injectMemoryContext === "boolean" ? raw.injectMemoryContext : true,
    maxContextLength: typeof raw.maxContextLength === "number" ? raw.maxContextLength : 2000,
  };
}

const configSchema = {
  parse: parseConfig,
  uiHints: {
    enabled: { label: "Enabled", help: "Enable cross-platform identity and memory." },
    maxEpisodicEntries: {
      label: "Max Episodic Entries",
      help: "Compress oldest entries when this limit is reached.",
      advanced: true,
    },
    verificationTtlSec: {
      label: "Verification Code TTL (sec)",
      help: "How long a linking verification code is valid.",
      advanced: true,
    },
    maxVerificationAttempts: {
      label: "Max Verification Attempts",
      advanced: true,
    },
    injectMemoryContext: {
      label: "Inject Memory Context",
      help: "Prepend user profile and relevant memories to agent prompts.",
    },
    maxContextLength: {
      label: "Max Context Length",
      help: "Maximum character length of injected memory context.",
      advanced: true,
    },
  },
};

// Sender identity resolved during message_received, keyed by "channelId:senderId".
const resolvedIdentities = new Map<string, string>();

const identityMemoryPlugin = {
  id: "identity-memory",
  name: "Identity & Memory",
  description: "Cross-platform identity linking and multi-layer memory (episodic + semantic)",
  configSchema,

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);
    if (!config.enabled) {
      api.logger.info("[identity-memory] Plugin disabled via config");
      return;
    }

    const stateDir = api.resolvePath("~/.openclaw/identity-memory");
    const identityStore = new IdentityStore(stateDir);
    const memoryStore = new MemoryStore(stateDir);

    // Save interval handle for cleanup.
    let saveInterval: ReturnType<typeof setInterval> | null = null;

    // =========================================================================
    // Service: load on start, periodic save, save on stop.
    // =========================================================================
    api.registerService({
      id: "identity-memory",
      start: async () => {
        await identityStore.load();
        await memoryStore.load();
        // Periodic save every 30 seconds.
        saveInterval = setInterval(async () => {
          try {
            await identityStore.save();
            await memoryStore.save();
          } catch (err) {
            api.logger.error(
              `[identity-memory] Save failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }, 30_000);
        api.logger.info("[identity-memory] Service started");
      },
      stop: async () => {
        if (saveInterval) {
          clearInterval(saveInterval);
          saveInterval = null;
        }
        await identityStore.save();
        await memoryStore.save();
        api.logger.info("[identity-memory] Service stopped");
      },
    });

    // =========================================================================
    // Hook: message_received — resolve sender identity.
    // =========================================================================
    api.on(
      "message_received",
      (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => {
        if (!ctx.channelId) {
          return;
        }
        const senderId = event.from;
        if (!senderId) {
          return;
        }
        const { identityId } = identityStore.resolveSender(
          ctx.channelId,
          senderId,
          event.metadata?.senderName as string | undefined,
        );
        resolvedIdentities.set(`${ctx.channelId}:${senderId}`, identityId);
      },
      { priority: 100 }, // Run early so identity is available to other hooks.
    );

    // =========================================================================
    // Hook: before_prompt_build — inject memory context.
    // =========================================================================
    if (config.injectMemoryContext) {
      api.on(
        "before_prompt_build",
        async (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => {
          const identityId = resolveIdentityFromCtx(ctx.channelId, event);
          if (!identityId) {
            return;
          }
          const memCtx = await buildMemoryContext({
            identityStore,
            memoryStore,
            identityId,
            currentMessage: event.prompt,
            maxLength: config.maxContextLength,
          });
          if (memCtx) {
            return { prependContext: memCtx };
          }
        },
      );
    }

    // =========================================================================
    // Hook: agent_end — record interaction, update profile.
    // =========================================================================
    api.on("agent_end", async (_event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
      const identityId = resolveIdentityFromAgentCtx(ctx);
      if (!identityId) {
        return;
      }
      // Update interaction count.
      memoryStore.recordInteraction(identityId);

      // Check compression threshold.
      const count = await memoryStore.countEpisodic(identityId);
      if (count > config.maxEpisodicEntries) {
        const keepCount = Math.floor(config.maxEpisodicEntries * 0.75);
        await memoryStore.compressEpisodic(identityId, keepCount);
        api.logger.info(
          `[identity-memory] Compressed episodic memory for ${identityId}: ${count} → ${keepCount}`,
        );
      }

      // Clean expired verification codes.
      identityStore.cleanExpiredVerifications(config.verificationTtlSec * 1000);
    });

    // =========================================================================
    // Tool: identity_link — manage cross-platform identity linking.
    // =========================================================================
    api.registerTool({
      name: "identity_link",
      label: "Identity Link",
      description:
        "Link user accounts across platforms (Feishu, Telegram, Discord, etc.) " +
        "to create a unified identity. Supports: search by name, initiate " +
        "verification, verify code, list linked platforms.",
      parameters: Type.Object({
        action: Type.String({
          description:
            'Action: "search" (find identity by name), "initiate" (start linking), ' +
            '"verify" (verify code), "list" (show linked platforms), "info" (identity details)',
        }),
        name: Type.Optional(Type.String({ description: "Name to search for" })),
        identityId: Type.Optional(Type.String({ description: "Target identity ID" })),
        platform: Type.Optional(
          Type.String({ description: "Platform name (e.g. telegram, feishu)" }),
        ),
        platformUserId: Type.Optional(
          Type.String({ description: "User ID on the target platform" }),
        ),
        code: Type.Optional(Type.String({ description: "Verification code" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const action = String(params?.action || "");

          switch (action) {
            case "search": {
              const name = String(params?.name || "").trim();
              if (!name) {
                return json({ error: "name required for search" });
              }
              const results = identityStore.searchByName(name);
              return json({
                results: results.map((r) => ({
                  id: r.id,
                  name: r.name,
                  platforms: Object.keys(r.links),
                })),
              });
            }

            case "initiate": {
              const identityId = String(params?.identityId || "").trim();
              const targetPlatform = String(params?.platform || "").trim();
              const targetUserId = String(params?.platformUserId || "").trim();
              if (!identityId || !targetPlatform || !targetUserId) {
                return json({
                  error: "identityId, platform, and platformUserId required",
                });
              }
              const identity = identityStore.getIdentity(identityId);
              if (!identity) {
                return json({ error: "identity not found" });
              }
              // Use first existing link as the "from" platform.
              const fromPlatforms = Object.entries(identity.links);
              if (fromPlatforms.length === 0) {
                return json({ error: "identity has no existing platform links" });
              }
              const [fromPlatform, fromUserId] = fromPlatforms[0];
              const code = identityStore.createVerification({
                identityId,
                fromPlatform,
                fromPlatformUserId: fromUserId,
                targetPlatform,
                targetPlatformUserId: targetUserId,
              });
              return json({
                code,
                expiresInSec: config.verificationTtlSec,
                instruction: `Send this code on ${targetPlatform} to complete linking: ${code}`,
              });
            }

            case "verify": {
              const code = String(params?.code || "").trim();
              if (!code) {
                return json({ error: "code required" });
              }
              const result = identityStore.verifyCode(
                code,
                config.verificationTtlSec * 1000,
                config.maxVerificationAttempts,
              );
              if (!result.ok) {
                return json({ error: result.error });
              }
              return json({
                success: true,
                identityId: result.identityId,
                message: "Platforms linked successfully",
              });
            }

            case "list": {
              const identityId = String(params?.identityId || "").trim();
              if (!identityId) {
                return json({ error: "identityId required" });
              }
              const platforms = identityStore.getLinkedPlatforms(identityId);
              return json({ identityId, platforms });
            }

            case "info": {
              const identityId = String(params?.identityId || "").trim();
              if (!identityId) {
                return json({ error: "identityId required" });
              }
              const identity = identityStore.getIdentity(identityId);
              if (!identity) {
                return json({ error: "identity not found" });
              }
              return json(identity);
            }

            default:
              return json({
                error: `Unknown action: ${action}. Use: search, initiate, verify, list, info`,
              });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // =========================================================================
    // Tool: memory_manage — record and recall episodic memories + profiles.
    // =========================================================================
    api.registerTool({
      name: "memory_manage",
      label: "Memory Manager",
      description:
        "Record and recall user memories. Supports: record (write episodic entry), " +
        "recall (search memories by tags/keyword), profile (view/update user profile).",
      parameters: Type.Object({
        action: Type.String({
          description:
            'Action: "record" (write diary entry), "recall" (search memories), ' +
            '"profile" (get/update user profile)',
        }),
        identityId: Type.Optional(Type.String({ description: "Identity ID" })),
        summary: Type.Optional(
          Type.String({ description: "Summary for episodic entry (record action)" }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), { description: "Tags for recording or filtering" }),
        ),
        insights: Type.Optional(
          Type.Array(Type.String(), { description: "Insights from the interaction" }),
        ),
        keyword: Type.Optional(Type.String({ description: "Keyword for recall search" })),
        limit: Type.Optional(Type.Number({ description: "Max results for recall" })),
        name: Type.Optional(Type.String({ description: "Update profile name" })),
        preferences: Type.Optional(
          Type.Array(Type.String(), { description: "Update profile preferences" }),
        ),
        expertise: Type.Optional(
          Type.Array(Type.String(), { description: "Update profile expertise" }),
        ),
        topics: Type.Optional(Type.Array(Type.String(), { description: "Update recent topics" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const action = String(params?.action || "");
          const identityId = String(params?.identityId || "").trim();

          if (!identityId) {
            return json({ error: "identityId required" });
          }

          switch (action) {
            case "record": {
              const summary = String(params?.summary || "").trim();
              if (!summary) {
                return json({ error: "summary required for record" });
              }
              const entry = await memoryStore.writeEpisodic({
                identityId,
                summary,
                tags: (params?.tags as string[]) || [],
                insights: params?.insights as string[] | undefined,
              });
              return json({ recorded: true, entryId: entry.id });
            }

            case "recall": {
              const results = await memoryStore.searchEpisodic({
                identityId,
                tags: params?.tags as string[] | undefined,
                keyword: params?.keyword as string | undefined,
                limit: typeof params?.limit === "number" ? params.limit : 10,
              });
              return json({ count: results.length, entries: results });
            }

            case "profile": {
              // If update fields provided, update first.
              if (params?.name || params?.preferences || params?.expertise || params?.topics) {
                const updated = memoryStore.updateProfile(identityId, {
                  name: params.name as string | undefined,
                  preferences: params.preferences as string[] | undefined,
                  expertise: params.expertise as string[] | undefined,
                  recentTopics: params.topics as string[] | undefined,
                });
                return json({ updated: true, profile: updated });
              }
              // Otherwise just return the profile.
              const profile = memoryStore.getProfile(identityId);
              return json({ profile });
            }

            default:
              return json({
                error: `Unknown action: ${action}. Use: record, recall, profile`,
              });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // =========================================================================
    // Command: /identity — quick identity lookup from chat.
    // =========================================================================
    api.registerCommand({
      name: "identity",
      description: "Show your cross-platform identity and linked accounts",
      acceptsArgs: false,
      requireAuth: false,
      handler(ctx: PluginCommandContext) {
        const identityId = resolvedIdentities.get(`${ctx.channelId}:${ctx.senderId}`);
        if (!identityId) {
          return { text: "No identity found. Send a message first to create one." };
        }
        const identity = identityStore.getIdentity(identityId);
        if (!identity) {
          return { text: "Identity record not found." };
        }
        const platforms = Object.entries(identity.links)
          .map(([p, uid]) => `  ${p}: ${uid}`)
          .join("\n");
        const profile = memoryStore.getProfile(identityId);
        return {
          text:
            `**${identity.name}** (${identity.id})\n` +
            `Linked platforms:\n${platforms}\n` +
            `Interactions: ${profile.interactionCount}\n` +
            `First seen: ${profile.firstSeen}\n` +
            `Last seen: ${profile.lastSeen}`,
        };
      },
    });
  },
};

/** Resolve identity ID from hook context (channel + sender). */
function resolveIdentityFromCtx(
  channelId: string | undefined,
  event: { from?: string; prompt?: string },
): string | undefined {
  if (!channelId) {
    return undefined;
  }
  // Try "from" field from message_received.
  if (event.from) {
    return resolvedIdentities.get(`${channelId}:${event.from}`);
  }
  // Fall back to any recently resolved identity for this channel.
  for (const [key, id] of resolvedIdentities) {
    if (key.startsWith(`${channelId}:`)) {
      return id;
    }
  }
  return undefined;
}

/** Resolve identity from agent context. */
function resolveIdentityFromAgentCtx(ctx: {
  channelId?: string;
  sessionKey?: string;
}): string | undefined {
  if (ctx.channelId) {
    for (const [key, id] of resolvedIdentities) {
      if (key.startsWith(`${ctx.channelId}:`)) {
        return id;
      }
    }
  }
  return undefined;
}

export default identityMemoryPlugin;
