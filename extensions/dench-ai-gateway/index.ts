import {
  buildDenchGatewayApiBaseUrl,
  buildDenchGatewayCatalogUrl,
  cloneFallbackDenchCloudModels,
  DEFAULT_DENCH_CLOUD_GATEWAY_URL,
  formatDenchCloudModelHint,
  normalizeDenchCloudCatalogResponse,
  normalizeDenchGatewayUrl,
  resolveDenchCloudModel,
  type DenchCloudCatalogModel,
} from "./models.js";
import {
  buildDenchCloudConfigPatch,
  buildDenchCloudProviderConfig,
} from "./config-patch.js";
import { registerDenchIntegrationsBridge } from "./composio-bridge.js";
export { buildDenchCloudConfigPatch } from "./config-patch.js";

export const id = "dench-ai-gateway";

const PROVIDER_ID = "dench-cloud";
const PROVIDER_LABEL = "Dench Cloud";
const API_KEY_ENV_VARS = ["DENCH_CLOUD_API_KEY", "DENCH_API_KEY"] as const;

type CatalogSource = "live" | "fallback";

type CatalogLoadResult = {
  models: DenchCloudCatalogModel[];
  source: CatalogSource;
  detail?: string;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function resolvePluginConfig(api: any): UnknownRecord | undefined {
  const pluginConfig = api?.config?.plugins?.entries?.["dench-ai-gateway"]?.config;
  return asRecord(pluginConfig);
}

function resolveGatewayUrl(api: any): string {
  const pluginConfig = resolvePluginConfig(api);
  const configured = typeof pluginConfig?.gatewayUrl === "string" ? pluginConfig.gatewayUrl : undefined;
  return normalizeDenchGatewayUrl(
    configured || process.env.DENCH_GATEWAY_URL || DEFAULT_DENCH_CLOUD_GATEWAY_URL,
  );
}

function resolveEnvApiKey(): string | undefined {
  for (const envVar of API_KEY_ENV_VARS) {
    const value = process.env[envVar]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

async function promptForApiKey(prompter: any): Promise<string> {
  if (typeof prompter?.secret === "function") {
    return String(
      await prompter.secret(
        "Enter your Dench Cloud API key (sign up at dench.com and get it at dench.com/settings)",
      ),
    ).trim();
  }

  return String(
    await prompter.text({
      message:
        "Enter your Dench Cloud API key (sign up at dench.com and get it at dench.com/settings)",
    }),
  ).trim();
}

export async function fetchDenchCloudCatalog(gatewayUrl: string): Promise<CatalogLoadResult> {
  try {
    const response = await fetch(buildDenchGatewayCatalogUrl(gatewayUrl));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json().catch(() => null);
    const models = normalizeDenchCloudCatalogResponse(payload);
    if (!models.length) {
      throw new Error("response did not contain any usable models");
    }

    return { models, source: "live" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      models: cloneFallbackDenchCloudModels(),
      source: "fallback",
      detail,
    };
  }
}

export async function validateDenchCloudApiKey(
  gatewayUrl: string,
  apiKey: string,
): Promise<void> {
  const response = await fetch(`${buildDenchGatewayApiBaseUrl(gatewayUrl)}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (response.ok) {
    return;
  }

  const message =
    response.status === 401 || response.status === 403
      ? "Invalid Dench Cloud API key."
      : `Dench Cloud validation failed with HTTP ${response.status}.`;
  throw new Error(`${message} Check your key at dench.com/settings.`);
}

async function promptForModelSelection(params: {
  prompter: any;
  models: DenchCloudCatalogModel[];
  initialStableId?: string;
}): Promise<DenchCloudCatalogModel> {
  const selectedStableId = String(
    await params.prompter.select({
      message: "Choose your default Dench Cloud model",
      options: params.models.map((model) => ({
        value: model.stableId,
        label: model.displayName,
        hint: formatDenchCloudModelHint(model),
      })),
      ...(params.initialStableId ? { initialValue: params.initialStableId } : {}),
    }),
  );

  const selected = resolveDenchCloudModel(params.models, selectedStableId);
  if (!selected) {
    throw new Error(`Unknown Dench Cloud model "${selectedStableId}".`);
  }
  return selected;
}

function buildAuthNotes(params: {
  gatewayUrl: string;
  catalog: CatalogLoadResult;
}): string[] {
  const notes = [
    `Dench Cloud uses ${buildDenchGatewayApiBaseUrl(params.gatewayUrl)} for model traffic.`,
  ];

  if (params.catalog.source === "fallback") {
    notes.push(
      `Model catalog fell back to DenchClaw's bundled list (${params.catalog.detail ?? "public catalog unavailable"}).`,
    );
  }

  return notes;
}

function buildProviderAuthResult(params: {
  gatewayUrl: string;
  apiKey: string;
  catalog: CatalogLoadResult;
  selected: DenchCloudCatalogModel;
}) {
  return {
    profiles: [
      {
        profileId: `${PROVIDER_ID}:default`,
        credential: {
          type: "api_key",
          provider: PROVIDER_ID,
          key: params.apiKey,
        },
      },
    ],
    defaultModel: `${PROVIDER_ID}/${params.selected.stableId}`,
    configPatch: buildDenchCloudConfigPatch({
      gatewayUrl: params.gatewayUrl,
      apiKey: params.apiKey,
      models: params.catalog.models,
    }),
    notes: buildAuthNotes({
      gatewayUrl: params.gatewayUrl,
      catalog: params.catalog,
    }),
  };
}

async function runInteractiveAuth(ctx: any, gatewayUrl: string) {
  const apiKey = await promptForApiKey(ctx.prompter);
  if (!apiKey) {
    throw new Error("A Dench Cloud API key is required.");
  }

  await validateDenchCloudApiKey(gatewayUrl, apiKey);
  const catalog = await fetchDenchCloudCatalog(gatewayUrl);
  const selected = await promptForModelSelection({
    prompter: ctx.prompter,
    models: catalog.models,
  });

  return buildProviderAuthResult({
    gatewayUrl,
    apiKey,
    catalog,
    selected,
  });
}

async function runNonInteractiveAuth(ctx: any, gatewayUrl: string) {
  const apiKey = String(
    ctx?.opts?.denchCloudApiKey ||
      ctx?.opts?.denchCloudKey ||
      resolveEnvApiKey() ||
      "",
  ).trim();
  if (!apiKey) {
    throw new Error(
      "Dench Cloud non-interactive auth requires DENCH_CLOUD_API_KEY or --dench-cloud-api-key.",
    );
  }

  await validateDenchCloudApiKey(gatewayUrl, apiKey);
  const catalog = await fetchDenchCloudCatalog(gatewayUrl);
  const selected = resolveDenchCloudModel(
    catalog.models,
    String(ctx?.opts?.denchCloudModel || process.env.DENCH_CLOUD_MODEL || "").trim(),
  );
  if (!selected) {
    throw new Error("Configured Dench Cloud model is not available.");
  }

  return buildProviderAuthResult({
    gatewayUrl,
    apiKey,
    catalog,
    selected,
  });
}

function buildDiscoveryProvider(api: any, gatewayUrl: string) {
  const configured = api?.config?.models?.providers?.[PROVIDER_ID];
  if (configured && typeof configured === "object") {
    return configured;
  }

  const apiKey = resolveEnvApiKey();
  if (!apiKey) {
    return null;
  }

  const models = cloneFallbackDenchCloudModels();
  return buildDenchCloudProviderConfig({ gatewayUrl, apiKey, models });
}

export default function register(api: any) {
  const pluginConfig = resolvePluginConfig(api);
  if (pluginConfig?.enabled === false) {
    return;
  }

  const gatewayUrl = resolveGatewayUrl(api);

  api.registerProvider({
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    docsPath: "/providers/models",
    aliases: ["dench", "dench-cloud", "dench-ai-gateway"],
    envVars: [...API_KEY_ENV_VARS],
    auth: [
      {
        id: "api-key",
        label: "Dench Cloud API Key",
        hint: "Use your Dench Cloud key from dench.com/settings",
        kind: "api_key",
        run: async (ctx: any) => await runInteractiveAuth(ctx, gatewayUrl),
        // Newer OpenClaw builds can call this hook during headless onboarding.
        runNonInteractive: async (ctx: any) => await runNonInteractiveAuth(ctx, gatewayUrl),
      },
    ],
    // Newer OpenClaw builds can surface provider-specific wizard entries.
    wizard: {
      onboarding: {
        choiceId: PROVIDER_ID,
        choiceLabel: PROVIDER_LABEL,
        choiceHint: "Use Dench's managed AI gateway",
        groupId: "dench",
        groupLabel: "Dench",
        groupHint: "Managed Dench Cloud models",
        methodId: "api-key",
      },
      modelPicker: {
        label: PROVIDER_LABEL,
        hint: "Connect Dench Cloud with your API key",
        methodId: "api-key",
      },
    },
    // Best-effort discovery so newer OpenClaw builds can rehydrate provider config.
    discovery: {
      order: "profile",
      run: async () => {
        const provider = buildDiscoveryProvider(api, gatewayUrl);
        return provider ? { provider } : null;
      },
    },
  } as any);

  registerDenchIntegrationsBridge(api, gatewayUrl);

  api.registerService({
    id: "dench-ai-gateway",
    start: () => {
      api.logger?.info?.(`[dench-ai-gateway] active (gateway: ${gatewayUrl})`);
    },
    stop: () => {
      api.logger?.info?.("[dench-ai-gateway] stopped");
    },
  });
}
