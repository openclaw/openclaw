import {
  fingerprintAuthProfileStoreEntry,
  type AgentHarnessModelCatalogParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { prepareCodexAppServerAuthBinding } from "./auth-binding.js";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
} from "./auth-profile.js";
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
  captureSharedClientRegistration,
} from "./shared-client.js";

// Manifest contract (openclaw.plugin.json discovery.timeoutMs default): live model
// discovery is bounded tightly so a wedged app-server degrades to the static catalog.
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 2500;
type ModelInputType = NonNullable<ModelCatalogEntry["input"]>[number];
type CodexModelCatalogSelectionAttempt =
  | {
      phase: "bind";
      authBindingFingerprint: string;
      attemptFingerprint: string;
    }
  | {
      phase: "assert";
      authBindingFingerprint?: string;
      attemptFingerprint: string;
    };
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
    profileAuthSelected?: boolean;
    authProfileId?: string;
    authProfileOwnerFingerprint?: string;
    authBindingFingerprint?: string;
    isClientCurrent?: () => boolean;
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
        (!observation.profileAuthSelected || observation.authBindingFingerprint !== undefined) &&
        observation.isCurrent?.()
        ? {
            accountType: observation.accountType,
            ...(observation.authMode ? { authMode: observation.authMode } : {}),
          }
        : undefined;
    },
    captureSelectionAuthority(
      params: AgentHarnessModelCatalogParams & { provider: string; modelId: string },
      pluginConfig: unknown,
    ) {
      const observation = scopes.get(params.config)?.get(scopeKey(params));
      const isLiveProfileOwnerCurrent = () => {
        if (!observation?.profileAuthSelected) {
          return true;
        }
        const authProfileId = observation.authProfileId;
        const authProfileOwnerFingerprint = observation.authProfileOwnerFingerprint;
        if (!authProfileId || !authProfileOwnerFingerprint) {
          return false;
        }
        try {
          const store = resolveCodexAppServerAuthProfileStore({
            agentDir: params.agentDir,
            authProfileId,
            config: params.config,
          });
          return (
            fingerprintAuthProfileStoreEntry({
              profileId: authProfileId,
              credential: store.profiles[authProfileId],
            }) === authProfileOwnerFingerprint
          );
        } catch {
          return false;
        }
      };
      const isCurrent = () =>
        !disposed &&
        params.provider === "openai" &&
        observation !== undefined &&
        scopes.get(params.config)?.get(scopeKey(params)) === observation &&
        observation.pluginConfig === pluginConfig &&
        observation.models?.has(params.modelId) === true &&
        observation.accountType !== undefined &&
        (observation.profileAuthSelected
          ? observation.isClientCurrent?.() === true &&
            observation.authBindingFingerprint !== undefined &&
            isLiveProfileOwnerCurrent()
          : observation.isCurrent?.() === true);
      if (!isCurrent()) {
        return undefined;
      }
      let preparedAttemptAuthority: string | undefined;
      return (attempt?: CodexModelCatalogSelectionAttempt) => {
        if (!isCurrent()) {
          throw new Error("Codex native model catalog selection is no longer current");
        }
        if (!observation?.profileAuthSelected || attempt === undefined) {
          return;
        }
        if (attempt.phase === "bind") {
          const validAttempt =
            attempt.authBindingFingerprint === observation.authBindingFingerprint &&
            typeof attempt.attemptFingerprint === "string" &&
            attempt.attemptFingerprint.length > 0;
          if (!validAttempt) {
            throw new Error("Codex native model catalog selection is no longer current");
          }
          if (preparedAttemptAuthority && preparedAttemptAuthority !== attempt.attemptFingerprint) {
            throw new Error("Codex native model catalog selection is no longer current");
          }
          preparedAttemptAuthority = attempt.attemptFingerprint;
          return;
        }
        if (
          attempt.authBindingFingerprint !== observation.authBindingFingerprint ||
          !preparedAttemptAuthority ||
          attempt.attemptFingerprint !== preparedAttemptAuthority
        ) {
          throw new Error("Codex native model catalog selection is no longer current");
        }
      };
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
      observation.profileAuthSelected = authProfileId !== undefined;
      observation.authProfileId = authProfileId;
      if (authProfileId && authProfileStore) {
        observation.authProfileOwnerFingerprint = fingerprintAuthProfileStoreEntry({
          profileId: authProfileId,
          credential: authProfileStore.profiles[authProfileId],
        });
        try {
          observation.authBindingFingerprint = (
            await prepareCodexAppServerAuthBinding({
              authProfileId,
              authProfileStore,
              agentDir: params.agentDir,
              config: params.config,
            })
          )?.fingerprint;
        } catch {
          // Discovery can still populate the picker, but an unresolvable profile cannot
          // authorize a later attempt to reuse its native model selection.
        }
      }
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
          ...(authProfileStore ? { authProfileStore, authProfileId } : {}),
        },
        async (request, client) => {
          const discover = async () => {
            const isCurrent = captureSharedCodexAppServerCatalogLifetime(client);
            const isClientCurrent = captureSharedClientRegistration(client);
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
            return {
              models,
              rawModelCount: listed.models.length,
              isCurrent,
              isClientCurrent,
              accountType,
            } as const;
          };
          const first = await discover();
          if (first.rawModelCount > 0 && first.isCurrent()) {
            return first;
          }
          // A genuinely empty cold response or account/config churn can race native startup.
          // Re-read model/list and account/read together once, on the same scoped client.
          const retryIsCurrent = captureSharedCodexAppServerCatalogLifetime(client);
          return retryIsCurrent() ? discover() : first;
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
      observation.isClientCurrent = result.isClientCurrent;
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
