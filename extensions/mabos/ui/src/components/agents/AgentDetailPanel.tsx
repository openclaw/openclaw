import { AlertCircle, Shield, Gauge, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { AgentDeleteConfirmDialog } from "@/components/agents/AgentDeleteConfirmDialog";
import { AgentFormDialog } from "@/components/agents/AgentFormDialog";
import { BdiViewer } from "@/components/agents/BdiViewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentDetail } from "@/hooks/useAgentDetail";
import { useAgents } from "@/hooks/useAgents";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import type { AgentDetail, AgentListResponse, AgentListItem } from "@/lib/types";

const BUSINESS_ID = "vividwalls";

const statusColors: Record<string, string> = {
  active: "var(--accent-green)",
  idle: "var(--accent-orange)",
  error: "var(--accent-red)",
  paused: "var(--text-muted)",
};

interface AgentDetailPanelProps {
  agentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetSide?: "right" | "bottom";
}

function PanelSkeleton() {
  return (
    <div className="space-y-6 px-4">
      <div className="flex items-center gap-4">
        <Skeleton className="w-12 h-12 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>
      <Skeleton className="h-10 w-full" />
      <div className="space-y-3">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    </div>
  );
}

function ConfigurationTab({ agent }: { agent: AgentListItem | undefined }) {
  if (!agent) {
    return (
      <p className="text-sm text-[var(--text-muted)] italic">Configuration data unavailable.</p>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4">
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-md"
              style={{
                backgroundColor: `color-mix(in srgb, var(--accent-blue) 15%, transparent)`,
              }}
            >
              <Gauge className="w-4 h-4 text-[var(--accent-blue)]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">Autonomy Level</p>
              <p className="text-xs text-[var(--text-muted)]">
                Determines how independently the agent operates
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 pl-11">
            <Badge
              variant="outline"
              className="border-[var(--border-mabos)] text-[var(--text-secondary)] capitalize"
            >
              {agent.autonomy_level}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4">
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-md"
              style={{
                backgroundColor: `color-mix(in srgb, var(--accent-green) 15%, transparent)`,
              }}
            >
              <Shield className="w-4 h-4 text-[var(--accent-green)]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">Approval Threshold</p>
              <p className="text-xs text-[var(--text-muted)]">
                Maximum USD amount this agent can approve without escalation
              </p>
            </div>
          </div>
          <div className="pl-11">
            <p className="text-lg font-semibold text-[var(--accent-green)]">
              ${(agent.approval_threshold_usd ?? 0).toLocaleString()}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4">
        <CardContent className="space-y-3">
          <p className="text-sm font-medium text-[var(--text-primary)]">Agent Properties</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <p className="text-xs text-[var(--text-muted)]">ID</p>
              <p className="text-sm text-[var(--text-secondary)] font-mono">{agent.id}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-[var(--text-muted)]">Type</p>
              <p className="text-sm text-[var(--text-secondary)] capitalize">{agent.type}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-[var(--text-muted)]">Status</p>
              <p className="text-sm text-[var(--text-secondary)] capitalize">{agent.status}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-[var(--text-muted)]">Name</p>
              <p className="text-sm text-[var(--text-secondary)]">{agent.name}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function AgentDetailPanel({
  agentId,
  open,
  onOpenChange,
  sheetSide = "right",
}: AgentDetailPanelProps) {
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);

  const {
    data: detailRaw,
    isLoading: detailLoading,
    error: detailError,
  } = useAgentDetail(agentId ?? "");
  const { data: agentsRaw } = useAgents(BUSINESS_ID);

  const detail = detailRaw as AgentDetail | undefined;
  const agentsResponse = agentsRaw as AgentListResponse | undefined;
  const agentListItem = agentId ? agentsResponse?.agents?.find((a) => a.id === agentId) : undefined;

  const Icon = agentId ? getAgentIcon(agentId) : null;
  const displayName = agentId ? getAgentName(agentId) : "";

  const statusColor = agentListItem
    ? (statusColors[agentListItem.status] ?? "var(--text-muted)")
    : "var(--text-muted)";

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side={sheetSide}
          className={`bg-[var(--bg-primary)] overflow-y-auto ${sheetSide === "bottom" ? "h-[85vh] border-t" : "w-full sm:max-w-lg border-l"} border-[var(--border-mabos)]`}
        >
          {detailLoading ? (
            <PanelSkeleton />
          ) : detailError ? (
            <div className="flex items-center gap-3 p-4 mx-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
              <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  Failed to load agent detail
                </p>
                <p className="text-xs text-[var(--text-secondary)]">
                  Unable to fetch data for agent &quot;{agentId}&quot;.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Header */}
              <SheetHeader className="pb-0">
                <div className="flex items-center gap-3">
                  {Icon && (
                    <div
                      className="flex items-center justify-center w-12 h-12 rounded-xl shrink-0"
                      style={{
                        backgroundColor: `color-mix(in srgb, var(--accent-purple) 15%, transparent)`,
                      }}
                    >
                      <Icon className="w-6 h-6 text-[var(--accent-purple)]" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <SheetTitle className="text-lg text-[var(--text-primary)]">
                        {displayName}
                      </SheetTitle>
                      {agentListItem && (
                        <Badge
                          variant="outline"
                          className="border-[var(--border-mabos)] text-[var(--text-secondary)] text-[10px] px-1.5 py-0 gap-1.5 shrink-0"
                        >
                          <span
                            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ backgroundColor: statusColor }}
                          />
                          {agentListItem.status}
                        </Badge>
                      )}
                    </div>
                    <SheetDescription className="text-[var(--text-muted)]">
                      {agentListItem && (
                        <span className="capitalize">{agentListItem.type} agent</span>
                      )}
                      {agentId && <span className="ml-2 font-mono text-xs">{agentId}</span>}
                    </SheetDescription>
                  </div>
                </div>
              </SheetHeader>

              <div className="px-4">
                <Separator className="bg-[var(--border-mabos)]" />
              </div>

              {/* Tabs */}
              <div className="px-4 flex-1">
                <Tabs defaultValue="bdi">
                  <TabsList className="bg-[var(--bg-secondary)]">
                    <TabsTrigger
                      value="bdi"
                      className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
                    >
                      BDI State
                    </TabsTrigger>
                    <TabsTrigger
                      value="config"
                      className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
                    >
                      Configuration
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="bdi" className="mt-4">
                    {detail ? (
                      <BdiViewer agent={detail} />
                    ) : (
                      <p className="text-sm text-[var(--text-muted)] italic">
                        BDI data unavailable.
                      </p>
                    )}
                  </TabsContent>

                  <TabsContent value="config" className="mt-4">
                    <ConfigurationTab agent={agentListItem} />
                  </TabsContent>
                </Tabs>
              </div>

              {/* Footer with actions */}
              <SheetFooter className="border-t border-[var(--border-mabos)] flex-row gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowEditDialog(true)}
                  className="border-[var(--border-mabos)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] gap-1.5"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowArchiveDialog(true)}
                  className="border-[var(--accent-red)]/30 text-[var(--accent-red)] hover:bg-[var(--accent-red)]/10 gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Archive
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Dialogs rendered outside Sheet to avoid portal conflicts */}
      {agentId && (
        <>
          <AgentFormDialog
            open={showEditDialog}
            onOpenChange={setShowEditDialog}
            businessId={BUSINESS_ID}
            agent={agentListItem}
          />
          <AgentDeleteConfirmDialog
            open={showArchiveDialog}
            onOpenChange={setShowArchiveDialog}
            businessId={BUSINESS_ID}
            agentId={agentId}
            agentName={displayName}
            onArchived={() => onOpenChange(false)}
          />
        </>
      )}
    </>
  );
}
