import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
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
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { Model } from "../llm/types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";
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
  AgentHarnessIsolatedCompletionAuthorization,
  AgentHarnessIsolatedCompletionParamsV2,
  AgentHarnessIsolatedCompletionResult,
} from "./harness/types.js";
import {
  createIsolatedCompletionDiagnostics,
  emitIsolatedCompletionUsage,
  type IsolatedCompletionDiagnostics,
} from "./isolated-completion-diagnostics.js";
import {
  createIsolatedCompletionModelAuthority,
  prepareIsolatedHostAuthorization,
  resolveIsolatedStreamParams,
  type AgentHarnessIsolatedCompletionParams,
} from "./isolated-completion-model-authority.js";
import {
  hasCliSideEffectEvidence,
  IsolatedCompletionError,
  isRetryableIsolatedQuotaFailure,
  requireIsolatedAssistantText,
  type IsolatedCompletionResult,
} from "./isolated-completion-output.js";
import type { IsolatedCompletionPurpose } from "./isolated-completion-purpose.js";
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
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import {
  canRunPreparedAgentRuntimeAuthAttempt,
  prepareAgentRuntimeAuth,
  preparedAgentRuntimeProfileAttemptHasCandidate,
  type PreparedAgentRuntimeAuthAttempt,
} from "./runtime-plan/prepare-auth.js";
import { scopeAuthProfileStoreToPreparedPlan } from "./runtime-plan/resolve-auth.js";
import { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";
export type { IsolatedCompletionResult } from "./isolated-completion-output.js";

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
  /** Adapt the owner's deadline reason to the caller's error contract. */
  timeoutError?: Error;
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

/** Run one fresh completion with the selected runtime's documented isolation boundary. */
export async function runIsolatedCompletion(
  params: RunIsolatedCompletionParams,
): Promise<IsolatedCompletionResult> {
  const deadline = performance.now() + params.timeoutMs;
  const diagnostics = createIsolatedCompletionDiagnostics(params);
  const abortSignal = params.abortSignal;
  const timeout = new AbortController();
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout.signal]) : timeout.signal;
  const expire = () =>
    timeout.abort(
      params.timeoutError ??
        new IsolatedCompletionError("runtime-unavailable", "Isolated completion timed out."),
    );
  const remainingTimeoutMs = () => {
    const remaining = deadline - performance.now();
    // Check the clock at ownership boundaries even when the timer is starved.
    if (remaining <= 0 && !signal.aborted) {
      expire();
    }
    signal.throwIfAborted();
    // Runtime timeout APIs require integers; the shared signal keeps the exact cutoff.
    return Math.ceil(remaining);
  };
  const cancelDeadline = scheduleAbsoluteDeadline(deadline, expire, () => performance.now());
  return await runWithAsyncWorkResources(async (onAcquired, captureWorkContext) => {
    let release: (() => Promise<void>) | undefined;
    // Register before acquisition: failed preparation can still own an async cleanup tail.
    onAcquired({
      release: async () => {
        let settlementOutcome: "completed" | "error" = "error";
        try {
          await release?.();
          settlementOutcome = "completed";
        } finally {
          diagnostics?.settle(settlementOutcome);
        }
      },
    });
    try {
      const result = await racePromiseWithAbortSignal(
        // Timeout ends observation, not ownership of preparation or runtime cleanup.
        () =>
          trackAsyncWork(() =>
            runIsolatedCompletionOwned(
              { ...params, abortSignal: signal },
              (resources) => {
                release = resources.release;
              },
              captureWorkContext,
              diagnostics,
              remainingTimeoutMs,
            ),
          ),
        signal,
        (aborted) => aborted.reason,
      );
      remainingTimeoutMs();
      diagnostics?.complete("completed");
      return result;
    } catch (error) {
      diagnostics?.complete(abortSignal?.aborted ? "aborted" : "error");
      throw error;
    }
  }).finally(cancelDeadline);
}

async function runIsolatedCompletionOwned(
  params: RunIsolatedCompletionParams,
  onAcquired: (resources: { release: () => Promise<void> }) => void,
  captureWorkContext: () => void,
  diagnostics: IsolatedCompletionDiagnostics,
  remainingTimeoutMs: () => number,
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
    remainingTimeoutMs();
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
  diagnostics?.setConfig(lease.snapshot.config);
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
              provider: cliOwner,
              config: request.config,
              agentId: request.agentId,
            })
              ? await resolveCliExecutionAuthProfileId({
                  cliExecutionProvider: cliOwner,
                  model: request.model,
                  authProfileProvider: provider,
                  config: request.config,
                  agentDir: request.agentDir,
                  selected: { authProfileId: request.authProfileId },
                })
              : request.authProfileId;
            request.assertCurrent?.();
            const sessionId = `isolated-completion-${randomUUID()}`;
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
              const dispatch = () =>
                runCliAgent({
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
                  timeoutMs: remainingTimeoutMs(),
                  runId: sessionId,
                  provider: cliOwner,
                  modelProvider: provider,
                  requesterModel: { provider, model: request.model },
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
                });
              const result = await (diagnostics
                ? diagnostics.dispatch("cli", dispatch)
                : dispatch());
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
                .filter((payload) => !payload.isReasoning && payload.text !== undefined)
                .map((payload) => payload.text ?? "")
                .join("\n")
                .trim();
              const backend = resolveCliBackendConfig(cliOwner, request.config, {
                agentId: request.agentId,
              });
              if (!backend) {
                throw new IsolatedCompletionError(
                  "runtime-unavailable",
                  `CLI backend ${cliOwner} became unavailable after execution.`,
                );
              }
              const { usage, diagnosticUsage } = result.meta?.agentMeta ?? {};
              return {
                text,
                provider,
                model: normalizeCliModel(request.model, backend.config),
                owner: { kind: "cli", id: cliOwner },
                ...(usage ? { usage } : {}),
                ...(diagnosticUsage ? { diagnosticUsage } : {}),
              };
            } finally {
              preparedRunAdmission.close();
            }
          },
        );
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
      if (harness.runIsolatedCompletionV2) {
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
        let firstError: unknown;
        let priorProfileAttempted = false;
        for (const preparedAttempt of harnessAuth?.attempts ?? [undefined]) {
          assertCurrent();
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
            const execution = modelAuthority.bind(modelForAuthorization);
            const dispatch = () =>
              harness.runIsolatedCompletionV2!({
                ...commonParams,
                ...execution,
                timeoutMs: remainingTimeoutMs(),
                authorization:
                  authorization.owner === "host"
                    ? prepareIsolatedHostAuthorization(harness, authorization)
                    : authorization,
                streamParams: resolveIsolatedStreamParams(request, completionModel),
              });
            const pending = diagnostics ? diagnostics.dispatch("harness", dispatch) : dispatch();
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
        const harnessParams: Omit<AgentHarnessIsolatedCompletionParams, "timeoutMs"> = {
          ...commonParams,
          streamParams: resolveIsolatedStreamParams(request, authorization.model),
          model: authorization.model,
          auth: authorization.auth,
          sourceAuthFingerprint: authorization.sourceAuthFingerprint,
        };
        assertCurrent();
        const execution = modelAuthority.bind(modelForAuthorization);
        const dispatch = () =>
          harness.runIsolatedCompletion!(
            prepareIsolatedHostAuthorization(harness, {
              ...harnessParams,
              ...execution,
              timeoutMs: remainingTimeoutMs(),
            }),
          );
        result = await (diagnostics ? diagnostics.dispatch("harness", dispatch) : dispatch());
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
    return await withPluginRuntimeGenerationScope(lease.snapshot, async () => {
      const result = await run();
      assertCurrent();
      if (!result.text && input.outputTextPolicy !== "strict-visible") {
        throw new IsolatedCompletionError(
          "output-rejected",
          "Isolated completion returned empty output.",
        );
      }
      // Usage pricing must share the completion's prepared metadata instead of rediscovering it.
      emitIsolatedCompletionUsage({
        config: lease.snapshot.config,
        agentId,
        agentDir: lease.snapshot.agentDir,
        purpose: input.purpose,
        result,
      });
      return result;
    });
  } finally {
    closed = true;
  }
}
