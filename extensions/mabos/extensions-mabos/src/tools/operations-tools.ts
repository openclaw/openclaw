/**
 * Operations Domain Tools (COO)
 *
 * Fills gaps: supply chain tracking, vendor scoring, SLA tracking,
 * capacity planning, and inventory management.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir, generatePrefixedId } from "./common.js";

async function readJson(p: string): Promise<any> {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

async function writeJson(p: string, d: any): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

// ── Parameters ───────────────────────────────────────────────

const SupplyChainParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID (e.g., 'coo')" }),
  supplier: Type.Optional(Type.String({ description: "Filter by supplier name" })),
});

const VendorScoreParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  vendor: Type.String({ description: "Vendor name" }),
  quality_score: Type.Number({ description: "Quality score 0-100" }),
  delivery_score: Type.Number({ description: "Delivery reliability score 0-100" }),
  cost_score: Type.Number({ description: "Cost competitiveness score 0-100" }),
  notes: Type.Optional(Type.String({ description: "Additional notes" })),
});

const SlaTrackParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  service: Type.String({ description: "Service or process name" }),
  target_value: Type.Number({ description: "SLA target value" }),
  actual_value: Type.Number({ description: "Actual measured value" }),
  unit: Type.String({ description: "Unit (e.g., 'hours', 'percent', 'days')" }),
});

const CapacityPlanParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  resource: Type.String({ description: "Resource type (e.g., 'fulfillment', 'customer_service')" }),
  current_utilization_pct: Type.Number({ description: "Current utilization %" }),
  projected_demand_pct: Type.Number({ description: "Projected demand increase %" }),
  period: Type.String({ description: "Planning period (e.g., '2026-Q2')" }),
});

const InventoryParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  category: Type.Optional(Type.String({ description: "Inventory category filter" })),
});

// ── Factory ──────────────────────────────────────────────────

export function createOperationsTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const ws = resolveWorkspaceDir(api);

  return [
    {
      name: "supply_chain_status",
      label: "Supply Chain Status",
      description:
        "View current supply chain status including supplier performance, lead times, and pending orders.",
      parameters: SupplyChainParams,
      async execute(_id: string, params: Static<typeof SupplyChainParams>) {
        const dir = join(ws, "agents", params.agent_id, "operations");
        const path = join(dir, "supply-chain.json");
        const data = (await readJson(path)) ?? {
          suppliers: [],
          pending_orders: 0,
          avg_lead_time_days: 0,
        };

        const suppliers = params.supplier
          ? data.suppliers.filter((s: any) =>
              s.name.toLowerCase().includes(params.supplier!.toLowerCase()),
            )
          : data.suppliers;

        return textResult(
          `Supply chain: ${suppliers.length} suppliers, ${data.pending_orders} pending orders, avg lead time ${data.avg_lead_time_days} days.`,
        );
      },
    },

    {
      name: "vendor_score",
      label: "Vendor Scorecard",
      description: "Record a vendor performance scorecard with quality, delivery, and cost scores.",
      parameters: VendorScoreParams,
      async execute(_id: string, params: Static<typeof VendorScoreParams>) {
        const overall = Math.round(
          (params.quality_score + params.delivery_score + params.cost_score) / 3,
        );

        const record = {
          id: generatePrefixedId("vendor"),
          vendor: params.vendor,
          quality_score: params.quality_score,
          delivery_score: params.delivery_score,
          cost_score: params.cost_score,
          overall_score: overall,
          notes: params.notes ?? "",
          scored_at: new Date().toISOString(),
        };

        const dir = join(ws, "agents", params.agent_id, "operations");
        const path = join(dir, "vendor-scores.json");
        const existing = (await readJson(path)) ?? { scores: [] };
        existing.scores.push(record);
        await writeJson(path, existing);

        return textResult(
          `Vendor '${params.vendor}' scored: quality=${params.quality_score}, delivery=${params.delivery_score}, cost=${params.cost_score}, overall=${overall}/100.`,
        );
      },
    },

    {
      name: "sla_track",
      label: "SLA Tracker",
      description: "Track SLA compliance for a service. Flags breaches when actual exceeds target.",
      parameters: SlaTrackParams,
      async execute(_id: string, params: Static<typeof SlaTrackParams>) {
        const breach = params.actual_value > params.target_value;
        const record = {
          id: generatePrefixedId("sla"),
          service: params.service,
          target: params.target_value,
          actual: params.actual_value,
          unit: params.unit,
          breach,
          tracked_at: new Date().toISOString(),
        };

        const dir = join(ws, "agents", params.agent_id, "operations");
        const path = join(dir, "sla-tracking.json");
        const existing = (await readJson(path)) ?? { records: [] };
        existing.records.push(record);
        await writeJson(path, existing);

        const status = breach ? "BREACH" : "OK";
        return textResult(
          `SLA '${params.service}': target=${params.target_value}${params.unit}, actual=${params.actual_value}${params.unit} [${status}].`,
        );
      },
    },

    {
      name: "capacity_plan",
      label: "Capacity Planning",
      description:
        "Assess capacity for a resource given current utilization and projected demand growth.",
      parameters: CapacityPlanParams,
      async execute(_id: string, params: Static<typeof CapacityPlanParams>) {
        const projectedUtilization =
          params.current_utilization_pct * (1 + params.projected_demand_pct / 100);
        const headroom = 100 - projectedUtilization;
        const risk = headroom < 0 ? "critical" : headroom < 15 ? "warning" : "healthy";

        const record = {
          id: generatePrefixedId("cap"),
          resource: params.resource,
          current_utilization_pct: params.current_utilization_pct,
          projected_demand_pct: params.projected_demand_pct,
          projected_utilization_pct: Math.round(projectedUtilization * 10) / 10,
          headroom_pct: Math.round(headroom * 10) / 10,
          risk,
          period: params.period,
          planned_at: new Date().toISOString(),
        };

        const dir = join(ws, "agents", params.agent_id, "operations");
        const path = join(dir, "capacity-plans.json");
        const existing = (await readJson(path)) ?? { plans: [] };
        existing.plans.push(record);
        await writeJson(path, existing);

        return textResult(
          `Capacity '${params.resource}' (${params.period}): current=${params.current_utilization_pct}%, projected=${record.projected_utilization_pct}%, headroom=${record.headroom_pct}% [${risk}].`,
        );
      },
    },

    {
      name: "inventory_status",
      label: "Inventory Status",
      description: "View current inventory levels, reorder points, and stock alerts.",
      parameters: InventoryParams,
      async execute(_id: string, params: Static<typeof InventoryParams>) {
        const dir = join(ws, "agents", params.agent_id, "operations");
        const path = join(dir, "inventory.json");
        const data = (await readJson(path)) ?? {
          items: [],
          total_value: 0,
          low_stock_count: 0,
        };

        const items = params.category
          ? data.items.filter((i: any) =>
              i.category?.toLowerCase().includes(params.category!.toLowerCase()),
            )
          : data.items;

        return textResult(
          `Inventory: ${items.length} items, total value=$${data.total_value}, ${data.low_stock_count} low stock alerts.`,
        );
      },
    },
  ];
}
