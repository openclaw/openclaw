import { Package } from "lucide-react";
import { useState } from "react";
import { InventoryStatsRow } from "@/components/inventory/InventoryStatsRow";
import { StockAlertTable } from "@/components/inventory/StockAlertTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { useStockItems, useLowStockAlerts } from "@/hooks/useInventory";
import type { StockItem } from "@/lib/types";

const statusOptions = ["all", "active", "discontinued", "reserved"] as const;

const columns: Column<StockItem>[] = [
  { key: "sku", header: "SKU", sortable: true },
  { key: "name", header: "Name", sortable: true },
  { key: "quantity", header: "Quantity", sortable: true },
  { key: "reorder_point", header: "Reorder Point", sortable: true },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "warehouse_id",
    header: "Warehouse",
    render: (row) => row.warehouse_name ?? (row.warehouse_id as string) ?? "—",
  },
];

export function InventoryPage() {
  const [statusFilter, setStatusFilter] = useState("all");
  const { data: itemsData, isLoading: itemsLoading } = useStockItems(
    statusFilter !== "all" ? { status: statusFilter } : undefined,
  );
  const { data: alertsData, isLoading: alertsLoading } = useLowStockAlerts();

  const items = itemsData?.items ?? [];
  const alerts = alertsData?.alerts ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-orange) 15%, var(--bg-card))",
          }}
        >
          <Package className="w-5 h-5 text-[var(--accent-orange)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Inventory</h1>
          <p className="text-sm text-[var(--text-secondary)]">Stock management and tracking</p>
        </div>
      </div>

      {/* Stats */}
      <InventoryStatsRow items={items} alerts={alerts} isLoading={itemsLoading || alertsLoading} />

      {/* Filter + Main Table */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
              Stock Items
            </CardTitle>
            <select
              className="text-xs px-2 py-1 rounded border border-[var(--border-mabos)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={items}
            isLoading={itemsLoading}
            emptyMessage="No stock items found"
          />
        </CardContent>
      </Card>

      {/* Low Stock Alerts */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-[var(--accent-orange)]">
            Low Stock Alerts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <StockAlertTable alerts={alerts} isLoading={alertsLoading} />
        </CardContent>
      </Card>
    </div>
  );
}
