import type { AgentHarnessModelCatalogParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderCatalogOutcome } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
} from "./auth-profile.js";
import {
  isCodexAppServerIndeterminateRequestCancellationError,
  type CodexAppServerClient,
} from "./client.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";
import { buildCodexRuntimeModelParams } from "./model-runtime.js";
import {
  DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
  listAllCodexAppServerModels,
  type CodexAppServerModel,
} from "./models.js";
import { probeCodexNativeAuth } from "./native-auth.js";
import type { CodexGetAccountResponse } from "./protocol.js";
import { withCodexAppServerJsonClient } from "./request.js";
import { isCodexResponsesOAuthCredential } from "./responses-oauth.js";
import {
  captureSharedCodexAppServerCatalogLifetime,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";

type ModelInputType = NonNullable<ModelCatalogEntry["input"]>[number];
const INPUT_TYPES: ReadonlySet<string> = new Set(["text", "image", "audio", "video", "document"]);
// Codex keeps a fetched /models catalog this long (`DEFAULT_MODEL_CACHE_TTL`, codex-rs
// models-manager/src/manager.rs), so reuse within it shows no older catalog than Codex would.
const CODEX_MODEL_CACHE_TTL_MS = 300_000;

function isModelInputType(value: string): value is ModelInputType {
  return INPUT_TYPES.has(value);
}

function codexAppServerModelsToCatalogEntries(
  models: readonly CodexAppServerModel[],
  runtime: string,
): ModelCatalogEntry[] {
  return models.map((model, providerOrder) => {
    const input = model.inputModalities.filter(isModelInputType);
    const runtimeParams = buildCodexRuntimeModelParams(model.id, model.model);
    return {
      provider: "openai",
      id: model.id,
      name: model.displayName ?? model.id,
      providerOrder,
      nativeRuntime: runtime,
      reasoning: model.supportedReasoningEfforts.length > 0,
      ...(input.length > 0 ? { input } : {}),
      ...(runtimeParams ? { params: runtimeParams } : {}),
      compat: {
        supportsReasoningEffort: model.supportedReasoningEfforts.length > 0,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
      },
    };
  });
}

/** One harness registration owns its observations; none travel with worker snapshots. */
export function createCodexAppServerModelCatalog(runtime: string) {
  type Discovery = {
    models: CodexAppServerModel[];
    client: CodexAppServerClient;
    /** The account Codex reported before listing; a different account lists again. */
    account: string;
    isCurrent: () => boolean;
    listedAt: number;
    accountType?: "apiKey" | "chatgpt";
  };
  type Observation = {
    pluginConfig: unknown;
    authProfileId?: string;
    discovery?: Discovery;
    models?: ReadonlySet<string>;
    accountType?: "apiKey" | "chatgpt";
    authMode?: string;
    isCurrent?: () => boolean;
  };
  const scopes = new WeakMap<AgentHarnessModelCatalogParams["config"], Map<string, Observation>>();
  const scopeKey = (params: AgentHarnessModelCatalogParams) =>
    JSON.stringify([params.agentId, params.agentDir, params.workspaceDir]);
  let disposed = false;
  return {
    dispose() {
      disposed = true;
    },
    read(
      params: AgentHarnessModelCatalogParams & { provider: string; modelId: string },
      pluginConfig: unknown,
    ) {
      const observation = scopes.get(params.config)?.get(scopeKey(params));
      return !disposed &&
        params.provider === "openai" &&
        observation !== undefined &&
        observation.pluginConfig === pluginConfig &&
        observation.models?.has(params.modelId) &&
        observation.accountType &&
        observation.isCurrent?.()
        ? {
            accountType: observation.accountType,
            ...(observation.authMode ? { authMode: observation.authMode } : {}),
          }
        : undefined;
    },
    async load(
      params: AgentHarnessModelCatalogParams,
      pluginConfig: unknown,
    ): Promise<{ entries: ModelCatalogEntry[]; outcomes?: ProviderCatalogOutcome[] }> {
      if (disposed) {
        return { entries: [] };
      }
      let observations = scopes.get(params.config);
      if (!observations) {
        observations = new Map();
        scopes.set(params.config, observations);
      }
      const key = scopeKey(params);
      const previous = observations.get(key);
      const observation: Observation = { pluginConfig };
      // Revoke before any await, including failed/disabled refreshes and superseded reads.
      observations.set(key, observation);
      const configured = readCodexPluginConfig(pluginConfig);
      const discovery = configured.discovery;
      if (discovery?.enabled === false) {
        return { entries: [] };
      }
      const options = resolveCodexAppServerRuntimeOptions({ pluginConfig: configured });
      const ownsLocalProcess =
        options.start.transport === "stdio" && !isCodexAppServerProxyLaunch(options.start.args);
      const authProfileStore =
        ownsLocalProcess && options.start.homeScope === "agent"
          ? await resolveCodexAppServerAuthProfileStore({
              agentDir: params.agentDir,
              config: params.config,
            })
          : undefined;
      const authProfileId = authProfileStore
        ? resolveCodexAppServerAuthProfileId({ store: authProfileStore, config: params.config })
        : undefined;
      observation.authProfileId = authProfileId;
      const reusable =
        previous &&
        previous.pluginConfig === pluginConfig &&
        previous.authProfileId === authProfileId
          ? previous.discovery
          : undefined;
      // SIWC's public provider owns the account model list. Native Codex sees only a
      // placeholder API key here, so its bundled catalog cannot describe that account.
      if (isCodexResponsesOAuthCredential(authProfileStore?.profiles[authProfileId ?? ""])) {
        return { entries: [] };
      }
      const usesNativeHome = ownsLocalProcess && options.start.homeScope === "user";
      const native = usesNativeHome
        ? await probeCodexNativeAuth({ pluginConfig: configured })
        : undefined;
      if ((usesNativeHome && !native) || disposed || observations.get(key) !== observation) {
        return { entries: [] };
      }
      const { start } = options;
      const timeoutMs = discovery?.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
      const result = await withCodexAppServerJsonClient(
        {
          startOptions: start,
          pluginConfig: configured,
          config: params.config,
          agentDir: params.agentDir,
          timeoutMs,
          ...(authProfileStore ? { authProfileStore, authProfileId } : {}),
          ...(ownsLocalProcess && start.homeScope === "agent" && !authProfileId
            ? { authRequirement: "environment-api-key" as const }
            : {}),
        },
        async (request, client): Promise<Discovery> => {
          try {
            // Codex serializes this read after login's delayed account/updated.
            // Drain startup before pinning the account revision for discovery.
            const current = await request<CodexGetAccountResponse>({
              method: "account/read",
              requestParams: { refreshToken: false },
            });
            // Codex refetches an uncached /models on every model/list and remembers no failure,
            // so an unreachable endpoint costs its full timeout per call. Reuse an earlier
            // discovery only on the same client and account revision, for the account Codex
            // reports now: an app-server not owned here can switch accounts without notifying.
            const account = JSON.stringify(current);
            if (
              reusable?.client === client &&
              reusable.account === account &&
              reusable.isCurrent() &&
              performance.now() - reusable.listedAt < CODEX_MODEL_CACHE_TTL_MS
            ) {
              return reusable;
            }
            const isCurrent = captureSharedCodexAppServerCatalogLifetime(client);
            const listedAt = performance.now();
            const listed = await listAllCodexAppServerModels({
              request,
              limit: 100,
              includeHidden: true,
            });
            const settled = await request<CodexGetAccountResponse>({
              method: "account/read",
              requestParams: { refreshToken: false },
            });
            const observedType = settled.account?.type;
            const accountType = settled.requiresOpenaiAuth
              ? observedType === "apiKey" || observedType === "chatgpt"
                ? observedType
                : undefined
              : undefined;
            return { models: listed.models, client, account, isCurrent, listedAt, accountType };
          } catch (error) {
            // Discovery owns its deadline; retire unanswered work without aborting sibling leases.
            if (isCodexAppServerIndeterminateRequestCancellationError(error)) {
              retireSharedCodexAppServerClientIfCurrent(client);
            }
            throw error;
          }
        },
      );
      // Publish only after the bounded operation settles; a late timed-out callback cannot publish.
      if (disposed || observations.get(key) !== observation || !result.isCurrent()) {
        return { entries: [] };
      }
      observation.discovery = result;
      const models = result.models.filter(
        (model) =>
          !model.hidden ||
          params.configuredModelRefs?.some(
            (ref) => ref.provider === "openai" && ref.model === model.id,
          ),
      );
      observation.models = new Set(models.map((model) => model.id));
      observation.accountType =
        !usesNativeHome ||
        (native?.mode === "api-key" && result.accountType === "apiKey") ||
        ((native?.mode === "oauth" || native?.mode === "token") && result.accountType === "chatgpt")
          ? result.accountType
          : undefined;
      observation.isCurrent = result.isCurrent;
      // A remote ChatGPT account does not distinguish OAuth from caller-supplied tokens.
      // Carry the local mode only after its account type matches this discovery observation.
      observation.authMode =
        observation.accountType === "apiKey"
          ? "api_key"
          : observation.accountType === "chatgpt" &&
              (native?.mode === "oauth" || native?.mode === "token")
            ? native.mode
            : undefined;
      return {
        entries: codexAppServerModelsToCatalogEntries(models, runtime),
        outcomes: [
          {
            provider: "openai",
            status: observation.accountType ? "ready" : "unavailable",
            ...(observation.accountType
              ? {
                  modelAccessPrograms: models.flatMap((model) =>
                    model.availableAccessPrograms
                      ? [
                          {
                            modelId: model.id,
                            runtimeId: runtime,
                            cyber: model.availableAccessPrograms.cyber,
                          },
                        ]
                      : [],
                  ),
                }
              : {}),
          },
        ],
      };
    },
  };
}
