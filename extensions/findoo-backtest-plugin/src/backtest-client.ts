import type {
  CancelResponse,
  HealthResponse,
  ListResponse,
  RemoteReport,
  RemoteTask,
  SubmitResponse,
  UploadParams,
} from "./types.js";

/**
 * Thin HTTP client for the Findoo Backtest Agent REST API (v1.1).
 *
 * Base URL: `http://<host>:8000/api/v1`
 *
 * Key v1.1 changes vs v1.0:
 * - Submit = multipart POST /backtests (file + optional form fields)
 * - Cancel = DELETE /backtests/{id}
 * - No separate /backtests/upload endpoint
 */
export class BacktestClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {
    this.base = `${baseUrl}/api/v1`;
  }

  // ------------------------------------------------------------------
  // Core operations
  // ------------------------------------------------------------------

  /** POST /backtests — submit a backtest via multipart/form-data (ZIP upload). */
  async submit(archive: Buffer, filename: string, params?: UploadParams): Promise<SubmitResponse> {
    const form = new FormData();
    form.append("file", new Blob([archive], { type: "application/zip" }), filename);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value != null) form.append(key, String(value));
      }
    }

    const resp = await fetch(`${this.base}/backtests`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.handleResponse<SubmitResponse>(resp);
  }

  /** GET /backtests/{id} — get task status. */
  async getTask(taskId: string): Promise<RemoteTask> {
    return this.get<RemoteTask>(`/backtests/${encodeURIComponent(taskId)}`);
  }

  /** GET /backtests/{id}/report — get completed report. */
  async getReport(taskId: string): Promise<RemoteReport> {
    return this.get<RemoteReport>(`/backtests/${encodeURIComponent(taskId)}/report`);
  }

  /** GET /backtests — list tasks with pagination. */
  async listTasks(limit = 20, offset = 0): Promise<ListResponse> {
    return this.get<ListResponse>(`/backtests?limit=${limit}&offset=${offset}`);
  }

  /** DELETE /backtests/{id} — cancel a queued/processing task. */
  async cancelTask(taskId: string): Promise<CancelResponse> {
    return this.delete<CancelResponse>(`/backtests/${encodeURIComponent(taskId)}`);
  }

  // ------------------------------------------------------------------
  // Health
  // ------------------------------------------------------------------

  /** GET /health — platform health check. */
  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health");
  }

  // ------------------------------------------------------------------
  // HTTP helpers
  // ------------------------------------------------------------------

  /** Auth-only headers (no Content-Type — let FormData/fetch set it). */
  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) {
      h["X-API-Key"] = this.apiKey;
    }
    return h;
  }

  /** JSON-capable headers for GET requests. */
  private jsonHeaders(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      h["X-API-Key"] = this.apiKey;
    }
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.base}${path}`, {
      method: "GET",
      headers: this.jsonHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.handleResponse<T>(resp);
  }

  private async delete<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.base}${path}`, {
      method: "DELETE",
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.handleResponse<T>(resp);
  }

  private async handleResponse<T>(resp: Response): Promise<T> {
    const text = await resp.text();

    if (!resp.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text);
        if (parsed.detail) detail = String(parsed.detail);
        else if (parsed.error) detail = String(parsed.error);
      } catch {
        // use raw text
      }
      throw new Error(`Backtest API error (${resp.status}): ${detail}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Backtest API returned non-JSON (${resp.status}): ${text.slice(0, 200)}`);
    }
  }
}
