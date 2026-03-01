import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Invoice } from "@/lib/types";

type Props = {
  invoices: Invoice[];
  isLoading?: boolean;
};

const columns: Column<Invoice>[] = [
  {
    key: "id",
    header: "Invoice #",
    render: (row) => <span className="font-mono text-xs">{(row.id as string).slice(0, 8)}</span>,
  },
  {
    key: "customer_id",
    header: "Customer",
    render: (row) =>
      row.customer_name ?? (
        <span className="font-mono text-xs">{(row.customer_id as string).slice(0, 8)}</span>
      ),
  },
  {
    key: "amount",
    header: "Amount",
    sortable: true,
    render: (row) =>
      `$${(row.amount as number).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "due_date",
    header: "Due Date",
    sortable: true,
    render: (row) => (row.due_date ? new Date(row.due_date as string).toLocaleDateString() : "—"),
  },
  {
    key: "created_at",
    header: "Created",
    sortable: true,
    render: (row) => new Date(row.created_at as string).toLocaleDateString(),
  },
];

export function InvoiceTable({ invoices, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={invoices}
      isLoading={isLoading}
      emptyMessage="No invoices found"
    />
  );
}
