import { createHash } from "node:crypto";
import path from "node:path";
import { isManagedGitHubProfileId } from "../config/github-identity-profile-id.js";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";

const MANAGED_GITHUB_ROOT_SEGMENTS = ["credentials", "github"] as const;

export function resolveManagedGitHubProfileDir(params: {
  agentId: string;
  scope: "system" | "agent" | "personal";
  profileId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (!isManagedGitHubProfileId(params.profileId)) {
    throw new Error("Managed GitHub profile id is invalid.");
  }
  const root = resolveManagedGitHubProfileRoot(params);
  return path.join(root, params.profileId);
}

export function resolveManagedGitHubProfileRoot(params: {
  agentId: string;
  scope: "system" | "agent" | "personal";
  env?: NodeJS.ProcessEnv;
}): string {
  const root = path.join(resolveStateDir(params.env), ...MANAGED_GITHUB_ROOT_SEGMENTS);
  return params.scope === "agent"
    ? path.join(root, "agents", resolveManagedGitHubAgentKey(params.agentId))
    : path.join(root, params.scope);
}

export function resolveManagedGitHubAgentKey(agentId: string): string {
  return createHash("sha256").update(normalizeAgentId(agentId), "utf8").digest("hex");
}
