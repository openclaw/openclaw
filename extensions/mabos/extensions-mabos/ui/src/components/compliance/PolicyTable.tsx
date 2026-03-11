import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { CompliancePolicy } from "@/lib/types";

type Props = {
  policies: CompliancePolicy[];
  isLoading?: boolean;
};

const columns: Column<CompliancePolicy>[] = [
  { key: "title", header: "Title", sortable: true },
  { key: "category", header: "Category" },
  { key: "version", header: "Version", render: (row) => row.version || "1.0" },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "effective_date",
    header: "Effective Date",
    sortable: true,
    render: (row) => (row.effective_date ? new Date(row.effective_date).toLocaleDateString() : "—"),
  },
];

export function PolicyTable({ policies, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={policies}
      isLoading={isLoading}
      emptyMessage="No policies found"
    />
  );
}
