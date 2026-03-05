import { NextResponse } from "next/server";
import { getActiveProvider, loadConfig, resolveProvider } from "../../../../../src/codegen/config";

type HealthStatus = "ok" | "degraded" | "unreachable" | "unknown" | "unconfigured";

interface SettingsDiagnostics {
  provider: string;
  model: string;
  endpoint_host: string;
  health_status: HealthStatus;
  checked_at: number;
}

function maskHost(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).host;
    if (host.length <= 6) {
      return host;
    }
    return `${host.slice(0, 3)}***${host.slice(-3)}`;
  } catch {
    return "unknown";
  }
}

async function probe(baseUrl: string, apiKey: string): Promise<HealthStatus> {
  if (process.env.NODE_ENV === "test") {
    return "unknown";
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    const healthUrl = new URL("/models", baseUrl).toString();
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok || response.status === 401 || response.status === 403) {
      return "ok";
    }
    return "degraded";
  } catch {
    return "unreachable";
  }
}

export async function GET(): Promise<NextResponse<SettingsDiagnostics>> {
  try {
    const config = loadConfig();
    const active = getActiveProvider(config);
    const provider = resolveProvider(active.provider);
    const baseUrl = provider.base_url || "https://api.openai.com/v1";

    const payload: SettingsDiagnostics = {
      provider: provider.type,
      model: active.model,
      endpoint_host: maskHost(baseUrl),
      health_status: await probe(baseUrl, provider.api_key),
      checked_at: Date.now(),
    };

    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({
      provider: "unconfigured",
      model: "n/a",
      endpoint_host: "n/a",
      health_status: "unconfigured",
      checked_at: Date.now(),
    });
  }
}
