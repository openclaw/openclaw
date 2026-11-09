/** Decides when a session-event tool cap only records the producing run's own surface. */
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import {
  isProducerSurfaceToolAllowlist,
  markToolAllowlistAsProducerSurface,
  toolPolicyRestrictsTools,
  type ToolPolicyLike,
} from "./tool-policy.js";

/** Turn-scoped option facts that make a run's own surface narrower than its session's. */
type ProducerSurfaceOptions = Pick<
  InternalCodingToolsOptions,
  "runtimeToolAllowlist" | "runtimePluginToolGrant" | "swarmCollector"
>;

/** Requester, group and inheritance policies that only this turn's authority explains. */
type ProducerSurfacePolicies = Pick<
  ResolvedConversationCapabilityProfile["policy"],
  | "delegatedToolPolicy"
  | "groupPolicy"
  | "inheritedToolPolicy"
  | "runtimeToolPolicyForInheritance"
  | "sandboxPolicy"
  | "senderPolicy"
  | "subagentPolicy"
>;

/**
 * Reads a policy as a prompt-surface narrowing. A ceiling that only recorded its producer's
 * own surface bounds tool access without removing anything the capped turn would build on its
 * own, so it is not a narrowing — neither as this turn's runtime allowlist nor as the same
 * list re-read from the runtime inheritance projection a repeated wake prepares. A deny is
 * always a narrowing.
 */
function restrictsPromptSurface(policy?: ToolPolicyLike): boolean {
  if (!toolPolicyRestrictsTools(policy)) {
    return false;
  }
  return (policy?.deny?.length ?? 0) > 0 || !isProducerSurfaceToolAllowlist(policy?.allow);
}

/**
 * Marks the default session-event cap when it removes nothing a woken turn would build on
 * its own, so that turn keeps the conversation's normal prompt and reads the provider
 * prompt cache. The list stays the tool-access ceiling either way.
 *
 * The cap is a real narrowing — and keeps the minimal prompt — when this turn held less
 * than its session normally does: a runtime allowlist, a turn-scoped plugin grant, a
 * collector contract, delegated authority, a requester/group/sandbox/subagent/inherited
 * restriction, a tool this turn was not authorized to call, or no tool at all.
 * Configured `tools.allow`/`tools.deny` policies are not turn-scoped: the woken turn
 * re-resolves them from the same config, so the cap adds nothing to them.
 */
export function markProducerSurfaceToolCap<T extends string[]>(params: {
  toolsAllow: T;
  options?: ProducerSurfaceOptions;
  capabilityProfile: { policy: ProducerSurfacePolicies };
  turnAuthorized: (tool: { name: string }) => boolean;
  tools: readonly { name: string }[];
}): T {
  const { options, capabilityProfile, turnAuthorized, tools, toolsAllow } = params;
  const { policy } = capabilityProfile;
  const turnScopedRestriction =
    toolsAllow.length === 0 ||
    options?.swarmCollector === true ||
    options?.runtimePluginToolGrant !== undefined ||
    Boolean(policy.delegatedToolPolicy) ||
    // A wake that starts its own background work inherits the marked cap, so the fact
    // survives into the next generation of wakes instead of degrading to minimal there.
    restrictsPromptSurface({ allow: options?.runtimeToolAllowlist }) ||
    [
      policy.senderPolicy,
      policy.groupPolicy,
      policy.sandboxPolicy,
      policy.subagentPolicy,
      policy.inheritedToolPolicy,
      policy.runtimeToolPolicyForInheritance,
    ].some((entry) => restrictsPromptSurface(entry)) ||
    tools.some((tool) => !turnAuthorized(tool));
  return turnScopedRestriction ? toolsAllow : markToolAllowlistAsProducerSurface(toolsAllow);
}

/**
 * Builds the tool cap a run records for the session events it produces, such as an exec
 * completion waking its own session. The woken turn may never reach a tool this run could
 * not, and it keeps the conversation's normal prompt when this run was unrestricted.
 */
export function buildSessionEventSourceToolCap(params: {
  options?: ProducerSurfaceOptions;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  turnAuthorized: (tool: { name: string }) => boolean;
  tools: readonly { name: string }[];
}): string[] {
  const { capabilityProfile, turnAuthorized, tools } = params;
  return markProducerSurfaceToolCap({
    ...params,
    toolsAllow: [
      ...tools.filter(turnAuthorized).map((tool) => tool.name),
      // Provider-hosted search has no function tool; keep this turn's decision for it.
      ...(!tools.some((tool) => tool.name === "web_search") &&
      isConversationToolAllowed(capabilityProfile, "web_search")
        ? ["web_search"]
        : []),
    ],
  });
}
