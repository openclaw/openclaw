/**
 * fin-evolution-engine — Plugin entry point.
 *
 * Registers evolution services, HTTP API routes, SSE stream, and dashboard.
 * All data flows through EvolutionStore (SQLite) and RDAVD orchestrator.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { EvolutionStore } from "./src/evolution-store.ts";
import { createLlmMutator } from "./src/llm-mutator.ts";
import {
  runRdavdCycle,
  type BacktestEngineLike,
  type PaperEngineLike,
  type RegimeDetectorLike,
  type DataProviderLike,
  type RdavdDeps,
} from "./src/rdavd.ts";
import type {
  EvolutionNode,
  EvolutionStatsResponse,
  EvolutionDashboardData,
} from "./src/schemas.ts";
import { MutateRequestSchema, KillRequestSchema, PromoteRequestSchema } from "./src/schemas.ts";

// ─── HTTP helper types ────────────────────────────────────────────────

type HttpReq = {
  on: (event: string, cb: (data?: Buffer) => void) => void;
  method?: string;
  url?: string;
};

type HttpRes = {
  writeHead: (statusCode: number, headers: Record<string, string>) => void;
  write: (chunk: string) => boolean;
  end: (body?: string) => void;
};

function parseJsonBody(req: HttpReq): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      if (chunk) chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", () => reject(new Error("Request error")));
  });
}

function jsonResponse(res: HttpRes, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function errorResponse(res: HttpRes, status: number, message: string): void {
  jsonResponse(res, status, { error: message });
}

// ─── Tool response helper ──────────────────────────────────────────────

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

// ─── Plugin ────────────────────────────────────────────────────────────

const plugin = {
  id: "fin-evolution-engine",
  name: "Evolution Engine",
  description:
    "Self-evolving strategy engine — RDAVD cycle, mutation risk gates, constitution enforcer, evolution tree",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const dbPath = api.resolvePath("state/fin-evolution.sqlite");
    const store = new EvolutionStore(dbPath);

    // Register service for cross-extension use
    api.registerService({
      id: "fin-evolution-engine",
      instance: { store, runRdavdCycle },
      start() {},
    } as Parameters<typeof api.registerService>[0]);

    // ── Data gathering helpers ──

    function gatherStats(): EvolutionStatsResponse {
      const allNodes = store.getAllNodes();
      const activeNodes = store.getActiveNodes();
      const extinctCount = allNodes.length - activeNodes.length;
      const byLevel = store.getNodeCountByLevel();
      const byTier = store.getNodeCountByTier();
      const mutations = store.getTotalMutations();

      const bestNode = activeNodes.length > 0 ? activeNodes[0] : undefined; // sorted by fitness DESC
      const avgFitness =
        activeNodes.length > 0
          ? activeNodes.reduce((s, n) => s + n.fitness, 0) / activeNodes.length
          : 0;

      // Count unique strategy IDs
      const strategyIds = new Set(allNodes.map((n) => n.strategyId));
      const activeStrategyIds = new Set(activeNodes.map((n) => n.strategyId));

      return {
        totalStrategies: strategyIds.size,
        activeStrategies: activeStrategyIds.size,
        extinctStrategies: strategyIds.size - activeStrategyIds.size,
        survivalRate: strategyIds.size > 0 ? activeStrategyIds.size / strategyIds.size : 0,
        avgFitness: Math.round(avgFitness * 1000) / 1000,
        bestFitness: bestNode?.fitness ?? 0,
        bestStrategyId: bestNode?.strategyId,
        bestStrategyName: bestNode?.strategyName,
        totalMutations: mutations.total,
        successfulMutations: mutations.successful,
        mutationSuccessRate:
          mutations.total > 0
            ? Math.round((mutations.successful / mutations.total) * 1000) / 1000
            : 0,
        byLevel: {
          L0: byLevel.L0 ?? 0,
          L1: byLevel.L1 ?? 0,
          L2: byLevel.L2 ?? 0,
          L3: byLevel.L3 ?? 0,
        },
        bySurvivalTier: {
          thriving: byTier.thriving ?? 0,
          healthy: byTier.healthy ?? 0,
          stressed: byTier.stressed ?? 0,
          critical: byTier.critical ?? 0,
          stopped: byTier.stopped ?? 0,
        },
      };
    }

    type EdgeType = "mutation" | "crossover" | "promotion" | "demotion";

    function buildEdges(
      nodes: EvolutionNode[],
    ): Array<{ from: string; to: string; type: EdgeType }> {
      const edges: Array<{ from: string; to: string; type: EdgeType }> = [];
      for (const node of nodes) {
        if (node.parentId) {
          const edgeType: EdgeType = node.mutationType ? "mutation" : "promotion";
          edges.push({ from: node.parentId, to: node.id, type: edgeType });
        }
        if (node.crossoverParentIds) {
          for (const pid of node.crossoverParentIds) {
            edges.push({ from: pid, to: node.id, type: "crossover" });
          }
        }
      }
      return edges;
    }

    function gatherDashboardData(): EvolutionDashboardData & {
      strategies: unknown[];
      events: unknown[];
    } {
      const stats = gatherStats();
      const nodes = store.getAllNodes();
      const edges = buildEdges(nodes);
      const recentAudit = store.getAuditLog({ limit: 20 });

      // ── Strategy-lab compatible view ──
      const levelMap: Record<string, number> = {
        L0_INCUBATE: 0,
        L1_BACKTEST: 1,
        L2_PAPER: 2,
        L3_LIVE: 3,
        KILLED: -1,
      };
      const latestByStrategy = new Map<string, (typeof nodes)[0]>();
      for (const n of nodes) {
        const existing = latestByStrategy.get(n.strategyId);
        if (!existing || n.generation > existing.generation) {
          latestByStrategy.set(n.strategyId, n);
        }
      }
      const strategies = [...latestByStrategy.values()].map((n) => ({
        id: n.strategyId,
        name: n.strategyName,
        level: levelMap[n.level] ?? 0,
        fitness: n.fitness,
        sharpe: n.backtestSharpe ?? n.paperSharpe ?? 0,
        maxDrawdown: n.maxDrawdown ?? 0,
        winRate: n.winRate ?? 0,
        totalTrades: n.totalTrades ?? 0,
        status: n.extinctAt ? "killed" : (n.status ?? "active"),
        generation: n.generation,
        mutationCount: nodes.filter((x) => x.strategyId === n.strategyId && x.mutationType).length,
      }));

      const events = recentAudit.map((a) => ({
        type: a.type,
        strategyId: a.strategyId,
        strategyName: a.strategyName,
        detail: a.detail,
        timestamp: a.createdAt,
      }));

      return { stats, tree: { nodes, edges }, recentAudit, strategies, events };
    }

    // ── RDAVD dependency resolver ──

    const runtime = api.runtime as unknown as { services?: Map<string, unknown> };
    const llmMutator = createLlmMutator();

    function makeRdavdDeps(): RdavdDeps {
      const backtestEngine = runtime.services?.get?.("fin-backtest-engine") as
        | BacktestEngineLike
        | undefined;
      const paperEngine = runtime.services?.get?.("fin-paper-engine") as
        | PaperEngineLike
        | undefined;
      const regimeDetector = runtime.services?.get?.("fin-regime-detector") as
        | RegimeDetectorLike
        | undefined;
      const dataProvider = runtime.services?.get?.("fin-data-provider") as
        | DataProviderLike
        | undefined;
      const registry = runtime.services?.get?.("fin-strategy-registry") as
        | import("./src/rdavd.ts").StrategyRegistryLike
        | undefined;
      return {
        store,
        registry,
        backtestEngine,
        llmMutator,
        paperEngine,
        regimeDetector,
        dataProvider,
      };
    }

    // ── AI Tool: fin_evolve_trigger ──

    api.registerTool(
      {
        name: "fin_evolve_trigger",
        label: "Trigger Evolution",
        description:
          "Trigger an RDAVD evolution cycle for a strategy. Runs Diagnose → Adapt → Validate → Distill with LLM assistance (or rule-based fallback). Returns the cycle outcome, new generation node, and distill insights.",
        parameters: Type.Object({
          strategyId: Type.String({ description: "Strategy ID to evolve" }),
          trigger: Type.Unsafe<"decay" | "regime_change" | "scheduled" | "manual">({
            type: "string",
            enum: ["decay", "regime_change", "scheduled", "manual"],
            description: "What triggered this evolution cycle",
          }),
          mutationType: Type.Optional(
            Type.Unsafe<
              "parameter-tune" | "signal-change" | "risk-adjustment" | "architecture-change"
            >({
              type: "string",
              enum: ["parameter-tune", "signal-change", "risk-adjustment", "architecture-change"],
              description: "Force a specific mutation type (auto-selected if omitted)",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const strategyId = params.strategyId as string;
            const trigger = (params.trigger as string) || "manual";
            const mutationType = params.mutationType as string | undefined;

            const deps = makeRdavdDeps();
            const result = await runRdavdCycle(
              strategyId,
              trigger as "decay" | "regime_change" | "scheduled" | "manual",
              deps,
              mutationType
                ? {
                    mutationType: mutationType as
                      | "parameter-tune"
                      | "signal-change"
                      | "risk-adjustment"
                      | "architecture-change",
                  }
                : undefined,
            );

            return json({
              outcome: result.cycle.outcome,
              cycleId: result.cycle.id,
              trigger: result.cycle.trigger,
              newNodeId: result.newNode?.id,
              newGeneration: result.newNode?.generation,
              newFitness: result.newNode?.fitness,
              mutationType: result.newNode?.mutationType,
              diagnoseRootCause: result.cycle.diagnoseResult?.rootCause,
              distillResult: result.cycle.distillResult,
              riskGatePassed: result.cycle.riskGateResult?.allPassed,
              constitutionPassed: result.cycle.constitutionVerdict?.passed,
              llmAvailable: llmMutator.isLlmAvailable,
            });
          } catch (err) {
            return json({ error: (err as Error).message });
          }
        },
      },
      { names: ["fin_evolve_trigger"] },
    );

    // ── AI Tool: fin_evolve_status ──

    api.registerTool(
      {
        name: "fin_evolve_status",
        label: "Evolution Status",
        description:
          "Get evolution engine statistics: strategy counts, fitness metrics, mutation success rate, survival tiers, and LLM availability.",
        parameters: Type.Object({
          strategyId: Type.Optional(
            Type.String({ description: "Optional: get detailed status for a specific strategy" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const strategyId = params.strategyId as string | undefined;

            if (strategyId) {
              // Detailed strategy status
              const history = store.getNodesByStrategy(strategyId);
              if (history.length === 0) {
                return json({ error: `Strategy ${strategyId} not found` });
              }

              const currentNode = history[history.length - 1];
              const recentCycles = store.getRecentCycles(strategyId, 5);
              const auditLog = store.getAuditLog({ strategyId, limit: 10 });

              return json({
                strategyId,
                strategyName: currentNode.strategyName,
                generation: currentNode.generation,
                fitness: currentNode.fitness,
                survivalTier: currentNode.survivalTier,
                level: currentNode.level,
                geneCount: currentNode.genes.length,
                recentCycles: recentCycles.map((c) => ({
                  id: c.id,
                  trigger: c.trigger,
                  outcome: c.outcome,
                  distillResult: c.distillResult,
                })),
                recentAudit: auditLog.map((a) => ({
                  type: a.type,
                  detail: a.detail,
                  createdAt: a.createdAt,
                })),
                llmAvailable: llmMutator.isLlmAvailable,
              });
            }

            // Global stats
            const stats = gatherStats();
            return json({
              ...stats,
              llmAvailable: llmMutator.isLlmAvailable,
              llmModel: llmMutator.isLlmAvailable
                ? process.env.OPENFINCLAW_EVOLUTION_MODEL?.trim() || "gpt-4o-mini"
                : null,
            });
          } catch (err) {
            return json({ error: (err as Error).message });
          }
        },
      },
      { names: ["fin_evolve_status"] },
    );

    // ── REST: GET /api/v1/finance/evolution/stats ──

    api.registerHttpRoute({
      path: "/api/v1/finance/evolution/stats",
      handler: async (_req: HttpReq, res: HttpRes) => {
        jsonResponse(res, 200, gatherStats());
      },
    });

    // ── REST: GET /api/v1/finance/evolution/tree ──

    api.registerHttpRoute({
      path: "/api/v1/finance/evolution/tree",
      handler: async (_req: HttpReq, res: HttpRes) => {
        const nodes = store.getAllNodes();
        const edges = buildEdges(nodes);
        const stats = gatherStats();
        jsonResponse(res, 200, { nodes, edges, stats });
      },
    });

    // ── REST: GET /api/v1/finance/evolution/strategy (query ?id=) ──

    api.registerHttpRoute({
      path: "/api/v1/finance/evolution/strategy",
      handler: async (req: HttpReq, res: HttpRes) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const strategyId = url.searchParams.get("id");
        if (!strategyId) {
          errorResponse(res, 400, "Missing required query parameter: id");
          return;
        }

        const history = store.getNodesByStrategy(strategyId);
        if (history.length === 0) {
          errorResponse(res, 404, `Strategy ${strategyId} not found`);
          return;
        }

        const currentNode = history[history.length - 1];
        const recentCycles = store.getRecentCycles(strategyId, 10);
        const auditLog = store.getAuditLog({ strategyId, limit: 20 });

        jsonResponse(res, 200, {
          strategyId,
          strategyName: currentNode.strategyName,
          currentNode,
          history,
          recentCycles,
          auditLog,
        });
      },
    });

    // ── REST: GET /api/v1/finance/evolution/audit ──

    api.registerHttpRoute({
      path: "/api/v1/finance/evolution/audit",
      handler: async (req: HttpReq, res: HttpRes) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const strategyId = url.searchParams.get("strategyId") ?? undefined;
        const type = url.searchParams.get("type") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? 50);

        const log = store.getAuditLog({
          strategyId,
          type: type as Parameters<typeof store.getAuditLog>[0] extends { type?: infer T }
            ? T
            : never,
          limit,
        });
        jsonResponse(res, 200, { audit: log, total: log.length });
      },
    });

    // ── REST: POST /api/v1/finance/evolution/mutate ──

    api.registerHttpRoute({
      path: "/api/v1/finance/evolution/mutate",
      handler: async (req: HttpReq, res: HttpRes) => {
        try {
          const body = await parseJsonBody(req);
          const parsed = MutateRequestSchema.safeParse(body);
          if (!parsed.success) {
            errorResponse(res, 400, `Validation error: ${parsed.error.message}`);
            return;
          }

          const { strategyId, mutationType, reason } = parsed.data;
          const deps = makeRdavdDeps();
          const result = await runRdavdCycle(strategyId, reason ? "manual" : "manual", deps, {
            mutationType,
          });

          jsonResponse(res, 200, {
            success: result.cycle.outcome === "mutated",
            newNodeId: result.newNode?.id,
            riskGateResult: result.cycle.riskGateResult,
            constitutionVerdict: result.cycle.constitutionVerdict,
            error: result.cycle.outcome === "rejected" ? "Mutation rejected" : undefined,
          });
        } catch (err) {
          errorResponse(res, 500, (err as Error).message);
        }
      },
    });

    // ── REST: POST /api/v1/finance/evolution/promote ──

    api.registerHttpRoute({
      path: "/api/v1/finance/evolution/promote",
      handler: async (req: HttpReq, res: HttpRes) => {
        try {
          const body = await parseJsonBody(req);
          const parsed = PromoteRequestSchema.safeParse(body);
          if (!parsed.success) {
            errorResponse(res, 400, `Validation error: ${parsed.error.message}`);
            return;
          }

          const { strategyId, targetLevel } = parsed.data;
          const currentNode = store.getLatestGeneration(strategyId);
          if (!currentNode) {
            errorResponse(res, 404, `Strategy ${strategyId} not found`);
            return;
          }

          // Create a promoted node (new generation with same genes but higher level)
          const newNode: EvolutionNode = {
            ...currentNode,
            id: `evo-${strategyId}-gen${currentNode.generation + 1}`,
            generation: currentNode.generation + 1,
            parentId: currentNode.id,
            level: targetLevel,
            mutationReason: `Promoted from ${currentNode.level} to ${targetLevel}`,
            createdAt: new Date().toISOString(),
          };
          store.saveNode(newNode);

          store.logAudit({
            id: `audit-${Date.now().toString(36)}`,
            type: "PROMOTION",
            strategyId,
            strategyName: currentNode.strategyName,
            detail: `Promoted ${currentNode.level} → ${targetLevel}`,
            triggeredBy: "manual",
            metadata: { fromLevel: currentNode.level, toLevel: targetLevel },
            createdAt: new Date().toISOString(),
          });

          jsonResponse(res, 200, {
            from: currentNode.level,
            to: targetLevel,
            newNodeId: newNode.id,
          });
        } catch (err) {
          errorResponse(res, 500, (err as Error).message);
        }
      },
    });

    // ── REST: POST /api/v1/finance/evolution/kill ──

    api.registerHttpRoute({
      path: "/api/v1/finance/evolution/kill",
      handler: async (req: HttpReq, res: HttpRes) => {
        try {
          const body = await parseJsonBody(req);
          const parsed = KillRequestSchema.safeParse(body);
          if (!parsed.success) {
            errorResponse(res, 400, `Validation error: ${parsed.error.message}`);
            return;
          }

          const { strategyId, reason } = parsed.data;
          const currentNode = store.getLatestGeneration(strategyId);
          if (!currentNode) {
            errorResponse(res, 404, `Strategy ${strategyId} not found`);
            return;
          }

          const now = new Date().toISOString();
          store.markExtinct(currentNode.id, now);

          store.logAudit({
            id: `audit-${Date.now().toString(36)}`,
            type: "EXTINCTION",
            strategyId,
            strategyName: currentNode.strategyName,
            detail: reason ?? `Strategy ${strategyId} killed manually`,
            triggeredBy: "manual",
            createdAt: now,
          });

          jsonResponse(res, 200, { killed: true, nodeId: currentNode.id });
        } catch (err) {
          errorResponse(res, 500, (err as Error).message);
        }
      },
    });

    // ── SSE: GET /api/v1/finance/evolution/stream ──

    api.registerHttpRoute({
      path: "/api/v1/finance/evolution/stream",
      handler: async (req: { on: (event: string, cb: () => void) => void }, res: HttpRes) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(gatherDashboardData())}\n\n`);
        const interval = setInterval(() => {
          res.write(`data: ${JSON.stringify(gatherDashboardData())}\n\n`);
        }, 10000);
        req.on("close", () => clearInterval(interval));
      },
    });

    // ── Dashboard: GET /dashboard/evolution ──

    api.registerHttpRoute({
      path: "/dashboard/evolution",
      handler: async (_req: HttpReq, res: HttpRes) => {
        const data = gatherDashboardData();

        try {
          const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "dashboard");
          const template = readFileSync(join(dashboardDir, "evolution-dashboard.html"), "utf-8");
          const css = readFileSync(join(dashboardDir, "evolution-dashboard.css"), "utf-8");
          const safeJson = JSON.stringify(data).replace(/<\//g, "<\\/");
          const html = template
            .replace("/*__EVO_CSS__*/", css)
            .replace(/\/\*__EVO_DATA__\*\/\s*\{\}/, safeJson);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch {
          // Fallback: return JSON if template not found
          jsonResponse(res, 200, data);
        }
      },
    });
  },
};

export default plugin;
