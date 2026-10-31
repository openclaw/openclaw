import {
  findConfiguredProviderModel,
  resolveMergedModelProviderEntry,
} from "../config/model-provider-config.js";
import { requiredWorkerHelperError } from "../config/required-worker-profile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { supportsDecisionInput } from "../decisions/capabilities.js";
import type { DecisionEvaluateOptionsV2 } from "../decisions/execution-types.js";
import type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
import { evaluatePreparedDecisionProvider } from "../decisions/provider-execution.js";
import type { PreparedDecisionBilling } from "../decisions/provider-host.js";
import type { DecisionProviderV2 } from "../decisions/provider-types.js";
import type { DecisionBatchV2, ProviderDecisionOutcomeV2 } from "../decisions/types-v2.js";
import {
  assertProviderAuthAuthority,
  attachProviderAuthAuthority,
  getProviderAuthAuthority,
} from "../plugins/provider-auth-authority.js";
import {
  createProviderModelCatalogIdNormalizer,
  resolveProviderModelRoutes,
} from "../plugins/provider-model-routes.js";
import type { PluginProviderRegistration } from "../plugins/provider-plugin.types.js";
import {
  prepareProviderRuntimeAuth,
  UnsupportedProviderRuntimeAuthCapabilityError,
} from "../plugins/provider-runtime-auth.js";
import { normalizeProviderTransportWithPlugin } from "../plugins/provider-runtime.js";
import {
  normalizeResolvedTransportApi,
  sanitizeModelHeaders,
} from "./embedded-agent-runner/model.inline-provider.js";
import { applyLocalNoAuthHeaders } from "./model-auth-markers.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";
import { isProviderAuthError, type ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { applyAuthHeaderOverride, applySecretRefHeaderSentinels } from "./model-auth.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { withPreparedModelInference } from "./prepared-model-inference.js";
import {
  applyPreparedRuntimeAuthToModel,
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "./provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "./provider-runtime-auth-protection.js";
import {
  unwrapSecretSentinelsForProviderEgress,
  unwrapModelHeaderSentinelsForProviderEgress,
} from "./provider-secret-egress.js";

/** Decision SDK dispatch uses the existing prepared generation and credential owner, without a fake chat Model. */
export async function executePreparedDecision(params: {
  provider: DecisionProviderV2;
  registration: PluginProviderRegistration;
  batch: DecisionBatchV2;
  modelId: string;
  config: OpenClawConfig;
  options: DecisionEvaluateOptionsV2;
  signal: AbortSignal;
  deadlineMonotonicMs: number;
  isAdmissible: () => boolean;
  onPreparedBilling?: (facts: PreparedDecisionBilling) => void;
}): Promise<ProviderDecisionOutcomeV2> {
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    return params.isAdmissible() && performance.now() < params.deadlineMonotonicMs;
  };
  if (!assertCurrent() || requiredWorkerHelperError(params.config)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const selected = splitTrailingAuthProfile(params.modelId);
  const modelId = selected.model;
  const profileId = selected.profile;
  return withPreparedModelInference<ProviderDecisionOutcomeV2>(
    { cfg: params.config, agentId: params.options.agentId, signal: params.signal },
    { provider: params.registration.provider.id, modelId },
    async (context) => {
      const prepared = context.preparedModelRuntime;
      let auth: ResolvedProviderAuth | undefined;
      const assertPrepared = () => {
        if (!assertCurrent()) {
          return false;
        }
        if (!prepared.isCurrent()) {
          throw new Error("Decision model generation is no longer current.");
        }
        assertProviderAuthAuthority(auth);
        return true;
      };
      if (!assertPrepared()) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const canonical = prepared.pluginRegistry?.providers.find(
        (entry) => entry.provider.id === params.registration.provider.id,
      );
      if (
        !canonical ||
        canonical.pluginId !== params.registration.pluginId ||
        canonical.source !== params.registration.source
      ) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      let row = prepared.modelCatalog.entries.find(
        (entry) => entry.provider === canonical.provider.id && entry.id === modelId,
      );
      if (!row) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const route = resolveProviderModelRoutes({
        provider: row.provider,
        modelId: row.id,
        api: row.api,
        baseUrl: row.baseUrl,
        config: prepared.config,
        capability: "decision",
      });
      if (route) {
        // Capability routing precedes auth. Never guess among physical destinations
        // or carry stale catalog capabilities into a provider-selected endpoint.
        if (route.kind !== "routes" || route.routes.length !== 1) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        const selectedRoute = route.routes[0];
        const decision = selectedRoute.inference
          ? selectedRoute.inference.decision
          : modelTransportRoutesMatch(row, selectedRoute)
            ? row.inference?.decision
            : undefined;
        row = {
          ...row,
          api: selectedRoute.api,
          baseUrl: selectedRoute.baseUrl,
          inference: { chat: row.inference?.chat ?? false, ...(decision ? { decision } : {}) },
        };
      } else {
        // Reuse the selected normal provider's existing catalog hook for protocol facts,
        // including explicitly configured custom model IDs. No provider rediscovery or chat Model.
        const supplemental = await canonical.provider.augmentModelCatalog?.({
          config: prepared.config,
          agentDir: prepared.agentDir,
          workspaceDir: context.workspaceDir,
          env: process.env,
          entries: [structuredClone(row)],
        });
        if (!assertPrepared()) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        row =
          supplemental?.find((entry) => entry.provider === row?.provider && entry.id === modelId) ??
          row;
      }
      if (!supportsDecisionInput(row.inference?.decision, params.batch, params.options.reasoning)) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const normalized = route
        ? undefined
        : normalizeProviderTransportWithPlugin({
            provider: row.provider,
            modelId: row.id,
            config: prepared.config,
            workspaceDir: context.workspaceDir,
            context: {
              provider: row.provider,
              modelId: row.id,
              config: prepared.config,
              workspaceDir: context.workspaceDir,
              api: row.api,
              baseUrl: row.baseUrl,
            },
          });
      let model: DecisionProviderContextV2["model"] = {
        ...row,
        api: normalizeResolvedTransportApi(normalized?.api) ?? row.api,
        ...(normalized?.baseUrl ? { baseUrl: normalized.baseUrl } : {}),
      };
      const providerConfig = resolveMergedModelProviderEntry(
        prepared.config,
        row.provider,
      )?.providerConfig;
      if (providerConfig) {
        const configuredModel = findConfiguredProviderModel(
          providerConfig,
          row.provider,
          row.id,
          createProviderModelCatalogIdNormalizer(row.provider),
        );
        const request = sanitizeConfiguredModelProviderRequest(providerConfig.request);
        // Catalog projections omit authored headers; use the normal model resolver's
        // provider → model → request precedence before private provider handoff.
        const resolved = resolveProviderRequestConfig({
          provider: row.provider,
          api: model.api,
          baseUrl: model.baseUrl,
          capability: "other",
          providerHeaders: sanitizeModelHeaders(providerConfig.headers),
          modelHeaders: sanitizeModelHeaders(configuredModel?.headers),
          authHeader: providerConfig.authHeader,
          request,
        });
        model = applySecretRefHeaderSentinels(
          attachModelProviderRequestTransport({ ...model, headers: resolved.headers }, request),
          prepared.config,
        );
      }
      try {
        auth = await resolveApiKeyForProviderCore({
          provider: row.provider,
          modelId: row.id,
          modelApi: model.api,
          modelBaseUrl: model.baseUrl,
          profileId,
          ...(profileId ? { lockedProfile: true, allowAuthProfileFallback: false } : {}),
          cfg: prepared.config,
          agentDir: prepared.agentDir,
          workspaceDir: context.workspaceDir,
          signal: params.signal,
          secretSentinels: true,
          capability: "decision",
        });
        model = attachProviderAuthAuthority(model, getProviderAuthAuthority(auth));
        if (auth.apiKey) {
          const exchanged = await prepareProviderRuntimeAuth({
            provider: row.provider,
            config: prepared.config,
            workspaceDir: context.workspaceDir,
            env: process.env,
            assertCurrent: () => {
              if (!assertPrepared()) {
                throw new Error("Decision credential exchange is no longer admitted.");
              }
            },
            context: {
              capability: "decision",
              config: prepared.config,
              agentDir: prepared.agentDir,
              workspaceDir: context.workspaceDir,
              env: process.env,
              provider: row.provider,
              modelId: row.id,
              // Exchange needs transport identity, not catalog limits or capabilities.
              // Keep the private request and credential owners on this projection.
              model: attachProviderAuthAuthority(
                attachModelProviderRequestTransport(
                  {
                    id: model.id,
                    provider: model.provider,
                    name: model.name,
                    api: model.api,
                    baseUrl: model.baseUrl,
                    headers: model.headers,
                  },
                  getModelProviderRequestTransport(model),
                ),
                getProviderAuthAuthority(model),
              ),
              apiKey: auth.apiKey,
              authMode: auth.mode,
              profileId: auth.profileId,
            },
          });
          const protectedAuth = protectPreparedProviderRuntimeAuth({
            provider: row.provider,
            preparedAuth: exchanged,
          });
          auth = { ...auth, apiKey: protectedAuth?.apiKey?.trim() || auth.apiKey };
          model = applyPreparedRuntimeAuthToModel(model, protectedAuth);
        }
        model = applyAuthHeaderOverride(
          { ...model, headers: applyLocalNoAuthHeaders(model.api, auth.apiKey, model.headers) },
          auth,
          prepared.config,
        );
      } catch (error) {
        // Profile lookup uses ordinary errors too. Fail closed without changing accounts;
        // cancellation and generation loss remain distinct rejection paths.
        assertPrepared();
        if (error instanceof UnsupportedProviderRuntimeAuthCapabilityError) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const assertAuthAuthority = getProviderAuthAuthority(auth);
      model = attachProviderAuthAuthority(model, assertAuthAuthority);
      if (!assertPrepared()) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      // A route rewrite cannot carry a hosted billing claim into another endpoint.
      if (!modelTransportRoutesMatch(row, model) && model.inference?.decision) {
        const { billing: _billing, ...decision } = model.inference.decision;
        model.inference = { ...model.inference, decision };
      }
      const offered = structuredClone(params.batch);
      const egressModel = unwrapModelHeaderSentinelsForProviderEgress(
        model,
        "decision provider handoff",
      );
      const request = getModelProviderRequestTransport(egressModel);
      // Structured cloning omits symbol-attached exchange overrides. Preserve their private owner facts too.
      const privateModel = attachProviderAuthAuthority(
        attachModelProviderRequestTransport(
          structuredClone(egressModel),
          request ? structuredClone(request) : undefined,
        ),
        assertAuthAuthority,
      );
      const providerContext: DecisionProviderContextV2 = {
        model: privateModel,
        config: prepared.config,
        agentId: params.options.agentId,
        workspaceDir: context.workspaceDir,
        auth: {
          mode: auth.mode,
          ...(auth.profileId ? { profileId: auth.profileId } : {}),
          ...(auth.apiKey
            ? {
                apiKey: unwrapSecretSentinelsForProviderEgress(
                  auth.apiKey,
                  "decision provider handoff",
                ),
              }
            : {}),
        },
        signal: params.signal,
        deadlineMonotonicMs: params.deadlineMonotonicMs,
        reasoning: params.options.reasoning,
        isAdmissible: assertPrepared,
      };
      if (!assertPrepared()) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      params.onPreparedBilling?.({
        provider: model.provider,
        model: model.id,
        billing: model.inference?.decision?.billing,
      });
      return evaluatePreparedDecisionProvider({
        provider: params.provider,
        batch: params.batch,
        offered,
        context: providerContext,
        capabilities: model.inference?.decision,
        isAdmissible: assertPrepared,
      });
    },
  ).catch((error: unknown): ProviderDecisionOutcomeV2 => {
    // Caller, cancellation and generation checks run before the credential fence.
    // A retired physical credential owner is unavailable auth, never a caller contract failure.
    if (!assertCurrent()) {
      return { status: "unavailable", reason: "unsupported-input" };
    }
    if (isProviderAuthError(error, "missing-provider-auth")) {
      return { status: "unavailable", reason: "credentials-unavailable" };
    }
    throw error;
  });
}
