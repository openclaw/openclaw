import { Truck, CheckCircle, AlertTriangle, Route as RouteIcon } from "lucide-react";
import { StatCard, StatCardRow } from "@/components/ui/stat-card";
import type { Shipment, Route } from "@/lib/types";

type Props = {
  shipments: Shipment[] | undefined;
  routes: Route[] | undefined;
  isLoading: boolean;
};

export function SupplyChainStatsRow({ shipments, routes, isLoading }: Props) {
  const inTransit = shipments?.filter((s) => s.status === "in_transit").length ?? 0;
  const delivered = shipments?.filter((s) => s.status === "delivered").length ?? 0;
  const delayed = shipments?.filter((s) => s.status === "delayed").length ?? 0;
  const activeRoutes = routes?.filter((r) => r.status === "active").length ?? 0;

  return (
    <StatCardRow isLoading={isLoading}>
      <StatCard label="In Transit" value={inTransit} icon={Truck} color="var(--accent-blue)" />
      <StatCard
        label="Delivered"
        value={delivered}
        icon={CheckCircle}
        color="var(--accent-green)"
      />
      <StatCard label="Delayed" value={delayed} icon={AlertTriangle} color="var(--accent-red)" />
      <StatCard
        label="Active Routes"
        value={activeRoutes}
        icon={RouteIcon}
        color="var(--accent-orange)"
      />
    </StatCardRow>
  );
}
