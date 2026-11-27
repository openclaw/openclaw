import {
  readProviderJsonResponse,
  readProviderTextResponse,
} from "openclaw/plugin-sdk/provider-http";
import { ssrfPolicyFromHttpBaseUrlAllowedOrigin } from "openclaw/plugin-sdk/ssrf-runtime";
import { fetchConfiguredLocalOriginWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime-internal";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

async function fetchEndpoint(
  url: string,
  accept: "json" | "text",
): Promise<{ ok: boolean; value?: unknown }> {
  try {
    const configuredLocalOriginBaseUrl = new URL(url).origin;
    const { response, release } = await fetchConfiguredLocalOriginWithSsrFGuard({
      url,
      configuredLocalOriginBaseUrl,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(configuredLocalOriginBaseUrl),
      timeoutMs: 2_500,
      auditContext: "llama-server-inspect",
    });
    try {
      if (!response.ok) {
        return { ok: false };
      }
      const value =
        accept === "json"
          ? await readProviderJsonResponse(response, "llama-server inspection")
          : await readProviderTextResponse(response, "llama-server inspection");
      return { ok: true, value };
    } finally {
      await release();
    }
  } catch {
    return { ok: false };
  }
}

export async function inspectLlamaServerRuntime(params: {
  baseUrl: string;
  modelId: string;
  loadError?: string;
}) {
  const root = params.baseUrl.replace(/\/v1\/?$/u, "").replace(/\/+$/u, "");
  const query = `model=${encodeURIComponent(params.modelId)}&autoload=false`;
  const [health, models, props, metrics] = await Promise.all([
    fetchEndpoint(`${root}/health`, "json"),
    fetchEndpoint(`${root}/models`, "json"),
    fetchEndpoint(`${root}/props?${query}`, "json"),
    fetchEndpoint(`${root}/metrics?${query}`, "text"),
  ]);
  const propsRecord = asOptionalRecord(props.value);
  const modalities = asOptionalRecord(propsRecord?.modalities);
  const modelsRecord = asOptionalRecord(models.value);
  const modelRows = Array.isArray(modelsRecord?.data) ? modelsRecord.data : [];
  const selected = modelRows
    .map((row) => asOptionalRecord(row))
    .find((row) => row?.id === params.modelId);
  const pathValue =
    typeof propsRecord?.model_path === "string"
      ? propsRecord.model_path
      : typeof selected?.path === "string"
        ? selected.path
        : undefined;
  return {
    engine: "llama.cpp" as const,
    state:
      health.ok && models.ok && props.ok && !params.loadError
        ? ("ready" as const)
        : ("failed" as const),
    backend: undefined,
    buildInfo: typeof propsRecord?.build_info === "string" ? propsRecord.build_info : undefined,
    model: { id: params.modelId, ...(pathValue ? { path: pathValue } : {}) },
    capabilities: {
      vision: modalities?.vision === true,
      // OpenClaw does not configure a draft model in the managed preset.
      draft: false,
    },
    endpoints: {
      health: health.ok ? ("ready" as const) : ("unavailable" as const),
      models: models.ok ? ("ready" as const) : ("unavailable" as const),
      props: props.ok ? ("ready" as const) : ("unavailable" as const),
      metrics: metrics.ok ? ("ready" as const) : ("unavailable" as const),
    },
    ...(params.loadError ? { loadError: params.loadError } : {}),
  };
}
