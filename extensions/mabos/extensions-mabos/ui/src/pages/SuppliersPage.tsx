import { Building2 } from "lucide-react";
import { useState } from "react";
import { PurchaseOrderPipeline } from "@/components/suppliers/PurchaseOrderPipeline";
import { SupplierStatsRow } from "@/components/suppliers/SupplierStatsRow";
import { SupplierTable } from "@/components/suppliers/SupplierTable";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useSuppliers, usePurchaseOrders } from "@/hooks/useSuppliers";

const tabs = ["Vendors", "Purchase Orders"] as const;

export function SuppliersPage() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Vendors");

  const { data: suppliersData, isLoading: suppliersLoading } = useSuppliers();
  const { data: posData, isLoading: posLoading } = usePurchaseOrders();

  const suppliers = suppliersData?.suppliers ?? [];
  const purchaseOrders = posData?.orders ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: "color-mix(in srgb, var(--accent-blue) 15%, var(--bg-card))" }}
        >
          <Building2 className="w-5 h-5 text-[var(--accent-blue)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Suppliers</h1>
          <p className="text-sm text-[var(--text-secondary)]">Vendor management and procurement</p>
        </div>
      </div>

      {/* Stats */}
      <SupplierStatsRow
        suppliers={suppliers}
        purchaseOrders={purchaseOrders}
        isLoading={suppliersLoading || posLoading}
      />

      {/* Tabs + Content */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
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
        </CardHeader>
        <CardContent>
          {activeTab === "Vendors" ? (
            <SupplierTable suppliers={suppliers} isLoading={suppliersLoading} />
          ) : (
            <PurchaseOrderPipeline orders={purchaseOrders} isLoading={posLoading} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
