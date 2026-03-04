import type {
  HealthResponse,
  ListResponse,
  RemoteReport,
  RemoteTask,
  SubmitRequest,
  UploadParams,
  UploadResponse,
} from "./types.js";

/**
 * Thin HTTP client for the Findoo Backtest Agent REST API.
 *
 * Base URL: `http://<host>:8000/api/v1`
 * All methods throw on non-2xx responses.
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
  // Core CRUD
  // ------------------------------------------------------------------

  /** POST /backtests — submit a new backtest task. */
  async submit(req: SubmitRequest): Promise<RemoteTask> {
    return this.post<RemoteTask>("/backtests", req);
  }

  /** GET /backtests/:id — get task status. */
  async getTask(taskId: string): Promise<RemoteTask> {
    return this.get<RemoteTask>(`/backtests/${encodeURIComponent(taskId)}`);
  }

  /** GET /backtests/:id/report — get completed report. */
  async getReport(taskId: string): Promise<RemoteReport> {
    return this.get<RemoteReport>(`/backtests/${encodeURIComponent(taskId)}/report`);
  }

  /** GET /backtests — list tasks with pagination. */
  async listTasks(limit = 20, offset = 0): Promise<ListResponse> {
    return this.get<ListResponse>(`/backtests?limit=${limit}&offset=${offset}`);
  }

  /** POST /backtests/:id/cancel — cancel a queued task. */
  async cancelTask(taskId: string): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>(`/backtests/${encodeURIComponent(taskId)}/cancel`, {});
  }

  // ------------------------------------------------------------------
  // Upload
  // ------------------------------------------------------------------

  /** POST /backtests/upload — upload a strategy archive and optionally submit. */
  async uploadStrategy(
    archiveBuffer: Buffer,
    filename: string,
    params?: UploadParams,
  ): Promise<UploadResponse> {
    const form = new FormData();
    form.append("file", new Blob([archiveBuffer], { type: "application/zip" }), filename);

    // Append optional backtest params as form fields
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value != null) form.append(key, String(value));
      }
    }

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
    }

    const resp = await fetch(`${this.base}/backtests/upload`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.handleResponse<UploadResponse>(resp);
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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      h["X-API-Key"] = this.apiKey;
    }
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.base}${path}`, {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.handleResponse<T>(resp);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const resp = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
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
