import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildGenericCliContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { AsyncWorkScope, captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../agent-project-settings.js";
import { OPENCLAW_AGENT_RUNTIME_ID, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  applyAgentAutoCompactionGuard,
  resolveEffectiveCompactionMode,
} from "../agent-settings.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import { clearCliSessionInStore } from "../cli-session-store.js";
import {
  isBenignCompactionSkipReason,
  isBenignCompactionSkipResult,
} from "../embedded-agent-runner/compact-reasons.js";
import type { QueuedCompactionHostOptions } from "../embedded-agent-runner/compact.types.js";
import { buildEmbeddedCompactionRuntimeContext } from "../embedded-agent-runner/compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "../embedded-agent-runner/compaction-safety-timeout.js";
import {
  acceptCompactionSuccessor,
  type AcceptedCompactionSuccessor,
} from "../embedded-agent-runner/compaction-successor.js";
import { runContextEngineMaintenance } from "../embedded-agent-runner/context-engine-maintenance.js";
import { shouldPreemptivelyCompactBeforePrompt } from "../embedded-agent-runner/run/preemptive-compaction.js";
import { resolveLiveToolResultMaxChars } from "../embedded-agent-runner/tool-result-truncation.js";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import { isRecoverableNativeHarnessBindingFailure } from "../harness/compaction-recovery.js";
import { maybeCompactAgentHarnessSession } from "../harness/compaction.js";
import { retainAgentHarnessCompactionSource } from "../harness/host-source-authority.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { acquireAgentRunPreparedModelRuntime } from "../prepared-model-runtime.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import { SessionManager } from "../sessions/session-manager.js";
import { recordCliCompactionInStore } from "./session-store.js";

type CliCompactionContext = {
  sessionAgentId: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  workspaceDir: string;
  cwd?: string;
  agentDir: string;
  /** Selected model provider (for example "anthropic"). */
  provider: string;
  model: string;
  /** CLI backend that ran the turn (for example "claude-cli"); owns native compaction policy. */
  cliBackendId?: string;
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  agentAccountId?: string;
  senderIsOwner?: boolean;
  thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  extraSystemPrompt?: string;
};

type CliCompactionRuntimeContextParams = CliCompactionContext & {
  authProfileId?: string;
  harnessRuntime?: string;
  modelSelectionLocked?: boolean;
  currentTokenCount: number;
  contextTokenBudget: number;
  trigger: string;
};

function buildCliCompactionParams(params: CliCompactionContext) {
  return {
    agentId: params.sessionAgentId,
    config: params.cfg,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    agentDir: params.agentDir,
    provider: params.provider,
    model: params.model,
    skillsSnapshot: params.skillsSnapshot,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
    senderIsOwner: params.senderIsOwner,
    thinkLevel: params.thinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
  };
}

function buildCliCompactionRuntimeContext(params: CliCompactionRuntimeContextParams) {
  return {
    ...buildEmbeddedCompactionRuntimeContext({
      ...buildCliCompactionParams(params),
      messageProvider: params.messageChannel,
      authProfileId: params.authProfileId,
      modelId: params.model,
      harnessRuntime: params.harnessRuntime,
      modelSelectionLocked: params.modelSelectionLocked,
    }),
    currentTokenCount: params.currentTokenCount,
    tokenBudget: params.contextTokenBudget,
    trigger: params.trigger,
  };
}

const CODEX_APP_SERVER_OWNS_AUTO_COMPACTION_REASON = "codex app-server owns automatic compaction";

type NativeHarnessCliCompactionOutcome = {
  compacted: boolean;
  result?: EmbeddedAgentCompactResult;
  fallbackToContextEngine?: boolean;
  clearCliSessionBinding?: boolean;
  failureReason?: string;
};
type CliTranscriptCompactionOutcome = {
  compacted: boolean;
  failureReason?: string;
  accepted?: AcceptedCompactionSuccessor;
  tokensAfter?: number;
};

const log = createSubsystemLogger("agents/cli-compaction");

function isNativeHarnessCompactionSession(
  sessionEntry: SessionEntry | undefined,
  provider: string,
): sessionEntry is SessionEntry {
  const harnessId = sessionEntry?.agentHarnessId?.trim().toLowerCase();
  if (!harnessId || normalizeOptionalAgentRuntimeId(harnessId) === OPENCLAW_AGENT_RUNTIME_ID) {
    return false;
  }
  const providerId = provider.trim().toLowerCase();
  return (
    harnessId === providerId ||
    (harnessId === "copilot" && providerId === "github-copilot") ||
    (harnessId === "codex" && (providerId === "codex" || providerId === "openai"))
  );
}

/** Runs pre-turn compaction for a CLI session and returns the updated session entry. */
export async function runCliTurnCompactionLifecycle(
  input: CliCompactionContext & {
    sessionId: string;
    sessionEntry: SessionEntry | undefined;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    pluginGeneration?: PreparedModelRuntimePluginGeneration;
    abortSignal?: AbortSignal;
  },
  host: QueuedCompactionHostOptions,
): Promise<SessionEntry | undefined> {
  const storePath = input.storePath;
  const contextTokenBudget = floorPositiveFiniteNumber(input.sessionEntry?.contextTokens);
  if (!storePath || !contextTokenBudget) {
    return input.sessionEntry;
  }

  return await runWithAsyncWorkResources(async (onAcquired) => {
    const sourceAuthority = host.sourceAuthority;
    const releaseSource = retainAgentHarnessCompactionSource(sourceAuthority);
    onAcquired({ release: releaseSource, releaseBeforeResultWhenIdle: true });
    const operatorAuthority = sourceAuthority.operatorAuthority;
    const assertSourceActive = sourceAuthority.assertActive;
    const sourceSignal = operatorAuthority?.signal;
    const abortSignal =
      input.abortSignal && sourceSignal
        ? AbortSignal.any([input.abortSignal, sourceSignal])
        : (input.abortSignal ?? sourceSignal);
    const params = { ...input, abortSignal };
    const assertActive = composeSessionSourceAssertion(
      [assertSourceActive, operatorAuthority?.assertCurrent, host.assertActive],
      (assertSources) => {
        params.abortSignal?.throwIfAborted();
        assertSources();
      },
    );
    assertActive();
    const capturedEntry = await readSessionEntryReadOnlyInWorker(
      {
        agentId: params.sessionAgentId,
        sessionKey: params.sessionKey,
        storePath,
        readConsistency: "latest",
      },
      assertActive,
    );
    const expectedEntry = {
      sessionId: params.sessionId,
      lifecycleRevision: capturedEntry?.lifecycleRevision,
      activeWriterRunId: capturedEntry?.activeWriterRunId,
    };
    const onCommitted = (accepted: AcceptedCompactionSuccessor) => {
      if (params.sessionStore) {
        params.sessionStore[params.sessionKey] = accepted.entry;
      }
      host.onCommitted?.(accepted);
    };
    const sessionManager = await SessionManager.openAsync({
      agentId: params.sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath,
    });
    assertActive();
    const sessionFile = params.sessionKey;
    const settingsManager = createPreparedEmbeddedAgentSettingsManager({
      sessionId: params.sessionId,
      cwd: params.cwd ?? params.workspaceDir,
      agentDir: params.agentDir,
      cfg: params.cfg,
      pluginMetadataSnapshot:
        params.pluginGeneration?.pluginMetadataSnapshot ??
        getCurrentPluginMetadataSnapshot({
          config: params.cfg,
          env: process.env,
          workspaceDir: params.workspaceDir,
        }),
      contextTokenBudget,
    });
    assertActive();

    const preemptiveCompaction = shouldPreemptivelyCompactBeforePrompt({
      messages: sessionManager.buildSessionContext().messages,
      prompt: "",
      contextTokenBudget,
      reserveTokens: settingsManager.getCompactionReserveTokens(),
      toolResultMaxChars: resolveLiveToolResultMaxChars({
        contextWindowTokens: contextTokenBudget,
      }),
    });
    const currentTokenCount = Math.max(
      preemptiveCompaction.estimatedPromptTokens,
      floorPositiveFiniteNumber(resolveFreshSessionTotalTokens(params.sessionEntry)) ?? 0,
    );
    if (
      !preemptiveCompaction.shouldCompact &&
      currentTokenCount <= preemptiveCompaction.promptBudgetBeforeReserve
    ) {
      return params.sessionEntry;
    }

    const cliBackendId = params.cliBackendId?.trim() || params.provider;
    const resolvedBackend = resolveCliBackendConfig(cliBackendId, params.cfg);
    const nativeSessionEntry = isNativeHarnessCompactionSession(
      params.sessionEntry,
      params.provider,
    )
      ? params.sessionEntry
      : undefined;
    const lockedHarnessRuntime = normalizeOptionalAgentRuntimeId(
      params.sessionEntry?.agentHarnessId,
    );
    if (
      params.sessionEntry?.modelSelectionLocked === true &&
      lockedHarnessRuntime !== OPENCLAW_AGENT_RUNTIME_ID &&
      !nativeSessionEntry
    ) {
      throw new Error("CLI compaction cannot replace a model-locked native harness runtime");
    }
    if (resolvedBackend?.ownsNativeCompaction && !nativeSessionEntry) {
      log.info(`CLI backend "${cliBackendId}" owns native compaction — deferring to backend`);
      return params.sessionEntry;
    }

    let compactionKind: EmbeddedAgentCompactResult["compactionKind"];
    let contextCompactionOutcome: CliTranscriptCompactionOutcome | undefined;
    let nativeOutcome: NativeHarnessCliCompactionOutcome | undefined;
    let resolvedContextEngine: ContextEngine | undefined;
    const authProfileId = params.sessionEntry?.authProfileOverride?.trim() || undefined;

    const work = new AsyncWorkScope();
    const trackCleanup = captureAsyncWorkTracker();
    let result: SessionEntry | undefined;
    let failure: { error: unknown } | undefined;
    try {
      result = await work.run(async () => {
        if (!nativeSessionEntry) {
          assertActive();
        }
        const contextEngine = await resolveContextEngine(params.cfg, {
          initialize: ensureContextEnginesInitialized,
        });
        resolvedContextEngine = contextEngine;
        applyAgentAutoCompactionGuard({
          settingsManager,
          contextEngineInfo: contextEngine.info,
          compactionMode: resolveEffectiveCompactionMode(params.cfg),
        });
        if (nativeSessionEntry) {
          const nativeEntry = nativeSessionEntry;
          const tokenBudget = contextTokenBudget;
          async function compactNativeHarnessCliTranscript(): Promise<NativeHarnessCliCompactionOutcome> {
            let nativeResult: EmbeddedAgentCompactResult | undefined;
            try {
              const nativeHarnessId = nativeEntry.agentHarnessId?.trim();
              const nativeModelSelectionLocked = nativeEntry.modelSelectionLocked === true;
              const nativeAuthProfileId = nativeEntry.authProfileOverride?.trim() || undefined;
              await using preparedRuntimeLease = await acquireAgentRunPreparedModelRuntime(
                {
                  config: params.cfg,
                  agentId: params.sessionAgentId,
                  agentDir: params.agentDir,
                  workspaceDir: params.workspaceDir,
                  allowGatewaySubagentBinding: true,
                  runtimePluginSelections: [
                    {
                      provider: params.provider,
                      modelId: params.model,
                      agentId: params.sessionAgentId,
                      ...(nativeHarnessId ? { runtime: nativeHarnessId } : {}),
                    },
                  ],
                },
                params.pluginGeneration ? { pluginGeneration: params.pluginGeneration } : {},
              );
              const preparedModelRuntime = preparedRuntimeLease.snapshot;
              nativeResult = await withPluginRuntimeGenerationScope(
                preparedModelRuntime,
                async () => {
                  await ensureSelectedAgentHarnessPlugin({
                    provider: params.provider,
                    modelId: params.model,
                    config: params.cfg,
                    sessionKey: params.sessionKey,
                    workspaceDir: params.workspaceDir,
                    agentId: params.sessionAgentId,
                    ...(nativeHarnessId ? { agentHarnessRuntimeOverride: nativeHarnessId } : {}),
                    pluginRegistry: preparedModelRuntime.pluginRegistry,
                  });
                  assertActive();
                  return await maybeCompactAgentHarnessSession(
                    {
                      ...buildCliCompactionParams(params),
                      sessionId: params.sessionId,
                      sessionFile,
                      authProfileId: nativeAuthProfileId,
                      contextTokenBudget: tokenBudget,
                      currentTokenCount,
                      trigger: "budget",
                      force: true,
                      modelSelectionLocked: nativeModelSelectionLocked,
                      allowGatewaySubagentBinding: true,
                      contextEngine,
                      contextEngineRuntimeContext: buildCliCompactionRuntimeContext({
                        ...params,
                        contextTokenBudget: tokenBudget,
                        currentTokenCount,
                        authProfileId: nativeAuthProfileId,
                        harnessRuntime: nativeHarnessId,
                        modelSelectionLocked: nativeModelSelectionLocked,
                        trigger: "cli_native_budget",
                      }),
                      ...(nativeHarnessId ? { agentHarnessId: nativeHarnessId } : {}),
                      abortSignal: params.abortSignal,
                    },
                    { preparedModelRuntime, sourceAuthority: { assertActive, operatorAuthority } },
                  );
                },
              );
            } catch (error) {
              const reason = coerceErrorMessage(error);
              log.warn(
                `CLI native harness compaction failed for ${params.provider}/${params.model}: ${reason}`,
              );
              return {
                compacted: false,
                failureReason: reason,
              };
            }

            if (!nativeResult?.ok || !nativeResult.compacted) {
              const reason = nativeResult?.reason;
              // Native automatic compaction must not fall back to a host model request.
              if (
                (nativeResult && isBenignCompactionSkipResult(nativeResult)) ||
                (nativeResult?.ok === true &&
                  nativeResult.reason === CODEX_APP_SERVER_OWNS_AUTO_COMPACTION_REASON)
              ) {
                log.info(
                  `CLI native harness compaction skipped for ${params.provider}/${params.model}: ${reason}`,
                );
                return { compacted: false };
              }
              const recoverableBindingFailure =
                isRecoverableNativeHarnessBindingFailure(nativeResult);
              const fallbackToContextEngine =
                nativeEntry.modelSelectionLocked !== true &&
                ((nativeResult?.ok === false &&
                  nativeResult.failure?.reason === "unsupported_harness_compaction") ||
                  recoverableBindingFailure);
              // Native harness binding failures can be repaired by clearing the stored CLI
              // session binding and falling back to the context engine for this turn.
              log.warn(
                `CLI native harness compaction did not reduce context for ${params.provider}/${params.model}: ${reason}`,
              );
              return {
                compacted: false,
                fallbackToContextEngine,
                clearCliSessionBinding:
                  nativeEntry.modelSelectionLocked !== true && recoverableBindingFailure,
                failureReason:
                  nativeResult?.reason ?? "native harness compaction did not reduce context",
              };
            }

            return { compacted: true, result: nativeResult };
          }
          nativeOutcome = await compactNativeHarnessCliTranscript();
          if (nativeOutcome.compacted) {
            compactionKind = "native-harness";
          } else if (!nativeOutcome.fallbackToContextEngine && nativeOutcome.failureReason) {
            throw new Error(
              `CLI native harness compaction failed for ${params.provider}/${params.model}: ${nativeOutcome.failureReason}`,
            );
          }
        }

        if (!nativeOutcome || nativeOutcome.fallbackToContextEngine) {
          assertActive();
          const tokenBudget = contextTokenBudget;
          const activeStorePath = storePath;
          const harnessRuntime = params.sessionEntry?.agentHarnessId;
          const modelSelectionLocked = params.sessionEntry?.modelSelectionLocked;
          const bestEffortMaintenance = nativeOutcome?.fallbackToContextEngine === true;
          async function compactCliTranscript(): Promise<CliTranscriptCompactionOutcome> {
            const runtimeContext = buildCliCompactionRuntimeContext({
              ...params,
              authProfileId,
              harnessRuntime,
              modelSelectionLocked,
              contextTokenBudget: tokenBudget,
              currentTokenCount,
              trigger: "cli_budget",
            });
            const runtimeSettings = buildContextEngineRuntimeSettings({
              contextEngineHost: buildGenericCliContextEngineHostSupport({
                backendId: params.provider,
                capabilities: ["compact", "maintain"],
              }),
              provider: params.provider,
              requestedModel: params.model,
              resolvedModel: params.model,
              selectedContextEngineId: contextEngine.info.id,
              contextEngineSelectionSource: "configured",
              promptTokenBudget: tokenBudget,
            });

            let compactResult: Awaited<ReturnType<typeof contextEngine.compact>>;
            assertActive();
            try {
              compactResult = await compactContextEngineWithSafetyTimeout(
                contextEngine,
                {
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  sessionTarget: {
                    agentId: params.sessionAgentId,
                    sessionId: params.sessionId,
                    sessionKey: params.sessionKey,
                    ...(activeStorePath ? { storePath: activeStorePath } : {}),
                  },
                  tokenBudget,
                  currentTokenCount,
                  force: true,
                  compactionTarget: "budget",
                  runtimeContext,
                  runtimeSettings,
                },
                resolveCompactionTimeoutMs(params.cfg),
                params.abortSignal,
              );
            } catch (error) {
              const reason = coerceErrorMessage(error);
              if (isBenignCompactionSkipReason(reason)) {
                log.info(
                  `CLI transcript compaction skipped for ${params.provider}/${params.model}: ${reason}`,
                );
                return { compacted: false };
              }
              log.warn(
                `CLI transcript compaction failed for ${params.provider}/${params.model}: ${reason}`,
              );
              return {
                compacted: false,
                failureReason: reason,
              };
            }

            if (!compactResult.ok || !compactResult.compacted) {
              const reason = compactResult.reason;
              if (isBenignCompactionSkipResult(compactResult)) {
                log.info(
                  `CLI transcript compaction skipped for ${params.provider}/${params.model}: ${reason}`,
                );
                return { compacted: false };
              }
              log.warn(
                `CLI transcript compaction did not reduce context for ${params.provider}/${params.model}: ${reason ?? "compaction did not reduce context"}`,
              );
              return {
                compacted: false,
                failureReason: compactResult.reason ?? "compaction did not reduce context",
              };
            }

            const compactedResult = compactResult.result;
            const successor = await acceptCompactionSuccessor({
              expectedEntry,
              assertActive,
              onCommitted,
              config: params.cfg,
              currentSessionFile: sessionFile,
              currentTarget: {
                agentId: params.sessionAgentId,
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                storePath: activeStorePath,
              },
              result: compactResult,
            });
            const outcome: CliTranscriptCompactionOutcome = {
              compacted: true,
              accepted: successor,
              ...(compactedResult?.tokensAfter !== undefined
                ? { tokensAfter: compactedResult.tokensAfter }
                : {}),
            };
            try {
              assertActive();
              await runContextEngineMaintenance({
                contextEngine,
                sessionId: successor.sessionId,
                sessionKey: params.sessionKey,
                sessionFile: successor.sessionFile,
                sessionTarget: successor.sessionTarget,
                reason: "compaction",
                ...(successor.previousSessionId ? {} : { sessionManager }),
                runtimeContext,
                runtimeSettings,
                config: params.cfg,
                assertActive,
              });
            } catch (error) {
              try {
                assertActive();
              } catch {
                return outcome;
              }
              if (!bestEffortMaintenance) {
                throw error;
              }
              log.warn(
                `CLI transcript compaction maintenance failed after fallback for ${params.provider}/${params.model}: ${coerceErrorMessage(error)}`,
              );
            }
            return outcome;
          }
          const contextOutcome = await compactCliTranscript();
          contextCompactionOutcome = contextOutcome;
          compactionKind = contextOutcome.compacted ? "context-engine" : undefined;
          if (!compactionKind && contextOutcome.failureReason) {
            throw new Error(
              `CLI transcript compaction failed for ${params.provider}/${params.model}: ${contextOutcome.failureReason}`,
            );
          }
        }

        if (nativeOutcome?.clearCliSessionBinding && !compactionKind && params.sessionStore) {
          assertActive();
          return (
            (await clearCliSessionInStore({
              agentId: params.sessionAgentId,
              provider: params.provider,
              sessionKey: params.sessionKey,
              sessionStore: params.sessionStore,
              storePath,
              expectedSessionId: params.sessionId,
              assertCommitAllowed: assertActive,
            })) ?? params.sessionEntry
          );
        }

        if (!compactionKind || !params.sessionStore) {
          return params.sessionEntry;
        }

        const recorded = await recordCliCompactionInStore({
          agentId: params.sessionAgentId,
          compactionKind,
          sessionKey: params.sessionKey,
          sessionStore: params.sessionStore,
          storePath,
          tokensAfter:
            nativeOutcome?.result?.result?.tokensAfter ?? contextCompactionOutcome?.tokensAfter,
          expectedSession: contextCompactionOutcome?.accepted?.entry ?? expectedEntry,
        });
        if (!recorded) {
          throw new Error("Session changed before CLI compaction could be recorded");
        }
        return recorded;
      });
    } catch (error) {
      failure = { error };
    }
    const cleanup = async () => {
      try {
        await AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => resolvedContextEngine?.dispose?.(),
        );
      } finally {
        await work.run(() => work.drain());
      }
    };
    if (work.hasPendingWork) {
      // A timeout can return before raw compaction settles. Its owner retains
      // the engine until that work finishes without extending the watchdog.
      void trackCleanup(cleanup).catch((error: unknown) => {
        log.warn(`CLI compaction engine cleanup failed: ${String(error)}`);
      });
    } else {
      try {
        await cleanup();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) {
      throw failure.error;
    }
    return result;
  });
}
