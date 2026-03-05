"use client";

import { useAutoRefresh } from "@/hooks/use-auto-refresh";
import { GlassCard } from "@/components/ui/glass-card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { StaggerGrid, StaggerItem } from "@/components/ui/stagger-grid";
import { FileText, PenLine, Eye, CheckCircle, Globe, ArrowRight } from "lucide-react";
import { cn, truncate } from "@/lib/utils";
import type { ContentItem } from "@/lib/types";

const statusConfig = {
  draft: { label: "Draft", icon: PenLine, color: "text-zinc-400", bg: "bg-zinc-500/10" },
  review: { label: "Review", icon: Eye, color: "text-amber-400", bg: "bg-amber-500/10" },
  approved: { label: "Approved", icon: CheckCircle, color: "text-blue-400", bg: "bg-blue-500/10" },
  published: { label: "Published", icon: Globe, color: "text-emerald-400", bg: "bg-emerald-500/10" },
};

const columns: (keyof typeof statusConfig)[] = ["draft", "review", "approved", "published"];

export function ContentView() {
  const { data, loading } = useAutoRefresh<{ items: ContentItem[]; counts: Record<string, number> }>(
    "/api/content-pipeline"
  );

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} lines={3} />
        ))}
      </div>
    );
  }

  const items = data?.items || [];

  if (items.length === 0) {
    return (
      <GlassCard>
        <EmptyState
          icon={FileText}
          title="No content in pipeline"
          description="Content items will appear here when added to content/queue.md"
        />
      </GlassCard>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((status) => {
        const config = statusConfig[status];
        const columnItems = items.filter((i) => i.status === status);
        const Icon = config.icon;

        return (
          <div key={status} className="flex-1 min-w-[220px]">
            {/* Column header */}
            <div className={cn("flex items-center gap-1.5 px-3 py-2 rounded-t-xl mb-2", config.bg)}>
              <Icon className={cn("w-3.5 h-3.5", config.color)} />
              <span className={cn("text-xs font-semibold", config.color)}>{config.label}</span>
              <span className="text-[10px] text-muted-foreground ml-auto">{columnItems.length}</span>
            </div>

            {/* Cards */}
            <div className="space-y-2">
              {columnItems.map((item) => (
                <GlassCard key={item.id} hover padding="sm">
                  <p className="text-xs font-medium mb-1">{item.title}</p>
                  {item.platform && (
                    <span className="inline-flex text-[9px] px-1.5 py-0.5 rounded bg-white/[0.04] text-muted-foreground mb-1.5">
                      {item.platform}
                    </span>
                  )}
                  {item.preview && (
                    <p className="text-[10px] text-muted-foreground line-clamp-2">
                      {truncate(item.preview, 120)}
                    </p>
                  )}
                  {status !== "published" && (
                    <div className="mt-2 flex items-center gap-1 text-[10px] text-primary cursor-pointer hover:underline">
                      <ArrowRight className="w-3 h-3" />
                      <span>Move to {columns[columns.indexOf(status) + 1]}</span>
                    </div>
                  )}
                </GlassCard>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
