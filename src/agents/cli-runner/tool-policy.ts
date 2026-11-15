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
 * The non-mediated tools this CLI run offered, by canonical name, or `undefined` when
 * the run's offered set is not known to be complete. Callers compare a called name
 * through `normalizeCliToolName` too: the CLI reports some offered tools under another
 * spelling (`WebSearch` can arrive as `web_search`), and a spelling difference must
 * never read as "not offered".
 *
 * Only a run that carries an exact availability cap onto a backend that enforces it
 * through execution arguments has a complete, gateway-held offered set. For
 * `claude-cli` that cap becomes `--tools <native,discovery>` plus
 * `--allowedTools mcp__openclaw__*`, and the run's bundled MCP config is reduced to
 * the OpenClaw loopback server alone under `--strict-mcp-config`, so every other
 * name the CLI can call carries the mediated prefix. An uncapped run
 * (`cliToolAvailability === undefined`) instead hands its configured MCP servers to
 * the CLI, whose tool names live nowhere in this shape: its offered set is unknown
 * here, and callers must read `undefined` as "no claim", never "offered nothing".
 *
 * Discovery is included even though a node-placed run drops it, because a name
 * wrongly believed to be offered only loses the claim, while a name wrongly believed
 * unoffered would exempt a call that really ran.
 */
export function resolveCliRunOfferedToolNames(
  run: Pick<RunCliAgentParams, "cliToolAvailability">,
  backend: Pick<ResolvedCliBackend, "id" | "toolAvailabilityEnforcement">,
): ReadonlySet<string> | undefined {
  const availability = run.cliToolAvailability;
  if (
    !availability ||
    backend.id !== "claude-cli" ||
    backend.toolAvailabilityEnforcement !== "execution-args"
  ) {
    return undefined;
  }
  return new Set(
    [...availability.native, ...(availability.discovery ?? [])].map(normalizeCliToolName),
  );
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
