import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type DreamingBudgetConfig = {
  /** Maximum cost in USD within the sliding window before halting. Default: 1.00 */
  maxCostUsd: number;
  /** Sliding window duration in milliseconds. Default: 3_600_000 (60 min) */
  windowMs: number;
  /** Minimum candidate confidence to allow processing. Default: 0.05 */
  minConfidence: number;
  /** Minimum recall count to allow narrative generation. Default: 1 */
  minRecalls: number;
};

export type BudgetState = {
  version: 1;
  windowStartMs: number;
  accumulatedCostUsd: number;
  sessionsSpawned: number;
};

export type CandidateQualityInfo = {
  confidence: number;
  recallCount: number;
  snippet: string;
};

export type EnforcerDecision =
  | { allowed: true }
  | { allowed: false; reason: "duplicate" | "low_quality" | "budget_exceeded" };

// ── Constants ──────────────────────────────────────────────────────────

const BUDGET_STATE_RELATIVE_PATH = path.join("memory", ".dreams", "dreaming-budget.json");

const DEFAULT_CONFIG: DreamingBudgetConfig = {
  maxCostUsd: 1.0,
  windowMs: 3_600_000,
  minConfidence: 0.05,
  minRecalls: 1,
};

// Conservative per-session cost estimates (USD) based on ~2000 tokens
// input + ~200 tokens output for narrative generation.
const DEFAULT_ESTIMATED_SESSION_COST_USD = 0.045;

// ── Budget Enforcer ────────────────────────────────────────────────────

export class DreamingBudgetEnforcer {
  private readonly config: DreamingBudgetConfig;
  private readonly logger: Logger;
  private readonly processedFingerprints = new Set<string>();
  private budgetState: BudgetState;
  private budgetTripped = false;
  private readonly workspaceDir: string;

  constructor(params: {
    config?: Partial<DreamingBudgetConfig>;
    logger: Logger;
    workspaceDir: string;
    nowMs?: number;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...params.config };
    this.logger = params.logger;
    this.workspaceDir = params.workspaceDir;
    const now = params.nowMs ?? Date.now();
    this.budgetState = { version: 1, windowStartMs: now, accumulatedCostUsd: 0, sessionsSpawned: 0 };
  }

  // ── Deduplication ──────────────────────────────────────────────────

  /**
   * Compute a content fingerprint for a candidate snippet.
   * Uses SHA-256 of normalized (trimmed + lowercased) text.
   */
  static fingerprint(snippet: string): string {
    const normalized = snippet.trim().toLowerCase().replace(/\s+/g, " ");
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  /**
   * Returns true if this candidate should be skipped (already processed).
   */
  shouldSkipDuplicate(snippet: string): boolean {
    const fp = DreamingBudgetEnforcer.fingerprint(snippet);
    if (this.processedFingerprints.has(fp)) {
      return true;
    }
    this.processedFingerprints.add(fp);
    return false;
  }

  // ── Quality gate ───────────────────────────────────────────────────

  /**
   * Returns true if the candidate is below quality thresholds and should
   * be skipped before any LLM call is made.
   */
  shouldSkipLowQuality(candidate: CandidateQualityInfo): boolean {
    if (!Number.isFinite(candidate.confidence) || candidate.confidence < this.config.minConfidence) {
      return true;
    }
    if (
      !Number.isFinite(candidate.recallCount) ||
      candidate.recallCount < this.config.minRecalls
    ) {
      return true;
    }
    return false;
  }

  // ── Cost circuit breaker ───────────────────────────────────────────

  /**
   * Check whether the budget has been exceeded in the current window.
   */
  isBudgetExceeded(nowMs?: number): boolean {
    if (this.budgetTripped) {
      return true;
    }
    const now = nowMs ?? Date.now();
    // If the window has expired, reset it.
    if (now - this.budgetState.windowStartMs > this.config.windowMs) {
      this.budgetState = {
        version: 1,
        windowStartMs: now,
        accumulatedCostUsd: 0,
        sessionsSpawned: 0,
      };
      return false;
    }
    if (this.budgetState.accumulatedCostUsd >= this.config.maxCostUsd) {
      this.budgetTripped = true;
      this.logger.warn(
        `memory-core: dreaming budget exceeded ($${this.budgetState.accumulatedCostUsd.toFixed(2)} >= $${this.config.maxCostUsd.toFixed(2)} in ${Math.round(this.config.windowMs / 60_000)}min window). Halting dreaming cycle.`,
      );
      return true;
    }
    return false;
  }

  /**
   * Record the cost of a completed narrative session.
   */
  recordSessionCost(estimatedCostUsd?: number): void {
    const cost =
      estimatedCostUsd != null && Number.isFinite(estimatedCostUsd) && estimatedCostUsd > 0
        ? estimatedCostUsd
        : DEFAULT_ESTIMATED_SESSION_COST_USD;
    this.budgetState.accumulatedCostUsd += cost;
    this.budgetState.sessionsSpawned += 1;
  }

  // ── Composite check ────────────────────────────────────────────────

  /**
   * Run all three checks in sequence for a candidate. Returns a decision
   * indicating whether the candidate should be processed or skipped.
   */
  checkCandidate(candidate: CandidateQualityInfo, nowMs?: number): EnforcerDecision {
    if (this.isBudgetExceeded(nowMs)) {
      return { allowed: false, reason: "budget_exceeded" };
    }
    if (this.shouldSkipLowQuality(candidate)) {
      return { allowed: false, reason: "low_quality" };
    }
    if (this.shouldSkipDuplicate(candidate.snippet)) {
      return { allowed: false, reason: "duplicate" };
    }
    return { allowed: true };
  }

  // ── Persistence ────────────────────────────────────────────────────

  /**
   * Load budget state from the workspace's budget file.
   * If the file doesn't exist or is invalid, starts fresh.
   */
  async loadState(): Promise<void> {
    const filePath = path.join(this.workspaceDir, BUDGET_STATE_RELATIVE_PATH);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as BudgetState;
      if (
        parsed &&
        parsed.version === 1 &&
        typeof parsed.windowStartMs === "number" &&
        typeof parsed.accumulatedCostUsd === "number" &&
        typeof parsed.sessionsSpawned === "number"
      ) {
        this.budgetState = parsed;
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh.
    }
  }

  /**
   * Persist budget state to the workspace's budget file.
   * Uses atomic write (temp file + rename) to prevent corruption.
   */
  async saveState(): Promise<void> {
    const filePath = path.join(this.workspaceDir, BUDGET_STATE_RELATIVE_PATH);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(this.budgetState, null, 2), "utf-8");
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // Best-effort cleanup of temp file.
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup failures.
      }
      this.logger.error(
        `memory-core: failed to persist dreaming budget state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Accessors (for diagnostics / testing) ──────────────────────────

  getState(): Readonly<BudgetState> {
    return { ...this.budgetState };
  }

  getProcessedCount(): number {
    return this.processedFingerprints.size;
  }

  isTripped(): boolean {
    return this.budgetTripped;
  }
}
