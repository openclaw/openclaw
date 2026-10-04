import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import type { SandboxContext } from "./sandbox/types.js";
import type { PreparedSessionPermissionPolicy } from "./tool-fs-policy.js";
import type { WorkspaceSandboxParams } from "./workspace-sandbox.js";

export type RootedExecutionRequest = Readonly<{ root: string }>;

/** Prepared by the host and retained outside child-visible MCP request context. */
export type PreparedRootedExecutionCapability = Readonly<{
  root: string;
  workspaceDir: string;
  cwd: string;
  requireWorkspaceOnly: true;
  sandbox: SandboxContext | null;
  sessionPermissionPolicy?: PreparedSessionPermissionPolicy;
}>;

/**
 * Sandbox prepared by the host for an ordinary (non-rooted) sandboxed CLI run.
 * Retained outside child-visible MCP request context, like the rooted capability,
 * so loopback coding tools execute against the session's real sandbox filesystem.
 */
export type PreparedSandboxExecutionCapability = Readonly<{ sandbox: SandboxContext }>;

/** Resolve the session's sandbox for mediated coding tools; undefined when it is not sandboxed. */
export async function prepareSandboxExecutionCapability(
  params: Omit<
    WorkspaceSandboxParams,
    "sessionRoot" | "requireWritableSandbox" | "requireWorkspaceOnly"
  >,
): Promise<PreparedSandboxExecutionCapability | undefined> {
  const { resolveAttemptWorkspaceSandbox } = await import("./workspace-sandbox.js");
  const workspace = await resolveAttemptWorkspaceSandbox(params);
  return workspace.sandbox?.enabled ? Object.freeze({ sandbox: workspace.sandbox }) : undefined;
}

export async function prepareRootedExecutionCapability(
  params: Omit<
    WorkspaceSandboxParams,
    "workspaceDir" | "cwd" | "sessionRoot" | "requireWritableSandbox" | "requireWorkspaceOnly"
  > & { rootedExecution: RootedExecutionRequest },
): Promise<PreparedRootedExecutionCapability> {
  const { resolveAttemptWorkspaceSandbox } = await import("./workspace-sandbox.js");
  const workspace = await resolveAttemptWorkspaceSandbox({
    ...params,
    workspaceDir: params.rootedExecution.root,
    cwd: params.rootedExecution.root,
    sessionRoot: params.rootedExecution.root,
    requireWritableSandbox: true,
    requireWorkspaceOnly: true,
  });
  return Object.freeze({
    root: workspace.resolvedWorkspace,
    workspaceDir: workspace.effectiveWorkspace,
    cwd: workspace.effectiveCwd,
    requireWorkspaceOnly: true,
    sandbox: workspace.sandbox,
    sessionPermissionPolicy: workspace.sessionPermissionPolicy,
  });
}

/** Root file tools at the task directory without widening the operator's shell policy. */
export function rootedAgentRunParams(workspaceDir: string, executionRoot?: string) {
  return {
    workspaceDir: executionRoot ?? workspaceDir,
    bootstrapWorkspaceDir: workspaceDir,
    cwd: executionRoot,
    sessionRoot: executionRoot,
    requireWritableSandbox: executionRoot ? true : undefined,
    requireWorkspaceOnly: executionRoot ? true : undefined,
  } satisfies Partial<RunEmbeddedAgentParams>;
}
