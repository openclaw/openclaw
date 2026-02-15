/**
 * Agents Plane — Core Types
 *
 * All interfaces, configs, and enums for the provider-agnostic
 * agent orchestration framework.
 */

// ── Plane-level configuration ──

export interface PlaneConfig {
  name: string;
  identity: {
    provider: "google-workspace" | "entra";
    domain: string;
    adminEmail?: string;
    credentials?: string;
  };
  infra: {
    provider: "gcp" | "aws";
    project?: string;
    region: string;
    defaults: ComputeDefaults;
  };
  secrets: {
    provider: "gcp-secret-manager" | "aws-secrets-manager";
    project?: string;
  };
  network: {
    provider: "iap" | "ssm" | "none";
    egressPolicy?: EgressPolicy;
  };
  stateBackend?: {
    provider: "gcs" | "s3" | "local";
    bucket?: string;
    prefix?: string;
    directory?: string;
  };
}

export interface ComputeDefaults {
  machineType: string;
  diskSizeGb: number;
  image?: string;
}

export interface EgressPolicy {
  default: "restricted" | "open";
  allowedDomains?: string[];
}

// ── Agent-level ──

export interface AgentConfig {
  name: string;
  owner: string;
  machineType?: string;
  modelTier: "haiku" | "sonnet" | "opus";
  model?: string;
  budgetCap: number;
  tools: string[];
  channels: string[];
}

export interface AgentInstance {
  agentId: string;
  planeId: string;
  config: AgentConfig;
  compute: {
    instanceId: string;
    zone: string;
    ip?: string;
  };
  iam: {
    serviceAccount?: string;
    iamUser?: string;
    role?: string;
  };
  secrets: {
    prefix: string;
  };
  status: AgentStatus;
  lastHeartbeat?: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentStatus =
  | "provisioning"
  | "bootstrapping"
  | "running"
  | "stopped"
  | "error"
  | "deprovisioning";

// ── Plane state ──

export interface PlaneState {
  config: PlaneConfig;
  agents: Record<string, AgentInstance>;
  version: number;
  updatedAt: string;
}

// ── Provider interfaces ──

export interface AgentComputeSpec {
  machineType: string;
  region: string;
  zone?: string;
  diskSizeGb: number;
  image?: string;
  labels: Record<string, string>;
}

export interface ProvisionResult {
  instanceId: string;
  zone: string;
  serviceAccount?: string;
  iamUser?: string;
  ip?: string;
}

export interface InfraProvider {
  readonly name: string;
  provision(
    agentId: string,
    spec: AgentComputeSpec,
    startupScript: string,
  ): Promise<ProvisionResult>;
  deprovision(agentId: string): Promise<void>;
  restart(instanceId: string): Promise<void>;
  status(
    instanceId: string,
  ): Promise<{ state: "running" | "stopped" | "terminated" | "unknown"; ip?: string }>;
}

export interface UserIdentity {
  email: string;
  displayName: string;
  ou?: string;
  groups?: string[];
  agentEnabled?: boolean;
  agentConfig?: Partial<AgentConfig>;
}

export interface UserEvent {
  type: "created" | "deleted" | "suspended" | "updated" | "ou-changed";
  email: string;
  timestamp: string;
}

export interface IdentityProvider {
  readonly name: string;
  resolveUser(email: string): Promise<UserIdentity | null>;
  listUsers(filter?: { ou?: string; group?: string }): Promise<UserIdentity[]>;
  watchEvents?(callback: (event: UserEvent) => void): Promise<void>;
}

export interface StateStore {
  load(planeId: string): Promise<PlaneState | null>;
  save(state: PlaneState): Promise<void>;
  list(): Promise<string[]>;
  lock(planeId: string): Promise<() => Promise<void>>;
}
