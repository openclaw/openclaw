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

    // Render v1 /services/{id} returns config only — runtime status comes from
    // the suspended field and the separate deploys endpoint.
    const suspended = normalizeStringOrNull(raw.suspended);
    const isSuspended = suspended != null && suspended !== "not_suspended";

    // Fetch latest deploy from the dedicated endpoint.
    // Response shape: [{ deploy: { id, status, commit, ... }, cursor }]
    type DeployEntry = { deploy?: Record<string, unknown> };
    const deploysRaw = await this.requestJson<DeployEntry[]>(
      `/v1/services/${serviceId}/deploys`,
      { limit: "1" },
    ).catch(() => [] as DeployEntry[]);

    const latestDeployRaw = deploysRaw[0]?.deploy ?? null;
    const latestDeploy = latestDeployRaw
      ? {
          id: normalizeStringOrNull(latestDeployRaw.id) ?? null,
          status: normalizeStringOrNull(latestDeployRaw.status) ?? null,
          commitSha:
            normalizeStringOrNull(
              (latestDeployRaw.commit as Record<string, unknown>)?.id ??
                latestDeployRaw.commit_sha ??
                latestDeployRaw.commitSha,
            ) ?? null,
        }
      : null;

    // Derive a top-level status from deploy + suspension state.
    const deployStatus = latestDeploy?.status ?? null;
    const status = isSuspended
      ? "suspended"
      : deployStatus;

    // Render v1 does not expose healthCheckState directly; derive from
    // deploy status when possible (live = healthy, build_failed = failing).
    const healthCheckState =
      deployStatus === "live" ? "healthy"
        : deployStatus && ["build_failed", "update_failed", "pre_deploy_failed"].includes(deployStatus)
          ? "failing"
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

