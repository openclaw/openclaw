import type { ResolvedCliBackend } from "../cli-backends.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

/** Match provider-native names against the canonical tool hook and policy ids. */
export function normalizeCliToolName(toolName: string): string {
  return normalizeToolPolicyName(
    toolName.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
  );
}

/** Keeps only explicit runtime caps for backend-owned exact translation. */
export function resolveCliRuntimeToolsAllow(toolsAllow?: string[]): string[] | undefined {
  if (toolsAllow === undefined) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")
    ? undefined
    : toolsAllow;
}

/**
 * Whether a native call may run under the run's exact selection. A completion keeps the
 * ordinary native list for a stable prefix, but its requester cap is enforced per MCP
 * call, so a native tool that confers a capability is refused there.
 */
export function isCliNativeToolCallable(
  run: Pick<RunCliAgentParams, "cliToolAvailability" | "trustedInternalHandoff">,
  toolName: string,
  backend: Pick<ResolvedCliBackend, "projectNativeToolAuthority">,
): boolean {
  if (!run.cliToolAvailability) {
    return true;
  }
  return (
    run.cliToolAvailability.native.includes(toolName) &&
    !(run.trustedInternalHandoff && backend.projectNativeToolAuthority?.([toolName]).length)
  );
}
