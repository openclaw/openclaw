import { Building2, DollarSign, Star, Clock } from "lucide-react";
import { StatCard, StatCardRow } from "@/components/ui/stat-card";
import type { Supplier, PurchaseOrder } from "@/lib/types";

type Props = {
  suppliers: Supplier[] | undefined;
  purchaseOrders: PurchaseOrder[] | undefined;
  isLoading: boolean;
};

export function SupplierStatsRow({ suppliers, purchaseOrders, isLoading }: Props) {
  const activeVendors = suppliers?.filter((s) => s.status === "active").length ?? 0;
  const openPOValue =
    purchaseOrders
      ?.filter((po) => po.status !== "received" && po.status !== "cancelled")
      .reduce((sum, po) => sum + po.total, 0) ?? 0;
  const ratings = suppliers?.filter((s) => s.rating != null).map((s) => s.rating!) ?? [];
  const avgRating =
    ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "—";
  const delivered = purchaseOrders?.filter((po) => po.status === "received").length ?? 0;
  const total = purchaseOrders?.length ?? 0;
  const onTimePct = total > 0 ? `${Math.round((delivered / total) * 100)}%` : "—";

  return (
    <StatCardRow isLoading={isLoading}>
      <StatCard
        label="Active Vendors"
        value={activeVendors}
        icon={Building2}
        color="var(--accent-blue)"
      />
      <StatCard
        label="Open PO Value"
        value={`$${openPOValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
        icon={DollarSign}
        color="var(--accent-green)"
      />
      <StatCard label="Avg Rating" value={avgRating} icon={Star} color="var(--accent-orange)" />
      <StatCard label="On-Time %" value={onTimePct} icon={Clock} color="var(--accent-purple)" />
    </StatCardRow>
  );
}
