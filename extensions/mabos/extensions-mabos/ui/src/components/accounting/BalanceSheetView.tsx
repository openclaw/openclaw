import { Card, CardContent } from "@/components/ui/card";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useBalanceSheet } from "@/hooks/useAccounting";
import type { BalanceSheet } from "@/lib/types";

function fmt(n: number) {
  if (n < 0) return `($${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2 })})`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

function Section({
  title,
  items,
  total,
}: {
  title: string;
  items: BalanceSheet["assets"];
  total: number;
}) {
  return (
    <div className="mb-4">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-2 border-b border-[var(--border-mabos)] pb-1">
        {title}
      </h3>
      <div className="space-y-1">
        {items.map((item) => (
          <div key={item.id} className="flex justify-between text-sm px-2">
            <span className="text-[var(--text-primary)]">{item.name}</span>
            <span className="font-mono text-[var(--text-primary)]">{fmt(item.balance)}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-sm font-bold mt-2 pt-1 border-t border-[var(--border-mabos)] px-2">
        <span className="text-[var(--text-primary)]">Total {title}</span>
        <span className="font-mono text-[var(--text-primary)]">{fmt(total)}</span>
      </div>
    </div>
  );
}

export function BalanceSheetView() {
  const { activeBusiness } = useBusinessContext();
  const { data, isLoading } = useBalanceSheet();

  if (isLoading) {
    return (
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardContent className="py-12 text-center text-sm text-[var(--text-secondary)]">
          Loading balance sheet...
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const balanced =
    Math.abs(data.totals.assets - (data.totals.liabilities + data.totals.equity)) < 0.01;

  return (
    <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
      <CardContent className="pt-6">
        {/* Document header */}
        <div className="text-center mb-6">
          <p className="text-xs uppercase tracking-widest text-[var(--text-secondary)]">
            {activeBusiness?.name || "Business"}
          </p>
          <h2 className="text-lg font-bold text-[var(--text-primary)] mt-1">Balance Sheet</h2>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            As of {new Date(data.as_of).toLocaleDateString()}
          </p>
        </div>

        <Section title="Assets" items={data.assets} total={data.totals.assets} />
        <Section title="Liabilities" items={data.liabilities} total={data.totals.liabilities} />
        <Section title="Equity" items={data.equity} total={data.totals.equity} />

        {/* Grand total */}
        <div className="flex justify-between text-sm font-bold mt-4 pt-2 border-t-2 border-[var(--text-primary)] px-2">
          <span className="text-[var(--text-primary)]">Total Liabilities + Equity</span>
          <span className="font-mono text-[var(--text-primary)]">
            {fmt(data.totals.liabilities + data.totals.equity)}
          </span>
        </div>

        {/* Balance check */}
        <div className="mt-4 flex items-center justify-center gap-2">
          <span
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
              balanced
                ? "bg-[color-mix(in_srgb,var(--accent-green)_15%,var(--bg-card))] text-[var(--accent-green)]"
                : "bg-[color-mix(in_srgb,var(--accent-red)_15%,var(--bg-card))] text-[var(--accent-red)]"
            }`}
          >
            {balanced ? "Assets = Liabilities + Equity" : "Out of Balance"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
