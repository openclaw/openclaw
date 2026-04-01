import { Package, DollarSign, AlertTriangle, XCircle } from "lucide-react";
import { StatCard, StatCardRow } from "@/components/ui/stat-card";
import type { StockItem } from "@/lib/types";

type Props = {
  items: StockItem[] | undefined;
  alerts: StockItem[] | undefined;
  isLoading: boolean;
};

export function InventoryStatsRow({ items, alerts, isLoading }: Props) {
  const totalSkus = items?.length ?? 0;
  const totalValue = items?.reduce((sum, i) => sum + i.quantity, 0) ?? 0;
  const lowStock = alerts?.length ?? 0;
  const outOfStock = items?.filter((i) => i.quantity === 0).length ?? 0;

  return (
    <StatCardRow isLoading={isLoading}>
      <StatCard label="Total SKUs" value={totalSkus} icon={Package} color="var(--accent-blue)" />
      <StatCard
        label="Total Units"
        value={totalValue.toLocaleString()}
        icon={DollarSign}
        color="var(--accent-green)"
      />
      <StatCard
        label="Low Stock"
        value={lowStock}
        icon={AlertTriangle}
        color="var(--accent-orange)"
      />
      <StatCard label="Out of Stock" value={outOfStock} icon={XCircle} color="var(--accent-red)" />
    </StatCardRow>
  );
}
