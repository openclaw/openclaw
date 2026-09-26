import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
import type {
  DecisionBatchV2,
  DecisionEvaluateOptionsV2,
  DecisionProviderV2,
  ProviderDecisionOutcomeV2,
} from "../decisions/types-v2.js";
import { validateDecisionResultV2 } from "../decisions/validation-v2.js";
import { createProviderModelCatalogIdNormalizer } from "../plugins/provider-model-routes.js";
import type { PluginProviderRegistration } from "../plugins/provider-plugin.types.js";
import { normalizeProviderTransportWithPlugin } from "../plugins/provider-runtime.js";
import {
  normalizeResolvedTransportApi,
  sanitizeModelHeaders,
} from "./embedded-agent-runner/model.inline-provider.js";
import { applySecretRefHeaderSentinels } from "./model-auth-model.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { resolveManifestModelCatalogHeaders } from "./model-catalog-manifest.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { withPreparedModelInference } from "./prepared-model-inference.js";
import {
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "./provider-request-config.js";
import {
  unwrapSecretSentinelsForProviderEgress,
  unwrapModelHeaderSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";

function supportsInput(
  model: ModelCatalogEntry,
  batch: DecisionBatchV2,
  reasoning: DecisionEvaluateOptionsV2["reasoning"],
): boolean {
  const capability = model.inference?.decision;
  if (
    !capability ||
    !capability.input.includes(batch.state.type === "image" ? "image" : "text") ||
    (reasoning !== undefined && !capability.reasoning?.modes.includes(reasoning)) ||
    (capability.limits?.maxQuestions !== undefined &&
      Object.keys(batch.questions).length > capability.limits.maxQuestions)
  ) {
    return false;
  }
  for (const question of Object.values(batch.questions)) {
    const kind = capability.questions?.[question.type];
    if (!kind) {
      if (capability.questions) {
        return false;
      }
      continue;
    }
    if (
      question.type === "boolean" &&
      kind.requiresCriteria &&
      (question.criteria?.true == null || question.criteria.false == null)
    ) {
      return false;
    }
    const count =
      question.type === "choice" || question.type === "tags"
        ? Object.keys(question.criteria).length
        : question.type === "score"
          ? question.criteria.length
          : question.type === "sort" && batch.state.type === "list"
            ? batch.state.items.length
            : undefined;
    if (
      count !== undefined &&
      ((kind.minOptions !== undefined && count < kind.minOptions) ||
        (kind.maxOptions !== undefined && count > kind.maxOptions) ||
        (batch.state.type === "image" &&
          kind.maxImageOptions !== undefined &&
          count > kind.maxImageOptions))
    ) {
      return false;
    }
  }
  return true;
}

/** Decision SDK dispatch uses the existing prepared generation and credential owner, without a fake chat Model. */
export async function executePreparedDecision(params: {
  provider: DecisionProviderV2;
  registration: PluginProviderRegistration;
  batch: DecisionBatchV2;
  modelId: string;
  profileId?: string;
  config: OpenClawConfig;
  options: DecisionEvaluateOptionsV2;
  signal: AbortSignal;
  deadlineMonotonicMs: number;
  assertCurrent: () => void;
  onPreparedBilling?: (billing: ModelDecisionCapabilities["billing"]) => void;
}): Promise<ProviderDecisionOutcomeV2> {
  const assertCurrent = () => {
    params.assertCurrent();
    params.signal.throwIfAborted();
    if (performance.now() >= params.deadlineMonotonicMs) {
      throw new Error("Decision preparation deadline exhausted.");
    }
  };
  assertCurrent();
  return withPreparedModelInference(
    { cfg: params.config, agentId: params.options.agentId, signal: params.signal },
    { provider: params.registration.provider.id, modelId: params.modelId },
    async (context) => {
      const prepared = context.preparedModelRuntime;
      const assertPrepared = () => {
        assertCurrent();
        if (!prepared.isCurrent()) {
          throw new Error("Decision model generation is no longer current.");
        }
      };
      assertPrepared();
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
      const row = prepared.modelCatalog.entries.find(
        (entry) => entry.provider === canonical.provider.id && entry.id === params.modelId,
      );
      if (!row || !supportsInput(row, params.batch, params.options.reasoning)) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const normalized = normalizeProviderTransportWithPlugin({
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
      let auth: ResolvedProviderAuth;
      try {
        if (canonical.provider.prepareRuntimeAuth) {
          // Existing exchange hooks have a chat Model contract. Never fabricate its costs or limits.
          if (row.inference?.chat === false) {
            return { status: "unavailable", reason: "unsupported-input" };
          }
          const completion = await prepareSimpleCompletionModel(
            {
              cfg: prepared.config,
              agentId: params.options.agentId,
              provider: row.provider,
              modelId: row.id,
              profileId: params.profileId,
              bindAuthOwner: true,
              agentDir: prepared.agentDir,
              workspaceDir: context.workspaceDir,
              signal: params.signal,
              preparedModelRuntime: prepared,
            },
            assertPrepared,
          );
          if ("error" in completion) {
            return { status: "unavailable", reason: "credentials-unavailable" };
          }
          auth = completion.auth;
          model = {
            ...model,
            api: completion.model.api,
            baseUrl: completion.model.baseUrl,
            headers: completion.model.headers,
          };
        } else {
          const providerConfig = resolveMergedModelProviderConfig(prepared.config, row.provider);
          const configuredModel = findConfiguredProviderModel(
            providerConfig,
            row.provider,
            row.id,
            createProviderModelCatalogIdNormalizer(row.provider, prepared.metadataSnapshot),
          );
          // The public catalog intentionally excludes private headers. Compile them from
          // this generation's config with the same precedence and sanitizers as chat.
          const request = resolveProviderRequestConfig({
            provider: row.provider,
            api: model.api,
            baseUrl: model.baseUrl,
            providerMetadataOwners: prepared.metadataSnapshot.owners,
            discoveredHeaders: resolveManifestModelCatalogHeaders({
              config: prepared.config,
              snapshot: prepared.metadataSnapshot,
              model,
            }),
            providerHeaders: sanitizeModelHeaders(providerConfig?.headers, {
              stripSecretRefMarkers: true,
            }),
            modelHeaders: sanitizeModelHeaders(configuredModel?.headers, {
              stripSecretRefMarkers: true,
            }),
            authHeader: providerConfig?.authHeader,
            request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
            capability: "llm",
            transport: "http",
          });
          model = applySecretRefHeaderSentinels(
            { ...model, headers: request.headers },
            prepared.config,
          );
          auth = await resolveApiKeyForProviderCore({
            provider: row.provider,
            modelId: row.id,
            modelApi: model.api,
            modelBaseUrl: model.baseUrl,
            profileId: params.profileId,
            ...(params.profileId ? { lockedProfile: true, allowAuthProfileFallback: false } : {}),
            cfg: prepared.config,
            agentDir: prepared.agentDir,
            workspaceDir: context.workspaceDir,
            signal: params.signal,
            secretSentinels: true,
          });
        }
      } catch {
        // Profile lookup uses ordinary errors too. Fail closed without changing accounts;
        // cancellation and generation loss remain distinct rejection paths.
        assertPrepared();
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      assertPrepared();
      // A route rewrite cannot carry a hosted billing claim into another endpoint.
      if (!modelTransportRoutesMatch(row, model) && model.inference?.decision) {
        const { billing: _billing, ...decision } = model.inference.decision;
        model.inference = { ...model.inference, decision };
      }
      // Capture host-prepared route facts before exposing a separate model copy to the adapter.
      params.onPreparedBilling?.(structuredClone(model.inference?.decision?.billing));
      const offered = structuredClone(params.batch);
      const providerContext: DecisionProviderContextV2 = {
        model: structuredClone(
          unwrapModelHeaderSentinelsForProviderEgress(model, "decision provider handoff"),
        ),
        config: prepared.config,
        agentId: params.options.agentId,
        workspaceDir: context.workspaceDir,
        auth: {
          ...auth,
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
      };
      assertPrepared();
      const result = await params.provider.evaluate(params.batch, providerContext);
      assertPrepared();
      const status = result.status;
      if (status === "ok") {
        const value = result.result;
        if (!validateDecisionResultV2(offered, value, model.inference?.decision)) {
          return { status: "unavailable", reason: "invalid-response" };
        }
        const snapshot = structuredClone(value);
        assertPrepared();
        return { status, result: snapshot };
      }
      if (status !== "unavailable") {
        throw new Error("Invalid decision provider outcome");
      }
      const { reason, retryAfterMs } = result;
      assertPrepared();
      return { status, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    },
  );
}
