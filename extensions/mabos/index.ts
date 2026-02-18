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

  // API: Onboard a new business (POST)
  api.registerHttpRoute({
    path: "/mabos/api/onboard",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      try {
        const { readFile: rf, writeFile: wf, mkdir: mk, existsSync: ex } = await import("node:fs");
        const { readFile, writeFile, mkdir } = await import("node:fs/promises");
        const { join, dirname } = await import("node:path");
        const { existsSync } = await import("node:fs");

        let body = "";
        for await (const chunk of req as any) body += chunk;
        const params = JSON.parse(body);

        if (!params.business_id || !params.name || !params.type) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing required fields: business_id, name, type" }));
          return;
        }

        const bizDir = join(workspaceDir, "businesses", params.business_id);
        const now = new Date().toISOString();

        if (existsSync(bizDir)) {
          res.statusCode = 409;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: `Business '${params.business_id}' already exists` }));
          return;
        }

        const ROLES = ["ceo", "cfo", "coo", "cmo", "cto", "hr", "legal", "strategy", "knowledge"];

        // 1. Create manifest
        const manifest: any = {
          id: params.business_id,
          name: params.name,
          legal_name: params.legal_name || params.name,
          type: params.type,
          description: params.description || "",
          jurisdiction: params.jurisdiction || "",
          stage: params.stage || "mvp",
          status: "active",
          created: now,
          agents: [...ROLES],
          domain_agents: [],
        };
        await mkdir(bizDir, { recursive: true });
        await writeFile(join(bizDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

        // 2. Copy/create core agent cognitive files
        const { fileURLToPath } = await import("node:url");
        const thisDir = join(fileURLToPath(import.meta.url), "..");
        const templateBase = join(thisDir, "templates", "base", "agents");

        for (const role of ROLES) {
          const agentPath = join(bizDir, "agents", role);
          await mkdir(agentPath, { recursive: true });

          // Try to copy persona from template
          const templatePersona = join(templateBase, role, "Persona.md");
          if (existsSync(templatePersona)) {
            let persona = await readFile(templatePersona, "utf-8");
            persona = persona.replace(/\{business_name\}/g, params.name);
            await writeFile(join(agentPath, "Persona.md"), persona, "utf-8");
          } else {
            await writeFile(
              join(agentPath, "Persona.md"),
              `# Persona — ${role.toUpperCase()}\n\n**Role:** ${role.toUpperCase()}\n**Business:** ${params.name}\n`,
              "utf-8",
            );
          }

          // Try to copy capabilities from template
          const templateCaps = join(templateBase, role, "Capabilities.md");
          if (existsSync(templateCaps)) {
            await writeFile(
              join(agentPath, "Capabilities.md"),
              await readFile(templateCaps, "utf-8"),
              "utf-8",
            );
          }

          // Init cognitive files
          for (const f of [
            "Beliefs.md",
            "Desires.md",
            "Goals.md",
            "Intentions.md",
            "Plans.md",
            "Playbooks.md",
            "Knowledge.md",
            "Memory.md",
          ]) {
            await writeFile(
              join(agentPath, f),
              `# ${f.replace(".md", "")} — ${role.toUpperCase()}\n\nInitialized: ${now.split("T")[0]}\nBusiness: ${params.name}\n`,
              "utf-8",
            );
          }
          await writeFile(join(agentPath, "inbox.json"), "[]", "utf-8");
          await writeFile(join(agentPath, "cases.json"), "[]", "utf-8");
          await writeFile(
            join(agentPath, "facts.json"),
            JSON.stringify({ facts: [], version: 0 }, null, 2),
            "utf-8",
          );
          await writeFile(
            join(agentPath, "rules.json"),
            JSON.stringify({ rules: [], version: 0 }, null, 2),
            "utf-8",
          );
          await writeFile(
            join(agentPath, "memory-store.json"),
            JSON.stringify({ working: [], short_term: [], long_term: [], version: 0 }, null, 2),
            "utf-8",
          );
        }

        // 3. Generate BMC
        const bmc = {
          business_id: params.business_id,
          generated_at: now,
          canvas: {
            value_propositions: params.value_propositions || [],
            customer_segments: params.customer_segments || [],
            revenue_streams: params.revenue_streams || [],
            key_partners: params.key_partners || [],
            key_activities: params.key_activities || [],
            key_resources: params.key_resources || [],
            customer_relationships: params.customer_relationships || [],
            channels: params.channels || [],
            cost_structure: params.cost_structure || [],
          },
        };
        await writeFile(
          join(bizDir, "business-model-canvas.json"),
          JSON.stringify(bmc, null, 2),
          "utf-8",
        );

        // 4. Create shared resources
        await writeFile(join(bizDir, "decision-queue.json"), "[]", "utf-8");
        await writeFile(
          join(bizDir, "metrics.json"),
          JSON.stringify({ metrics: [], snapshots: [] }, null, 2),
          "utf-8",
        );
        await writeFile(
          join(bizDir, "README.md"),
          `# ${params.name}\n\n**Legal:** ${params.legal_name || params.name}\n**Type:** ${params.type}\n**Created:** ${now}\n\n${params.description || ""}\n`,
          "utf-8",
        );

        // 5. Orchestrate if requested
        if (params.orchestrate) {
          // 5a. Spawn domain agents
          const domainAgentDefs: Record<
            string,
            Array<{ id: string; name: string; role: string }>
          > = {
            ecommerce: [
              {
                id: "inventory-mgr",
                name: "Inventory Manager",
                role: "Manages stock levels, reorder points, and supplier relationships",
              },
              {
                id: "fulfillment-mgr",
                name: "Fulfillment Manager",
                role: "Handles order processing, shipping, and returns",
              },
              {
                id: "product-mgr",
                name: "Product Manager",
                role: "Manages product catalog, pricing, and listings",
              },
            ],
            saas: [
              {
                id: "devops",
                name: "DevOps Engineer",
                role: "Manages deployments, monitoring, uptime, and infrastructure",
              },
              {
                id: "product-mgr",
                name: "Product Manager",
                role: "Manages feature roadmap, user research, and releases",
              },
              {
                id: "customer-success",
                name: "Customer Success",
                role: "Manages onboarding, retention, and churn prevention",
              },
            ],
            consulting: [
              {
                id: "engagement-mgr",
                name: "Engagement Manager",
                role: "Manages client engagements, milestones, and deliverables",
              },
              {
                id: "biz-dev",
                name: "Business Development",
                role: "Manages pipeline, proposals, and client acquisition",
              },
            ],
            marketplace: [
              {
                id: "supply-mgr",
                name: "Supply Manager",
                role: "Manages seller onboarding, quality, and trust scoring",
              },
              {
                id: "demand-mgr",
                name: "Demand Manager",
                role: "Manages buyer acquisition, matching, and experience",
              },
              {
                id: "trust-safety",
                name: "Trust & Safety",
                role: "Manages disputes, fraud prevention, and platform integrity",
              },
            ],
            retail: [
              {
                id: "store-mgr",
                name: "Store Manager",
                role: "Manages store operations, staff scheduling, and customer experience",
              },
              {
                id: "merchandiser",
                name: "Merchandiser",
                role: "Manages product placement, promotions, and visual merchandising",
              },
            ],
          };
          const agents = domainAgentDefs[params.type] || [];
          for (const agent of agents) {
            const agentPath = join(bizDir, "agents", agent.id);
            await mkdir(agentPath, { recursive: true });
            await writeFile(
              join(agentPath, "Persona.md"),
              `# Persona — ${agent.name}\n\n**Role:** ${agent.name}\n**Agent ID:** ${agent.id}\n**Type:** Domain-specific\n\n## Identity\n${agent.role}\n`,
              "utf-8",
            );
            for (const f of [
              "Capabilities.md",
              "Beliefs.md",
              "Desires.md",
              "Goals.md",
              "Intentions.md",
              "Plans.md",
              "Playbooks.md",
              "Knowledge.md",
              "Memory.md",
            ]) {
              await writeFile(
                join(agentPath, f),
                `# ${f.replace(".md", "")} — ${agent.name}\n\nInitialized: ${now.split("T")[0]}\n`,
                "utf-8",
              );
            }
            await writeFile(join(agentPath, "inbox.json"), "[]", "utf-8");
            await writeFile(join(agentPath, "cases.json"), "[]", "utf-8");
          }
          manifest.domain_agents = agents.map((a: any) => a.id);
          await writeFile(
            join(bizDir, "manifest.json"),
            JSON.stringify(manifest, null, 2),
            "utf-8",
          );

          // 5b. Initialize desires from templates
          const templateDir = join(thisDir, "templates", "base");
          for (const role of ROLES) {
            const templateFile = join(templateDir, `desires-${role}.md`);
            if (existsSync(templateFile)) {
              let content = await readFile(templateFile, "utf-8");
              content = content.replace(/\{business_name\}/g, params.name);
              await writeFile(join(bizDir, "agents", role, "Desires.md"), content, "utf-8");
            }
          }

          // 5c. SBVR sync (best-effort, non-blocking)
          try {
            const { loadOntologies, mergeOntologies, exportSBVRForTypeDB } =
              await import("./src/ontology/index.js");
            const ontologies = loadOntologies();
            const graph = mergeOntologies(ontologies);
            const sbvrExport = exportSBVRForTypeDB(graph);
            await writeFile(
              join(bizDir, "sbvr-export.json"),
              JSON.stringify(sbvrExport, null, 2),
              "utf-8",
            );
          } catch {
            /* best-effort */
          }

          // 5d. Write onboarding progress
          const progress = {
            business_id: params.business_id,
            started_at: now,
            phases: {
              discovery: { status: "completed", started_at: now, completed_at: now },
              architecture: { status: "completed", started_at: now, completed_at: now },
              agents: { status: "completed", started_at: now, completed_at: now },
              knowledge_graph: { status: "completed", started_at: now, completed_at: now },
              launch: { status: "completed", started_at: now, completed_at: now },
            },
            current_phase: "launch",
            overall_status: "completed",
          };
          await writeFile(
            join(bizDir, "onboarding-progress.json"),
            JSON.stringify(progress, null, 2),
            "utf-8",
          );
        }

        // 6. Generate Tropos goal model from stakeholder goals if provided
        if (params.goals && params.goals.length > 0) {
          const goalMapping = params.goals.map((g: string, i: number) => {
            const gl = g.toLowerCase();
            let agent = "ceo";
            if (gl.includes("revenue") || gl.includes("profit") || gl.includes("cost"))
              agent = "cfo";
            else if (gl.includes("customer") || gl.includes("market") || gl.includes("brand"))
              agent = "cmo";
            else if (gl.includes("tech") || gl.includes("platform") || gl.includes("build"))
              agent = "cto";
            else if (gl.includes("operation") || gl.includes("process") || gl.includes("efficien"))
              agent = "coo";
            return {
              id: `G-${String(i + 1).padStart(3, "0")}`,
              text: g,
              type: "hard" as const,
              priority: 0.8,
              actor: agent,
              parent_goal: null,
              decomposition: "AND",
              linked_tasks: [] as string[],
              contributions: [] as any[],
            };
          });
          const tropos = {
            business_id: params.business_id,
            generated_at: now,
            actors: [
              {
                id: "stakeholder",
                type: "principal",
                goals: params.goals.map((g: string, i: number) => ({
                  goal: g,
                  priority: 0.8,
                  type: "hard",
                })),
                x: 400,
                y: 50,
              },
              ...ROLES.map((r: string) => ({
                id: r,
                type: "agent",
                delegated_goals: goalMapping
                  .filter((gm: any) => gm.actor === r)
                  .map((gm: any) => gm.text),
                x: 0,
                y: 0,
              })),
            ],
            goals: goalMapping,
            goal_mapping: goalMapping.map((gm: any) => ({
              stakeholder_goal: gm.text,
              priority: gm.priority,
              type: gm.type,
              primary_agent: gm.actor,
            })),
            dependencies: ROLES.map((r: string) => ({
              from: "stakeholder",
              to: r,
              type: "delegation",
            })),
            constraints: [],
          };
          await writeFile(
            join(bizDir, "tropos-goal-model.json"),
            JSON.stringify(tropos, null, 2),
            "utf-8",
          );
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, business: manifest }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Get goal model for a business
  api.registerHttpRoute({
    path: "/mabos/api/businesses/:id/goals",
    handler: async (req, res) => {
      try {
        const { readFile, readdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { existsSync } = await import("node:fs");

        const url = new URL(req.url || "", "http://localhost");
        const segments = url.pathname.split("/");
        const bizIdx = segments.indexOf("businesses");
        const businessId = segments[bizIdx + 1] || "";
        const bizDir = join(workspaceDir, "businesses", businessId);

        if (req.method === "PUT") {
          // Update goal model
          let body = "";
          for await (const chunk of req as any) body += chunk;
          const goalModel = JSON.parse(body);
          const { writeFile, mkdir } = await import("node:fs/promises");
          await mkdir(bizDir, { recursive: true });
          await writeFile(
            join(bizDir, "tropos-goal-model.json"),
            JSON.stringify(goalModel, null, 2),
            "utf-8",
          );

          // Cascade: update agent Goals.md files
          if (goalModel.goals && goalModel.actors) {
            for (const actor of goalModel.actors) {
              if (actor.type === "agent") {
                const agentGoals = goalModel.goals.filter((g: any) => g.actor === actor.id);
                if (agentGoals.length > 0) {
                  const goalsContent = `# Goals — ${actor.id.toUpperCase()}\n\nUpdated: ${new Date().toISOString().split("T")[0]}\n\n${agentGoals.map((g: any) => `## ${g.id}: ${g.text}\n- **Type:** ${g.type}\n- **Priority:** ${g.priority}\n- **Status:** active\n`).join("\n")}`;
                  const agentDir = join(bizDir, "agents", actor.id);
                  if (existsSync(agentDir)) {
                    await writeFile(join(agentDir, "Goals.md"), goalsContent, "utf-8");
                  }
                }
              }
            }
          }

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, goals: goalModel }));
          return;
        }

        // GET: Read goal model
        const troposPath = join(bizDir, "tropos-goal-model.json");
        let goalModel = await readJsonSafe(troposPath);

        if (!goalModel) {
          // Build from manifest + agent Goals.md
          const manifest = await readJsonSafe(join(bizDir, "manifest.json"));
          const goals: any[] = [];
          const actors: any[] = [
            { id: "stakeholder", type: "principal", goals: [], x: 400, y: 50 },
          ];

          if (manifest?.agents) {
            for (const agentId of manifest.agents) {
              const goalsPath = join(bizDir, "agents", agentId, "Goals.md");
              const agentGoals = await readMdLines(goalsPath);
              actors.push({ id: agentId, type: "agent", delegated_goals: agentGoals, x: 0, y: 0 });
              agentGoals.forEach((g: string, i: number) => {
                goals.push({
                  id: `G-${agentId}-${i}`,
                  text: g,
                  type: "hard",
                  priority: 0.5,
                  actor: agentId,
                  parent_goal: null,
                  decomposition: "AND",
                  linked_tasks: [],
                  contributions: [],
                });
              });
            }
          }

          goalModel = { actors, goals, goal_mapping: [], dependencies: [], constraints: [] };
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(goalModel));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Get tasks for a business (parsed from agent Plans.md)
  api.registerHttpRoute({
    path: "/mabos/api/businesses/:id/tasks",
    handler: async (req, res) => {
      try {
        const { readFile, readdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { existsSync } = await import("node:fs");

        const url = new URL(req.url || "", "http://localhost");
        const segments = url.pathname.split("/");
        const bizIdx = segments.indexOf("businesses");
        const businessId = segments[bizIdx + 1] || "";
        const bizDir = join(workspaceDir, "businesses", businessId);
        const agentsDir = join(bizDir, "agents");

        const tasks: any[] = [];
        const agentEntries = await readdir(agentsDir).catch(() => []);

        for (const agentId of agentEntries) {
          const plansPath = join(agentsDir, agentId, "Plans.md");
          if (!existsSync(plansPath)) continue;

          const content = await readFile(plansPath, "utf-8");
          const lines = content.split("\n");
          let currentPlan = "";
          let currentPlanId = "";

          for (const line of lines) {
            // Match plan headers: ### P-001: Plan Name
            const planMatch = line.match(/^###\s+(P-\d+):\s*(.+)/);
            if (planMatch) {
              currentPlanId = planMatch[1];
              currentPlan = planMatch[2].trim();
              continue;
            }

            // Match table rows: | S-1 | description | type | assigned | depends | status | duration |
            const rowMatch = line.match(
              /^\|\s*(S-\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/,
            );
            if (rowMatch && currentPlanId) {
              tasks.push({
                id: `${currentPlanId}-${rowMatch[1]}`,
                plan_id: currentPlanId,
                plan_name: currentPlan,
                step_id: rowMatch[1],
                description: rowMatch[2].trim(),
                type: rowMatch[3].trim(),
                assigned_to: rowMatch[4].trim() || agentId,
                depends_on:
                  rowMatch[5].trim() === "-"
                    ? []
                    : rowMatch[5]
                        .trim()
                        .split(",")
                        .map((s: string) => s.trim()),
                status: rowMatch[6].trim().toLowerCase() || "proposed",
                estimated_duration: rowMatch[7].trim(),
                agent_id: agentId,
              });
            }
          }

          // Also check for plans.json
          const plansJsonPath = join(agentsDir, agentId, "plans.json");
          const plansJson = await readJsonSafe(plansJsonPath);
          if (plansJson && Array.isArray(plansJson.plans)) {
            for (const plan of plansJson.plans) {
              if (plan.steps) {
                for (const step of plan.steps) {
                  tasks.push({
                    id: `${plan.id}-${step.id}`,
                    plan_id: plan.id,
                    plan_name: plan.name || plan.id,
                    step_id: step.id,
                    description: step.description || step.name || "",
                    type: step.type || "task",
                    assigned_to: step.assigned_to || agentId,
                    depends_on: step.depends_on || [],
                    status: step.status || "proposed",
                    estimated_duration: step.estimated_duration || "",
                    agent_id: agentId,
                  });
                }
              }
            }
          }
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ tasks }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Update task status
  api.registerHttpRoute({
    path: "/mabos/api/businesses/:id/tasks/:taskId",
    handler: async (req, res) => {
      try {
        const { readFile, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");

        let body = "";
        for await (const chunk of req as any) body += chunk;
        const params = JSON.parse(body);

        const url = new URL(req.url || "", "http://localhost");
        const segments = url.pathname.split("/");
        const bizIdx = segments.indexOf("businesses");
        const businessId = segments[bizIdx + 1] || "";
        const agentsDir = join(workspaceDir, "businesses", businessId, "agents");

        // Find the task in agent Plans.md files and update status
        const { readdir } = await import("node:fs/promises");
        const { existsSync } = await import("node:fs");
        const agentEntries = await readdir(agentsDir).catch(() => []);
        let updated = false;

        for (const agentId of agentEntries) {
          const plansPath = join(agentsDir, agentId, "Plans.md");
          if (!existsSync(plansPath)) continue;

          let content = await readFile(plansPath, "utf-8");
          const taskId = segments[segments.length - 1] || "";
          // Try to find and update the step row with matching ID
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(taskId.split("-").pop() || "") && lines[i].startsWith("|")) {
              // Replace status in the row
              const parts = lines[i].split("|");
              if (parts.length >= 7 && params.status) {
                parts[6] = ` ${params.status} `;
                lines[i] = parts.join("|");
                updated = true;
              }
            }
          }
          if (updated) {
            await writeFile(plansPath, lines.join("\n"), "utf-8");
            break;
          }
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, updated }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Get agents for a business
  api.registerHttpRoute({
    path: "/mabos/api/businesses/:id/agents",
    handler: async (req, res) => {
      try {
        const { readFile, readdir, stat: fsStat } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { existsSync } = await import("node:fs");

        const url = new URL(req.url || "", "http://localhost");
        const segments = url.pathname.split("/");
        const bizIdx = segments.indexOf("businesses");
        const businessId = segments[bizIdx + 1] || "";
        const bizDir = join(workspaceDir, "businesses", businessId);
        const agentsDir = join(bizDir, "agents");

        const manifest = await readJsonSafe(join(bizDir, "manifest.json"));
        const agentEntries = await readdir(agentsDir).catch(() => []);
        const agents: any[] = [];

        for (const agentId of agentEntries) {
          const agentPath = join(agentsDir, agentId);
          const s = await fsStat(agentPath).catch(() => null);
          if (!s?.isDirectory()) continue;

          const countLines = async (file: string) => {
            try {
              const content = await readFile(file, "utf-8");
              return content.split("\n").filter((l: string) => l.trim() && !l.startsWith("#"))
                .length;
            } catch {
              return 0;
            }
          };

          const beliefs = await countLines(join(agentPath, "Beliefs.md"));
          const goals = await countLines(join(agentPath, "Goals.md"));
          const intentions = await countLines(join(agentPath, "Intentions.md"));
          const desires = await countLines(join(agentPath, "Desires.md"));

          const config = await readJsonSafe(join(agentPath, "config.json"));
          const isCoreAgent = manifest?.agents?.includes(agentId);

          agents.push({
            id: agentId,
            name: agentId.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
            type: isCoreAgent ? "core" : "domain",
            beliefs,
            goals,
            intentions,
            desires,
            status: config?.status || "active",
            autonomy_level: config?.autonomy_level || "medium",
            approval_threshold_usd: config?.approval_threshold_usd || 100,
          });
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ agents }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Update agent config
  api.registerHttpRoute({
    path: "/mabos/api/businesses/:id/agents/:agentId",
    handler: async (req, res) => {
      try {
        const { readFile, writeFile, mkdir } = await import("node:fs/promises");
        const { join, dirname } = await import("node:path");

        let body = "";
        for await (const chunk of req as any) body += chunk;
        const params = JSON.parse(body);

        const url = new URL(req.url || "", "http://localhost");
        const segments = url.pathname.split("/");
        const bizIdx = segments.indexOf("businesses");
        const businessId = segments[bizIdx + 1] || "";
        const agentId = segments[segments.length - 1] || "";
        const agentDir = join(workspaceDir, "businesses", businessId, "agents", agentId);
        const configPath = join(agentDir, "config.json");

        const config = (await readJsonSafe(configPath)) || {};
        if (params.status !== undefined) config.status = params.status;
        if (params.autonomy_level !== undefined) config.autonomy_level = params.autonomy_level;
        if (params.approval_threshold_usd !== undefined)
          config.approval_threshold_usd = params.approval_threshold_usd;
        config.updated_at = new Date().toISOString();

        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, config }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Get campaigns for a business
  api.registerHttpRoute({
    path: "/mabos/api/businesses/:id/campaigns",
    handler: async (req, res) => {
      try {
        const { join } = await import("node:path");

        const url = new URL(req.url || "", "http://localhost");
        const segments = url.pathname.split("/");
        const bizIdx = segments.indexOf("businesses");
        const businessId = segments[bizIdx + 1] || "";
        const marketingPath = join(workspaceDir, "businesses", businessId, "marketing.json");
        const marketing = await readJsonSafe(marketingPath);

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ campaigns: marketing?.campaigns || [] }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // Dashboard: serve SPA HTML (no trailing slash)
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
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!DOCTYPE html><html><head><title>MABOS</title></head><body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;padding:40px"><h1 style="color:#58a6ff">MABOS Dashboard</h1><p>Dashboard files not found. Ensure src/dashboard/ exists.</p></body></html>`,
        );
      }
    },
  });

  // Dashboard: wildcard static file server for all dashboard assets
  api.registerHttpRoute({
    path: "/mabos/dashboard/*",
    handler: async (req, res) => {
      try {
        const { readFile } = await import("node:fs/promises");
        const { join, extname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const thisDir = join(fileURLToPath(import.meta.url), "..");

        const url = new URL(req.url || "", "http://localhost");
        const filePath = url.pathname.replace("/mabos/dashboard/", "");

        // Block directory traversal
        if (filePath.includes("..") || filePath.includes("~") || !filePath) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        const fullPath = join(thisDir, "src", "dashboard", filePath);
        const contentTypes: Record<string, string> = {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "application/javascript",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        };

        const ext = extname(filePath).toLowerCase();
        const contentType = contentTypes[ext] || "application/octet-stream";

        const content = await readFile(fullPath);
        res.setHeader("Content-Type", contentType);
        res.end(content);
      } catch {
        res.statusCode = 404;
        res.end("Not found");
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
