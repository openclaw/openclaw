import { buildFallbackModelCatalog, buildModelDefinitionFromSdk } from "./models.js";
import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
  type ProviderCatalogResult,
} from "./runtime-api.js";
import { getSdkClient, type SdkClient, type SdkClientOptions } from "./sdk-client.js";
import type { ModelDefinitionConfig } from "./shared-types.js";

const PROVIDER_ID = "copilot-sdk";
const CHOICE_ID = "copilot-sdk";
const METHOD_ID = "sdk";
/**
 * Fixed port for the shim server. Written into models.json so the baseUrl is
 * stable across process restarts. The shim binds with `server.unref()` and
 * falls back to ephemeral on EADDRINUSE.
 */
const DEFAULT_PORT = 9527;
const PROFILE_ID = "copilot-sdk:logged-in";
const PLACEHOLDER_API_KEY = "copilot-sdk";

type PluginConfig = {
  port?: number;
  rejectToolRequests?: boolean;
  cliPath?: string;
};

type SharedDeps = {
  getClient: (options: SdkClientOptions) => Promise<SdkClient>;
};

const DEFAULT_DEPS: SharedDeps = {
  getClient: getSdkClient,
};

function readPluginConfig(ctx: ProviderCatalogContext): PluginConfig {
  const raw = (
    ctx.config as { plugins?: { entries?: Record<string, { config?: PluginConfig }> } } | undefined
  )?.plugins?.entries?.[PROVIDER_ID]?.config;
  if (!raw || typeof raw !== "object") {
    return {};
  }
  return raw;
}

/**
 * Catalog hook — discovers available models via the Copilot SDK.
 *
 * The shim server is NOT started here. The catalog only needs the model list
 * which comes from `listModels()`. After discovery the SDK client is stopped
 * so the CLI subprocess does not prevent process exit (important for
 * short-lived commands like `models list`).
 *
 * The shim starts lazily via `ensureShim()` when the provider is actually
 * used for inference (the shim server is `unref()`d so it never blocks exit
 * on its own).
 */
async function buildCatalog(
  ctx: ProviderCatalogContext,
  deps: SharedDeps,
): Promise<ProviderCatalogResult> {
  const auth = ctx.resolveProviderAuth(PROVIDER_ID);
  if (!auth.apiKey) {
    return null;
  }

  const pluginConfig = readPluginConfig(ctx);
  const port = pluginConfig.port ?? DEFAULT_PORT;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  let models: ModelDefinitionConfig[];
  let client: SdkClient | undefined;
  try {
    client = await deps.getClient({ cliPath: pluginConfig.cliPath });
    const sdkModels = await client.listModels();
    models = sdkModels.length
      ? sdkModels.map((m) => buildModelDefinitionFromSdk(m.id, m.name))
      : buildFallbackModelCatalog();
  } catch {
    models = buildFallbackModelCatalog();
  } finally {
    // Stop the SDK subprocess so it does not keep the event loop alive.
    if (client) {
      await client.close().catch(() => undefined);
    }
  }

  return {
    provider: {
      baseUrl,
      api: "openai-completions",
      apiKey: PLACEHOLDER_API_KEY,
      authHeader: false,
      models,
    },
  };
}

function buildAuthResult(): ProviderAuthResult {
  return {
    profiles: [
      {
        profileId: PROFILE_ID,
        credential: {
          type: "token",
          provider: PROVIDER_ID,
          token: PLACEHOLDER_API_KEY,
        },
      },
    ],
    configPatch: {
      plugins: {
        entries: {
          [PROVIDER_ID]: {
            enabled: true,
          },
        },
      },
    },
    notes: [
      "The copilot-sdk plugin requires the @github/copilot CLI to be logged in.",
      "Run `copilot` once in a terminal and complete device login before using this provider.",
      "The plugin spawns the CLI via @github/copilot-sdk (public preview).",
      "Tool calls are NOT forwarded to the Copilot CLI; OpenClaw handles tools locally.",
    ],
  };
}

export function createCopilotSdkPlugin(deps: SharedDeps = DEFAULT_DEPS) {
  return definePluginEntry({
    id: PROVIDER_ID,
    name: "Copilot SDK",
    description:
      "Proxies chat completions through the @github/copilot CLI via @github/copilot-sdk.",
    register(api) {
      api.registerProvider({
        id: PROVIDER_ID,
        label: "Copilot SDK (experimental)",
        docsPath: "/providers/models",
        auth: [
          {
            id: METHOD_ID,
            label: "Copilot SDK (experimental)",
            hint: "Use @github/copilot CLI as the model backend",
            kind: "custom",
            run: async (_ctx: ProviderAuthContext): Promise<ProviderAuthResult> =>
              buildAuthResult(),
          },
        ],
        catalog: {
          order: "simple",
          run: (ctx) => buildCatalog(ctx, deps),
        },
        wizard: {
          setup: {
            choiceId: CHOICE_ID,
            choiceLabel: "Copilot SDK (experimental)",
            choiceHint: "Proxy through @github/copilot CLI",
            methodId: METHOD_ID,
          },
        },
      });
    },
  });
}

export default createCopilotSdkPlugin();
