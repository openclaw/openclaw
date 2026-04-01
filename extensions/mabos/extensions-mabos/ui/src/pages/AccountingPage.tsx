import { DollarSign } from "lucide-react";
import { useMemo, useState } from "react";
import { BalanceSheetView } from "@/components/accounting/BalanceSheetView";
import { BudgetVsActualView } from "@/components/accounting/BudgetVsActualView";
import { CashFlowView } from "@/components/accounting/CashFlowView";
import { ExpenseReportView } from "@/components/accounting/ExpenseReportView";
import { FinanceStatsRow } from "@/components/accounting/FinanceStatsRow";
import { InvoiceAgingChart } from "@/components/accounting/InvoiceAgingChart";
import { InvoiceTable } from "@/components/accounting/InvoiceTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useInvoices,
  useProfitLoss,
  useBalanceSheet,
  useCashFlow,
  useExpenseReport,
  useBudgetVsActual,
} from "@/hooks/useAccounting";

const tabs = ["Overview", "Balance Sheet", "Cash Flow", "Expenses", "Budget"] as const;
const statusOptions = ["all", "draft", "sent", "paid", "overdue"] as const;

export function AccountingPage() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Overview");
  const [statusFilter, setStatusFilter] = useState("all");
  const [from, to] = useMemo(() => {
    const now = new Date();
    return [new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(), now.toISOString()];
  }, []);

  // All hooks at top level per React rules
  const { data: invoicesData, isLoading: invoicesLoading } = useInvoices(
    statusFilter !== "all" ? { status: statusFilter } : undefined,
  );
  const { data: profitLoss, isLoading: plLoading } = useProfitLoss(from, to);
  const { data: cashFlowData, isLoading: cfLoading } = useCashFlow(from, to);
  const { data: expenseData, isLoading: expLoading } = useExpenseReport(from, to);
  const { data: budgetData, isLoading: budgetLoading } = useBudgetVsActual(from, to);

  const invoices = invoicesData?.invoices ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: "color-mix(in srgb, var(--accent-green) 15%, var(--bg-card))" }}
        >
          <DollarSign className="w-5 h-5 text-[var(--accent-green)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Accounting</h1>
          <p className="text-sm text-[var(--text-secondary)]">Financial management and reporting</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1">
        {tabs.map((tab) => (
          <button
            key={tab}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeTab === tab
                ? "bg-[var(--accent-green)] text-white"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "Overview" && (
        <>
          <FinanceStatsRow
            invoices={invoices}
            profitLoss={profitLoss}
            isLoading={invoicesLoading || plLoading}
          />

          <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
                Invoice Aging
              </CardTitle>
            </CardHeader>
            <CardContent>
              <InvoiceAgingChart invoices={invoices} />
            </CardContent>
          </Card>

          <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
                  Invoices
                </CardTitle>
                <select
                  className="text-xs px-2 py-1 rounded border border-[var(--border-mabos)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  {statusOptions.map((s) => (
                    <option key={s} value={s}>
                      {s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
            </CardHeader>
            <CardContent>
              <InvoiceTable invoices={invoices} isLoading={invoicesLoading} />
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === "Balance Sheet" && <BalanceSheetView />}

      {activeTab === "Cash Flow" && (
        <CashFlowView from={from} to={to} data={cashFlowData} isLoading={cfLoading} />
      )}

      {activeTab === "Expenses" && (
        <ExpenseReportView from={from} to={to} data={expenseData} isLoading={expLoading} />
      )}

      {activeTab === "Budget" && (
        <BudgetVsActualView from={from} to={to} data={budgetData} isLoading={budgetLoading} />
      )}
    </div>
  );
}
