import { Card, CardContent } from "@/components/ui/card";
import { useBusinessContext } from "@/contexts/BusinessContext";
import type { ExpenseCategory } from "@/lib/types";

function fmt(n: number) {
  if (n < 0) return `($${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2 })})`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

function CategorySection({ category }: { category: ExpenseCategory }) {
  return (
    <div className="mb-4">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-2 border-b border-[var(--border-mabos)] pb-1">
        {category.name}
      </h3>
      <div className="space-y-1">
        {category.items.map((item, i) => (
          <div key={i} className="flex justify-between text-sm px-2 gap-4">
            <span className="text-[var(--text-primary)] truncate">{item.description}</span>
            <div className="flex items-center gap-4 shrink-0">
              <span className="text-xs text-[var(--text-secondary)]">
                {new Date(item.date).toLocaleDateString()}
              </span>
              <span className="font-mono text-[var(--text-primary)] w-24 text-right">
                {fmt(item.amount)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-sm font-bold mt-2 pt-1 border-t border-[var(--border-mabos)] px-2">
        <span className="text-[var(--text-primary)]">Subtotal</span>
        <span className="font-mono text-[var(--text-primary)] w-24 text-right">
          {fmt(category.total)}
        </span>
      </div>
    </div>
  );
}

type Props = {
  from: string;
  to: string;
  data: { categories: ExpenseCategory[]; grand_total: number } | undefined;
  isLoading: boolean;
};

export function ExpenseReportView({ from, to, data, isLoading }: Props) {
  const { activeBusiness } = useBusinessContext();
  if (isLoading) {
    return (
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardContent className="py-12 text-center text-sm text-[var(--text-secondary)]">
          Loading expense report...
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
          <h2 className="text-lg font-bold text-[var(--text-primary)] mt-1">Expense Report</h2>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            {new Date(from).toLocaleDateString()} — {new Date(to).toLocaleDateString()}
          </p>
        </div>

        {data.categories.map((cat) => (
          <CategorySection key={cat.name} category={cat} />
        ))}

        {/* Grand total */}
        <div className="flex justify-between text-sm font-bold mt-4 pt-2 border-t-2 border-[var(--text-primary)] px-2">
          <span className="text-[var(--text-primary)]">Grand Total</span>
          <span className="font-mono text-[var(--text-primary)] w-24 text-right">
            {fmt(data.grand_total)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
