/**
 * Remote Backtest Agent API types.
 *
 * These mirror the Findoo Backtest Agent REST API at /api/v1/*.
 * All remote types use snake_case to match the API; local types use camelCase.
 */

// ---------------------------------------------------------------------------
// Enums / literals
// ---------------------------------------------------------------------------

export type EngineType = "script" | "agent";

export type TaskStatus =
  | "submitted"
  | "queued"
  | "running"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";

/** Terminal statuses — polling stops when the task reaches one of these. */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);

// ---------------------------------------------------------------------------
// Submit request
// ---------------------------------------------------------------------------

export interface SubmitRequest {
  strategy_dir: string;
  engine: EngineType;
  symbol?: string;
  initial_capital?: number;
  start_date: string;
  end_date: string;
  csv_path?: string;
  // L2 (agent) specific
  budget_cap_usd?: number;
  max_turns_per_period?: number;
  agent_model?: string;
  agent_mode?: string;
  reflection_interval?: number;
}

// ---------------------------------------------------------------------------
// Task (returned by POST /backtests, GET /backtests/:id)
// ---------------------------------------------------------------------------

export interface RemoteTask {
  task_id: string;
  status: TaskStatus;
  engine: EngineType;
  strategy_dir: string;
  symbol: string;
  initial_capital: number;
  start_date: string;
  end_date: string;
  created_at: string;
  updated_at?: string;
  error?: string;
  message?: string;
  reject_reason?: string;
  progress?: number | null;
}

// ---------------------------------------------------------------------------
// Report (returned by GET /backtests/:id/report)
// ---------------------------------------------------------------------------

export interface RemoteResultSummary {
  total_return: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  max_drawdown: number;
  calmar_ratio: number;
  win_rate: number;
  profit_factor: number;
  total_trades: number;
  final_equity: number;
  // L2 may include extra fields
  alpha?: number;
  beta?: number;
  information_ratio?: number;
}

export interface RemoteTrade {
  entry_time: string;
  exit_time: string;
  symbol: string;
  side: "long" | "short";
  entry_price: number;
  exit_price: number;
  quantity: number;
  commission: number;
  slippage: number;
  pnl: number;
  pnl_pct: number;
  reason: string;
  exit_reason: string;
}

export interface RemoteEquityPoint {
  date: string;
  equity: number;
}

export interface RemoteReport {
  task_id: string;
  result_summary: RemoteResultSummary;
  trades: RemoteTrade[];
  equity_curve: RemoteEquityPoint[];
  // Raw data from remote; may contain extra engine-specific fields
  [key: string]: unknown;
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
// Upload response (POST /strategies/upload)
// ---------------------------------------------------------------------------

export interface UploadResponse {
  task_id: string;
  status: string;
  message: string;
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
// Strategy validation (local compliance check)
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  level: "error" | "warning";
  category: "structure" | "interface" | "safety" | "yaml" | "data";
  file?: string;
  message: string;
  fix?: string; // suggested fix
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
