import type { Invoice } from "@/lib/types";

type Props = {
  invoices: Invoice[];
};

function getAgingBuckets(invoices: Invoice[]) {
  const now = Date.now();
  const unpaid = invoices.filter((i) => i.status !== "paid" && i.due_date);
  const buckets = { "0-30d": 0, "31-60d": 0, "61-90d": 0, "90+d": 0 };

  for (const inv of unpaid) {
    const dueDate = new Date(inv.due_date!).getTime();
    const daysOverdue = Math.max(0, Math.floor((now - dueDate) / 86400000));
    if (daysOverdue <= 30) buckets["0-30d"] += inv.amount;
    else if (daysOverdue <= 60) buckets["31-60d"] += inv.amount;
    else if (daysOverdue <= 90) buckets["61-90d"] += inv.amount;
    else buckets["90+d"] += inv.amount;
  }
  return buckets;
}

const bucketColors: Record<string, string> = {
  "0-30d": "var(--accent-green)",
  "31-60d": "var(--accent-blue)",
  "61-90d": "var(--accent-orange)",
  "90+d": "var(--accent-red)",
};

export function InvoiceAgingChart({ invoices }: Props) {
  const buckets = getAgingBuckets(invoices);
  const total = Object.values(buckets).reduce((s, v) => s + v, 0);

  if (total === 0) {
    return (
      <div className="text-center py-6 text-sm text-[var(--text-muted)]">
        No outstanding invoices
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Stacked bar */}
      <div className="flex h-6 rounded-full overflow-hidden">
        {Object.entries(buckets).map(([label, amount]) => {
          const pct = total > 0 ? (amount / total) * 100 : 0;
          if (pct === 0) return null;
          return (
            <div
              key={label}
              className="transition-all"
              style={{
                width: `${pct}%`,
                backgroundColor: bucketColors[label],
                minWidth: pct > 0 ? "4px" : 0,
              }}
              title={`${label}: $${amount.toLocaleString()}`}
            />
          );
        })}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs">
        {Object.entries(buckets).map(([label, amount]) => (
          <div key={label} className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: bucketColors[label] }}
            />
            <span className="text-[var(--text-secondary)]">{label}</span>
            <span className="text-[var(--text-primary)] font-medium">
              ${amount.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
