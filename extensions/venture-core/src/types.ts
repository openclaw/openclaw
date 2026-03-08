export type VentureModuleId =
  | "market-intelligence"
  | "funnel-builder"
  | "browser-swarm"
  | "finance-engine"
  | "support-agents"
  | "deployment-engine"
  | "partnership-finder"
  | "agent-replication"
  | "venture-loop"
  | (string & {});

export type VenturePriority = "low" | "normal" | "high" | "critical";

export type VentureRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "validating"
  | "succeeded"
  | "failed"
  | "canceled";

export type VentureActor = {
  id: string;
  kind: "user" | "agent" | "system";
};

export type VentureTags = Record<string, string>;

export type VentureBudget = {
  maxUsd?: number;
  maxTokens?: number;
  maxDurationMs?: number;
};

export type VentureRunMetadata = {
  runId: string;
  parentRunId?: string;
  moduleId: VentureModuleId;
  requestedAt: string;
  requestedBy?: VentureActor;
  priority: VenturePriority;
  tags?: VentureTags;
  budget?: VentureBudget;
};

export type VentureModuleDescriptor = {
  id: VentureModuleId;
  version: string;
  title: string;
  description: string;
  owner?: string;
  capabilities: string[];
};

