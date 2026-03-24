import type { ResolvedOpenStreamPluginConfig } from "./config.js";
import { buildModelHint, type OpenStreamModelHint } from "./heuristics.js";

type OpenClawConfigLike = Record<string, unknown>;

export type OpenStreamDoctorReport = {
  pluginId: "openstream";
  mode: "plugin-companion";
  providerDefault: string;
  promptGuidanceEnabled: boolean;
  coreBridgeStillNeeded: boolean;
  ollamaConfigured: boolean;
  baseUrl?: string;
  configuredModels: string[];
  modelHints: OpenStreamModelHint[];
  recommendations: string[];
  suggestedPluginConfig: Record<string, unknown>;
  suggestedRuntimeConfig: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function extractConfiguredModelIds(hostConfig: unknown): string[] {
  const cfg = asRecord(hostConfig);
  if (!cfg) {
    return [];
  }
  const models = asRecord(cfg.models);
  const providers = asRecord(models?.providers);
  const ollama = asRecord(providers?.ollama);
  const configuredModels = Array.isArray(ollama?.models) ? ollama?.models : [];
  const result: string[] = [];
  for (const entry of configuredModels) {
    if (typeof entry === "string" && entry.trim()) {
      result.push(entry.trim());
      continue;
    }
    const record = asRecord(entry);
    const id = asString(record?.id) ?? asString(record?.name);
    if (id) {
      result.push(id);
    }
  }
  const defaults = asRecord(cfg.defaults);
  const defaultModels = asRecord(defaults?.models);
  for (const key of ["ollama", "openstream", "chat", "default"]) {
    const modelId = asString(defaultModels?.[key]);
    if (modelId) {
      result.push(modelId);
    }
  }
  return uniqueStrings(result);
}

export function detectOllamaBaseUrl(hostConfig: unknown): string | undefined {
  const cfg = asRecord(hostConfig);
  const models = asRecord(cfg?.models);
  const providers = asRecord(models?.providers);
  const ollama = asRecord(providers?.ollama);
  return asString(ollama?.baseUrl);
}

export function isOllamaConfigured(hostConfig: unknown): boolean {
  return Boolean(detectOllamaBaseUrl(hostConfig) || extractConfiguredModelIds(hostConfig).length > 0);
}

export function buildSuggestedPluginConfig(
  pluginConfig: ResolvedOpenStreamPluginConfig,
): Record<string, unknown> {
  return {
    plugins: {
      entries: {
        openstream: {
          enabled: true,
          config: {
            promptGuidance: pluginConfig.promptGuidance,
            streamingMode: pluginConfig.streamingMode,
            enableMegaContext: pluginConfig.enableMegaContext,
            maxContextWindow: pluginConfig.maxContextWindow,
            doctorDefaultProvider: pluginConfig.doctorDefaultProvider,
          },
        },
      },
    },
  };
}

export function buildSuggestedRuntimeConfig(
  pluginConfig: ResolvedOpenStreamPluginConfig,
): Record<string, unknown> {
  return {
    streaming: {
      mode: pluginConfig.streamingMode,
      bufferSize:
        pluginConfig.streamingMode === "ultra"
          ? 4096
          : pluginConfig.streamingMode === "enhanced"
            ? 2048
            : 1024,
      throttleDelay:
        pluginConfig.streamingMode === "ultra"
          ? 1
          : pluginConfig.streamingMode === "enhanced"
            ? 5
            : 10,
      enableThinkingOutput: pluginConfig.streamingMode === "ultra",
      streamInterval:
        pluginConfig.streamingMode === "ultra"
          ? 10
          : pluginConfig.streamingMode === "enhanced"
            ? 25
            : 50,
    },
    context: {
      enableMegaContext: pluginConfig.enableMegaContext,
      maxContextWindow: pluginConfig.maxContextWindow,
      autoDetectContext: true,
    },
  };
}

export function buildOpenStreamDoctorReport(params: {
  hostConfig: unknown;
  pluginConfig: ResolvedOpenStreamPluginConfig;
  targetModelId?: string;
}): OpenStreamDoctorReport {
  const configuredModels = extractConfiguredModelIds(params.hostConfig);
  const targetModels = uniqueStrings([
    ...(params.targetModelId ? [params.targetModelId] : []),
    ...configuredModels,
  ]).slice(0, 8);
  const modelHints = targetModels.map((modelId) => buildModelHint(modelId, params.pluginConfig));
  const baseUrl = detectOllamaBaseUrl(params.hostConfig);
  const ollamaConfigured = isOllamaConfigured(params.hostConfig);
  const recommendations: string[] = [];

  if (!ollamaConfigured) {
    recommendations.push(
      "Configure models.providers.ollama with a reachable baseUrl before expecting OpenStream runtime guidance to matter.",
    );
  } else if (baseUrl && !baseUrl.includes("/v1")) {
    recommendations.push(
      "Ollama baseUrl looks native already; keep it stable and avoid mixing OpenAI-compatible and native endpoints in the same provider block.",
    );
  } else if (baseUrl) {
    recommendations.push(
      "Base URL appears OpenAI-compatible; if native Ollama discovery behaves oddly, validate the corresponding native /api endpoint too.",
    );
  }

  if (!params.pluginConfig.promptGuidance) {
    recommendations.push(
      "Enable plugin prompt guidance so OpenClaw can keep cached Ollama/tool-call recovery guidance out of user space.",
    );
  }

  if (modelHints.some((hint) => hint.estimatedContextWindow === undefined)) {
    recommendations.push(
      "Some configured models do not match strong OpenStream heuristics yet; keep runtime benchmarks and replay fixtures before widening defaults.",
    );
  }

  if (modelHints.some((hint) => hint.estimatedContextWindow === 2097152)) {
    recommendations.push(
      "Mega-context families are present; keep summarization checkpoints and memory pressure testing in the validation loop.",
    );
  }

  recommendations.push(
    "Use OpenStream for diagnostics, prompt guidance, and safe config generation now; keep raw stream parsing and payload repair on a narrower core or provider-hook path until the runtime surface grows.",
  );

  return {
    pluginId: "openstream",
    mode: "plugin-companion",
    providerDefault: params.pluginConfig.doctorDefaultProvider,
    promptGuidanceEnabled: params.pluginConfig.promptGuidance,
    coreBridgeStillNeeded: true,
    ollamaConfigured,
    ...(baseUrl ? { baseUrl } : {}),
    configuredModels,
    modelHints,
    recommendations,
    suggestedPluginConfig: buildSuggestedPluginConfig(params.pluginConfig),
    suggestedRuntimeConfig: buildSuggestedRuntimeConfig(params.pluginConfig),
  };
}

export function formatDoctorReport(report: OpenStreamDoctorReport): string {
  const lines: string[] = [];
  lines.push("OpenStream doctor");
  lines.push("");
  lines.push(`- mode: ${report.mode}`);
  lines.push(`- provider default: ${report.providerDefault}`);
  lines.push(`- prompt guidance: ${report.promptGuidanceEnabled ? "enabled" : "disabled"}`);
  lines.push(`- core bridge still needed: ${report.coreBridgeStillNeeded ? "yes" : "no"}`);
  lines.push(`- ollama configured: ${report.ollamaConfigured ? "yes" : "no"}`);
  if (report.baseUrl) {
    lines.push(`- baseUrl: ${report.baseUrl}`);
  }
  lines.push(
    `- configured models: ${
      report.configuredModels.length > 0 ? report.configuredModels.join(", ") : "(none detected)"
    }`,
  );
  if (report.modelHints.length > 0) {
    lines.push("");
    lines.push("Model hints:");
    for (const hint of report.modelHints) {
      lines.push(
        `- ${hint.modelId}: reasoning=${hint.reasoning ? "yes" : "no"}, context=${
          hint.estimatedContextWindow ?? "unknown"
        }, maxTokens=${hint.recommendedMaxTokens}, mode=${hint.recommendedStreamingMode}`,
      );
    }
  }
  lines.push("");
  lines.push("Recommendations:");
  for (const recommendation of report.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  return lines.join("\n");
}
