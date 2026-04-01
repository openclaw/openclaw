import { useState, useEffect, useCallback } from "react";

type BudgetSummary = {
  totalBudget: number;
  spent: number;
  remaining: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
};

type CostEntry = {
  id: string;
  model: string;
  tokens: number;
  cost: number;
  timestamp: string;
};

type AuditLogEntry = {
  id: string;
  action: string;
  actor: string;
  resource: string;
  timestamp: string;
  details: string;
};

type GovernanceState = {
  budgets: BudgetSummary | null;
  costs: CostEntry[];
  auditLog: AuditLogEntry[];
  isLoading: boolean;
  error: string | null;
};

export function useGovernance() {
  const [state, setState] = useState<GovernanceState>({
    budgets: null,
    costs: [],
    auditLog: [],
    isLoading: true,
    error: null,
  });

  const fetchAll = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const [budgetRes, costsRes, auditRes] = await Promise.all([
        fetch("/mabos/governance/budget/summary"),
        fetch("/mabos/governance/costs"),
        fetch("/mabos/governance/audit?limit=50"),
      ]);

      if (!budgetRes.ok || !costsRes.ok || !auditRes.ok) {
        throw new Error("Failed to fetch governance data");
      }

      const [budgets, costs, auditLog] = await Promise.all([
        budgetRes.json() as Promise<BudgetSummary>,
        costsRes.json() as Promise<CostEntry[]>,
        auditRes.json() as Promise<AuditLogEntry[]>,
      ]);

      setState({ budgets, costs, auditLog, isLoading: false, error: null });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return {
    budgets: state.budgets,
    costs: state.costs,
    auditLog: state.auditLog,
    isLoading: state.isLoading,
    error: state.error,
    refresh: fetchAll,
  };
}
