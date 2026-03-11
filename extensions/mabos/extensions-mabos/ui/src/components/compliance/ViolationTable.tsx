import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Violation } from "@/lib/types";

type Props = {
  violations: Violation[];
  isLoading?: boolean;
};

const severityColorMap: Record<string, string> = {
  critical: "var(--accent-red)",
  high: "var(--accent-orange)",
  medium: "var(--accent-blue)",
  low: "var(--accent-green)",
  info: "var(--accent-purple)",
};

const columns: Column<Violation>[] = [
  { key: "description", header: "Description", sortable: true },
  {
    key: "severity",
    header: "Severity",
    render: (row) => <StatusBadge status={row.severity} colorMap={severityColorMap} />,
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
  { key: "reported_by", header: "Reported By", render: (row) => row.reported_by || "—" },
  {
    key: "created_at",
    header: "Date",
    sortable: true,
    render: (row) => new Date(row.created_at).toLocaleDateString(),
  },
];

export function ViolationTable({ violations, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={violations}
      isLoading={isLoading}
      emptyMessage="No violations found"
    />
  );
}
