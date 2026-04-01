import { DollarSign, TrendingDown, TrendingUp, CreditCard } from "lucide-react";
import { StatCard, StatCardRow } from "@/components/ui/stat-card";
import type { Invoice, ProfitLoss } from "@/lib/types";

type Props = {
  invoices: Invoice[] | undefined;
  profitLoss: ProfitLoss | undefined;
  isLoading: boolean;
};

export function FinanceStatsRow({ invoices, profitLoss, isLoading }: Props) {
  const revenue =
    invoices?.filter((i) => i.status === "paid").reduce((sum, i) => sum + i.amount, 0) ?? 0;
  const receivable =
    invoices
      ?.filter((i) => i.status === "sent" || i.status === "overdue")
      .reduce((sum, i) => sum + i.amount, 0) ?? 0;
  const net = profitLoss?.net ?? 0;

  return (
    <StatCardRow isLoading={isLoading}>
      <StatCard
        label="Revenue"
        value={`$${revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
        icon={TrendingUp}
        color="var(--accent-green)"
      />
      <StatCard
        label="Net Profit"
        value={`$${Number(net).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
        icon={net >= 0 ? TrendingUp : TrendingDown}
        color={net >= 0 ? "var(--accent-green)" : "var(--accent-red)"}
      />
      <StatCard
        label="Receivable"
        value={`$${receivable.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
        icon={CreditCard}
        color="var(--accent-blue)"
      />
      <StatCard
        label="Total Invoices"
        value={invoices?.length ?? 0}
        icon={DollarSign}
        color="var(--accent-purple)"
      />
    </StatCardRow>
  );
}
