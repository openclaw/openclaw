import type { RenderServiceSnapshot } from "./types.js";

export type RenderClientOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
};

function normalizeStringOrNull(value: unknown): string | null | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export class RenderClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(opts: RenderClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.render.com";
    this.timeoutMs = opts.timeoutMs ?? 12_000;
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestJson<T>(path: string, query?: Record<string, string>): Promise<T> {
    const q =
      query && Object.keys(query).length > 0
        ? `?${new URLSearchParams(query).toString()}`
        : "";
    const url = `${this.baseUrl}${path}${q}`;
    return await this.withTimeout(async (signal) => {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`render api request failed (${res.status}): ${body.slice(0, 600)}`);
      }
      return (await res.json()) as T;
    });
  }

  async getService(serviceId: string): Promise<RenderServiceSnapshot> {
    const raw = await this.requestJson<Record<string, unknown>>(`/v1/services/${serviceId}`);
    const status = normalizeStringOrNull(raw.status);
    const healthCheckState = normalizeStringOrNull(
      (raw as Record<string, unknown>).health_check_state ??
        (raw as Record<string, unknown>).healthCheckState,
    );

    const latestDeployRaw = (raw as Record<string, unknown>).latest_deploy ?? (raw as any).latestDeploy;
    const latestDeploy =
      latestDeployRaw && typeof latestDeployRaw === "object"
        ? {
            id: normalizeStringOrNull((latestDeployRaw as Record<string, unknown>).id) ?? null,
            status:
              normalizeStringOrNull(
                (latestDeployRaw as Record<string, unknown>).status ??
                  (latestDeployRaw as any).state,
              ) ?? null,
            commitSha:
              normalizeStringOrNull(
                (latestDeployRaw as Record<string, unknown>).commit_sha ??
                  (latestDeployRaw as Record<string, unknown>).commitSha ??
                  (latestDeployRaw as any).commit,
              ) ?? null,
          }
        : null;

    return {
      serviceId,
      raw,
      status,
      healthCheckState,
      latestDeploy,
    };
  }
}

