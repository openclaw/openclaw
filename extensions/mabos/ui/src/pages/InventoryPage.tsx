import { Package, MessageSquare, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

const upcomingFeatures = [
  "Stock tracking across multiple locations",
  "Purchase order management and approvals",
  "Warehouse management and transfers",
  "Supplier portal and vendor scoring",
];

export function InventoryPage() {
  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--accent-orange) 15%, var(--bg-card))",
          }}
        >
          <Package className="w-5 h-5 text-[var(--accent-orange)]" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">
              Inventory
            </h1>
            <Badge
              variant="outline"
              className="border-[var(--accent-orange)]/30 text-[var(--accent-orange)] text-[10px]"
            >
              Coming Soon
            </Badge>
          </div>
          <p className="text-sm text-[var(--text-secondary)] mt-0.5">
            Stock management and supply-chain operations
          </p>
        </div>
      </div>

      {/* Description card */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
            About this Module
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[var(--text-primary)] leading-relaxed">
            Track stock levels, manage suppliers, and monitor inventory across
            locations.
          </p>
          <p className="text-sm text-[var(--text-muted)] mt-3 leading-relaxed">
            While this module is under development, you can interact with the{" "}
            <span className="text-[var(--accent-orange)] font-medium">
              Inventory Manager
            </span>{" "}
            agent through the chat panel for inventory-related queries and
            operations.
          </p>
        </CardContent>
      </Card>

      {/* Upcoming features */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
            Upcoming Features
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {upcomingFeatures.map((feature) => (
              <li key={feature} className="flex items-center gap-3">
                <ChevronRight className="w-4 h-4 text-[var(--accent-orange)] shrink-0" />
                <span className="text-sm text-[var(--text-primary)]">
                  {feature}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Chat CTA */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
              style={{
                backgroundColor:
                  "color-mix(in srgb, var(--accent-green) 15%, var(--bg-card))",
              }}
            >
              <MessageSquare className="w-4 h-4 text-[var(--accent-green)]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Use the Chat Panel
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Open the chat panel and ask the Inventory Manager agent about
                stock levels, suppliers, or purchase orders.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
