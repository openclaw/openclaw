import { ShoppingCart, DollarSign, TrendingUp, Package } from "lucide-react";
import { StatCard, StatCardRow } from "@/components/ui/stat-card";
import type { Order, Product } from "@/lib/types";

type Props = {
  orders: Order[] | undefined;
  products: Product[] | undefined;
  isLoading: boolean;
};

export function EcommerceStatsRow({ orders, products, isLoading }: Props) {
  const totalOrders = orders?.length ?? 0;
  const revenue = orders?.reduce((sum, o) => sum + parseFloat(String(o.total)), 0) ?? 0;
  const aov = totalOrders > 0 ? revenue / totalOrders : 0;
  const activeProducts = products?.filter((p) => p.status === "active").length ?? 0;

  return (
    <StatCardRow isLoading={isLoading}>
      <StatCard
        label="Total Orders"
        value={totalOrders}
        icon={ShoppingCart}
        color="var(--accent-blue)"
      />
      <StatCard
        label="Revenue"
        value={`$${revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
        icon={DollarSign}
        color="var(--accent-green)"
      />
      <StatCard
        label="AOV"
        value={`$${aov.toFixed(2)}`}
        icon={TrendingUp}
        color="var(--accent-purple)"
      />
      <StatCard
        label="Active Products"
        value={activeProducts}
        icon={Package}
        color="var(--accent-orange)"
      />
    </StatCardRow>
  );
}
