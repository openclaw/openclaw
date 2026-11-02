import { randomUUID } from "node:crypto";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  buildReplyUsageState,
  recordReplyUsageState,
} from "../auto-reply/reply/reply-usage-state.js";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import type { Message, Model } from "../llm/types.js";
import {
  attachProviderAuthAuthority,
  getProviderAuthAuthority,
} from "../plugins/provider-auth-authority.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import {
  assertOperatorModelAllowed,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "./admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";
import {
  prepareBtwRuntimeAuth,
  prepareBtwHarnessToolPolicies,
  resolveBtwPreparedRuntimeAuth,
  resolveRuntimeModel,
  runCliBtwSideQuestion,
  toSimpleContextMessages,
  withBtwPreparedRuntime,
  type RunBtwSideQuestionParams,
} from "./btw-runtime.js";
import { runBtwSessionFork, runLightweightBtwStream } from "./btw-stream.js";
import { readBtwTranscriptMessages, resolveBtwSessionTranscriptPath } from "./btw-transcript.js";
import { getActiveEmbeddedRunSnapshot } from "./embedded-agent-runner/runs.js";
import { createAgentHarnessHostCapabilities } from "./harness/host-capability.js";
import { resolveAgentHarnessOwnerPluginId } from "./harness/registry.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import type { AgentHarnessPreparedModelProvider } from "./harness/selection-decision.js";
import {
  resolveAvailableAgentHarnessPolicy,
  selectAgentHarness,
  selectAgentHarnessForPreparedModelProviders,
} from "./harness/selection.js";
import {
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "./harness/support.js";
import type { AgentHarness } from "./harness/types.js";
import { resolveImageSanitizationLimits } from "./image-sanitization.js";
import { applySecretRefHeaderSentinels, requireApiKey } from "./model-auth.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";
import { preparedModelRuntimeConfigsMatch } from "./prepared-model-runtime.js";
import { applyPreparedRuntimeAuthToModel } from "./provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "./provider-runtime-auth-protection.js";
import { unwrapSecretSentinelsForProviderEgress } from "./provider-secret-egress.js";
import { scopeAuthProfileStoreToPreparedPlan } from "./runtime-plan/resolve-auth.js";
import { resolveSandboxContext } from "./sandbox/context.js";
import { resolveSessionModelRef } from "./session-model-ref.js";
import { prepareSessionPlacementSandbox } from "./session-placement-admission.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";
import { hasBillableUsage, toDiagnosticUsage, type NormalizedUsage } from "./usage.js";

/** Answers a side question using sanitized session context and no tool execution. */
export async function runBtwSideQuestion(
  paramsInput: RunBtwSideQuestionParams,
): Promise<ReplyPayload | undefined> {
  // Side execution closes independently from the main run. A dedicated ID
  // prevents caller correlation IDs from replacing the parent's live authority.
  let params = {
    ...paramsInput,
    sessionEntry: { ...paramsInput.sessionEntry },
    authorityRunId: paramsInput.authorityRunId ?? `btw-${randomUUID()}`,
  };
  if (params.sessionStore && params.sessionKey) {
    params.sessionStore[params.sessionKey] = params.sessionEntry;
  }
  const sessionId = params.sessionEntry.sessionId?.trim();
  if (!sessionId) {
    throw new Error("No active session context.");
  }

  const sessionFile = resolveBtwSessionTranscriptPath({
    sessionId,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  if (!sessionFile) {
    throw new Error("No active session transcript.");
  }

  const requestedWorkspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const runtimeInput = {
    config: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: requestedWorkspaceDir,
    // Gateway-published owners are keyed with this flag, so a gateway-hosted
    // request that omits it can never match one.
    ...(params.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true as const } : {}),
  };
  return await withBtwPreparedRuntime(runtimeInput, async (preparedModelRuntime) => {
    const sessionAgentId = preparedModelRuntime.agentId ?? params.agentId;
    const workspaceDir =
      preparedModelRuntime.workspaceDir ??
      resolveAgentWorkspaceDir(preparedModelRuntime.config, sessionAgentId);
    const preparedModelRef = preparedModelRuntimeConfigsMatch(
      preparedModelRuntime.config,
      params.cfg,
    )
      ? { provider: params.provider, model: params.model }
      : resolveSessionModelRef(preparedModelRuntime.config, params.sessionEntry, sessionAgentId);
    // BTW policy, model selection, directories, auth, and catalog must come from one generation.
    // A reload may have committed while the command waited for its transcript/session lookup.
    // Rebind every later policy/auth/dispatch read to the generation returned above.
    params = {
      ...params,
      cfg: preparedModelRuntime.config,
      agentDir: preparedModelRuntime.agentDir,
      provider: preparedModelRef.provider,
      model: preparedModelRef.model,
    };
    const preparedHarnesses = new Map<string, AgentHarness>();
    const prepareHarness = async (
      provider: string,
      modelId: string,
      modelProvider?: AgentHarnessPreparedModelProvider,
    ): Promise<AgentHarness> => {
      const agentHarnessId = isModelSelectionLocked(params.sessionEntry)
        ? params.sessionEntry.agentHarnessId
        : undefined;
      const agentHarnessRuntimeOverride = agentHarnessId
        ? undefined
        : resolveSessionRuntimeOverrideForProvider({
            provider,
            entry: params.sessionEntry,
            cfg: params.cfg,
          });
      const selectedHarnessId = agentHarnessId ?? agentHarnessRuntimeOverride ?? "configured";
      const key = [
        `${provider}/${modelId}/${selectedHarnessId}`,
        modelProvider?.api ?? "",
        modelProvider?.baseUrl ?? "",
        modelProvider?.requestTransportOverrides ?? "",
        modelProvider?.runtimePolicy?.compatibleIds.join(",") ?? "",
        modelProvider?.preparedAuth?.source ?? "",
        modelProvider?.preparedAuth?.mode ?? "",
        modelProvider?.preparedAuth?.requirement ?? "",
      ].join("\0");
      const cached = preparedHarnesses.get(key);
      if (cached) {
        return cached;
      }
      const selectionParams = {
        provider,
        modelId,
        config: params.cfg,
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        ...(agentHarnessId ? { agentHarnessId } : {}),
        ...(agentHarnessRuntimeOverride ? { agentHarnessRuntimeOverride } : {}),
      };
      await ensureSelectedAgentHarnessPlugin({
        ...selectionParams,
        workspaceDir,
        pluginRegistry: preparedModelRuntime.pluginRegistry!,
      });
      const harness = modelProvider
        ? selectAgentHarnessForPreparedModelProviders({
            ...selectionParams,
            modelProviders: [modelProvider],
          })
        : selectAgentHarness(selectionParams);
      preparedHarnesses.set(key, harness);
      return harness;
    };
    const harness = await prepareHarness(params.provider, params.model);
    let runtimeSelection: Awaited<ReturnType<typeof resolveRuntimeModel>> | undefined;
    const resolveRuntimeSelection = async () => {
      if (!runtimeSelection) {
        runtimeSelection = await resolveRuntimeModel({
          ...params,
          abortSignal: params.opts?.abortSignal,
          agentId: sessionAgentId,
          harnessId: harness.id,
          harnessAuthBootstrap: harness.authBootstrap,
          preparedModelRuntime,
        });
      }
      return runtimeSelection;
    };
    const recordBtwUsage = (runtimeModel: Model, usage?: NormalizedUsage) => {
      params.onUsage?.(usage);
      if (params.onUsage) {
        return;
      }
      if (!hasBillableUsage(usage)) {
        return;
      }
      const usageState = buildReplyUsageState({
        config: params.cfg,
        agentDir: params.agentDir,
        agentId: sessionAgentId,
        sessionId,
        provider: runtimeModel.provider,
        model: runtimeModel.id,
        chatType: params.chatType,
        usage,
      });
      // Delivery hooks use the reply correlation ID, not the side run's authority ID.
      recordReplyUsageState(params.opts?.runId, usageState);
      if (isDiagnosticsEnabled(params.cfg)) {
        emitTrustedDiagnosticEvent({
          type: "model.usage",
          sessionKey: params.sessionKey,
          sessionId,
          channel: params.messageChannel,
          agentId: sessionAgentId,
          provider: runtimeModel.provider,
          model: runtimeModel.id,
          usage: toDiagnosticUsage(usage),
          costUsd: usageState.turnUsd,
        });
      }
    };
    type BtwHarnessSideQuestionDispatch =
      | { kind: "handled"; payload: ReplyPayload }
      | {
          kind: "openclaw";
          harness: AgentHarness;
          runtime: Awaited<ReturnType<typeof resolveRuntimeModel>>;
          resolvedAttempt: Awaited<ReturnType<typeof resolveBtwPreparedRuntimeAuth>>;
        };
    let preparedOpenClawFallback:
      | Extract<BtwHarnessSideQuestionDispatch, { kind: "openclaw" }>
      | undefined;
    const runHarnessSideQuestion = async (
      selectedHarness: AgentHarness,
      runtime: Awaited<ReturnType<typeof resolveRuntimeModel>>,
      routeFinalized = false,
    ): Promise<BtwHarnessSideQuestionDispatch> => {
      const authPreparation =
        selectedHarness.id === harness.id
          ? undefined
          : await prepareBtwRuntimeAuth({
              cfg: params.cfg,
              model: runtime.model,
              agentId: sessionAgentId,
              agentDir: params.agentDir,
              workspaceDir,
              authProfileId: runtime.authProfileId,
              authProfileIdSource: runtime.authProfileIdSource,
              harnessId: selectedHarness.id,
              harnessAuthBootstrap: selectedHarness.authBootstrap,
            });
      const runtimeAuthPreparation = authPreparation?.preparation ?? runtime.runtimeAuthPreparation;
      const selectedAuthProfileStore = authPreparation?.store ?? runtime.authProfileStore;
      const nativeAuth = runtime.nativeOwnership?.auth === "native";
      const firstAuthAttempt = runtimeAuthPreparation.attempts[0];
      const implicitHarnessAuthPlan =
        runtimeAuthPreparation.attempts.length === 1 &&
        firstAuthAttempt?.kind === "implicit" &&
        (nativeAuth ||
          (selectedHarness.authBootstrap === "harness" &&
            firstAuthAttempt.plan.harnessAuthProvider))
          ? firstAuthAttempt.plan
          : undefined;
      // Native authentication is already owned by the binding, not a host credential route.
      const resolvedAttempt = implicitHarnessAuthPlan
        ? { plan: implicitHarnessAuthPlan, model: runtime.model }
        : await resolveBtwPreparedRuntimeAuth({
            abortSignal: params.opts?.abortSignal,
            preparation: runtimeAuthPreparation,
            model: runtime.model,
            provider: runtime.model.provider,
            modelId: runtime.model.id,
            preparedModelRuntime,
            authStorage: runtime.authStorage,
            modelRegistry: runtime.modelRegistry,
            authProfileStore: selectedAuthProfileStore,
          });
      const runtimeAuthPlan = resolvedAttempt.plan;
      const runtimeModel = attachProviderAuthAuthority(
        resolvedAttempt.model,
        getProviderAuthAuthority("auth" in resolvedAttempt ? resolvedAttempt.auth : undefined),
      );
      const finalizedHarness = nativeAuth
        ? selectedHarness
        : await prepareHarness(runtimeModel.provider, runtimeModel.id, {
            api: runtimeModel.api,
            baseUrl: runtimeModel.baseUrl,
            ...resolveAgentHarnessPreparedRouteSupport(runtimeAuthPlan),
            preparedAuth: resolveAgentHarnessPreparedAuthSupport({ plan: runtimeAuthPlan }),
          });
      if (finalizedHarness.id !== selectedHarness.id) {
        if (routeFinalized) {
          throw new Error("Agent harness selection changed after route materialization.");
        }
        return runHarnessSideQuestion(
          finalizedHarness,
          {
            ...runtime,
            model: runtimeModel,
            runtimeAuthPreparation,
            authProfileStore: selectedAuthProfileStore,
          },
          true,
        );
      }
      if (!selectedHarness.runSideQuestion) {
        if (selectedHarness.id !== "openclaw" || !("auth" in resolvedAttempt)) {
          throw new Error(
            `Selected agent harness "${selectedHarness.id}" does not support /btw side questions.`,
          );
        }
        return {
          kind: "openclaw",
          harness: selectedHarness,
          runtime: {
            ...runtime,
            model: runtimeModel,
            authProfileId: runtimeAuthPlan.forwardedAuthProfileId,
            authProfileIdSource: runtimeAuthPlan.forwardedAuthProfileSource,
            authProfileStore: selectedAuthProfileStore,
            runtimeAuthPreparation,
          },
          resolvedAttempt,
        };
      }
      const resolvedApiKey =
        runtimeAuthPlan.modelRoute?.authRequirement === "api-key" && "auth" in resolvedAttempt
          ? resolvedAttempt.auth.apiKey?.trim()
          : undefined;
      const sideRunId = params.authorityRunId;
      using placement = await prepareSessionPlacementSandbox({
        agentId: sessionAgentId,
        config: params.cfg,
        sessionId,
        sessionKey: params.sessionKey,
        workspaceDir,
      });
      placement.assertCurrent();
      const sandbox =
        placement.sandbox ??
        (await resolveSandboxContext({
          config: params.cfg,
          // An independent policy key keeps its own owner; global execution retains its prepared one.
          agentId:
            !params.sandboxSessionKey || params.sandboxSessionKey === params.sessionKey
              ? sessionAgentId
              : undefined,
          sessionKey: params.sandboxSessionKey ?? params.sessionKey ?? sessionId,
          workspaceDir,
        }));
      using sandboxLifetime = {
        [Symbol.dispose]: () => {
          if (!placement.sandbox) {
            sandbox?.[Symbol.dispose]?.();
          }
        },
      };
      void sandboxLifetime;
      const { toolsAllow, webSearchPolicy } = await prepareBtwHarnessToolPolicies({
        ...params,
        agentId: sessionAgentId,
        sessionId,
        runtimeModel,
        nativeOwnership: runtime.nativeOwnership,
        sandbox,
      });
      const preparedRunAdmission = prepareSystemAgentRunAdmission(
        params.cfg,
        sideRunId,
        sessionAgentId,
        "btw.side-question",
        params.assertCurrent,
        params.operatorAuthority,
      );
      const admittedRunContext = await preparedRunAdmission.admit("plugin-harness");
      try {
        const { model: _sideModel, authorityRunId: _authorityRunId, ...hostAttempt } = params;
        const host = createAgentHarnessHostCapabilities({
          attempt: {
            ...hostAttempt,
            admittedRunContext,
            config: params.cfg,
            agentId: sessionAgentId,
            sessionId,
            sessionKey: params.sessionKey,
            sandbox,
            workspaceDir,
            runId: sideRunId,
            currentMessagingTarget: params.messageTo,
            currentThreadTs:
              params.messageThreadId === undefined ? undefined : String(params.messageThreadId),
          },
          pluginId: resolveAgentHarnessOwnerPluginId(selectedHarness),
          nativeModelPolicySupport: selectedHarness.nativeModelPolicySupport,
          toolCalls: params.toolCalls,
        });
        const sideParams = {
          ...hostAttempt,
          hostCapabilities: host.capabilities,
          sandbox,
          provider: runtimeModel.provider,
          model: runtimeModel.id,
          runtimeModel,
          preparedModelRuntime,
          expectedSessionRuntimeOwnership: runtime.nativeOwnership,
          preparedWebSearchPolicy: webSearchPolicy,
          preparedRuntimeAuth: {
            plan: runtimeAuthPlan,
            authProfileStore: scopeAuthProfileStoreToPreparedPlan(
              selectedAuthProfileStore,
              runtimeAuthPlan,
            ),
            authStorage: runtime.authStorage,
            modelRegistry: runtime.modelRegistry,
            ...(resolvedApiKey
              ? {
                  resolvedApiKey: unwrapSecretSentinelsForProviderEgress(
                    resolvedApiKey,
                    "BTW harness handoff",
                  ),
                }
              : {}),
          },
          sessionId,
          sessionFile,
          agentId: sessionAgentId,
          workspaceDir,
          ...(toolsAllow ? { toolsAllow } : {}),
          authProfileId:
            runtimeAuthPlan.modelRoute?.authRequirement === "api-key"
              ? undefined
              : runtimeAuthPlan.forwardedAuthProfileId,
          opts: { ...params.opts, runId: sideRunId },
          authProfileIdSource:
            runtimeAuthPlan.modelRoute?.authRequirement === "api-key"
              ? undefined
              : runtimeAuthPlan.forwardedAuthProfileSource,
        };
        let result: Awaited<ReturnType<NonNullable<AgentHarness["runSideQuestion"]>>>;
        try {
          placement.assertCurrent();
          params.assertCurrent?.();
          assertOperatorModelAllowed(params.operatorAuthority, {
            provider: runtimeModel.provider,
            model: runtimeModel.id,
          });
          getProviderAuthAuthority(runtimeModel)?.();
          result = await selectedHarness.runSideQuestion(sideParams);
        } finally {
          host.close();
        }
        recordBtwUsage(runtimeModel, result.usage);
        return { kind: "handled", payload: { text: result.text } };
      } finally {
        preparedRunAdmission.close();
      }
    };
    if (harness.runSideQuestion) {
      const dispatch = await runHarnessSideQuestion(harness, await resolveRuntimeSelection());
      if (dispatch.kind === "handled") {
        return dispatch.payload;
      }
      preparedOpenClawFallback = dispatch;
    }
    if (harness.id === "codex" && !harness.runSideQuestion) {
      throw new Error(
        `Selected agent harness "${harness.id}" does not support /btw side questions.`,
      );
    }

    const sessionFork = harness.id === "openclaw" && params.toolCalls === "deny";
    const activeRunSnapshot = getActiveEmbeddedRunSnapshot(sessionFile);
    const imageLimits = resolveImageSanitizationLimits(params.cfg);
    let messages: Message[] = [];
    const inFlightPrompt = activeRunSnapshot?.inFlightPrompt;
    if (!sessionFork) {
      if (activeRunSnapshot?.messages?.length) {
        messages = await toSimpleContextMessages({
          messages: activeRunSnapshot.messages,
          imageLimits,
        });
      }
      if (messages.length === 0) {
        messages = await toSimpleContextMessages({
          messages: await readBtwTranscriptMessages({
            agentId: sessionAgentId,
            sessionFile,
            sessionId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
            snapshotLeafId: activeRunSnapshot?.transcriptLeafId,
          }),
          imageLimits,
        });
      }
    }
    params.opts?.abortSignal?.throwIfAborted();
    if (!sessionFork && messages.length === 0 && !inFlightPrompt?.trim()) {
      throw new Error("No active session context.");
    }

    const fallbackPolicy = resolveAvailableAgentHarnessPolicy({
      provider: params.provider,
      modelId: params.model,
      config: params.cfg,
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
    });
    const fallbackRuntime = fallbackPolicy.runtime.trim();
    const sessionAuthProfileId = params.sessionEntry.authProfileOverride?.trim() || undefined;
    const sessionAuthProfileSource = sessionAuthProfileId
      ? resolveCollapsedSessionAuthPinSource(params.sessionEntry)
      : undefined;
    const cliSelection = {
      provider: params.provider,
      cfg: params.cfg,
      agentId: sessionAgentId,
      modelId: params.model,
    };
    const cliProviderFromSessionAuth = sessionAuthProfileId
      ? resolveCliRuntimeExecutionProvider({
          ...cliSelection,
          authProfileId: sessionAuthProfileId,
        })?.trim()
      : undefined;
    const cliProviderFromAuthOrder =
      !sessionAuthProfileId || sessionAuthProfileSource === "auto"
        ? resolveCliRuntimeExecutionProvider(cliSelection)?.trim()
        : undefined;
    const resolvedCliProvider = cliProviderFromSessionAuth ?? cliProviderFromAuthOrder;
    const cliProvider =
      resolvedCliProvider ??
      (isCliRuntimeAliasForProvider({
        runtime: fallbackRuntime,
        provider: params.provider,
        cfg: params.cfg,
      })
        ? fallbackRuntime
        : undefined);
    if (cliProvider) {
      if (params.toolCalls === "deny") {
        throw new Error(`Session forks are not supported for CLI runtime ${cliProvider}.`);
      }
      return runCliBtwSideQuestion({
        cfg: params.cfg,
        onUsage: params.onUsage,
        model: params.model,
        question: params.question,
        imageCount: params.images?.length ?? 0,
        sessionId,
        sessionFile,
        sessionEntry: params.sessionEntry,
        sessionKey: params.sessionKey,
        sessionAgentId,
        workspaceDir,
        cliProvider,
        authProfileId: cliProviderFromSessionAuth ? sessionAuthProfileId : undefined,
        resolvedThinkLevel: params.resolvedThinkLevel,
        messages,
        inFlightPrompt,
        opts: params.opts,
        authorityRunId: params.authorityRunId,
        messageChannel: params.messageChannel,
        messageProvider: params.messageProvider,
        currentChannelId: params.currentChannelId,
      });
    }

    const initialOpenClawFallback = preparedOpenClawFallback;
    const runtimeSelectionForHarness =
      initialOpenClawFallback?.runtime ?? (await resolveRuntimeSelection());
    // Model resolution can canonicalize a legacy provider alias, so reselect against the resolved
    // provider/model instead of reusing the raw route's selection.
    const runtimeHarness =
      initialOpenClawFallback?.harness ??
      (await prepareHarness(
        runtimeSelectionForHarness.model.provider,
        runtimeSelectionForHarness.model.id,
      ));
    if (runtimeHarness.runSideQuestion) {
      const dispatch = await runHarnessSideQuestion(runtimeHarness, runtimeSelectionForHarness);
      if (dispatch.kind === "handled") {
        return dispatch.payload;
      }
      preparedOpenClawFallback = dispatch;
    }
    if (runtimeHarness.id === "codex" && !runtimeHarness.runSideQuestion) {
      throw new Error(
        `Selected agent harness "${runtimeHarness.id}" does not support /btw side questions.`,
      );
    }

    const finalizedOpenClawFallback = preparedOpenClawFallback;
    const effectiveRuntimeSelection =
      finalizedOpenClawFallback?.runtime ?? runtimeSelectionForHarness;
    const { authStorage, model, modelRegistry, authProfileStore, runtimeAuthPreparation } =
      effectiveRuntimeSelection;
    const resolvedAttempt =
      finalizedOpenClawFallback?.resolvedAttempt ??
      (await resolveBtwPreparedRuntimeAuth({
        abortSignal: params.opts?.abortSignal,
        preparation: runtimeAuthPreparation,
        model,
        provider: model.provider,
        modelId: model.id,
        preparedModelRuntime,
        authStorage,
        modelRegistry,
        authProfileStore,
      }));
    const apiKeyInfo = resolvedAttempt.auth;
    params.assertCurrent?.();
    assertOperatorModelAllowed(params.operatorAuthority, {
      provider: resolvedAttempt.model.provider,
      model: resolvedAttempt.model.id,
    });
    const resolvedAuthProfileId = resolvedAttempt.plan.forwardedAuthProfileId;
    let runtimeModel = attachProviderAuthAuthority(
      resolvedAttempt.model,
      getProviderAuthAuthority(apiKeyInfo),
    );
    let apiKey =
      apiKeyInfo.mode === "aws-sdk" && !apiKeyInfo.apiKey
        ? undefined
        : requireApiKey(apiKeyInfo, runtimeModel.provider);
    if (apiKey) {
      const preparedAuth = protectPreparedProviderRuntimeAuth({
        provider: runtimeModel.provider,
        preparedAuth: await prepareProviderRuntimeAuth({
          provider: runtimeModel.provider,
          config: params.cfg,
          workspaceDir,
          env: process.env,
          context: {
            config: params.cfg,
            agentDir: params.agentDir,
            workspaceDir,
            env: process.env,
            provider: runtimeModel.provider,
            modelId: runtimeModel.id,
            model: runtimeModel,
            apiKey,
            authMode: apiKeyInfo.mode,
            profileId: resolvedAuthProfileId,
          },
        }),
      });
      runtimeModel = applyPreparedRuntimeAuthToModel(runtimeModel, preparedAuth);
      if (preparedAuth?.apiKey) {
        apiKey = preparedAuth.apiKey;
      }
    }
    runtimeModel = applySecretRefHeaderSentinels(runtimeModel, params.cfg);
    if (params.toolCalls === "deny") {
      const admission = prepareSystemAgentRunAdmission(
        params.cfg,
        params.authorityRunId,
        sessionAgentId,
        "btw.session-fork",
        params.assertCurrent,
        params.operatorAuthority,
      );
      try {
        const admitted = await admission.admit("plugin-harness");
        const assertCurrent = resolveAdmittedRunActiveAssertion(admitted, params.opts?.abortSignal);
        if (!assertCurrent) {
          throw new Error("Session fork admission is no longer active.");
        }
        assertCurrent();
        const text = await runBtwSessionFork({
          params: { ...params, agentId: sessionAgentId },
          modelRegistry,
          runtimeModel,
          auth: { mode: apiKeyInfo.mode, authFlow: apiKeyInfo.authFlow },
          apiKey,
          resolvedAuthProfileId,
          sessionId,
          sessionFile,
          workspaceDir,
          assertCurrent,
        });
        assertCurrent();
        return { text };
      } finally {
        admission.close();
      }
    }
    return runLightweightBtwStream({
      params,
      modelRegistry,
      runtimeModel,
      auth: { mode: apiKeyInfo.mode, authFlow: apiKeyInfo.authFlow },
      apiKey,
      resolvedAuthProfileId,
      sessionId,
      workspaceDir,
      imageLimits,
      messages,
      inFlightPrompt,
      recordBtwUsage,
    });
  });
}
