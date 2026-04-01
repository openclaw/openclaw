import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Supplier } from "@/lib/types";

type Props = {
  suppliers: Supplier[];
  isLoading?: boolean;
};

function RatingDisplay({ rating }: { rating: number | null }) {
  if (rating == null) return <span className="text-[var(--text-muted)]">—</span>;
  const stars = Math.round(rating);
  return (
    <span className="text-xs" title={`${rating}/5`}>
      {"★".repeat(stars)}
      {"☆".repeat(5 - stars)}
    </span>
  );
}

const columns: Column<Supplier>[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "contact_email", header: "Email", render: (row) => row.contact_email || "—" },
  { key: "category", header: "Category", render: (row) => row.category || "—" },
  {
    key: "rating",
    header: "Rating",
    sortable: true,
    render: (row) => <RatingDisplay rating={row.rating} />,
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
];

export function SupplierTable({ suppliers, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={suppliers}
      isLoading={isLoading}
      emptyMessage="No suppliers found"
    />
  );
}
