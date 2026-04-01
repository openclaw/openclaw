import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Campaign } from "@/lib/types";

type Props = {
  campaigns: Campaign[];
  isLoading?: boolean;
};

const columns: Column<Campaign>[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "type", header: "Type", render: (row) => <StatusBadge status={row.type} /> },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "budget",
    header: "Budget",
    sortable: true,
    render: (row) =>
      row.budget != null
        ? `$${row.budget.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
        : "—",
  },
  {
    key: "channels",
    header: "Channels",
    render: (row) =>
      row.channels && row.channels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {row.channels.map((ch) => (
            <span
              key={ch}
              className="inline-flex px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            >
              {ch}
            </span>
          ))}
        </div>
      ) : (
        "—"
      ),
  },
  {
    key: "start_date",
    header: "Start",
    render: (row) => (row.start_date ? new Date(row.start_date).toLocaleDateString() : "—"),
  },
  {
    key: "end_date",
    header: "End",
    render: (row) => (row.end_date ? new Date(row.end_date).toLocaleDateString() : "—"),
  },
];

export function CampaignTable({ campaigns, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={campaigns}
      isLoading={isLoading}
      emptyMessage="No campaigns found"
    />
  );
}
