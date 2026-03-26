import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  renderMonitorConfigSchema,
  type RenderMonitorConfig,
  type RenderMonitorConfigResolved,
  type RenderMonitorServiceTarget,
} from "./types.js";

function safeJsonParse<T>(raw: string | undefined): T | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

function resolveNonEmptyEnv(name: string): string | null {
  const raw = process.env[name];
  const trimmed = raw?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function resolveNumberEnv(name: string): number | null {
  const raw = resolveNonEmptyEnv(name);
  if (!raw) {
    return null;
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function resolveServicesFallback(): RenderMonitorServiceTarget[] {
  const envRaw = resolveNonEmptyEnv("RENDER_MONITOR_SERVICES_JSON");
  if (!envRaw) {
    return [];
  }
  const parsed = safeJsonParse<unknown>(envRaw);
  if (!parsed || !Array.isArray(parsed)) {
    return [];
  }
  // Best-effort: validate minimal required fields for safe runtime behavior.
  const out: RenderMonitorServiceTarget[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const serviceId = typeof record.serviceId === "string" ? record.serviceId.trim() : "";
    if (!serviceId) {
      continue;
    }
    const name = typeof record.name === "string" ? record.name.trim() : undefined;
    const environment =
      typeof record.environment === "string" ? record.environment.trim() : undefined;
    const publicUrl = typeof record.publicUrl === "string" ? record.publicUrl.trim() : undefined;

    const gitRaw = record.git as Record<string, unknown> | undefined;
    let git: RenderMonitorConfig["services"][number]["git"] | undefined;
    if (gitRaw && typeof gitRaw === "object") {
      const repoPath =
        typeof gitRaw.repoPath === "string" ? gitRaw.repoPath.trim() : undefined;
      const githubRepo =
        typeof gitRaw.githubRepo === "string" ? gitRaw.githubRepo.trim() : undefined;
      if (repoPath && githubRepo) {
        git = {
          repoPath,
          githubRepo,
          remote: typeof gitRaw.remote === "string" ? gitRaw.remote.trim() : undefined,
          baseBranch:
            typeof gitRaw.baseBranch === "string" ? gitRaw.baseBranch.trim() : undefined,
          deployBranch:
            typeof gitRaw.deployBranch === "string" ? gitRaw.deployBranch.trim() : undefined,
        };
      }
    }

    out.push({
      serviceId,
      name: name || undefined,
      environment: environment || undefined,
      publicUrl: publicUrl || undefined,
      git,
    });
  }
  return out;
}

export { renderMonitorConfigSchema };

export function loadRenderMonitorConfig(api: OpenClawPluginApi): RenderMonitorConfigResolved {
  const parsedFromConfig = (() => {
    try {
      return renderMonitorConfigSchema.parse(api.pluginConfig ?? {});
    } catch {
      // Keep runtime alive even if plugin config is corrupt.
      return renderMonitorConfigSchema.parse({});
    }
  })();

  const renderApiKey = resolveNonEmptyEnv("RENDER_API_KEY");
  const renderApiBaseUrl =
    parsedFromConfig.renderApiBaseUrl?.trim() ||
    resolveNonEmptyEnv("RENDER_API_BASE_URL") ||
    "https://api.render.com";

  const telegramChatId =
    parsedFromConfig.telegram?.chatId?.trim() ||
    resolveNonEmptyEnv("TELEGRAM_CHAT_ID") ||
    resolveNonEmptyEnv("RENDER_MONITOR_TELEGRAM_CHAT_ID") ||
    "";

  const pollIntervalMinutes =
    parsedFromConfig.pollIntervalMinutes ??
    resolveNumberEnv("RENDER_POLL_INTERVAL_MINUTES") ??
    15;

  const dedupeTtlMinutes =
    parsedFromConfig.dedupeTtlMinutes ??
    resolveNumberEnv("RENDER_DEDUPE_TTL_MINUTES") ??
    60;

  const httpProbeEnabled = Boolean(
    parsedFromConfig.httpProbeEnabled ??
      (resolveNonEmptyEnv("RENDER_HTTP_PROBE_ENABLED")?.toLowerCase() === "true"),
  );

  const httpProbeTimeoutMs =
    parsedFromConfig.httpProbeTimeoutMs ??
    resolveNumberEnv("RENDER_HTTP_PROBE_TIMEOUT_MS") ??
    8000;

  const httpProbeIntervalMinutes =
    parsedFromConfig.httpProbeIntervalMinutes ??
    resolveNumberEnv("RENDER_HTTP_PROBE_INTERVAL_MINUTES") ??
    15;

  const servicesFromConfig = parsedFromConfig.services ?? [];
  const services = servicesFromConfig.length > 0 ? servicesFromConfig : resolveServicesFallback();

  const enabled =
    parsedFromConfig.enabled === false
      ? false
      : Boolean(renderApiKey && services.length > 0);

  const rem = parsedFromConfig.remediations ?? {};
  const remediations: RenderMonitorConfig["remediations"] = {
    investigationTimeoutMs: rem.investigationTimeoutMs ?? 120_000,
    applyTimeoutMs: rem.applyTimeoutMs ?? 10 * 60_000,
    renderVerifyTimeoutMs: rem.renderVerifyTimeoutMs ?? 10 * 60_000,
    ciVerifyTimeoutMs: rem.ciVerifyTimeoutMs ?? 15 * 60_000,
  };

  const cfg: RenderMonitorConfigResolved = {
    ...parsedFromConfig,
    enabled,
    renderApiKey: renderApiKey ?? "",
    renderApiBaseUrl,
    telegram: { chatId: telegramChatId || "" },
    pollIntervalMinutes,
    dedupeTtlMinutes,
    httpProbeEnabled,
    httpProbeTimeoutMs,
    httpProbeIntervalMinutes,
    services,
    remediations,
    enabledAtMs: Date.now(),
  };

  // Ensure shape stays stable even when telegram is missing.
  if (!cfg.telegram.chatId) {
    api.logger.warn?.(
      `render-monitor: TELEGRAM_CHAT_ID missing; incidents will not be alerted.`,
    );
  }

  return cfg;
}
