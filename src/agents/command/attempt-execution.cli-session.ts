import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  NATIVE_HISTORY_AUTHORIZATION_DENIED,
  isNativeHistoryAuthorizationDenied,
} from "../../config/sessions/session-history-types.js";
import type { CliSessionBinding, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { isClaudeCliProvider } from "../cli-output-records.js";
import { resolveAuthorizedClaudeCliBinding } from "../cli-runner/child-env.js";
import { hasCliLiveSession } from "../cli-runner/cli-live-session-registry.js";
import { clearCliSessionInStore } from "../cli-session-store.js";
import {
  buildClaudeCliFallbackContextPrelude,
  claudeCliSessionTranscriptHasContent,
  rebaseExecApprovalContinuationPromptRange,
  resolveFallbackRetryPrompt,
} from "./attempt-execution.helpers.js";
import type { AgentAttemptParams } from "./attempt-execution.types.js";

type MutableCliSessionStore = Pick<
  Parameters<typeof clearCliSessionInStore>[0],
  | "agentId"
  | "sessionKey"
  | "sessionStore"
  | "storePath"
  | "expectedSessionId"
  | "assertCommitAllowed"
>;

export async function prepareCliSessionBinding(params: {
  provider: string;
  sessionEntry: SessionEntry | undefined;
  config: OpenClawConfig;
  agentId: string;
  skillsSnapshot?: Parameters<typeof resolveAuthorizedClaudeCliBinding>[0]["skillsSnapshot"];
  cwd: string;
  cliSessionBinding?: CliSessionBinding;
  sessionId: string;
  sessionKey?: string;
  mutableCliSessionStore?: MutableCliSessionStore;
  warn: (message: string) => void;
}): Promise<SessionEntry | undefined> {
  if (params.sessionEntry?.execHost === "node") {
    return params.sessionEntry;
  }
  const authorizedBinding = isClaudeCliProvider(params.provider)
    ? resolveAuthorizedClaudeCliBinding({
        entry: params.sessionEntry,
        config: params.config,
        agentId: params.agentId,
        skillsSnapshot: params.skillsSnapshot,
        cwd: params.cwd,
      })
    : undefined;
  const hasManagedClaudeLiveSession = Boolean(
    isClaudeCliProvider(params.provider) &&
    params.cliSessionBinding?.sessionId &&
    hasCliLiveSession({
      backendId: params.provider,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    }),
  );
  if (
    !isClaudeCliProvider(params.provider) ||
    !params.cliSessionBinding?.sessionId ||
    (authorizedBinding &&
      (hasManagedClaudeLiveSession ||
        (await claudeCliSessionTranscriptHasContent({
          sessionId: authorizedBinding.sessionId,
          workspaceDir: params.cwd,
          projectsRoot: authorizedBinding.transcriptRoot,
        }))))
  ) {
    return params.sessionEntry;
  }

  params.warn(
    `cli session reset: provider=${sanitizeForLog(params.provider)} reason=transcript-missing sessionKey=${params.sessionKey ?? params.sessionId}`,
  );
  if (params.mutableCliSessionStore) {
    return (
      (await clearCliSessionInStore({
        provider: params.provider,
        ...params.mutableCliSessionStore,
      })) ?? params.sessionEntry
    );
  }
  return params.sessionEntry;
}

/**
 * Prompts for the attempt's runner handoff. Prior-context history from a retained Claude
 * transcript is read once; the returned reader drops it again if the current selection no
 * longer authorizes that transcript. Runners await again after the handoff and do not recheck.
 */
export async function prepareFallbackPrompts(params: {
  /** Live attempt params: the session entry is re-read on every authorization check. */
  run: AgentAttemptParams;
  isRawModelRun: boolean;
  childCwd: string;
}) {
  const { run, isRawModelRun, childCwd } = params;
  const seedsClaudeCliFallback =
    !isRawModelRun &&
    run.isFallbackRetry &&
    isClaudeCliProvider(run.originalProvider) &&
    !isClaudeCliProvider(run.providerOverride);
  const authorizeClaudeCliFallback = () =>
    resolveAuthorizedClaudeCliBinding({
      entry: run.sessionEntry,
      config: run.cfg,
      agentId: run.sessionAgentId,
      skillsSnapshot: run.skillsSnapshot,
      cwd: childCwd,
    });
  const claudeCliBinding = seedsClaudeCliFallback ? authorizeClaudeCliFallback() : undefined;
  // The retained root only locates the transcript; the current selection must still authorize
  // it at each seam, up to the runner handoff.
  const sameClaudeCliAuthorization = () =>
    JSON.stringify(authorizeClaudeCliFallback()) === JSON.stringify(claudeCliBinding);
  const claudeCliFallbackPrelude = claudeCliBinding
    ? await buildClaudeCliFallbackContextPrelude({
        cliSessionId: claudeCliBinding.sessionId,
        cwd: claudeCliBinding.cwd ?? childCwd,
        projectsRoot: claudeCliBinding.transcriptRoot,
        assertNativeHistoryAuthorized: async () => {
          if (!sameClaudeCliAuthorization()) {
            throw new Error(NATIVE_HISTORY_AUTHORIZATION_DENIED);
          }
        },
      }).catch((error: unknown) => {
        if (isNativeHistoryAuthorizationDenied(error)) {
          return "";
        }
        throw error;
      })
    : "";
  const derivePrompts = (priorContextPrelude: string) => {
    const resolvedPrompt = resolveFallbackRetryPrompt({
      body: run.body,
      isFallbackRetry: run.isFallbackRetry,
      sessionHasHistory: run.sessionHasHistory,
      priorContextPrelude,
    });
    const effectivePrompt = isRawModelRun
      ? resolvedPrompt
      : annotateInterSessionPromptText(resolvedPrompt, run.opts.inputProvenance);
    return {
      priorContextPrelude,
      resolvedPrompt,
      effectivePrompt,
      embeddedExecApprovalContinuationPromptRange: rebaseExecApprovalContinuationPromptRange({
        body: run.body,
        prompt: effectivePrompt,
        range: run.opts.execApprovalContinuationPromptRange,
      }),
    };
  };
  const preparedPrompts = derivePrompts(claudeCliFallbackPrelude);
  return () =>
    preparedPrompts.priorContextPrelude && !sameClaudeCliAuthorization()
      ? derivePrompts("")
      : preparedPrompts;
}
