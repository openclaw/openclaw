import { createHash } from "node:crypto";
import {
  embeddedAgentLog,
  fingerprintResolvedAuthProfileCredential,
  type AgentHarnessModelCatalogParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { resolveOpenAICodexAuthIdentity } from "openclaw/plugin-sdk/provider-auth";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
} from "./auth-profile.js";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import { codexAppServerStartOptionsKey } from "./config-options.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";
import { readCodexManagedRuntimeRevision } from "./managed-runtime-installation.js";
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
import { captureSharedCodexAppServerCatalogLifetime } from "./shared-client.js";

type ModelInputType = NonNullable<ModelCatalogEntry["input"]>[number];
const MAX_CATALOG_ENTRIES = 128;
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

/** Harness-lifetime observations; account/runtime refreshes never belong to a message. */
export function createCodexAppServerModelCatalog(
  runtime: string,
  getScheduler?: () => PluginServiceSchedulerV1 | undefined,
) {
  type Result = {
    models: readonly CodexAppServerModel[];
    runtimeVersion?: string;
    accountType?: "apiKey" | "chatgpt";
    authMode?: string;
    isCurrent: () => boolean;
  };
  type Entry = {
    result?: Result;
    pending?: Promise<Result | undefined>;
    cancelScheduled?: () => void;
    refreshedAt: number;
    retryAt: number;
    failures: number;
    ready: boolean;
  };
  type Observation = {
    pluginConfig: unknown;
    models: ReadonlySet<string>;
    accountKey: string;
  };
  const scopes = new WeakMap<AgentHarnessModelCatalogParams["config"], Map<string, Observation>>();
  const entries = new Map<string, Entry>();
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const scopeKey = (params: AgentHarnessModelCatalogParams) =>
    JSON.stringify([params.agentId, params.agentDir, params.workspaceDir, params.authProfileId]);
  const prepare = (params: AgentHarnessModelCatalogParams, pluginConfig: unknown) => {
    const options = resolveCodexAppServerRuntimeOptions({ pluginConfig });
    const ownsLocalProcess =
      options.start.transport === "stdio" && !isCodexAppServerProxyLaunch(options.start.args);
    const authProfileStore =
      ownsLocalProcess && options.start.homeScope === "agent"
        ? resolveCodexAppServerAuthProfileStore({
            agentDir: params.agentDir,
            authProfileId: params.authProfileId,
            config: params.config,
          })
        : undefined;
    const authProfileId = authProfileStore
      ? resolveCodexAppServerAuthProfileId({
          store: authProfileStore,
          config: params.config,
          authProfileId: params.authProfileId,
        })
      : undefined;
    const credential = authProfileStore?.profiles[authProfileId ?? ""];
    const credentialFingerprint =
      credential && authProfileId
        ? fingerprintResolvedAuthProfileCredential({
            profileId: authProfileId,
            credential:
              credential.type === "oauth"
                ? { ...credential, accountId: resolveOpenAICodexAuthIdentity(credential).accountId }
                : credential,
            resolvedAuth: undefined,
          })
        : undefined;
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          runtime,
          codexAppServerStartOptionsKey(options.start),
          readCodexManagedRuntimeRevision(),
          authProfileId,
          credentialFingerprint ?? credential,
          // Native per-home policy can select a different runtime for one account.
          ownsLocalProcess
            ? resolveCodexAppServerLocalHomeDir(options.start, params.agentDir)
            : undefined,
          !credential && ownsLocalProcess
            ? [process.env.CODEX_API_KEY, process.env.OPENAI_API_KEY]
            : undefined,
        ]),
      )
      .digest("hex");
    return { options, ownsLocalProcess, authProfileStore, authProfileId, credential, key };
  };
  const visible = (
    models: readonly CodexAppServerModel[],
    params: AgentHarnessModelCatalogParams,
  ) =>
    models.filter(
      (model) =>
        !model.hidden ||
        params.configuredModelRefs?.some(
          (ref) =>
            ref.provider === "openai" && (ref.model === model.id || ref.model === model.model),
        ),
    );

  return {
    async dispose() {
      lifetime.abort();
      for (const entry of entries.values()) {
        entry.cancelScheduled?.();
      }
      await Promise.allSettled(pending);
      entries.clear();
    },
    readRuntimeVersion(params: AgentHarnessModelCatalogParams, pluginConfig: unknown) {
      if (
        lifetime.signal.aborted ||
        readCodexPluginConfig(pluginConfig).discovery?.enabled === false
      ) {
        return undefined;
      }
      const observation = scopes.get(params.config)?.get(scopeKey(params));
      if (
        observation?.pluginConfig !== pluginConfig ||
        observation?.accountKey !== prepare(params, pluginConfig).key
      ) {
        return undefined;
      }
      const result = entries.get(observation.accountKey)?.result;
      return result?.isCurrent() ? result.runtimeVersion : undefined;
    },
    read(
      params: AgentHarnessModelCatalogParams & { provider: string; modelId: string },
      pluginConfig: unknown,
    ) {
      if (lifetime.signal.aborted || params.provider !== "openai") {
        return undefined;
      }
      const observation = scopes.get(params.config)?.get(scopeKey(params));
      if (
        !observation ||
        observation.pluginConfig !== pluginConfig ||
        !observation.models.has(params.modelId) ||
        observation.accountKey !== prepare(params, pluginConfig).key
      ) {
        return undefined;
      }
      const current = entries.get(observation.accountKey);
      const result = current?.result;
      return current?.ready &&
        result?.accountType &&
        result.isCurrent() &&
        result.models.some((model) => model.id === params.modelId)
        ? {
            accountType: result.accountType,
            ...(result.authMode ? { authMode: result.authMode } : {}),
          }
        : undefined;
    },
    async load(
      params: AgentHarnessModelCatalogParams,
      pluginConfig: unknown,
    ): Promise<ModelCatalogEntry[]> {
      if (lifetime.signal.aborted) {
        return [];
      }
      let observations = scopes.get(params.config);
      if (!observations) {
        observations = new Map();
        scopes.set(params.config, observations);
      }
      const scope = scopeKey(params);
      const discovery = readCodexPluginConfig(pluginConfig).discovery;
      const prepared = prepare(params, pluginConfig);
      if (discovery?.enabled === false || isCodexResponsesOAuthCredential(prepared.credential)) {
        observations.delete(scope);
        return [];
      }
      let entry = entries.get(prepared.key);
      if (!entry) {
        entry = { refreshedAt: 0, retryAt: 0, failures: 0, ready: false };
        // Running refreshes keep their ownership until joined; only settled rows can evict.
        for (const [key, value] of entries) {
          if (entries.size < MAX_CATALOG_ENTRIES) {
            break;
          }
          if (!value.pending) {
            entries.delete(key);
          }
        }
        if (entries.size >= MAX_CATALOG_ENTRIES) {
          throw new Error(
            "Codex model discovery is busy; retry after the active refreshes finish.",
          );
        }
        entries.set(prepared.key, entry);
      }
      const current = entry;
      const observation: Observation = {
        pluginConfig,
        accountKey: prepared.key,
        models: new Set(),
      };
      // Scope projections cannot retain evicted account/runtime rows or grow for
      // every workspace an account visits. Pending work remains owned by entries.
      observations.delete(scope);
      while (observations.size >= MAX_CATALOG_ENTRIES) {
        const oldest = observations.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        observations.delete(oldest);
      }
      observations.set(scope, observation);
      const resultCurrent = current.result?.isCurrent() === true;
      if (!resultCurrent) {
        current.ready = false;
      }
      const scheduler = getScheduler?.();
      const background =
        params.refresh !== true && resultCurrent && scheduler && !scheduler.signal.aborted
          ? scheduler
          : undefined;
      if (
        (!resultCurrent || background || params.refresh === true) &&
        !current.pending &&
        Date.now() >= current.retryAt &&
        (!resultCurrent ||
          params.refresh === true ||
          Date.now() - current.refreshedAt >= 5 * 60_000)
      ) {
        const signal = background
          ? AbortSignal.any([lifetime.signal, background.signal])
          : lifetime.signal;
        const assertCurrent = () => signal.throwIfAborted();
        const refresh = async (): Promise<Result | undefined> => {
          try {
            const usesNativeHome =
              prepared.ownsLocalProcess && prepared.options.start.homeScope === "user";
            const native = usesNativeHome
              ? await probeCodexNativeAuth({ pluginConfig })
              : undefined;
            assertCurrent();
            if (usesNativeHome && !native) {
              current.result = undefined;
              current.ready = false;
              current.retryAt = Date.now() + 30_000;
              return undefined;
            }
            const revision = readCodexManagedRuntimeRevision();
            const result = await withCodexAppServerJsonClient(
              {
                startOptions: prepared.options.start,
                config: params.config,
                agentDir: params.agentDir,
                timeoutMs: discovery?.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
                signal,
                assertCurrent,
                ...(prepared.authProfileStore
                  ? {
                      authProfileStore: prepared.authProfileStore,
                      authProfileId: prepared.authProfileId,
                    }
                  : {}),
              },
              async (request, client) => {
                const clientCurrent = captureSharedCodexAppServerCatalogLifetime(client);
                const listed = await listAllCodexAppServerModels({
                  request,
                  limit: 100,
                  includeHidden: true,
                });
                if (listed.truncated) {
                  throw new Error("Codex model catalog pagination was truncated.");
                }
                const account = await request<CodexGetAccountResponse>({
                  method: "account/read",
                  requestParams: { refreshToken: false },
                });
                const observedType = account.account?.type;
                const accountType =
                  account.requiresOpenaiAuth &&
                  (observedType === "apiKey" || observedType === "chatgpt") &&
                  (!usesNativeHome ||
                    (native?.mode === "api-key" && observedType === "apiKey") ||
                    ((native?.mode === "oauth" || native?.mode === "token") &&
                      observedType === "chatgpt"))
                    ? observedType
                    : undefined;
                return {
                  models: listed.models,
                  runtimeVersion: client.getServerVersion(),
                  accountType,
                  authMode:
                    accountType === "apiKey"
                      ? "api_key"
                      : accountType === "chatgpt" &&
                          (native?.mode === "oauth" || native?.mode === "token")
                        ? native.mode
                        : undefined,
                  isCurrent: () =>
                    !signal.aborted &&
                    clientCurrent() &&
                    revision === readCodexManagedRuntimeRevision(),
                };
              },
            );
            // The deadline and owner must settle before publishing; late callbacks cannot write.
            if (!result.isCurrent()) {
              return undefined;
            }
            current.result = result;
            current.ready = true;
            current.refreshedAt = Date.now();
            current.failures = 0;
            current.retryAt = 0;
            return result;
          } catch (error) {
            current.ready = false;
            current.failures++;
            current.retryAt =
              Date.now() + Math.min(5 * 60_000, 30_000 * 2 ** Math.min(current.failures - 1, 4));
            throw error;
          }
        };
        let work: Promise<Result | undefined>;
        if (background) {
          const scheduled = createDeferred<Result | undefined>();
          let started = false;
          const cancel = () => {
            if (!started) {
              scheduled.resolve(undefined);
            }
          };
          signal.addEventListener("abort", cancel, { once: true });
          const job = background.schedule({
            id: `model-catalog:${prepared.key}`,
            delayMs: 0,
            run: async () => {
              started = true;
              try {
                scheduled.resolve(await refresh());
              } catch (error) {
                scheduled.reject(error);
              }
            },
          });
          current.cancelScheduled = () => {
            job.cancel();
            cancel();
          };
          work = scheduled.promise.finally(() => signal.removeEventListener("abort", cancel));
        } else {
          // Cold, non-service callers retain and await their own operation.
          work = refresh();
        }
        current.pending = work;
        pending.add(work);
        void work
          .catch((error: unknown) => {
            if (background && !signal.aborted) {
              embeddedAgentLog.warn(
                `Codex model catalog refresh failed; cached models retained: ${String(error)}`,
              );
            }
          })
          .finally(() => {
            current.pending = undefined;
            current.cancelScheduled = undefined;
            pending.delete(work);
          });
      }
      const result =
        params.refresh === true && current.pending
          ? await current.pending
          : resultCurrent
            ? current.result
            : await current.pending;
      if (
        lifetime.signal.aborted ||
        !result ||
        prepared.key !== prepare(params, pluginConfig).key ||
        observations.get(scope)?.accountKey !== prepared.key ||
        observations.get(scope)?.pluginConfig !== pluginConfig ||
        !result.isCurrent()
      ) {
        if (observations.get(scope) === observation) {
          observations.delete(scope);
        }
        return [];
      }
      const models = visible(result.models, params);
      if (observations.get(scope) === observation) {
        observation.models = new Set(models.map((model) => model.id));
      }
      return codexAppServerModelsToCatalogEntries(models, runtime);
    },
  };
}
