import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
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
import { NativeHistoryAuthorizationChangedError } from "../native-history-authorization-error.js";
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

/** Retain source authority with native context until its persistence or disclosure. */
export async function prepareFallbackPrompts(params: {
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
  const authorizeClaudeCliFallback = (config = getRuntimeConfigSnapshot() ?? run.cfg) =>
    resolveAuthorizedClaudeCliBinding({
      entry: run.sessionEntry,
      config,
      agentId: run.sessionAgentId,
      skillsSnapshot: run.skillsSnapshot,
      cwd: childCwd,
    });
  // Initial selection belongs to this attempt; later checks observe live revocation.
  const claudeCliBinding = seedsClaudeCliFallback ? authorizeClaudeCliFallback(run.cfg) : undefined;
  // The retained root locates the transcript; the live selection authorizes its use.
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
  const resolvedPrompt = resolveFallbackRetryPrompt({
    body: run.body,
    isFallbackRetry: run.isFallbackRetry,
    sessionHasHistory: run.sessionHasHistory,
    priorContextPrelude: claudeCliFallbackPrelude,
  });
  const effectivePrompt = isRawModelRun
    ? resolvedPrompt
    : annotateInterSessionPromptText(resolvedPrompt, run.opts.inputProvenance);
  return {
    priorContextPrelude: claudeCliFallbackPrelude,
    resolvedPrompt,
    effectivePrompt,
    embeddedExecApprovalContinuationPromptRange: rebaseExecApprovalContinuationPromptRange({
      body: run.body,
      prompt: effectivePrompt,
      range: run.opts.execApprovalContinuationPromptRange,
    }),
    assertPrivateInputCurrent: claudeCliFallbackPrelude
      ? () => {
          if (!sameClaudeCliAuthorization()) {
            throw new NativeHistoryAuthorizationChangedError();
          }
        }
      : undefined,
  };
}
