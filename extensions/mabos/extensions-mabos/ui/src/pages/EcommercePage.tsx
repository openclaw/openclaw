import { ShoppingCart } from "lucide-react";
import { useState } from "react";
import { EcommerceStatsRow } from "@/components/ecommerce/EcommerceStatsRow";
import { OrdersTable } from "@/components/ecommerce/OrdersTable";
import { TopProductsTable } from "@/components/ecommerce/TopProductsTable";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useProducts, useOrders } from "@/hooks/useEcommerce";

const statusOptions = [
  "all",
  "pending",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
] as const;
const tabs = ["Orders", "Products"] as const;

export function EcommercePage() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Orders");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: ordersData, isLoading: ordersLoading } = useOrders(
    statusFilter !== "all" ? { status: statusFilter } : undefined,
  );
  const { data: productsData, isLoading: productsLoading } = useProducts();

  const orders = ordersData?.orders ?? [];
  const products = productsData?.products ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: "color-mix(in srgb, var(--accent-blue) 15%, var(--bg-card))" }}
        >
          <ShoppingCart className="w-5 h-5 text-[var(--accent-blue)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">E-Commerce</h1>
          <p className="text-sm text-[var(--text-secondary)]">Orders, products, and sales</p>
        </div>
      </div>

      {/* Stats */}
      <EcommerceStatsRow
        orders={orders}
        products={products}
        isLoading={ordersLoading || productsLoading}
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
                      ? "bg-[var(--accent-blue)] text-white"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  }`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>
            {activeTab === "Orders" && (
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
            )}
          </div>
        </CardHeader>
        <CardContent>
          {activeTab === "Orders" ? (
            <OrdersTable orders={orders} isLoading={ordersLoading} />
          ) : (
            <TopProductsTable products={products} isLoading={productsLoading} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
