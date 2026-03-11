import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Product } from "@/lib/types";

type Props = {
  products: Product[];
  isLoading?: boolean;
};

const columns: Column<Product>[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "sku", header: "SKU" },
  {
    key: "price",
    header: "Price",
    sortable: true,
    render: (row) => `$${Number(row.price).toFixed(2)}`,
  },
  { key: "stock_qty", header: "Stock", sortable: true },
  { key: "category", header: "Category", render: (row) => row.category || "—" },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
];

export function TopProductsTable({ products, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={products}
      isLoading={isLoading}
      emptyMessage="No products found"
    />
  );
}
