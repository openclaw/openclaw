/**
 * BusinessClaw (BCL) - Types and Core Constants
 *
 * This file contains all core interfaces and hardcoded values
 * as defined in the BCL specification.
 */

// ============================================================================
// CORE VALUES (Hardcoded from spec)
// ============================================================================

export const BCL_CORE_VALUES = {
  // Qualität hat oberste Priorität
  quality_over_money: true,

  // Tool Building Pattern: Prompt/Plan für Kilo Code
  tool_building_pattern: "prompt_plan_for_kilo_code",

  // Anti-Hallucination aktiviert
  anti_hallucination_enabled: true,
  min_confidence_threshold: 0.85,
  human_review_required_impact: 500,

  // BCL baut eigene Tools bei Bedarf
  auto_tool_building: true,

  // Minimaler menschlicher Eingriff
  max_human_interaction: "start + revenue_cut_only",

  // Ressourcennutzung
  resource_usage: "local_cpu_gpu_storage_when_available",

  // Uptime-Modell
  uptime_model: "best_effort",

  // Kostenkontrolle
  free_tier_only: true,
  require_approval_for_spend: true,

  // Test-Anforderungen
  min_test_coverage: 0.7,

  // Sicherheitsstandards
  security_first: true,
  dependabot_enabled: true,
  security_scan_on_every_commit: true,

  // Finanzkontrolle
  track_all_purchases: true,
  require_receipts: true,
  volatility_monitoring: true,

  // Rate Limiting
  auto_model_failover: true,
  circuit_breaker_enabled: true,
} as const;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Agent types for BCL subagents
 */
export type BCLAgentType =
  | "research"
  | "competitor"
  | "builder"
  | "security"
  | "marketer"
  | "finance"
  | "market_predictor"
  | "test_generator"
  | "comms"
  | "health"
  | "rate_limit_manager";

/**
 * Opportunity scoring
 */
export interface Opportunity {
  id: string;
  source: string;
  title: string;
  description: string;
  score: number; // 0-100
  confidence: number; // 0-1
  sources: string[];
  timestamp: Date;
  status: "new" | "analyzing" | "building" | "deployed" | "failed";
}

/**
 * Competitor analysis result
 */
export interface CompetitorAnalysis {
  id: string;
  name: string;
  url: string;
  pricing: string;
  features: string[];
  marketing_strategy: string;
  strengths: string[];
  weaknesses: string[];
  lessons_learned: string[];
  timestamp: Date;
}

/**
 * Project tracking
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  github_url?: string;
  status: "planning" | "building" | "testing" | "deployed" | "failed";
  revenue: number;
  costs: number;
  roi: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Financial entry
 */
export interface FinanceEntry {
  id: string;
  type: "income" | "expense";
  amount: number;
  currency: "USD" | "BTC" | "ETH" | "SOL";
  description: string;
  project_id?: string;
  receipt_path?: string;
  timestamp: Date;
}

/**
 * Wallet for multi-chain support
 */
export interface Wallet {
  id: string;
  chain: "BTC" | "ETH" | "SOL";
  address: string;
  balance: number;
  last_updated: Date;
}

/**
 * Milestone tracking
 */
export interface Milestone {
  id: string;
  type: "revenue" | "deployment" | "user_count" | "custom";
  target_value: number;
  current_value: number;
  reached_at?: Date;
  notified: boolean;
}

/**
 * Health status
 */
export interface HealthStatus {
  agents: Record<BCLAgentType, AgentHealth>;
  database: boolean;
  last_check: Date;
}

export interface AgentHealth {
  status: "healthy" | "degraded" | "down";
  last_run?: Date;
  error_count: number;
  last_error?: string;
}

/**
 * Message/Communication types
 */
export type MessagePriority = "critical" | "high" | "normal" | "low";

export interface BCLMessage {
  id: string;
  priority: MessagePriority;
  title: string;
  body: string;
  timestamp: Date;
  sent: boolean;
}

/**
 * Decision record for audit trail
 */
export interface DecisionRecord {
  id: string;
  decision: string;
  confidence: number;
  sources: string[];
  reasoning: string;
  impact: number;
  human_review: boolean;
  approved_by?: string;
  timestamp: Date;
}

/**
 * Brain.md memory entry
 */
export interface MemoryEntry {
  id: string;
  category: "success" | "failure" | "learning" | "strategy" | "market";
  content: string;
  tags: string[];
  timestamp: Date;
}

/**
 * Scheduling configuration
 */
export interface ScheduleConfig {
  agent: BCLAgentType;
  cron: string;
  enabled: boolean;
}

/**
 * API configuration
 */
export interface APIConfig {
  groq?: string;
  github?: string;
  telegram?: string;
  solana_rpc?: string;
  btc_rpc?: string;
  eth_rpc?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const SCHEDULE_TIMES = {
  RESEARCH: "06:00",
  COMPETITOR_ANALYSIS: "06:00",
  BUILD: "09:00",
  SECURITY_SCAN: "09:00",
  MARKETING: "14:00",
  FINANCE: "18:00",
  DAILY_REPORT: "20:00",
  LEARNING_LOOP: "22:00",
} as const;

export const API_SERVICES = {
  GROQ: {
    name: "Groq",
    purpose: "LLM (70B Modelle)",
    cost: "$0 (Free Tier)",
    failover: "Auto-switch Model",
  },
  GITHUB: { name: "GitHub", purpose: "Repos, PRs", cost: "$0", failover: "-" },
  TELEGRAM: { name: "Telegram", purpose: "Bot, Voice", cost: "$0", failover: "-" },
  SOLANA_RPC: { name: "Solana RPC", purpose: "Wallet", cost: "$0", failover: "-" },
  BTC_RPC: { name: "BTC RPC", purpose: "Wallet", cost: "$0", failover: "-" },
  ETH_RPC: { name: "ETH RPC", purpose: "Wallet", cost: "$0", failover: "-" },
} as const;

export const DEFAULT_SCHEDULES: ScheduleConfig[] = [
  { agent: "research", cron: "0 6 * * *", enabled: true },
  { agent: "competitor", cron: "0 6 * * *", enabled: true },
  { agent: "builder", cron: "0 9 * * *", enabled: true },
  { agent: "security", cron: "0 9 * * *", enabled: true },
  { agent: "marketer", cron: "0 14 * * *", enabled: true },
  { agent: "finance", cron: "0 18 * * *", enabled: true },
  { agent: "market_predictor", cron: "0 */4 * * *", enabled: true },
];

export const MILESTONE_THRESHOLDS = [1, 10, 100, 500, 1000, 5000, 10000] as const;
