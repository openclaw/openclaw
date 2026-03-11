import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, Shield, Gauge, Pencil, Trash2, Target, Maximize2 } from "lucide-react";
import { useState } from "react";
import { AgentDeleteConfirmDialog } from "@/components/agents/AgentDeleteConfirmDialog";
import { AgentFileEditor } from "@/components/agents/AgentFileEditor";
import { AgentFormDialog } from "@/components/agents/AgentFormDialog";
import { BdiSummaryBar } from "@/components/agents/BdiViewer";
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
import { useGoals } from "@/hooks/useGoals";
import { getAgentAvatar } from "@/lib/agent-avatars";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import type { AgentDetail, AgentListResponse, AgentListItem, BusinessGoal } from "@/lib/types";

const BUSINESS_ID = "vividwalls";

const statusColors: Record<string, string> = {
  active: "var(--accent-green)",
  idle: "var(--accent-orange)",
  error: "var(--accent-red)",
  paused: "var(--text-muted)",
};

// BDI cognitive files with display labels
const BDI_FILES = [
  { label: "Beliefs", filename: "Beliefs.md" },
  { label: "Desires", filename: "Desires.md" },
  { label: "Goals", filename: "Goals.md" },
  { label: "Intentions", filename: "Intentions.md" },
  { label: "Plans", filename: "Plans.md" },
  { label: "Memory", filename: "Memory.md" },
  { label: "Persona", filename: "Persona.md" },
  { label: "Skills", filename: "Capabilities.md" },
  { label: "Knowledge", filename: "Knowledge.md" },
  { label: "Playbooks", filename: "Playbooks.md" },
] as const;

// OpenClaw core files
const CORE_FILES = [
  { label: "Soul", filename: "SOUL.md" },
  { label: "Agent", filename: "AGENTS.md" },
  { label: "Identity", filename: "IDENTITY.md" },
  { label: "Tools", filename: "TOOLS.md" },
] as const;

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

const priorityColors: Record<number, string> = {
  1: "var(--accent-red)",
  2: "var(--accent-orange)",
  3: "var(--accent-blue)",
};

function GoalsSection({ agentId }: { agentId: string }) {
  const { data, isLoading } = useGoals(BUSINESS_ID);

  const agentGoals: BusinessGoal[] = data?.goals?.filter(
    (g) => g.actor === agentId,
  ) ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Target className="w-3.5 h-3.5 text-[var(--accent-green)]" />
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Goals ({agentGoals.length})
        </span>
      </div>
      {agentGoals.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)] italic pl-5.5">
          No goals assigned to this agent
        </p>
      ) : (
        <div className="space-y-1">
          {agentGoals.map((goal) => (
            <div
              key={goal.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-mabos)]"
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: priorityColors[goal.priority] ?? "var(--text-muted)" }}
              />
              <span className="text-xs text-[var(--text-secondary)] flex-1 truncate">
                {goal.name}
              </span>
              <Badge
                variant="outline"
                className="border-[var(--border-mabos)] text-[10px] px-1.5 py-0 text-[var(--text-muted)] capitalize shrink-0"
              >
                {goal.level}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {/* Projects & Workflows placeholders */}
      <div className="mt-3 space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Projects & Workflows
        </p>
        <p className="text-xs text-[var(--text-muted)] italic">
          Coming soon — will show agent-specific projects and workflow assignments.
        </p>
      </div>
    </div>
  );
}

function AgentMindTab({
  agentId,
  detail,
  editable,
}: {
  agentId: string;
  detail: AgentDetail | undefined;
  editable: boolean;
}) {
  const [activeFile, setActiveFile] = useState<string>(BDI_FILES[0].filename);
  const [fileGroup, setFileGroup] = useState<"bdi" | "core">("bdi");

  function handleBdiSummaryClick(fileTab: string) {
    setFileGroup("bdi");
    setActiveFile(fileTab);
  }

  const currentFiles = fileGroup === "bdi" ? BDI_FILES : CORE_FILES;
  // Ensure activeFile is valid for the current group
  const validFile = currentFiles.find((f) => f.filename === activeFile)
    ? activeFile
    : currentFiles[0].filename;

  return (
    <div className="space-y-3">
      {/* BDI Summary Bar */}
      {detail && (
        <BdiSummaryBar agent={detail} onClickSection={handleBdiSummaryClick} />
      )}

      {/* File Group Selector */}
      <Tabs
        value={fileGroup}
        onValueChange={(v) => {
          const group = v as "bdi" | "core";
          setFileGroup(group);
          const files = group === "bdi" ? BDI_FILES : CORE_FILES;
          setActiveFile(files[0].filename);
        }}
      >
        <TabsList className="bg-[var(--bg-secondary)]">
          <TabsTrigger
            value="bdi"
            className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
          >
            BDI Files
          </TabsTrigger>
          <TabsTrigger
            value="core"
            className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
          >
            OpenClaw Core
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* File Sub-tabs (line variant) */}
      <Tabs value={validFile} onValueChange={setActiveFile}>
        <TabsList variant="line" className="flex-wrap gap-0">
          {currentFiles.map((f) => (
            <TabsTrigger
              key={f.filename}
              value={f.filename}
              className="text-xs text-[var(--text-muted)] data-[state=active]:text-[var(--text-primary)] px-2 py-1"
            >
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {currentFiles.map((f) => (
          <TabsContent key={f.filename} value={f.filename} className="mt-0">
            <div className="rounded-lg border border-[var(--border-mabos)] overflow-hidden bg-[var(--bg-card)] min-h-[200px]">
              <AgentFileEditor
                agentId={agentId}
                filename={f.filename}
                editable={editable}
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>

      {/* Goals Section */}
      <Separator className="bg-[var(--border-mabos)]" />
      <GoalsSection agentId={agentId} />
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
  const navigate = useNavigate();
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [isEditable, setIsEditable] = useState(false);

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
  const avatar = agentId ? getAgentAvatar(agentId) : undefined;
  const displayName = agentId ? getAgentName(agentId) : "";

  const statusColor = agentListItem
    ? (statusColors[agentListItem.status] ?? "var(--text-muted)")
    : "var(--text-muted)";

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side={sheetSide}
          showCloseButton={false}
          className={`bg-[var(--bg-primary)] ${sheetSide === "bottom" ? "h-[85vh] border-t" : "w-full sm:max-w-lg border-l"} border-[var(--border-mabos)]`}
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
              {/* Fixed Header */}
              <SheetHeader className="pb-0 shrink-0">
                <div className="flex items-center gap-3">
                  {avatar ? (
                    <img
                      src={avatar}
                      alt={displayName}
                      className="w-12 h-12 rounded-xl object-cover shrink-0"
                    />
                  ) : Icon ? (
                    <div
                      className="flex items-center justify-center w-12 h-12 rounded-xl shrink-0"
                      style={{
                        backgroundColor: `color-mix(in srgb, var(--accent-purple) 15%, transparent)`,
                      }}
                    >
                      <Icon className="w-6 h-6 text-[var(--accent-purple)]" />
                    </div>
                  ) : null}
                  <div className="min-w-0 flex-1">
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
                  {/* Header action buttons */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setIsEditable(!isEditable)}
                      className={`p-1.5 rounded-md transition-colors ${isEditable ? "text-[var(--accent-purple)] bg-[var(--accent-purple)]/10" : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"}`}
                      aria-label="Toggle edit mode"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        onOpenChange(false);
                        if (agentId) navigate({ to: "/agents/$agentId", params: { agentId } });
                      }}
                      className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                      aria-label="Expand to full page"
                    >
                      <Maximize2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onOpenChange(false)}
                      className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                      aria-label="Close panel"
                    >
                      <span className="text-lg leading-none">&times;</span>
                    </button>
                  </div>
                </div>
              </SheetHeader>

              <div className="px-4 shrink-0">
                <Separator className="bg-[var(--border-mabos)]" />
              </div>

              {/* Scrollable Content */}
              <div className="px-4 flex-1 overflow-y-auto min-h-0">
                <Tabs defaultValue="mind">
                  <TabsList className="bg-[var(--bg-secondary)]">
                    <TabsTrigger
                      value="mind"
                      className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
                    >
                      Agent Mind
                    </TabsTrigger>
                    <TabsTrigger
                      value="config"
                      className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
                    >
                      Configuration
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="mind" className="mt-4">
                    {agentId && (
                      <AgentMindTab
                        agentId={agentId}
                        detail={detail}
                        editable={isEditable}
                      />
                    )}
                  </TabsContent>

                  <TabsContent value="config" className="mt-4">
                    <ConfigurationTab agent={agentListItem} />
                  </TabsContent>
                </Tabs>
              </div>

              {/* Fixed Footer */}
              <SheetFooter className="border-t border-[var(--border-mabos)] flex-row gap-2 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setIsEditable(!isEditable);
                  }}
                  className={`border-[var(--border-mabos)] gap-1.5 ${isEditable ? "text-[var(--accent-purple)] border-[var(--accent-purple)]/30" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  {isEditable ? "Editing" : "Edit Files"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowEditDialog(true)}
                  className="border-[var(--border-mabos)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] gap-1.5"
                >
                  <Gauge className="w-3.5 h-3.5" />
                  Settings
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
