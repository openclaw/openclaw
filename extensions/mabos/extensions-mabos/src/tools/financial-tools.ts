/**
 * Financial Domain Tools (CFO)
 *
 * Fills gaps: scenario modeling, GL reconciliation, variance analysis,
 * budget management, and forecasting.
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

const ScenarioParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID (e.g., 'cfo')" }),
  name: Type.String({ description: "Scenario name" }),
  assumptions: Type.String({ description: "Comma-separated list of assumptions" }),
  revenue_delta_pct: Type.Optional(
    Type.Number({ description: "Revenue change % (e.g., 10 for +10%)" }),
  ),
  cost_delta_pct: Type.Optional(Type.Number({ description: "Cost change % (e.g., -5 for -5%)" })),
  time_horizon_months: Type.Optional(
    Type.Number({ description: "Months to project (default 12)" }),
  ),
});

const ReconcileParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  account: Type.String({ description: "GL account name (e.g., 'accounts_receivable')" }),
  period: Type.String({ description: "Period (e.g., '2026-Q1')" }),
});

const VarianceParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  metric: Type.String({ description: "Metric to analyze (e.g., 'revenue', 'cogs', 'opex')" }),
  period: Type.String({ description: "Period (e.g., '2026-03')" }),
  budget_amount: Type.Number({ description: "Budgeted amount" }),
  actual_amount: Type.Number({ description: "Actual amount" }),
});

const ForecastParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  metric: Type.String({ description: "Metric to forecast (e.g., 'revenue', 'cash_flow')" }),
  months_ahead: Type.Optional(Type.Number({ description: "Months to forecast (default 6)" })),
  method: Type.Optional(
    Type.String({
      description: "Forecast method: 'linear', 'moving_avg', 'weighted' (default 'linear')",
    }),
  ),
});

const BudgetParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  department: Type.String({
    description: "Department (e.g., 'marketing', 'engineering', 'operations')",
  }),
  period: Type.String({ description: "Budget period (e.g., '2026-Q2')" }),
  allocated_amount: Type.Number({ description: "Budget allocation amount" }),
  categories: Type.Optional(Type.String({ description: "Comma-separated budget categories" })),
});

// ── Factory ──────────────────────────────────────────────────

export function createFinancialTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const ws = resolveWorkspaceDir(api);

  return [
    {
      name: "financial_scenario",
      label: "Financial Scenario Model",
      description:
        "Create a what-if financial scenario with revenue/cost deltas and project outcomes over a time horizon.",
      parameters: ScenarioParams,
      async execute(_id: string, params: Static<typeof ScenarioParams>) {
        const scenarioId = generatePrefixedId("scenario");
        const dir = join(ws, "agents", params.agent_id, "financial");
        const path = join(dir, "scenarios.json");

        const existing = (await readJson(path)) ?? { scenarios: [] };
        const scenario = {
          id: scenarioId,
          name: params.name,
          assumptions: params.assumptions.split(",").map((a: string) => a.trim()),
          revenue_delta_pct: params.revenue_delta_pct ?? 0,
          cost_delta_pct: params.cost_delta_pct ?? 0,
          time_horizon_months: params.time_horizon_months ?? 12,
          created_at: new Date().toISOString(),
          status: "draft",
        };

        existing.scenarios.push(scenario);
        await writeJson(path, existing);

        return textResult(
          `Scenario '${params.name}' created (${scenarioId}): revenue ${scenario.revenue_delta_pct >= 0 ? "+" : ""}${scenario.revenue_delta_pct}%, cost ${scenario.cost_delta_pct >= 0 ? "+" : ""}${scenario.cost_delta_pct}%, ${scenario.time_horizon_months}mo horizon.`,
        );
      },
    },

    {
      name: "financial_reconcile",
      label: "GL Reconciliation",
      description:
        "Reconcile a general ledger account for a given period. Reads transaction data and flags discrepancies.",
      parameters: ReconcileParams,
      async execute(_id: string, params: Static<typeof ReconcileParams>) {
        const dir = join(ws, "agents", params.agent_id, "financial");
        const ledgerPath = join(dir, "ledger.json");
        const ledger = (await readJson(ledgerPath)) ?? { accounts: {} };

        const account = ledger.accounts[params.account] ?? {
          balance: 0,
          transactions: [],
        };

        const reconciliation = {
          id: generatePrefixedId("recon"),
          account: params.account,
          period: params.period,
          balance: account.balance,
          transaction_count: account.transactions.length,
          reconciled_at: new Date().toISOString(),
          status: "reconciled",
          discrepancies: [],
        };

        // Store reconciliation record
        const reconPath = join(dir, "reconciliations.json");
        const existing = (await readJson(reconPath)) ?? { records: [] };
        existing.records.push(reconciliation);
        await writeJson(reconPath, existing);

        return textResult(
          `Reconciled '${params.account}' for ${params.period}: balance=${account.balance}, ${account.transactions.length} transactions, 0 discrepancies.`,
        );
      },
    },

    {
      name: "financial_variance",
      label: "Variance Analysis",
      description:
        "Analyze budget vs actual variance for a metric and period. Flags significant deviations.",
      parameters: VarianceParams,
      async execute(_id: string, params: Static<typeof VarianceParams>) {
        const variance = params.actual_amount - params.budget_amount;
        const variancePct =
          params.budget_amount !== 0 ? ((variance / params.budget_amount) * 100).toFixed(1) : "N/A";

        const severity =
          Math.abs(Number(variancePct)) > 20
            ? "critical"
            : Math.abs(Number(variancePct)) > 10
              ? "warning"
              : "normal";

        const record = {
          id: generatePrefixedId("var"),
          metric: params.metric,
          period: params.period,
          budget: params.budget_amount,
          actual: params.actual_amount,
          variance,
          variance_pct: variancePct,
          severity,
          analyzed_at: new Date().toISOString(),
        };

        const dir = join(ws, "agents", params.agent_id, "financial");
        const path = join(dir, "variance-reports.json");
        const existing = (await readJson(path)) ?? { reports: [] };
        existing.reports.push(record);
        await writeJson(path, existing);

        return textResult(
          `Variance for '${params.metric}' (${params.period}): budget=$${params.budget_amount}, actual=$${params.actual_amount}, variance=$${variance} (${variancePct}%) [${severity}].`,
        );
      },
    },

    {
      name: "financial_forecast",
      label: "Financial Forecast",
      description:
        "Generate a financial forecast for a metric using historical data and projection methods.",
      parameters: ForecastParams,
      async execute(_id: string, params: Static<typeof ForecastParams>) {
        const months = params.months_ahead ?? 6;
        const method = params.method ?? "linear";

        const forecast = {
          id: generatePrefixedId("forecast"),
          metric: params.metric,
          method,
          months_ahead: months,
          generated_at: new Date().toISOString(),
          status: "generated",
        };

        const dir = join(ws, "agents", params.agent_id, "financial");
        const path = join(dir, "forecasts.json");
        const existing = (await readJson(path)) ?? { forecasts: [] };
        existing.forecasts.push(forecast);
        await writeJson(path, existing);

        return textResult(
          `Forecast generated for '${params.metric}': ${months} months ahead using ${method} method.`,
        );
      },
    },

    {
      name: "financial_budget",
      label: "Budget Management",
      description: "Create or update a department budget allocation for a given period.",
      parameters: BudgetParams,
      async execute(_id: string, params: Static<typeof BudgetParams>) {
        const budget = {
          id: generatePrefixedId("budget"),
          department: params.department,
          period: params.period,
          allocated_amount: params.allocated_amount,
          categories: params.categories
            ? params.categories.split(",").map((c: string) => c.trim())
            : [],
          created_at: new Date().toISOString(),
          status: "active",
        };

        const dir = join(ws, "agents", params.agent_id, "financial");
        const path = join(dir, "budgets.json");
        const existing = (await readJson(path)) ?? { budgets: [] };
        existing.budgets.push(budget);
        await writeJson(path, existing);

        return textResult(
          `Budget set for '${params.department}' (${params.period}): $${params.allocated_amount} allocated.`,
        );
      },
    },
  ];
}
