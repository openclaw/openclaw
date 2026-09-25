import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredApplyPatchPolicy } from "./apply-patch-policy.js";
import type { ExecElevatedDefaults } from "./bash-tools.exec-types.js";
import {
  resolveExecConfigState,
  type ExecPolicyOverrides,
  type ExecSessionDefaults,
} from "./exec-defaults.js";
import type { DelegatedToolParameterFacts } from "./inherited-tool-parameters.js";
import { resolveExecToolConfig } from "./lazy-exec-tool.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import type { SandboxWorkspaceAccess } from "./sandbox/types.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import {
  projectEffectiveExecPolicy,
  resolveSessionPermissionCoreToolPolicy,
} from "./session-permission-exec-mode.js";
import { resolveToolFsConfig, type PreparedSessionPermissionPolicy } from "./tool-fs-policy.js";

/** Resource-free prospective projection; callers supply owner-prepared session/placement facts. */
export function prepareDelegatedToolParameterTarget(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionPermissionPolicy: PreparedSessionPermissionPolicy | undefined;
  sessionEntry: ExecSessionDefaults | null;
  rootIsWorkspace: boolean;
  execOverrides?: ExecPolicyOverrides;
  scheduledExecTarget?: ScheduledToolPolicyContext["execTarget"];
  elevated: ExecElevatedDefaults | null;
  sandbox: {
    sandboxed: boolean;
    sandboxRequired: boolean;
    workspaceAccess?: SandboxWorkspaceAccess;
  };
  modelProvider?: string;
  modelId?: string;
  requireWorkspaceOnly?: boolean;
}): DelegatedToolParameterFacts {
  const execConfig = resolveExecToolConfig({ cfg: params.config, agentId: params.agentId });
  const fsConfig = resolveToolFsConfig({ cfg: params.config, agentId: params.agentId });
  const session = params.sessionPermissionPolicy
    ? resolveSessionPermissionCoreToolPolicy(params.sessionPermissionPolicy)
    : undefined;
  const workspaceOnly =
    params.requireWorkspaceOnly === true ||
    (session?.workspaceOnly ?? fsConfig.workspaceOnly === true);
  const readOnly = session?.readOnly ?? false;
  const patch = resolveConfiguredApplyPatchPolicy({
    config: execConfig.applyPatch,
    workspaceOnly,
    readOnly,
    requireWorkspaceOnly: params.requireWorkspaceOnly === true,
    sessionPolicy: session,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const sandboxConfig = resolveSandboxConfigForAgent(params.config, params.agentId);
  const execState = resolveExecConfigState({
    cfg: params.config,
    agentId: params.agentId,
    sessionEntry: params.sessionEntry ?? undefined,
    execOverrides: params.execOverrides,
  });
  return {
    exec: {
      ...execConfig,
      ...params.execOverrides,
      ...projectEffectiveExecPolicy({
        base: { ...execConfig, host: execState.host },
        overrides: params.execOverrides,
        permissionPolicy: params.sessionPermissionPolicy,
        scheduledExecTarget: params.scheduledExecTarget,
      }),
      node: params.execOverrides?.node ?? params.sessionEntry?.execNode ?? execConfig.node,
      nodeCwd: params.sessionEntry?.execCwd,
      elevated: params.elevated ?? undefined,
      sandboxRequired: params.sandbox.sandboxRequired,
    },
    fileTools: {
      workspaceOnly,
      readOnly,
      configuredApplyPatchEnabled: execConfig.applyPatch?.enabled !== false,
      applyPatchEnabled: patch.applyPatchEnabled,
      applyPatchWorkspaceOnly: patch.applyPatchWorkspaceOnly,
      applyPatchAllowModels: execConfig.applyPatch?.allowModels,
      rootIsWorkspace: params.rootIsWorkspace,
    },
    sandbox: {
      sandboxed: params.sandbox.sandboxed,
      config: params.sandbox.workspaceAccess
        ? { ...sandboxConfig, workspaceAccess: params.sandbox.workspaceAccess }
        : sandboxConfig,
    },
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  };
}
