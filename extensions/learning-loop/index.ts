// ============================================================================
// OpenClaw Learning Loop Plugin
//
// Self-improving AI agent with three subsystems:
//   1. Knowledge Graph Memory — Graphiti-backed via MCP server bridge
//   2. Skill Evolution — auto-refine skills from errors and corrections
//   3. Learning Nudge Loop — periodic background reviews for knowledge capture
//
// Architecture:
//   OpenClaw hooks → learning-loop plugin → Graphiti MCP Server → Neo4j/FalkorDB
// ============================================================================

import { Type } from "@sinclair/typebox";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { learningLoopConfigSchema, type LearningLoopConfig } from "./src/config.js";
import { EvolutionService } from "./src/evolution-service.js";
import { GraphitiClient } from "./src/graphiti-client.js";
import { looksLikeInjection } from "./src/injection-guard.js";
import { extractMessageText } from "./src/message-content.js";
import { NudgeManager } from "./src/nudge-manager.js";
import {
  createLearningLoopLlmCaller,
  isLearningLoopInternalSessionId,
  resolveLearningLoopSkillsBaseDir,
} from "./src/runtime-llm.js";

// ============================================================================
// Plugin Definition
// ============================================================================

export default definePluginEntry({
  id: "learning-loop",
  name: "Learning Loop",
  description:
    "Self-improving agent with Graphiti knowledge graph memory, autonomous skill evolution, and built-in learning loop",
  configSchema: learningLoopConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = learningLoopConfigSchema.parse(api.pluginConfig) as LearningLoopConfig;

    // ========================================================================
    // Initialize subsystems
    // ========================================================================

    const graphiti = new GraphitiClient(cfg.graphiti.mcpServerUrl, cfg.graphiti.groupId);
    type LearningLoopScope = {
      agentDir?: string;
      agentId?: string;
      sessionId?: string;
      workspaceDir?: string;
    };

    type ScopedServices = {
      evolutionService: EvolutionService;
      nudgeManager: NudgeManager;
    };

    const sessionServices = new Map<string, ScopedServices>();
    const activeRunKeys = new Set<string>();
    let defaultServices: ScopedServices | null = null;

    const createScopedServices = (scope?: LearningLoopScope): ScopedServices => {
      const llmCallFn = createLearningLoopLlmCaller(api, scope);
      const skillsBaseDir = resolveLearningLoopSkillsBaseDir(api, scope);
      const evolutionService = new EvolutionService({
        graphiti,
        callLlm: llmCallFn,
        skillsBaseDir,
        config: cfg.evolution,
        logger: api.logger,
      });
      const nudgeManager = new NudgeManager(
        graphiti,
        evolutionService,
        llmCallFn,
        cfg.nudge,
        api.logger,
      );

      return { evolutionService, nudgeManager };
    };

    const getScopedServices = (scope?: LearningLoopScope): ScopedServices => {
      const sessionId = scope?.sessionId?.trim();
      if (sessionId) {
        const existing = sessionServices.get(sessionId);
        if (existing) {
          return existing;
        }
        const scoped = createScopedServices(scope);
        sessionServices.set(sessionId, scoped);
        return scoped;
      }

      defaultServices ??= createScopedServices(scope);
      return defaultServices;
    };

    api.logger.info(
      `learning-loop: plugin registered (graphiti: ${cfg.graphiti.mcpServerUrl}, ` +
        `evolution: ${cfg.evolution.enabled}, nudge: ${cfg.nudge.enabled})`,
    );

    // ========================================================================
    // Tools — Knowledge Graph Memory
    // ========================================================================

    api.registerTool(
      {
        name: "knowledge_search",
        label: "Knowledge Search",
        description:
          "Search the knowledge graph for facts, entities, and relationships. " +
          "Use when you need context about the user, project, past decisions, or learned patterns.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          maxResults: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        }),
        async execute(_toolCallId, params) {
          const { query, maxResults = 5 } = params as {
            query: string;
            maxResults?: number;
          };

          const results = await graphiti.search(query, maxResults);

          if (results.facts.length === 0 && results.nodes.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant knowledge found." }],
              details: { factCount: 0, nodeCount: 0 },
            };
          }

          const lines: string[] = [];
          if (results.facts.length > 0) {
            lines.push("**Facts:**");
            for (const f of results.facts) {
              lines.push(`- ${f.fact}`);
            }
          }
          if (results.nodes.length > 0) {
            lines.push("**Entities:**");
            for (const n of results.nodes) {
              const label = n.labels?.length ? ` [${n.labels.join(", ")}]` : "";
              lines.push(`- **${n.name}**${label}: ${n.summary}`);
            }
          }

          return {
            content: [
              {
                type: "text",
                text: `Found ${results.facts.length} fact(s) and ${results.nodes.length} entity(ies):\n\n${lines.join("\n")}`,
              },
            ],
            details: {
              factCount: results.facts.length,
              nodeCount: results.nodes.length,
            },
          };
        },
      },
      { name: "knowledge_search" },
    );

    api.registerTool(
      {
        name: "knowledge_store",
        label: "Knowledge Store",
        description:
          "Store an observation, fact, or preference in the knowledge graph. " +
          "Graphiti automatically extracts entities and relationships.",
        parameters: Type.Object({
          observation: Type.String({
            description: "The fact, preference, or observation to store",
          }),
          category: Type.Optional(
            Type.Unsafe<string>({
              type: "string",
              enum: [
                "user_profile",
                "preference",
                "project_fact",
                "technical",
                "workflow",
                "decision",
                "other",
              ],
            }),
          ),
          context: Type.Optional(
            Type.String({ description: "Additional context for the observation" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            observation,
            category = "other",
            context,
          } = params as {
            observation: string;
            category?: string;
            context?: string;
          };

          if (looksLikeInjection(observation) || (context && looksLikeInjection(context))) {
            return {
              content: [{ type: "text", text: "Blocked: content looks like prompt injection." }],
              details: { action: "blocked" },
            };
          }

          const result = await graphiti.addObservation(category, observation, context);

          return {
            content: [
              {
                type: "text",
                text: `Stored: "${observation.slice(0, 100)}${observation.length > 100 ? "..." : ""}"`,
              },
            ],
            details: { action: "created", result },
          };
        },
      },
      { name: "knowledge_store" },
    );

    api.registerTool(
      {
        name: "knowledge_forget",
        label: "Knowledge Forget",
        description: "Delete a specific fact from the knowledge graph by its UUID.",
        parameters: Type.Object({
          factUuid: Type.String({ description: "UUID of the fact to delete" }),
        }),
        async execute(_toolCallId, params) {
          const { factUuid } = params as { factUuid: string };

          await graphiti.deleteFact(factUuid);

          return {
            content: [{ type: "text", text: `Fact ${factUuid} forgotten.` }],
            details: { action: "deleted", uuid: factUuid },
          };
        },
      },
      { name: "knowledge_forget" },
    );

    // ========================================================================
    // Tools — Skill Evolution
    // ========================================================================

    if (cfg.evolution.enabled) {
      api.registerTool(
        (toolCtx) => ({
          name: "skill_evolve",
          label: "Skill Evolve",
          description:
            "Manually trigger skill evolution for a specific skill based on current conversation. " +
            "Analyzes errors and corrections to generate improvements.",
          parameters: Type.Object({
            skillName: Type.String({ description: "Name of the skill to evolve" }),
          }),
          async execute(_toolCallId, params) {
            const { skillName } = params as { skillName: string };
            const { evolutionService } = getScopedServices(toolCtx);

            // We pass an empty messages array here; the hook-based flow
            // provides the real messages. For manual tool calls, the agent
            // should provide context in the conversation.
            const result = await evolutionService.evolveSkill(skillName, []);

            if (!result || result.entries.length === 0) {
              return {
                content: [{ type: "text", text: `No evolution needed for "${skillName}".` }],
                details: { entries: 0 },
              };
            }

            const summary = result.entries
              .map((e) => `- [${e.change.section}] ${e.change.content.slice(0, 80)}...`)
              .join("\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Generated ${result.entries.length} evolution(s) for "${skillName}":\n${summary}\n\n${result.applied ? "Auto-applied." : "Pending approval."}`,
                },
              ],
              details: {
                entries: result.entries.length,
                applied: result.applied,
              },
            };
          },
        }),
        { name: "skill_evolve" },
      );

      api.registerTool(
        (toolCtx) => ({
          name: "skill_solidify",
          label: "Skill Solidify",
          description:
            "Write pending evolution entries into a skill's SKILL.md file, making them permanent.",
          parameters: Type.Object({
            skillName: Type.String({ description: "Name of the skill to solidify" }),
          }),
          async execute(_toolCallId, params) {
            const { skillName } = params as { skillName: string };
            const { evolutionService } = getScopedServices(toolCtx);
            const count = evolutionService.solidifySkill(skillName);

            return {
              content: [
                {
                  type: "text",
                  text:
                    count > 0
                      ? `Solidified ${count} entry(ies) into ${skillName}/SKILL.md.`
                      : `No pending entries for "${skillName}".`,
                },
              ],
              details: { solidified: count },
            };
          },
        }),
        { name: "skill_solidify" },
      );
    }

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant knowledge before agent starts
    if (cfg.memory.autoRecall) {
      api.on("before_prompt_build", async (event, ctx) => {
        if (isLearningLoopInternalSessionId(ctx.sessionId)) return;
        if (!event.prompt || event.prompt.length < 5) return;

        try {
          const results = await graphiti.search(event.prompt, 5);
          const formatted = graphiti.formatForPrompt(results);

          if (!formatted) return;

          api.logger.info?.(
            `learning-loop: injecting ${results.facts.length} facts + ${results.nodes.length} nodes into context`,
          );

          return { prependSystemContext: formatted };
        } catch (err) {
          api.logger.warn(`learning-loop: auto-recall failed: ${String(err)}`);
        }
      });
    }

    // Skill evolution: detect and evolve after agent ends
    if (cfg.evolution.enabled) {
      // Inject skill experiences into prompts
      api.on("before_prompt_build", async (_event, ctx) => {
        if (isLearningLoopInternalSessionId(ctx.sessionId)) return;
        try {
          const { evolutionService } = getScopedServices(ctx);
          const evolvedSkills = evolutionService.listEvolvedSkills();
          const experiences = evolvedSkills
            .map((s) => evolutionService.getDescriptionExperiences(s))
            .filter(Boolean);

          if (experiences.length === 0) return;

          return { appendSystemContext: experiences.join("\n\n") };
        } catch {
          // Non-fatal
        }
      });
    }

    // Session lifecycle: clear caches on new sessions
    api.on("before_agent_start", (_event, ctx) => {
      const runKey = ctx.runId?.trim() || ctx.sessionId?.trim();
      if (runKey) {
        activeRunKeys.add(runKey);
      }
    });

    api.on("session_start", (event, ctx) => {
      if (isLearningLoopInternalSessionId(event.sessionId)) return;
      const { evolutionService, nudgeManager } = getScopedServices(ctx);
      evolutionService.clearSignals();
      nudgeManager.resetAll();
    });

    api.on("session_end", (event) => {
      sessionServices.delete(event.sessionId);
    });

    // Reset nudge counters when user manually uses knowledge tools
    api.on("after_tool_call", (event, ctx) => {
      const { nudgeManager } = getScopedServices(ctx);
      const name = event.toolName;
      if (name === "knowledge_store" || name === "knowledge_search") {
        nudgeManager.resetCounter("memory");
      }
      if (name === "skill_evolve" || name === "skill_solidify") {
        nudgeManager.resetCounter("skill");
      }
    });

    if (cfg.memory.autoCapture || cfg.evolution.enabled || cfg.nudge.enabled) {
      api.on("agent_end", async (event, ctx) => {
        if (isLearningLoopInternalSessionId(ctx.sessionId)) return;
        const { evolutionService, nudgeManager } = getScopedServices(ctx);

        try {
          if (cfg.memory.autoCapture && event.success && event.messages?.length) {
            try {
              // Extract user messages for knowledge capture.
              const userTexts: string[] = [];
              for (const raw of event.messages) {
                if (!raw || typeof raw !== "object") continue;
                const msg = raw as Record<string, unknown>;
                if (msg.role !== "user") continue;

                const content = extractMessageText(msg.content);
                if (content.length > 10) {
                  userTexts.push(content);
                }
              }

              if (userTexts.length > 0) {
                const sessionId = ctx.sessionId;
                const conversationContent = userTexts.slice(-3).join("\n---\n");

                if (!looksLikeInjection(conversationContent)) {
                  await graphiti.addEpisode({
                    name: `session-${sessionId ?? "unknown"}-${Date.now()}`,
                    content: conversationContent,
                    source: "message",
                    sourceDescription: "OpenClaw conversation auto-capture",
                    groupId: cfg.graphiti.groupId,
                  });
                  api.logger.info?.("learning-loop: auto-captured conversation episode");
                }
              }
            } catch (err) {
              api.logger.warn(`learning-loop: auto-capture failed: ${String(err)}`);
            }
          }

          if (cfg.evolution.enabled && event.messages?.length) {
            try {
              const results = await evolutionService.runAutoEvolution(event.messages);
              if (results.length > 0) {
                const total = results.reduce((sum, r) => sum + r.entries.length, 0);
                api.logger.info(
                  `learning-loop: auto-evolution generated ${total} entry(ies) across ${results.length} skill(s)`,
                );
              }
            } catch (err) {
              api.logger.warn(`learning-loop: auto-evolution failed: ${String(err)}`);
            }
          }

          if (cfg.nudge.enabled && event.messages) {
            nudgeManager.checkNudge(event.messages);
          }
        } finally {
          const runKey = ctx.runId?.trim() || ctx.sessionId?.trim();
          if (runKey) {
            activeRunKeys.delete(runKey);
          }

          // One-shot local agent runs still need cleanup, but concurrent agent
          // turns must not lose the shared transport underneath in-flight work.
          if (activeRunKeys.size === 0) {
            await graphiti.closeConnection();
          }
        }
      });
    }

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const runCliCommand = async (action: () => Promise<void>) => {
          try {
            await action();
          } finally {
            // One-shot CLI commands should not leave the MCP transport's SSE
            // session open, or the process will stay alive after printing.
            await graphiti.dispose();
          }
        };

        const ll = program.command("learning-loop").description("Learning loop plugin commands");

        ll.command("status")
          .description("Show learning loop status")
          .action(async () => {
            await runCliCommand(async () => {
              const { evolutionService } = getScopedServices();
              const evolvedSkills = evolutionService.listEvolvedSkills();
              console.log("Learning Loop Status");
              console.log("====================");
              console.log(`Graphiti MCP: ${cfg.graphiti.mcpServerUrl}`);
              console.log(`Group ID: ${cfg.graphiti.groupId}`);
              console.log(`Evolution: ${cfg.evolution.enabled ? "enabled" : "disabled"}`);
              console.log(`Nudge: ${cfg.nudge.enabled ? "enabled" : "disabled"}`);
              console.log(`Auto-recall: ${cfg.memory.autoRecall ? "on" : "off"}`);
              console.log(`Auto-capture: ${cfg.memory.autoCapture ? "on" : "off"}`);
              console.log(`\nEvolved skills (${evolvedSkills.length}):`);
              for (const skill of evolvedSkills) {
                const pending = evolutionService.getPendingEntries(skill);
                console.log(`  ${skill} (${pending.length} pending)`);
              }
            });
          });

        ll.command("search")
          .description("Search the knowledge graph")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query: string, opts: { limit: string }) => {
            await runCliCommand(async () => {
              const results = await graphiti.search(query, parseInt(opts.limit));
              console.log(JSON.stringify(results, null, 2));
            });
          });

        ll.command("evolve")
          .description("Manually trigger skill evolution")
          .argument("<skill>", "Skill name")
          .action(async (skill: string) => {
            await runCliCommand(async () => {
              const { evolutionService } = getScopedServices();
              const result = await evolutionService.evolveSkill(skill, []);
              if (!result) {
                console.log("No evolution needed.");
                return;
              }
              console.log(`Generated ${result.entries.length} evolution(s):`);
              for (const entry of result.entries) {
                console.log(`  [${entry.change.section}] ${entry.change.content.slice(0, 80)}...`);
              }
            });
          });

        ll.command("solidify")
          .description("Write pending evolutions into SKILL.md")
          .argument("<skill>", "Skill name")
          .action(async (skill: string) => {
            await runCliCommand(async () => {
              const { evolutionService } = getScopedServices();
              const count = evolutionService.solidifySkill(skill);
              console.log(
                count > 0
                  ? `Solidified ${count} entry(ies) into ${skill}/SKILL.md.`
                  : "No pending entries.",
              );
            });
          });

        ll.command("pending")
          .description("Show pending evolution entries for a skill")
          .argument("<skill>", "Skill name")
          .action(async (skill: string) => {
            await runCliCommand(async () => {
              const { evolutionService } = getScopedServices();
              const entries = evolutionService.getPendingEntries(skill);
              if (entries.length === 0) {
                console.log("No pending entries.");
                return;
              }
              console.log(`Pending entries for ${skill}:`);
              for (const entry of entries) {
                console.log(
                  `  [${entry.id}] ${entry.change.section}: ${entry.change.content.slice(0, 60)}...`,
                );
                console.log(`    Source: ${entry.source} | Target: ${entry.change.target}`);
              }
            });
          });
      },
      { commands: ["learning-loop"] },
    );

    // ========================================================================
    // Service lifecycle
    // ========================================================================

    api.registerService({
      id: "learning-loop",
      start: () => {
        api.logger.info(`learning-loop: service started (graphiti: ${cfg.graphiti.mcpServerUrl})`);
      },
      stop: async () => {
        sessionServices.clear();
        defaultServices = null;
        await graphiti.dispose();
        api.logger.info("learning-loop: service stopped");
      },
    });
  },
});
