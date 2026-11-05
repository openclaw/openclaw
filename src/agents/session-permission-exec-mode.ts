import {
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
  type ExecTarget,
  resolveExecModeFromPolicy,
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

// Strictest first; matches the documented permission-mode ladder.
const EXEC_MODE_RANK = {
  deny: 0,
  allowlist: 1,
  ask: 2,
  auto: 3,
  full: 4,
} as const satisfies Record<ExecMode, number>;

/** Pick the strictest configured model ceiling, if any. */
export function strictestExecMode(modes: readonly (ExecMode | undefined)[]): ExecMode | undefined {
  let strictest: ExecMode | undefined;
  for (const mode of modes) {
    if (mode && (!strictest || EXEC_MODE_RANK[mode] < EXEC_MODE_RANK[strictest])) {
      strictest = mode;
    }
  }
  return strictest;
}

/**
 * A model ceiling acts like that configured mode whenever it is stricter.
 * Unset security resolves to unrestricted host exec downstream, so it ranks as full.
 */
function applyExecModeCeiling<
  T extends { mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk },
>(
  policy: T,
  ceiling: ExecMode | undefined,
): T | { mode: ExecMode; security: ExecSecurity; ask: ExecAsk } {
  if (!ceiling) {
    return policy;
  }
  const current =
    policy.mode ??
    (policy.security
      ? resolveExecModeFromPolicy({ security: policy.security, ask: policy.ask ?? "off" })
      : "full");
  if (EXEC_MODE_RANK[current] <= EXEC_MODE_RANK[ceiling]) {
    return policy;
  }
  const { security, ask } = resolveExecPolicyForMode(ceiling);
  return { mode: ceiling, security, ask };
}

/** Pure final projection shared by local tool construction and worker dispatch. */
export function projectEffectiveExecPolicy(params: {
  base: { host?: ExecTarget; mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk };
  overrides?: { host?: ExecTarget; mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk };
  permissionPolicy?: Pick<PreparedSessionPermissionPolicy, "mode">;
  scheduledExecTarget?: ScheduledToolPolicyContext["execTarget"];
  /** `tools.byProvider[...].exec.mode` for the turn's model; applied after every other layer. */
  modelExecCeiling?: ExecMode;
}) {
  const policy = applyExecModeCeiling(
    params.permissionPolicy
      ? resolveSessionPermissionExecPolicy(params.permissionPolicy, params.overrides)
      : applyExecPolicyLayer(params.base, params.overrides),
    params.modelExecCeiling,
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
