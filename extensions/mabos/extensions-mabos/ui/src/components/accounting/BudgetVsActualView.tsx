import { Card, CardContent } from "@/components/ui/card";
import { useBusinessContext } from "@/contexts/BusinessContext";
import type { BudgetLine } from "@/lib/types";

function fmt(n: number) {
  if (n < 0) return `($${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2 })})`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

function varianceColor(line: BudgetLine) {
  // For revenue: positive variance is favorable
  // For expenses: negative variance is favorable (under budget)
  const isExpense = line.account_type === "expense";
  const favorable = isExpense ? line.variance <= 0 : line.variance >= 0;
  if (favorable) return "text-[var(--accent-green)]";
  if (Math.abs(line.variance_pct) > 10) return "text-[var(--accent-red)]";
  return "text-[var(--accent-amber)]";
}

type Props = {
  from: string;
  to: string;
  data:
    | {
        lines: BudgetLine[];
        totals: { budgeted: number; actual: number; variance: number };
      }
    | undefined;
  isLoading: boolean;
};

export function BudgetVsActualView({ from, to, data, isLoading }: Props) {
  const { activeBusiness } = useBusinessContext();
  if (isLoading) {
    return (
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardContent className="py-12 text-center text-sm text-[var(--text-secondary)]">
          Loading budget vs actual...
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
      <CardContent className="pt-6">
        {/* Document header */}
        <div className="text-center mb-6">
          <p className="text-xs uppercase tracking-widest text-[var(--text-secondary)]">
            {activeBusiness?.name || "Business"}
          </p>
          <h2 className="text-lg font-bold text-[var(--text-primary)] mt-1">
            Budget vs Actual Ledger
          </h2>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            {new Date(from).toLocaleDateString()} — {new Date(to).toLocaleDateString()}
          </p>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-[var(--border-mabos)]">
                <th className="text-left py-2 text-xs font-bold uppercase text-[var(--text-secondary)]">
                  Account
                </th>
                <th className="text-right py-2 text-xs font-bold uppercase text-[var(--text-secondary)]">
                  Budget
                </th>
                <th className="text-right py-2 text-xs font-bold uppercase text-[var(--text-secondary)]">
                  Actual
                </th>
                <th className="text-right py-2 text-xs font-bold uppercase text-[var(--text-secondary)]">
                  Variance
                </th>
                <th className="text-right py-2 text-xs font-bold uppercase text-[var(--text-secondary)]">
                  %
                </th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line, i) => (
                <tr key={i} className="border-b border-[var(--border-mabos)]">
                  <td className="py-2 text-[var(--text-primary)]">{line.account_name}</td>
                  <td className="py-2 text-right font-mono text-[var(--text-primary)]">
                    {fmt(line.budgeted)}
                  </td>
                  <td className="py-2 text-right font-mono text-[var(--text-primary)]">
                    {fmt(line.actual)}
                  </td>
                  <td className={`py-2 text-right font-mono ${varianceColor(line)}`}>
                    {fmt(line.variance)}
                  </td>
                  <td className={`py-2 text-right font-mono ${varianceColor(line)}`}>
                    {line.variance_pct > 0 ? "+" : ""}
                    {line.variance_pct.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--text-primary)]">
                <td className="py-2 font-bold text-[var(--text-primary)]">Total</td>
                <td className="py-2 text-right font-mono font-bold text-[var(--text-primary)]">
                  {fmt(data.totals.budgeted)}
                </td>
                <td className="py-2 text-right font-mono font-bold text-[var(--text-primary)]">
                  {fmt(data.totals.actual)}
                </td>
                <td
                  className={`py-2 text-right font-mono font-bold ${
                    data.totals.variance < 0
                      ? "text-[var(--accent-red)]"
                      : "text-[var(--accent-green)]"
                  }`}
                >
                  {fmt(data.totals.variance)}
                </td>
                <td className="py-2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
