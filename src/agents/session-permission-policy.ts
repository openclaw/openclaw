import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { resolveExecDefaultsAsync, type ExecPolicyOverrides } from "./exec-defaults.js";
import { SESSION_PERMISSION_BY_EXEC_MODE } from "./session-permission-exec-mode.js";
import type { PreparedSessionPermissionPolicy } from "./tool-fs-policy.types.js";

/** Native turns and compaction share the same bounded participant permission policy. */
export async function prepareRunSessionPermissionPolicy(params: {
  pluginExecutionAuthority?: AdmittedRunOperatorAuthority;
  root: string;
  mode?: SessionPermissionMode;
  config?: OpenClawConfig;
  agentId: string;
  sandboxAvailable: boolean;
  execOverrides?: ExecPolicyOverrides;
}): Promise<PreparedSessionPermissionPolicy | undefined> {
  const participationCeiling = params.pluginExecutionAuthority?.participationCeiling;
  if (!participationCeiling) {
    return params.mode ? { root: params.root, mode: params.mode } : undefined;
  }
  const exec = await resolveExecDefaultsAsync({
    cfg: params.config,
    agentId: params.agentId,
    sessionEntry: { permissionMode: params.mode },
    sandboxAvailable: params.sandboxAvailable,
    execOverrides: params.execOverrides,
    participationCeiling,
  });
  return {
    root: params.root,
    mode: SESSION_PERMISSION_BY_EXEC_MODE[exec.mode],
    sourceMode: params.mode,
    execPolicy: {
      security: exec.security,
      ask: exec.ask,
      ...(exec.denyMisses ? { denyMisses: true } : {}),
    },
  };
}
