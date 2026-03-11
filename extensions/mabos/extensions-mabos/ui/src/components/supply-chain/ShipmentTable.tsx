import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Shipment } from "@/lib/types";

type Props = {
  shipments: Shipment[];
  isLoading?: boolean;
};

const columns: Column<Shipment>[] = [
  {
    key: "tracking_number",
    header: "Tracking #",
    render: (row) => (
      <span className="font-mono text-xs">{row.tracking_number || row.id.slice(0, 8)}</span>
    ),
  },
  { key: "origin", header: "Origin", sortable: true },
  { key: "destination", header: "Destination", sortable: true },
  { key: "carrier", header: "Carrier", render: (row) => row.carrier || "—" },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "estimated_arrival",
    header: "ETA",
    sortable: true,
    render: (row) => {
      if (!row.estimated_arrival) return "—";
      const eta = new Date(row.estimated_arrival);
      const isLate = eta < new Date() && row.status !== "delivered";
      return (
        <span style={{ color: isLate ? "var(--accent-red)" : undefined }}>
          {eta.toLocaleDateString()}
        </span>
      );
    },
  },
];

export function ShipmentTable({ shipments, isLoading }: Props) {
  return (
    <DataTable
      columns={columns}
      data={shipments}
      isLoading={isLoading}
      emptyMessage="No shipments found"
    />
  );
}
