import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { PartnershipContract, FreelancerContract } from "@/lib/types";

type PartnerProps = { type: "partnership"; contracts: PartnershipContract[]; isLoading?: boolean };
type FreelancerProps = { type: "freelancer"; contracts: FreelancerContract[]; isLoading?: boolean };
type Props = PartnerProps | FreelancerProps;

const partnerColumns: Column<PartnershipContract>[] = [
  { key: "partner_name", header: "Partner", sortable: true },
  { key: "partner_type", header: "Type", render: (row) => row.partner_type || "—" },
  {
    key: "ownership_pct",
    header: "Ownership %",
    render: (row) => (row.ownership_pct != null ? `${row.ownership_pct}%` : "—"),
  },
  {
    key: "revenue_share_pct",
    header: "Rev Share %",
    render: (row) => (row.revenue_share_pct != null ? `${row.revenue_share_pct}%` : "—"),
  },
  { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
  {
    key: "end_date",
    header: "End Date",
    render: (row) => (row.end_date ? new Date(row.end_date).toLocaleDateString() : "—"),
  },
];

const freelancerColumns: Column<FreelancerContract>[] = [
  { key: "contractor_name", header: "Contractor", sortable: true },
  {
    key: "scope_of_work",
    header: "Scope",
    render: (row) =>
      row.scope_of_work
        ? row.scope_of_work.length > 40
          ? row.scope_of_work.slice(0, 40) + "..."
          : row.scope_of_work
        : "—",
  },
  {
    key: "rate_type",
    header: "Rate Type",
    render: (row) => <StatusBadge status={row.rate_type} />,
  },
  { key: "rate_amount", header: "Rate", render: (row) => `$${row.rate_amount.toLocaleString()}` },
  { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
  {
    key: "end_date",
    header: "End Date",
    render: (row) => (row.end_date ? new Date(row.end_date).toLocaleDateString() : "—"),
  },
];

export function ContractTable(props: Props) {
  if (props.type === "partnership") {
    return (
      <DataTable
        columns={partnerColumns}
        data={props.contracts}
        isLoading={props.isLoading}
        emptyMessage="No partnership contracts"
      />
    );
  }
  return (
    <DataTable
      columns={freelancerColumns}
      data={props.contracts}
      isLoading={props.isLoading}
      emptyMessage="No freelancer contracts"
    />
  );
}
