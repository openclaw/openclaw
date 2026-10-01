import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { expandToolGroups, normalizeToolPolicyName } from "../tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

/**
 * Translate the caller's runtime tool cap into the CLI run's exact tool availability.
 * A trusted completion handoff inherits the requester's persisted cap: native CLI tools
 * cannot enforce it, so its whole surface goes through the policy projection as mediated
 * MCP tools.
 */
export function resolveCliRuntimeToolPolicy(input: {
  params: RunCliAgentParams;
  backendId: string;
  bundleMcp: boolean;
  canEnforceExactToolAvailability: boolean;
  isSideQuestion: boolean;
  skipsTurnPreparation: boolean;
}): { params: RunCliAgentParams; runtimeToolsAllowPolicy: string[] | undefined } {
  let { params } = input;
  let runtimeToolsAllowPolicy: string[] | undefined;
  if (params.toolsAllow !== undefined) {
    if (params.cliToolAvailability !== undefined) {
      throw new Error(`CLI backend ${input.backendId} received conflicting runtime tool policies`);
    }
    if (params.toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")) {
      params = { ...params, toolsAllow: undefined };
    } else {
      runtimeToolsAllowPolicy = [...params.toolsAllow];
      const fallbackOpenClawTools = uniqueStrings(
        expandToolGroups(params.toolsAllow)
          .map((toolName) => normalizeToolPolicyName(toolName))
          .filter(Boolean),
      );
      if (
        fallbackOpenClawTools.includes("write") &&
        !fallbackOpenClawTools.includes("apply_patch")
      ) {
        fallbackOpenClawTools.push("apply_patch");
      }
      params = {
        ...params,
        toolsAllow: undefined,
        cliToolAvailability: {
          native: [],
          // Preserve the prior normalized fallback for modes without a catalog;
          // catalog-backed paths replace it with exact names below.
          openClaw: fallbackOpenClawTools,
        },
      };
    }
  }
  if (
    params.disableTools === true &&
    !input.isSideQuestion &&
    input.canEnforceExactToolAvailability
  ) {
    // Selectable backends need the exact empty cap as well as the generic flag;
    // otherwise their native tools remain selectable and the run must fail closed.
    runtimeToolsAllowPolicy = undefined;
    params = {
      ...params,
      toolsAllow: undefined,
      cliToolAvailability: { native: [], openClaw: [] },
    };
  }
  if (params.trustedInternalHandoff && params.disableTools !== true) {
    if (
      !input.canEnforceExactToolAvailability ||
      !input.bundleMcp ||
      input.skipsTurnPreparation ||
      params.sessionEntry?.execHost === "node" ||
      params.trustedInternalHandoff.settleBatch !== undefined
    ) {
      throw new Error(`CLI backend ${input.backendId} cannot enforce completion tool policy`);
    }
    runtimeToolsAllowPolicy ??= ["*"];
    params = {
      ...params,
      toolsAllow: undefined,
      cliToolAvailability: { native: [], openClaw: [] },
    };
  }
  return { params, runtimeToolsAllowPolicy };
}
