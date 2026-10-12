import { randomUUID } from "node:crypto";
import path from "node:path";
import { adjustMaxTokensForThinking } from "@openclaw/ai/internal/shared";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import type { ThinkLevel } from "../auto-reply/thinking.js";
/**
 * Fresh, prompt-only inference through the selected runtime.
 *
 * This operation deliberately bypasses the ordinary agent attempt, retry,
 * transcript, hook, and delivery lifecycle. Execution owners either prove a
 * literal empty native tool surface or fail before inference starts, except
 * Agents API: its restricted sessions may retain service-owned helpers.
 */
import { requiredWorkerHelperError } from "../config/required-worker-profile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { Model } from "../llm/types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { estimateAggregateUsageCost } from "../utils/usage-format.js";
import {
  assertOperatorModelAllowed,
  prepareSystemAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import { reconcileAuthProfileQuotaBlocks } from "./auth-profiles/usage.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { normalizeCliModel } from "./cli-runner/helpers.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import type {
  AgentHarness,
  AgentHarnessIsolatedCompletionAuthorization,
  AgentHarnessIsolatedCompletionParamsV2,
  AgentHarnessIsolatedCompletionResult,
} from "./harness/types.js";
import { createIsolatedCompletionModelAuthority } from "./isolated-completion-model-authority.js";
import {
  hasCliSideEffectEvidence,
  IsolatedCompletionError,
  isRetryableIsolatedQuotaFailure,
  requireIsolatedAssistantText,
} from "./isolated-completion-output.js";
import {
  resolveIsolatedCompletionAuthorizationOwner,
  selectIsolatedHarnessAuthAttempt,
  resolveIsolatedCompletionProvider,
  resolveIsolatedCompletionRoute,
} from "./isolated-completion-route.js";
import { ensureAuthProfileStoreAsync } from "./model-auth.js";
import {
  createModelCatalogSnapshotView,
  listModelCatalogObservedRoutes,
} from "./model-catalog-view.js";
import type { ModelRef } from "./model-ref-shared.js";
import { readAdmittedPublishedModelCatalog } from "./prepared-model-runtime.capture.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
} from "./prepared-model-runtime.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import type { IsolatedCompletionPurpose } from "./run-trigger.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import {
  canRunPreparedAgentRuntimeAuthAttempt,
  prepareAgentRuntimeAuth,
  preparedAgentRuntimeProfileAttemptHasCandidate,
  type PreparedAgentRuntimeAuthAttempt,
} from "./runtime-plan/prepare-auth.js";
import { scopeAuthProfileStoreToPreparedPlan } from "./runtime-plan/resolve-auth.js";
import { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";
import {
  hasObservedModelUsage,
  normalizeUsage,
  toDiagnosticUsage,
  type UsageLike,
} from "./usage.js";

type RunIsolatedCompletionParams = {
  purpose?: IsolatedCompletionPurpose;
  config?: OpenClawConfig;
  provider: string;
  model: string;
  /** Explicit credential owner. CLI and harness paths must not replace it with another profile. */
  authProfileId?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  /** Concrete owner already resolved by the caller, when available. */
  agentHarnessRuntimeOverride?: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  /** Private credential directories must remain outside the configured Gateway owner. */
  preparedModelRuntimeMode?: "isolated-read-only";
  /** Duration of dispatch through the selected runtime, excluding model/auth preparation. */
  onRequestComplete?: (durationMs: number) => void;
  /** Revalidate the caller's authority before credential handoff and dispatch. */
  assertCurrent?: () => void;
  /** Explicit requester restriction; automatic metadata callers remain system-owned. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Adapt host authorization failures to the calling completion API's error contract. */
  mapOperatorAuthorizationError?: (error: unknown) => Error;
  thinkLevel?: ThinkLevel;
  outputTextPolicy?: AgentHarnessIsolatedCompletionParamsV2["outputTextPolicy"];
  /** Internal answer budget; reasoning reserves still obey model and explicit stream limits. */
  answerTokenBudget?: number;
  streamParams?: AgentHarnessIsolatedCompletionParamsV2["streamParams"];
};

export type IsolatedCompletionResult = {
  text: string;
  provider: string;
  model: string;
  owner: { kind: "cli" | "harness"; id: string };
  /** CLI runtimes may not report token usage; absence must not be projected as zero. */
  usage?: UsageLike;
  /** Terminal cumulative CLI turn usage; diagnostics prefer it over `usage`. */
  diagnosticUsage?: UsageLike;
};

type AgentHarnessIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarness["runIsolatedCompletion"]>
>[0];

function resolveIsolatedStreamParams(
  { answerTokenBudget, streamParams }: RunIsolatedCompletionParams,
  model?: Model,
): RunIsolatedCompletionParams["streamParams"] {
  let maxTokens = answerTokenBudget ?? streamParams?.maxTokens;
  if (maxTokens === undefined) {
    return streamParams;
  }
  const modelMaxTokens = model?.maxTokens ?? Number.POSITIVE_INFINITY;
  if (answerTokenBudget !== undefined && model?.reasoning) {
    maxTokens = adjustMaxTokensForThinking(answerTokenBudget, modelMaxTokens, "medium").maxTokens;
  }
  return {
    ...streamParams,
    maxTokens: Math.min(maxTokens, modelMaxTokens, streamParams?.maxTokens ?? maxTokens),
  };
}

async function runCliIsolatedCompletion(
  request: RunIsolatedCompletionParams & {
    config: OpenClawConfig;
    agentId: string;
    agentDir: string;
    workspaceDir: string;
  },
  provider: string,
  modelProvider: string,
): Promise<IsolatedCompletionResult> {
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-isolated-completion-" },
    async ({ dir }) => {
      const { runCliAgent } = await import("./cli-runner.runtime.js");
      request.assertCurrent?.();
      const { cliBackendAcceptsAuthProfileForwarding, resolveCliExecutionAuthProfileId } =
        await import("./cli-execution-auth.js");
      request.assertCurrent?.();
      // Fresh completions use the same account order as new CLI sessions.
      const authProfileId = cliBackendAcceptsAuthProfileForwarding({
        provider,
        config: request.config,
        agentId: request.agentId,
      })
        ? resolveCliExecutionAuthProfileId({
            cliExecutionProvider: provider,
            authProfileProvider: modelProvider,
            config: request.config,
            agentDir: request.agentDir,
            selected: { authProfileId: request.authProfileId },
          })
        : request.authProfileId;
      request.assertCurrent?.();
      const sessionId = `isolated-completion-${randomUUID()}`;
      const config = request.config;
      const preparedRunAdmission = prepareSystemAgentRunAdmission(
        config,
        sessionId,
        request.agentId,
        "isolated-completion",
        request.assertCurrent,
        request.operatorAuthority,
      );
      try {
        request.assertCurrent?.();
        const result = await runCliAgent({
          preparedRunAdmission,
          sessionId,
          sessionFile: path.join(dir, "session.json"),
          workspaceDir: request.workspaceDir,
          cwd: dir,
          agentDir: request.agentDir,
          agentId: request.agentId,
          config,
          prompt: request.prompt,
          extraSystemPrompt: request.systemPrompt,
          timeoutMs: request.timeoutMs,
          runId: sessionId,
          provider,
          modelProvider,
          requesterModel: { provider: modelProvider, model: request.model },
          model: request.model,
          authProfileId,
          thinkLevel: request.thinkLevel,
          streamParams: resolveIsolatedStreamParams(request),
          abortSignal: request.abortSignal,
          assertCurrent: request.assertCurrent,
          mapOperatorAuthorizationError: request.mapOperatorAuthorizationError,
          executionMode: "side-question",
          cliToolAvailability: { native: [], openClaw: [] },
          disableTools: true,
          disableCliLiveSession: true,
          cleanupCliLiveSessionOnRunEnd: true,
          cleanupBundleMcpOnRunEnd: true,
          requireExplicitMessageTarget: true,
          isolatedCompletion: true,
          isolatedCompletionPurpose: request.purpose ?? "isolated-completion",
          outputTextPolicy: request.outputTextPolicy,
          onRequestComplete: request.onRequestComplete,
        });
        if (hasCliSideEffectEvidence(result)) {
          throw new IsolatedCompletionError(
            "output-rejected",
            "Isolated CLI completion returned side-effect evidence; result rejected.",
          );
        }
        const payloads = result.payloads ?? [];
        if (
          payloads.some(
            (payload) =>
              payload.isError ||
              payload.mediaUrl ||
              payload.mediaUrls?.length ||
              payload.audioAsVoice ||
              payload.channelData,
          )
        ) {
          throw new IsolatedCompletionError(
            "output-rejected",
            "Isolated CLI completion returned non-text output; result rejected.",
          );
        }
        const text = payloads
          .filter((payload) => !payload.isReasoning && typeof payload.text === "string")
          .map((payload) => payload.text ?? "")
          .join("\n")
          .trim();
        const backend = resolveCliBackendConfig(provider, request.config, {
          agentId: request.agentId,
        });
        if (!backend) {
          throw new IsolatedCompletionError(
            "runtime-unavailable",
            `CLI backend ${provider} became unavailable after execution.`,
          );
        }
        const { usage, diagnosticUsage } = result.meta?.agentMeta ?? {};
        return {
          text,
          provider: modelProvider,
          model: normalizeCliModel(request.model, backend.config),
          owner: { kind: "cli", id: provider },
          ...(usage ? { usage } : {}),
          ...(diagnosticUsage ? { diagnosticUsage } : {}),
        };
      } finally {
        preparedRunAdmission.close();
      }
    },
  );
}

function prepareIsolatedHostAuthorization<
  T extends Pick<AgentHarnessIsolatedCompletionParams, "model" | "auth">,
>(harness: AgentHarness, authorization: T): T {
  if (harness.id === "openclaw") {
    return authorization;
  }
  // External harnesses are the provider egress boundary. Keep credentials
  // sentinelized until this owner is selected, then hand it usable values.
  const boundary = "plugin harness isolated completion handoff";
  const apiKey = authorization.auth.apiKey
    ? unwrapSecretSentinelsForProviderEgress(authorization.auth.apiKey, boundary)
    : authorization.auth.apiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(authorization.model, boundary);
  if (apiKey === authorization.auth.apiKey && model === authorization.model) {
    return authorization;
  }
  return {
    ...authorization,
    model,
    auth: { ...authorization.auth, apiKey },
  };
}

/** Plugin completions finalize usage with host-plugin attribution; core callers have no other path. */
function emitIsolatedCompletionUsage(params: {
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  purpose?: IsolatedCompletionPurpose;
  result: IsolatedCompletionResult;
}): void {
  const { config, result } = params;
  if (params.purpose === "plugin-completion" || !isDiagnosticsEnabled(config)) {
    return;
  }
  const usage = normalizeUsage(result.diagnosticUsage ?? result.usage);
  if (!hasObservedModelUsage(usage)) {
    return;
  }
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    agentId: params.agentId,
    provider: result.provider,
    model: result.model,
    usage: toDiagnosticUsage(usage),
    costUsd: estimateAggregateUsageCost({
      usage,
      provider: result.provider,
      model: result.model,
      config,
      agentDir: params.agentDir,
    }),
  });
}

/** Run one fresh completion with the selected runtime's documented isolation boundary. */
export async function runIsolatedCompletion(
  params: RunIsolatedCompletionParams,
): Promise<IsolatedCompletionResult> {
  return await runWithAsyncWorkResources((onAcquired, captureWorkContext) =>
    runIsolatedCompletionOwned(params, onAcquired, captureWorkContext),
  );
}

async function runIsolatedCompletionOwned(
  params: RunIsolatedCompletionParams,
  onAcquired: (resources: { release: () => Promise<void> }) => void,
  captureWorkContext: () => void,
): Promise<IsolatedCompletionResult> {
  // Snapshot caller choices and validators before admission yields; callbacks expire on close.
  const input = {
    ...params,
    streamParams: params.streamParams && { ...params.streamParams },
  };
  const requestConfig = input.config ?? {};
  const agentId = input.agentId ?? resolveDefaultAgentId(requestConfig);
  const requestAgentDir = input.agentDir ?? resolveAgentDir(requestConfig, agentId);
  const requestedWorkspaceDir =
    input.workspaceDir ?? resolveAgentWorkspaceDir(requestConfig, agentId);
  const { provider, runtimeOverride } = resolveIsolatedCompletionProvider({
    provider: input.provider,
    config: requestConfig,
    agentHarnessRuntimeOverride: input.agentHarnessRuntimeOverride,
  });
  let closed = false;
  let modelForAuthorization: ModelRef | undefined = { provider, model: input.model };
  const assertCurrent = () => {
    if (closed) {
      throw new IsolatedCompletionError("runtime-unavailable", "Isolated completion has ended.");
    }
    input.assertCurrent?.();
    try {
      assertOperatorModelAllowed(input.operatorAuthority, modelForAuthorization);
    } catch (error) {
      throw input.mapOperatorAuthorizationError?.(error) ?? error;
    }
    input.abortSignal?.throwIfAborted();
  };
  const resolveAuthorizedModel: typeof resolveModelAsync = async (...args) => {
    const resolved = await resolveModelAsync(...args);
    if (resolved.model) {
      modelForAuthorization = resolved.logicalRef;
      assertCurrent();
    }
    return resolved;
  };
  assertCurrent();
  const isolatedReadOnly = input.preparedModelRuntimeMode === "isolated-read-only";
  const acquireRuntime = isolatedReadOnly
    ? acquireReadOnlyPreparedModelRuntime
    : acquireAgentRunPreparedModelRuntime;
  const lease = await acquireRuntime(
    {
      config: requestConfig,
      agentId,
      agentDir: requestAgentDir,
      workspaceDir: requestedWorkspaceDir,
      preserveWorkspaceDirOnRefresh: input.workspaceDir !== undefined,
      runtimePluginPurpose: "isolated-completion",
      ...(isolatedReadOnly ? { loadRuntimePlugins: true } : {}),
    },
    {
      catalogMode: "static",
      abortSignal: input.abortSignal,
      deriveRuntimePluginSelections: () => [
        {
          provider,
          modelId: input.model,
          ...(runtimeOverride ? { runtime: runtimeOverride } : {}),
          agentId,
        },
      ],
    },
  );
  const modelAuthority = createIsolatedCompletionModelAuthority({
    operatorAuthority: input.operatorAuthority,
    mapOperatorAuthorizationError: input.mapOperatorAuthorizationError,
    abortSignal: input.abortSignal,
    assertCurrent,
    runtime: lease,
  });
  onAcquired({ release: () => modelAuthority.release() });
  try {
    assertCurrent();
    const run = async (): Promise<IsolatedCompletionResult> => {
      captureWorkContext();
      // A new admission owns config and directories; the caller keeps its explicit route and profile.
      const context = {
        config: lease.snapshot.config,
        agentId,
        agentDir: lease.snapshot.agentDir,
        workspaceDir: lease.snapshot.workspaceDir ?? requestedWorkspaceDir,
      };
      const { config, agentDir, workspaceDir } = context;
      const blocked = requiredWorkerHelperError(config);
      if (blocked) {
        throw new IsolatedCompletionError("unsupported", blocked.error);
      }
      const request = { ...input, ...context, assertCurrent };
      await ensureSelectedAgentHarnessPlugin({
        provider,
        modelId: request.model,
        ...context,
        agentHarnessRuntimeOverride: runtimeOverride,
        pluginRegistry: lease.snapshot.pluginRegistry,
      });
      assertCurrent();
      const { selection, cliOwner } = await resolveIsolatedCompletionRoute({
        provider,
        model: request.model,
        authProfileId: request.authProfileId,
        runtimeOverride,
        explicitRuntimeOverride: request.agentHarnessRuntimeOverride,
        ...context,
      });
      if (cliOwner) {
        return await runCliIsolatedCompletion(request, cliOwner, provider);
      }

      // Retain the validated plugin instance; load the built-in runner only when selected.
      const harness = selection.builtIn
        ? (await import("./harness/builtin-openclaw.js")).createOpenClawAgentHarness()
        : selection.harness;
      assertCurrent();
      if (!harness.runIsolatedCompletionV2 && !harness.runIsolatedCompletion) {
        throw new IsolatedCompletionError(
          "unsupported",
          `Agent harness ${harness.id} does not support isolated completion.`,
        );
      }
      const commonParams = {
        provider,
        modelId: request.model,
        ...context,
        systemPrompt: request.systemPrompt,
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
        abortSignal: request.abortSignal,
        assertCurrent,
        thinkLevel: request.thinkLevel,
        outputTextPolicy: request.outputTextPolicy,
        onRequestComplete: request.onRequestComplete,
      };
      const prepareHostAuthorization = async (
        authProfileId: string | undefined,
      ): Promise<Extract<AgentHarnessIsolatedCompletionAuthorization, { owner: "host" }>> => {
        const prepared = await prepareSimpleCompletionModel(
          {
            cfg: config,
            agentId,
            provider,
            modelId: request.model,
            agentDir,
            profileId: authProfileId,
            allowMissingApiKeyModes: ["aws-sdk"],
            allowBundledStaticCatalogFallback: true,
            skipAgentDiscovery: true,
            bindAuthOwner: true,
            workspaceDir,
            preparedModelRuntime: lease.snapshot,
            signal: request.abortSignal,
            modelResolver: resolveAuthorizedModel,
          },
          assertCurrent,
        );
        assertCurrent();
        if ("error" in prepared) {
          throw new Error(`Isolated completion preparation failed: ${prepared.error}`);
        }
        return { owner: "host", ...prepared };
      };
      let result: AgentHarnessIsolatedCompletionResult | undefined;
      const runIsolatedCompletionV2 = harness.runIsolatedCompletionV2;
      if (runIsolatedCompletionV2) {
        let harnessAuth:
          | {
              model: Model;
              store: Awaited<ReturnType<typeof ensureAuthProfileStoreAsync>>;
              attempts: readonly PreparedAgentRuntimeAuthAttempt[];
            }
          | undefined;
        if (harness.authBootstrap === "harness") {
          const resolution = await resolveAuthorizedModel(
            provider,
            request.model,
            agentDir,
            config,
            {
              abortSignal: request.abortSignal,
              assertCurrent,
              ...lease.snapshot.createStores(),
              preparedModelRuntime: lease.snapshot,
              workspaceDir,
              authProfileId: request.authProfileId,
              skipAgentDiscovery: true,
              allowBundledStaticCatalogFallback: true,
              preferBundledStaticCatalogTransport: true,
            },
          );
          if (!resolution.model) {
            throw new IsolatedCompletionError(
              "runtime-unavailable",
              resolution.error ?? `Unknown isolated completion model ${provider}/${request.model}.`,
            );
          }
          const runtimeModel = resolution.model;
          assertCurrent();
          const authProfileStore = await ensureAuthProfileStoreAsync(agentDir, {
            profileId: request.authProfileId,
            readOnly: true,
            allowKeychainPrompt: false,
            config,
          });
          const catalog =
            readAdmittedPublishedModelCatalog(lease.snapshot) ?? lease.snapshot.modelCatalog;
          const variants =
            catalog &&
            createModelCatalogSnapshotView(config, catalog).variantsOf({
              provider: runtimeModel.provider,
              id: runtimeModel.id,
            });
          const authParams = {
            provider: runtimeModel.provider,
            modelId: runtimeModel.id,
            ...(variants
              ? { observedRoutes: listModelCatalogObservedRoutes(variants) }
              : { modelApi: runtimeModel.api, modelBaseUrl: runtimeModel.baseUrl }),
            ...context,
            env: process.env,
            authProfileStore,
            sessionAuthProfileId: request.authProfileId,
            sessionAuthProfileSource: request.authProfileId ? "user" : undefined,
            ...(request.authProfileId ? { allowAuthProfileFallback: false } : {}),
            harnessId: harness.id,
            harnessRuntime: harness.id,
            harnessAuthBootstrap: harness.authBootstrap,
          } satisfies Parameters<typeof prepareAgentRuntimeAuth>[0];
          await reconcileAuthProfileQuotaBlocks(authParams);
          assertCurrent();
          const authAttempts = prepareAgentRuntimeAuth(authParams).attempts;
          harnessAuth = { model: runtimeModel, store: authProfileStore, attempts: authAttempts };
        }
        const hasAuthCandidate = (attempt: PreparedAgentRuntimeAuthAttempt | undefined) =>
          attempt?.kind !== "profile" ||
          !harnessAuth ||
          preparedAgentRuntimeProfileAttemptHasCandidate({
            attempt,
            store: harnessAuth.store,
            modelId: harnessAuth.model.id,
          });
        // Profile rotation shares one inference budget instead of restarting it per account.
        let deadline: number | undefined;
        const remainingTimeoutMs = () => {
          const remaining = deadline === undefined ? request.timeoutMs : deadline - Date.now();
          if (remaining <= 0) {
            throw new IsolatedCompletionError(
              "runtime-unavailable",
              "Isolated completion timed out.",
            );
          }
          return remaining;
        };
        let firstError: unknown;
        let priorProfileAttempted = false;
        for (const preparedAttempt of harnessAuth?.attempts ?? [undefined]) {
          assertCurrent();
          remainingTimeoutMs();
          const attempt = preparedAttempt && selectIsolatedHarnessAuthAttempt(preparedAttempt);
          if (
            attempt &&
            !canRunPreparedAgentRuntimeAuthAttempt({ attempt, priorProfileAttempted })
          ) {
            firstError ??= new Error("Prepared direct auth requires a prior profile attempt.");
            continue;
          }
          if (!hasAuthCandidate(attempt)) {
            firstError ??= new Error(
              "Prepared runtime auth candidates are temporarily unavailable.",
            );
            continue;
          }
          try {
            let authorization: AgentHarnessIsolatedCompletionAuthorization;
            let completionModel: Model | undefined;
            if (
              attempt &&
              harnessAuth &&
              resolveIsolatedCompletionAuthorizationOwner(attempt.plan) === "harness"
            ) {
              const plan = attempt.plan;
              // Auth owns the resolved model tuple; a manifest alias remains only
              // on the caller's dispatch envelope, not on the materialization target.
              const { model: runtimeModel, store: authProfileStore } = harnessAuth;
              completionModel = await materializePreparedRuntimeModel({
                plan,
                provider: runtimeModel.provider,
                modelId: runtimeModel.id,
                model: runtimeModel,
                config,
                workspaceDir,
                metadataSnapshot: lease.snapshot.metadataSnapshot,
                resolveModel: ({ config: modelConfig, authProfileId, authProfileMode }) =>
                  resolveAuthorizedModel(
                    runtimeModel.provider,
                    runtimeModel.id,
                    agentDir,
                    modelConfig,
                    {
                      abortSignal: request.abortSignal,
                      assertCurrent,
                      modelIdSource: "selected",
                      preparedModelRuntime: lease.snapshot,
                      workspaceDir,
                      authProfileId,
                      authProfileMode,
                      skipAgentDiscovery: true,
                      allowBundledStaticCatalogFallback: true,
                    },
                  ),
              });
              assertCurrent();
              authorization = {
                owner: "harness",
                plan,
                authProfileStore: scopeAuthProfileStoreToPreparedPlan(authProfileStore, plan),
              };
            } else {
              authorization = await prepareHostAuthorization(
                attempt?.kind === "profile" ? attempt.profileId : request.authProfileId,
              );
              completionModel = authorization.model;
            }
            if (!hasAuthCandidate(attempt)) {
              throw new Error("Prepared runtime auth candidates are temporarily unavailable.");
            }
            assertCurrent();
            deadline ??= Date.now() + request.timeoutMs;
            const execution = modelAuthority.bind(modelForAuthorization);
            const pending = runIsolatedCompletionV2.call(harness, {
              ...commonParams,
              ...execution,
              timeoutMs: remainingTimeoutMs(),
              authorization:
                authorization.owner === "host"
                  ? prepareIsolatedHostAuthorization(harness, authorization)
                  : authorization,
              streamParams: resolveIsolatedStreamParams(request, completionModel),
            });
            priorProfileAttempted ||= attempt?.kind === "profile";
            const candidate = await pending;
            execution.assertCurrent?.();
            assertCurrent();
            if (isRetryableIsolatedQuotaFailure(candidate.assistant)) {
              // Returned quota failures must enter the same core-owned profile loop as throws.
              // Terminal errors and tool-bearing output never authorize another attempt.
              requireIsolatedAssistantText(candidate.assistant);
            }
            result = candidate;
            break;
          } catch (error) {
            // A retired caller cannot authorize another credential attempt.
            assertCurrent();
            firstError ??= error;
          }
        }
        if (!result) {
          throw firstError instanceof Error
            ? firstError
            : new Error("No prepared auth attempt succeeded.", { cause: firstError });
        }
      } else {
        const authorization = await prepareHostAuthorization(request.authProfileId);
        const harnessParams: AgentHarnessIsolatedCompletionParams = {
          ...commonParams,
          streamParams: resolveIsolatedStreamParams(request, authorization.model),
          model: authorization.model,
          auth: authorization.auth,
          sourceAuthFingerprint: authorization.sourceAuthFingerprint,
        };
        assertCurrent();
        const execution = modelAuthority.bind(modelForAuthorization);
        result = await harness.runIsolatedCompletion!(
          prepareIsolatedHostAuthorization(harness, { ...harnessParams, ...execution }),
        );
        execution.assertCurrent?.();
      }
      return {
        text: requireIsolatedAssistantText(result.assistant),
        provider: result.assistant.provider,
        model: result.assistant.model,
        owner: { kind: "harness", id: harness.id },
        usage: result.assistant.usage,
      };
    };
    const result = await withPluginRuntimeGenerationScope(lease.snapshot, run);
    assertCurrent();
    if (!result.text && input.outputTextPolicy !== "strict-visible") {
      throw new IsolatedCompletionError(
        "output-rejected",
        "Isolated completion returned empty output.",
      );
    }
    emitIsolatedCompletionUsage({
      config: lease.snapshot.config,
      agentId,
      agentDir: lease.snapshot.agentDir,
      purpose: input.purpose,
      result,
    });
    return result;
  } finally {
    closed = true;
  }
}
