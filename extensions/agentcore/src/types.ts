/**
 * Configuration for the AgentCore runtime backend.
 * Loaded from SSM parameters at startup (see CDK AgentCoreConstruct).
 */
export type AgentCoreRuntimeConfig = {
  /** AWS region for AgentCore API calls. */
  region: string;
  /** AgentCore Runtime ARNs for load distribution. */
  runtimeArns: string[];
  /** Prefix for per-tenant memory namespacing (e.g. "tenant_"). */
  memoryNamespacePrefix: string;
  /** AgentCore Memory resource ID (from CDK CfnMemory). */
  memoryId?: string;
  /** Default Bedrock model ID (e.g. "anthropic.claude-sonnet-4-20250514"). */
  defaultModel: string;
  /** AgentCore endpoint override (for local testing). */
  endpoint?: string;
  /** Timeout for agent invocations in milliseconds. Default 300_000 (5 min). */
  invokeTimeoutMs?: number;
};

/**
 * Internal handle state encoded into AcpRuntimeHandle.runtimeSessionName.
 * Tracks the AgentCore session identity for subsequent turns.
 */
export type AgentCoreHandleState = {
  /** AgentCore Runtime ARN used for this session. */
  runtimeArn: string;
  /** Session ID passed as runtimeSessionId to AgentCore. */
  sessionId: string;
  /** Tenant/user ID — used as runtimeUserId for per-tenant isolation. */
  tenantId: string;
  /** Agent instance ID within the tenant. Default: "main". [claude-infra] */
  agentId: string;
  /** Agent identifier from OC's session key. */
  agent: string;
  /** Session mode. */
  mode: "persistent" | "oneshot";
};
