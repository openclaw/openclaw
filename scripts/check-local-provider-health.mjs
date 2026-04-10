#!/usr/bin/env node

import fs from "node:fs";

export const LOCAL_PROVIDER_IDS = ["ollama", "vllm", "sglang"];
export const LOCAL_PROVIDER_DEFAULTS = {
  ollama: {
    baseUrl: "http://127.0.0.1:11434",
    probePath: "/api/tags",
  },
  vllm: {
    baseUrl: "http://127.0.0.1:8000/v1",
    probePath: "/models",
  },
  sglang: {
    baseUrl: "http://127.0.0.1:30000/v1",
    probePath: "/models",
  },
};

export const DEFAULT_VLLM_CODER_JOURNAL_UNITS = [
  "openclaw-tool-coder-vllm-models.service",
  "openclaw-vllm-coder.service",
];

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function stripTrailingSlashes(value) {
  return normalizeNonEmptyString(value).replace(/\/+$/u, "");
}

function resolveModelsJsonPath(env = process.env) {
  const override = normalizeNonEmptyString(env.OPENCLAW_AGENT_MODELS_JSON);
  if (override) {
    return override;
  }
  const home = normalizeNonEmptyString(env.HOME);
  if (!home) {
    throw new Error("HOME is not set and OPENCLAW_AGENT_MODELS_JSON is empty");
  }
  return `${home}/.openclaw/agents/main/agent/models.json`;
}

export function parseModelsJsonPayload(raw) {
  const text = normalizeNonEmptyString(raw);
  if (!text) {
    throw new Error("empty models.json payload");
  }
  return JSON.parse(text);
}

export function loadModelsJsonPayload(pathname) {
  return parseModelsJsonPayload(fs.readFileSync(pathname, "utf8"));
}

function normalizeOllamaBaseUrl(baseUrl) {
  const trimmed = stripTrailingSlashes(baseUrl || LOCAL_PROVIDER_DEFAULTS.ollama.baseUrl);
  return trimmed.replace(/\/v1$/iu, "");
}

function normalizeOpenAiCompatBaseUrl(baseUrl, fallbackBaseUrl) {
  const trimmed = stripTrailingSlashes(baseUrl || fallbackBaseUrl);
  return /\/v1$/iu.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function listConfiguredLocalProviders(modelsPayload) {
  const providers =
    modelsPayload?.providers && typeof modelsPayload.providers === "object"
      ? modelsPayload.providers
      : {};
  const configured = [];

  for (const providerId of LOCAL_PROVIDER_IDS) {
    const rawEntry = providers[providerId];
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }
    const entry = rawEntry;
    const models = Array.isArray(entry.models)
      ? entry.models
          .map((model) =>
            typeof model?.id === "string" && model.id.trim()
              ? model.id.trim()
              : typeof model?.name === "string" && model.name.trim()
                ? model.name.trim()
                : "",
          )
          .filter(Boolean)
      : [];
    configured.push({
      providerId,
      api: normalizeNonEmptyString(entry.api) || providerId,
      baseUrl:
        normalizeNonEmptyString(entry.baseUrl) || LOCAL_PROVIDER_DEFAULTS[providerId].baseUrl,
      modelIds: models,
    });
  }

  return configured;
}

export function selectConfiguredLocalProvider(modelsPayload, preferredProviderId = "") {
  const configured = listConfiguredLocalProviders(modelsPayload);
  const normalizedPreferred = normalizeNonEmptyString(preferredProviderId).toLowerCase();
  if (normalizedPreferred) {
    return configured.find((entry) => entry.providerId === normalizedPreferred) ?? null;
  }
  return configured[0] ?? null;
}

export function buildProviderProbeUrl(provider) {
  if (!provider) {
    throw new Error("provider is required");
  }
  if (provider.providerId === "ollama") {
    return `${normalizeOllamaBaseUrl(provider.baseUrl)}${LOCAL_PROVIDER_DEFAULTS.ollama.probePath}`;
  }
  const defaults = LOCAL_PROVIDER_DEFAULTS[provider.providerId] ?? LOCAL_PROVIDER_DEFAULTS.vllm;
  return `${normalizeOpenAiCompatBaseUrl(provider.baseUrl, defaults.baseUrl)}${defaults.probePath}`;
}

export async function probeLocalProvider(provider, fetchImpl = fetch) {
  const url = buildProviderProbeUrl(provider);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        providerId: provider.providerId,
        ok: false,
        reachable: true,
        status: response.status,
        url,
        modelCount: 0,
        reason: `http_${response.status}`,
      };
    }
    const payload = text ? JSON.parse(text) : {};
    const modelCount =
      provider.providerId === "ollama"
        ? Array.isArray(payload?.models)
          ? payload.models.length
          : 0
        : Array.isArray(payload?.data)
          ? payload.data.length
          : 0;
    return {
      providerId: provider.providerId,
      ok: true,
      reachable: true,
      status: response.status,
      url,
      modelCount,
      reason: "ok",
    };
  } catch (error) {
    return {
      providerId: provider.providerId,
      ok: false,
      reachable: false,
      status: 0,
      url,
      modelCount: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseVllmCoderStartBlocked(line) {
  const text = normalizeNonEmptyString(line);
  if (!text.includes("VLLM_CODER_START_BLOCKED")) {
    return null;
  }
  const reason = text.match(/reason=([A-Z0-9_]+)/u)?.[1] ?? "BLOCKED";
  const freeMb = text.match(/free_mb=([A-Za-z0-9._-]+)/u)?.[1];
  const minFreeMb = text.match(/min_free_mb=([A-Za-z0-9._-]+)/u)?.[1];
  return {
    reason,
    ...(freeMb ? { freeMb } : {}),
    ...(minFreeMb ? { minFreeMb } : {}),
  };
}

export function resolveVllmCoderJournalUnits(env = process.env) {
  const override = normalizeNonEmptyString(env.OPENCLAW_VLLM_CODER_JOURNAL_UNITS);
  if (!override) {
    return [...DEFAULT_VLLM_CODER_JOURNAL_UNITS];
  }
  return override
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function detectVllmCoderJournalIssue(params = {}) {
  const units = Array.isArray(params.units)
    ? params.units
    : resolveVllmCoderJournalUnits(params.env);
  const journalByUnit =
    params.journalByUnit && typeof params.journalByUnit === "object" ? params.journalByUnit : {};

  for (const unit of units) {
    const text = normalizeNonEmptyString(journalByUnit[unit]);
    if (!text) {
      continue;
    }
    const lines = text.split(/\r?\n/u).toReversed();
    for (const line of lines) {
      const parsed = parseVllmCoderStartBlocked(line);
      if (!parsed) {
        continue;
      }
      return {
        reason: parsed.reason,
        note: `journal_marker:${unit}`,
        unit,
        ...(parsed.freeMb ? { freeMb: parsed.freeMb } : {}),
        ...(parsed.minFreeMb ? { minFreeMb: parsed.minFreeMb } : {}),
      };
    }
  }

  return { reason: "NO_BLOCK_MARKER", note: "journal_no_marker", unit: null };
}

export function buildLocalProviderHealthSummary(params) {
  const provider = params.provider;
  const probe = params.probe;
  if (!provider) {
    return {
      providerId: null,
      configured: false,
      coderStatus: "UNCONFIGURED",
      reason: "not_configured",
      note: "no_local_provider_configured",
      modelIds: [],
    };
  }

  if (probe.ok) {
    return {
      providerId: provider.providerId,
      configured: true,
      coderStatus: "UP",
      reason: "probe_ok",
      note: "http_probe",
      url: probe.url,
      modelCount: probe.modelCount,
      modelIds: provider.modelIds,
    };
  }

  if (provider.providerId === "vllm") {
    const journal = detectVllmCoderJournalIssue({
      env: params.env,
      units: params.units,
      journalByUnit: params.journalByUnit,
    });
    return {
      providerId: provider.providerId,
      configured: true,
      coderStatus: journal.reason === "NO_BLOCK_MARKER" ? "DOWN" : "DEGRADED",
      reason: journal.reason,
      note: journal.note,
      url: probe.url,
      modelCount: probe.modelCount,
      modelIds: provider.modelIds,
      ...(journal.unit ? { unit: journal.unit } : {}),
    };
  }

  return {
    providerId: provider.providerId,
    configured: true,
    coderStatus: "DOWN",
    reason: probe.reason,
    note: "http_probe_failed",
    url: probe.url,
    modelCount: probe.modelCount,
    modelIds: provider.modelIds,
  };
}

function parseArgs(argv) {
  const parsed = {
    help: false,
    json: false,
    provider: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--provider") {
      parsed.provider = normalizeNonEmptyString(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function formatPlainSummary(summary) {
  return [
    `provider=${summary.providerId ?? "none"}`,
    `configured=${summary.configured ? "true" : "false"}`,
    `coder_status=${summary.coderStatus}`,
    `reason=${summary.reason}`,
    `note=${summary.note}`,
    ...(summary.url ? [`url=${summary.url}`] : []),
    ...(typeof summary.modelCount === "number" ? [`model_count=${summary.modelCount}`] : []),
    ...(Array.isArray(summary.modelIds) ? [`configured_models=${summary.modelIds.join(",")}`] : []),
    ...(summary.unit ? [`unit=${summary.unit}`] : []),
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      [
        "Check the configured local provider health from models.json.",
        "",
        "Usage:",
        "  node scripts/check-local-provider-health.mjs [--provider <id>] [--json]",
      ].join("\n"),
    );
    return 0;
  }

  const modelsPath = resolveModelsJsonPath(env);
  const modelsPayload = loadModelsJsonPayload(modelsPath);
  const provider = selectConfiguredLocalProvider(modelsPayload, args.provider);
  const probe = provider
    ? await probeLocalProvider(provider, fetchImpl)
    : { ok: false, url: "", modelCount: 0, reason: "not_configured" };
  const summary = buildLocalProviderHealthSummary({ provider, probe, env });
  const payload = {
    ...summary,
    modelsPath,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatPlainSummary(payload)}\n`);
  }

  return payload.coderStatus === "UP" ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check-local-provider-health: ${message}\n`);
    process.exitCode = 2;
  }
}
