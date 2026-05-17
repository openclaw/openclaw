// Core types for the shield: threats, scan results, recovery state, config.

export type ThreatCategory =
  | "prompt_injection"
  | "identity_spoofing"
  | "context_poisoning"
  | "delegation_loop"
  | "confidence_amplification"
  | "privilege_escalation"
  | "data_exfiltration"
  | "tool_abuse"
  | "secret_leak";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface ThreatRule {
  // stable id, e.g. "T01"
  id: string;
  name: string;
  category: ThreatCategory;
  severity: Severity;
  description: string;
  // returns a match, or null if nothing fired
  evaluate(ctx: ScanContext): ThreatMatch | null;
}

export interface ScanContext {
  content: string;
  source: MessageSource;
  // 0 = root agent
  delegationDepth: number;
  delegationChain: string[];
  toolName?: string;
  // matches accumulated so far in this turn (used by T18)
  priorMatches: ThreatMatch[];
}

export interface MessageSource {
  agentId: string;
  targetId: string;
  direction: "inbound" | "outbound" | "agent_to_agent" | "tool_call" | "tool_result";
  sessionId: string;
  timestamp: number;
}

export interface ThreatMatch {
  ruleId: string;
  ruleName: string;
  category: ThreatCategory;
  severity: Severity;
  // 0.0 to 1.0
  confidence: number;
  excerpt: string;
  offset?: number;
  action: ThreatAction;
  explanation: string;
}

export type ThreatAction =
  | "block"
  | "warn"
  | "redact"
  | "pause_agent"
  | "log"
  | "escalate";

// Recovery routing

export type AgentStatus = "healthy" | "paused" | "recovering" | "quarantined";

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  threats: ThreatMatch[];
  recoveryAttempts: number;
  activeWork: WorkItem[];
  lastStatusChange: number;
}

export interface WorkItem {
  id: string;
  description: string;
  partialOutput?: string;
  // higher = more urgent
  priority: number;
  originAgentId: string;
}

export interface RecoveryAction {
  type: "pause" | "redistribute" | "verify" | "escalate" | "resume";
  targetAgentId: string;
  workItems?: WorkItem[];
  annotation?: DownstreamAnnotation;
  verificationClaim?: VerificationClaim;
  escalationArtifact?: EscalationArtifact;
}

export interface DownstreamAnnotation {
  message: string;
  pausedAgentId: string;
  severity: Severity;
  scrutinyLevel: "elevated" | "maximum";
  timestamp: number;
}

export interface VerificationClaim {
  workItemId: string;
  partialOutput: string;
  claims: string[];
  verifierAgentId: string;
}

export interface EscalationArtifact {
  id: string;
  diagnosis: string;
  context: string;
  threats: ThreatMatch[];
  recoveryHistory: RecoveryAttemptRecord[];
  suggestedFix: string;
  timestamp: number;
}

export interface RecoveryAttemptRecord {
  attempt: number;
  action: RecoveryAction["type"];
  outcome: "success" | "failure" | "partial";
  detail: string;
  timestamp: number;
}

// Scan results / logging

export interface ScanResult {
  clean: boolean;
  matches: ThreatMatch[];
  durationMs: number;
  maxSeverity: Severity | null;
  action: ThreatAction | "allow";
}

export interface ThreatLogEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  scanResult: ScanResult;
  source: MessageSource;
  recoveryActions: RecoveryAction[];
}

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

// Plugin config (mirrors openclaw.plugin.json configSchema).
export interface AgentShieldConfig {
  enabled: boolean;
  mode: "monitor" | "enforce";
  maxDelegationDepth: number;
  maxRecoveryAttempts: number;
  redactSecrets: boolean;
  filterMcpEnv: boolean;
  allowedEnvVars: string[];
  threatLog: "file" | "memory" | "both";
}

export const DEFAULT_CONFIG: AgentShieldConfig = {
  enabled: true,
  mode: "enforce",
  maxDelegationDepth: 3,
  maxRecoveryAttempts: 3,
  redactSecrets: true,
  filterMcpEnv: true,
  allowedEnvVars: [],
  threatLog: "both",
};
