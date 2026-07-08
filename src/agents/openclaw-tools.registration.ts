/**
 * OpenClaw-owned tool registration filters.
 *
 * Keeps optional tool gating separate from tool construction so config and execution contracts decide exposure.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Registration helpers for optional OpenClaw-owned tools.
 *
 * This keeps model/runtime gating separate from tool construction so callers can
 * assemble candidate tools first, then filter by config and execution contract.
 */
/** Drops disabled optional tools while preserving candidate order. */
export function collectPresentOpenClawTools(
  candidates: readonly (AnyAgentTool | null | undefined)[],
): AnyAgentTool[] {
  return candidates.filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
}

/**
 * Resolves the update_plan switch. Codex-parity plan mode promotes update_plan to default-on
 * for every model; `tools.experimental.planTool: false` remains the explicit kill-switch (and
 * `true` still force-enables). Strict-agentic runs stay on as a subset of the new default.
 */
function isUpdatePlanToolEnabledForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
}): boolean {
  const configured = params.config?.tools?.experimental?.planTool;
  if (configured !== undefined) {
    return configured;
  }
  // Default-on: update_plan is the live plan-mode checklist for all models.
  return true;
}

function mergeOpenClawToolPolicyList(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = lists.flatMap((list) => (Array.isArray(list) ? list : []));
  return merged.length > 0 ? uniqueStrings(merged) : undefined;
}

function isToolExplicitlyAllowedByOpenClawToolPolicy(params: {
  toolName: string;
  allowlist?: string[];
  denylist?: string[];
}): boolean {
  if (!params.allowlist?.some((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return false;
  }
  return isToolAllowedByPolicyName(params.toolName, {
    allow: params.allowlist,
    deny: params.denylist,
  });
}

/** Decides whether update_plan should be included in the assembled OpenClaw tool set. */
export function shouldIncludeUpdatePlanToolForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
  pluginToolAllowlist?: string[];
  pluginToolDenylist?: string[];
}): boolean {
  const allowlist = mergeOpenClawToolPolicyList(
    params.config?.tools?.allow,
    params.config?.tools?.alsoAllow,
    params.pluginToolAllowlist,
  );
  const denylist = mergeOpenClawToolPolicyList(
    params.config?.tools?.deny,
    params.pluginToolDenylist,
  );
  // An explicit allowlist entry always wins (even over a broad deny group).
  if (
    isToolExplicitlyAllowedByOpenClawToolPolicy({ toolName: "update_plan", allowlist, denylist })
  ) {
    return true;
  }
  // Otherwise an explicit deny of update_plan opts out of the default-on switch.
  if (
    denylist &&
    !isToolAllowedByPolicyName("update_plan", { allow: ["update_plan"], deny: denylist })
  ) {
    return false;
  }
  return isUpdatePlanToolEnabledForOpenClawTools({
    config: params.config,
    agentSessionKey: params.agentSessionKey,
    agentId: params.agentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
}
