import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { StockItem } from "@/lib/types";

type Props = {
  alerts: StockItem[];
  isLoading?: boolean;
};

const columns: Column<StockItem>[] = [
  { key: "sku", header: "SKU", sortable: true },
  { key: "name", header: "Name", sortable: true },
  {
    key: "quantity",
    header: "Quantity",
    sortable: true,
    render: (row) => (
      <span
        style={{
          color: row.quantity === 0 ? "var(--accent-red)" : "var(--accent-orange)",
          fontWeight: 600,
        }}
      >
        {row.quantity}
      </span>
    ),
  },
  { key: "reorder_point", header: "Reorder Point", sortable: true },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
];

export function StockAlertTable({ alerts, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={alerts}
      isLoading={isLoading}
      emptyMessage="No low stock alerts"
    />
  );
}
