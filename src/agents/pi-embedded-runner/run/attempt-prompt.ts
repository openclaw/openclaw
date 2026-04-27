import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { isAcpSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
} from "../../bootstrap-budget.js";
import {
  hasCompletedBootstrapTurn,
  isWorkspaceBootstrapPending,
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveContextInjectionMode,
} from "../../bootstrap-files.js";
import type { EmbeddedContextFile } from "../../pi-embedded-helpers.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../../pi-embedded-helpers.js";
import { stripToolResultDetails } from "../../session-transcript-repair.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../../workspace.js";
import { normalizeAssistantReplayContent } from "../replay-history.js";
import { resolveAttemptWorkspaceBootstrapRouting } from "./attempt-bootstrap-routing.js";
import { resolveAttemptBootstrapContext } from "./attempt.context-engine-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function isPrimaryBootstrapRun(sessionKey?: string): boolean {
  return !isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey);
}

export function remapInjectedContextFilesToWorkspace(params: {
  files: EmbeddedContextFile[];
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile[] {
  if (params.sourceWorkspaceDir === params.targetWorkspaceDir) {
    return params.files;
  }
  return params.files.map((file) => {
    const relative = path.relative(params.sourceWorkspaceDir, file.path);
    const canRemap = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    return canRemap
      ? {
          ...file,
          path:
            relative === ""
              ? params.targetWorkspaceDir
              : path.join(params.targetWorkspaceDir, relative),
        }
      : file;
  });
}

export function normalizeMessagesForLlmBoundary(messages: AgentMessage[]): AgentMessage[] {
  return stripToolResultDetails(normalizeAssistantReplayContent(messages));
}

export async function prepareAttemptBootstrapPromptContext(params: {
  attempt: EmbeddedRunAttemptParams;
  sessionLabel: string;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  toolsEnabled: boolean;
  toolsRaw: Array<{ name?: string }>;
  logWarn: (message: string) => void;
}) {
  const contextInjectionMode = resolveContextInjectionMode(params.attempt.config);
  const bootstrapHasFileAccess =
    params.toolsEnabled && params.toolsRaw.some((tool) => tool.name === "read");
  const bootstrapRouting = await resolveAttemptWorkspaceBootstrapRouting({
    isWorkspaceBootstrapPending,
    bootstrapContextRunKind: params.attempt.bootstrapContextRunKind,
    trigger: params.attempt.trigger,
    sessionKey: params.attempt.sessionKey,
    isPrimaryRun: isPrimaryBootstrapRun(params.attempt.sessionKey),
    isCanonicalWorkspace: params.attempt.isCanonicalWorkspace,
    effectiveWorkspace: params.effectiveWorkspace,
    resolvedWorkspace: params.resolvedWorkspace,
    hasBootstrapFileAccess: bootstrapHasFileAccess,
  });
  const bootstrapMode = bootstrapRouting.bootstrapMode;
  const shouldStripBootstrapFromContext = bootstrapRouting.shouldStripBootstrapFromContext;
  const {
    bootstrapFiles: hookAdjustedBootstrapFiles,
    contextFiles: resolvedContextFiles,
    shouldRecordCompletedBootstrapTurn,
  } = await resolveAttemptBootstrapContext({
    contextInjectionMode,
    bootstrapContextMode: params.attempt.bootstrapContextMode,
    bootstrapContextRunKind: params.attempt.bootstrapContextRunKind ?? "default",
    bootstrapMode,
    sessionFile: params.attempt.sessionFile,
    hasCompletedBootstrapTurn,
    resolveBootstrapContextForRun: async () =>
      await resolveBootstrapContextForRun({
        workspaceDir: params.resolvedWorkspace,
        config: params.attempt.config,
        sessionKey: params.attempt.sessionKey,
        sessionId: params.attempt.sessionId,
        warn: makeBootstrapWarn({
          sessionLabel: params.sessionLabel,
          workspaceDir: params.resolvedWorkspace,
          warn: params.logWarn,
        }),
        contextMode: params.attempt.bootstrapContextMode,
        runKind: params.attempt.bootstrapContextRunKind,
      }),
  });
  const remappedContextFiles = remapInjectedContextFilesToWorkspace({
    files: resolvedContextFiles,
    sourceWorkspaceDir: params.resolvedWorkspace,
    targetWorkspaceDir: params.effectiveWorkspace,
  });
  const contextFiles = shouldStripBootstrapFromContext
    ? remappedContextFiles.filter((file) => !/(^|[\\/])BOOTSTRAP\.md$/iu.test(file.path.trim()))
    : remappedContextFiles;
  const bootstrapFilesForInjectionStats = shouldStripBootstrapFromContext
    ? hookAdjustedBootstrapFiles.filter((file) => file.name !== DEFAULT_BOOTSTRAP_FILENAME)
    : hookAdjustedBootstrapFiles;
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.attempt.config);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.attempt.config);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles: bootstrapFilesForInjectionStats,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(
    params.attempt.config,
  );
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: params.attempt.bootstrapPromptWarningSignaturesSeen,
    previousSignature: params.attempt.bootstrapPromptWarningSignature,
  });
  const workspaceNotes: string[] = [];
  if (
    hookAdjustedBootstrapFiles.some(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
    )
  ) {
    workspaceNotes.push("Reminder: commit your changes in this workspace after edits.");
  }

  return {
    hookAdjustedBootstrapFiles,
    contextFiles,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    bootstrapAnalysis,
    bootstrapPromptWarningMode,
    bootstrapPromptWarning,
    workspaceNotes,
    shouldRecordCompletedBootstrapTurn,
    userPromptPrefixText: bootstrapRouting.userPromptPrefixText,
  };
}
