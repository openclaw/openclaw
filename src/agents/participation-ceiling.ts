import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  intersectSessionParticipationSources,
  type SessionParticipationSource,
} from "../config/sessions/session-participation-source.js";
import { intersectExecPolicyCeilings, type ExecPolicyCeiling } from "../infra/exec-policy.js";
import { AgentHarnessPreflightError } from "./harness/errors.js";
import { intersectSessionPermissionModes } from "./session-permission-mode.js";
import { createToolPolicyMatcher } from "./tool-policy-match.js";
import {
  attachToolAllowlistIntersection,
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
} from "./tool-policy.js";

/** Host-stamped input authority. Never accept this field from message text or RPC parameters. */
export type ParticipationCeiling = {
  readonly kind: "send";
  readonly profileId: string;
  readonly sessionKey: string;
  /** Tool policy patterns captured at admission; omission uses participant defaults. */
  readonly tools?: readonly string[];
  /** Independent retained/current restrictions; every list must permit a tool. */
  readonly toolConstraints?: readonly (readonly string[])[];
  /** Effective permission captured at admission; missing stored values retain guarded authority. */
  readonly permission?: SessionPermissionMode;
  /** Exact child execution floor when the permission label cannot represent it. */
  readonly execPolicy?: ExecPolicyCeiling;
  /** Original invitation and file root; descendants never retarget this source. */
  readonly source?: SessionParticipationSource;
};

/** A run restriction is bound to its original invitation before it can be retained. */
export type BoundParticipationCeiling = ParticipationCeiling & {
  readonly tools: readonly string[];
  readonly permission: SessionPermissionMode;
  readonly source: NonNullable<ParticipationCeiling["source"]>;
};

/** Participation defaults live here; other policy layers may only narrow these capabilities. */
export function participationPermission(ceiling: ParticipationCeiling): SessionPermissionMode {
  return ceiling.permission ?? "guarded";
}
export const DEFAULT_PARTICIPATION_TOOLS = Object.freeze([
  "read",
  "write",
  "edit",
  "apply_patch",
  "ls",
  "exec",
  "process",
  "sessions_spawn",
  "sessions_yield",
  "skills_search",
  "skills_read",
  "web_search",
  "web_fetch",
  "tool_search",
  "tool_describe",
  "dispatch_action",
  "view_image",
  "progress_card",
]);

/** Resolve role replacement/addition once before capturing the input's tool ceiling. */
export function resolveParticipationTools(policy?: {
  invitedTools?: readonly string[];
  invitedAlsoAllow?: readonly string[];
}): string[] {
  if (!policy?.invitedTools && !policy?.invitedAlsoAllow?.length) {
    return DEFAULT_PARTICIPATION_TOOLS.slice();
  }
  return [
    ...new Set(
      policy?.invitedTools ?? [...DEFAULT_PARTICIPATION_TOOLS, ...(policy?.invitedAlsoAllow ?? [])],
    ),
  ];
}

/** Durable independent lists preserve intersecting globs across queueing and restart. */
export function participationToolConstraints(ceiling: ParticipationCeiling): string[][] {
  return [ceiling.tools ?? DEFAULT_PARTICIPATION_TOOLS, ...(ceiling.toolConstraints ?? [])].map(
    (allow) => allow.slice(),
  );
}

/** Apply ordinary policy syntax while retaining an empty list as deny-all. */
export function participationToolPolicy(ceiling: ParticipationCeiling) {
  const constraints = participationToolConstraints(ceiling);
  return {
    allow: attachToolAllowlistIntersection([...constraints[0]!], constraints),
    deny: ["openclaw"],
  };
}

/** Project concrete core/plugin/MCP tools without inventing a second policy language. */
export function filterParticipationTools<T extends { name: string }>(
  tools: T[],
  ceiling: ParticipationCeiling | undefined,
  toolMeta: (tool: T) => { pluginId: string; ownerUnverified?: boolean } | undefined = () =>
    undefined,
): T[] {
  if (!ceiling) {
    return tools;
  }
  const policy = expandPolicyWithPluginGroups(
    participationToolPolicy(ceiling),
    buildPluginToolGroups({ tools, toolMeta }),
  );
  const matches = createToolPolicyMatcher(policy);
  return tools.filter((tool) => matches(tool.name));
}

/** Test a core capability at admission using the same matcher as the tool surface. */
export function participationAllowsTool(ceiling: ParticipationCeiling, name: string): boolean {
  return filterParticipationTools([{ name }], ceiling).length === 1;
}

/** A continuation retains one original invitation, never a union of different participants. */
export function intersectParticipationCeilings(
  retained: BoundParticipationCeiling | undefined,
  current: BoundParticipationCeiling | undefined,
): BoundParticipationCeiling | undefined;
export function intersectParticipationCeilings(
  retained: BoundParticipationCeiling,
  current: ParticipationCeiling | undefined,
): BoundParticipationCeiling;
export function intersectParticipationCeilings(
  retained: ParticipationCeiling | undefined,
  current: BoundParticipationCeiling,
): BoundParticipationCeiling;
export function intersectParticipationCeilings(
  retained: ParticipationCeiling | undefined,
  current: ParticipationCeiling | undefined,
): ParticipationCeiling | undefined;
export function intersectParticipationCeilings(
  retained: ParticipationCeiling | undefined,
  current: ParticipationCeiling | undefined,
): ParticipationCeiling | undefined {
  if (!retained || !current) {
    return retained ?? current;
  }
  if (retained.profileId !== current.profileId || retained.sessionKey !== current.sessionKey) {
    throw new Error("Participation continuations must retain one original invitation.");
  }
  const tools = [...(retained.tools ?? DEFAULT_PARTICIPATION_TOOLS)];
  const original = JSON.stringify(tools);
  const toolConstraints = [
    ...new Map(
      [...(retained.toolConstraints ?? []), ...participationToolConstraints(current)]
        .map((allow) => [JSON.stringify(allow), allow] as const)
        .filter(([key]) => key !== original),
    ).values(),
  ];
  return {
    ...retained,
    source: intersectSessionParticipationSources(retained.source, current.source),
    permission: intersectSessionPermissionModes(
      participationPermission(retained),
      participationPermission(current),
    ),
    ...((retained.execPolicy || current.execPolicy) && {
      execPolicy: intersectExecPolicyCeilings(retained.execPolicy, current.execPolicy),
    }),
    tools,
    toolConstraints:
      toolConstraints.length > 0 ? toolConstraints.map((allow) => allow.slice()) : undefined,
  };
}

export const PARTICIPATION_RUNTIME_ERROR =
  "Participating inputs require the OpenClaw runtime. Select an OpenClaw model and send again.";

export function assertParticipationRuntime(
  ceiling: ParticipationCeiling | undefined,
  runtime: string,
): void {
  if (ceiling && runtime !== "openclaw") {
    throw new AgentHarnessPreflightError(PARTICIPATION_RUNTIME_ERROR, {
      userMessage: PARTICIPATION_RUNTIME_ERROR,
    });
  }
}

const PARTICIPATION_WORKER_ERROR =
  "Participating inputs require Gateway-local OpenClaw execution. Worker placements cannot enforce their permission ceiling; use a Gateway-local OpenClaw session.";

/** Worker launch protocols do not carry the per-input execution ceiling. */
export function assertParticipationWorkerExecution(
  ceiling: ParticipationCeiling | undefined,
): void {
  if (ceiling) {
    throw new AgentHarnessPreflightError(PARTICIPATION_WORKER_ERROR, {
      userMessage: PARTICIPATION_WORKER_ERROR,
    });
  }
}
