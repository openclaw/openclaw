import { Truck } from "lucide-react";
import { useState } from "react";
import { RouteList } from "@/components/supply-chain/RouteList";
import { ShipmentTable } from "@/components/supply-chain/ShipmentTable";
import { SupplyChainStatsRow } from "@/components/supply-chain/SupplyChainStatsRow";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useShipments, useRoutes } from "@/hooks/useSupplyChain";

const statusOptions = ["all", "pending", "in_transit", "delivered", "delayed"] as const;
const tabs = ["Shipments", "Routes"] as const;

export function SupplyChainPage() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Shipments");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: shipmentsData, isLoading: shipmentsLoading } = useShipments(
    statusFilter !== "all" ? { status: statusFilter } : undefined,
  );
  const { data: routesData, isLoading: routesLoading } = useRoutes();

  const shipments = shipmentsData?.shipments ?? [];
  const routes = routesData?.routes ?? [];

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
          <Truck className="w-5 h-5 text-[var(--accent-orange)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Supply Chain</h1>
          <p className="text-sm text-[var(--text-secondary)]">Shipments, routes, and logistics</p>
        </div>
      </div>

      {/* Stats */}
      <SupplyChainStatsRow
        shipments={shipments}
        routes={routes}
        isLoading={shipmentsLoading || routesLoading}
      />

      {/* Tabs + Content */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    activeTab === tab
                      ? "bg-[var(--accent-orange)] text-white"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  }`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>
            {activeTab === "Shipments" && (
              <select
                className="text-xs px-2 py-1 rounded border border-[var(--border-mabos)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                {statusOptions.map((s) => (
                  <option key={s} value={s}>
                    {s === "all"
                      ? "All Statuses"
                      : s.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                  </option>
                ))}
              </select>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {activeTab === "Shipments" ? (
            <ShipmentTable shipments={shipments} isLoading={shipmentsLoading} />
          ) : (
            <RouteList routes={routes} isLoading={routesLoading} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
