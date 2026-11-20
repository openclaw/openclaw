import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionProjectRequester } from "../gateway/session-project-move-policy.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";

/** The harness requests this guidance only if it actually offers session_project. */
export function sessionProjectGuidanceSource(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  entry?: InternalSessionEntry;
  senderIsOwner?: boolean;
  operatorAuthority?: SessionProjectRequester;
}) {
  const { config, agentId, sessionKey, entry, operatorAuthority } = params;
  if (
    !config ||
    !agentId ||
    !entry ||
    !sessionKey ||
    !(params.senderIsOwner || operatorAuthority)
  ) {
    return undefined;
  }
  return async () => {
    const { canChooseSessionProject, isUnboundProjectSession, listSessionProjects } =
      await import("../gateway/session-project-move-policy.js");
    if (
      !isUnboundProjectSession(entry, resolveAgentWorkspaceDir(config, agentId)) ||
      !canChooseSessionProject(config, sessionKey, entry, operatorAuthority)
    ) {
      return undefined;
    }
    try {
      if ((await listSessionProjects(config, operatorAuthority)).length > 0) {
        return "## Session project\nYou are in the general workspace. Before coding, or when the task fits an existing project, use session_project to list the available projects. Move this conversation into the matching project before starting work there.";
      }
    } catch (error) {
      createSubsystemLogger("session-project").warn(
        "Could not list projects for the session prompt",
        { error: String(error) },
      );
    }
    return undefined;
  };
}
