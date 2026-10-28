import { createHash } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitLabToolIdentityConfig } from "../config/types.tools.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentEntry } from "./agent-scope-config.js";
import type { GitLabIdentityScope } from "./gitlab-managed-records.js";

export function resolveConfiguredGitLabToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  scope: GitLabIdentityScope;
}): GitLabToolIdentityConfig | undefined {
  return params.scope === "agent"
    ? resolveAgentEntry(params.config, params.agentId)?.tools?.gitlab
    : params.config.tools?.gitlab;
}

export function resolveEffectiveGitLabToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
}):
  | {
      source: "agent-override" | "system-configured";
      scope: GitLabIdentityScope;
      identity: GitLabToolIdentityConfig;
    }
  | undefined {
  const agent = resolveConfiguredGitLabToolIdentity({ ...params, scope: "agent" });
  if (agent) {
    return { source: "agent-override", scope: "agent", identity: agent };
  }
  const system = resolveConfiguredGitLabToolIdentity({ ...params, scope: "system" });
  return system ? { source: "system-configured", scope: "system", identity: system } : undefined;
}

export function resolveManagedGitLabProfileDir(params: {
  scope: GitLabIdentityScope;
  agentId: string;
  profileId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (!/^glp_[a-f0-9]{32}$/u.test(params.profileId)) {
    throw new Error("Invalid managed GitLab profile ID.");
  }
  const root = path.join(resolveStateDir(params.env), "credentials", "gitlab");
  return params.scope === "system"
    ? path.join(root, "system", params.profileId)
    : path.join(
        root,
        "agents",
        createHash("sha256").update(normalizeAgentId(params.agentId)).digest("hex"),
        params.profileId,
      );
}
