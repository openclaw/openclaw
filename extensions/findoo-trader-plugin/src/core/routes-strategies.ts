/**
 * Strategy management HTTP route handlers (list, pause, resume, kill, promote).
 */

import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { createStrategySchema } from "../schemas.js";
import type { HttpReq, HttpRes, RuntimeServices, StrategyRegistryLike } from "../types-http.js";
import { parseJsonBody, jsonResponse, errorResponse } from "../types-http.js";
import type { StrategyTemplate } from "../types.js";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";
import { STRATEGY_TEMPLATES } from "./strategy-templates.js";

export function registerStrategyRoutes(
  api: OpenClawPluginApi,
  runtime: RuntimeServices,
  eventStore: AgentEventSqliteStore,
): void {
  // GET /api/v1/finance/strategies -- List all strategies
  api.registerHttpRoute({
    path: "/api/v1/finance/strategies",
    handler: async (_req: unknown, res: HttpRes) => {
      const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
        | StrategyRegistryLike
        | undefined;
      if (!strategyRegistry) {
        jsonResponse(res, 200, { strategies: [] });
        return;
      }
      jsonResponse(res, 200, { strategies: strategyRegistry.list() });
    },
  });

  // POST /api/v1/finance/strategies/pause -- Pause a strategy
  api.registerHttpRoute({
    path: "/api/v1/finance/strategies/pause",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { id } = body as { id?: string };

        if (!id) {
          errorResponse(res, 400, "Missing required field: id");
          return;
        }

        const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
          | StrategyRegistryLike
          | undefined;
        if (!strategyRegistry?.updateStatus) {
          errorResponse(res, 503, "Strategy registry not available");
          return;
        }

        const strategy = strategyRegistry.get?.(id);
        if (!strategy) {
          errorResponse(res, 404, `Strategy ${id} not found`);
          return;
        }

        strategyRegistry.updateStatus(id, "paused");

        eventStore.addEvent({
          type: "system",
          title: `Strategy paused: ${strategy.name}`,
          detail: `${strategy.name} (${strategy.level}) paused by user`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "paused", id });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // POST /api/v1/finance/strategies/resume -- Resume a paused strategy
  api.registerHttpRoute({
    path: "/api/v1/finance/strategies/resume",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { id } = body as { id?: string };

        if (!id) {
          errorResponse(res, 400, "Missing required field: id");
          return;
        }

        const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
          | StrategyRegistryLike
          | undefined;
        if (!strategyRegistry?.updateStatus) {
          errorResponse(res, 503, "Strategy registry not available");
          return;
        }

        strategyRegistry.updateStatus(id, "running");
        jsonResponse(res, 200, { status: "running", id });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // POST /api/v1/finance/strategies/kill -- Kill a strategy
  api.registerHttpRoute({
    path: "/api/v1/finance/strategies/kill",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { id } = body as { id?: string };

        if (!id) {
          errorResponse(res, 400, "Missing required field: id");
          return;
        }

        const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
          | StrategyRegistryLike
          | undefined;
        if (!strategyRegistry?.updateLevel) {
          errorResponse(res, 503, "Strategy registry not available");
          return;
        }

        const strategy = strategyRegistry.get?.(id);
        if (!strategy) {
          errorResponse(res, 404, `Strategy ${id} not found`);
          return;
        }

        strategyRegistry.updateLevel(id, "KILLED");
        strategyRegistry.updateStatus?.(id, "stopped");

        eventStore.addEvent({
          type: "strategy_killed",
          title: `Strategy killed: ${strategy.name}`,
          detail: `${strategy.name} permanently killed by user`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "killed", id });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // POST /api/v1/finance/strategies/promote -- Promote a strategy to next level
  api.registerHttpRoute({
    path: "/api/v1/finance/strategies/promote",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const { id, targetLevel } = body as { id?: string; targetLevel?: string };

        if (!id) {
          errorResponse(res, 400, "Missing required field: id");
          return;
        }

        const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
          | StrategyRegistryLike
          | undefined;
        if (!strategyRegistry?.updateLevel) {
          errorResponse(res, 503, "Strategy registry not available");
          return;
        }

        const strategy = strategyRegistry.get?.(id);
        if (!strategy) {
          errorResponse(res, 404, `Strategy ${id} not found`);
          return;
        }

        // Determine next level if not specified
        const levelOrder = ["L0_INCUBATE", "L1_BACKTEST", "L2_PAPER", "L3_LIVE"];
        const currentIdx = levelOrder.indexOf(strategy.level);
        const nextLevel =
          targetLevel ??
          (currentIdx >= 0 && currentIdx < levelOrder.length - 1
            ? levelOrder[currentIdx + 1]
            : undefined);

        if (!nextLevel) {
          errorResponse(res, 400, `Strategy ${id} is already at highest level or level is invalid`);
          return;
        }

        // L3 requires approval — real money trading must be explicitly confirmed
        if (nextLevel === "L3_LIVE") {
          eventStore.addEvent({
            type: "trade_pending",
            title: `Promote ${strategy.name} → L3_LIVE (approval required)`,
            detail: `Strategy ${strategy.name} promotion from ${strategy.level} to L3_LIVE requires human confirmation`,
            status: "pending",
            actionParams: { action: "promote_l3", strategyId: id, from: strategy.level },
          });
          jsonResponse(res, 202, { status: "pending_approval", id, targetLevel: "L3_LIVE" });
          return;
        }

        strategyRegistry.updateLevel(id, nextLevel);

        eventStore.addEvent({
          type: "strategy_promoted",
          title: `${strategy.name} → ${nextLevel}`,
          detail: `Strategy promoted from ${strategy.level} to ${nextLevel}`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "promoted", id, from: strategy.level, to: nextLevel });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // POST /api/v1/finance/strategies/pause-all -- Pause all active strategies
  api.registerHttpRoute({
    path: "/api/v1/finance/strategies/pause-all",
    handler: async (_req: unknown, res: HttpRes) => {
      try {
        const registry = runtime.services?.get?.("fin-strategy-registry") as
          | StrategyRegistryLike
          | undefined;
        if (!registry?.updateStatus) {
          errorResponse(res, 503, "Strategy registry not available");
          return;
        }

        const all = registry.list();
        let paused = 0;
        for (const s of all) {
          if (s.status !== "paused" && s.status !== "stopped") {
            registry.updateStatus(s.id, "paused");
            paused++;
          }
        }

        eventStore.addEvent({
          type: "system",
          title: `All strategies paused (${paused})`,
          detail: `${paused} strategies paused by user`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "paused_all", count: paused });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // POST /api/v1/finance/strategies/backtest-all -- Run backtests for all strategies
  api.registerHttpRoute({
    path: "/api/v1/finance/strategies/backtest-all",
    handler: async (_req: HttpReq, res: HttpRes) => {
      try {
        const registry = runtime.services?.get?.("fin-strategy-registry") as
          | StrategyRegistryLike
          | undefined;
        if (!registry) {
          errorResponse(res, 503, "Strategy registry not available");
          return;
        }

        const remoteService = runtime.services?.get?.("fin-remote-backtest") as
          | import("../strategy/remote-backtest-bridge.js").RemoteBacktestService
          | undefined;
        if (!remoteService) {
          errorResponse(
            res,
            503,
            "Remote backtest service not available. Load findoo-backtest-plugin.",
          );
          return;
        }

        const { RemoteBacktestBridge: BridgeClass } =
          await import("../strategy/remote-backtest-bridge.js");
        const bridge = new BridgeClass(() => remoteService);

        const strategies = registry.list();
        const results: Array<{
          id: string;
          name: string;
          success: boolean;
          error?: string;
          result?: Record<string, unknown>;
        }> = [];

        for (const s of strategies) {
          try {
            const detail = registry.get?.(s.id);
            const definition = (
              detail as { definition?: import("../shared/types.js").StrategyDefinition } | undefined
            )?.definition;
            if (!definition) {
              results.push({ id: s.id, name: s.name, success: false, error: "No definition" });
              continue;
            }
            const result = await bridge.runBacktest(definition, {
              capital: 10_000,
              commissionRate: 0.001,
              slippageBps: 5,
              market: "crypto",
            });
            registry.updateBacktest?.(s.id, result as unknown as Record<string, unknown>);
            results.push({
              id: s.id,
              name: s.name,
              success: true,
              result: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            results.push({ id: s.id, name: s.name, success: false, error: (err as Error).message });
          }
        }

        eventStore.addEvent({
          type: "system",
          title: `Batch backtest completed (${results.filter((r) => r.success).length}/${results.length})`,
          detail: `${results.length} strategies backtested`,
          status: "completed",
        });

        jsonResponse(res, 200, { status: "completed", results });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });

  // GET /api/v1/finance/strategy-templates -- List built-in strategy templates
  api.registerHttpRoute({
    path: "/api/v1/finance/strategy-templates",
    handler: async (_req: unknown, res: HttpRes) => {
      jsonResponse(res, 200, { templates: STRATEGY_TEMPLATES });
    },
  });

  // POST /api/v1/finance/strategies/create -- Create L0 strategy from template
  api.registerHttpRoute({
    path: "/api/v1/finance/strategies/create",
    handler: async (req: HttpReq, res: HttpRes) => {
      try {
        const body = await parseJsonBody(req);
        const parsed = createStrategySchema.safeParse(body);
        if (!parsed.success) {
          errorResponse(res, 400, parsed.error.issues.map((i) => i.message).join("; "));
          return;
        }

        const { templateId, name, symbol, timeframe, exchangeId, parameters } = parsed.data;

        // Validate template exists
        const template = STRATEGY_TEMPLATES.find((t: StrategyTemplate) => t.id === templateId);
        if (!template) {
          errorResponse(
            res,
            400,
            `Unknown template: ${templateId}. Use GET /api/v1/finance/strategy-templates to see available templates.`,
          );
          return;
        }

        const strategyRegistry = runtime.services?.get?.("fin-strategy-registry") as
          | StrategyRegistryLike
          | undefined;
        if (!strategyRegistry) {
          errorResponse(res, 503, "Strategy registry not available");
          return;
        }

        // Build a StrategyDefinition-compatible object for the registry
        const strategyId = `${templateId}-${Date.now().toString(36)}`;
        const definition = {
          id: strategyId,
          name,
          version: "1.0.0",
          markets: template.supportedMarkets as string[],
          symbols: [symbol],
          timeframes: [timeframe],
          parameters: Object.fromEntries(
            Object.entries(parameters).filter(([, v]) => typeof v === "number"),
          ) as Record<string, number>,
          templateId,
          exchangeId,
        };

        // Use the registry's create method via the service interface
        const registryInstance = runtime.services?.get?.("fin-strategy-registry") as
          | { create?: (def: Record<string, unknown>) => Record<string, unknown> }
          | undefined;
        let record: Record<string, unknown>;
        if (registryInstance?.create) {
          record = registryInstance.create(definition as unknown as Record<string, unknown>);
        } else {
          // Fallback: return the definition as-is
          record = {
            ...definition,
            level: "L0_INCUBATE",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        }

        eventStore.addEvent({
          type: "system",
          title: `Strategy created: ${name}`,
          detail: `${name} (${templateId}) on ${symbol} ${timeframe} — starts at L0_INCUBATE`,
          status: "completed",
        });

        jsonResponse(res, 201, { strategy: record });
      } catch (err) {
        errorResponse(res, 500, (err as Error).message);
      }
    },
  });
}
