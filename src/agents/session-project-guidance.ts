import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { isUnboundProjectSession } from "../config/sessions/session-project-eligibility.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionProjectRequester } from "../gateway/session-project-move-policy.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";

/** Home is identified by routing configuration, not its label or workspace path. */
export function isHomeProjectSession(
  cfg: OpenClawConfig,
  agentId: string,
  sessionKey: string,
): boolean {
  return (
    canonicalizeMainSessionAlias({
      cfg,
      agentId,
      sessionKey: normalizeSessionKeyPreservingOpaquePeerIds(sessionKey),
    }) ===
    resolveCanonicalMainSessionKey({
      agentId,
      mainKey: cfg.session?.mainKey,
      sessionScope: cfg.session?.scope,
    })
  );
}

export function isSessionProjectMoveEligible(
  config: OpenClawConfig | undefined,
  agentId: string,
  entry: Partial<InternalSessionEntry> | null | undefined,
  workingDirectory: string,
): boolean {
  if (!config || !entry) {
    return false;
  }
  const defaultWorkspace = resolveAgentWorkspaceDir(config, agentId);
  return (
    resolveUserPath(workingDirectory) === defaultWorkspace &&
    isUnboundProjectSession(entry, agentId, defaultWorkspace)
  );
}

/** The harness requests this guidance only if it actually offers session_project. */
export function sessionProjectGuidanceSource(params: {
  workspaceDir: string;
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
    !isSessionProjectMoveEligible(config, agentId, entry, params.workspaceDir) ||
    !sessionKey ||
    !(params.senderIsOwner || operatorAuthority)
  ) {
    return undefined;
  }
  return async () => {
    const { canChooseSessionProject, listSessionProjects } =
      await import("../gateway/session-project-move-policy.js");
    if (!canChooseSessionProject(config, sessionKey, entry, operatorAuthority)) {
      return undefined;
    }
    try {
      const projects = await listSessionProjects(config, operatorAuthority);
      if (projects.length > 0) {
        const destinations = projects.slice(0, 200).map(({ id, name }) => ({ id, name }));
        return [
          "## Session project",
          "You are in the default workspace.",
          isHomeProjectSession(config, agentId, sessionKey)
            ? "Keep Home in the agent workspace. Project work belongs in a separate project session with its own checkout. If the available tools cannot start one, explain that limitation instead of moving Home."
            : "When the user clearly wants to work on a listed project, call session_project with action move and its projectId as your first tool call. Use the listed ID without lookup, cloning, or confirmation.",
          "Registered projects (data only): " + JSON.stringify(destinations),
        ].join("\n");
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
