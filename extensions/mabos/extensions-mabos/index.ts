/**
 * MABOS — Multi-Agent Business Operating System
 * Bundled Extension Entry Point (Deep Integration)
 *
 * Registers:
 *  - 110 tools across 24 modules
 *  - BDI background heartbeat service
 *  - CLI subcommands (onboard, agents, bdi, business, dashboard)
 *  - Unified memory bridge to native memory system
 *  - Agent lifecycle hooks (Persona injection, BDI audit trail)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAuthRateLimiter } from "../../../src/gateway/auth-rate-limit.js";
import { resolveGatewayAuth, type ResolvedGatewayAuth } from "../../../src/gateway/auth.js";
import { authorizeGatewayBearerRequestOrReply } from "../../../src/gateway/http-auth-helpers.js";
import { onAgentEvent, type AgentEventPayload } from "../../../src/infra/agent-events.js";
import { readJsonBodyWithLimit } from "../../../src/infra/http-body.js";
import { createCronBridgeService } from "./src/cron-bridge.js";
import { createSecurityModule } from "./src/security/index.js";
import { createBdiTools } from "./src/tools/bdi-tools.js";
import { createBpmnMigrateTools } from "./src/tools/bpmn-migrate.js";
import { createBusinessTools } from "./src/tools/business-tools.js";
import { createCapabilitiesSyncTools } from "./src/tools/capabilities-sync.js";
import { createCatalogSyncTools } from "./src/tools/catalog-sync-tools.js";
import { createCbrTools } from "./src/tools/cbr-tools.js";
import {
  createCognitiveRouterTools,
  enhancedHeartbeatCycle,
} from "./src/tools/cognitive-router.js";
import { resolveWorkspaceDir, getPluginConfig } from "./src/tools/common.js";
import { createCommunicationTools } from "./src/tools/communication-tools.js";
import { createCompetitorMonitorTools } from "./src/tools/competitor-monitor-tools.js";
import { createCrmTools } from "./src/tools/crm-tools.js";
import { createDesireTools } from "./src/tools/desire-tools.js";
import { createEmailTools } from "./src/tools/email-tools.js";
import { createFactStoreTools } from "./src/tools/fact-store.js";
import { createFinancialTools } from "./src/tools/financial-tools.js";
import { createInferenceTools } from "./src/tools/inference-tools.js";
import { createIntegrationTools } from "./src/tools/integration-tools.js";
import { createKnowledgeTools } from "./src/tools/knowledge-tools.js";
import { createLeInventoryTools } from "./src/tools/le-inventory-tools.js";
import { createLeWaitlistTools } from "./src/tools/le-waitlist-tools.js";
import { createLeadGenerationTools } from "./src/tools/lead-generation-tools.js";
import { createMarketingTools } from "./src/tools/marketing-tools.js";
import { createMemoryHierarchyTools } from "./src/tools/memory-hierarchy.js";
import { createMemoryTools } from "./src/tools/memory-tools.js";
import { createMetricsTools } from "./src/tools/metrics-tools.js";
import { createOnboardingTools } from "./src/tools/onboarding-tools.js";
import { createOntologyManagementTools } from "./src/tools/ontology-management-tools.js";
import { createOperationsTools } from "./src/tools/operations-tools.js";
import { createOutreachTools } from "./src/tools/outreach-tools.js";
import { createPlanningTools } from "./src/tools/planning-tools.js";
import { createReasoningTools } from "./src/tools/reasoning-tools.js";
import { createReportingTools } from "./src/tools/reporting-tools.js";
import { createRuleEngineTools } from "./src/tools/rule-engine.js";
import { createSalesResearchTools } from "./src/tools/sales-research-tools.js";
import { createSeoAnalyticsTools } from "./src/tools/seo-analytics-tools.js";
import { createSetupWizardTools } from "./src/tools/setup-wizard-tools.js";
import { createStakeholderTools } from "./src/tools/stakeholder-tools.js";
import { createTechOpsTools } from "./src/tools/techops-tools.js";
import { isToolAllowedForRole } from "./src/tools/tool-filter.js";
import { createTypeDBTools } from "./src/tools/typedb-tools.js";
import { createWorkflowTools } from "./src/tools/workflow-tools.js";
import { createWorkforceTools } from "./src/tools/workforce-tools.js";

// Use a variable for the bdi-runtime path so TypeScript doesn't try to
// statically resolve it (it lives outside this extension's rootDir).
const BDI_RUNTIME_PATH = "../../../mabos/bdi-runtime/index.js";

export default function register(api: OpenClawPluginApi) {
  const log = api.logger;

  // ── 0. Security Module (runs before all tools) ───────────────
  const pluginConfig = getPluginConfig(api);
  createSecurityModule(api, pluginConfig);

  // ── 1. Register all tools ─────────────────────────────────────
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
    createMemoryHierarchyTools,
    createOnboardingTools,
    createStakeholderTools,
    createWorkforceTools,
    createIntegrationTools,
    createReportingTools,
    createMarketingTools,
    createCrmTools,
    createEmailTools,
    createSeoAnalyticsTools,
    createOntologyManagementTools,
    createSetupWizardTools,
    createTypeDBTools,
    createWorkflowTools,
    createBpmnMigrateTools,
    createCognitiveRouterTools,
    createLeadGenerationTools,
    createSalesResearchTools,
    createOutreachTools,
    createFinancialTools,
    createOperationsTools,
    createTechOpsTools,
    createCatalogSyncTools,
    createLeWaitlistTools,
    createLeInventoryTools,
    createCompetitorMonitorTools,
  ];

  // Collect all tool names for capabilities_sync context
  const registeredToolNames: string[] = [];

  for (const factory of factories) {
    const tools = factory(api);
    for (const tool of tools) {
      api.registerTool(tool);
      registeredToolNames.push(tool.name);
    }
  }

  // Register capabilities_sync (needs the tool name list)
  const capSyncTools = createCapabilitiesSyncTools(api, { registeredToolNames });
  for (const tool of capSyncTools) {
    api.registerTool(tool);
    registeredToolNames.push(tool.name);
  }

  // Export tool filter for per-agent scoping (used by cognitive router)
  // Agents can check `isToolAllowedForRole(role, toolName)` at runtime
  (api as any)._mabosToolFilter = { isToolAllowedForRole, registeredToolNames };

  // ── 2. BDI Background Service ─────────────────────────────────
  const workspaceDir = resolveWorkspaceDir(api);

  // Resolve gateway auth for MABOS HTTP routes
  const gatewayAuthConfig = (api as any).config?.gateway?.auth ?? {};
  const resolvedAuth: ResolvedGatewayAuth = resolveGatewayAuth({
    authConfig: gatewayAuthConfig,
  });

  const authRateLimiter =
    resolvedAuth.mode !== "none"
      ? createAuthRateLimiter({
          maxAttempts: 10,
          windowMs: 60_000,
          lockoutMs: 300_000,
        })
      : undefined;

  async function requireAuth(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<boolean> {
    // Skip auth if gateway is in "none" mode
    if (resolvedAuth.mode === "none") return true;
    // Skip auth for requests originating from the MABOS dashboard UI
    const referer = req.headers.referer || req.headers.origin || "";
    if (referer.includes("/mabos/dashboard")) return true;
    return authorizeGatewayBearerRequestOrReply({
      req,
      res,
      auth: resolvedAuth,
      rateLimiter: authRateLimiter,
    });
  }
  async function readMabosJsonBody<T = Record<string, unknown>>(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    opts?: { maxBytes?: number },
  ): Promise<T | null> {
    const result = await readJsonBodyWithLimit(req, {
      maxBytes: opts?.maxBytes ?? 1_048_576,
      timeoutMs: 10_000,
    });
    if (!result.ok) {
      const statusCode = result.code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
      const message =
        result.code === "PAYLOAD_TOO_LARGE" ? "Request body too large" : "Invalid JSON body";
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return null;
    }
    return result.value as T;
  }

  const bdiIntervalMinutes = getPluginConfig(api).bdiCycleIntervalMinutes ?? 30;

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
            .catch((err) => {
              log.debug(`TypeDB connect failed: ${err}`);
            });
        })
        .catch((err) => {
          log.debug(`TypeDB import failed: ${err}`);
        });

      const cognitiveRouterEnabled = getPluginConfig(api).cognitiveRouterEnabled ?? true;

      const runLegacyCycle = async () => {
        try {
          const { discoverAgents, readAgentCognitiveState, runMaintenanceCycle } = (await import(
            /* webpackIgnore: true */ BDI_RUNTIME_PATH
          )) as import("./src/types/bdi-runtime.js").BdiRuntime;
          const agents = await discoverAgents(workspaceDir);
          for (const agentId of agents) {
            const { join } = await import("node:path");
            const agentDir = join(workspaceDir, "agents", agentId);
            const state = await readAgentCognitiveState(agentDir, agentId);
            const cycleResult = await runMaintenanceCycle(state);

            // Fire-and-forget: write BDI cycle results to TypeDB
            import("./src/knowledge/typedb-dashboard.js")
              .then(({ writeBdiCycleResultToTypeDB }) =>
                writeBdiCycleResultToTypeDB(agentId, "mabos", {
                  newIntentions: cycleResult?.newIntentions,
                  newBeliefs: cycleResult?.newBeliefs,
                  updatedGoals: cycleResult?.updatedGoals,
                }),
              )
              .catch((err) => {
                log.debug(`TypeDB BDI write failed: ${err}`);
              });
          }
        } catch (err) {
          api.logger.warn?.(
            `[mabos-bdi] Cycle error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      const runCycle = cognitiveRouterEnabled
        ? async () => {
            try {
              await enhancedHeartbeatCycle(workspaceDir, api, {
                info: (...args: any[]) => api.logger.info?.(...args),
                debug: (...args: any[]) => log.debug?.(...args),
                warn: (...args: any[]) => api.logger.warn?.(...args),
              });
            } catch (err) {
              api.logger.warn?.(
                `[cognitive-router] Cycle error, falling back to legacy: ${err instanceof Error ? err.message : String(err)}`,
              );
              await runLegacyCycle();
            }
          }
        : runLegacyCycle;

      // Initial cycle
      await runCycle();

      // Periodic cycles
      bdiInterval = setInterval(
        () => {
          runCycle().catch((err) => {
            log.debug(`BDI periodic cycle failed: ${err}`);
          });
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
      // Close TypeDB connection
      try {
        const { getTypeDBClient } = await import("./src/knowledge/typedb-client.js");
        const client = getTypeDBClient();
        if (client.isAvailable()) {
          await client.close();
        }
      } catch {
        // TypeDB may not be configured — ignore
      }

      authRateLimiter?.dispose();
      api.logger.info("[mabos-bdi] Heartbeat stopped");
    },
  });

  // ── 2b. Cron Bridge Service ──────────────────────────────────
  api.registerService(createCronBridgeService(api));

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
            log.info(`Starting onboarding for: ${businessName}`);
            log.info("Use the MABOS agent tools for full interactive onboarding.");
            return;
          }

          if (businessName && orchestrateTool) {
            log.info(`Onboarding "${businessName}" (${opts.industry ?? "general"})...`);
            try {
              const result = await (orchestrateTool as any).execute("cli", {
                business_name: businessName,
                industry: opts.industry ?? "general",
              });
              log.info(JSON.stringify(result, null, 2));
            } catch (err) {
              log.error(`Onboarding error: ${err instanceof Error ? err.message : String(err)}`);
            }
          } else {
            log.info("Usage: mabos onboard <business-name> [--industry <type>]");
            log.info("Industries: ecommerce, saas, consulting, marketplace, retail");
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
              log.info("No MABOS agents found. Run 'mabos onboard' to create a business.");
              return;
            }

            log.info("\nMABOS Agents\n" + "=".repeat(70));
            log.info(
              "Agent".padEnd(15) +
                "Beliefs".padEnd(10) +
                "Goals".padEnd(10) +
                "Intentions".padEnd(12) +
                "Desires".padEnd(10),
            );
            log.info("-".repeat(70));

            for (const s of summaries) {
              log.info(
                s.agentId.padEnd(15) +
                  String(s.beliefCount).padEnd(10) +
                  String(s.goalCount).padEnd(10) +
                  String(s.intentionCount).padEnd(12) +
                  String(s.desireCount).padEnd(10),
              );
            }
            log.info(`\nTotal: ${summaries.length} agents`);
          } catch (err) {
            log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
            log.info(`BDI cycle for ${agentId}:`);
            log.info(`  Intentions pruned: ${result.staleIntentionsPruned}`);
            log.info(`  Desires re-sorted: ${result.desiresPrioritized}`);
            log.info(`  Timestamp: ${result.timestamp}`);
          } catch (err) {
            log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
              log.info("No businesses found. Run 'mabos onboard' to create one.");
              return;
            }

            log.info("\nManaged Businesses\n" + "=".repeat(50));
            for (const entry of entries) {
              const s = await fsStat(join(businessDir, entry)).catch(() => null);
              if (s?.isDirectory()) {
                const manifest = join(businessDir, entry, "manifest.json");
                try {
                  const { readFile } = await import("node:fs/promises");
                  const data = JSON.parse(await readFile(manifest, "utf-8"));
                  log.info(`  ${data.name ?? entry} (${data.industry ?? "general"})`);
                } catch {
                  log.info(`  ${entry}`);
                }
              }
            }
          } catch (err) {
            log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        });

      // --- mabos migrate ---
      mabos
        .command("migrate")
        .description("Migrate data from ~/.openclaw to ~/.mabos")
        .option("--dry-run", "Preview changes without modifying files")
        .action(async (opts: { dryRun?: boolean }) => {
          try {
            const migratePath = "../../../mabos/scripts/migrate.js";
            const { migrate } = (await import(/* webpackIgnore: true */ migratePath)) as any;
            await migrate({ dryRun: opts.dryRun ?? false });
          } catch (err) {
            log.error(`Migration error: ${err instanceof Error ? err.message : String(err)}`);
          }
        });

      // --- mabos dashboard ---
      mabos
        .command("dashboard")
        .description("Open the MABOS web dashboard")
        .action(async () => {
          const port = api.config?.gateway?.port ?? 18789;
          const url = `http://localhost:${port}/mabos/dashboard`;
          log.info(`Opening dashboard: ${url}`);
          try {
            const { exec } = await import("node:child_process");
            const { platform } = await import("node:os");
            const cmd =
              platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
            exec(`${cmd} ${url}`);
          } catch {
            log.info(`Open manually: ${url}`);
          }
        });
    },
    { commands: ["mabos"] },
  );

  // ── 4. Dashboard HTTP Routes & API Endpoints ─────────────────────

  // Helper: sanitize path-based IDs to prevent traversal attacks
  function sanitizeId(id: string): string | null {
    if (!id || id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0"))
      return null;
    if (id.length > 128) return null;
    return id;
  }

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
    auth: "gateway",
    path: "/mabos/api/status",
    handler: async (_req, res) => {
      if (!(await requireAuth(_req, res))) return;
      try {
        const { getAgentsSummary } = (await import(
          /* webpackIgnore: true */ BDI_RUNTIME_PATH
        )) as import("./src/types/bdi-runtime.js").BdiRuntime;
        const agents = await getAgentsSummary(workspaceDir);

        const { readdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const businessDir = join(workspaceDir, "businesses");
        const businesses = await readdir(businessDir).catch(() => []);

        // Overlay TypeDB intention counts onto agent summaries
        try {
          const { queryAgentListFromTypeDB } = await import("./src/knowledge/typedb-dashboard.js");
          const typedbAgents = await queryAgentListFromTypeDB("mabos");
          if (typedbAgents && typedbAgents.length > 0) {
            const typedbMap = new Map(typedbAgents.map((a: any) => [a.id, a]));
            for (const agent of agents) {
              const tdb = typedbMap.get(agent.agentId);
              if (tdb) {
                agent.intentionCount = tdb.intentions;
              }
            }
          }
        } catch (err) {
          log.debug(`TypeDB agent overlay skipped: ${err}`);
        }

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
    auth: "gateway",
    path: "/mabos/api/decisions",
    handler: async (_req, res) => {
      if (!(await requireAuth(_req, res))) return;
      // Try TypeDB first
      try {
        const { queryDecisionsFromTypeDB } = await import("./src/knowledge/typedb-dashboard.js");
        const decisions = await queryDecisionsFromTypeDB("mabos");
        if (decisions && decisions.length > 0) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ decisions }));
          return;
        }
      } catch (err) {
        log.debug(`TypeDB decisions query skipped: ${err}`);
      }

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

  // Helper: register parameterized routes via registerHttpRoute with prefix matching
  // Collects handlers per static prefix to avoid duplicate registration errors
  const paramRouteHandlers = new Map<
    string,
    Array<{
      regex: RegExp;
      handler: (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
      ) => Promise<void>;
    }>
  >();
  const registeredPrefixes = new Set<string>();

  const registerParamRoute = (
    pattern: string,
    handler: (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => Promise<void>,
  ) => {
    const staticPrefix = pattern.replace(/\/:[^/]+.*$/, "");
    const prefix = staticPrefix || pattern;
    const regex = new RegExp("^" + pattern.replace(/:[^/]+/g, "[^/]+") + "$");

    if (!paramRouteHandlers.has(prefix)) {
      paramRouteHandlers.set(prefix, []);
    }
    paramRouteHandlers.get(prefix)!.push({ regex, handler });

    if (!registeredPrefixes.has(prefix)) {
      registeredPrefixes.add(prefix);
      api.registerHttpRoute({
        path: prefix,
        match: "prefix",
        auth: "gateway",
        handler: async (req, res) => {
          const url = new URL(req.url || "/", "http://localhost");
          const handlers = paramRouteHandlers.get(prefix) || [];
          for (const { regex: r, handler: h } of handlers) {
            if (r.test(url.pathname)) {
              if (!(await requireAuth(req, res))) return true;
              await h(req, res);
              return true;
            }
          }
          return false;
        },
      });
    }
  };

  // API: Resolve a decision
  registerParamRoute("/mabos/api/decisions/:id/resolve", async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { readFile, writeFile, mkdir } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");

      const params = await readMabosJsonBody<any>(req, res);
      if (!params) return;

      const bizId = sanitizeId(params.business_id);
      if (!bizId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business_id" }));
        return;
      }

      const queuePath = join(workspaceDir, "businesses", bizId, "decision-queue.json");
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
          bizId,
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
  });

  // API: Agent detail
  registerParamRoute("/mabos/api/agents/:id", async (req, res) => {
    try {
      const { join } = await import("node:path");
      const url = new URL(req.url || "", "http://localhost");
      const rawId = url.pathname.split("/").pop() || "";
      const agentId = sanitizeId(rawId);
      if (!agentId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid agent ID" }));
        return;
      }
      // Try TypeDB first
      try {
        const { queryAgentDetailFromTypeDB } = await import("./src/knowledge/typedb-dashboard.js");
        const detail = await queryAgentDetailFromTypeDB(agentId, `mabos`);
        if (detail) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(detail));
          return;
        }
      } catch (err) {
        log.debug(`TypeDB agent detail skipped: ${err}`);
      }

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
  });

  // API: Agent files — list .md files for an agent
  registerParamRoute("/mabos/api/agents/:id/files", async (req, res) => {
    try {
      const { join } = await import("node:path");
      const { readdir, stat: fsStat } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      const thisDir = join(fileURLToPath(import.meta.url), "..");
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const filesIdx = segments.indexOf("files");
      const rawId = filesIdx > 0 ? segments[filesIdx - 1] : "";
      const agentId = sanitizeId(rawId);
      if (!agentId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid agent ID" }));
        return;
      }

      const bdiDir = join(workspaceDir, "businesses", "vividwalls", "agents", agentId);
      const coreDir = join(workspaceDir, "agents", agentId);
      const templateDir = join(thisDir, "templates", "base", "agents", agentId);

      type AgentFile = {
        filename: string;
        category: "bdi" | "core" | "template";
        size: number;
        modified: string;
      };
      const files: AgentFile[] = [];
      const seen = new Set<string>();

      for (const [dir, cat] of [
        [bdiDir, "bdi"],
        [coreDir, "core"],
        [templateDir, "template"],
      ] as const) {
        try {
          const entries = await readdir(dir);
          for (const entry of entries) {
            if (!entry.endsWith(".md") || seen.has(entry)) continue;
            try {
              const s = await fsStat(join(dir, entry));
              files.push({
                filename: entry,
                category: cat,
                size: s.size,
                modified: s.mtime.toISOString(),
              });
              seen.add(entry);
            } catch {
              /* skip unreadable */
            }
          }
        } catch {
          /* dir doesn't exist */
        }
      }

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ files }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // API: Agent files — read or update a single file
  registerParamRoute("/mabos/api/agents/:id/files/:filename", async (req, res) => {
    try {
      const { join } = await import("node:path");
      const {
        stat: fsStat,
        readFile: fsReadFile,
        writeFile: fsWriteFile,
        mkdir,
      } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      const thisDir = join(fileURLToPath(import.meta.url), "..");
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const filesIdx = segments.indexOf("files");
      const rawId = filesIdx > 0 ? segments[filesIdx - 1] : "";
      const agentId = sanitizeId(rawId);
      const rawFilename = segments.slice(filesIdx + 1).join("/");
      const filename = decodeURIComponent(rawFilename);

      if (!agentId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid agent ID" }));
        return;
      }
      if (!filename.endsWith(".md") || filename.includes("..") || filename.includes("/")) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid filename" }));
        return;
      }

      const bdiDir = join(workspaceDir, "businesses", "vividwalls", "agents", agentId);
      const coreDir = join(workspaceDir, "agents", agentId);
      const templateDir = join(thisDir, "templates", "base", "agents", agentId);

      // Resolve which directory contains the file (BDI first, then core, then template)
      let filePath = join(bdiDir, filename);
      let category: "bdi" | "core" | "template" = "bdi";
      try {
        await fsStat(filePath);
      } catch {
        filePath = join(coreDir, filename);
        category = "core";
        try {
          await fsStat(filePath);
        } catch {
          filePath = join(templateDir, filename);
          category = "template";
          try {
            await fsStat(filePath);
          } catch {
            if (req.method !== "PUT") {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "File not found" }));
              return;
            }
            // For PUT, default to BDI dir
            filePath = join(bdiDir, filename);
            category = "bdi";
          }
        }
      }

      if (req.method === "PUT") {
        let body = "";
        for await (const chunk of req as any) body += chunk;
        const parsed = JSON.parse(body);
        if (typeof parsed.content !== "string") {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing content field" }));
          return;
        }
        await mkdir(join(bdiDir), { recursive: true });
        // Always write to BDI dir (never overwrite templates)
        const writePath = join(bdiDir, filename);
        await fsWriteFile(writePath, parsed.content, "utf-8");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // GET file content
      const content = await fsReadFile(filePath, "utf-8");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ filename, content, category }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // API: Agent knowledge stats
  registerParamRoute("/mabos/api/agents/:id/knowledge", async (req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      // agents/:id/knowledge → id is at index -2 from "knowledge"
      const knowledgeIdx = segments.indexOf("knowledge");
      const rawId = knowledgeIdx > 0 ? segments[knowledgeIdx - 1] : "";
      const agentId = sanitizeId(rawId);
      if (!agentId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid agent ID" }));
        return;
      }

      try {
        const { queryKnowledgeStatsFromTypeDB } =
          await import("./src/knowledge/typedb-dashboard.js");
        const stats = await queryKnowledgeStatsFromTypeDB(agentId, "mabos");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(stats ?? { facts: 0, rules: 0, memories: 0, cases: 0 }));
        return;
      } catch (err) {
        log.debug(`TypeDB knowledge stats skipped: ${err}`);
      }

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ facts: 0, rules: 0, memories: 0, cases: 0 }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // API: Business list
  api.registerHttpRoute({
    auth: "gateway",
    path: "/mabos/api/businesses",
    handler: async (_req, res) => {
      if (!(await requireAuth(_req, res))) return;
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
  registerParamRoute("/mabos/api/metrics/:business", async (req, res) => {
    try {
      const { join } = await import("node:path");
      const url = new URL(req.url || "", "http://localhost");
      const rawId = url.pathname.split("/").pop() || "";
      const businessId = sanitizeId(rawId);
      if (!businessId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business ID" }));
        return;
      }
      const metricsPath = join(workspaceDir, "businesses", businessId, "metrics.json");
      const metrics = await readJsonSafe(metricsPath);

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ business: businessId, metrics: metrics || {} }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // API: Contractors
  api.registerHttpRoute({
    auth: "gateway",
    path: "/mabos/api/contractors",
    handler: async (_req, res) => {
      if (!(await requireAuth(_req, res))) return;
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
    auth: "gateway",
    path: "/mabos/api/onboard",
    handler: async (req, res) => {
      if (!(await requireAuth(req, res))) return;
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

        const params = await readMabosJsonBody<any>(req, res);
        if (!params) return;

        if (!params.business_id || !params.name || !params.type) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing required fields: business_id, name, type" }));
          return;
        }

        // Validate business_id format
        if (
          typeof params.business_id !== "string" ||
          params.business_id.length > 64 ||
          !/^[a-zA-Z0-9_-]+$/.test(params.business_id)
        ) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error:
                "Invalid business_id: must be alphanumeric with hyphens/underscores, max 64 chars",
            }),
          );
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
          } catch (err) {
            log.debug(`SBVR sync skipped: ${err}`);
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
              contributions: [] as Array<{ from: string; to: string; type: string }>,
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

  // API: Chat — send message to an agent's inbox
  api.registerHttpRoute({
    auth: "gateway",
    path: "/mabos/api/chat",
    handler: async (req, res) => {
      if (!(await requireAuth(req, res))) return;
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      try {
        const { readFile, writeFile, mkdir } = await import("node:fs/promises");
        const { join, dirname } = await import("node:path");

        const params = await readMabosJsonBody<any>(req, res);
        if (!params) return;

        if (!params.agentId || !params.message || !params.businessId) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({ error: "Missing required fields: agentId, message, businessId" }),
          );
          return;
        }

        const agentId = sanitizeId(params.agentId);
        const businessId = sanitizeId(params.businessId);
        if (!agentId || !businessId) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid agent or business ID" }));
          return;
        }

        // Write message to agent's canonical inbox
        const inboxPath = join(workspaceDir, "agents", agentId, "inbox.json");
        let inbox: any[] = [];
        try {
          inbox = JSON.parse(await readFile(inboxPath, "utf-8"));
        } catch {
          /* empty inbox */
        }

        const pageContext = params.pageContext || null;
        const msg = {
          id: `CHAT-${Date.now()}`,
          from: "dashboard-user",
          to: agentId,
          performative: "QUERY",
          content: params.message,
          priority: "normal",
          timestamp: new Date().toISOString(),
          read: false,
          channel: "dashboard",
          pageContext,
        };

        inbox.push(msg);
        await mkdir(dirname(inboxPath), { recursive: true });
        await writeFile(inboxPath, JSON.stringify(inbox, null, 2), "utf-8");

        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            messageId: msg.id,
            message: `Message delivered to ${agentId}. The agent will process it during the next BDI cycle.`,
          }),
        );
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // Track connected SSE clients per agentId
  const sseClients = new Map<string, Set<import("node:http").ServerResponse>>();

  // API: Chat SSE — stream agent events to the dashboard
  api.registerHttpRoute({
    auth: "gateway",
    path: "/mabos/api/chat/events",
    handler: async (req, res) => {
      if (!(await requireAuth(req, res))) return;
      const { readFile, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const url = new URL(req.url || "", "http://localhost");
      const agentId = sanitizeId(url.searchParams.get("agentId") || "");
      const businessId = sanitizeId(url.searchParams.get("businessId") || "");

      if (!agentId || !businessId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing agentId or businessId" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send initial connection event
      res.write(`data: ${JSON.stringify({ type: "connected", agentId })}\n\n`);

      // Register this client
      const clientKey = `${businessId}:${agentId}`;
      if (!sseClients.has(clientKey)) {
        sseClients.set(clientKey, new Set());
      }
      sseClients.get(clientKey)!.add(res);

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        res.write(`: heartbeat\n\n`);
      }, 30000);

      let closed = false;

      // Subscribe to agent event bus — forward matching events to SSE
      const unsubscribe = onAgentEvent((evt: AgentEventPayload) => {
        if (closed) return;

        // Match events by sessionKey containing the agentId
        // SessionKey format: "{channel}:{accountId}:{chatId}"
        // Also match by checking if the event's data references this agent
        const matchesAgent =
          evt.sessionKey?.includes(agentId) || (evt.data as any)?.agentId === agentId;

        if (!matchesAgent) return;

        try {
          if (evt.stream === "assistant") {
            const text =
              typeof evt.data?.text === "string"
                ? evt.data.text
                : typeof evt.data?.delta === "string"
                  ? evt.data.delta
                  : null;
            if (text) {
              res.write(
                `data: ${JSON.stringify({
                  type: "stream_token",
                  token: text,
                  agentId,
                  agentName: agentId,
                  id: evt.runId,
                })}\n\n`,
              );
            }
          } else if (evt.stream === "lifecycle") {
            const phase = evt.data?.phase;
            if (phase === "end") {
              res.write(`data: ${JSON.stringify({ type: "stream_end", agentId })}\n\n`);
            } else if (phase === "error") {
              res.write(
                `data: ${JSON.stringify({
                  type: "agent_response",
                  agentId,
                  agentName: agentId,
                  content: `Error: ${evt.data?.error || "Unknown error"}`,
                  id: evt.runId,
                })}\n\n`,
              );
            }
          } else if (evt.stream === "tool") {
            // Forward MABOS tool events for transparency
            const toolName = evt.data?.name || evt.data?.toolName;
            if (toolName && String(toolName).startsWith("mabos_")) {
              res.write(
                `data: ${JSON.stringify({
                  type: "agent_response",
                  agentId,
                  agentName: agentId,
                  content: `[Using tool: ${toolName}]`,
                  id: evt.runId,
                })}\n\n`,
              );
            }
          }
        } catch (err) {
          log.debug(`SSE write failed (connection closing): ${err}`);
        }
      });

      // Also keep outbox polling as fallback for non-event-bus messages
      const outboxPath = join(
        workspaceDir,
        "businesses",
        businessId,
        "agents",
        agentId,
        "outbox.json",
      );
      const pollInterval = setInterval(async () => {
        if (closed) return;
        try {
          const raw = await readFile(outboxPath, "utf-8");
          const outbox: any[] = JSON.parse(raw);
          if (outbox.length > 0) {
            for (const entry of outbox) {
              if (entry.type === "thinking_status") {
                const event = {
                  type: "thinking_status",
                  status: entry.status || "thinking",
                  label: entry.label || entry.status || "Thinking",
                };
                res.write(`data: ${JSON.stringify(event)}\n\n`);
              } else {
                const event = {
                  type: entry.type || "agent_response",
                  id: entry.id || String(Date.now()),
                  agentId,
                  agentName: entry.agentName || agentId,
                  content: entry.content || "",
                  actions: entry.actions || [],
                };
                res.write(`data: ${JSON.stringify(event)}\n\n`);
              }
            }
            await writeFile(outboxPath, "[]", "utf-8");
          }
        } catch (err) {
          log.debug(`Outbox poll: ${err}`);
        }
      }, 2000);

      req.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
        clearInterval(pollInterval);
        unsubscribe();
        sseClients.get(clientKey)?.delete(res);
        if (sseClients.get(clientKey)?.size === 0) {
          sseClients.delete(clientKey);
        }
      });
    },
  });

  // API: Get goal model for a business
  registerParamRoute("/mabos/api/businesses/:id/goals", async (req, res) => {
    try {
      const { readFile, readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { existsSync } = await import("node:fs");

      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const bizIdx = segments.indexOf("businesses");
      const rawBizId = segments[bizIdx + 1] || "";
      const businessId = sanitizeId(rawBizId);
      if (!businessId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business ID" }));
        return;
      }
      const bizDir = join(workspaceDir, "businesses", businessId);

      if (req.method === "PUT") {
        // Update goal model
        const goalModel = await readMabosJsonBody<any>(req, res);
        if (!goalModel) return;
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
      // Try TypeDB first
      try {
        const { queryGoalModelFromTypeDB } = await import("./src/knowledge/typedb-dashboard.js");
        const model = await queryGoalModelFromTypeDB(`mabos`);
        if (model) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(model));
          return;
        }
      } catch (err) {
        log.debug(`TypeDB goal model skipped: ${err}`);
      }

      const troposPath = join(bizDir, "tropos-goal-model.json");
      let goalModel = await readJsonSafe(troposPath);

      if (!goalModel) {
        // Build from manifest + agent Goals.md
        const manifest = await readJsonSafe(join(bizDir, "manifest.json"));
        const goals: any[] = [];
        const actors: any[] = [{ id: "stakeholder", type: "principal", goals: [], x: 400, y: 50 }];

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
  });

  // API: Get tasks for a business (parsed from agent Plans.md)
  registerParamRoute("/mabos/api/businesses/:id/tasks", async (req, res) => {
    // Try TypeDB first
    try {
      const { queryTasksFromTypeDB } = await import("./src/knowledge/typedb-dashboard.js");
      const tasks = await queryTasksFromTypeDB("mabos");
      if (tasks && tasks.length > 0) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ tasks }));
        return;
      }
    } catch (err) {
      log.debug(`TypeDB tasks query skipped: ${err}`);
    }

    try {
      const { readFile, readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { existsSync } = await import("node:fs");

      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const bizIdx = segments.indexOf("businesses");
      const rawBizId = segments[bizIdx + 1] || "";
      const businessId = sanitizeId(rawBizId);
      if (!businessId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business ID" }));
        return;
      }
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
  });

  // API: Update task status
  registerParamRoute("/mabos/api/businesses/:id/tasks/:taskId", async (req, res) => {
    if (req.method !== "POST" && req.method !== "PUT") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { readFile, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const params = await readMabosJsonBody<any>(req, res);
      if (!params) return;

      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const bizIdx = segments.indexOf("businesses");
      const rawBizId = segments[bizIdx + 1] || "";
      const businessId = sanitizeId(rawBizId);
      if (!businessId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business ID" }));
        return;
      }
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
  });

  // API: Get/Create agents for a business
  registerParamRoute("/mabos/api/businesses/:id/agents", async (req, res) => {
    try {
      const {
        readFile,
        readdir,
        stat: fsStat,
        writeFile: wf,
        mkdir: mk,
      } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { existsSync } = await import("node:fs");

      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const bizIdx = segments.indexOf("businesses");
      const rawBizId = segments[bizIdx + 1] || "";
      const businessId = sanitizeId(rawBizId);
      if (!businessId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business ID" }));
        return;
      }
      const bizDir = join(workspaceDir, "businesses", businessId);
      const agentsDir = join(bizDir, "agents");

      // POST: Create a new agent
      if (req.method === "POST") {
        const params = await readMabosJsonBody<any>(req, res);
        if (!params) return;

        const newId = sanitizeId(params.id);
        if (!newId) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid agent ID" }));
          return;
        }

        const agentPath = join(agentsDir, newId);
        if (existsSync(agentPath)) {
          res.statusCode = 409;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: `Agent '${newId}' already exists` }));
          return;
        }

        const now = new Date().toISOString();
        await mk(agentPath, { recursive: true });

        // Create cognitive files
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
          await wf(
            join(agentPath, f),
            `# ${f.replace(".md", "")} — ${params.name || newId}\n\nInitialized: ${now.split("T")[0]}\n`,
            "utf-8",
          );
        }
        await wf(
          join(agentPath, "Persona.md"),
          `# Persona — ${params.name || newId}\n\n**Role:** ${params.name || newId}\n**Agent ID:** ${newId}\n**Type:** ${params.type || "domain"}\n`,
          "utf-8",
        );
        await wf(join(agentPath, "inbox.json"), "[]", "utf-8");
        await wf(join(agentPath, "cases.json"), "[]", "utf-8");

        // Write config
        const config = {
          status: "active",
          autonomy_level: params.autonomy_level || "medium",
          approval_threshold_usd: params.approval_threshold_usd || 100,
          created_at: now,
        };
        await wf(join(agentPath, "config.json"), JSON.stringify(config, null, 2), "utf-8");

        // Update manifest
        const manifest = (await readJsonSafe(join(bizDir, "manifest.json"))) || {};
        if (params.type === "core") {
          manifest.agents = [...(manifest.agents || []), newId];
        } else {
          manifest.domain_agents = [...(manifest.domain_agents || []), newId];
        }
        await wf(join(bizDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, agentId: newId }));
        return;
      }

      // GET: List agents
      // Build from filesystem first (all agents), then overlay TypeDB BDI counts
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
            return content.split("\n").filter((l: string) => l.trim() && !l.startsWith("#")).length;
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

      // Overlay TypeDB BDI counts (richer data for agents in knowledge graph)
      try {
        const { queryAgentListFromTypeDB } = await import("./src/knowledge/typedb-dashboard.js");
        const typedbAgents = await queryAgentListFromTypeDB(`mabos`);
        if (typedbAgents && typedbAgents.length > 0) {
          const typedbMap = new Map(typedbAgents.map((a: any) => [a.id, a]));
          for (const agent of agents) {
            const tdb = typedbMap.get(agent.id);
            if (tdb) {
              agent.name = tdb.name;
              agent.beliefs = tdb.beliefs;
              agent.goals = tdb.goals;
              agent.intentions = tdb.intentions;
              agent.desires = tdb.desires;
            }
          }
        }
      } catch (err) {
        log.debug(`TypeDB agent overlay skipped: ${err}`);
      }

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ agents }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // API: Archive an agent
  registerParamRoute("/mabos/api/businesses/:id/agents/:agentId/archive", async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { rename, writeFile, mkdir } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");
      const { existsSync } = await import("node:fs");

      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const bizIdx = segments.indexOf("businesses");
      const rawBizId = segments[bizIdx + 1] || "";
      const businessId = sanitizeId(rawBizId);
      // agentId is before "archive"
      const archiveIdx = segments.indexOf("archive");
      const rawAgentId = archiveIdx > 0 ? segments[archiveIdx - 1] : "";
      const agentId = sanitizeId(rawAgentId);

      if (!businessId || !agentId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business or agent ID" }));
        return;
      }

      const bizDir = join(workspaceDir, "businesses", businessId);
      const agentDir = join(bizDir, "agents", agentId);
      const archivedDir = join(bizDir, "agents", `_archived_${agentId}`);

      if (!existsSync(agentDir)) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: `Agent '${agentId}' not found` }));
        return;
      }

      await rename(agentDir, archivedDir);

      // Update manifest
      const manifest = (await readJsonSafe(join(bizDir, "manifest.json"))) || {};
      manifest.agents = (manifest.agents || []).filter((a: string) => a !== agentId);
      manifest.domain_agents = (manifest.domain_agents || []).filter((a: string) => a !== agentId);
      await writeFile(join(bizDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, archived: agentId }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // API: Trigger manual BDI cycle
  api.registerHttpRoute({
    auth: "gateway",
    path: "/mabos/api/bdi/cycle",
    handler: async (req, res) => {
      if (!(await requireAuth(req, res))) return;
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      try {
        const params = await readMabosJsonBody<any>(req, res);
        if (!params) return;

        const agentId = sanitizeId(params.agentId);
        if (!agentId) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid agent ID" }));
          return;
        }

        const { join } = await import("node:path");
        const { readAgentCognitiveState, runMaintenanceCycle } = (await import(
          /* webpackIgnore: true */ BDI_RUNTIME_PATH
        )) as any;
        const agentDir = join(workspaceDir, "agents", agentId);
        const state = await readAgentCognitiveState(agentDir, agentId);
        const result = await runMaintenanceCycle(state);

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, agentId, result }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // API: Update agent config
  registerParamRoute("/mabos/api/businesses/:id/agents/:agentId", async (req, res) => {
    if (req.method !== "PUT" && req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { readFile, writeFile, mkdir } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");

      const params = await readMabosJsonBody<any>(req, res);
      if (!params) return;

      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const bizIdx = segments.indexOf("businesses");
      const rawBizId = segments[bizIdx + 1] || "";
      const businessId = sanitizeId(rawBizId);
      const rawAgentId = segments[segments.length - 1] || "";
      const agentId = sanitizeId(rawAgentId);
      if (!businessId || !agentId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business or agent ID" }));
        return;
      }
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
  });

  // API: Cron jobs for a business
  registerParamRoute("/mabos/api/businesses/:id/cron", async (req, res) => {
    try {
      const { readFile, writeFile, mkdir } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");

      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const bizIdx = segments.indexOf("businesses");
      const rawBizId = segments[bizIdx + 1] || "";
      const businessId = sanitizeId(rawBizId);
      if (!businessId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business ID" }));
        return;
      }
      const bizDir = join(workspaceDir, "businesses", businessId);
      const cronPath = join(bizDir, "cron-jobs.json");

      if (req.method === "POST") {
        const params = await readMabosJsonBody<any>(req, res);
        if (!params) return;

        const jobs = (await readJsonSafe(cronPath)) || [];
        const newJob: Record<string, unknown> = {
          id: `CRON-${Date.now()}`,
          name: params.name || "Unnamed Job",
          schedule: params.schedule || "0 */6 * * *",
          agentId: params.agentId || "",
          action: params.action || "",
          enabled: params.enabled !== false,
          status: "active",
          createdAt: new Date().toISOString(),
        };
        if (params.workflowId) newJob.workflowId = params.workflowId;
        if (params.stepId) newJob.stepId = params.stepId;
        jobs.push(newJob);
        await mkdir(dirname(cronPath), { recursive: true });
        await writeFile(cronPath, JSON.stringify(jobs, null, 2), "utf-8");

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, job: newJob }));
        return;
      }

      // GET: List cron jobs
      let jobs = await readJsonSafe(cronPath);
      if (!jobs || !Array.isArray(jobs)) {
        // Seed default cron jobs
        jobs = [
          {
            id: "CRON-heartbeat",
            name: "BDI Heartbeat Cycle",
            schedule: `*/${bdiIntervalMinutes} * * * *`,
            agentId: "system",
            action: "bdi_cycle",
            enabled: true,
            status: "active",
            lastRun: new Date().toISOString(),
            nextRun: new Date(Date.now() + bdiIntervalMinutes * 60 * 1000).toISOString(),
          },
          {
            id: "CRON-knowledge",
            name: "Knowledge Consolidation",
            schedule: "0 2 * * *",
            agentId: "vw-knowledge",
            action: "memory_consolidate",
            enabled: true,
            status: "active",
          },
          {
            id: "CRON-decisions",
            name: "Decision Queue Review",
            schedule: "0 */6 * * *",
            agentId: "vw-ceo",
            action: "decision_review",
            enabled: true,
            status: "active",
          },
        ];
        await mkdir(dirname(cronPath), { recursive: true });
        await writeFile(cronPath, JSON.stringify(jobs, null, 2), "utf-8");
      }

      // Update heartbeat job with actual last/next run times
      const heartbeatJob = jobs.find((j: any) => j.id === "CRON-heartbeat");
      if (heartbeatJob) {
        heartbeatJob.lastRun = new Date().toISOString();
        heartbeatJob.nextRun = new Date(Date.now() + bdiIntervalMinutes * 60 * 1000).toISOString();
      }

      // Filter by workflowId if query param provided
      const filterWorkflowId = url.searchParams.get("workflowId");
      const filteredJobs = filterWorkflowId
        ? jobs.filter((j: any) => j.workflowId === filterWorkflowId)
        : jobs;

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jobs: filteredJobs }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // API: Update/toggle a cron job
  registerParamRoute("/mabos/api/businesses/:id/cron/:jobId", async (req, res) => {
    if (req.method !== "PUT" && req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { readFile, writeFile, mkdir } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");

      const params = await readMabosJsonBody<any>(req, res);
      if (!params) return;

      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const bizIdx = segments.indexOf("businesses");
      const rawBizId = segments[bizIdx + 1] || "";
      const businessId = sanitizeId(rawBizId);
      const jobId = segments[segments.length - 1] || "";
      if (!businessId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business ID" }));
        return;
      }

      const cronPath = join(workspaceDir, "businesses", businessId, "cron-jobs.json");
      const jobs = (await readJsonSafe(cronPath)) || [];
      const idx = jobs.findIndex((j: any) => j.id === jobId);
      if (idx === -1) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Cron job not found" }));
        return;
      }

      if (params.enabled !== undefined) jobs[idx].enabled = params.enabled;
      if (params.schedule !== undefined) jobs[idx].schedule = params.schedule;
      if (params.name !== undefined) jobs[idx].name = params.name;
      if (params.status !== undefined) jobs[idx].status = params.status;
      jobs[idx].updatedAt = new Date().toISOString();

      await mkdir(dirname(cronPath), { recursive: true });
      await writeFile(cronPath, JSON.stringify(jobs, null, 2), "utf-8");

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, job: jobs[idx] }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // API: Get campaigns for a business
  registerParamRoute("/mabos/api/businesses/:id/campaigns", async (req, res) => {
    try {
      const { join } = await import("node:path");

      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const bizIdx = segments.indexOf("businesses");
      const rawBizId = segments[bizIdx + 1] || "";
      const businessId = sanitizeId(rawBizId);
      if (!businessId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid business ID" }));
        return;
      }
      const marketingPath = join(workspaceDir, "businesses", businessId, "marketing.json");
      const marketing = await readJsonSafe(marketingPath);

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ campaigns: marketing?.campaigns || [] }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // Dashboard: serve SPA HTML (no trailing slash)
  api.registerHttpRoute({
    auth: "gateway",
    path: "/mabos/dashboard",
    handler: async (_req, res) => {
      try {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const thisDir = join(fileURLToPath(import.meta.url), "..");
        const htmlPath = join(thisDir, "ui", "dist", "index.html");
        const html = await readFile(htmlPath, "utf-8");
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      } catch {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!DOCTYPE html><html><head><title>MABOS</title></head><body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;padding:40px"><h1 style="color:#58a6ff">MABOS Dashboard</h1><p>Dashboard files not found. Run <code>cd extensions/mabos/ui && npm run build</code> first.</p></body></html>`,
        );
      }
    },
  });

  // Dashboard: wildcard static file server for all dashboard assets + SPA fallback
  api.registerHttpRoute({
    auth: "gateway",
    path: "/mabos/dashboard/*",
    handler: async (req, res) => {
      try {
        const { readFile } = await import("node:fs/promises");
        const path = await import("node:path");
        const { join, extname } = path;
        const { fileURLToPath } = await import("node:url");
        const thisDir = join(fileURLToPath(import.meta.url), "..");

        const url = new URL(req.url || "", "http://localhost");
        const filePath = url.pathname.replace("/mabos/dashboard/", "");

        if (!filePath) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        const contentTypes: Record<string, string> = {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "application/javascript",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
          ".ttf": "font/ttf",
        };

        const ext = extname(filePath).toLowerCase();

        const fullPath = join(thisDir, "ui", "dist", filePath);
        const baseDir = path.resolve(join(thisDir, "ui", "dist"));

        const resolved = path.resolve(fullPath);

        // Block directory traversal via resolved path comparison
        if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        // If no file extension or unknown extension, serve index.html for SPA routing
        if (!ext || !contentTypes[ext]) {
          const htmlPath = join(thisDir, "ui", "dist", "index.html");
          try {
            const html = await readFile(htmlPath, "utf-8");
            res.setHeader("Content-Type", "text/html");
            res.end(html);
            return;
          } catch {
            // Fall through to 404
          }
        }

        const contentType = contentTypes[ext] || "application/octet-stream";
        const content = await readFile(fullPath);
        res.setHeader("Content-Type", contentType);
        res.end(content);
      } catch {
        // SPA fallback: serve index.html for any non-file route
        try {
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const { fileURLToPath } = await import("node:url");
          const thisDir = join(fileURLToPath(import.meta.url), "..");
          const htmlPath = join(thisDir, "ui", "dist", "index.html");
          const html = await readFile(htmlPath, "utf-8");
          res.setHeader("Content-Type", "text/html");
          res.end(html);
        } catch {
          res.statusCode = 404;
          res.end("Not found");
        }
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

  // ── BPMN 2.0 Workflow API ────────────────────────────────────

  const BPMN_DB = "mabos";

  // GET /mabos/api/workflows — list all BPMN workflows
  api.registerHttpRoute({
    auth: "gateway",
    path: "/mabos/api/workflows",
    handler: async (req, res) => {
      if (!(await requireAuth(req, res))) return;
      try {
        const { getTypeDBClient } = await import("./src/knowledge/typedb-client.js");
        const { BpmnStoreQueries } = await import("./src/knowledge/bpmn-queries.js");
        const client = getTypeDBClient();
        const url = new URL(req.url || "/", "http://localhost");
        const status = url.searchParams.get("status") || undefined;
        const agentId = url.searchParams.get("agentId") || "vw-ceo";

        if (req.method === "POST") {
          // Create workflow
          const body = await readMabosJsonBody<any>(req, res);
          if (!body) return;
          const id = body.id || `bpmn-wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const typeql = BpmnStoreQueries.createWorkflow(body.agentId || agentId, {
            id,
            name: body.name || "Untitled Workflow",
            status: body.status || "pending",
            description: body.description,
            version: body.version,
          });
          await client.insertData(typeql, BPMN_DB);

          // Link to goal if provided
          if (body.goalId) {
            const linkTypeql = BpmnStoreQueries.linkWorkflowToGoal(id, body.goalId);
            await client.insertData(linkTypeql, BPMN_DB).catch(() => {});
          }

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, id }));
          return;
        }

        // GET — list workflows
        const typeql = BpmnStoreQueries.queryWorkflows(agentId, { status });
        const results = await client.matchQuery(typeql, BPMN_DB);
        const workflows = Array.isArray(results)
          ? results.map((r: any) => ({
              id: r.wfid?.value ?? r.wfid,
              name: r.wn?.value ?? r.wn,
              status: r.ws?.value ?? r.ws,
              createdAt: r.wc?.value ?? r.wc,
              updatedAt: r.wu?.value ?? r.wu,
            }))
          : [];
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ workflows }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // GET/PUT/DELETE /mabos/api/workflows/:id
  registerParamRoute("/mabos/api/workflows/:id", async (req, res) => {
    try {
      const { getTypeDBClient } = await import("./src/knowledge/typedb-client.js");
      const { BpmnStoreQueries } = await import("./src/knowledge/bpmn-queries.js");
      const client = getTypeDBClient();
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const id = sanitizeId(segments[segments.length - 1]);
      if (!id) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid workflow ID" }));
        return;
      }

      if (req.method === "DELETE") {
        await client.deleteData(BpmnStoreQueries.deleteWorkflow(id), BPMN_DB);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "PUT") {
        const body = await readMabosJsonBody<any>(req, res);
        if (!body) return;
        const typeql = BpmnStoreQueries.updateWorkflow(id, {
          name: body.name,
          status: body.status,
          description: body.description,
        });
        await client.insertData(typeql, BPMN_DB);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // GET — full workflow with elements, flows, pools, lanes
      const wfResult = await client.matchQuery(BpmnStoreQueries.queryWorkflow(id), BPMN_DB);
      if (!wfResult || (Array.isArray(wfResult) && wfResult.length === 0)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Workflow not found" }));
        return;
      }
      const wf = Array.isArray(wfResult) ? wfResult[0] : wfResult;

      // Fetch elements
      let elements: any[] = [];
      try {
        const elResult = await client.matchQuery(BpmnStoreQueries.queryElements(id), BPMN_DB);
        elements = Array.isArray(elResult)
          ? elResult.map((r: any) => ({
              id: r.eid?.value ?? r.eid,
              type: r.etype?.value ?? r.etype,
              position: { x: r.px?.value ?? r.px ?? 0, y: r.py?.value ?? r.py ?? 0 },
              size: { w: r.sw?.value ?? r.sw ?? 160, h: r.sh?.value ?? r.sh ?? 80 },
            }))
          : [];
      } catch {
        /* no elements yet */
      }

      // Fetch flows
      let flows: any[] = [];
      try {
        const flResult = await client.matchQuery(BpmnStoreQueries.queryFlows(id), BPMN_DB);
        flows = Array.isArray(flResult)
          ? flResult.map((r: any) => ({
              id: r.fid?.value ?? r.fid,
              type: r.ft?.value ?? r.ft,
              sourceId: r.sid?.value ?? r.sid,
              targetId: r.tid?.value ?? r.tid,
            }))
          : [];
      } catch {
        /* no flows yet */
      }

      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id,
          name: wf.wn?.value ?? wf.wn,
          status: wf.ws?.value ?? wf.ws,
          elements,
          flows,
          pools: [],
          lanes: [],
        }),
      );
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // POST /mabos/api/workflows/:id/elements — add element
  registerParamRoute("/mabos/api/workflows/:id/elements", async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { getTypeDBClient } = await import("./src/knowledge/typedb-client.js");
      const { BpmnStoreQueries } = await import("./src/knowledge/bpmn-queries.js");
      const client = getTypeDBClient();
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const workflowId = sanitizeId(segments[segments.length - 2]);
      if (!workflowId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid workflow ID" }));
        return;
      }

      const body = await readMabosJsonBody<any>(req, res);
      if (!body) return;
      const agentId = body.agentId || "vw-ceo";
      const elementId =
        body.id || `bpmn-el-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const typeql = BpmnStoreQueries.addElement(agentId, workflowId, {
        id: elementId,
        name: body.name,
        element_type: body.type || body.element_type || "task",
        pos_x: body.position?.x ?? body.pos_x ?? 0,
        pos_y: body.position?.y ?? body.pos_y ?? 0,
        size_w: body.size?.w ?? body.size_w,
        size_h: body.size?.h ?? body.size_h,
        event_position: body.eventPosition ?? body.event_position,
        event_trigger: body.eventTrigger ?? body.event_trigger,
        event_catching: body.eventCatching ?? body.event_catching,
        task_type_bpmn: body.taskType ?? body.task_type_bpmn,
        loop_type: body.loopType ?? body.loop_type,
        gateway_type: body.gatewayType ?? body.gateway_type,
        subprocess_type: body.subProcessType ?? body.subprocess_type,
        assignee_agent_id: body.assignee ?? body.assignee_agent_id,
        action_tool: body.action ?? body.action_tool,
        lane_id: body.laneId ?? body.lane_id,
        documentation: body.documentation,
      });
      await client.insertData(typeql, BPMN_DB);

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, id: elementId }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // PUT /mabos/api/workflows/:id/elements/:eid — update element
  registerParamRoute("/mabos/api/workflows/:id/elements/:eid", async (req, res) => {
    try {
      const { getTypeDBClient } = await import("./src/knowledge/typedb-client.js");
      const { BpmnStoreQueries } = await import("./src/knowledge/bpmn-queries.js");
      const client = getTypeDBClient();
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const elementId = sanitizeId(segments[segments.length - 1]);
      if (!elementId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid element ID" }));
        return;
      }

      if (req.method === "DELETE") {
        await client.deleteData(BpmnStoreQueries.deleteElement(elementId), BPMN_DB);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "PATCH" || req.method === "PUT") {
        const body = await readMabosJsonBody<any>(req, res);
        if (!body) return;

        // Position-only update
        if (body.position && Object.keys(body).length <= 2) {
          const typeql = BpmnStoreQueries.updateElementPosition(
            elementId,
            body.position.x,
            body.position.y,
          );
          await client.insertData(typeql, BPMN_DB);
        } else {
          // Full field update
          const fields: Record<string, string | number | boolean> = {};
          if (body.name !== undefined) fields.name = body.name;
          if (body.element_type !== undefined) fields.element_type = body.element_type;
          if (body.task_type_bpmn !== undefined) fields.task_type_bpmn = body.task_type_bpmn;
          if (body.gateway_type !== undefined) fields.gateway_type = body.gateway_type;
          if (body.documentation !== undefined) fields.documentation = body.documentation;
          if (Object.keys(fields).length > 0) {
            const typeql = BpmnStoreQueries.updateElement(elementId, fields);
            await client.insertData(typeql, BPMN_DB);
          }
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.statusCode = 405;
      res.end(JSON.stringify({ error: "Method not allowed" }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // POST /mabos/api/workflows/:id/flows — create flow
  registerParamRoute("/mabos/api/workflows/:id/flows", async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { getTypeDBClient } = await import("./src/knowledge/typedb-client.js");
      const { BpmnStoreQueries } = await import("./src/knowledge/bpmn-queries.js");
      const client = getTypeDBClient();
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const workflowId = sanitizeId(segments[segments.length - 2]);
      if (!workflowId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid workflow ID" }));
        return;
      }

      const body = await readMabosJsonBody<any>(req, res);
      if (!body) return;
      const agentId = body.agentId || "vw-ceo";
      const flowId = body.id || `bpmn-fl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const typeql = BpmnStoreQueries.addFlow(agentId, workflowId, {
        id: flowId,
        flow_type: body.type || body.flow_type || "sequence",
        source_id: body.sourceId || body.source_id,
        target_id: body.targetId || body.target_id,
        name: body.name,
        condition_expr: body.conditionExpression || body.condition_expr,
        is_default: body.isDefault ?? body.is_default,
      });
      await client.insertData(typeql, BPMN_DB);

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, id: flowId }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // DELETE /mabos/api/workflows/:id/flows/:fid
  registerParamRoute("/mabos/api/workflows/:id/flows/:fid", async (req, res) => {
    if (req.method !== "DELETE") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { getTypeDBClient } = await import("./src/knowledge/typedb-client.js");
      const { BpmnStoreQueries } = await import("./src/knowledge/bpmn-queries.js");
      const client = getTypeDBClient();
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const flowId = sanitizeId(segments[segments.length - 1]);
      if (!flowId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid flow ID" }));
        return;
      }
      await client.deleteData(BpmnStoreQueries.deleteFlow(flowId), BPMN_DB);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // POST /mabos/api/workflows/:id/pools — add pool
  registerParamRoute("/mabos/api/workflows/:id/pools", async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { getTypeDBClient } = await import("./src/knowledge/typedb-client.js");
      const { BpmnStoreQueries } = await import("./src/knowledge/bpmn-queries.js");
      const client = getTypeDBClient();
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const workflowId = sanitizeId(segments[segments.length - 2]);
      if (!workflowId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid workflow ID" }));
        return;
      }

      const body = await readMabosJsonBody<any>(req, res);
      if (!body) return;
      const agentId = body.agentId || "vw-ceo";
      const poolId = body.id || `bpmn-pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const typeql = BpmnStoreQueries.addPool(agentId, workflowId, {
        id: poolId,
        name: body.name || "Pool",
        participant_ref: body.participantRef,
        is_black_box: body.isBlackBox,
      });
      await client.insertData(typeql, BPMN_DB);

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, id: poolId }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // POST /mabos/api/workflows/:id/lanes — add lane
  registerParamRoute("/mabos/api/workflows/:id/lanes", async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { getTypeDBClient } = await import("./src/knowledge/typedb-client.js");
      const { BpmnStoreQueries } = await import("./src/knowledge/bpmn-queries.js");
      const client = getTypeDBClient();
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const workflowId = sanitizeId(segments[segments.length - 2]);
      if (!workflowId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid workflow ID" }));
        return;
      }

      const body = await readMabosJsonBody<any>(req, res);
      if (!body) return;
      const agentId = body.agentId || "vw-ceo";
      const laneId = body.id || `bpmn-lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const typeql = BpmnStoreQueries.addLane(agentId, body.poolId, {
        id: laneId,
        name: body.name || "Lane",
        assignee_agent_id: body.assignee,
      });
      await client.insertData(typeql, BPMN_DB);

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, id: laneId }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // POST /mabos/api/workflows/:id/validate — BPMN validation
  registerParamRoute("/mabos/api/workflows/:id/validate", async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const { getTypeDBClient } = await import("./src/knowledge/typedb-client.js");
      const { BpmnStoreQueries } = await import("./src/knowledge/bpmn-queries.js");
      const client = getTypeDBClient();
      const url = new URL(req.url || "", "http://localhost");
      const segments = url.pathname.split("/");
      const workflowId = sanitizeId(segments[segments.length - 2]);
      if (!workflowId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid workflow ID" }));
        return;
      }

      const errors: { elementId: string; message: string; severity: string }[] = [];

      // Check orphan nodes
      try {
        const orphanResult = await client.matchQuery(
          BpmnStoreQueries.queryOrphanNodes(workflowId),
          BPMN_DB,
        );
        if (Array.isArray(orphanResult)) {
          for (const r of orphanResult) {
            const eid = r.eid?.value ?? r.eid;
            const etype = r.etype?.value ?? r.etype;
            if (etype !== "startEvent" && etype !== "endEvent") {
              errors.push({
                elementId: eid,
                message: `Element "${eid}" has no connections`,
                severity: "warning",
              });
            }
          }
        }
      } catch {
        /* skip orphan check */
      }

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ valid: errors.length === 0, errors }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // ── 6. Agent Lifecycle Hooks ──────────────────────────────────

  const cfg = getPluginConfig(api);

  // Inject BDI context + Persona.md + cognitive context + auto-recall into system prompt
  api.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.workspaceDir) return undefined;

    const agentDir = ctx.workspaceDir;
    const agentId = ctx.agentId ?? "unknown";

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

      // ── Cognitive context injection (beliefs, desires, plans, knowledge) ──
      if (cfg.cognitiveContextEnabled !== false) {
        try {
          const { assembleCognitiveContext } = await import("./src/tools/cognitive-context.js");
          const { cognitiveExtras, longTermHighlights } = await assembleCognitiveContext(agentDir);
          if (cognitiveExtras) {
            parts.push(`## Cognitive State\n${cognitiveExtras}`);
          }
          if (longTermHighlights) {
            parts.push(`## Long-Term Memory Highlights\n${longTermHighlights}`);
          }
        } catch (err) {
          log.debug(`[mabos] Cognitive context skipped: ${err}`);
        }
      }

      // ── Auto-recall relevant memories for this session ──
      if (cfg.autoRecallEnabled !== false) {
        try {
          const { semanticRecall } = await import("./src/tools/memory-tools.js");
          // Use the agent's Persona + Goals as the recall query
          const recallQuery = parts.slice(0, 2).join(" ").slice(0, 500);
          if (recallQuery.trim()) {
            const results = await semanticRecall(api, agentId, recallQuery, 5);
            if (results && results.length > 0) {
              const recallBlock = results
                .map((r) => `- [${(r.score * 100).toFixed(0)}%] ${r.content}`)
                .join("\n");
              parts.push(`## Recalled Memories\n${recallBlock}`);
            }
          }
        } catch (err) {
          log.debug(`[mabos] Auto-recall skipped: ${err}`);
        }
      }

      // ── Observation log summary (recent critical/important observations) ──
      if (cfg.preCompactionObserverEnabled !== false) {
        try {
          const { loadObservationLog } = await import("./src/tools/observation-store.js");
          const { formatObservationLog } = await import("./src/tools/observer.js");
          const obsLog = await loadObservationLog(api, agentId);
          if (obsLog.observations.length > 0) {
            // Include only critical/important observations, most recent 10
            const relevant = obsLog.observations
              .filter((o) => o.priority === "critical" || o.priority === "important")
              .slice(-10);
            if (relevant.length > 0) {
              parts.push(`## Recent Observations\n${formatObservationLog(relevant)}`);
            }
          }
        } catch (err) {
          log.debug(`[mabos] Observation log injection skipped: ${err}`);
        }
      }

      // ── Inbox context injection (pending messages) ──
      if (cfg.inboxContextEnabled !== false) {
        try {
          const inboxPath = join(agentDir, "inbox.json");
          const inboxRaw = await readFile(inboxPath, "utf-8").catch(() => "[]");
          const inbox: Array<{
            id: string;
            from: string;
            performative: string;
            priority: string;
            content: string;
            timestamp: string;
            read: boolean;
          }> = JSON.parse(inboxRaw);

          const unread = inbox.filter((m) => !m.read);
          if (unread.length > 0) {
            // Sort by priority: urgent > high > normal > low
            const priorityOrder: Record<string, number> = {
              urgent: 0,
              high: 1,
              normal: 2,
              low: 3,
            };
            unread.sort(
              (a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2),
            );

            const top = unread.slice(0, 10);
            const lines = top.map(
              (m) =>
                `- **${m.id}** from ${m.from} [${m.performative}] (${m.priority}): ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""} _${m.timestamp}_`,
            );
            const summary = `${unread.length} unread message(s)${unread.length > 10 ? ` (showing top 10)` : ""}\n\n${lines.join("\n")}`;
            parts.push(`## Pending Inbox Messages\n${summary}`);
          }
        } catch (err) {
          log.debug(`[mabos] Inbox context injection skipped: ${err}`);
        }
      }

      if (parts.length > 0) {
        return {
          prependContext: `[MABOS Agent Context]\n${parts.join("\n\n")}\n`,
        };
      }
    } catch (err) {
      log.debug(`Agent context injection skipped: ${err}`);
    }
    return undefined;
  });

  // ── Pre-compaction Observer: compress messages into observations ──
  api.on("before_compaction", async (event, ctx) => {
    if (cfg.preCompactionObserverEnabled === false) return;
    if (!event.messages || !Array.isArray(event.messages) || event.messages.length === 0) return;

    const agentId = ctx.agentId ?? "unknown";

    try {
      const { compressMessagesToObservations } = await import("./src/tools/observer.js");
      const { loadObservationLog, saveObservationLog } =
        await import("./src/tools/observation-store.js");

      // Load existing observation log
      const obsLog = await loadObservationLog(api, agentId);

      // Convert event messages to ObservableMessage format
      const observableMessages = (event.messages as any[]).map((m) => ({
        role: m.role ?? "unknown",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        name: m.name,
        timestamp: m.timestamp ?? new Date().toISOString(),
      }));

      // Run Observer compression
      const result = compressMessagesToObservations(observableMessages, obsLog.observations);

      if (result.observations.length > 0) {
        obsLog.observations = result.observations;
        obsLog.total_messages_compressed += result.messagesCompressed;
        obsLog.total_tool_calls_compressed += result.toolCallsCompressed;
        obsLog.last_observer_run_at = new Date().toISOString();

        await saveObservationLog(api, agentId, obsLog);
        log.info(
          `[mabos] Observer compressed ${result.messagesCompressed} messages into ${result.observations.length} observations for ${agentId}`,
        );
      }
    } catch (err) {
      log.debug(`[mabos] Pre-compaction observer failed: ${err}`);
    }
  });

  // ── Agent end: final observation checkpoint ──
  api.on("agent_end", async (event, ctx) => {
    if (cfg.preCompactionObserverEnabled === false) return;
    if (!event.messages || !Array.isArray(event.messages) || event.messages.length === 0) return;

    const agentId = ctx.agentId ?? "unknown";

    try {
      const { compressMessagesToObservations } = await import("./src/tools/observer.js");
      const { loadObservationLog, saveObservationLog } =
        await import("./src/tools/observation-store.js");

      const obsLog = await loadObservationLog(api, agentId);

      const observableMessages = (event.messages as any[]).map((m) => ({
        role: m.role ?? "unknown",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        name: m.name,
        timestamp: m.timestamp ?? new Date().toISOString(),
      }));

      const result = compressMessagesToObservations(observableMessages, obsLog.observations);

      if (result.messagesCompressed > 0) {
        obsLog.observations = result.observations;
        obsLog.total_messages_compressed += result.messagesCompressed;
        obsLog.total_tool_calls_compressed += result.toolCallsCompressed;
        obsLog.last_observer_run_at = new Date().toISOString();

        await saveObservationLog(api, agentId, obsLog);
        log.info(
          `[mabos] Agent end checkpoint: ${result.messagesCompressed} messages → ${result.observations.length} observations for ${agentId}`,
        );
      }
    } catch (err) {
      log.debug(`[mabos] Agent end observation checkpoint failed: ${err}`);
    }
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
