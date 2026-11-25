import path from "node:path";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/health";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedOpenShellPluginConfig } from "./config.js";

type AgentWorkspace = NonNullable<
  NonNullable<ResolvedOpenShellPluginConfig["worker"]>["agentWorkspace"]
>;

const WORKSPACE_COMMANDS = [
  "file.fetch",
  "file.stat",
  "file.write",
  "file.create",
  "dir.list",
  "workspace.memory",
  "workspace.skills",
];

/** Compose existing File Transfer configuration; never replace an operator's grants. */
export function prepareOpenShellAgentWorkspace(
  config: OpenClawConfig,
  workspace: AgentWorkspace,
  nodeId: string,
  runtimeConfig: OpenClawConfig,
) {
  const plugins = config.plugins;
  const entry = plugins?.entries?.["file-transfer"];
  if (
    plugins?.enabled === false ||
    entry?.enabled === false ||
    plugins?.deny?.includes("file-transfer") ||
    (plugins?.allow?.length && !plugins.allow.includes("file-transfer"))
  ) {
    throw new Error(
      "Agent workspace binding requires File Transfer; preserve the existing plugin restriction and enable it explicitly before retrying.",
    );
  }
  const commands = config.gateway?.nodes?.commands;
  const missing = WORKSPACE_COMMANDS.filter(
    (command) => !commands?.allow?.includes(command) || commands.deny?.includes(command),
  );
  if (missing.length) {
    throw new Error(
      "Agent workspace binding needs existing Gateway node-command grants (and pairing approval): " +
        missing.join(", ") +
        ". Review gateway.nodes.commands; setup does not change command approvals.",
    );
  }
  const ids = listAgentIds(runtimeConfig);
  if (!ids.includes(workspace.agentId)) {
    throw new Error("Agent workspace binding requires an exact configured agent ID.");
  }
  const previous = entry?.config ?? {};
  if (
    (previous.policyVersion !== undefined && previous.policyVersion !== 2) ||
    (previous.policyVersion === undefined && Object.keys(previous).length > 0)
  ) {
    throw new Error(
      "Review existing File Transfer permissions with file-transfer approvals migrate before adding an agent workspace binding.",
    );
  }
  const workspaces = asOptionalRecord(previous.workspaces) ?? {};
  const binding = { nodeId, remoteRoot: workspace.remoteRoot };
  const matches = (value: unknown) => {
    const old = asOptionalRecord(value);
    return old?.nodeId === nodeId && old.remoteRoot === workspace.remoteRoot;
  };
  if (workspaces[workspace.agentId] && !matches(workspaces[workspace.agentId])) {
    throw new Error(
      "This agent already has a different canonical workspace binding; setup does not migrate or replace it.",
    );
  }
  const localRoot = path.resolve(resolveAgentWorkspaceDir(runtimeConfig, workspace.agentId));
  for (const id of ids) {
    if (
      id !== workspace.agentId &&
      path.resolve(resolveAgentWorkspaceDir(runtimeConfig, id)) === localRoot &&
      !matches(workspaces[id])
    ) {
      throw new Error(
        "Another agent shares this Gateway workspace. Give the selected agent its own workspace before binding it remotely.",
      );
    }
  }
  const nodes = asOptionalRecord(previous.nodes) ?? {};
  const root = workspace.remoteRoot;
  const policy = {
    ask: "off",
    followSymlinks: false,
    allowReadPaths: [root, root + "/**"],
    allowWritePaths: [
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "BOOTSTRAP.md",
      "MEMORY.md",
      "DREAMS.md",
      "memory",
      "memory/**",
      "skills",
      "skills/**",
      ".clawhub/lock.json",
      ".clawdhub/lock.json",
      ".openclaw/skill-installs",
      ".openclaw/skill-installs/**",
      "media/inbound/openclaw-staged-*",
      "media/inbound/openclaw-staged-*/**",
    ].map((relative) => root + "/" + relative),
  };
  return {
    ...entry,
    enabled: true,
    config: {
      ...previous,
      policyVersion: 2,
      workspaces: { ...workspaces, [workspace.agentId]: binding },
      // Display-name selectors also precede wildcard policies. An exact-ID
      // grant could shadow one, so only seed an entirely new policy map.
      nodes: Object.keys(nodes).length > 0 ? nodes : { [nodeId]: policy },
    },
  };
}
