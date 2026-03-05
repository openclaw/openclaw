/**
 * Remote Backtest Agent API types — aligned with FEP v1.1.
 *
 * These mirror the Findoo Backtest Agent REST API at /api/v1/*.
 * v1.1 uses camelCase for result_summary/performance fields.
 */

// ---------------------------------------------------------------------------
// Enums / literals
// ---------------------------------------------------------------------------

export type EngineType = "script" | "agent";

/** v1.1: no "running" or "cancelled" — uses "processing"; cancel → "failed". */
export type TaskStatus =
  | "submitted"
  | "rejected"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

/** Terminal statuses — polling stops when the task reaches one of these. */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "rejected",
]);

// ---------------------------------------------------------------------------
// Task (returned by POST /backtests, GET /backtests/{id})
// ---------------------------------------------------------------------------

export interface RemoteTask {
  task_id: string;
  status: TaskStatus;
  created_at: string;
  updated_at?: string;
  message?: string;
  reject_reason?: string | null;
  progress?: number | null;
  /** Inline summary, only present when status === "completed". */
  result_summary?: RemoteResultSummary | null;
}

// ---------------------------------------------------------------------------
// result_summary — camelCase, 3 core fields (inline in task response)
// ---------------------------------------------------------------------------

export interface RemoteResultSummary {
  totalReturn: number;
  maxDrawdown: number;
  totalTrades: number;
}

// ---------------------------------------------------------------------------
// Report (GET /backtests/{id}/report)
// ---------------------------------------------------------------------------

export interface RemoteReport {
  task_id: string;
  performance: RemotePerformance | null;
  alpha: Record<string, unknown> | null;
  equity_curve: RemoteEquityPoint[] | null;
  trade_journal: RemoteTradeEntry[] | null;
}

/** Performance fields use short names (sharpe, not sharpeRatio). */
export interface RemotePerformance {
  totalReturn: number;
  sharpe?: number;
  sortino?: number;
  calmar?: number;
  maxDrawdown?: number;
  totalTrades?: number;
  winRate?: number;
  profitFactor?: number;
  finalEquity?: number;
  annualizedReturn?: number;
  maxDrawdownStart?: string;
  maxDrawdownEnd?: string;
  monthlyReturns?: Record<string, number>;
  [key: string]: unknown;
}

export interface RemoteTradeEntry {
  date: string;
  action: "buy" | "sell" | "hold" | string;
  amount?: number;
  price?: number;
  reason?: string;
  [key: string]: unknown;
}

export interface RemoteEquityPoint {
  date: string;
  equity: number;
}

// ---------------------------------------------------------------------------
// Submit response (POST /backtests — multipart/form-data)
// ---------------------------------------------------------------------------

export interface SubmitResponse {
  task_id: string;
  status: string;
  message?: string;
}

/** Optional parameters sent alongside the upload file. */
export interface UploadParams {
  symbol?: string;
  initial_capital?: number;
  start_date?: string;
  end_date?: string;
  engine?: EngineType;
  budget_cap_usd?: number;
}

// ---------------------------------------------------------------------------
// Cancel response (DELETE /backtests/{id})
// ---------------------------------------------------------------------------

export interface CancelResponse {
  task_id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// List response
// ---------------------------------------------------------------------------

export interface ListResponse {
  tasks: RemoteTask[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Health response
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;
  version?: string;
  engines?: string[];
}

// ---------------------------------------------------------------------------
// Strategy validation (local compliance check)
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  level: "error" | "warning";
  category: "structure" | "interface" | "safety" | "yaml" | "data";
  file?: string;
  message: string;
  fix?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
