import { useNavigate, useParams } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, Shield, Gauge, Pencil, Trash2, Target } from "lucide-react";
import { useState } from "react";
import { AgentDeleteConfirmDialog } from "@/components/agents/AgentDeleteConfirmDialog";
import { AgentFileEditor } from "@/components/agents/AgentFileEditor";
import { AgentFormDialog } from "@/components/agents/AgentFormDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useActiveBusinessId } from "@/contexts/BusinessContext";
import { useAgentDetail } from "@/hooks/useAgentDetail";
import { useAgents } from "@/hooks/useAgents";
import { useGoals } from "@/hooks/useGoals";
import { getAgentAvatar } from "@/lib/agent-avatars";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import type { AgentListResponse, AgentListItem, BusinessGoal } from "@/lib/types";

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

const tabTriggerClass =
  "text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]";

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="w-14 h-14 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <Skeleton className="h-10 w-64" />
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

function GoalsSection({ agentId, businessId }: { agentId: string; businessId: string }) {
  const { data, isLoading } = useGoals(businessId);

  const agentGoals: BusinessGoal[] = data?.goals?.filter((g) => g.actor === agentId) ?? [];

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
                style={{
                  backgroundColor: priorityColors[goal.priority] ?? "var(--text-muted)",
                }}
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
    </div>
  );
}

function AgentMindTab({
  agentId,
  editable,
  businessId,
}: {
  agentId: string;
  editable: boolean;
  businessId: string;
}) {
  const [activeFile, setActiveFile] = useState<string>(BDI_FILES[0].filename);
  const [fileGroup, setFileGroup] = useState<"bdi" | "core">("bdi");

  const currentFiles = fileGroup === "bdi" ? BDI_FILES : CORE_FILES;
  const validFile = currentFiles.find((f) => f.filename === activeFile)
    ? activeFile
    : currentFiles[0].filename;

  return (
    <div className="space-y-4">
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
          <TabsTrigger value="bdi" className={tabTriggerClass}>
            BDI Files
          </TabsTrigger>
          <TabsTrigger value="core" className={tabTriggerClass}>
            OpenClaw Core
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* File Sub-tabs */}
      <Tabs value={validFile} onValueChange={setActiveFile}>
        <TabsList variant="line" className="overflow-x-auto flex-nowrap gap-0 scrollbar-hide">
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
            <div className="rounded-lg border border-[var(--border-mabos)] overflow-hidden bg-[var(--bg-card)] min-h-[300px]">
              <AgentFileEditor agentId={agentId} filename={f.filename} editable={editable} />
            </div>
          </TabsContent>
        ))}
      </Tabs>

      {/* Goals Section */}
      <Separator className="bg-[var(--border-mabos)]" />
      <GoalsSection agentId={agentId} businessId={businessId} />
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

export function AgentDetailPage() {
  const businessId = useActiveBusinessId();
  const navigate = useNavigate();
  const { agentId } = useParams({ strict: false }) as { agentId: string };
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [isEditable, setIsEditable] = useState(false);

  const { isLoading: detailLoading, error: detailError } = useAgentDetail(agentId);

  const { data: agentsRaw } = useAgents(businessId);
  const agentsResponse = agentsRaw as AgentListResponse | undefined;
  const agentListItem = agentsResponse?.agents?.find((a) => a.id === agentId);

  const Icon = getAgentIcon(agentId);
  const avatar = getAgentAvatar(agentId);
  const displayName = getAgentName(agentId);

  const statusColor = agentListItem
    ? agentListItem.status === "active"
      ? "var(--accent-green)"
      : agentListItem.status === "error"
        ? "var(--accent-red)"
        : agentListItem.status === "idle"
          ? "var(--accent-orange)"
          : "var(--text-muted)"
    : "var(--text-muted)";

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button
        variant="ghost"
        className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] -ml-2 gap-2"
        onClick={() => navigate({ to: "/agents" })}
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Agents
      </Button>

      {detailLoading ? (
        <DetailSkeleton />
      ) : detailError ? (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
          <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Failed to load agent detail
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Unable to fetch data for agent &quot;{agentId}&quot;. Please try again later.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Agent Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {avatar ? (
                <img src={avatar} alt={displayName} className="w-14 h-14 rounded-xl object-cover" />
              ) : (
                <div
                  className="flex items-center justify-center w-14 h-14 rounded-xl"
                  style={{
                    backgroundColor: `color-mix(in srgb, var(--accent-purple) 15%, transparent)`,
                  }}
                >
                  <Icon className="w-7 h-7 text-[var(--accent-purple)]" />
                </div>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-bold text-[var(--text-primary)]">{displayName}</h1>
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
                <p className="text-sm text-[var(--text-muted)]">
                  Agent ID: <span className="font-mono">{agentId}</span>
                  {agentListItem && (
                    <span className="ml-3 capitalize">{agentListItem.type} agent</span>
                  )}
                </p>
              </div>
            </div>

            {/* Edit / Archive buttons */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsEditable(!isEditable)}
                className={`gap-1.5 ${isEditable ? "border-[var(--accent-purple)]/30 text-[var(--accent-purple)]" : "border-[var(--border-mabos)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
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
            </div>
          </div>

          <Separator className="bg-[var(--border-mabos)]" />

          {/* Tabs */}
          <Tabs defaultValue="mind">
            <TabsList className="bg-[var(--bg-secondary)]">
              <TabsTrigger value="mind" className={tabTriggerClass}>
                Agent Mind
              </TabsTrigger>
              <TabsTrigger value="config" className={tabTriggerClass}>
                Configuration
              </TabsTrigger>
            </TabsList>

            <TabsContent value="mind" className="mt-4">
              <AgentMindTab agentId={agentId} editable={isEditable} businessId={businessId} />
            </TabsContent>

            <TabsContent value="config" className="mt-4">
              <ConfigurationTab agent={agentListItem} />
            </TabsContent>
          </Tabs>
        </>
      )}

      {/* Dialogs */}
      <AgentFormDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        businessId={businessId}
        agent={agentListItem}
      />
      <AgentDeleteConfirmDialog
        open={showArchiveDialog}
        onOpenChange={setShowArchiveDialog}
        businessId={businessId}
        agentId={agentId}
        agentName={displayName}
        onArchived={() => navigate({ to: "/agents" })}
      />
    </div>
  );
}
