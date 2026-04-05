export const DEFAULT_BASE_URL = "https://api.promptguard.co/api/v1";
const REQUEST_TIMEOUT_MS = 10_000;

export type GuardDirection = "input" | "output";
export type GuardDecision = "allow" | "block" | "redact";

export type GuardRequest = {
  messages?: Array<{ role: string; content: string }>;
  content?: string;
  direction?: GuardDirection;
  detectors?: string[];
};

export type GuardResponse = {
  decision: GuardDecision;
  event_id?: string;
  confidence?: number;
  threat_type?: string;
  threats?: Array<{ type: string; confidence: number; detail?: string }>;
  redacted_messages?: Array<{ role: string; content: string }>;
  latency_ms?: number;
};

export type ScanRequest = {
  content: string;
  type?: "prompt" | "response";
};

export type ScanResponse = {
  flagged: boolean;
  categories?: Record<string, boolean>;
  scores?: Record<string, number>;
};

export type RedactRequest = {
  content: string;
  pii_types?: string[];
};

export type RedactResponse = {
  redacted: string;
  entities?: Array<{ type: string; original: string; replacement: string }>;
};

export type ValidateToolRequest = {
  tool_name: string;
  arguments: Record<string, unknown>;
  agent_id?: string;
};

export type ValidateToolResponse = {
  allowed: boolean;
  reason?: string;
  risk_level?: string;
  flagged_arguments?: string[];
};

export type PromptGuardClientConfig = {
  apiKey: string;
  baseUrl?: string;
};

export class PromptGuardClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: PromptGuardClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async guard(req: GuardRequest): Promise<GuardResponse> {
    return this.post<GuardResponse>("/guard", req);
  }

  async scan(req: ScanRequest): Promise<ScanResponse> {
    return this.post<ScanResponse>("/security/scan", req);
  }

  async redact(req: RedactRequest): Promise<RedactResponse> {
    return this.post<RedactResponse>("/security/redact", req);
  }

  async validateTool(req: ValidateToolRequest): Promise<ValidateToolResponse> {
    return this.post<ValidateToolResponse>("/agent/validate-tool", req);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        headers: { "X-API-Key": this.apiKey },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        "X-PromptGuard-SDK": "openclaw-plugin",
        "X-PromptGuard-Version": "1.0.0",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PromptGuard API ${res.status}: ${text.slice(0, 200)}`);
    }

    return (await res.json()) as T;
  }
}
