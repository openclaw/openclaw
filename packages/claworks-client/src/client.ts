import type {
  HealthResponse,
  TriggerPlaybookResponse,
  KbSearchResult,
  RobotStatusResponse,
  PublishEventResponse,
  HealthDimensionsResponse,
  PlaybookRun,
} from "./types.js";

export class ClaworksClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!resp.ok) {
      throw new Error(`GET ${path} failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.json() as Promise<T>;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      throw new Error(`POST ${path} failed: ${resp.status} ${resp.statusText}`);
    }
    return resp.json() as Promise<T>;
  }

  /** GET /health — 基础健康检查 */
  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health");
  }

  /** GET /healthz — 机器人公开健康端点 */
  async healthz(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/healthz");
  }

  /** GET /v1/health/dimensions — 健康维度详情 */
  async healthDimensions(): Promise<HealthDimensionsResponse> {
    return this.get<HealthDimensionsResponse>("/v1/health/dimensions");
  }

  /** GET /v1/robot/status — 机器人整体运行状态 */
  async robotStatus(): Promise<RobotStatusResponse> {
    return this.get<RobotStatusResponse>("/v1/robot/status");
  }

  /** POST /v1/playbooks/:id/trigger — 触发 Playbook */
  async triggerPlaybook(
    id: string,
    payload?: Record<string, unknown>,
  ): Promise<TriggerPlaybookResponse> {
    const data = await this.post<{ run_id?: string; runId?: string }>(
      `/v1/playbooks/${encodeURIComponent(id)}/trigger`,
      payload ?? {},
    );
    return { runId: data.run_id ?? data.runId ?? "" };
  }

  /** GET /v1/playbooks/runs/:id — 查询 Playbook 运行状态 */
  async getPlaybookRun(runId: string): Promise<PlaybookRun> {
    return this.get<PlaybookRun>(`/v1/playbooks/runs/${encodeURIComponent(runId)}`);
  }

  /** POST /v1/kb/search — 知识库搜索 */
  async kbSearch(query: string, limit = 5): Promise<KbSearchResult[]> {
    const data = await this.post<{ results?: KbSearchResult[] }>("/v1/kb/search", {
      query,
      limit,
    });
    return data.results ?? [];
  }

  /** POST /v1/capabilities/:id/call — 调用能力 */
  async callCapability(id: string, params: Record<string, unknown>): Promise<unknown> {
    const data = await this.post<{ result?: unknown }>(
      `/v1/capabilities/${encodeURIComponent(id)}/invoke`,
      {
        params,
      },
    );
    return data.result;
  }

  /** POST /v1/events/publish — 发布事件 */
  async publishEvent(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<PublishEventResponse> {
    const data = await this.post<{ published?: boolean }>("/v1/events/publish", {
      event_type: type,
      payload,
    });
    return { published: data.published ?? true };
  }
}
