/// IC Memory Vault -- OpenClaw extension for persistent, sovereign AI memory on the Internet Computer.
/// Registers tools, hooks, CLI commands, and services for syncing with IC canisters.

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig, icStorageConfigSchema, type IcStorageConfig } from "./config.js";
import { IcClient } from "./ic-client.js";
import {
  loadPromptState,
  savePromptState,
  canPrompt,
  shouldNudgeForMilestone,
  getFirstRunMessage,
  getMilestoneNudgeMessage,
  getReminderMessage,
  getSetupCompleteMessage,
} from "./prompts.js";
import { performSync, restoreFromVault, decodeContent, type LocalMemory } from "./sync.js";

const icStoragePlugin = {
  id: "ic-persistent-storage",
  name: "IC Memory Vault",
  description:
    "Persistent, sovereign AI memory storage on the Internet Computer. " +
    "Syncs your local memories to a personal IC canister for cross-device persistence.",
  kind: "memory" as const,
  configSchema: icStorageConfigSchema,

  register(api: OpenClawPluginApi) {
    let cfg: IcStorageConfig;
    try {
      cfg = parseConfig(api.pluginConfig);
    } catch (err) {
      api.logger.error(
        `IC Memory Vault: invalid config: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    let client: IcClient | null = null;

    // Lazy-init the IC client
    function getClient(): IcClient {
      if (!client) {
        client = new IcClient(cfg);
      }
      return client;
    }

    // -- Tools --

    // vault_sync: push local memories to IC vault
    api.registerTool(
      {
        name: "vault_sync",
        label: "IC Vault Sync",
        description:
          "Sync local memories and sessions to the IC Memory Vault. " +
          "Uses differential sync to only upload what has changed.",
        parameters: Type.Object({
          memories: Type.Optional(
            Type.Array(
              Type.Object({
                key: Type.String({ description: "Memory key" }),
                category: Type.String({ description: "Memory category" }),
                content: Type.String({ description: "Memory content" }),
                metadata: Type.Optional(Type.String({ description: "JSON metadata" })),
              }),
            ),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const localMemories: LocalMemory[] = (params.memories ?? []).map(
              (m: { key: string; category: string; content: string; metadata?: string }) => ({
                key: m.key,
                category: m.category,
                content: m.content,
                metadata: m.metadata ?? "{}",
                createdAt: Date.now() * 1_000_000, // nanoseconds
                updatedAt: Date.now() * 1_000_000,
              }),
            );

            const result = await performSync(getClient(), localMemories, []);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Sync complete: ${result.totalStored} stored, ${result.totalSkipped} skipped.${
                    result.errors.length > 0 ? ` Errors: ${result.errors.join(", ")}` : ""
                  }`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      },
      { name: "vault_sync" },
    );

    // vault_recall: pull specific memory from IC vault
    api.registerTool(
      {
        name: "vault_recall",
        label: "IC Vault Recall",
        description:
          "Recall a specific memory from the IC Memory Vault by key, " +
          "or search by category and prefix.",
        parameters: Type.Object({
          key: Type.Optional(Type.String({ description: "Exact memory key to recall" })),
          category: Type.Optional(Type.String({ description: "Filter by category" })),
          prefix: Type.Optional(Type.String({ description: "Filter by key prefix" })),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default 10)", minimum: 1, maximum: 100 }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const ic = getClient();

            // Exact key recall
            if (params.key) {
              const entry = await ic.recall(params.key);
              if (!entry) {
                return {
                  content: [
                    { type: "text" as const, text: `No memory found for key "${params.key}"` },
                  ],
                };
              }
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `[${entry.category}] ${entry.key}: ${decodeContent(entry.content)}`,
                  },
                ],
                details: {
                  key: entry.key,
                  category: entry.category,
                  metadata: entry.metadata,
                },
              };
            }

            // Search by category/prefix
            const entries = await ic.recallRelevant(
              params.category ?? null,
              params.prefix ?? null,
              params.limit ?? 10,
            );

            if (entries.length === 0) {
              return {
                content: [
                  { type: "text" as const, text: "No matching memories found in IC vault." },
                ],
              };
            }

            const text = entries
              .map((e) => `[${e.category}] ${e.key}: ${decodeContent(e.content)}`)
              .join("\n");

            return {
              content: [{ type: "text" as const, text }],
              details: { count: entries.length },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Recall failed: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      },
      { name: "vault_recall" },
    );

    // vault_restore: full restore from IC vault to local
    api.registerTool(
      {
        name: "vault_restore",
        label: "IC Vault Restore",
        description:
          "Restore all memories and sessions from the IC Memory Vault. " +
          "Use this to recover data on a new device or after local data loss.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await restoreFromVault(getClient());
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Restored ${result.memories.length} memories and ${result.sessions.length} sessions from IC vault.`,
                },
              ],
              details: {
                memoriesCount: result.memories.length,
                sessionsCount: result.sessions.length,
                categories: [...new Set(result.memories.map((m) => m.category))],
              },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Restore failed: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      },
      { name: "vault_restore" },
    );

    // vault_status: show vault stats, cycles, sync status
    api.registerTool(
      {
        name: "vault_status",
        label: "IC Vault Status",
        description: "Show IC Memory Vault status: memories, sessions, cycle balance, categories.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const dashboard = await getClient().getDashboard();
            const s = dashboard.stats;
            const text = [
              `IC Memory Vault Status`,
              `  Memories:  ${s.totalMemories}`,
              `  Sessions:  ${s.totalSessions}`,
              `  Categories: ${s.categories.join(", ") || "(none)"}`,
              `  Storage:   ${formatBytes(Number(s.bytesUsed))}`,
              `  Cycles:    ${formatCycles(Number(s.cycleBalance))}`,
              `  Last sync: ${s.lastUpdated === 0n ? "never" : new Date(Number(s.lastUpdated) / 1_000_000).toISOString()}`,
            ].join("\n");

            return {
              content: [{ type: "text" as const, text }],
              details: {
                totalMemories: Number(s.totalMemories),
                totalSessions: Number(s.totalSessions),
                bytesUsed: Number(s.bytesUsed),
                cycleBalance: Number(s.cycleBalance),
              },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Status check failed: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      },
      { name: "vault_status" },
    );

    // vault_audit: show immutable audit log
    api.registerTool(
      {
        name: "vault_audit",
        label: "IC Vault Audit",
        description:
          "Show the immutable audit log from the IC Memory Vault. " +
          "Every operation is recorded with consensus-verified timestamps.",
        parameters: Type.Object({
          offset: Type.Optional(
            Type.Number({ description: "Start offset (default 0)", minimum: 0 }),
          ),
          limit: Type.Optional(
            Type.Number({ description: "Max entries (default 20)", minimum: 1, maximum: 100 }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const ic = getClient();
            const [entries, totalSize] = await Promise.all([
              ic.getAuditLog(params.offset ?? 0, params.limit ?? 20),
              ic.getAuditLogSize(),
            ]);

            if (entries.length === 0) {
              return {
                content: [{ type: "text" as const, text: "Audit log is empty." }],
              };
            }

            const lines = entries.map((e) => {
              const action = Object.keys(e.action)[0];
              const key = e.key.length > 0 ? e.key[0] : "-";
              const cat = e.category.length > 0 ? e.category[0] : "-";
              const details = e.details.length > 0 ? e.details[0] : "";
              const ts = new Date(Number(e.timestamp) / 1_000_000).toISOString();
              return `${ts} [${action}] key=${key} cat=${cat} ${details}`.trim();
            });

            const text = [`Audit Log (${entries.length} of ${totalSize} total):`, ...lines].join(
              "\n",
            );

            return {
              content: [{ type: "text" as const, text }],
              details: { totalEntries: Number(totalSize), shown: entries.length },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Audit log failed: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      },
      { name: "vault_audit" },
    );

    // -- Hooks --

    // Load prompt state for smart adoption messaging
    let promptState = loadPromptState();

    // Mark as configured if canisterId is present
    if (cfg.canisterId) {
      if (!promptState.vaultConfigured) {
        promptState.vaultConfigured = true;
        savePromptState(promptState);
      }
    }

    // Gateway start: first-run prompt or periodic reminder
    api.on("gateway_start", async () => {
      if (cfg.canisterId) {
        // Vault is configured -- show confirmation on first run after setup
        if (promptState.vaultConfigured && promptState.promptCount === 0) {
          for (const line of getSetupCompleteMessage(cfg.canisterId)) {
            api.logger.info(line);
          }
        }
        return;
      }

      // No vault configured -- show adoption prompt if appropriate
      promptState = loadPromptState(); // reload in case another process updated
      if (!canPrompt(promptState)) return;

      const messages =
        promptState.promptCount === 0
          ? getFirstRunMessage()
          : getReminderMessage(promptState.trackedMemoryCount);

      for (const line of messages) {
        api.logger.info(line);
      }

      promptState.promptCount += 1;
      promptState.lastPromptAt = Date.now();
      savePromptState(promptState);
    });

    // Auto-sync on session end (placeholder -- actual MemorySearchManager wiring is Phase 2)
    if (cfg.syncOnSessionEnd) {
      api.on("session_end", async (_event) => {
        if (!cfg.canisterId) return;
        // Phase 2: wire to MemorySearchManager to pull session memories and sync.
        // No-op for now -- sync must be triggered manually via vault_sync tool or CLI.
        api.logger.debug(
          "IC Memory Vault: session_end hook registered (sync wiring pending Phase 2)",
        );
      });
    }

    // Agent end: sync memories + track memory count for milestone nudges
    api.on("agent_end", async (_event) => {
      // Track memory growth for milestone nudges (even if vault isn't configured)
      promptState = loadPromptState();
      promptState.trackedMemoryCount += 1; // approximate: 1 conversation ~ 1 memory

      // Check if we should show a milestone nudge
      if (!cfg.canisterId && shouldNudgeForMilestone(promptState, promptState.trackedMemoryCount)) {
        const messages = getMilestoneNudgeMessage(promptState.trackedMemoryCount);
        for (const line of messages) {
          api.logger.info(line);
        }
        promptState.promptCount += 1;
        promptState.lastPromptAt = Date.now();
      }

      savePromptState(promptState);

      // Phase 2: wire to MemorySearchManager to pull conversation memories and sync.
      // No-op for now -- sync must be triggered manually via vault_sync tool or CLI.
      if (cfg.canisterId && cfg.syncOnAgentEnd) {
        api.logger.debug(
          "IC Memory Vault: agent_end hook registered (sync wiring pending Phase 2)",
        );
      }
    });

    // -- CLI Commands --

    api.registerCli(
      ({ program }) => {
        const vault = program
          .command("ic-memory")
          .description(
            "IC Memory Vault -- persistent, sovereign AI memory on the Internet Computer",
          );

        vault
          .command("setup")
          .description("Authenticate with Internet Identity and create your IC vault")
          .action(async () => {
            try {
              const ic = getClient();
              console.log("Authenticating with Internet Identity 2.0...");
              console.log("A browser window will open for authentication.");

              const principal = await ic.authenticate();
              console.log(`Authenticated as: ${principal.toText()}`);

              // Check if vault exists
              const existingVault = await ic.getVault();
              if (existingVault) {
                console.log(`Vault already exists: ${existingVault.toText()}`);
                console.log(`Set canisterId in your config to: ${existingVault.toText()}`);
                return;
              }

              // Create vault
              console.log("Creating your personal IC Memory Vault...");
              const result = await ic.createVault();
              if ("ok" in result) {
                console.log(`Vault created: ${result.ok.toText()}`);
                console.log(`Set canisterId in your config to: ${result.ok.toText()}`);
              } else {
                console.error(`Failed: ${result.err}`);
              }
            } catch (err) {
              console.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          });

        vault
          .command("status")
          .description("Show IC vault status and statistics")
          .action(async () => {
            try {
              const dashboard = await getClient().getDashboard();
              const s = dashboard.stats;
              console.log("IC Memory Vault Status");
              console.log(`  Memories:   ${s.totalMemories}`);
              console.log(`  Sessions:   ${s.totalSessions}`);
              console.log(`  Categories: ${s.categories.join(", ") || "(none)"}`);
              console.log(`  Storage:    ${formatBytes(Number(s.bytesUsed))}`);
              console.log(`  Cycles:     ${formatCycles(Number(s.cycleBalance))}`);
              console.log(
                `  Last sync:  ${s.lastUpdated === 0n ? "never" : new Date(Number(s.lastUpdated) / 1_000_000).toISOString()}`,
              );

              if (dashboard.recentMemories.length > 0) {
                console.log("\nRecent Memories:");
                for (const m of dashboard.recentMemories.slice(0, 5)) {
                  console.log(
                    `  [${m.category}] ${m.key}: ${decodeContent(m.content).slice(0, 80)}...`,
                  );
                }
              }
            } catch (err) {
              console.error(`Status failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          });

        vault
          .command("sync")
          .description("Manually sync local memories to IC vault")
          .action(async () => {
            try {
              console.log("Starting sync...");
              // Placeholder: in production, pull local memories from OpenClaw's memory system
              const result = await performSync(getClient(), [], [], (msg) =>
                console.log(`  ${msg}`),
              );
              console.log(`Done: ${result.totalStored} stored, ${result.totalSkipped} skipped`);
            } catch (err) {
              console.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          });

        vault
          .command("restore")
          .description("Restore all data from IC vault to local storage")
          .action(async () => {
            try {
              console.log("Restoring from IC vault...");
              const result = await restoreFromVault(getClient(), (msg) => console.log(`  ${msg}`));
              console.log(
                `Restored ${result.memories.length} memories, ${result.sessions.length} sessions`,
              );
            } catch (err) {
              console.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          });

        vault
          .command("audit")
          .description("Show immutable audit log")
          .option("--offset <n>", "Start offset", "0")
          .option("--limit <n>", "Max entries", "20")
          .action(async (opts) => {
            try {
              const ic = getClient();
              const entries = await ic.getAuditLog(
                parseInt(opts.offset, 10),
                parseInt(opts.limit, 10),
              );
              const total = await ic.getAuditLogSize();

              console.log(`Audit Log (${entries.length} of ${total} total):`);
              for (const e of entries) {
                const action = Object.keys(e.action)[0];
                const key = e.key.length > 0 ? e.key[0] : "-";
                const ts = new Date(Number(e.timestamp) / 1_000_000).toISOString();
                const details = e.details.length > 0 ? ` ${e.details[0]}` : "";
                console.log(`  ${ts} [${action}] key=${key}${details}`);
              }
            } catch (err) {
              console.error(`Audit failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          });
      },
      { commands: ["ic-memory"] },
    );

    // -- Service --

    api.registerService({
      id: "ic-persistent-storage",
      start: () => {
        if (cfg.canisterId) {
          api.logger.info(
            `IC Memory Vault: active (vault: ${cfg.canisterId}, network: ${cfg.network}, auto-sync: ${cfg.autoSync})`,
          );
        }
        // If not configured, the gateway_start hook handles messaging
      },
      stop: () => {
        api.logger.info("IC Memory Vault: service stopped");
      },
    });
  },
};

// -- Utility functions --

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatCycles(cycles: number): string {
  if (cycles >= 1_000_000_000_000) {
    return `${(cycles / 1_000_000_000_000).toFixed(2)} T`;
  }
  if (cycles >= 1_000_000_000) {
    return `${(cycles / 1_000_000_000).toFixed(2)} B`;
  }
  return `${cycles.toLocaleString()}`;
}

export default icStoragePlugin;
