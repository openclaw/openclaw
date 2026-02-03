/**
 * Cost Guard - TypeScript implementation for OpenClaw integration.
 *
 * Enforces budget limits and prevents runaway spending.
 * Reads/writes to the same JSON files as the Python version for compatibility.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// State file (same as Python version)
const WORKSPACE = path.join(os.homedir(), ".openclaw/workspaces/friday");
const STATE_FILE = path.join(WORKSPACE, "memory/cost_guard_state.json");
const METRICS_FILE = path.join(WORKSPACE, "memory/cost-metrics.csv");

// Model pricing (per million tokens)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus": { input: 5.0, output: 25.0 },
  "claude-sonnet": { input: 3.0, output: 15.0 },
  gemini: { input: 0.3, output: 2.5 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  qwen: { input: 0.0, output: 0.0 },
  llama: { input: 0.0, output: 0.0 },
  deepseek: { input: 0.0, output: 0.0 },
};

// Downgrade chain
const DOWNGRADE_CHAIN = [
  "openrouter/anthropic/claude-opus-4.5",
  "openrouter/anthropic/claude-sonnet-4",
  "openrouter/google/gemini-2.5-flash",
  "ollama/qwen3:32b",
];

export interface CostLimits {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxSessionDollars: number;
  maxHourlyDollars: number;
  downgradeThreshold: number;
  maxRetries: number;
}

export interface CostRecord {
  timestamp: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface CostCheckResult {
  allowed: boolean;
  reason: string | null;
  suggestedModel: string | null;
}

export interface CostStatus {
  sessionCost: number;
  sessionCalls: number;
  hourlyCost: number;
  toolCallsThisRun: number;
  budgetRemaining: number;
  budgetPercentUsed: number;
}

// Default limits
const DEFAULT_LIMITS: CostLimits = {
  maxInputTokens: 50_000,
  maxOutputTokens: 8_000,
  maxToolCalls: 20,
  maxSessionDollars: 2.0,
  maxHourlyDollars: 5.0,
  downgradeThreshold: 0.7,
  maxRetries: 3,
};

// In-memory state (loaded from disk on first access)
let limits: CostLimits = { ...DEFAULT_LIMITS };
let sessionCost = 0;
let sessionCalls = 0;
let toolCallsThisRun = 0;
let retryCount = 0;
let recentCosts: CostRecord[] = [];
let stateLoaded = false;

/**
 * Load state from disk.
 */
function loadState(): void {
  if (stateLoaded) return;

  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));

      // Filter to costs from last hour
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      recentCosts = (data.recent_costs ?? data.recentCosts ?? []).filter(
        (c: CostRecord) => c.timestamp > hourAgo,
      );

      // Session cost from today
      const today = new Date().toISOString().slice(0, 10);
      sessionCost = recentCosts
        .filter((c) => c.timestamp.startsWith(today))
        .reduce((sum, c) => sum + c.cost, 0);
    }
  } catch {
    // Ignore errors
  }

  stateLoaded = true;
}

/**
 * Save state to disk.
 */
function saveState(): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Keep only last hour of costs
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = recentCosts.filter((c) => c.timestamp > hourAgo);

    const data = {
      recentCosts: recent,
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch {
    // Ignore errors
  }
}

/**
 * Append cost record to CSV metrics file.
 */
function appendMetrics(record: CostRecord): void {
  try {
    const dir = path.dirname(METRICS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Add header if file doesn't exist
    if (!fs.existsSync(METRICS_FILE)) {
      fs.writeFileSync(METRICS_FILE, "timestamp,model,input_tokens,output_tokens,cost\n");
    }

    const line = `${record.timestamp},${record.model},${record.inputTokens},${record.outputTokens},${record.cost.toFixed(6)}\n`;
    fs.appendFileSync(METRICS_FILE, line);
  } catch {
    // Ignore errors
  }
}

/**
 * Calculate cost for a model call.
 */
function calculateCost(inputTokens: number, outputTokens: number, model: string): number {
  const modelLower = model.toLowerCase();

  for (const [key, prices] of Object.entries(MODEL_PRICING)) {
    if (modelLower.includes(key)) {
      return (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000;
    }
  }

  // Unknown model, assume moderate pricing
  return (inputTokens * 1.0 + outputTokens * 5.0) / 1_000_000;
}

/**
 * Get next cheaper model in chain.
 */
function getCheaperModel(current: string): string | null {
  for (let i = 0; i < DOWNGRADE_CHAIN.length; i++) {
    const model = DOWNGRADE_CHAIN[i];
    if (model.includes(current) || current.includes(model)) {
      if (i + 1 < DOWNGRADE_CHAIN.length) {
        return DOWNGRADE_CHAIN[i + 1];
      }
      break;
    }
  }
  return null;
}

// Public API

/**
 * Configure cost limits.
 */
export function configureLimits(newLimits: Partial<CostLimits>): void {
  limits = { ...limits, ...newLimits };
}

/**
 * Pre-flight check before API call.
 */
export function checkCost(inputTokens: number, model: string): CostCheckResult {
  loadState();

  const result: CostCheckResult = {
    allowed: true,
    reason: null,
    suggestedModel: null,
  };

  // Check input token limit
  if (inputTokens > limits.maxInputTokens) {
    result.allowed = false;
    result.reason = `Input tokens (${inputTokens.toLocaleString()}) exceeds limit (${limits.maxInputTokens.toLocaleString()})`;
    return result;
  }

  // Check tool call limit
  if (toolCallsThisRun >= limits.maxToolCalls) {
    result.allowed = false;
    result.reason = `Tool call limit reached (${limits.maxToolCalls})`;
    return result;
  }

  // Check retry limit
  if (retryCount >= limits.maxRetries) {
    result.allowed = false;
    result.reason = `Max retries (${limits.maxRetries}) exceeded`;
    return result;
  }

  // Check session cost
  if (sessionCost >= limits.maxSessionDollars) {
    result.allowed = false;
    result.reason = `Session budget exhausted ($${sessionCost.toFixed(2)})`;
    return result;
  }

  // Check hourly cost
  const hourlyCost = recentCosts.reduce((sum, c) => sum + c.cost, 0);
  if (hourlyCost >= limits.maxHourlyDollars) {
    result.allowed = false;
    result.reason = `Hourly budget exhausted ($${hourlyCost.toFixed(2)})`;
    return result;
  }

  // Check if should suggest downgrade
  const sessionPct = sessionCost / limits.maxSessionDollars;
  if (sessionPct >= limits.downgradeThreshold) {
    const suggested = getCheaperModel(model);
    if (suggested) {
      result.suggestedModel = suggested;
    }
  }

  return result;
}

/**
 * Record a completed API call.
 */
export function recordCost(inputTokens: number, outputTokens: number, model: string): void {
  loadState();

  const cost = calculateCost(inputTokens, outputTokens, model);

  sessionCost += cost;
  sessionCalls += 1;

  const record: CostRecord = {
    timestamp: new Date().toISOString(),
    cost,
    inputTokens,
    outputTokens,
    model,
  };

  recentCosts.push(record);
  saveState();
  appendMetrics(record);
}

/**
 * Record a tool call in current run.
 */
export function recordToolCall(): void {
  loadState();
  toolCallsThisRun += 1;
}

/**
 * Record a retry attempt.
 */
export function recordRetry(): void {
  loadState();
  retryCount += 1;
}

/**
 * Reset per-run counters (call at start of each run).
 */
export function resetRun(): void {
  toolCallsThisRun = 0;
  retryCount = 0;
}

/**
 * Reset session counters (call at session start).
 */
export function resetSession(): void {
  sessionCost = 0;
  sessionCalls = 0;
  resetRun();
}

/**
 * Get current cost status.
 */
export function getCostStatus(): CostStatus {
  loadState();

  const hourlyCost = recentCosts.reduce((sum, c) => sum + c.cost, 0);

  return {
    sessionCost: Math.round(sessionCost * 10000) / 10000,
    sessionCalls,
    hourlyCost: Math.round(hourlyCost * 10000) / 10000,
    toolCallsThisRun,
    budgetRemaining: Math.round((limits.maxSessionDollars - sessionCost) * 10000) / 10000,
    budgetPercentUsed: Math.round((sessionCost / limits.maxSessionDollars) * 1000) / 10,
  };
}

/**
 * Get a formatted status string for logging.
 */
export function getCostStatusString(): string {
  const status = getCostStatus();
  return `[cost-guard] Session: $${status.sessionCost.toFixed(4)} (${status.budgetPercentUsed}% of $${limits.maxSessionDollars}), Calls: ${status.sessionCalls}, Tools: ${status.toolCallsThisRun}`;
}
