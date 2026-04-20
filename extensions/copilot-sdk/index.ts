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
import { startShimServer, type ShimServerHandle } from "./shim-server.js";

const PROVIDER_ID = "copilot-sdk";
const CHOICE_ID = "copilot-sdk";
const METHOD_ID = "sdk";
const DEFAULT_PORT = 0; // ephemeral — avoids EADDRINUSE from stale processes
const PROFILE_ID = "copilot-sdk:logged-in";
const PLACEHOLDER_API_KEY = "copilot-sdk";

type PluginConfig = {
  port?: number;
  rejectToolRequests?: boolean;
  cliPath?: string;
};

type SharedDeps = {
  startShim: typeof startShimServer;
  getClient: (options: SdkClientOptions) => Promise<SdkClient>;
};

const DEFAULT_DEPS: SharedDeps = {
  startShim: startShimServer,
  getClient: getSdkClient,
};

/** Process-lifetime singleton so we only spin up one shim per config. */
let runningShim: (ShimServerHandle & { fingerprint: string }) | undefined;
let pendingShim: Promise<ShimServerHandle & { fingerprint: string }> | undefined;

function shimFingerprint(config: PluginConfig): string {
  return JSON.stringify({
    port: config.port ?? DEFAULT_PORT,
    rejectToolRequests: config.rejectToolRequests ?? true,
    cliPath: config.cliPath ?? null,
  });
}

async function ensureShim(config: PluginConfig, deps: SharedDeps): Promise<ShimServerHandle> {
  const fingerprint = shimFingerprint(config);
  if (runningShim && runningShim.fingerprint === fingerprint) {
    return runningShim;
  }
  if (pendingShim) {
    return pendingShim;
  }

  pendingShim = (async () => {
    if (runningShim) {
      await runningShim.close().catch(() => undefined);
      runningShim = undefined;
    }
    const client = await deps.getClient({ cliPath: config.cliPath });
    const handle = await deps.startShim({
      client,
      port: config.port ?? DEFAULT_PORT,
      rejectToolRequests: config.rejectToolRequests ?? true,
    });
    runningShim = Object.assign(handle, { fingerprint });
    return runningShim;
  })();

  try {
    return await pendingShim;
  } finally {
    pendingShim = undefined;
  }
}

function readPluginConfig(ctx: ProviderCatalogContext): PluginConfig {
  const raw = (
    ctx.config as { plugins?: { entries?: Record<string, { config?: PluginConfig }> } } | undefined
  )?.plugins?.entries?.[PROVIDER_ID]?.config;
  if (!raw || typeof raw !== "object") {
    return {};
  }
  return raw;
}

async function buildCatalog(
  ctx: ProviderCatalogContext,
  deps: SharedDeps,
): Promise<ProviderCatalogResult> {
  const auth = ctx.resolveProviderAuth(PROVIDER_ID);
  if (!auth.apiKey) {
    console.error("[copilot-sdk] catalog: no auth profile found for provider", PROVIDER_ID);
    return null;
  }

  const pluginConfig = readPluginConfig(ctx);
  let baseUrl: string;
  let models: ModelDefinitionConfig[];
  try {
    const shim = await ensureShim(pluginConfig, deps);
    baseUrl = shim.url;
    try {
      const client = await deps.getClient({ cliPath: pluginConfig.cliPath });
      const sdkModels = await client.listModels();
      models = sdkModels.length
        ? sdkModels.map((m) => buildModelDefinitionFromSdk(m.id, m.name))
        : buildFallbackModelCatalog();
    } catch (innerErr) {
      console.error(
        "[copilot-sdk] listModels failed, using fallback:",
        innerErr instanceof Error ? innerErr.message : innerErr,
      );
      models = buildFallbackModelCatalog();
    }
  } catch (err) {
    console.error("[copilot-sdk] catalog failed:", err instanceof Error ? err.message : err);
    return null;
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

/** Test-only helper to clear the singleton shim between cases. */
export async function __resetShimForTests(): Promise<void> {
  if (runningShim) {
    await runningShim.close().catch(() => undefined);
    runningShim = undefined;
  }
  pendingShim = undefined;
}

export default createCopilotSdkPlugin();
