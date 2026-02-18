/**
 * MABOS — Multi-Agent Business Operating System
 * Bundled Extension Entry Point (Deep Integration)
 *
 * Registers:
 *  - 99 tools across 21 modules
 *  - BDI background heartbeat service
 *  - CLI subcommands (onboard, agents, bdi, business, dashboard)
 *  - Unified memory bridge to native memory system
 *  - Agent lifecycle hooks (Persona injection, BDI audit trail)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createBdiTools } from "./src/tools/bdi-tools.js";
import { createBusinessTools } from "./src/tools/business-tools.js";
import { createCbrTools } from "./src/tools/cbr-tools.js";
import { resolveWorkspaceDir } from "./src/tools/common.js";
import { createCommunicationTools } from "./src/tools/communication-tools.js";
import { createDesireTools } from "./src/tools/desire-tools.js";
import { createFactStoreTools } from "./src/tools/fact-store.js";
import { createInferenceTools } from "./src/tools/inference-tools.js";
import { createIntegrationTools } from "./src/tools/integration-tools.js";
import { createKnowledgeTools } from "./src/tools/knowledge-tools.js";
import { createMarketingTools } from "./src/tools/marketing-tools.js";
import { createMemoryTools } from "./src/tools/memory-tools.js";
import { createMetricsTools } from "./src/tools/metrics-tools.js";
import { createOnboardingTools } from "./src/tools/onboarding-tools.js";
import { createOntologyManagementTools } from "./src/tools/ontology-management-tools.js";
import { createPlanningTools } from "./src/tools/planning-tools.js";
import { createReasoningTools } from "./src/tools/reasoning-tools.js";
import { createReportingTools } from "./src/tools/reporting-tools.js";
import { createRuleEngineTools } from "./src/tools/rule-engine.js";
import { createSetupWizardTools } from "./src/tools/setup-wizard-tools.js";
import { createStakeholderTools } from "./src/tools/stakeholder-tools.js";
import { createTypeDBTools } from "./src/tools/typedb-tools.js";
import { createWorkforceTools } from "./src/tools/workforce-tools.js";

// Use a variable for the bdi-runtime path so TypeScript doesn't try to
// statically resolve it (it lives outside this extension's rootDir).
const BDI_RUNTIME_PATH = "../../mabos/bdi-runtime/index.js";

export default function register(api: OpenClawPluginApi) {
  // ── 1. Register all 99 tools ──────────────────────────────────
  const factories = [
    createBdiTools,
    createPlanningTools,
    createCbrTools,
    createKnowledgeTools,
    createReasoningTools,
    createCommunicationTools,
    createBusinessTools,
    createMetricsTools,
    createDesireTools,
    createFactStoreTools,
    createInferenceTools,
    createRuleEngineTools,
    createMemoryTools,
    createOnboardingTools,
    createStakeholderTools,
    createWorkforceTools,
    createIntegrationTools,
    createReportingTools,
    createMarketingTools,
    createOntologyManagementTools,
    createSetupWizardTools,
    createTypeDBTools,
  ];

  for (const factory of factories) {
    const tools = factory(api);
    for (const tool of tools) {
      api.registerTool(tool);
    }
  }

  // ── 2. BDI Background Service ─────────────────────────────────
  const workspaceDir = resolveWorkspaceDir(api);
  const bdiIntervalMinutes = (api.pluginConfig as any)?.bdiCycleIntervalMinutes ?? 30;

  // Dynamic import to avoid bundling issues — the bdi-runtime
  // lives in mabos/ which is outside the extension directory.
  // For now, inline a minimal service; the full runtime in
  // mabos/bdi-runtime/ is used by the CLI commands.
  let bdiInterval: ReturnType<typeof setInterval> | null = null;

  api.registerService({
    id: "mabos-bdi-heartbeat",
    start: async () => {
      api.logger.info(`[mabos-bdi] Heartbeat started (interval: ${bdiIntervalMinutes}min)`);

      // Initialize TypeDB connection (lazy, non-blocking)
      import("./src/knowledge/typedb-client.js")
        .then(({ getTypeDBClient }) => {
          const client = getTypeDBClient();
          client
            .connect()
            .then((ok) => {
              if (ok) api.logger.info("[mabos] TypeDB connected");
            })
            .catch(() => {});
        })
        .catch(() => {});

      const runCycle = async () => {
        try {
          const { discoverAgents, readAgentCognitiveState, runMaintenanceCycle } = (await import(
            /* webpackIgnore: true */ BDI_RUNTIME_PATH
          )) as any;
          const agents = await discoverAgents(workspaceDir);
          for (const agentId of agents) {
            const { join } = await import("node:path");
            const agentDir = join(workspaceDir, "agents", agentId);
            const state = await readAgentCognitiveState(agentDir, agentId);
            await runMaintenanceCycle(state);
          }
        } catch (err) {
          api.logger.warn?.(
            `[mabos-bdi] Cycle error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      // Initial cycle
      await runCycle();

      // Periodic cycles
      bdiInterval = setInterval(
        () => {
          runCycle().catch(() => {});
        },
        bdiIntervalMinutes * 60 * 1000,
      );
      bdiInterval.unref?.();
    },
    stop: async () => {
      if (bdiInterval) {
        clearInterval(bdiInterval);
        bdiInterval = null;
      }
      api.logger.info("[mabos-bdi] Heartbeat stopped");
    },
  });

  // ── 3. CLI Subcommands ────────────────────────────────────────
  api.registerCli(
    ({ program }) => {
      const mabos = program
        .command("mabos")
        .description("MABOS — Multi-Agent Business Operating System");

      // --- mabos onboard ---
      mabos
        .command("onboard")
        .description("Interactive 5-phase business onboarding")
        .argument("[business-name]", "Name of the business to onboard")
        .option("--industry <type>", "Industry vertical (e.g., ecommerce, saas)")
        .action(async (businessName: string | undefined, opts: { industry?: string }) => {
          const { createOnboardingTools } = await import("./src/tools/onboarding-tools.js");
          const tools = createOnboardingTools(api);
          const orchestrateTool = tools.find((t: any) => t.name === "onboarding_orchestrate");

          if (!orchestrateTool && businessName) {
            console.log(`Starting onboarding for: ${businessName}`);
            console.log("Use the MABOS agent tools for full interactive onboarding.");
            return;
          }

          if (businessName && orchestrateTool) {
            console.log(`Onboarding "${businessName}" (${opts.industry ?? "general"})...`);
            try {
              const result = await (orchestrateTool as any).execute("cli", {
                business_name: businessName,
                industry: opts.industry ?? "general",
              });
              console.log(JSON.stringify(result, null, 2));
            } catch (err) {
              console.error(
                `Onboarding error: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          } else {
            console.log("Usage: mabos onboard <business-name> [--industry <type>]");
            console.log("Industries: ecommerce, saas, consulting, marketplace, retail");
          }
        });

      // --- mabos agents ---
      mabos
        .command("agents")
        .description("List BDI agents with cognitive state summary")
        .action(async () => {
          try {
            const { getAgentsSummary } = (await import(
              /* webpackIgnore: true */ BDI_RUNTIME_PATH
            )) as any;
            const summaries = await getAgentsSummary(workspaceDir);

            if (summaries.length === 0) {
              console.log("No MABOS agents found. Run 'mabos onboard' to create a business.");
              return;
            }

            console.log("\nMABOS Agents\n" + "=".repeat(70));
            console.log(
              "Agent".padEnd(15) +
                "Beliefs".padEnd(10) +
                "Goals".padEnd(10) +
                "Intentions".padEnd(12) +
                "Desires".padEnd(10),
            );
            console.log("-".repeat(70));

            for (const s of summaries) {
              console.log(
                s.agentId.padEnd(15) +
                  String(s.beliefCount).padEnd(10) +
                  String(s.goalCount).padEnd(10) +
                  String(s.intentionCount).padEnd(12) +
                  String(s.desireCount).padEnd(10),
              );
            }
            console.log(`\nTotal: ${summaries.length} agents`);
          } catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        });

      // --- mabos bdi cycle <agent> ---
      mabos
        .command("bdi")
        .description("BDI cognitive operations")
        .command("cycle")
        .argument("<agent-id>", "Agent to run BDI cycle for")
        .description("Trigger a BDI maintenance cycle for an agent")
        .action(async (agentId: string) => {
          try {
            const { join } = await import("node:path");
            const { readAgentCognitiveState, runMaintenanceCycle } = (await import(
              /* webpackIgnore: true */ BDI_RUNTIME_PATH
            )) as any;
            const agentDir = join(workspaceDir, "agents", agentId);
            const state = await readAgentCognitiveState(agentDir, agentId);
            const result = await runMaintenanceCycle(state);
            console.log(`BDI cycle for ${agentId}:`);
            console.log(`  Intentions pruned: ${result.staleIntentionsPruned}`);
            console.log(`  Desires re-sorted: ${result.desiresPrioritized}`);
            console.log(`  Timestamp: ${result.timestamp}`);
          } catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        });

      // --- mabos business list ---
      mabos
        .command("business")
        .description("Business management operations")
        .command("list")
        .description("List managed businesses")
        .action(async () => {
          try {
            const { readdir, stat: fsStat } = await import("node:fs/promises");
            const { join } = await import("node:path");
            const businessDir = join(workspaceDir, "businesses");
            const entries = await readdir(businessDir).catch(() => []);

            if (entries.length === 0) {
              console.log("No businesses found. Run 'mabos onboard' to create one.");
              return;
            }

            console.log("\nManaged Businesses\n" + "=".repeat(50));
            for (const entry of entries) {
              const s = await fsStat(join(businessDir, entry)).catch(() => null);
              if (s?.isDirectory()) {
                const manifest = join(businessDir, entry, "manifest.json");
                try {
                  const { readFile } = await import("node:fs/promises");
                  const data = JSON.parse(await readFile(manifest, "utf-8"));
                  console.log(`  ${data.name ?? entry} (${data.industry ?? "general"})`);
                } catch {
                  console.log(`  ${entry}`);
                }
              }
            }
          } catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        });

      // --- mabos migrate ---
      mabos
        .command("migrate")
        .description("Migrate data from ~/.openclaw to ~/.mabos")
        .option("--dry-run", "Preview changes without modifying files")
        .action(async (opts: { dryRun?: boolean }) => {
          try {
            const migratePath = "../../mabos/scripts/migrate.js";
            const { migrate } = (await import(/* webpackIgnore: true */ migratePath)) as any;
            await migrate({ dryRun: opts.dryRun ?? false });
          } catch (err) {
            console.error(`Migration error: ${err instanceof Error ? err.message : String(err)}`);
          }
        });

      // --- mabos dashboard ---
      mabos
        .command("dashboard")
        .description("Open the MABOS web dashboard")
        .action(async () => {
          const port = api.config?.gateway?.port ?? 18789;
          const url = `http://localhost:${port}/mabos/dashboard`;
          console.log(`Opening dashboard: ${url}`);
          try {
            const { exec } = await import("node:child_process");
            const { platform } = await import("node:os");
            const cmd =
              platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
            exec(`${cmd} ${url}`);
          } catch {
            console.log(`Open manually: ${url}`);
          }
        });
    },
    { commands: ["mabos"] },
  );

  // ── 4. Dashboard HTTP Routes & API Endpoints ─────────────────────

  // Helper: read JSON file safely
  const readJsonSafe = async (p: string) => {
    try {
      const { readFile } = await import("node:fs/promises");
      return JSON.parse(await readFile(p, "utf-8"));
    } catch {
      return null;
    }
  };

  // Helper: read Markdown file safely, extract lines as items
  const readMdLines = async (p: string) => {
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(p, "utf-8");
      return content
        .split("\n")
        .filter((l: string) => l.trim() && !l.startsWith("#"))
        .map((l: string) => l.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 50);
    } catch {
      return [];
    }
  };

  // API: System status (enhanced)
  api.registerHttpRoute({
    path: "/mabos/api/status",
    handler: async (_req, res) => {
      try {
        const { getAgentsSummary } = (await import(
          /* webpackIgnore: true */ BDI_RUNTIME_PATH
        )) as any;
        const agents = await getAgentsSummary(workspaceDir);

        const { readdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const businessDir = join(workspaceDir, "businesses");
        const businesses = await readdir(businessDir).catch(() => []);

        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            product: "MABOS",
            version: api.version ?? "0.1.0",
            bdiHeartbeat: "active",
            bdiIntervalMinutes,
            agents,
            businessCount: businesses.length,
            workspaceDir,
            reasoningToolCount: 20,
          }),
        );
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Pending decisions across all businesses
  api.registerHttpRoute({
    path: "/mabos/api/decisions",
    handler: async (_req, res) => {
      try {
        const { readdir, stat: fsStat } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const businessDir = join(workspaceDir, "businesses");
        const entries = await readdir(businessDir).catch(() => []);
        const allDecisions: any[] = [];

        for (const entry of entries) {
          const s = await fsStat(join(businessDir, entry)).catch(() => null);
          if (!s?.isDirectory()) continue;
          const queuePath = join(businessDir, entry, "decision-queue.json");
          const queue = await readJsonSafe(queuePath);
          if (Array.isArray(queue)) {
            for (const d of queue) {
              if (d.status === "pending") {
                allDecisions.push({ ...d, business_id: entry });
              }
            }
          }
        }

        // Sort by urgency
        const urgencyOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        allDecisions.sort(
          (a, b) => (urgencyOrder[a.urgency] ?? 2) - (urgencyOrder[b.urgency] ?? 2),
        );

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ decisions: allDecisions }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Resolve a decision
  api.registerHttpRoute({
    path: "/mabos/api/decisions/:id/resolve",
    handler: async (req, res) => {
      try {
        const { readFile, writeFile, mkdir } = await import("node:fs/promises");
        const { join, dirname } = await import("node:path");

        let body = "";
        for await (const chunk of req as any) body += chunk;
        const params = JSON.parse(body);

        const queuePath = join(
          workspaceDir,
          "businesses",
          params.business_id,
          "decision-queue.json",
        );
        const queue = await readJsonSafe(queuePath);
        if (!Array.isArray(queue)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Decision queue not found" }));
          return;
        }

        const idx = queue.findIndex((d: any) => d.id === params.decision_id);
        if (idx === -1) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Decision not found" }));
          return;
        }

        const decision = queue[idx];
        decision.status = params.resolution;
        decision.feedback = params.feedback;
        decision.resolved_at = new Date().toISOString();

        await mkdir(dirname(queuePath), { recursive: true });
        await writeFile(queuePath, JSON.stringify(queue, null, 2), "utf-8");

        // Notify agent
        if (decision.agent) {
          const inboxPath = join(
            workspaceDir,
            "businesses",
            params.business_id,
            "agents",
            decision.agent,
            "inbox.json",
          );
          const inbox = (await readJsonSafe(inboxPath)) || [];
          inbox.push({
            id: `DEC-${params.decision_id}-resolved`,
            from: "stakeholder",
            to: decision.agent,
            performative:
              params.resolution === "approved"
                ? "ACCEPT"
                : params.resolution === "rejected"
                  ? "REJECT"
                  : "INFORM",
            content: `Decision ${params.decision_id} ${params.resolution}${params.feedback ? `. Feedback: ${params.feedback}` : ""}`,
            priority: "high",
            timestamp: new Date().toISOString(),
            read: false,
          });
          await mkdir(dirname(inboxPath), { recursive: true });
          await writeFile(inboxPath, JSON.stringify(inbox, null, 2), "utf-8");
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, decision }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Agent detail
  api.registerHttpRoute({
    path: "/mabos/api/agents/:id",
    handler: async (req, res) => {
      try {
        const { join } = await import("node:path");
        const url = new URL(req.url || "", "http://localhost");
        const agentId = url.pathname.split("/").pop() || "";
        const agentDir = join(workspaceDir, "agents", agentId);

        const beliefs = await readMdLines(join(agentDir, "Beliefs.md"));
        const goals = await readMdLines(join(agentDir, "Goals.md"));
        const intentions = await readMdLines(join(agentDir, "Intentions.md"));
        const desires = await readMdLines(join(agentDir, "Desires.md"));

        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            agentId,
            beliefCount: beliefs.length,
            goalCount: goals.length,
            intentionCount: intentions.length,
            desireCount: desires.length,
            beliefs,
            goals,
            intentions,
            desires,
          }),
        );
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Business list
  api.registerHttpRoute({
    path: "/mabos/api/businesses",
    handler: async (_req, res) => {
      try {
        const { readdir, stat: fsStat } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const businessDir = join(workspaceDir, "businesses");
        const entries = await readdir(businessDir).catch(() => []);
        const businesses: any[] = [];

        for (const entry of entries) {
          const s = await fsStat(join(businessDir, entry)).catch(() => null);
          if (!s?.isDirectory()) continue;
          const manifest = await readJsonSafe(join(businessDir, entry, "manifest.json"));
          const agentsDir = join(businessDir, entry, "agents");
          const agentEntries = await readdir(agentsDir).catch(() => []);
          businesses.push({
            id: entry,
            name: manifest?.name ?? entry,
            industry: manifest?.industry ?? "general",
            status: manifest?.status ?? "active",
            agentCount: agentEntries.length,
          });
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ businesses }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Metrics for a business
  api.registerHttpRoute({
    path: "/mabos/api/metrics/:business",
    handler: async (req, res) => {
      try {
        const { join } = await import("node:path");
        const url = new URL(req.url || "", "http://localhost");
        const businessId = url.pathname.split("/").pop() || "";
        const metricsPath = join(workspaceDir, "businesses", businessId, "metrics.json");
        const metrics = await readJsonSafe(metricsPath);

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ business: businessId, metrics: metrics || {} }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Contractors
  api.registerHttpRoute({
    path: "/mabos/api/contractors",
    handler: async (_req, res) => {
      try {
        const { join } = await import("node:path");
        const contractorsPath = join(workspaceDir, "contractors.json");
        const contractors = (await readJsonSafe(contractorsPath)) || [];

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ contractors: Array.isArray(contractors) ? contractors : [] }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // Dashboard: serve SPA HTML
  api.registerHttpRoute({
    path: "/mabos/dashboard",
    handler: async (_req, res) => {
      try {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const thisDir = join(fileURLToPath(import.meta.url), "..");
        const htmlPath = join(thisDir, "src", "dashboard", "index.html");
        const html = await readFile(htmlPath, "utf-8");
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      } catch {
        // Fallback: inline minimal HTML
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!DOCTYPE html><html><head><title>MABOS</title></head><body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;padding:40px"><h1 style="color:#58a6ff">MABOS Dashboard</h1><p>Dashboard files not found. Ensure src/dashboard/ exists.</p></body></html>`,
        );
      }
    },
  });

  // Dashboard: serve CSS
  api.registerHttpRoute({
    path: "/mabos/dashboard/styles.css",
    handler: async (_req, res) => {
      try {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const thisDir = join(fileURLToPath(import.meta.url), "..");
        const cssPath = join(thisDir, "src", "dashboard", "styles.css");
        res.setHeader("Content-Type", "text/css");
        res.end(await readFile(cssPath, "utf-8"));
      } catch {
        res.statusCode = 404;
        res.end("/* not found */");
      }
    },
  });

  // Dashboard: serve JS
  api.registerHttpRoute({
    path: "/mabos/dashboard/app.js",
    handler: async (_req, res) => {
      try {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const thisDir = join(fileURLToPath(import.meta.url), "..");
        const jsPath = join(thisDir, "src", "dashboard", "app.js");
        res.setHeader("Content-Type", "application/javascript");
        res.end(await readFile(jsPath, "utf-8"));
      } catch {
        res.statusCode = 404;
        res.end("// not found");
      }
    },
  });

  // ── 5. Unified Memory Bridge ──────────────────────────────────
  // Bridge MABOS memory_store_item to also use native memory search
  // when available. This augments the existing file-based bridge
  // with the runtime's BM25 + vector search capabilities.
  api.registerTool(
    (ctx) => {
      const memorySearchTool = api.runtime.tools.createMemorySearchTool({
        config: ctx.config,
        agentSessionKey: ctx.sessionKey,
      });

      if (!memorySearchTool) return null;

      return {
        name: "mabos_memory_search",
        label: "MABOS Memory Search",
        description:
          "Search agent memories using the native BM25 + vector search engine. " +
          "This searches across all memory files (daily logs, MEMORY.md, cognitive files). " +
          "Use for recalling past decisions, business context, or agent learnings.",
        parameters: {
          type: "object" as const,
          properties: {
            query: { type: "string" as const, description: "Search query" },
            agent_id: { type: "string" as const, description: "Optional: filter by agent ID" },
            limit: { type: "number" as const, description: "Max results (default 10)" },
          },
          required: ["query"],
        },
        async execute(
          toolCallId: string,
          params: { query: string; agent_id?: string; limit?: number },
        ) {
          // Delegate to the native memory search
          return (memorySearchTool as any).execute(toolCallId, {
            query: params.query,
            limit: params.limit ?? 10,
          });
        },
      };
    },
    { names: ["mabos_memory_search"] },
  );

  // ── 6. Agent Lifecycle Hooks ──────────────────────────────────

  // Inject BDI context + Persona.md into the system prompt
  api.on("before_agent_start", async (_event, ctx) => {
    if (ctx.workspaceDir) {
      const agentDir = ctx.workspaceDir;
      try {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");

        const parts: string[] = [];

        // Load Persona.md
        const persona = await readFile(join(agentDir, "Persona.md"), "utf-8").catch(() => null);
        if (persona) {
          parts.push(`## Agent Persona\n${persona}`);
        }

        // Load active goals summary
        const goals = await readFile(join(agentDir, "Goals.md"), "utf-8").catch(() => null);
        if (goals) {
          // Extract only active goals (first 500 chars for prompt budget)
          const activeGoals = goals
            .split("\n")
            .filter((l) => l.includes("status: active") || l.startsWith("## "))
            .slice(0, 20)
            .join("\n");
          if (activeGoals.trim()) {
            parts.push(`## Active Goals\n${activeGoals}`);
          }
        }

        // Load current commitments
        const commitments = await readFile(join(agentDir, "Commitments.md"), "utf-8").catch(
          () => null,
        );
        if (commitments && commitments.trim()) {
          const summary = commitments.slice(0, 300);
          parts.push(`## Current Commitments\n${summary}`);
        }

        if (parts.length > 0) {
          return {
            prependContext: `[MABOS Agent Context]\n${parts.join("\n\n")}\n`,
          };
        }
      } catch {
        // Not a MABOS agent — skip
      }
    }
    return undefined;
  });

  // BDI tool call audit trail
  api.on("after_tool_call", async (event, _ctx) => {
    if (
      event.toolName.startsWith("belief_") ||
      event.toolName.startsWith("goal_") ||
      event.toolName.startsWith("intention_") ||
      event.toolName.startsWith("desire_") ||
      event.toolName.startsWith("plan_") ||
      event.toolName === "bdi_cycle" ||
      event.toolName.startsWith("mabos_")
    ) {
      api.logger.info(`[mabos] BDI tool: ${event.toolName} (${event.durationMs ?? 0}ms)`);
    }
  });

  api.logger.info("[mabos] MABOS extension registered (bundled, deep integration)");
}
