import { isMainGitContributorScope } from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { resolveGitCoauthorAttribution } from "./git-coauthor-attribution.js";

const log = createSubsystemLogger("agents/system-prompt");

/** Request credit belongs in per-turn context, never main's retained instructions. */
export async function resolveRequestGitCoauthorPrompt(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  requesterProfileId?: string;
}): Promise<string | undefined> {
  if (
    !params.sessionKey ||
    !isMainGitContributorScope({ ...params, sessionKey: params.sessionKey })
  ) {
    return undefined;
  }
  try {
    const credit = await resolveGitCoauthorAttribution(params);
    return credit?.trailers.length
      ? [
          "Git co-author credit for this request: preserve these verified requester trailers in commits and delegation. Do not substitute the main session's roster. Retain other legitimate task co-authors.",
          ...credit.trailers,
        ].join("\n")
      : "Git co-author credit for this request: no host-verified requester trailer is available. Do not infer credit from this main session's roster, earlier tasks, display names, or the publishing account. Preserve any separately verified task contributor credit.";
  } catch (error) {
    log.warn("failed to resolve request Git co-authors", { error });
    return undefined;
  }
}

export async function resolveSessionGitCoauthorPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  storePath?: string;
}): Promise<string | undefined> {
  if (!params.config || !params.agentId || !params.sessionKey) {
    return undefined;
  }
  if (parseCronRunScopeSuffix(params.sessionKey).runId !== undefined) {
    return undefined;
  }
  // Incognito sessions keep no durable participant history, and the Codex runtime
  // freezes their generic instructions for the live thread, so they never carry credit.
  if (isIncognitoSessionKey(params.sessionKey)) {
    return undefined;
  }
  if (
    isMainGitContributorScope({
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    })
  ) {
    return "Git co-authors: this main session routes unrelated conversations. Its participant roster is not a task's contributor list. Use only the current request's verified Git co-author trailers when supplied; never copy credit from another conversation or an earlier task. Preserve legitimate task co-authors, and do not replace the requester's credit with session participants.";
  }
  try {
    const attribution = await resolveGitCoauthorAttribution({
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      storePath: params.storePath,
    });
    const trailers = attribution?.trailers;
    return trailers?.length
      ? [
          "Git co-authors: add these exact trailers to every commit you make from this session.",
          ...trailers,
        ].join("\n")
      : undefined;
  } catch (error) {
    log.warn("failed to resolve session Git co-authors", { error });
    return undefined;
  }
}
