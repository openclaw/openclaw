export type RunKind = "health" | "digest" | "free";

export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type RunResult = {
  summary: string | null;
  key_points: string[];
  suggested_next_action: string | null;
  exit_code: number | null;
  raw_output: string | null;
};

export type RunError = {
  message: string;
  code?: string | null;
  detail?: string | null;
};

export type RunRecord = {
  run_id: string;
  requested_by: string;
  requested_by_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  raw_text: string;
  kind: RunKind;
  normalized_task: string;
  params: Record<string, unknown>;
  status: RunStatus;
  sense_job_id: string | null;
  queued_at: string;
  started_at: string | null;
  done_at: string | null;
  result: RunResult | null;
  error: RunError | null;
  retry_of: string | null;
  retry_count: number;
  slack_ts: string | null;
};
