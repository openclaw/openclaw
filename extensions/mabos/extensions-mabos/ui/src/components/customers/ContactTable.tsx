import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Contact } from "@/lib/types";

type Props = {
  contacts: Contact[];
  isLoading?: boolean;
};

const columns: Column<Contact>[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "email", header: "Email", render: (row) => (row.email as string) || "—" },
  { key: "company", header: "Company", render: (row) => (row.company as string) || "—" },
  {
    key: "segment",
    header: "Segment",
    render: (row) =>
      row.segment ? (
        <StatusBadge status={row.segment} />
      ) : (
        <span className="text-[var(--text-muted)]">—</span>
      ),
  },
  {
    key: "lifecycle_stage",
    header: "Stage",
    render: (row) =>
      row.lifecycle_stage ? (
        <StatusBadge status={row.lifecycle_stage} />
      ) : (
        <span className="text-[var(--text-muted)]">—</span>
      ),
  },
  {
    key: "created_at",
    header: "Created",
    sortable: true,
    render: (row) => new Date(row.created_at as string).toLocaleDateString(),
  },
];

export function ContactTable({ contacts, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={contacts}
      isLoading={isLoading}
      emptyMessage="No contacts found"
    />
  );
}
