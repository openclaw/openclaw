"use client";

import * as React from "react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/useUIStore";
import { useNodes, useDevices, useExecApprovals } from "@/hooks/queries/useNodes";
import { useAgents } from "@/hooks/queries/useAgents";
import {
  useApproveDevice,
  useRejectDevice,
  useRotateDeviceToken,
  useRevokeDeviceToken,
  useSaveExecApprovals,
} from "@/hooks/mutations/useNodeMutations";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";

import { NodeCard } from "@/components/domain/nodes/NodeCard";
import { DeviceCard } from "@/components/domain/nodes/DeviceCard";
import {
  PolicySelectRow,
  PolicyToggleRow,
} from "@/components/domain/nodes/ExecApprovalsPolicyRow";

import type {
  ExecApprovalsAgent,
  ExecApprovalsDefaults,
} from "@/lib/api/nodes";

import {
import { RouteErrorFallback } from "@/components/composed";
  Shield,
  Server,
  Fingerprint,
  ChevronDown,
  Search,
  RefreshCw,
  Check,
  AlertTriangle,
  ListChecks,
  Pencil,
  Save,
  X,
  Plus,
  Trash2,
} from "lucide-react";

export const Route = createFileRoute("/nodes/")({
  component: NodesPage,
  errorComponent: RouteErrorFallback,
});

// ---------------------------------------------------------------------------
// Policy option definitions (shared)
// ---------------------------------------------------------------------------

const SECURITY_OPTIONS = [
  { value: "deny", label: "Deny" },
  { value: "allowlist", label: "Allowlist" },
  { value: "full", label: "Full" },
];

const ASK_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "on-miss", label: "On miss" },
  { value: "always", label: "Always" },
];

const ASK_FALLBACK_OPTIONS = [
  { value: "deny", label: "Deny" },
  { value: "allowlist", label: "Allowlist" },
  { value: "full", label: "Full" },
];

// ---------------------------------------------------------------------------
// Inline agent detail panel (replaces the sheet)
// ---------------------------------------------------------------------------

function AgentDetailInline({
  agentId,
  agentName,
  defaults,
  agentOverrides,
  onSave,
}: {
  agentId: string;
  agentName?: string;
  defaults: ExecApprovalsDefaults;
  agentOverrides: ExecApprovalsAgent;
  onSave: (agentId: string, overrides: ExecApprovalsAgent) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<ExecApprovalsAgent>({});
  const [newPattern, setNewPattern] = React.useState("");

  // Reset when agent changes or when we stop editing
  React.useEffect(() => {
    setDraft({ ...agentOverrides });
    setEditing(false);
    setNewPattern("");
  }, [agentId, agentOverrides]);

  const handleSave = () => {
    onSave(agentId, draft);
    setEditing(false);
  };

  const addPattern = () => {
    const trimmed = newPattern.trim();
    if (!trimmed) return;
    const existing = draft.allowlist ?? [];
    if (existing.some((e) => e.pattern === trimmed)) return;
    setDraft({ ...draft, allowlist: [...existing, { pattern: trimmed }] });
    setNewPattern("");
  };

  const removePattern = (index: number) => {
    const list = [...(draft.allowlist ?? [])];
    list.splice(index, 1);
    setDraft({ ...draft, allowlist: list.length > 0 ? list : undefined });
  };

  const overrideCount = [
    draft.security,
    draft.ask,
    draft.askFallback,
    draft.autoAllowSkills,
  ].filter((v) => v !== undefined).length + (draft.allowlist?.length ? 1 : 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5 text-primary" />
            {agentName ?? agentId}
          </div>
          {overrideCount > 0 && !editing && (
            <span className="text-[10px] text-muted-foreground">
              {overrideCount} override{overrideCount !== 1 ? "s" : ""}
            </span>
          )}
          {overrideCount === 0 && !editing && (
            <span className="text-[10px] text-muted-foreground">
              All inherited from defaults
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {editing ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setDraft({ ...agentOverrides });
                  setEditing(false);
                }}
              >
                <X className="h-3 w-3 mr-1" />
                Cancel
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={handleSave}>
                <Save className="h-3 w-3 mr-1" />
                Save
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3 w-3 mr-1" />
              Edit
            </Button>
          )}
        </div>
      </div>

      {/* Policy rows */}
      <div className="divide-y divide-border/50 rounded-lg border bg-card">
        <div className="px-3">
          <PolicySelectRow
            label="Security"
            description="Security mode"
            value={draft.security}
            defaultValue={defaults.security ?? "deny"}
            options={SECURITY_OPTIONS}
            onChange={(v) => setDraft({ ...draft, security: v })}
            editing={editing}
          />
        </div>
        <div className="px-3">
          <PolicySelectRow
            label="Ask"
            description="Prompt policy"
            value={draft.ask}
            defaultValue={defaults.ask ?? "on-miss"}
            options={ASK_OPTIONS}
            onChange={(v) => setDraft({ ...draft, ask: v })}
            editing={editing}
          />
        </div>
        <div className="px-3">
          <PolicySelectRow
            label="Ask fallback"
            description="When UI unavailable"
            value={draft.askFallback}
            defaultValue={defaults.askFallback ?? "deny"}
            options={ASK_FALLBACK_OPTIONS}
            onChange={(v) => setDraft({ ...draft, askFallback: v })}
            editing={editing}
          />
        </div>
        <div className="px-3">
          <PolicyToggleRow
            label="Auto-allow skill CLIs"
            description="Allow skill-listed executables"
            value={draft.autoAllowSkills}
            defaultValue={defaults.autoAllowSkills ?? false}
            onChange={(v) => setDraft({ ...draft, autoAllowSkills: v })}
            editing={editing}
          />
        </div>
      </div>

      {/* Allowlist */}
      <div>
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-2">
          <ListChecks className="h-3 w-3" />
          Allowlist
        </div>
        <div className="space-y-1.5">
          <AnimatePresence initial={false}>
            {(draft.allowlist ?? []).map((entry, i) => (
              <motion.div
                key={entry.pattern + i}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-center gap-2"
              >
                <code className="flex-1 text-xs bg-muted/50 px-2 py-1 rounded font-mono truncate">
                  {entry.pattern}
                </code>
                {editing && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0 text-destructive/70 hover:text-destructive"
                    onClick={() => removePattern(i)}
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </Button>
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {editing && (
            <div className="flex items-center gap-2 pt-1">
              <Input
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                placeholder="e.g. git *"
                className="h-7 text-xs font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPattern();
                  }
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={addPattern}
                disabled={!newPattern.trim()}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add
              </Button>
            </div>
          )}

          {!editing && (draft.allowlist ?? []).length === 0 && (
            <div className="text-xs text-muted-foreground italic">
              No patterns
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact defaults editor (accordion-style)
// ---------------------------------------------------------------------------

function CompactDefaultsEditor({
  defaults,
  onSave,
}: {
  defaults: ExecApprovalsDefaults;
  onSave: (defaults: ExecApprovalsDefaults) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<ExecApprovalsDefaults>({});

  React.useEffect(() => {
    setDraft({ ...defaults });
  }, [defaults]);

  const handleSave = () => {
    onSave(draft);
    setEditing(false);
  };

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Defaults
          </span>
          {/* Quick summary when collapsed */}
          {!open && (
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">
                {defaults.security ?? "deny"}
              </Badge>
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">
                ask: {defaults.ask ?? "on-miss"}
              </Badge>
            </div>
          )}
        </div>
        <motion.div
          animate={{ rotate: open ? 0 : -90 }}
          transition={{ duration: 0.15 }}
        >
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </motion.div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-2">
              {/* Edit controls */}
              <div className="flex items-center justify-end gap-1.5">
                {editing ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[10px]"
                      onClick={() => {
                        setDraft({ ...defaults });
                        setEditing(false);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" className="h-6 text-[10px]" onClick={handleSave}>
                      Save
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-[10px]"
                    onClick={() => setEditing(true)}
                  >
                    <Pencil className="h-2.5 w-2.5 mr-1" />
                    Edit
                  </Button>
                )}
              </div>

              <div className="divide-y divide-border/50">
                <PolicySelectRow
                  label="Security"
                  description="Default security mode"
                  value={draft.security}
                  defaultValue="deny"
                  options={SECURITY_OPTIONS}
                  onChange={(v) => setDraft({ ...draft, security: v ?? "deny" })}
                  editing={editing}
                />
                <PolicySelectRow
                  label="Ask"
                  description="Default prompt policy"
                  value={draft.ask}
                  defaultValue="on-miss"
                  options={ASK_OPTIONS}
                  onChange={(v) => setDraft({ ...draft, ask: v ?? "on-miss" })}
                  editing={editing}
                />
                <PolicySelectRow
                  label="Ask fallback"
                  description="When UI unavailable"
                  value={draft.askFallback}
                  defaultValue="deny"
                  options={ASK_FALLBACK_OPTIONS}
                  onChange={(v) => setDraft({ ...draft, askFallback: v ?? "deny" })}
                  editing={editing}
                />
                <PolicyToggleRow
                  label="Auto-allow skill CLIs"
                  description="Allow skill-listed executables"
                  value={draft.autoAllowSkills}
                  defaultValue={false}
                  onChange={(v) => setDraft({ ...draft, autoAllowSkills: v ?? false })}
                  editing={editing}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending device card
// ---------------------------------------------------------------------------

function PendingDeviceCard({
  device,
  onApprove,
  onReject,
}: {
  device: { requestId: string; deviceId: string; displayName?: string; role?: string };
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-2">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
          <div>
            <div className="text-sm font-medium">
              {device.displayName ?? "Unknown device"}
            </div>
            <code className="text-[10px] text-muted-foreground font-mono">
              {device.deviceId.slice(0, 12)}...
            </code>
          </div>
        </div>
        {device.role && (
          <Badge variant="outline" className="text-[10px]">
            {device.role}
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px]"
          onClick={() => onReject(device.requestId)}
        >
          Reject
        </Button>
        <Button
          size="sm"
          className="h-6 text-[10px]"
          onClick={() => onApprove(device.requestId)}
        >
          <Check className="h-3 w-3 mr-1" />
          Approve
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type PageTab = "permissions" | "nodes" | "devices";

function NodesPage() {
  const powerUserMode = useUIStore((s) => s.powerUserMode);

  // Tab
  const [activeTab, setActiveTab] = React.useState<PageTab>("permissions");

  // Approvals target
  const [approvalsTarget, setApprovalsTarget] = React.useState<"gateway" | "node">("gateway");
  const [approvalsNodeId, setApprovalsNodeId] = React.useState<string | undefined>(undefined);

  // Data queries
  const nodesQuery = useNodes();
  const devicesQuery = useDevices();
  const approvalsQuery = useExecApprovals(
    approvalsTarget,
    approvalsTarget === "node" ? approvalsNodeId : undefined,
  );
  const agentsQuery = useAgents();

  // Mutations
  const approveDeviceMut = useApproveDevice();
  const rejectDeviceMut = useRejectDevice();
  const rotateToken = useRotateDeviceToken();
  const revokeToken = useRevokeDeviceToken();
  const saveApprovals = useSaveExecApprovals();

  // Local state
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(null);
  const [agentSearch, setAgentSearch] = React.useState("");
  const [confirmRevoke, setConfirmRevoke] = React.useState<{
    deviceId: string;
    role: string;
  } | null>(null);

  // Derived data (computed before conditional return so hooks stay unconditional)
  const nodes = nodesQuery.data ?? [];
  const devices = devicesQuery.data ?? { pending: [], paired: [] };
  const snapshot = approvalsQuery.data;
  const file = snapshot?.file ?? {};
  const defaults: ExecApprovalsDefaults = file.defaults ?? {};
  const agentApprovals = file.agents ?? {};
  const agents = agentsQuery.data ?? [];

  const targetableNodes = nodes.filter((n) => n.caps.includes("exec") && n.connected);

  // Agent IDs
  const allAgentIds = React.useMemo(() => {
    const ids = new Set<string>();
    agents.forEach((a) => ids.add(a.id));
    Object.keys(agentApprovals).forEach((id) => ids.add(id));
    return Array.from(ids).sort();
  }, [agents, agentApprovals]);

  const filteredAgentIds = React.useMemo(() => {
    if (!agentSearch.trim()) return allAgentIds;
    const q = agentSearch.toLowerCase();
    return allAgentIds.filter((id) => {
      const name = agents.find((a) => a.id === id)?.name ?? id;
      return id.toLowerCase().includes(q) || name.toLowerCase().includes(q);
    });
  }, [allAgentIds, agentSearch, agents]);

  // Auto-select first agent if none selected
  React.useEffect(() => {
    if (!selectedAgentId && filteredAgentIds.length > 0) {
      setSelectedAgentId(filteredAgentIds[0]);
    }
  }, [selectedAgentId, filteredAgentIds]);

  const selectedAgentOverrides: ExecApprovalsAgent =
    selectedAgentId ? (agentApprovals[selectedAgentId] ?? {}) : {};

  // Gate: redirect if power user mode is off
  if (!powerUserMode) {
    return <Navigate to="/" />;
  }

  // Handlers
  const handleSaveDefaults = (newDefaults: ExecApprovalsDefaults) => {
    if (!snapshot) return;
    saveApprovals.mutate({
      file: { ...file, defaults: newDefaults },
      hash: snapshot.hash,
      target: approvalsTarget,
      nodeId: approvalsTarget === "node" ? approvalsNodeId : undefined,
    });
  };

  const handleSaveAgentOverrides = (agentId: string, overrides: ExecApprovalsAgent) => {
    if (!snapshot) return;
    const updatedAgents = { ...agentApprovals };
    const isEmpty =
      overrides.security === undefined &&
      overrides.ask === undefined &&
      overrides.askFallback === undefined &&
      overrides.autoAllowSkills === undefined &&
      (!overrides.allowlist || overrides.allowlist.length === 0);
    if (isEmpty) {
      delete updatedAgents[agentId];
    } else {
      updatedAgents[agentId] = overrides;
    }
    saveApprovals.mutate({
      file: { ...file, agents: updatedAgents },
      hash: snapshot.hash,
      target: approvalsTarget,
      nodeId: approvalsTarget === "node" ? approvalsNodeId : undefined,
    });
  };

  const isLoading =
    nodesQuery.isLoading || devicesQuery.isLoading || approvalsQuery.isLoading;

  const pendingCount = devices.pending.length;

  return (
    <div className="bg-background text-foreground">
      <div className="max-w-5xl mx-auto px-6 py-6">
        {/* Page header - compact */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              Nodes & Permissions
            </h1>
            <p className="text-xs text-muted-foreground">
              Execution policies, connected nodes, and devices.
            </p>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => {
                    nodesQuery.refetch();
                    devicesQuery.refetch();
                    approvalsQuery.refetch();
                  }}
                >
                  <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh all</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as PageTab)}
        >
          <TabsList variant="line" className="mb-4">
            <TabsTrigger value="permissions" className="gap-1.5">
              <Shield className="h-3.5 w-3.5" />
              Permissions
              {allAgentIds.length > 0 && (
                <Badge variant="secondary" className="text-[9px] h-4 px-1 ml-0.5">
                  {allAgentIds.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="nodes" className="gap-1.5">
              <Server className="h-3.5 w-3.5" />
              Nodes
              {nodes.length > 0 && (
                <Badge variant="secondary" className="text-[9px] h-4 px-1 ml-0.5">
                  {nodes.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="devices" className="gap-1.5">
              <Fingerprint className="h-3.5 w-3.5" />
              Devices
              {(devices.paired.length > 0 || pendingCount > 0) && (
                <Badge
                  variant={pendingCount > 0 ? "warning" : "secondary"}
                  className="text-[9px] h-4 px-1 ml-0.5"
                >
                  {pendingCount > 0
                    ? `${pendingCount} pending`
                    : devices.paired.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-64 w-full rounded-lg" />
            </div>
          ) : (
            <>
              {/* ==========================================================
                  Permissions tab: master-detail split
                  ========================================================== */}
              <TabsContent value="permissions">
                <div className="space-y-3">
                  {/* Target selector */}
                  {targetableNodes.length > 0 && (
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-muted-foreground shrink-0">Target:</span>
                      <Select
                        value={
                          approvalsTarget === "node" && approvalsNodeId
                            ? `node:${approvalsNodeId}`
                            : "gateway"
                        }
                        onValueChange={(v) => {
                          if (v === "gateway") {
                            setApprovalsTarget("gateway");
                            setApprovalsNodeId(undefined);
                          } else {
                            setApprovalsTarget("node");
                            setApprovalsNodeId(v.replace("node:", ""));
                          }
                        }}
                      >
                        <SelectTrigger className="h-7 text-xs w-[160px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="gateway">Gateway</SelectItem>
                          {targetableNodes.map((n) => (
                            <SelectItem key={n.nodeId} value={`node:${n.nodeId}`}>
                              {n.displayName ?? n.nodeId}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Defaults accordion */}
                  <CompactDefaultsEditor defaults={defaults} onSave={handleSaveDefaults} />

                  {/* Master-detail: agent list + inline detail */}
                  <div className="flex gap-4 min-h-[400px]">
                    {/* Agent list (left) */}
                    <div className="w-56 shrink-0 space-y-2">
                      {allAgentIds.length > 5 && (
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                          <Input
                            value={agentSearch}
                            onChange={(e) => setAgentSearch(e.target.value)}
                            placeholder="Filter..."
                            className="h-7 pl-7 text-xs"
                          />
                        </div>
                      )}
                      <ScrollArea className="h-[400px]">
                        <div className="space-y-0.5 pr-2">
                          {filteredAgentIds.length === 0 && (
                            <div className="p-3 text-center text-xs text-muted-foreground">
                              {agentSearch ? "No match" : "No agents"}
                            </div>
                          )}
                          {filteredAgentIds.map((id) => {
                            const name = agents.find((a) => a.id === id)?.name;
                            const overrides = agentApprovals[id] ?? {};
                            const overrideCount = [
                              overrides.security,
                              overrides.ask,
                              overrides.askFallback,
                              overrides.autoAllowSkills,
                            ].filter((v) => v !== undefined).length +
                              ((overrides.allowlist ?? []).length > 0 ? 1 : 0);
                            const isSelected = selectedAgentId === id;

                            return (
                              <button
                                key={id}
                                type="button"
                                onClick={() => setSelectedAgentId(id)}
                                className={cn(
                                  "flex items-center justify-between w-full px-2.5 py-2 rounded-md text-left text-xs transition-colors",
                                  isSelected
                                    ? "bg-primary/10 text-foreground"
                                    : "hover:bg-muted/50 text-foreground/80",
                                )}
                              >
                                <div className="min-w-0">
                                  <div className="font-medium truncate">
                                    {name ?? id}
                                  </div>
                                  {name && (
                                    <div className="text-[10px] text-muted-foreground font-mono truncate">
                                      {id}
                                    </div>
                                  )}
                                </div>
                                {overrideCount > 0 ? (
                                  <Badge variant="secondary" className="text-[9px] h-4 px-1 shrink-0 ml-1">
                                    {overrideCount}
                                  </Badge>
                                ) : (
                                  <span className="text-[9px] text-muted-foreground/50 shrink-0 ml-1">
                                    default
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </ScrollArea>
                    </div>

                    {/* Detail panel (right) */}
                    <div className="flex-1 min-w-0">
                      {selectedAgentId ? (
                        <AnimatePresence mode="wait">
                          <motion.div
                            key={selectedAgentId}
                            initial={{ opacity: 0, x: 8 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -8 }}
                            transition={{ duration: 0.15 }}
                          >
                            <AgentDetailInline
                              agentId={selectedAgentId}
                              agentName={agents.find((a) => a.id === selectedAgentId)?.name}
                              defaults={defaults}
                              agentOverrides={selectedAgentOverrides}
                              onSave={handleSaveAgentOverrides}
                            />
                          </motion.div>
                        </AnimatePresence>
                      ) : (
                        <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                          Select an agent to view permissions
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* ==========================================================
                  Nodes tab
                  ========================================================== */}
              <TabsContent value="nodes">
                {nodes.length === 0 ? (
                  <div className="rounded-lg border bg-card p-8 text-center">
                    <Server className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">No nodes connected</p>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {nodes.map((node) => (
                      <NodeCard key={node.nodeId} node={node} />
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* ==========================================================
                  Devices tab
                  ========================================================== */}
              <TabsContent value="devices">
                <div className="space-y-4">
                  {/* Pending */}
                  {pendingCount > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <AlertTriangle className="h-3 w-3 text-warning" />
                        Pending Requests
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {devices.pending.map((d) => (
                          <PendingDeviceCard
                            key={d.requestId}
                            device={d}
                            onApprove={(id) => approveDeviceMut.mutate(id)}
                            onReject={(id) => rejectDeviceMut.mutate(id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Paired */}
                  {devices.paired.length === 0 && pendingCount === 0 ? (
                    <div className="rounded-lg border bg-card p-8 text-center">
                      <Fingerprint className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">No paired devices</p>
                    </div>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {devices.paired.map((d) => (
                        <DeviceCard
                          key={d.deviceId}
                          device={d}
                          onRotateToken={(deviceId, role, scopes) =>
                            rotateToken.mutate({ deviceId, role, scopes })
                          }
                          onRevokeToken={(deviceId, role) =>
                            setConfirmRevoke({ deviceId, role })
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>
            </>
          )}
        </Tabs>

        {/* Revoke Confirmation Dialog */}
        <Dialog
          open={!!confirmRevoke}
          onOpenChange={(open) => {
            if (!open) setConfirmRevoke(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Revoke Token</DialogTitle>
              <DialogDescription>
                Are you sure you want to revoke this{" "}
                <span className="font-medium text-foreground">{confirmRevoke?.role}</span>{" "}
                token? The device will need to re-authenticate.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmRevoke(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (confirmRevoke) {
                    revokeToken.mutate(confirmRevoke);
                    setConfirmRevoke(null);
                  }
                }}
              >
                Revoke
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
