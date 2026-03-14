"use client";

import Link from "next/link";
import { GlassCard } from "@/components/ui/glass-card";
import { EmptyState } from "@/components/ui/empty-state";
import { StaggerGrid, StaggerItem } from "@/components/ui/stagger-grid";
import { StatusDot } from "@/components/ui/status-dot";
import { Package, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface Product {
  _id?: string;
  name: string;
  slug: string;
  status: string;
  description?: string;
  health?: string;
  metrics?: Record<string, number>;
}

interface EcosystemViewProps {
  products?: Product[];
}

const statusStyles: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  development: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  concept: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  archived: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

const healthColors: Record<string, "green" | "yellow" | "red" | "gray"> = {
  healthy: "green",
  warning: "yellow",
  critical: "red",
};

export function EcosystemView({ products = [] }: EcosystemViewProps) {
  if (products.length === 0) {
    return (
      <GlassCard>
        <EmptyState
          icon={Package}
          title="No ecosystem products"
          description="Products will appear when added to the Convex database."
        />
      </GlassCard>
    );
  }

  return (
    <StaggerGrid columns="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
      {products.map((product) => (
        <StaggerItem key={product.slug}>
          <Link href={`/ecosystem/${product.slug}`}>
            <GlassCard hover>
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="text-sm font-semibold">{product.name}</h3>
                  <span
                    className={cn(
                      "inline-flex items-center px-1.5 py-0.5 text-[9px] font-medium rounded-md border mt-1",
                      statusStyles[product.status] || statusStyles.concept
                    )}
                  >
                    {product.status}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {product.health && (
                    <StatusDot color={healthColors[product.health] || "gray"} pulse />
                  )}
                  <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
              </div>

              {product.description && (
                <p className="text-[11px] text-muted-foreground mb-2 line-clamp-2">
                  {product.description}
                </p>
              )}

              {product.metrics && Object.keys(product.metrics).length > 0 && (
                <div className="flex gap-3 mt-2 pt-2 border-t border-white/[0.04]">
                  {Object.entries(product.metrics).slice(0, 3).map(([key, val]) => (
                    <div key={key}>
                      <p className="text-xs font-semibold">{val}</p>
                      <p className="text-[9px] text-muted-foreground capitalize">{key}</p>
                    </div>
                  ))}
                </div>
              )}
            </GlassCard>
          </Link>
        </StaggerItem>
      ))}
    </StaggerGrid>
  );
}
