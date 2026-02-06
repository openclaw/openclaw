import { useQuery } from "@tanstack/react-query";
import {
  listNodes,
  listDevices,
  getExecApprovals,
  type NodeEntry,
  type DevicePairingList,
  type ExecApprovalsSnapshot,
} from "@/lib/api/nodes";
import { useUIStore } from "@/stores/useUIStore";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const nodeKeys = {
  all: ["nodes"] as const,
  list: () => [...nodeKeys.all, "list"] as const,
  devices: () => [...nodeKeys.all, "devices"] as const,
  execApprovals: (target: string, nodeId?: string) =>
    [...nodeKeys.all, "execApprovals", target, nodeId] as const,
};

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockNodes: NodeEntry[] = [
  {
    nodeId: "mbp-main",
    displayName: "MacBook Pro",
    platform: "darwin",
    version: "2025.1.15",
    caps: ["exec", "fs", "media"],
    commands: ["system.run", "system.execApprovals.get", "system.execApprovals.set"],
    paired: true,
    connected: true,
    connectedAtMs: Date.now() - 3600000,
  },
  {
    nodeId: "home-server",
    displayName: "Home Server",
    platform: "linux",
    version: "2025.1.14",
    caps: ["exec", "fs"],
    commands: ["system.run"],
    paired: true,
    connected: true,
    connectedAtMs: Date.now() - 86400000,
  },
  {
    nodeId: "work-desktop",
    displayName: "Work Desktop",
    platform: "win32",
    version: "2025.1.12",
    caps: ["exec"],
    commands: ["system.run"],
    paired: true,
    connected: false,
  },
];

const mockDevices: DevicePairingList = {
  pending: [],
  paired: [
    {
      deviceId: "dd5d7b46ea89126d3944b4d9a35f3cf1",
      displayName: "Operator Device",
      roles: ["operator"],
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
      tokens: [
        {
          role: "operator",
          scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
          createdAtMs: Date.now() - 259200000,
          active: true,
        },
      ],
      approvedAtMs: Date.now() - 259200000,
    },
    {
      deviceId: "8def531bcf854503f42d8b6bb03a5cc6",
      displayName: "Agent Runner",
      roles: ["agent"],
      scopes: ["agent.run", "agent.status"],
      tokens: [
        {
          role: "agent",
          scopes: ["agent.run", "agent.status"],
          createdAtMs: Date.now() - 604800000,
          active: true,
        },
      ],
      approvedAtMs: Date.now() - 604800000,
    },
  ],
};

const mockExecApprovals: ExecApprovalsSnapshot = {
  path: "~/.clawdbrain/exec-approvals.json",
  exists: true,
  hash: "mock-hash-001",
  file: {
    version: 1,
    defaults: {
      security: "deny",
      ask: "on-miss",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agents: {
      main: {},
      work: { security: "allowlist", allowlist: [{ pattern: "git *" }, { pattern: "npm *" }] },
      "code-reviewer": { ask: "always" },
    },
  },
};

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchNodes(live: boolean): Promise<NodeEntry[]> {
  if (!live) {
    await new Promise((r) => setTimeout(r, 300));
    return mockNodes;
  }
  const result = await listNodes();
  return result.nodes;
}

async function fetchDevices(live: boolean): Promise<DevicePairingList> {
  if (!live) {
    await new Promise((r) => setTimeout(r, 300));
    return mockDevices;
  }
  return listDevices();
}

async function fetchExecApprovals(
  live: boolean,
  target: "gateway" | "node" = "gateway",
  nodeId?: string,
): Promise<ExecApprovalsSnapshot> {
  if (!live) {
    await new Promise((r) => setTimeout(r, 300));
    return mockExecApprovals;
  }
  return getExecApprovals(target, nodeId);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useNodes() {
  const useLiveGateway = useUIStore((s) => s.useLiveGateway);
  const live = (import.meta.env?.DEV ?? false) && useLiveGateway;
  return useQuery({
    queryKey: nodeKeys.list(),
    queryFn: () => fetchNodes(live),
    staleTime: 1000 * 60 * 5,
  });
}

export function useDevices() {
  const useLiveGateway = useUIStore((s) => s.useLiveGateway);
  const live = (import.meta.env?.DEV ?? false) && useLiveGateway;
  return useQuery({
    queryKey: nodeKeys.devices(),
    queryFn: () => fetchDevices(live),
    staleTime: 1000 * 60 * 2,
  });
}

export function useExecApprovals(
  target: "gateway" | "node" = "gateway",
  nodeId?: string,
) {
  const useLiveGateway = useUIStore((s) => s.useLiveGateway);
  const live = (import.meta.env?.DEV ?? false) && useLiveGateway;
  return useQuery({
    queryKey: nodeKeys.execApprovals(target, nodeId),
    queryFn: () => fetchExecApprovals(live, target, nodeId),
    staleTime: 1000 * 60 * 2,
  });
}

// Re-export types
export type {
  NodeEntry,
  NodeListResult,
  DevicePairingList,
  PairedDevice,
  PendingDevice,
  DeviceTokenSummary,
  ExecApprovalsSnapshot,
  ExecApprovalsFile,
  ExecApprovalsDefaults,
  ExecApprovalsAgent,
  ExecApprovalsAllowlistEntry,
} from "@/lib/api/nodes";
