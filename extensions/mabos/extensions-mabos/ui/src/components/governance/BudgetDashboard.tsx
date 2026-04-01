import { Wallet, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { BudgetGauge } from "./BudgetGauge";

type AgentBudget = {
  agentId: string;
  agentName: string;
  daily: { spent: number; limit: number; reserved: number };
  monthly: { spent: number; limit: number; reserved: number };
};

type BudgetSummary = {
  agents: AgentBudget[];
  totalSpent: number;
  totalLimit: number;
};

export function BudgetDashboard() {
  const [data, setData] = useState<BudgetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBudgets = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/mabos/governance/budget/summary");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load budgets");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBudgets();
  }, []);

  return (
    <div
      className="rounded-lg border p-5 space-y-5"
      style={{
        backgroundColor: "var(--bg-card)",
        borderColor: "var(--border-mabos)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg"
            style={{ backgroundColor: "color-mix(in srgb, var(--accent-green) 15%, transparent)" }}
          >
            <Wallet className="w-4 h-4" style={{ color: "var(--accent-green)" }} />
          </div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Agent Budgets</h3>
        </div>
        <button
          type="button"
          onClick={fetchBudgets}
          disabled={loading}
          className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw
            className={`w-4 h-4 text-[var(--text-muted)] ${loading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {/* Error state */}
      {error && (
        <p className="text-xs text-[var(--accent-red)] bg-[var(--bg-tertiary)] rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-lg p-4 space-y-3 animate-pulse"
              style={{ backgroundColor: "var(--bg-secondary)" }}
            >
              <div className="h-3 w-24 rounded bg-[var(--bg-tertiary)]" />
              <div className="h-3 w-full rounded bg-[var(--bg-tertiary)]" />
              <div className="h-3 w-full rounded bg-[var(--bg-tertiary)]" />
            </div>
          ))}
        </div>
      )}

      {/* Summary bar */}
      {data && (
        <div className="rounded-md px-4 py-3" style={{ backgroundColor: "var(--bg-secondary)" }}>
          <BudgetGauge
            label="Total Organization Budget"
            spent={data.totalSpent}
            limit={data.totalLimit}
          />
        </div>
      )}

      {/* Per-agent grid */}
      {data && data.agents.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.agents.map((agent) => (
            <div
              key={agent.agentId}
              className="rounded-lg border p-4 space-y-3"
              style={{
                backgroundColor: "var(--bg-secondary)",
                borderColor: "var(--border-mabos)",
              }}
            >
              <p className="text-sm font-medium text-[var(--text-primary)]">{agent.agentName}</p>
              <BudgetGauge
                label="Daily"
                spent={agent.daily.spent}
                limit={agent.daily.limit}
                reserved={agent.daily.reserved}
              />
              <BudgetGauge
                label="Monthly"
                spent={agent.monthly.spent}
                limit={agent.monthly.limit}
                reserved={agent.monthly.reserved}
              />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {data && data.agents.length === 0 && (
        <p className="text-sm text-center text-[var(--text-muted)] py-6">
          No agent budgets configured
        </p>
      )}
    </div>
  );
}
