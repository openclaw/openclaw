import { DataTable } from "@/components/ui/data-table";
import type { AnalyticsDashboard } from "@/lib/types";

interface Props {
  dashboards: AnalyticsDashboard[];
  isLoading: boolean;
}

const columns = [
  {
    key: "name" as const,
    header: "Name",
    sortable: true,
    render: (d: AnalyticsDashboard) => (
      <span className="font-medium text-[var(--text-primary)]">{d.name}</span>
    ),
  },
  {
    key: "description" as const,
    header: "Description",
    render: (d: AnalyticsDashboard) => (
      <span className="text-[var(--text-muted)] line-clamp-1">{d.description ?? "—"}</span>
    ),
  },
  {
    key: "widgets" as const,
    header: "Widgets",
    sortable: true,
    render: (d: AnalyticsDashboard) => d.widgets?.length ?? 0,
  },
  {
    key: "owner_id" as const,
    header: "Owner",
    render: (d: AnalyticsDashboard) => d.owner_id ?? "—",
  },
  {
    key: "updated_at" as const,
    header: "Updated",
    sortable: true,
    render: (d: AnalyticsDashboard) =>
      d.updated_at ? new Date(d.updated_at).toLocaleDateString() : "—",
  },
];

export function DashboardList({ dashboards, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={dashboards}
      isLoading={isLoading}
      emptyMessage="No dashboards configured yet."
    />
  );
}
