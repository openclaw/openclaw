/** HTTP client for the Verdict policy gateway. */

import type {
  ActionRequest,
  DiscoveryResponse,
  HealthResponse,
  PolicyDecision,
  PolicyExplanation,
  TraceSummaryResponse,
} from "./types.js";

export type VerdictClientOptions = {
  gatewayUrl: string;
  timeoutMs?: number;
};

export class VerdictClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: VerdictClientOptions) {
    // Strip trailing slash
    this.baseUrl = opts.gatewayUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  /** Evaluate a tool call against loaded policies. */
  async evaluate(request: ActionRequest, shadow?: boolean): Promise<PolicyDecision> {
    const url = shadow ? `${this.baseUrl}/evaluate?shadow=true` : `${this.baseUrl}/evaluate`;
    return await this.post<PolicyDecision>(url, request);
  }

  /** Health check with metrics. */
  async health(): Promise<HealthResponse> {
    return await this.get<HealthResponse>("/health");
  }

  /** List all loaded policies. */
  async listPolicies(): Promise<DiscoveryResponse> {
    return await this.get<DiscoveryResponse>("/policies");
  }

  /** Explain a specific policy. */
  async explainPolicy(name: string): Promise<PolicyExplanation> {
    return await this.get<PolicyExplanation>(`/policies/${encodeURIComponent(name)}/explain`);
  }

  /** Get policies for a specific tool. */
  async toolPolicies(toolName: string): Promise<{ tool: string; policies: PolicyExplanation[] }> {
    return await this.get(`/tools/${encodeURIComponent(toolName)}/policies`);
  }

  /** Get trace summary statistics. */
  async tracesSummary(since?: string): Promise<TraceSummaryResponse> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    return await this.get<TraceSummaryResponse>(`/traces/summary${qs}`);
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Verdict GET ${path} failed: ${resp.status} ${text}`);
    }
    return (await resp.json()) as T;
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Verdict POST ${url} failed: ${resp.status} ${text}`);
    }
    return (await resp.json()) as T;
  }
}
