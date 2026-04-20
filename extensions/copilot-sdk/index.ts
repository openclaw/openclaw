import { buildFallbackModelCatalog, buildModelDefinition } from "./models.js";
import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
  type ProviderCatalogResult,
} from "./runtime-api.js";
import {
  createDedicatedClient,
  getSdkClient,
  type SdkClient,
  type SdkClientOptions,
} from "./sdk-client.js";
import type { ModelDefinitionConfig } from "./shared-types.js";
import type { ShimServerHandle, ShimServerOptions } from "./shim-server.js";
import { startShimServer } from "./shim-server.js";

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
  allowBuiltinTools?: boolean;
  cliPath?: string;
};

type SharedDeps = {
  getClient: (options: SdkClientOptions) => Promise<SdkClient>;
  createDedicatedClient: (options: SdkClientOptions) => Promise<SdkClient>;
  startShimServer: (options: ShimServerOptions) => Promise<ShimServerHandle>;
};

const DEFAULT_DEPS: SharedDeps = {
  getClient: getSdkClient,
  createDedicatedClient,
  startShimServer,
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

// ---------------------------------------------------------------------------
// Shim lifecycle — module-level state
// ---------------------------------------------------------------------------

let shimHandle: ShimServerHandle | undefined;
let shimConfigFingerprint = "";
let shimInitPromise: Promise<ShimServerHandle> | undefined;

function shimFingerprint(cfg: PluginConfig): string {
  return JSON.stringify({
    port: cfg.port ?? DEFAULT_PORT,
    cliPath: cfg.cliPath ?? null,
    rejectToolRequests: cfg.rejectToolRequests ?? false,
    allowBuiltinTools: cfg.allowBuiltinTools ?? true,
  });
}

/**
 * Ensures a shim HTTP server is running with the given config.
 *
 * - Reuses an existing shim if the config fingerprint hasn't changed.
 * - Coalesces concurrent callers behind a single init promise.
 * - Tears down and rebuilds when config changes.
 */
async function ensureShim(pluginConfig: PluginConfig, deps: SharedDeps): Promise<ShimServerHandle> {
  const fp = shimFingerprint(pluginConfig);

  // Fast path: shim already running with matching config.
  if (shimHandle && shimConfigFingerprint === fp) {
    return shimHandle;
  }

  // Coalesce concurrent callers during init.
  if (shimInitPromise && shimConfigFingerprint === fp) {
    return shimInitPromise;
  }

  // Config changed — tear down old shim.
  if (shimHandle) {
    await shimHandle.close().catch(() => undefined);
    shimHandle = undefined;
  }
  shimInitPromise = undefined;
  shimConfigFingerprint = fp;

  shimInitPromise = (async () => {
    try {
      const client = await deps.createDedicatedClient({ cliPath: pluginConfig.cliPath });
      const handle = await deps.startShimServer({
        client,
        port: pluginConfig.port ?? DEFAULT_PORT,
        rejectToolRequests: pluginConfig.rejectToolRequests,
        allowBuiltinTools: pluginConfig.allowBuiltinTools ?? true,
      });
      shimHandle = handle;
      return handle;
    } catch (err) {
      // Clean up on failure so the next call retries from scratch.
      shimHandle = undefined;
      shimConfigFingerprint = "";
      shimInitPromise = undefined;
      throw err;
    }
  })();

  try {
    return await shimInitPromise;
  } finally {
    shimInitPromise = undefined;
  }
}

/** Test-only: reset module-level shim state between test cases. */
export async function __resetShimForTests(): Promise<void> {
  if (shimHandle) {
    await shimHandle.close().catch(() => undefined);
  }
  shimHandle = undefined;
  shimConfigFingerprint = "";
  shimInitPromise = undefined;
}

/**
 * Catalog hook — discovers available models via the Copilot SDK, then
 * ensures the shim HTTP server is running so inference requests have a
 * live endpoint.
 *
 * Model discovery uses the singleton SDK client (closed after discovery).
 * The shim uses a dedicated long-lived client via `createDedicatedClient`.
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

  // --- Model discovery (singleton client, closed afterward) ---
  let models: ModelDefinitionConfig[];
  let client: SdkClient | undefined;
  try {
    client = await deps.getClient({ cliPath: pluginConfig.cliPath });
    const sdkModels = await client.listModels();
    models = sdkModels.length
      ? sdkModels.map((m) => buildModelDefinition(m.id, m.name))
      : buildFallbackModelCatalog();
  } catch (err) {
    console.warn(
      "copilot-sdk: model discovery failed, using fallback catalog:",
      err instanceof Error ? err.message : String(err),
    );
    models = buildFallbackModelCatalog();
  } finally {
    // Stop the SDK subprocess so it does not keep the event loop alive.
    if (client) {
      await client.close().catch(() => undefined);
    }
  }

  // --- Shim startup (dedicated long-lived client) ---
  let handle: ShimServerHandle;
  try {
    handle = await ensureShim(pluginConfig, deps);
  } catch (err) {
    console.error(
      "copilot-sdk: shim server failed to start, self-disabling:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  return {
    provider: {
      baseUrl: handle.url,
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
