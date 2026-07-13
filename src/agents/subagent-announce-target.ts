// Shared native subagent completion routing helpers.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

/** Completion routing target for native subagent runs. */
export const SUBAGENT_ANNOUNCE_TARGETS = ["channel", "parent"] as const;
export type SubagentAnnounceTarget = (typeof SUBAGENT_ANNOUNCE_TARGETS)[number];

export function readConfiguredSubagentAnnounceTarget(
  value: unknown,
): SubagentAnnounceTarget | undefined {
  return value === "channel" || value === "parent" ? value : undefined;
}

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
    readConfiguredSubagentAnnounceTarget(requesterAgentConfig?.subagents?.announceTarget) ??
    readConfiguredSubagentAnnounceTarget(params.cfg?.agents?.defaults?.subagents?.announceTarget) ??
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
