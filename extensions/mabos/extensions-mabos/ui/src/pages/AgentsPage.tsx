import { AlertCircle, Users, Plus } from "lucide-react";
import { useState } from "react";
import { AgentCard } from "@/components/agents/AgentCard";
import { AgentFormDialog } from "@/components/agents/AgentFormDialog";
import { AgentViewSwitcher } from "@/components/agents/AgentViewSwitcher";
import { ChatBlurOverlay } from "@/components/agents/ChatBlurOverlay";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePanels } from "@/contexts/PanelContext";
import { useAgents } from "@/hooks/useAgents";
import type { AgentListResponse } from "@/lib/types";

const BUSINESS_ID = "vividwalls";

function AgentCardSkeleton() {
  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4">
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="w-10 h-10 rounded-lg" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-4 w-full" />
      </CardContent>
    </Card>
  );
}

export function AgentsPage() {
  const { data: agentsRaw, isLoading, error } = useAgents(BUSINESS_ID);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const { openDetailPanel } = usePanels();

  // The API wraps agents in { agents: [...] }
  const agentsResponse = agentsRaw as AgentListResponse | undefined;
  const agents = agentsResponse?.agents;

  return (
    <div className="relative z-10 space-y-6 pb-[255px] max-md:pb-[180px]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-lg"
            style={{
              backgroundColor: `color-mix(in srgb, var(--accent-purple) 15%, transparent)`,
            }}
          >
            <Users className="w-5 h-5 text-[var(--accent-purple)]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">Agent Management</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              {agents ? `${agents.length} agents across all departments` : "Loading agents..."}
            </p>
          </div>
        </div>
        <Button
          onClick={() => setShowCreateDialog(true)}
          className="bg-[var(--accent-green)] text-white hover:bg-[var(--accent-green)]/90 gap-1.5"
        >
          <Plus className="w-4 h-4" />
          Create Agent
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
          <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Failed to load agents</p>
            <p className="text-xs text-[var(--text-secondary)]">
              Unable to fetch agent data from the API. Please try again later.
            </p>
          </div>
        </div>
      )}

      {/* View Switcher with Tabs */}
      <AgentViewSwitcher
        agents={agents}
        isLoading={isLoading}
        onSelectAgent={(id) => openDetailPanel("agent", id, null)}
      >
        {/* Grid tab content */}
        <>
          {/* Agent Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {isLoading
              ? Array.from({ length: 8 }).map((_, i) => <AgentCardSkeleton key={i} />)
              : agents?.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onSelect={(id) => openDetailPanel("agent", id, null)}
                  />
                ))}
          </div>

          {/* Empty state */}
          {!isLoading && !error && agents && agents.length === 0 && (
            <div className="text-center py-12">
              <Users className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
              <p className="text-sm text-[var(--text-secondary)]">No agents configured yet.</p>
            </div>
          )}
        </>
      </AgentViewSwitcher>

      {/* Create Dialog */}
      <AgentFormDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        businessId={BUSINESS_ID}
      />

      {/* Blur overlay between grid and chat */}
      <ChatBlurOverlay />
    </div>
  );
}
