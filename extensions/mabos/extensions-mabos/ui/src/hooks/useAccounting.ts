import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useInvoices(params?: { status?: string }) {
  return useQuery({
    queryKey: ["erp", "finance", "invoices", params],
    queryFn: () => api.getInvoices(params),
  });
}

export function useAccounts() {
  return useQuery({
    queryKey: ["erp", "finance", "accounts"],
    queryFn: api.getAccounts,
  });
}

export function useProfitLoss(from: string, to: string) {
  return useQuery({
    queryKey: ["erp", "finance", "profit-loss", from, to],
    queryFn: () => api.getProfitLoss(from, to),
  });
}

export function useBalanceSheet() {
  return useQuery({
    queryKey: ["erp", "finance", "balance-sheet"],
    queryFn: api.getBalanceSheet,
  });
}

export function useCashFlow(from: string, to: string) {
  return useQuery({
    queryKey: ["erp", "finance", "cash-flow", from, to],
    queryFn: () => api.getCashFlow(from, to),
  });
}

export function useExpenseReport(from: string, to: string) {
  return useQuery({
    queryKey: ["erp", "finance", "expense-report", from, to],
    queryFn: () => api.getExpenseReport(from, to),
  });
}

export function useBudgetVsActual(from: string, to: string) {
  return useQuery({
    queryKey: ["erp", "finance", "budget-vs-actual", from, to],
    queryFn: () => api.getBudgetVsActual(from, to),
  });
}
