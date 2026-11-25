import {
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
  type ExecTarget,
  resolveExecPolicyForMode,
} from "../infra/exec-approvals-core.js";
import { maxAsk, minSecurity } from "../infra/exec-approvals-policy.js";
import {
  deniesExecAllowlistMisses,
  intersectExecPolicyCeilings,
  applyExecPolicyLayer,
} from "../infra/exec-policy.js";
import { participationPermission, type ParticipationCeiling } from "./participation-ceiling.js";
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
  policy: Pick<PreparedSessionPermissionPolicy, "mode" | "execPolicy">,
  overrides?: { mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk },
): { mode?: ExecMode; security: ExecSecurity; ask: ExecAsk } {
  const mode = resolveSessionPermissionExecMode(policy);
  const canonical = resolveExecPolicyForMode(mode);
  const base = policy.execPolicy ?? canonical;
  const override = overrides?.mode ? resolveExecPolicyForMode(overrides.mode) : base;
  // Overrides may tighten a session mode, never loosen it. Dispatch can echo
  // the session mode alongside explicit security/ask, so clamp both inputs.
  const security = minSecurity(
    base.security,
    minSecurity(override.security, overrides?.security ?? "full"),
  );
  const ask =
    policy.execPolicy &&
    base.security !== "full" &&
    base.ask === "off" &&
    override.ask !== "always" &&
    overrides?.ask !== "always"
      ? "off"
      : maxAsk(base.ask, maxAsk(override.ask, overrides?.ask ?? "off"));
  // Retaining a changed mode would make downstream normalization erase the tightening.
  return {
    mode: security === canonical.security && ask === canonical.ask ? mode : undefined,
    security,
    ask,
  };
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
export function applyExecModeCeiling<T extends ExecPolicyFields>(
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
  permissionPolicy?: Pick<PreparedSessionPermissionPolicy, "mode" | "execPolicy">;
  scheduledExecTarget?: ScheduledToolPolicyContext["execTarget"];
  /** `tools.byProvider[...].exec.mode` entries for the turn's model; applied after every other layer. */
  modelExecCeilings?: readonly ExecMode[];
  participationCeiling?: ParticipationCeiling;
}) {
  const ceilings = params.participationCeiling
    ? [
        ...(params.modelExecCeilings ?? []),
        resolveSessionPermissionExecMode({
          mode: participationPermission(params.participationCeiling),
        }),
      ]
    : (params.modelExecCeilings ?? []);
  const policy = ceilings.reduce<ExecPolicyFields>(
    (current, ceiling) => applyExecModeCeiling(current, ceiling),
    params.permissionPolicy
      ? resolveSessionPermissionExecPolicy(params.permissionPolicy, params.overrides)
      : applyExecPolicyLayer(params.base, params.overrides),
  );
  const exact = params.participationCeiling?.execPolicy
    ? intersectExecPolicyCeilings(
        { security: policy.security ?? "full", ask: policy.ask ?? "off" },
        params.participationCeiling.execPolicy,
      )!
    : policy;
  const canonical = policy.mode ? resolveExecPolicyForMode(policy.mode) : undefined;
  const mode = params.participationCeiling?.execPolicy
    ? canonical?.security === exact.security && canonical?.ask === exact.ask
      ? policy.mode
      : undefined
    : policy.mode;
  const target = params.scheduledExecTarget;
  const host = params.overrides?.host ?? params.base.host;
  return {
    host: host === undefined || host === "auto" ? (target?.host ?? host) : host,
    mode: target?.ask ? undefined : mode,
    security: exact.security,
    ask: target?.ask ?? exact.ask,
    participationDenyMisses:
      params.participationCeiling !== undefined &&
      (deniesExecAllowlistMisses(params.participationCeiling.execPolicy) ||
        deniesExecAllowlistMisses(params.permissionPolicy?.execPolicy)),
    bypassHostApprovalFloors:
      !params.participationCeiling &&
      target?.ask !== "always" &&
      params.permissionPolicy?.mode === "full" &&
      policy.security === "full",
  };
}
