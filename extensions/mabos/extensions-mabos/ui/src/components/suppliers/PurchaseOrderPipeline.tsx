import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { PurchaseOrder } from "@/lib/types";

type Props = {
  orders: PurchaseOrder[];
  isLoading?: boolean;
};

const stages = ["draft", "submitted", "approved", "shipped", "received"] as const;

function PipelineBar({ status }: { status: string }) {
  const idx = stages.indexOf(status as (typeof stages)[number]);
  const progress = idx >= 0 ? ((idx + 1) / stages.length) * 100 : 0;

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${progress}%`,
            backgroundColor: progress === 100 ? "var(--accent-green)" : "var(--accent-blue)",
          }}
        />
      </div>
      <span className="text-[10px] text-[var(--text-muted)] w-16 text-right capitalize">
        {status}
      </span>
    </div>
  );
}

const columns: Column<PurchaseOrder>[] = [
  {
    key: "id",
    header: "PO #",
    render: (row) => <span className="font-mono text-xs">{row.id.slice(0, 8)}</span>,
  },
  {
    key: "supplier_id",
    header: "Supplier",
    render: (row) => <span className="font-mono text-xs">{row.supplier_id.slice(0, 8)}</span>,
  },
  {
    key: "total",
    header: "Total",
    sortable: true,
    render: (row) => `$${row.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
  },
  {
    key: "status",
    header: "Progress",
    render: (row) => <PipelineBar status={row.status} />,
  },
  {
    key: "expected_delivery",
    header: "Expected",
    render: (row) =>
      row.expected_delivery ? new Date(row.expected_delivery).toLocaleDateString() : "—",
  },
];

export function PurchaseOrderPipeline({ orders, isLoading }: Props) {
  return (
    <div className="space-y-4">
      {/* Status summary bar */}
      <div className="flex gap-2 text-xs">
        {stages.map((stage) => {
          const count = orders.filter((o) => o.status === stage).length;
          return (
            <div key={stage} className="flex items-center gap-1">
              <StatusBadge status={stage} />
              <span className="text-[var(--text-muted)]">{count}</span>
            </div>
          );
        })}
      </div>
      <DataTable
        columns={columns}
        data={orders}
        isLoading={isLoading}
        emptyMessage="No purchase orders found"
      />
    </div>
  );
}
