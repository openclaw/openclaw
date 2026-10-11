import { isPathInsideWithRealpath } from "@openclaw/fs-safe/path";
import type { OpenClawConfig } from "../../config/config.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { getAgentToolActionDescriptor } from "../agent-tool-metadata.js";
import type { OpenClawCodingToolsOptions } from "../agent-tools.options.js";
import { isCodeModeControlTool } from "../code-mode-control-tools.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { normalizeToolPolicyName } from "../tool-policy-shared.js";
import type { AnyAgentTool } from "../tools/common.js";
import { cloneHostSnapshot as cloneSnapshot } from "./host-snapshot.js";

export const WORKSPACE_TOOL_NAMES = Object.freeze([
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "find",
  "apply_patch",
  "view_image",
]);
const workspaceToolNames = new Set(WORKSPACE_TOOL_NAMES);
const nativeWorkspaceToolNames: Readonly<Record<string, string>> = {
  exec_command: "exec",
  write_stdin: "process",
  read_file: "read",
  list_dir: "ls",
  grep_files: "grep",
  glob: "find",
};

export function isWorkspaceToolName(name: string): boolean {
  const normalized = normalizeToolPolicyName(name);
  return workspaceToolNames.has(nativeWorkspaceToolNames[normalized] ?? normalized);
}

export function isWorkspaceTool(tool: AnyAgentTool): boolean {
  if (isCodeModeControlTool(tool)) {
    return false;
  }
  const operation = getAgentToolActionDescriptor(tool)?.operation;
  return (
    getPluginToolMeta(tool)?.workspaceAccess === true ||
    operation === "filesystem" ||
    operation === "process" ||
    isWorkspaceToolName(tool.name)
  );
}

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
