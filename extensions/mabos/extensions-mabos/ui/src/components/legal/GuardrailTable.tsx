import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ComplianceGuardrail } from "@/lib/types";

type Props = {
  guardrails: ComplianceGuardrail[];
  isLoading?: boolean;
};

const severityColorMap: Record<string, string> = {
  critical: "var(--accent-red)",
  warning: "var(--accent-orange)",
  info: "var(--accent-blue)",
};

const columns: Column<ComplianceGuardrail>[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "category", header: "Category" },
  {
    key: "severity",
    header: "Severity",
    render: (row) => <StatusBadge status={row.severity} colorMap={severityColorMap} />,
  },
  {
    key: "active",
    header: "Active",
    render: (row) => (
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ backgroundColor: row.active ? "var(--accent-green)" : "var(--text-muted)" }}
        title={row.active ? "Active" : "Inactive"}
      />
    ),
  },
];

export function GuardrailTable({ guardrails, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={guardrails}
      isLoading={isLoading}
      emptyMessage="No guardrails configured"
    />
  );
}
