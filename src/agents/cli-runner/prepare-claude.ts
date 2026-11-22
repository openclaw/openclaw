import { getRuntimeConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { isClaudeCliProvider } from "../cli-output-records.js";
import type { RunCliAgentParams } from "./types.js";

export function detectNodeClaudePlacement(params: {
  backendId: string;
  execHost?: string;
  execNode?: string;
}): boolean {
  if (params.backendId === "claude-cli" && params.execHost === "node" && !params.execNode?.trim()) {
    throw new Error("node-placed Claude CLI session is missing execNode");
  }
  return (
    params.backendId === "claude-cli" &&
    params.execHost === "node" &&
    Boolean(params.execNode?.trim())
  );
}

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

/**
 * The configured placement of one run's session entry. The binding is not stored, so readers
 * of the stored session on the run's path compare through this, with the run's own inputs.
 */
export function applyConfiguredClaudeCliRunPlacement<
  Entry extends Pick<SessionEntry, "execHost" | "execNode">,
>(
  run: Pick<RunCliAgentParams, "config" | "sessionKey" | "agentId" | "provider">,
  sessionEntry: Entry | undefined,
): Entry | undefined {
  return applyConfiguredClaudeCliPlacement({
    config: run.config ?? getRuntimeConfig(),
    // The session owner, as preparation resolves it.
    agentId: normalizeAgentId(
      parseAgentSessionKey(run.sessionKey)?.agentId ||
        run.agentId?.trim() ||
        LEGACY_IMPLICIT_AGENT_ID,
    ),
    backendId: run.provider,
    sessionEntry,
  });
}

/** Places a CLI run before preparation, so every reader of its session sees one placement. */
export function placeConfiguredClaudeCliRun(params: RunCliAgentParams): RunCliAgentParams {
  const sessionEntry = applyConfiguredClaudeCliRunPlacement(params, params.sessionEntry);
  return sessionEntry === params.sessionEntry ? params : { ...params, sessionEntry };
}
