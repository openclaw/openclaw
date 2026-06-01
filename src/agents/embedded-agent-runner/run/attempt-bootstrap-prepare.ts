import { performance } from "node:perf_hooks";
import { isEmbeddedMode } from "../../../infra/embedded-mode.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
} from "../../bootstrap-budget.js";
import {
  buildBootstrapContextForFiles,
  hasCompletedBootstrapTurn,
  makeBootstrapWarn,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "../../bootstrap-files.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import {
  isPrimaryBootstrapRun,
  resolveWorkspaceBootstrapRouting,
} from "../../bootstrap-routing.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../../embedded-agent-helpers.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  isWorkspaceBootstrapPending,
  type WorkspaceBootstrapFile,
} from "../../workspace.js";
import { log } from "../logger.js";
import { remapInjectedContextFilesToWorkspace } from "./attempt.bootstrap-context.js";
import { resolveAttemptBootstrapContext } from "./attempt.context-engine-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export async function prepareEmbeddedAttemptBootstrap(params: {
  attempt: EmbeddedRunAttemptParams;
  effectiveWorkspace: string;
  hasReadTool: boolean;
  isRawModelRun: boolean;
  markStage: (name: string) => void;
  resolvedWorkspace: string;
  sessionAgentId: string;
  sessionLabel: string;
}) {
  const { attempt } = params;
  const suppressAmbientContext =
    params.isRawModelRun || attempt.operation === "settled-tool-finalization";
  const contextInjectionMode = resolveContextInjectionMode(attempt.config, params.sessionAgentId);
  const bootstrapWarn = makeBootstrapWarn({
    sessionLabel: params.sessionLabel,
    workspaceDir: params.resolvedWorkspace,
    warn: (message) => log.warn(message),
  });
  let completedBootstrapTurn: boolean | undefined;
  const hasCompletedBootstrapTurnForAttempt = async (sessionFile: string) => {
    completedBootstrapTurn ??= await hasCompletedBootstrapTurn(sessionFile);
    return completedBootstrapTurn;
  };
  // Bootstrap-context can stall the event loop; record per-substage timings so a
  // slow run reports where it spent time instead of a single opaque total.
  const bootstrapContextStartedAt = performance.now();
  const bootstrapContextSubstageTimings: Array<{ name: string; durationMs: number }> = [];
  const recordBootstrapContextSubstage = (name: string, durationMs: number) => {
    bootstrapContextSubstageTimings.push({
      name,
      durationMs: Math.max(0, durationMs),
    });
  };
  const resolveBootstrapRouting = (bootstrapFiles?: readonly WorkspaceBootstrapFile[]) => {
    const startedAt = performance.now();
    try {
      return resolveWorkspaceBootstrapRouting({
        isWorkspaceBootstrapPending,
        bootstrapFiles,
        bootstrapContextRunKind: attempt.bootstrapContextRunKind,
        trigger: attempt.trigger,
        sessionKey: attempt.sessionKey,
        isPrimaryRun: isPrimaryBootstrapRun(attempt.sessionKey),
        isCanonicalWorkspace: attempt.isCanonicalWorkspace,
        effectiveWorkspace: params.effectiveWorkspace,
        resolvedWorkspace: params.resolvedWorkspace,
        hasBootstrapFileAccess: params.hasReadTool,
      });
    } finally {
      recordBootstrapContextSubstage("bootstrap-routing", performance.now() - startedAt);
    }
  };
  const shouldProbeContinuation =
    !suppressAmbientContext &&
    contextInjectionMode === "continuation-skip" &&
    !isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind);
  const shouldProbeContinuationSkip = shouldProbeContinuation
    ? await (async () => {
        const startedAt = performance.now();
        try {
          return await hasCompletedBootstrapTurnForAttempt(attempt.sessionFile);
        } finally {
          recordBootstrapContextSubstage("continuation-scan", performance.now() - startedAt);
        }
      })()
    : false;
  let preloadedBootstrapFiles: WorkspaceBootstrapFile[] | undefined;
  let bootstrapRouting =
    shouldProbeContinuationSkip || suppressAmbientContext || contextInjectionMode === "never"
      ? await resolveBootstrapRouting()
      : undefined;
  if (
    !suppressAmbientContext &&
    contextInjectionMode !== "never" &&
    (bootstrapRouting === undefined || bootstrapRouting.bootstrapMode === "full")
  ) {
    preloadedBootstrapFiles = await resolveBootstrapFilesForRun({
      workspaceDir: params.resolvedWorkspace,
      config: attempt.config,
      sessionKey: attempt.sessionKey,
      sessionId: attempt.sessionId,
      agentId: params.sessionAgentId,
      warn: bootstrapWarn,
      contextMode: attempt.bootstrapContextMode,
      runKind: attempt.bootstrapContextRunKind,
      onBootstrapSubstageTiming: recordBootstrapContextSubstage,
    });
    bootstrapRouting = await resolveBootstrapRouting(preloadedBootstrapFiles);
  }
  bootstrapRouting ??= await resolveBootstrapRouting(preloadedBootstrapFiles);
  const bootstrapMode = bootstrapRouting.bootstrapMode;
  const {
    bootstrapFiles: hookAdjustedBootstrapFiles,
    contextFiles: resolvedContextFiles,
    shouldRecordCompletedBootstrapTurn,
  } = await resolveAttemptBootstrapContext({
    // Raw probes and isolated finalization must not load AGENTS/BOOTSTRAP
    // context even though finalization preserves the settled transcript.
    contextInjectionMode: suppressAmbientContext ? "never" : contextInjectionMode,
    bootstrapContextMode: attempt.bootstrapContextMode,
    bootstrapContextRunKind: attempt.bootstrapContextRunKind ?? "default",
    bootstrapMode,
    sessionFile: attempt.sessionFile,
    hasCompletedBootstrapTurn: hasCompletedBootstrapTurnForAttempt,
    resolveBootstrapContextForRun: async () => {
      const bootstrapFiles =
        preloadedBootstrapFiles ??
        (await resolveBootstrapFilesForRun({
          workspaceDir: params.resolvedWorkspace,
          config: attempt.config,
          sessionKey: attempt.sessionKey,
          sessionId: attempt.sessionId,
          agentId: params.sessionAgentId,
          warn: bootstrapWarn,
          contextMode: attempt.bootstrapContextMode,
          runKind: attempt.bootstrapContextRunKind,
          onBootstrapSubstageTiming: recordBootstrapContextSubstage,
        }));
      const contextBuildStartedAt = performance.now();
      const contextFiles = buildBootstrapContextForFiles(bootstrapFiles, {
        config: attempt.config,
        agentId: params.sessionAgentId,
        warn: bootstrapWarn,
      });
      recordBootstrapContextSubstage("context-build", performance.now() - contextBuildStartedAt);
      return {
        bootstrapFiles,
        contextFiles,
      };
    },
  });
  const bootstrapContextTotalMs = performance.now() - bootstrapContextStartedAt;
  if (bootstrapContextTotalMs > 2_000) {
    const substages =
      bootstrapContextSubstageTimings.length > 0
        ? bootstrapContextSubstageTimings
            .map((stage) => `${stage.name}:${stage.durationMs.toFixed(1)}ms`)
            .join(",")
        : "none";
    log.debug(
      `[trace:embedded-run] bootstrap-context substages: runId=${attempt.runId} sessionId=${attempt.sessionId} totalMs=${bootstrapContextTotalMs.toFixed(1)} substages=${substages}`,
    );
  }
  params.markStage("bootstrap-context");
  const remappedContextFiles = remapInjectedContextFilesToWorkspace({
    files: resolvedContextFiles,
    sourceWorkspaceDir: params.resolvedWorkspace,
    targetWorkspaceDir: params.effectiveWorkspace,
  });
  const contextFiles = bootstrapRouting.includeBootstrapInSystemContext
    ? remappedContextFiles
    : remappedContextFiles.filter((file) => !/(^|[\\/])BOOTSTRAP\.md$/iu.test(file.path.trim()));
  const bootstrapFilesForInjectionStats = bootstrapRouting.includeBootstrapInSystemContext
    ? hookAdjustedBootstrapFiles
    : hookAdjustedBootstrapFiles.filter((file) => file.name !== DEFAULT_BOOTSTRAP_FILENAME);
  const bootstrapMaxChars = resolveBootstrapMaxChars(attempt.config, params.sessionAgentId);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(
    attempt.config,
    params.sessionAgentId,
  );
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles: bootstrapFilesForInjectionStats,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(attempt.config);
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: attempt.bootstrapPromptWarningSignaturesSeen,
    previousSignature: attempt.bootstrapPromptWarningSignature,
  });
  const workspaceNotes: string[] = [];
  if (
    hookAdjustedBootstrapFiles.some(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
    )
  ) {
    workspaceNotes.push("Reminder: commit your changes in this workspace after edits.");
  }
  if (isEmbeddedMode()) {
    workspaceNotes.push(
      "Running in local embedded mode (no gateway). Most tools work locally. Gateway-dependent tools (canvas, nodes, cron, message, sessions_send, sessions_spawn, gateway) are unavailable. Subagent kill/steer require a gateway. Do not attempt to read gateway-specific files such as sessions.json, gateway.log, or gateway.pid.",
    );
  }

  return {
    bootstrapAnalysis,
    bootstrapMaxChars,
    bootstrapMode,
    bootstrapPromptWarning,
    bootstrapPromptWarningMode,
    bootstrapTotalMaxChars,
    contextFiles,
    hookAdjustedBootstrapFiles,
    shouldRecordCompletedBootstrapTurn,
    workspaceNotes,
  };
}
