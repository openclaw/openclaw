import {
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
  type ExecTarget,
  resolveExecPolicyForMode,
} from "../infra/exec-approvals-core.js";
import { maxAsk, minSecurity } from "../infra/exec-approvals-policy.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import type { PreparedSessionPermissionPolicy } from "./tool-fs-policy.types.js";

const EXEC_MODE_BY_PERMISSION_MODE = {
  "read-only": "deny",
  guarded: "ask",
  workspace: "auto",
  full: "full",
} as const satisfies Record<PreparedSessionPermissionPolicy["mode"], ExecMode>;

export const SESSION_PERMISSION_BY_EXEC_MODE = {
  deny: "read-only",
  allowlist: "guarded",
  ask: "guarded",
  auto: "workspace",
  full: "full",
} as const satisfies Record<ExecMode, PreparedSessionPermissionPolicy["mode"]>;

/** A retained mode is a ceiling; unset mode keeps config and host approval policy. */
export function intersectSessionPermissionModes(
  retained: PreparedSessionPermissionPolicy["mode"] | undefined,
  current: PreparedSessionPermissionPolicy["mode"] | undefined,
): PreparedSessionPermissionPolicy["mode"] | undefined {
  if (retained === current) {
    return retained;
  }
  if (retained === "read-only" || current === "read-only") {
    return "read-only";
  }
  if (retained === "full") {
    return current;
  }
  if (current === "full") {
    return retained;
  }
  if (retained === undefined || current === undefined) {
    throw new Error(
      "The session changed between default and explicit permissions; start a new turn under the current policy.",
    );
  }
  return retained === "guarded" || current === "guarded" ? "guarded" : "workspace";
}

export function resolveSessionPermissionCoreToolPolicy(
  policy: Pick<PreparedSessionPermissionPolicy, "mode">,
) {
  const workspaceOnly = policy.mode !== "full";
  return {
    workspaceOnly,
    readOnly: policy.mode === "read-only",
    applyPatchWorkspaceOnly: workspaceOnly,
    execMode: EXEC_MODE_BY_PERMISSION_MODE[policy.mode],
    bypassHostApprovalFloors: policy.mode === "full",
  };
}

export function resolveSessionPermissionExecMode(
  policy: Pick<PreparedSessionPermissionPolicy, "mode">,
): ExecMode {
  return resolveSessionPermissionCoreToolPolicy(policy).execMode;
}

export function resolveSessionPermissionExecPolicy(
  policy: Pick<PreparedSessionPermissionPolicy, "mode">,
  overrides?: { mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk },
): { mode?: ExecMode; security: ExecSecurity; ask: ExecAsk } {
  const mode = resolveSessionPermissionExecMode(policy);
  const base = resolveExecPolicyForMode(mode);
  const override = overrides?.mode ? resolveExecPolicyForMode(overrides.mode) : base;
  // Overrides may tighten a session mode, never loosen it. Dispatch can echo
  // the session mode alongside explicit security/ask, so clamp both inputs.
  const security = minSecurity(
    base.security,
    minSecurity(override.security, overrides?.security ?? "full"),
  );
  const ask = maxAsk(base.ask, maxAsk(override.ask, overrides?.ask ?? "off"));
  // Retaining a changed mode would make downstream normalization erase the tightening.
  return { mode: security === base.security && ask === base.ask ? mode : undefined, security, ask };
}

type ExecPolicyFields = { mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk };

/**
 * Model ceilings only restrict. Security takes the minimum. Ask takes the maximum,
 * except that when either side denies allowlist misses (non-full security, ask
 * off) misses stay denied; a mandatory `always` is never dropped. Unset fields
 * mean unrestricted host exec downstream. The ceiling's canonical mode is used
 * only when it describes the result exactly; otherwise raw fields stay so mode
 * normalization cannot loosen them, and human `ask` outranks reviewer `auto`.
 */
function applyExecModeCeiling<T extends ExecPolicyFields>(
  policy: T,
  ceiling: ExecMode,
): T | ExecPolicyFields {
  const cap = resolveExecPolicyForMode(ceiling);
  const current = { security: policy.security ?? "full", ask: policy.ask ?? "off" };
  const security = minSecurity(current.security, cap.security);
  const deniesMisses = (p: { security: ExecSecurity; ask: ExecAsk }) =>
    p.security !== "full" && p.ask === "off";
  const ask =
    current.ask !== "always" && (deniesMisses(current) || deniesMisses(cap))
      ? "off"
      : maxAsk(current.ask, cap.ask);
  if (security === current.security && ask === current.ask) {
    return policy.mode === "auto" && ceiling === "ask" ? { ...policy, mode: "ask" } : policy;
  }
  return {
    mode: security === cap.security && ask === cap.ask ? ceiling : undefined,
    security,
    ask,
  };
}

/** Pure final projection shared by local tool construction and worker dispatch. */
export function projectEffectiveExecPolicy(params: {
  base: { host?: ExecTarget; mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk };
  overrides?: { host?: ExecTarget; mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk };
  permissionPolicy?: Pick<PreparedSessionPermissionPolicy, "mode">;
  scheduledExecTarget?: ScheduledToolPolicyContext["execTarget"];
  /** `tools.byProvider[...].exec.mode` entries for the turn's model; applied after every other layer. */
  modelExecCeilings?: readonly ExecMode[];
}) {
  const policy = (params.modelExecCeilings ?? []).reduce<ExecPolicyFields>(
    (current, ceiling) => applyExecModeCeiling(current, ceiling),
    params.permissionPolicy
      ? resolveSessionPermissionExecPolicy(params.permissionPolicy, params.overrides)
      : applyExecPolicyLayer(params.base, params.overrides),
  );
  const target = params.scheduledExecTarget;
  const host = params.overrides?.host ?? params.base.host;
  return {
    host: host === undefined || host === "auto" ? (target?.host ?? host) : host,
    mode: target?.ask ? undefined : policy.mode,
    security: policy.security,
    ask: target?.ask ?? policy.ask,
    bypassHostApprovalFloors:
      target?.ask !== "always" &&
      params.permissionPolicy?.mode === "full" &&
      policy.security === "full",
  };
}
