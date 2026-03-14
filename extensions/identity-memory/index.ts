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

/** LRU cap for the resolved identities cache. */
const MAX_RESOLVED_IDENTITIES = 10_000;

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

    // Scoped to this plugin instance — not module-level — so re-registration
    // starts fresh and the map is eligible for GC when the plugin is unloaded.
    // Key: "channelId:senderId" → identityId  (for /identity command)
    const resolvedIdentities = new Map<string, string>();
    // Key: channelId → identityId  (most recent sender; bridge from
    // message_received to agent hooks that lack a senderId field)
    const pendingChannelIdentity = new Map<string, string>();
    // Key: sessionKey → identityId  (set in before_prompt_build, read in agent_end)
    const sessionIdentities = new Map<string, string>();

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
        const key = `${ctx.channelId}:${senderId}`;
        // Store as "pending" so the next before_prompt_build on this channel
        // can pick up the sender identity (the SDK's agent context lacks senderId).
        pendingChannelIdentity.set(ctx.channelId, identityId);
        // LRU eviction: delete-then-set keeps the newest entries at the end.
        resolvedIdentities.delete(key);
        resolvedIdentities.set(key, identityId);
        if (resolvedIdentities.size > MAX_RESOLVED_IDENTITIES) {
          // Evict the oldest entry (first key in insertion order).
          const oldest = resolvedIdentities.keys().next().value;
          if (oldest !== undefined) {
            resolvedIdentities.delete(oldest);
          }
        }
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
          // Resolve identity from the pending map (set by message_received).
          // This is the bridge: message_received knows the sender, agent hooks don't.
          const identityId = ctx.channelId
            ? pendingChannelIdentity.get(ctx.channelId)
            : undefined;
          if (!identityId) {
            return;
          }
          // Consume the pending entry and promote to session-scoped so
          // agent_end can retrieve it by sessionKey.
          if (ctx.channelId) {
            pendingChannelIdentity.delete(ctx.channelId);
          }
          if (ctx.sessionKey) {
            sessionIdentities.set(ctx.sessionKey, identityId);
            if (sessionIdentities.size > MAX_RESOLVED_IDENTITIES) {
              const oldest = sessionIdentities.keys().next().value;
              if (oldest !== undefined) {
                sessionIdentities.delete(oldest);
              }
            }
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
      // Look up identity stored during before_prompt_build for this session.
      // The SDK's PluginHookAgentContext does not carry senderId, so we rely
      // on the sessionKey bridge set up during the prompt-build phase.
      const identityId = ctx.sessionKey
        ? sessionIdentities.get(ctx.sessionKey)
        : undefined;
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

export default identityMemoryPlugin;
