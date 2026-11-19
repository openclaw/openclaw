import { isDeepStrictEqual } from "node:util";
import { readSourceReplyDeliveryRuntime } from "../../../auto-reply/reply/source-reply-delivery-runtime.js";
import { resolveMergedModelProviderConfig } from "../../../config/model-provider-config.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import { providerOwnsDynamicModelPreparation } from "../../../plugins/provider-runtime.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import {
  resolveAdmittedRunActiveAssertion,
  resolvePreparedRunAdmission,
} from "../../admitted-run-context.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../../model-auth-markers.js";
import { hasSyntheticLocalProviderAuthConfig } from "../../model-auth-provider-config.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../prepared-model-runtime-generation-scope.js";
import {
  acquirePreparedModelRuntimeSnapshot,
  getPreparedModelRuntimeSnapshot,
  type PreparedModelRuntimeLease,
} from "../../prepared-model-runtime.js";
import { getModelProviderLocalServiceReconciler } from "../../provider-local-service-reconcile.js";
import { getModelProviderLocalService } from "../../provider-local-service.js";
import { isConfiguredKeyAuthSource } from "../../provider-model-auth-source-plan.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
  inheritModelProviderRequestRouteFacts,
} from "../../provider-request-config.js";
import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";
import { providerUsesCredentialScopedModelMetadata } from "../../runtime-plan/credential-scoped-model.js";
import { log } from "../logger.js";
import { prepareEmbeddedRunTransport } from "./runtime-preparation.js";
import { resolveRequestStreamTransportOverrides } from "./runtime-resolution.js";

/** Admission and request policy survive replacement of a failed configured transport. */
export async function prepareEmbeddedRunRuntime(
  input: Parameters<typeof prepareEmbeddedRunTransport>[0],
) {
  const params = input.runParams;
  const initial = await prepareEmbeddedRunTransport(input);
  let transport = initial;
  const leases: PreparedModelRuntimeLease[] = [];
  const disposeLease = (lease: PreparedModelRuntimeLease) =>
    runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "transport-lease-dispose",
      log,
      cleanup: async () => await lease[Symbol.asyncDispose](),
    });
  const releaseTransport = async () => {
    transport.stopRuntimeAuthRefreshTimer();
    await Promise.all(leases.splice(0).map(disposeLease));
  };
  try {
    const initialSnapshot = initial.snapshot();
    let transportModel = initialSnapshot.effectiveModel;
    let transportConfig = params.config;
    let publication = input.preparedModelRuntime;
    const admittedRunContext = await resolvePreparedRunAdmission({
      runId: params.runId,
      runtimeKind: initialSnapshot.pluginHarnessOwnsTransport ? "plugin-harness" : "embedded",
      admittedRunContext: params.admittedRunContext,
      preparedRunAdmission: params.preparedRunAdmission,
    });
    const assertActive = resolveAdmittedRunActiveAssertion(admittedRunContext, params.abortSignal);
    const sourceReplyDeliveryRuntime = readSourceReplyDeliveryRuntime(params);
    if (sourceReplyDeliveryRuntime?.origin === "runtime_default") {
      const visibleReplies =
        initialSnapshot.agentHarness.deliveryDefaults?.visibleReplies ??
        initialSnapshot.agentHarness.deliveryDefaults?.sourceVisibleReplies;
      const mode = visibleReplies === "message_tool" ? "message_tool_only" : "automatic";
      sourceReplyDeliveryRuntime.applyPreparedMode(params, mode);
      params.forceMessageTool = mode === "message_tool_only";
    }
    const snapshot = () => {
      const current = transport.snapshot();
      const admitted = transport === initial ? current : initial.snapshot();
      return {
        ...current,
        effectiveModel: transport === initial ? admitted.effectiveModel : transportModel,
        transportConfig,
        thinkLevel: admitted.thinkLevel,
        modelContextWindow: admitted.modelContextWindow,
        contextTokenBudget: admitted.contextTokenBudget,
        authoredContextTokenCap: admitted.authoredContextTokenCap,
        contextWindowInfo: admitted.contextWindowInfo,
        outerContextTokenMeta: admitted.outerContextTokenMeta,
      };
    };
    const hasStaticConfiguredTransport = (config: typeof params.config) =>
      !providerOwnsDynamicModelPreparation({
        provider: initial.provider,
        config,
        workspaceDir: input.workspaceDir,
      }) &&
      !providerUsesCredentialScopedModelMetadata({
        provider: initial.provider,
        modelId: initial.modelId,
        config,
        agentDir: input.agentDir,
        workspaceDir: input.workspaceDir,
      });
    return {
      ...initial,
      admittedRunContext,
      get authStorage() {
        return transport.authStorage;
      },
      get modelRegistry() {
        return transport.modelRegistry;
      },
      get attemptAuthProfileStore() {
        return transport.attemptAuthProfileStore;
      },
      get profileFailureStore() {
        return transport.profileFailureStore;
      },
      advanceAttemptAuthProfile: () => transport.advanceAttemptAuthProfile(),
      maybeRefreshRuntimeAuthForAuthError: (
        ...args: Parameters<typeof initial.maybeRefreshRuntimeAuthForAuthError>
      ) => transport.maybeRefreshRuntimeAuthForAuthError(...args),
      getApiKeyInfo: () => transport.getApiKeyInfo(),
      resolveRunAttemptAuthProfileStore: () => transport.resolveRunAttemptAuthProfileStore(),
      snapshot,
      refreshTransportForConnectionError: async () => {
        const current = transport.snapshot();
        const source = current.activePreparedAuthPlan.credentialSource;
        const localNoAuth =
          source?.kind === "none" &&
          transport.getApiKeyInfo()?.apiKey === CUSTOM_LOCAL_AUTH_MARKER &&
          hasSyntheticLocalProviderAuthConfig({ cfg: transportConfig, provider: initial.provider });
        if (
          !publication ||
          initialSnapshot.pluginHarnessOwnsTransport ||
          initial.nativeModelOwned ||
          params.preparedModelRuntimeMode === "isolated-read-only" ||
          params.authProfileBinding ||
          params.authProfileId ||
          resolveRequestStreamTransportOverrides(params.streamParams) ||
          initial.profileCandidates.some((profileId) => profileId !== undefined) ||
          current.lastProfileId ||
          current.runtimeAuthState ||
          getModelProviderLocalService(initialSnapshot.effectiveModel) ||
          getModelProviderLocalServiceReconciler(initialSnapshot.effectiveModel) ||
          (!localNoAuth &&
            (!isConfiguredKeyAuthSource(source) ||
              source?.kind !== "direct" ||
              source.authorization !== "declared")) ||
          !hasStaticConfiguredTransport(transportConfig)
        ) {
          return;
        }
        const ownerInput = {
          config: publication.config,
          agentId: publication.agentId ?? params.agentId,
          agentDir: publication.agentDir,
          inheritedAuthDir: publication.inheritedAuthDir,
          workspaceDir: publication.workspaceDir,
        };
        const published = getPreparedModelRuntimeSnapshot(ownerInput);
        if (
          !published ||
          published.metadataSnapshot !== publication.metadataSnapshot ||
          !resolveMergedModelProviderConfig(published.config, initial.provider) ||
          resolveMergedModelProviderConfig(published.config, initial.provider)?.localService ||
          isDeepStrictEqual(
            resolveMergedModelProviderConfig(transportConfig, initial.provider),
            resolveMergedModelProviderConfig(published.config, initial.provider),
          )
        ) {
          return;
        }
        let candidate: typeof initial | undefined;
        let lease: PreparedModelRuntimeLease | undefined;
        try {
          lease = await acquirePreparedModelRuntimeSnapshot(ownerInput);
          const fresh = lease.snapshot;
          if (
            fresh.config !== published.config ||
            fresh.metadataSnapshot !== published.metadataSnapshot
          ) {
            return;
          }
          input.assertCurrent();
          assertActive?.();
          candidate = await withPreparedModelRuntimePluginGenerationScope(
            lease.pluginGeneration,
            () =>
              withPluginRuntimeGenerationScope(fresh, async () => {
                if (!hasStaticConfiguredTransport(fresh.config)) {
                  return undefined;
                }
                return await prepareEmbeddedRunTransport({
                  ...input,
                  refreshTransport: {
                    provider: initial.provider,
                    modelId: initial.modelId,
                    api: initialSnapshot.effectiveModel.api,
                    harnessId: initialSnapshot.agentHarness.id,
                  },
                  preparedModelRuntime: fresh,
                  runParams: {
                    ...params,
                    config: fresh.config,
                    admittedRunContext,
                    preparedRunAdmission: undefined,
                    resolvedModelSelection: {
                      provider: initial.provider,
                      modelId: initial.modelId,
                    },
                    agentHarnessRuntimeOverride: initialSnapshot.agentHarness.id,
                  },
                  markStartupStage: () => {},
                  notifyExecutionPhase: () => {},
                });
              }),
          );
          input.assertCurrent();
          assertActive?.();
          if (!candidate) {
            return;
          }
          const next = candidate.snapshot();
          if (
            getPreparedModelRuntimeSnapshot(ownerInput) !== published ||
            next.lastProfileId ||
            next.runtimeAuthState ||
            (next.activePreparedAuthPlan.credentialSource?.kind === "none" &&
              candidate.getApiKeyInfo()?.apiKey !== CUSTOM_LOCAL_AUTH_MARKER) ||
            getModelProviderLocalService(next.effectiveModel) ||
            getModelProviderLocalServiceReconciler(next.effectiveModel)
          ) {
            return;
          }
          const nextModel: ProviderRuntimeModel = next.effectiveModel;
          transportModel = inheritModelProviderRequestRouteFacts(
            nextModel,
            attachModelProviderRequestTransport(
              {
                ...initialSnapshot.effectiveModel,
                baseUrl: nextModel.baseUrl,
                headers: nextModel.headers,
                authHeader: nextModel.authHeader,
                requestTimeoutMs: nextModel.requestTimeoutMs,
              },
              // An empty current override clears any admitted transport symbol.
              getModelProviderRequestTransport(nextModel) ?? {},
            ),
          );
          transport.stopRuntimeAuthRefreshTimer();
          transport = candidate;
          transportConfig = fresh.config;
          publication = fresh;
          // A replaced auth callback may still be settling; the run retains its lease.
          leases.push(lease);
        } catch (error) {
          input.assertCurrent();
          assertActive?.();
          log.warn(`connection retry transport refresh failed: ${String(error)}`);
        } finally {
          if (candidate !== transport) {
            candidate?.stopRuntimeAuthRefreshTimer();
            if (lease) {
              await disposeLease(lease);
            }
          }
        }
      },
      stopRuntimeAuthRefreshTimer: () => transport.stopRuntimeAuthRefreshTimer(),
      releaseTransport,
    };
  } catch (error) {
    await releaseTransport();
    throw error;
  }
}
