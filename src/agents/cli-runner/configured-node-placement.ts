import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { isClaudeCliProvider } from "../cli-output-records.js";

/**
 * `tools.exec.claudeCliHost: "node"` is the configuration default for the per-session
 * Claude node placement (`execHost: "node"` + `execNode`). Every reader of the placement
 * takes the entry from here, so preparation, execution, and tool gates agree. A run that
 * cannot be placed on the configured node is refused; it never falls back to the Gateway.
 */
export function applyConfiguredClaudeCliPlacement<
  Entry extends Pick<SessionEntry, "execHost" | "execNode">,
>(params: {
  config: OpenClawConfig | undefined;
  /** The agent that owns the session; its tools.exec overrides the global one. */
  agentId: string | undefined;
  backendId: string | undefined;
  sessionEntry: Entry | undefined;
}): Entry | undefined {
  if (!params.backendId || !isClaudeCliProvider(params.backendId)) {
    return params.sessionEntry;
  }
  const globalExec = params.config?.tools?.exec;
  const agentExec =
    params.config && params.agentId
      ? resolveAgentConfig(params.config, params.agentId)?.tools?.exec
      : undefined;
  if ((agentExec?.claudeCliHost ?? globalExec?.claudeCliHost) !== "node") {
    return params.sessionEntry;
  }
  const node = (agentExec?.node ?? globalExec?.node)?.trim();
  if (!node) {
    throw new Error(
      'tools.exec.claudeCliHost is "node" but tools.exec.node is not set; set it to the paired node that runs Claude CLI.',
    );
  }
  const entry = params.sessionEntry;
  if (!entry) {
    throw new Error(
      'tools.exec.claudeCliHost is "node" but this Claude CLI run has no session to place on the node; OpenClaw did not start it on the Gateway.',
    );
  }
  const sessionNode = entry.execNode?.trim();
  if (sessionNode && sessionNode !== node) {
    throw new Error(
      `This session is bound to node "${sessionNode}", but tools.exec.claudeCliHost places Claude CLI runs on "${node}"; clear the session's execNode or change tools.exec.node.`,
    );
  }
  return entry.execHost === "node" && sessionNode === node
    ? entry
    : { ...entry, execHost: "node", execNode: node };
}
