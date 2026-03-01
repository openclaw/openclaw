import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Order } from "@/lib/types";

type Props = {
  orders: Order[];
  isLoading?: boolean;
};

const columns: Column<Order>[] = [
  {
    key: "id",
    header: "Order #",
    render: (row) => <span className="font-mono text-xs">{row.id.slice(0, 8)}</span>,
  },
  {
    key: "customer_id",
    header: "Customer",
    render: (row) =>
      row.customer_name ?? <span className="font-mono text-xs">{row.customer_id.slice(0, 8)}</span>,
  },
  {
    key: "items",
    header: "Items",
    render: (row) => `${row.item_count ?? row.items?.length ?? 0} items`,
  },
  {
    key: "total",
    header: "Total",
    sortable: true,
    render: (row) =>
      `$${parseFloat(String(row.total)).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "created_at",
    header: "Date",
    sortable: true,
    render: (row) => new Date(row.created_at).toLocaleDateString(),
  },
];

export function OrdersTable({ orders, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={orders}
      isLoading={isLoading}
      emptyMessage="No orders found"
    />
  );
}
