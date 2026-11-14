import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { resolveAgentEntry } from "./agent-scope-config.js";
import { resolveConfiguredGitHubHost } from "./github-host.js";
import {
  readNativeGitHubConfiguration,
  type GitHubIdentityPreparation,
} from "./github-read-identity.js";

export function resolveConfiguredGitHubToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  scope: "system" | "agent";
}): GitHubToolIdentityConfig | undefined {
  return params.scope === "agent"
    ? resolveAgentEntry(params.config, params.agentId)?.tools?.github
    : params.config.tools?.github;
}

export function resolveSystemGitHubToolIdentity(params: Pick<GitHubIdentityPreparation, "config">) {
  return (
    resolveScopedGitHubToolIdentity({ ...params, agentId: "", scope: "system" }) ?? {
      source: "system-detected" as const,
    }
  );
}

export function resolveGitHubToolIdentity(
  params: Pick<GitHubIdentityPreparation, "config" | "agentId">,
) {
  return (
    resolveScopedGitHubToolIdentity({ ...params, scope: "agent" }) ??
    resolveSystemGitHubToolIdentity(params)
  );
}

/** Secret-free selection inputs for the prompt owner's existing tool-policy epoch. */
export function readGitHubPublicationToolSelection(config: OpenClawConfig) {
  const role = (identity: GitHubToolIdentityConfig | undefined) =>
    !identity ? "native" : identity.kind === "app-installation" ? "reader" : "writer";
  return {
    host: resolveConfiguredGitHubHost(config),
    system: role(config.tools?.github),
    agents: Object.fromEntries(
      Object.entries(config.agents?.entries ?? {}).map(([id, agent]) => [
        id,
        role(agent.tools?.github),
      ]),
    ),
  };
}

/** Declaration eligibility, not credential health, caller authority, or repository access. */
export function readGitHubPublicationConfiguration(
  params: Pick<GitHubIdentityPreparation, "config" | "agentId">,
): "configured" | "unconfigured" | "unknown" {
  const selected = resolveGitHubToolIdentity(params);
  const selection = readGitHubPublicationToolSelection(params.config);
  const native = readNativeGitHubConfiguration(selection.host);
  // App installations support foreground reads, never publication.
  const own =
    selected.source === "system-detected"
      ? native
      : selected.config.kind === "app-installation"
        ? "unconfigured"
        : "configured";
  if (own !== "unconfigured") {
    return own;
  }
  const agentRoles = Object.values(selection.agents);
  // A selected publishing child can use another agent's identity. Configuration alone
  // cannot rule out that route; preserve its surface without scanning session children.
  if (
    selection.system === "writer" ||
    agentRoles.includes("writer") ||
    (selection.system === "native" && native !== "unconfigured" && agentRoles.includes("native"))
  ) {
    return "unknown";
  }
  return "unconfigured";
}

export function resolveScopedGitHubToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  scope: "system" | "agent";
}) {
  const config = resolveConfiguredGitHubToolIdentity(params);
  return config
    ? {
        source:
          params.scope === "agent" ? ("agent-override" as const) : ("system-configured" as const),
        config,
      }
    : undefined;
}
