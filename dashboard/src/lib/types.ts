// Agent types (from openclaw.json)
export interface Agent {
  id: string;
  name: string;
  emoji?: string;
  role?: string;
  model: string | { primary: string; fallbacks?: string[] };
  level?: string;
  status?: "active" | "idle" | "error" | "offline";
  tools?: { allow?: string[] };
  heartbeat?: {
    every: string;
    session: string;
    target?: string;
    to?: string;
    prompt?: string;
  };
  identity?: { name: string; emoji: string };
  groupChat?: { mentionPatterns: string[]; historyLimit: number };
  subagents?: { allowAgents?: string[]; model?: string };
}

export interface AgentDetail extends Agent {
  models: ModelConfig[];
  soul?: string;
  rules?: string;
  recentOutputs?: string[];
  sessionCount?: number;
}

// Model types
export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

// System state
export interface ServiceStatus {
  name: string;
  status: "up" | "down" | "degraded";
  port?: number;
  lastCheck: string;
  details?: string;
}

// Cron
export interface CronJob {
  name: string;
  schedule: string;
  lastRun?: string;
  lastStatus?: "success" | "error";
  consecutiveErrors?: number;
  enabled: boolean;
}

// Revenue
export interface RevenueData {
  current: number;
  monthlyBurn: number;
  net: number;
  currency: string;
}

// Content
export interface ContentItem {
  id: string;
  title: string;
  platform?: string;
  status: "draft" | "review" | "approved" | "published";
  createdAt?: string;
  preview?: string;
}

// Tasks
export interface SuggestedTask {
  id: string;
  category: string;
  categoryEmoji?: string;
  title: string;
  reasoning: string;
  nextAction: string;
  priority: "critical" | "high" | "medium" | "low";
  effort: "quick" | "medium" | "large";
  status: "pending" | "approved" | "rejected";
}

// Chat
export interface ChatSession {
  sessionId: string;
  agentId: string;
  agentName?: string;
  updatedAt: number;
  channel?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "toolResult";
  content: string;
  timestamp: string;
  channel?: string;
  model?: string;
  toolCalls?: { name: string; arguments: unknown }[];
}

// Client
export interface Client {
  id: string;
  name: string;
  status: "prospect" | "contacted" | "meeting" | "proposal" | "active";
  contacts?: string[];
  lastInteraction?: string;
  nextAction?: string;
  notes?: string;
}

// Ecosystem
export interface EcosystemProduct {
  name: string;
  slug: string;
  status: "active" | "development" | "concept" | "archived";
  description?: string;
  health?: "healthy" | "warning" | "critical";
  metrics?: Record<string, number>;
}

// Repository
export interface Repository {
  name: string;
  path: string;
  branch?: string;
  lastCommit?: string;
  lastCommitMessage?: string;
  dirtyFiles?: number;
  languages?: Record<string, number>;
}

// API response wrapper
export interface ApiResponse<T> {
  data: T;
  timestamp: string;
}

export interface ApiError {
  error: string;
  timestamp: string;
}
