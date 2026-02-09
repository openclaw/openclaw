/**
 * Core types for the Local LLM Router system.
 */

// ---------------------------------------------------------------------------
// Model & Provider
// ---------------------------------------------------------------------------

export interface ModelRef {
  provider: string; // "ollama" | "anthropic" | "openai"
  model: string; // "qwen2.5:3b" | "claude-opus-4-6"
}

export interface ModelConfig {
  ref: ModelRef;
  alias?: string;
  contextWindow?: number;
  costTier?: "free" | "cheap" | "expensive";
}

export interface ModelsRegistry {
  local: Record<string, ModelConfig>;
  cloud: Record<string, ModelConfig>;
  defaults: {
    router: string; // alias or provider/model
    local: string;
    cloud: string;
  };
}

// ---------------------------------------------------------------------------
// Router & Classification
// ---------------------------------------------------------------------------

export type Intent =
  | "email_draft"
  | "email_send"
  | "email_read"
  | "web_search"
  | "web_scrape"
  | "purchase"
  | "booking"
  | "code_simple"
  | "code_complex"
  | "deploy"
  | "research"
  | "form_fill"
  | "schedule_task"
  | "general_chat"
  | "unknown";

export interface Classification {
  intent: Intent;
  confidence: number; // 0-1
  complexity: "low" | "medium" | "high";
  tools_needed: string[];
  recommended_engine: "local" | "cloud";
  reasoning?: string;
}

export type ApprovalLevel =
  | "none" // auto-execute
  | "confirm" // simple yes/no via Telegram
  | "confirm_with_screenshot"; // screenshot + yes/no

export interface Route {
  intent: Intent;
  agent: AgentId;
  model: "local" | "cloud";
  tools: string[];
  approval: ApprovalLevel;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentId = "comms" | "browser" | "coder" | "monitor";

export interface AgentConfig {
  id: AgentId;
  defaultModel: string; // alias or provider/model
  tools: string[];
  alwaysOn: boolean;
  approvalRequired: string[]; // tool actions needing confirmation
  skills: string[]; // skill tier filter: "personal", "coding", "system"
}

// ---------------------------------------------------------------------------
// Task Queue
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface Task {
  id: string;
  createdAt: string;
  status: TaskStatus;
  agent: AgentId;
  classification: Classification;
  route: Route;
  input: string; // original user prompt
  channelId: string; // "telegram" | "terminal" | "email"
  sessionKey?: string;
  result?: string;
  error?: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Error Journal
// ---------------------------------------------------------------------------

export type ErrorType =
  | "tool_failure"
  | "user_rejection"
  | "user_correction"
  | "router_misclassification"
  | "low_confidence"
  | "fallback_triggered"
  | "timeout"
  | "repeated_attempt"
  | "skill_gap"
  | "stale_skill";

export interface ErrorEntry {
  id: string;
  timestamp: string;
  type: ErrorType;
  agent: AgentId;
  skill?: string;
  model: string;
  task: string;
  context: Record<string, unknown>;
  sessionRef?: string;
  screenshotPath?: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RouterConfig {
  models: ModelsRegistry;
  routes: Route[];
  agents: Record<AgentId, AgentConfig>;
  channels: {
    telegram: { botToken: string; allowedUsers: number[] };
    email: { imap: ImapConfig; smtp: SmtpConfig };
  };
  analysis: {
    enabled: boolean;
    schedule: string; // cron expression
    model: string; // expensive model alias
  };
}

export interface ImapConfig {
  host: string;
  port: number;
  auth: { user: string; pass: string };
  tls: boolean;
}

export interface SmtpConfig {
  host: string;
  port: number;
  auth: { user: string; pass: string };
  secure: boolean;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface AuditEntry {
  timestamp: string;
  agent: AgentId;
  action: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  durationMs?: number;
  approved?: boolean;
  error?: string;
}
