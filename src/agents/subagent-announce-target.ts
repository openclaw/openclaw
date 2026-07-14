// Shared native subagent completion routing helpers.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import {
  readSubagentAnnounceTarget,
  type SubagentAnnounceTarget,
} from "./subagent-announce-target.types.js";

/** Resolves subagent completion routing from per-call override, per-agent config, or defaults. */
export function resolveConfiguredSubagentAnnounceTarget(params: {
  cfg: OpenClawConfig;
  requesterAgentId?: string;
  announceTarget?: SubagentAnnounceTarget;
}): SubagentAnnounceTarget {
  if (params.announceTarget) {
    return params.announceTarget;
  }
  const requesterAgentConfig = params.requesterAgentId
    ? resolveAgentConfig(params.cfg, params.requesterAgentId)
    : undefined;
  return (
    readSubagentAnnounceTarget(requesterAgentConfig?.subagents?.announceTarget) ??
    readSubagentAnnounceTarget(params.cfg?.agents?.defaults?.subagents?.announceTarget) ??
    "channel"
  );
}

export function shouldAnnounceCompletionForInitialChildRun(params: {
  deliverInitialChildRunDirectly: boolean;
  announceTarget: SubagentAnnounceTarget;
  expectsCompletionMessage: boolean;
}): boolean {
  return params.deliverInitialChildRunDirectly && params.announceTarget !== "parent"
    ? false
    : params.expectsCompletionMessage;
}
