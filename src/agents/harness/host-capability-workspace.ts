import { isPathInsideWithRealpath } from "@openclaw/fs-safe/path";
import type { OpenClawConfig } from "../../config/config.js";
import type { OpenClawCodingToolsOptions } from "../agent-tools.options.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { cloneHostSnapshot as cloneSnapshot } from "./host-snapshot.js";

export function captureRequiredWorkspaceToolFloor(
  attempt: Partial<EmbeddedRunAttemptParams>,
  pluginId: string,
  config: OpenClawConfig | undefined,
):
  | {
      root: string;
      apply: (options?: OpenClawCodingToolsOptions) => Partial<OpenClawCodingToolsOptions>;
    }
  | undefined {
  if (attempt.requireWorkspaceOnly !== true) {
    return undefined;
  }
  const requiredWorkspace = {
    workspaceDir: attempt.workspaceDir,
    cwd: attempt.cwd ?? attempt.workspaceDir,
    root: attempt.sandbox?.enabled
      ? attempt.sandbox.workspaceDir
      : (attempt.sessionRoot ?? attempt.workspaceDir),
    sandbox: attempt.sandbox
      ? Object.freeze({
          ...attempt.sandbox,
          tools: cloneSnapshot(attempt.sandbox.tools),
        })
      : undefined,
    permissionMode: attempt.permissionMode,
  };
  if (!requiredWorkspace.workspaceDir || !requiredWorkspace.root) {
    throw new Error("required workspace tool surface has no captured root");
  }
  const root = requiredWorkspace.root;
  const apply = (options?: OpenClawCodingToolsOptions): Partial<OpenClawCodingToolsOptions> => {
    const requestedPermissionRoot = options?.sessionPermissionPolicy?.root;
    if (
      requestedPermissionRoot &&
      requestedPermissionRoot !== root &&
      !isPathInsideWithRealpath(root, requestedPermissionRoot)
    ) {
      throw new Error("tool permission root escapes the captured required workspace");
    }
    return {
      config,
      workspaceDir: requiredWorkspace.workspaceDir,
      cwd: requiredWorkspace.cwd,
      sandbox: requiredWorkspace.sandbox,
      requireWorkspaceOnly: true,
      sessionPermissionPolicy:
        requiredWorkspace.permissionMode || options?.sessionPermissionPolicy
          ? {
              root: requestedPermissionRoot ?? root,
              mode:
                requiredWorkspace.permissionMode === "read-only" ||
                options?.sessionPermissionPolicy?.mode === "read-only"
                  ? ("read-only" as const)
                  : (requiredWorkspace.permissionMode ?? options!.sessionPermissionPolicy!.mode),
            }
          : undefined,
      ...(pluginId === "codex"
        ? {
            // A host shell cwd is not a filesystem confinement boundary.
            exec: { ...options?.exec, mode: "deny" as const },
            toolConstructionPlan: {
              ...(options?.toolConstructionPlan ?? {
                includeBaseCodingTools: options?.includeCoreTools !== false,
                includeChannelTools: options?.includeCoreTools !== false,
                includeOpenClawTools: options?.includeCoreTools !== false,
                includePluginTools: true,
              }),
              includeShellTools: false,
            },
          }
        : {}),
    };
  };
  return { root, apply };
}
