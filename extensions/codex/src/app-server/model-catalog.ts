import type { AgentHarnessModelCatalogParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
} from "./auth-profile.js";
import type { CodexAppServerClient } from "./client.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";
import { buildCodexRuntimeModelParams } from "./model-runtime.js";
import { listAllCodexAppServerModels, type CodexAppServerModel } from "./models.js";
import { probeCodexNativeAuth } from "./native-auth.js";
import type { CodexGetAccountResponse } from "./protocol.js";
import { withCodexAppServerJsonClient } from "./request.js";
import {
  captureSharedCodexAppServerCatalogLifetime,
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
} from "./shared-client.js";

// Manifest contract (openclaw.plugin.json discovery.timeoutMs default): live model
// discovery is bounded tightly so a wedged app-server degrades to the static catalog.
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 2500;
type ModelInputType = NonNullable<ModelCatalogEntry["input"]>[number];
const INPUT_TYPES: ReadonlySet<string> = new Set(["text", "image", "audio", "video", "document"]);

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
  type Observation = {
    pluginConfig: unknown;
    models?: ReadonlySet<string>;
    accountType?: "apiKey" | "chatgpt";
    authMode?: string;
    isCurrent?: () => boolean;
  };
  const scopes = new WeakMap<AgentHarnessModelCatalogParams["config"], Map<string, Observation>>();
  const scopeKey = (params: AgentHarnessModelCatalogParams) =>
    JSON.stringify([params.agentId, params.agentDir, params.workspaceDir]);
  let disposed = false;
  const producers = new Set<Promise<unknown>>();
  const clients = new Map<CodexAppServerClient, () => void>();
  const closing = new Set<CodexAppServerClient>();
  let disposal: Promise<void> | undefined;
  return {
    dispose() {
      disposed = true;
      disposal ??= (async () => {
        await Promise.allSettled(producers);
        for (const [client, unobserve] of clients) {
          if (clearSharedCodexAppServerClientIfCurrentAndUnclaimed(client).closed) {
            closing.add(client);
          }
          unobserve();
          clients.delete(client);
        }
        const results = await Promise.allSettled(
          [...closing].map(async (client) => {
            const result = await client.closeAndWait();
            if (!result.exited) {
              throw new Error("Codex model catalog transport did not exit");
            }
            closing.delete(client);
          }),
        );
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Codex model catalog cleanup failed",
          );
        }
      })().finally(() => {
        disposal = undefined;
      });
      return disposal;
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
    ): Promise<ModelCatalogEntry[]> {
      if (disposed) {
        return [];
      }
      let observations = scopes.get(params.config);
      if (!observations) {
        observations = new Map();
        scopes.set(params.config, observations);
      }
      const key = scopeKey(params);
      const observation: Observation = { pluginConfig };
      // Revoke before any await, including failed/disabled refreshes and superseded reads.
      observations.set(key, observation);
      const configured = readCodexPluginConfig(pluginConfig);
      const discovery = configured.discovery;
      if (discovery?.enabled === false) {
        return [];
      }
      const options = resolveCodexAppServerRuntimeOptions({ pluginConfig });
      const ownsLocalProcess =
        options.start.transport === "stdio" && !isCodexAppServerProxyLaunch(options.start.args);
      const authProfileStore =
        ownsLocalProcess && options.start.homeScope === "agent"
          ? resolveCodexAppServerAuthProfileStore({
              agentDir: params.agentDir,
              config: params.config,
            })
          : undefined;
      const authProfileId = authProfileStore
        ? resolveCodexAppServerAuthProfileId({ store: authProfileStore, config: params.config })
        : undefined;
      const usesNativeHome = ownsLocalProcess && options.start.homeScope === "user";
      const native = usesNativeHome ? await probeCodexNativeAuth({ pluginConfig }) : undefined;
      if ((usesNativeHome && !native) || disposed || observations.get(key) !== observation) {
        return [];
      }
      const { start } = options;
      const timeoutMs = discovery?.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
      const result = await withCodexAppServerJsonClient(
        {
          startOptions: start,
          config: params.config,
          agentDir: params.agentDir,
          timeoutMs,
          onClientAcquired: (client) => {
            if (clients.has(client)) {
              return;
            }
            let exited = false;
            const unobserve = client.addTransportExitHandler(() => {
              exited = true;
              clients.delete(client);
            });
            if (!exited) {
              clients.set(client, unobserve);
            }
          },
          onProducer: (producer) => {
            producers.add(producer);
            const settled = () => producers.delete(producer);
            void producer.then(settled, settled);
          },
          ...(authProfileStore ? { authProfileStore, authProfileId } : {}),
        },
        async (request, client) => {
          const isCurrent = captureSharedCodexAppServerCatalogLifetime(client);
          const listed = await listAllCodexAppServerModels({
            request,
            limit: 100,
            includeHidden: true,
          });
          const models = listed.models.filter(
            (model) =>
              !model.hidden ||
              params.configuredModelRefs?.some(
                (ref) => ref.provider === "openai" && ref.model === model.id,
              ),
          );
          const account = await request<CodexGetAccountResponse>({
            method: "account/read",
            requestParams: { refreshToken: false },
          });
          const observedType = account.account?.type;
          const accountType = account.requiresOpenaiAuth
            ? observedType === "apiKey" || observedType === "chatgpt"
              ? observedType
              : undefined
            : undefined;
          return { models, isCurrent, accountType } as const;
        },
      );
      // Publish only after the bounded operation settles; a late timed-out callback cannot publish.
      if (disposed || observations.get(key) !== observation || !result.isCurrent()) {
        return [];
      }
      observation.models = new Set(result.models.map((model) => model.id));
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
      return codexAppServerModelsToCatalogEntries(result.models, runtime);
    },
  };
}
