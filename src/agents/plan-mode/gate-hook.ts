/**
 * Bridges the plan-mode mutation gate into the before_tool_call choke point.
 *
 * Reads the session's plan status from the cached session store (the same cheap read the
 * read-only goal path uses) and, when plan mode is active, evaluates the trusted gate. This
 * runs as a CORE policy inside runBeforeToolCallHook, so every in-session dispatch path
 * (built-in incl. exec + subagent spawn, plugin/MCP-backed, catalog, code-mode, client
 * tools) is covered regardless of whether any plugin registered a trusted policy.
 */
import { resolveStorePath } from "../../config/sessions/paths.js";
import { resolveSessionPlanState } from "../../config/sessions/plan-state.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { checkPlanModeMutationGate, type PlanModeGateResult } from "./mutation-gate.js";

type PlanModeGateContext = {
  toolName: string;
  toolParams: unknown;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
};

/** Returns a veto result when the session is in plan mode and the tool is not read-only. */
export function resolvePlanModeGate(ctx: PlanModeGateContext): PlanModeGateResult {
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) {
    // No session context (e.g. external ACPX MCP bridge) — plan mode is a session concept.
    return { blocked: false };
  }
  const agentId = normalizeAgentId(ctx.agentId ?? parseAgentSessionKey(sessionKey)?.agentId);
  const storePath = resolveStorePath(ctx.config?.session?.store, { agentId });
  const status = (() => {
    try {
      return resolveSessionPlanState(loadSessionEntry({ sessionKey, storePath })).status;
    } catch {
      // A store read failure must never be observed as an active plan; treat as inactive.
      return "inactive" as const;
    }
  })();
  if (status !== "planning" && status !== "pending_approval") {
    return { blocked: false };
  }
  return checkPlanModeMutationGate({
    toolName: ctx.toolName,
    planActive: true,
    toolParams: ctx.toolParams,
  });
}
