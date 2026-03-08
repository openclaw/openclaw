"use client";

import { useAutoRefresh } from "@/hooks/use-auto-refresh";
import { GlassCard } from "@/components/ui/glass-card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { Users, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Client } from "@/lib/types";

const pipelineStages = [
  { id: "prospect", label: "Prospect", color: "text-zinc-400", bg: "bg-zinc-500/10" },
  { id: "contacted", label: "Contacted", color: "text-blue-400", bg: "bg-blue-500/10" },
  { id: "meeting", label: "Meeting", color: "text-amber-400", bg: "bg-amber-500/10" },
  { id: "proposal", label: "Proposal", color: "text-purple-400", bg: "bg-purple-500/10" },
  { id: "active", label: "Active", color: "text-emerald-400", bg: "bg-emerald-500/10" },
] as const;

export function CrmView() {
  const { data: clients, loading } = useAutoRefresh<Client[]>("/api/clients");

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} lines={2} />
        ))}
      </div>
    );
  }

  const allClients = clients || [];

  if (allClients.length === 0) {
    return (
      <GlassCard>
        <EmptyState
          icon={Users}
          title="No clients in pipeline"
          description="Add client files to ~/.openclaw/workspace/clients/ to populate the CRM."
        />
      </GlassCard>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {pipelineStages.map((stage) => {
        const stageClients = allClients.filter((c) => c.status === stage.id);
        return (
          <div key={stage.id} className="flex-1 min-w-[180px]">
            <div className={cn("flex items-center gap-1.5 px-3 py-2 rounded-t-xl mb-2", stage.bg)}>
              <span className={cn("text-xs font-semibold", stage.color)}>{stage.label}</span>
              <span className="text-[10px] text-muted-foreground ml-auto">{stageClients.length}</span>
            </div>
            <div className="space-y-2">
              {stageClients.map((client) => (
                <GlassCard key={client.id} hover padding="sm">
                  <p className="text-xs font-medium">{client.name}</p>
                  {client.contacts?.[0] && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">{client.contacts[0]}</p>
                  )}
                  {client.nextAction && (
                    <p className="text-[10px] text-primary mt-1 flex items-center gap-0.5">
                      <ArrowRight className="w-3 h-3" />
                      {client.nextAction}
                    </p>
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
