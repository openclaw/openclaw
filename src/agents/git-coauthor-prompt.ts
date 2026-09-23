import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { resolveGitCoauthorAttribution } from "./git-coauthor-attribution.js";

const log = createSubsystemLogger("agents/system-prompt");

export function resolveSessionGitCoauthorPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
}): string | undefined {
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
  try {
    const trailers = resolveGitCoauthorAttribution({
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    })?.trailers;
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
