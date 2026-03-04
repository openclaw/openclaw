import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { AgentEventSqliteStore } from "../core/agent-event-sqlite-store.js";
import type { StrategyRegistry } from "../strategy/strategy-registry.js";
import type { HttpReq, HttpRes } from "../types-http.js";
import { parseJsonBody, jsonResponse, errorResponse } from "../types-http.js";
import { STRATEGY_PACKS, getStrategyPack } from "./strategy-packs.js";

export interface PackRouteDeps {
  strategyRegistry: StrategyRegistry;
  eventStore: AgentEventSqliteStore;
}

export function registerPackRoutes(api: OpenClawPluginApi, deps: PackRouteDeps): void {
  const { strategyRegistry, eventStore } = deps;

  // GET /api/v1/finance/strategy-packs — list available packs
  api.registerHttpRoute({
    path: "/api/v1/finance/strategy-packs",
    handler: async (_req: unknown, res: unknown) => {
      const httpRes = res as HttpRes;
      const packs = STRATEGY_PACKS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        category: p.category,
        strategyCount: p.strategies.length,
        strategies: p.strategies.map((s) => ({ id: s.id, name: s.name, symbols: s.symbols })),
      }));
      jsonResponse(httpRes, 200, { packs });
    },
  });

  // POST /api/v1/finance/strategy-packs/deploy — deploy a pack
  api.registerHttpRoute({
    path: "/api/v1/finance/strategy-packs/deploy",
    handler: async (req: unknown, res: unknown) => {
      const httpReq = req as HttpReq;
      const httpRes = res as HttpRes;

      let body: Record<string, unknown>;
      try {
        body = await parseJsonBody(httpReq);
      } catch {
        return errorResponse(httpRes, 400, "Invalid JSON body");
      }

      const packId = body.packId as string | undefined;
      if (!packId) {
        return errorResponse(httpRes, 400, "Missing packId");
      }

      const pack = getStrategyPack(packId);
      if (!pack) {
        return errorResponse(httpRes, 404, `Pack "${packId}" not found`);
      }

      const deployed: string[] = [];
      const skipped: string[] = [];

      for (const def of pack.strategies) {
        if (strategyRegistry.get(def.id)) {
          skipped.push(def.id);
          continue;
        }
        strategyRegistry.create(def);
        strategyRegistry.updateLevel(def.id, "L1_BACKTEST");
        deployed.push(def.id);
      }

      eventStore.addEvent({
        type: "system",
        title: `Pack deployed: ${pack.name}`,
        detail: `Deployed: ${deployed.length}, Skipped (already exist): ${skipped.length}. Use fin_backtest_run to backtest new strategies.`,
        status: "completed",
      });

      jsonResponse(httpRes, 200, { deployed, skipped, packId });
    },
  });
}
