import type {
  DetectedRenderIncident,
  RenderIncidentType,
  RenderMonitorServiceTarget,
  RenderServiceSnapshot,
} from "./types.js";

function normalizeLower(value?: string | null): string {
  return (value ?? "").toLowerCase().trim();
}

function resolveHealthFailure(healthState?: string | null): boolean {
  const s = normalizeLower(healthState);
  if (!s) return false;
  return ["failing", "fail", "failed", "unhealthy", "down", "error"].some((needle) => s.includes(needle));
}

function resolveDeployFailure(status?: string | null): boolean {
  const s = normalizeLower(status);
  if (!s) return false;
  return ["failed", "errored", "error", "canceled", "cancelled"].some((needle) => s.includes(needle));
}

function resolveServiceError(status?: string | null): boolean {
  const s = normalizeLower(status);
  if (!s) return false;
  return ["error", "failed", "suspended"].some((needle) => s.includes(needle));
}

function resolveHttpFailure(url?: string): boolean {
  if (!url) return false;
  // HTTP probe is done elsewhere; this is a placeholder.
  return false;
}

export async function probeHttpAvailability(url: string, opts: {
  timeoutMs: number;
}): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    // Any HTTP response (including 404, 403, etc.) means the server is alive.
    // Only 5xx indicates a real server-side problem.
    return res.status < 500;
  } finally {
    clearTimeout(timeout);
  }
}

export async function detectRenderIncidents(params: {
  service: RenderMonitorServiceTarget;
  snapshot: RenderServiceSnapshot;
  httpProbeEnabled: boolean;
  httpProbeTimeoutMs: number;
  consecutiveServiceErrorStreakCount?: number;
  nowMs: number;
}): Promise<DetectedRenderIncident[]> {
  const { snapshot, service } = params;
  const incidents: DetectedRenderIncident[] = [];

  const healthFailed = resolveHealthFailure(snapshot.healthCheckState);
  const deployFailed = resolveDeployFailure(snapshot.latestDeploy?.status);
  const serviceError = resolveServiceError(snapshot.status);

  const latestDeployId = snapshot.latestDeploy?.id ?? null;

  if (deployFailed) {
    incidents.push({
      incidentType: "deploy_failed",
      fingerprint: "",
      incidentId: "",
      serviceId: snapshot.serviceId,
      summary: `Deploy failed on Render (deploy=${latestDeployId ?? "unknown"}).`,
      createdAtMs: params.nowMs,
      details: {
        deployId: latestDeployId,
        deployStatus: snapshot.latestDeploy?.status ?? null,
      },
    });
    // Still allow additional labels if health is also failed.
  }

  if (healthFailed) {
    incidents.push({
      incidentType: "healthcheck_failed",
      fingerprint: "",
      incidentId: "",
      serviceId: snapshot.serviceId,
      summary: `Health check failing on Render (state=${snapshot.healthCheckState ?? "unknown"}).`,
      createdAtMs: params.nowMs,
      details: {
        healthCheckState: snapshot.healthCheckState ?? null,
      },
    });
  }

  if (serviceError) {
    incidents.push({
      incidentType: "service_error",
      fingerprint: "",
      incidentId: "",
      serviceId: snapshot.serviceId,
      summary: `Service error on Render (status=${snapshot.status ?? "unknown"}).`,
      createdAtMs: params.nowMs,
      details: {
        serviceStatus: snapshot.status ?? null,
      },
    });
  }

  // HTTP probing (indisponibilité HTTP)
  if (params.httpProbeEnabled && service.publicUrl?.trim()) {
    try {
      const ok = await probeHttpAvailability(service.publicUrl, {
        timeoutMs: params.httpProbeTimeoutMs,
      });
      if (!ok) {
        incidents.push({
          incidentType: "http_unavailable",
          fingerprint: "",
          incidentId: "",
          serviceId: snapshot.serviceId,
          summary: `HTTP endpoint unavailable (probe failed).`,
          createdAtMs: params.nowMs,
          details: {
            publicUrl: service.publicUrl,
          },
        });
      }
    } catch (err) {
      incidents.push({
        incidentType: "http_unavailable",
        fingerprint: "",
        incidentId: "",
        serviceId: snapshot.serviceId,
        summary: `HTTP endpoint probe failed (${String((err as Error)?.message ?? err)}).`,
        createdAtMs: params.nowMs,
        details: {
          publicUrl: service.publicUrl,
          probeError: String((err as Error)?.message ?? err),
        },
      });
    }
  }

  // Crash repetition heuristic: if we keep seeing service_error streak.
  if (serviceError && (params.consecutiveServiceErrorStreakCount ?? 0) >= 3) {
    incidents.push({
      incidentType: "crash_repeated",
      fingerprint: "",
      incidentId: "",
      serviceId: snapshot.serviceId,
      summary: `Crash repeated heuristic: service_error observed ${params.consecutiveServiceErrorStreakCount} times.`,
      createdAtMs: params.nowMs,
      details: {
        streakCount: params.consecutiveServiceErrorStreakCount ?? 0,
      },
    });
  }

  return incidents;
}

