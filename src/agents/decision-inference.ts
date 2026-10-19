import {
  findConfiguredProviderModel,
  resolveMergedModelProviderEntry,
} from "../config/model-provider-config.js";
import { requiredWorkerHelperError } from "../config/required-worker-profile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
import type { PreparedDecisionBilling } from "../decisions/provider-host.js";
import type {
  DecisionBatchV2,
  DecisionEvaluateOptionsV2,
  DecisionProviderV2,
  ProviderDecisionOutcomeV2,
} from "../decisions/types-v2.js";
import { validateDecisionResultV2 } from "../decisions/validation-v2.js";
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
import { normalizeProviderTransportWithPlugin } from "../plugins/provider-runtime.js";
import {
  normalizeResolvedTransportApi,
  sanitizeModelHeaders,
} from "./embedded-agent-runner/model.inline-provider.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";
import { isProviderAuthError, type ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { applySecretRefHeaderSentinels } from "./model-auth.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { withPreparedModelInference } from "./prepared-model-inference.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
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
  if (batch.state.type === "image" && capability.limits?.image) {
    const image = capability.limits.image;
    const [prefix, payload = ""] = batch.state.dataUri.split(",", 2);
    const mime = prefix?.slice(5).split(";", 1)[0];
    if (
      !image.mimeTypes.some((allowed) => allowed === mime) ||
      Buffer.byteLength(payload, "base64") > image.maxBytes
    ) {
      return false;
    }
  }
  for (const question of Object.values(batch.questions)) {
    if (
      reasoning === "on" &&
      capability.reasoning?.questionTypes &&
      !capability.reasoning.questionTypes.includes(question.type)
    ) {
      return false;
    }
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
  const profileId = params.profileId ?? selected.profile;
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
      if (!supportsInput(row, params.batch, params.options.reasoning)) {
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
              profileId,
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
          const request = getModelProviderRequestTransport(completion.model);
          if (request) {
            model = attachModelProviderRequestTransport(model, request);
          }
        } else {
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
        }
      } catch {
        // Profile lookup uses ordinary errors too. Fail closed without changing accounts;
        // cancellation and generation loss remain distinct rejection paths.
        assertPrepared();
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
      const result = await params.provider.evaluate(params.batch, providerContext);
      if (!assertPrepared()) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const status = result.status;
      if (status === "ok") {
        const value = result.result;
        if (!validateDecisionResultV2(offered, value, model.inference?.decision)) {
          return { status: "unavailable", reason: "invalid-response" };
        }
        assertPrepared();
        return { status, result: value };
      }
      if (status !== "unavailable") {
        throw new Error("Invalid decision provider outcome");
      }
      const { reason, retryAfterMs } = result;
      assertPrepared();
      return { status, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
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
