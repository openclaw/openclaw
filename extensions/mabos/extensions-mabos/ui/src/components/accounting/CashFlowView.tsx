import { Card, CardContent } from "@/components/ui/card";
import type { CashFlowSection } from "@/lib/types";

function fmt(n: number) {
  if (n < 0) return `($${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2 })})`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

function FlowSection({ title, section }: { title: string; section: CashFlowSection }) {
  return (
    <div className="mb-4">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-2 border-b border-[var(--border-mabos)] pb-1">
        {title}
      </h3>
      <div className="space-y-1">
        {section.items.map((item, i) => (
          <div key={i} className="flex justify-between text-sm px-2">
            <span className="text-[var(--text-primary)] truncate mr-4">{item.description}</span>
            <span
              className={`font-mono whitespace-nowrap ${
                item.amount < 0 ? "text-[var(--accent-red)]" : "text-[var(--text-primary)]"
              }`}
            >
              {fmt(item.amount)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-sm font-bold mt-2 pt-1 border-t border-[var(--border-mabos)] px-2">
        <span className="text-[var(--text-primary)]">Net {title}</span>
        <span
          className={`font-mono ${
            section.total < 0 ? "text-[var(--accent-red)]" : "text-[var(--text-primary)]"
          }`}
        >
          {fmt(section.total)}
        </span>
      </div>
    </div>
  );
}

type Props = {
  from: string;
  to: string;
  data:
    | {
        operating: CashFlowSection;
        investing: CashFlowSection;
        financing: CashFlowSection;
        net_change: number;
      }
    | undefined;
  isLoading: boolean;
};

export function CashFlowView({ from, to, data, isLoading }: Props) {
  if (isLoading) {
    return (
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardContent className="py-12 text-center text-sm text-[var(--text-secondary)]">
          Loading cash flow statement...
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
            VividWalls LLC
          </p>
          <h2 className="text-lg font-bold text-[var(--text-primary)] mt-1">Cash Flow Statement</h2>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            {new Date(from).toLocaleDateString()} — {new Date(to).toLocaleDateString()}
          </p>
        </div>

        <FlowSection title="Operating Activities" section={data.operating} />
        <FlowSection title="Investing Activities" section={data.investing} />
        <FlowSection title="Financing Activities" section={data.financing} />

        {/* Net change with double border */}
        <div className="flex justify-between text-sm font-bold mt-4 pt-2 px-2 border-t-2 border-b-2 border-[var(--text-primary)] pb-2">
          <span className="text-[var(--text-primary)]">Net Change in Cash</span>
          <span
            className={`font-mono ${
              data.net_change < 0 ? "text-[var(--accent-red)]" : "text-[var(--accent-green)]"
            }`}
          >
            {fmt(data.net_change)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
