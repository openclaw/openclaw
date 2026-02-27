import {
  AlertCircle,
  Shield,
  Gauge,
  Pencil,
  Trash2,
  Target,
  Maximize2,
  Minimize2,
  Camera,
  UserPlus,
  Workflow,
  FolderKanban,
  BookOpen,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { AgentDeleteConfirmDialog } from "@/components/agents/AgentDeleteConfirmDialog";
import { AgentFileEditor } from "@/components/agents/AgentFileEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePanels } from "@/contexts/PanelContext";
import { useAgentDetail } from "@/hooks/useAgentDetail";
import { useCreateAgent, useUpdateAgent } from "@/hooks/useAgentMutations";
import { useAgents } from "@/hooks/useAgents";
import { useGoals } from "@/hooks/useGoals";
import { getAgentAvatar } from "@/lib/agent-avatars";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import type { AgentListResponse, AgentListItem, BusinessGoal } from "@/lib/types";

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
  { label: "Intentions", filename: "Intentions.md" },
  { label: "Goals", filename: "Goals.md" },
  { label: "Plans", filename: "Plans.md" },
  { label: "Tasks", filename: "Task.md" },
  { label: "Skills", filename: "Skill.md" },
  { label: "Actions", filename: "Actions.md" },
  { label: "Role", filename: "Role.md" },
] as const;

// OpenClaw core files
const CORE_FILES = [
  { label: "Soul", filename: "SOUL.md" },
  { label: "Memory", filename: "Memory.md" },
  { label: "Agents", filename: "AGENTS.md" },
  { label: "Tools", filename: "TOOLS.md" },
  { label: "Bootstrap", filename: "Bootstrap.md" },
  { label: "Identity", filename: "IDENTITY.md" },
] as const;

interface AgentDetailPanelProps {
  agentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetSide?: "right" | "bottom";
  mode?: "view" | "create";
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

function AgentContextSection({ agentId }: { agentId: string }) {
  const { data, isLoading } = useGoals(BUSINESS_ID);

  const agentGoals: BusinessGoal[] = data?.goals?.filter((g) => g.actor === agentId) ?? [];
  const agentWorkflows = agentGoals.flatMap((g) => g.workflows ?? []);

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
    <div className="space-y-4">
      {/* Goals */}
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
      </div>

      {/* Workflows */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Workflow className="w-3.5 h-3.5 text-[var(--accent-blue)]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Workflows ({agentWorkflows.length})
          </span>
        </div>
        {agentWorkflows.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] italic pl-5.5">
            No workflows linked to this agent&apos;s goals
          </p>
        ) : (
          <div className="space-y-1">
            {agentWorkflows.map((wf) => (
              <div
                key={wf.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-mabos)]"
              >
                <Workflow className="w-3.5 h-3.5 text-[var(--accent-blue)] shrink-0" />
                <span className="text-xs text-[var(--text-secondary)] flex-1 truncate">
                  {wf.name}
                </span>
                <Badge
                  variant="outline"
                  className="border-[var(--border-mabos)] text-[10px] px-1.5 py-0 text-[var(--text-muted)] capitalize shrink-0"
                >
                  {wf.status}
                </Badge>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {wf.steps.length} steps
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Projects */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FolderKanban className="w-3.5 h-3.5 text-[var(--accent-orange)]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Projects
          </span>
        </div>
        <p className="text-xs text-[var(--text-muted)] italic pl-5.5">
          Project assignments coming soon
        </p>
      </div>

      {/* Knowledge Topics */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <BookOpen className="w-3.5 h-3.5 text-[var(--accent-purple)]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Knowledge Topics
          </span>
        </div>
        <p className="text-xs text-[var(--text-muted)] italic pl-5.5">
          Knowledge topics coming soon
        </p>
      </div>
    </div>
  );
}

function AgentMindTab({ agentId, editable }: { agentId: string; editable: boolean }) {
  const [activeFile, setActiveFile] = useState<string>(BDI_FILES[0].filename);
  const [fileGroup, setFileGroup] = useState<"bdi" | "core">("bdi");

  const currentFiles = fileGroup === "bdi" ? BDI_FILES : CORE_FILES;
  // Ensure activeFile is valid for the current group
  const validFile = currentFiles.find((f) => f.filename === activeFile)
    ? activeFile
    : currentFiles[0].filename;

  return (
    <div className="space-y-3">
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
            <div className="rounded-lg border border-[var(--border-mabos)] overflow-hidden bg-[var(--bg-card)] min-h-[200px]">
              <AgentFileEditor agentId={agentId} filename={f.filename} editable={editable} />
            </div>
          </TabsContent>
        ))}
      </Tabs>

      {/* Agent Context Section */}
      <Separator className="bg-[var(--border-mabos)]" />
      <AgentContextSection agentId={agentId} />
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

// --- Agent Create Form (replaces AgentFormDialog for panel-based creation) ---

function AgentCreateForm({ onClose }: { onClose: () => void }) {
  const createAgent = useCreateAgent(BUSINESS_ID);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<"core" | "domain">("domain");
  const [autonomyLevel, setAutonomyLevel] = useState<"low" | "medium" | "high">("medium");
  const [threshold, setThreshold] = useState(100);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createAgent.mutate(
      {
        id: id.toLowerCase().replace(/\s+/g, "-"),
        name,
        type,
        autonomy_level: autonomyLevel,
        approval_threshold_usd: threshold,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 px-4 py-4">
      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--text-muted)]">Agent ID</label>
        <Input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="e.g., product-mgr"
          required
          className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)]"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--text-muted)]">Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Product Manager"
          required
          className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)]"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-[var(--text-muted)]">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as "core" | "domain")}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)]"
          >
            <option value="core">Core</option>
            <option value="domain">Domain</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-[var(--text-muted)]">Autonomy Level</label>
          <select
            value={autonomyLevel}
            onChange={(e) => setAutonomyLevel(e.target.value as "low" | "medium" | "high")}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)]"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--text-muted)]">
          Approval Threshold (USD)
        </label>
        <Input
          type="number"
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          min={0}
          className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)]"
        />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          className="border-[var(--border-mabos)] text-[var(--text-secondary)]"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={createAgent.isPending}
          className="bg-[var(--accent-green)] text-white hover:bg-[var(--accent-green)]/90"
        >
          {createAgent.isPending ? "Creating..." : "Create Agent"}
        </Button>
      </div>
    </form>
  );
}

// --- Inline Agent Settings Form (replaces AgentFormDialog) ---

function AgentSettingsForm({
  agent,
  businessId,
  onClose,
}: {
  agent: AgentListItem;
  businessId: string;
  onClose: () => void;
}) {
  const updateAgent = useUpdateAgent(businessId);
  const [name, setName] = useState(agent.name);
  const [type, setType] = useState<"core" | "domain">(agent.type);
  const [autonomyLevel, setAutonomyLevel] = useState<"low" | "medium" | "high">(
    agent.autonomy_level,
  );
  const [threshold, setThreshold] = useState(agent.approval_threshold_usd);
  const [status, setStatus] = useState<"active" | "idle" | "paused">(
    agent.status === "error" ? "paused" : agent.status,
  );

  // Sync form state when agent prop changes
  useEffect(() => {
    setName(agent.name);
    setType(agent.type);
    setAutonomyLevel(agent.autonomy_level);
    setThreshold(agent.approval_threshold_usd);
    setStatus(agent.status === "error" ? "paused" : agent.status);
  }, [agent]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    updateAgent.mutate(
      {
        agentId: agent.id,
        body: {
          name,
          type,
          autonomy_level: autonomyLevel,
          approval_threshold_usd: threshold,
          status,
        },
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 py-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-[var(--text-primary)]">Agent Settings</p>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          aria-label="Close settings"
        >
          <span className="text-lg leading-none">&times;</span>
        </button>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--text-muted)]">Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Product Manager"
          required
          className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)]"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-[var(--text-muted)]">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as "core" | "domain")}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)]"
          >
            <option value="core">Core</option>
            <option value="domain">Domain</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-[var(--text-muted)]">Autonomy Level</label>
          <select
            value={autonomyLevel}
            onChange={(e) => setAutonomyLevel(e.target.value as "low" | "medium" | "high")}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)]"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--text-muted)]">
          Approval Threshold (USD)
        </label>
        <Input
          type="number"
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          min={0}
          className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)]"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--text-muted)]">Status</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as "active" | "idle" | "paused")}
          className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)]"
        >
          <option value="active">Active</option>
          <option value="idle">Idle</option>
          <option value="paused">Paused</option>
        </select>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          className="border-[var(--border-mabos)] text-[var(--text-secondary)]"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={updateAgent.isPending}
          className="bg-[var(--accent-green)] text-white hover:bg-[var(--accent-green)]/90"
        >
          {updateAgent.isPending ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </form>
  );
}

// --- Avatar with upload ---

function AvatarWithUpload({
  agentId,
  avatar,
  displayName,
  Icon,
}: {
  agentId: string;
  avatar: string | undefined;
  displayName: string;
  Icon: React.ComponentType<{ className?: string }> | null;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarOverride, setAvatarOverride] = useState<string | null>(null);

  const imgSrc = avatarOverride ?? avatar;

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result as string;
      const ext = file.name.endsWith(".png") ? "png" : "jpg";
      try {
        await fetch(`/mabos/api/agents/${agentId}/avatar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: base64, ext }),
        });
        setAvatarOverride(`/mabos/api/agents/${agentId}/avatar?t=${Date.now()}`);
      } catch {
        // silently fail
      }
    };
    reader.readAsDataURL(file);
    // Reset input so the same file can be re-selected
    e.target.value = "";
  }

  return (
    <div
      className="relative group cursor-pointer shrink-0"
      onClick={() => fileInputRef.current?.click()}
    >
      {imgSrc ? (
        <img src={imgSrc} alt={displayName} className="w-48 h-48 rounded-xl object-cover" />
      ) : Icon ? (
        <div
          className="flex items-center justify-center w-48 h-48 rounded-xl"
          style={{
            backgroundColor: `color-mix(in srgb, var(--accent-purple) 15%, transparent)`,
          }}
        >
          <Icon className="w-16 h-16 text-[var(--accent-purple)]" />
        </div>
      ) : (
        <div className="w-48 h-48 rounded-xl bg-[var(--bg-secondary)]" />
      )}
      {/* Camera overlay on hover */}
      <div className="absolute inset-0 rounded-xl bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
        <Camera className="w-10 h-10 text-white" />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".jpg,.jpeg,.png"
        className="hidden"
        onChange={handleFileSelect}
      />
    </div>
  );
}

// --- Extracted Panel Content ---

type AgentPanelContentProps = {
  agentId: string | null;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  mode: "view" | "create";
};

function AgentPanelContent({
  agentId,
  isExpanded,
  onToggleExpand,
  onClose,
  mode,
}: AgentPanelContentProps) {
  const [isEditingSettings, setIsEditingSettings] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [isEditable, setIsEditable] = useState(false);

  const { isLoading: detailLoading, error: detailError } = useAgentDetail(
    mode === "view" && agentId ? agentId : "",
  );
  const { data: agentsRaw } = useAgents(BUSINESS_ID);
  const agentsResponse = agentsRaw as AgentListResponse | undefined;
  const agentListItem =
    agentId && mode === "view" ? agentsResponse?.agents?.find((a) => a.id === agentId) : undefined;

  const Icon = agentId && mode === "view" ? getAgentIcon(agentId) : null;
  const avatar = agentId && mode === "view" ? getAgentAvatar(agentId) : undefined;
  const displayName = agentId && mode === "view" ? getAgentName(agentId) : "";

  const statusColor = agentListItem
    ? (statusColors[agentListItem.status] ?? "var(--text-muted)")
    : "var(--text-muted)";

  // --- Create Mode ---
  if (mode === "create") {
    return (
      <>
        {/* Header */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-12 h-12 rounded-xl shrink-0"
              style={{
                backgroundColor: `color-mix(in srgb, var(--accent-green) 15%, transparent)`,
              }}
            >
              <UserPlus className="w-6 h-6 text-[var(--accent-green)]" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Create New Agent</h2>
              <p className="text-sm text-[var(--text-muted)]">Add a new agent to the system</p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shrink-0"
              aria-label="Close panel"
            >
              <span className="text-lg leading-none">&times;</span>
            </button>
          </div>
        </div>

        <div className="px-4 shrink-0">
          <Separator className="bg-[var(--border-mabos)]" />
        </div>

        {/* Create Form */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <AgentCreateForm onClose={onClose} />
        </div>
      </>
    );
  }

  // --- View Mode ---
  if (detailLoading) {
    return <PanelSkeleton />;
  }

  if (detailError) {
    return (
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
    );
  }

  return (
    <>
      {/* Fixed Header */}
      <div className="px-4 pt-4 pb-0 shrink-0">
        <div className="flex items-start gap-3">
          {agentId ? (
            <AvatarWithUpload
              agentId={agentId}
              avatar={avatar}
              displayName={displayName}
              Icon={Icon}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">{displayName}</h2>
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
              {agentListItem && <span className="capitalize">{agentListItem.type} agent</span>}
              {agentId && <span className="ml-2 font-mono text-xs">{agentId}</span>}
            </p>
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
              onClick={onToggleExpand}
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              aria-label={isExpanded ? "Collapse panel" : "Expand to full page"}
            >
              {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              aria-label="Close panel"
            >
              <span className="text-lg leading-none">&times;</span>
            </button>
          </div>
        </div>
      </div>

      <div className="px-4 shrink-0">
        <Separator className="bg-[var(--border-mabos)]" />
      </div>

      {/* Scrollable Content */}
      <div className="px-4 flex-1 overflow-y-auto min-h-0">
        {isEditingSettings && agentListItem ? (
          <AgentSettingsForm
            agent={agentListItem}
            businessId={BUSINESS_ID}
            onClose={() => setIsEditingSettings(false)}
          />
        ) : (
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
              {agentId && <AgentMindTab agentId={agentId} editable={isEditable} />}
            </TabsContent>

            <TabsContent value="config" className="mt-4">
              <ConfigurationTab agent={agentListItem} />
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* Fixed Footer */}
      <div className="border-t border-[var(--border-mabos)] px-4 py-3 flex gap-2 shrink-0">
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
          onClick={() => setIsEditingSettings(!isEditingSettings)}
          className={`border-[var(--border-mabos)] gap-1.5 ${isEditingSettings ? "text-[var(--accent-blue)] border-[var(--accent-blue)]/30" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
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

      {/* Dialogs rendered outside Sheet to avoid portal conflicts */}
      {agentId && (
        <>
          <AgentDeleteConfirmDialog
            open={showArchiveDialog}
            onOpenChange={setShowArchiveDialog}
            businessId={BUSINESS_ID}
            agentId={agentId}
            agentName={displayName}
            onArchived={onClose}
          />
        </>
      )}
    </>
  );
}

// --- Main Panel Export ---

export function AgentDetailPanel({
  agentId,
  open,
  onOpenChange,
  sheetSide = "right",
  mode = "view",
}: AgentDetailPanelProps) {
  const { isPanelExpanded, setIsPanelExpanded } = usePanels();

  const handleClose = () => onOpenChange(false);

  if (isPanelExpanded && open) {
    // EXPANDED MODE: fixed overlay with 50px inset
    return (
      <>
        <div className="fixed inset-0 z-50 bg-black/50" onClick={() => setIsPanelExpanded(false)} />
        <div
          className="fixed z-50 flex flex-col bg-[var(--bg-primary)] border border-[var(--border-mabos)] rounded-2xl shadow-2xl overflow-hidden"
          style={{ inset: "50px" }}
        >
          <AgentPanelContent
            agentId={agentId}
            isExpanded={true}
            onToggleExpand={() => setIsPanelExpanded(false)}
            onClose={handleClose}
            mode={mode}
          />
        </div>
      </>
    );
  }

  // SIDEBAR MODE: existing Sheet
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={sheetSide}
        showCloseButton={false}
        className={`bg-[var(--bg-primary)] ${sheetSide === "bottom" ? "h-[85vh] border-t" : "w-full sm:max-w-lg border-l"} border-[var(--border-mabos)]`}
      >
        <AgentPanelContent
          agentId={agentId}
          isExpanded={false}
          onToggleExpand={() => setIsPanelExpanded(true)}
          onClose={handleClose}
          mode={mode}
        />
      </SheetContent>
    </Sheet>
  );
}
