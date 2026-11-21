import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { intersectExecPolicyCeilings, type ExecPolicyCeiling } from "../infra/exec-policy.js";
import { AgentHarnessPreflightError } from "./harness/errors.js";
import { intersectSessionPermissionModes } from "./session-permission-mode.js";

/** Host-stamped input authority. Never accept this field from message text or RPC parameters. */
export type ParticipationCeiling = {
  readonly kind: "send";
  readonly profileId: string;
  readonly sessionKey: string;
  /** Exact core names captured at admission; omission retains the default for stored inputs. */
  readonly tools?: readonly string[];
  /** Effective permission captured at admission; missing stored values retain guarded authority. */
  readonly permission?: SessionPermissionMode;
  /** Exact child execution floor when the permission label cannot represent it. */
  readonly execPolicy?: ExecPolicyCeiling;
  /** Original invitation and file root; descendants never retarget this source. */
  readonly source?: {
    readonly agentId: string;
    readonly sessionId: string;
    readonly lifecycleRevision: string | null;
    readonly creatorProfileId: string;
    readonly root: string;
  };
};

/** Participation defaults live here; other policy layers may only narrow these capabilities. */
export function participationPermission(ceiling: ParticipationCeiling): SessionPermissionMode {
  return ceiling.permission ?? "guarded";
}
export const PARTICIPATION_TOOL_ALLOWLIST = Object.freeze([
  "read",
  "write",
  "edit",
  "apply_patch",
  "ls",
  "exec",
  "process",
  "sessions_spawn",
  "skills_search",
  "skills_read",
  "web_search",
  "web_fetch",
  "tool_search",
  "tool_describe",
  "dispatch_action",
]);

/** Only tools with an enforced per-session boundary can enter a participation ceiling. */
export function isParticipationToolAllowed(name: string): boolean {
  return PARTICIPATION_TOOL_ALLOWLIST.includes(name);
}

/** Retained inputs cannot restore unsafe names admitted by earlier policy. */
export function participationToolAllowlist(ceiling: ParticipationCeiling): readonly string[] {
  return ceiling.tools?.filter(isParticipationToolAllowed) ?? PARTICIPATION_TOOL_ALLOWLIST;
}

/** A continuation retains one original invitation, never a union of different participants. */
export function intersectParticipationCeilings(
  retained: ParticipationCeiling | undefined,
  current: ParticipationCeiling | undefined,
): ParticipationCeiling | undefined {
  if (!retained || !current) {
    return retained ?? current;
  }
  if (
    retained.profileId !== current.profileId ||
    retained.sessionKey !== current.sessionKey ||
    (retained.source &&
      current.source &&
      (retained.source.agentId !== current.source.agentId ||
        retained.source.sessionId !== current.source.sessionId ||
        retained.source.lifecycleRevision !== current.source.lifecycleRevision ||
        retained.source.creatorProfileId !== current.source.creatorProfileId ||
        retained.source.root !== current.source.root))
  ) {
    throw new Error("Participation continuations must retain one original invitation.");
  }
  return {
    ...retained,
    source: retained.source ?? current.source,
    permission: intersectSessionPermissionModes(
      participationPermission(retained),
      participationPermission(current),
    ),
    ...((retained.execPolicy || current.execPolicy) && {
      execPolicy: intersectExecPolicyCeilings(retained.execPolicy, current.execPolicy),
    }),
    tools: participationToolAllowlist(retained).filter((name) =>
      participationToolAllowlist(current).includes(name),
    ),
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

export const PARTICIPATION_WORKER_ERROR =
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

/** Stored constraints are not a grant. Every new child turn acquires current source authority. */
export function sessionParticipationCeiling(
  entry: SessionEntry | undefined,
  recorded?: ParticipationCeiling,
): ParticipationCeiling | undefined {
  const ceiling = entry?.participationCeiling;
  if (
    (recorded || entry?.inheritedToolPolicySource === "participant" || ceiling) &&
    !ceiling?.source
  ) {
    throw new Error(
      "Participant child authority is missing; start a new child from the invited session.",
    );
  }
  return intersectParticipationCeilings(recorded, ceiling);
}
