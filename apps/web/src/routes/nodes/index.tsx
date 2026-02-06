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

import { NodeCard } from "@/components/domain/nodes/NodeCard";
import { DeviceCard } from "@/components/domain/nodes/DeviceCard";
import { DefaultsEditor } from "@/components/domain/nodes/DefaultsEditor";
import { AgentPermissionsSheet } from "@/components/domain/nodes/AgentPermissionsSheet";
import { InheritedBadge } from "@/components/domain/nodes/InheritedValue";

import type {
  ExecApprovalsAgent,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
} from "@/lib/api/nodes";

import {
  Shield,
  Server,
  Fingerprint,
  ChevronDown,
  ChevronRight,
  Search,
  RefreshCw,
  Check,
  AlertTriangle,
  ListChecks,
} from "lucide-react";

export const Route = createFileRoute("/nodes/")({
  component: NodesPage,
});

// ---------------------------------------------------------------------------
// Collapsible section helper
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title,
  description,
  icon: Icon,
  count,
  defaultOpen = true,
  children,
  action,
}: {
  title: string;
  description: string;
  icon: React.ElementType;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-3 w-full text-left group"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 shrink-0">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {count !== undefined && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                {count}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {action && (
          <div
            className="shrink-0"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {action}
          </div>
        )}
        <motion.div
          animate={{ rotate: open ? 0 : -90 }}
          transition={{ duration: 0.15 }}
          className="shrink-0"
        >
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </motion.div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Agent permission summary row (click to open sheet)
// ---------------------------------------------------------------------------

function AgentPermissionRow({
  agentId,
  agentName,
  defaults,
  overrides,
  onClick,
}: {
  agentId: string;
  agentName?: string;
  defaults: ExecApprovalsDefaults;
  overrides: ExecApprovalsAgent;
  onClick: () => void;
}) {
  const hasSecurity = overrides.security !== undefined;
  const hasAsk = overrides.ask !== undefined;
  const hasAskFallback = overrides.askFallback !== undefined;
  const hasAutoAllow = overrides.autoAllowSkills !== undefined;
  const hasAllowlist = (overrides.allowlist ?? []).length > 0;

  const overrideCount = [hasSecurity, hasAsk, hasAskFallback, hasAutoAllow, hasAllowlist].filter(
    Boolean,
  ).length;

  const effectiveSecurity = overrides.security ?? defaults.security ?? "deny";
  const effectiveAsk = overrides.ask ?? defaults.ask ?? "on-miss";

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between w-full py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors text-left group"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="h-7 w-7 rounded-md bg-muted flex items-center justify-center shrink-0">
          <span className="text-xs font-medium text-muted-foreground">
            {(agentName ?? agentId).charAt(0).toUpperCase()}
          </span>
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">
            {agentName ?? agentId}
          </div>
          <div className="text-[10px] text-muted-foreground font-mono">
            {agentId}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {/* Quick summary chips */}
        <div className="hidden sm:flex items-center gap-1.5">
          <Badge
            variant={hasSecurity ? "default" : "outline"}
            className={cn(
              "text-[10px] h-5 px-1.5",
              !hasSecurity && "text-muted-foreground",
            )}
          >
            {effectiveSecurity}
          </Badge>
          <Badge
            variant={hasAsk ? "default" : "outline"}
            className={cn(
              "text-[10px] h-5 px-1.5",
              !hasAsk && "text-muted-foreground",
            )}
          >
            ask: {effectiveAsk}
          </Badge>
          {hasAllowlist && (
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5 gap-0.5">
              <ListChecks className="h-2.5 w-2.5" />
              {overrides.allowlist!.length}
            </Badge>
          )}
        </div>

        {overrideCount > 0 && (
          <Badge variant="secondary" className="text-[10px] h-5 px-1.5 sm:hidden">
            {overrideCount} override{overrideCount !== 1 ? "s" : ""}
          </Badge>
        )}

        {overrideCount === 0 && (
          <InheritedBadge />
        )}

        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </button>
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
  device: { requestId: string; deviceId: string; displayName?: string; role?: string; remoteIp?: string };
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
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
          className="h-7 text-xs"
          onClick={() => onReject(device.requestId)}
        >
          Reject
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs"
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
// Loading skeleton
// ---------------------------------------------------------------------------

function SectionSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-48" />
      <div className="space-y-2">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function NodesPage() {
  const powerUserMode = useUIStore((s) => s.powerUserMode);

  // Approvals target: gateway or a specific node
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
  const approveDevice = useApproveDevice();
  const rejectDevice = useRejectDevice();
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

  if (!powerUserMode) {
    return <Navigate to="/" />;
  }

  // Derived data
  const nodes = nodesQuery.data ?? [];
  const devices = devicesQuery.data ?? { pending: [], paired: [] };
  const snapshot = approvalsQuery.data;
  const file = snapshot?.file ?? {};
  const defaults: ExecApprovalsDefaults = file.defaults ?? {};
  const agentApprovals = file.agents ?? {};
  const agents = agentsQuery.data ?? [];
  const execNodes = nodes.filter((n) =>
    n.commands.includes("system.run"),
  );

  // Build a merged list of agent IDs (from config agents + approval overrides)
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

  // Selected agent data for the sheet
  const selectedAgent = selectedAgentId
    ? agents.find((a) => a.id === selectedAgentId)
    : null;
  const selectedAgentOverrides: ExecApprovalsAgent =
    selectedAgentId ? (agentApprovals[selectedAgentId] ?? {}) : {};

  // Nodes that could be targeted for exec approvals
  const targetableNodes = nodes.filter((n) =>
    n.caps.includes("exec") && n.connected,
  );

  // Handlers
  const handleSaveDefaults = (newDefaults: ExecApprovalsDefaults) => {
    if (!snapshot) return;
    const updatedFile: ExecApprovalsFile = {
      ...file,
      defaults: newDefaults,
    };
    saveApprovals.mutate({
      file: updatedFile,
      hash: snapshot.hash,
      target: approvalsTarget,
      nodeId: approvalsTarget === "node" ? approvalsNodeId : undefined,
    });
  };

  const handleSaveAgentOverrides = (
    agentId: string,
    overrides: ExecApprovalsAgent,
  ) => {
    if (!snapshot) return;
    const updatedAgents = { ...agentApprovals };
    // If all values are undefined/empty, remove the agent entry entirely
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
    const updatedFile: ExecApprovalsFile = {
      ...file,
      agents: updatedAgents,
    };
    saveApprovals.mutate({
      file: updatedFile,
      hash: snapshot.hash,
      target: approvalsTarget,
      nodeId: approvalsTarget === "node" ? approvalsNodeId : undefined,
    });
  };

  const handleConfirmRevoke = () => {
    if (!confirmRevoke) return;
    revokeToken.mutate(confirmRevoke);
    setConfirmRevoke(null);
  };

  const isLoading =
    nodesQuery.isLoading || devicesQuery.isLoading || approvalsQuery.isLoading;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        {/* Page header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Nodes & Permissions
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Manage connected nodes, devices, and execution policies.
            </p>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => {
                    nodesQuery.refetch();
                    devicesQuery.refetch();
                    approvalsQuery.refetch();
                  }}
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      isLoading && "animate-spin",
                    )}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh all</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </motion.div>

        {isLoading ? (
          <div className="space-y-8">
            <SectionSkeleton />
            <SectionSkeleton />
            <SectionSkeleton />
          </div>
        ) : (
          <div className="space-y-8">
            {/* ============================================================
                Section 1: Exec Approvals (Permissions)
                ============================================================ */}
            <CollapsibleSection
              title="Execution Policy"
              description="Security, prompt, and allowlist settings for agent commands"
              icon={Shield}
              count={allAgentIds.length}
            >
              <div className="space-y-5">
                {/* Target selector: Gateway vs Node */}
                {targetableNodes.length > 0 && (
                  <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
                    <span className="text-xs font-medium text-muted-foreground shrink-0">
                      Target
                    </span>
                    <Select
                      value={approvalsTarget === "node" && approvalsNodeId ? `node:${approvalsNodeId}` : "gateway"}
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
                      <SelectTrigger className="h-8 text-sm w-[200px]">
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
                    <span className="text-[10px] text-muted-foreground">
                      {approvalsTarget === "gateway"
                        ? "Gateway edits local approvals"
                        : "Node edits the selected node"}
                    </span>
                  </div>
                )}

                {/* Defaults */}
                <DefaultsEditor
                  defaults={defaults}
                  onSave={handleSaveDefaults}
                />

                {/* Agent-specific overrides */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Per-Agent Overrides
                    </span>
                  </div>

                  {/* Search */}
                  {allAgentIds.length > 5 && (
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        value={agentSearch}
                        onChange={(e) => setAgentSearch(e.target.value)}
                        placeholder="Filter agents..."
                        className="h-8 pl-8 text-sm"
                      />
                    </div>
                  )}

                  {/* Agent list */}
                  <div className="rounded-lg border bg-card divide-y divide-border/50">
                    {filteredAgentIds.length === 0 && (
                      <div className="p-4 text-center text-sm text-muted-foreground">
                        {agentSearch
                          ? "No matching agents"
                          : "No agents configured"}
                      </div>
                    )}
                    {filteredAgentIds.map((id) => (
                      <AgentPermissionRow
                        key={id}
                        agentId={id}
                        agentName={agents.find((a) => a.id === id)?.name}
                        defaults={defaults}
                        overrides={agentApprovals[id] ?? {}}
                        onClick={() => setSelectedAgentId(id)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </CollapsibleSection>

            {/* ============================================================
                Section 2: Connected Nodes
                ============================================================ */}
            <CollapsibleSection
              title="Connected Nodes"
              description="Paired nodes and their capabilities"
              icon={Server}
              count={nodes.length}
            >
              {nodes.length === 0 ? (
                <div className="rounded-lg border bg-card p-6 text-center">
                  <Server className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No nodes connected
                  </p>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {nodes.map((node) => (
                    <NodeCard key={node.nodeId} node={node} />
                  ))}
                </div>
              )}

              {/* Exec node binding */}
              {execNodes.length > 0 && allAgentIds.length > 0 && (
                <div className="mt-4 space-y-2">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Exec Node Binding
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Pin agents to a specific node when using <code className="bg-muted px-1 rounded">exec host=node</code>.
                  </p>
                  <div className="rounded-lg border bg-card divide-y divide-border/50">
                    {/* Default binding row */}
                    <div className="flex items-center justify-between py-2.5 px-3">
                      <div>
                        <div className="text-sm font-medium">Default binding</div>
                        <div className="text-[10px] text-muted-foreground">
                          Used when agents do not override
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-foreground/70">Any node</span>
                        {execNodes.length > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            ({execNodes.length} available)
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Per-agent bindings */}
                    {allAgentIds.map((id) => (
                      <div key={id} className="flex items-center justify-between py-2 px-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Server className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="text-sm truncate">
                            {agents.find((a) => a.id === id)?.name ?? id}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-sm text-foreground/70">Any node</span>
                          <InheritedBadge />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CollapsibleSection>

            {/* ============================================================
                Section 3: Devices
                ============================================================ */}
            <CollapsibleSection
              title="Devices"
              description="Pairing requests and role tokens"
              icon={Fingerprint}
              count={devices.paired.length}
              action={
                devices.pending.length > 0 ? (
                  <Badge variant="warning" className="text-[10px] gap-1">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    {devices.pending.length} pending
                  </Badge>
                ) : undefined
              }
            >
              <div className="space-y-4">
                {/* Pending requests */}
                {devices.pending.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Pending Requests
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {devices.pending.map((d) => (
                        <PendingDeviceCard
                          key={d.requestId}
                          device={d}
                          onApprove={(id) => approveDevice.mutate(id)}
                          onReject={(id) => rejectDevice.mutate(id)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Paired devices */}
                {devices.paired.length === 0 ? (
                  <div className="rounded-lg border bg-card p-6 text-center">
                    <Fingerprint className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">
                      No paired devices
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
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
            </CollapsibleSection>
          </div>
        )}

        {/* ================================================================
            Agent Permissions Sheet (slide-out)
            ================================================================ */}
        <AgentPermissionsSheet
          open={!!selectedAgentId}
          onOpenChange={(open) => {
            if (!open) setSelectedAgentId(null);
          }}
          agentId={selectedAgentId ?? ""}
          agentName={selectedAgent?.name}
          defaults={defaults}
          agentOverrides={selectedAgentOverrides}
          onSave={handleSaveAgentOverrides}
        />

        {/* ================================================================
            Revoke Confirmation Dialog
            ================================================================ */}
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
                <span className="font-medium text-foreground">
                  {confirmRevoke?.role}
                </span>{" "}
                token? The device will need to re-authenticate.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirmRevoke(null)}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleConfirmRevoke}>
                Revoke
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
