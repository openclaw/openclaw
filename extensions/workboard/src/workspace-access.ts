// Workboard workspace access follows the caller's canonical filesystem boundary.
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-runtime";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/security-runtime";
import type { WorkboardWorkspace } from "./types.js";

export type WorkboardWorkspaceAccess =
  | { unrestricted: true }
  | { unrestricted: false; roots: readonly string[] };

type WorkboardConfig = NonNullable<OpenClawPluginToolContext["config"]>;

export function resolveWorkboardAgentWorkspace(config: WorkboardConfig, agentId?: string): string {
  return resolveAgentWorkspaceDir(config, agentId ?? resolveDefaultAgentId(config));
}

export function resolveConfiguredWorkboardWorkspaceAccess(params: {
  config: WorkboardConfig;
  unrestricted: boolean;
}): WorkboardWorkspaceAccess {
  if (params.unrestricted) {
    return { unrestricted: true };
  }
  return {
    unrestricted: false,
    roots: listAgentIds(params.config).map((agentId) =>
      resolveAgentWorkspaceDir(params.config, agentId),
    ),
  };
}

export function resolveAgentWorkboardWorkspaceAccess(params: {
  config: WorkboardConfig;
  agentId: string;
}): WorkboardWorkspaceAccess {
  const agentWorkspaceOnly = resolveAgentConfig(params.config, params.agentId)?.tools?.fs
    ?.workspaceOnly;
  const workspaceOnly = agentWorkspaceOnly ?? params.config.tools?.fs?.workspaceOnly;
  if (workspaceOnly !== true) {
    return { unrestricted: true };
  }
  return {
    unrestricted: false,
    roots: [resolveAgentWorkspaceDir(params.config, params.agentId)],
  };
}

export function resolveCommandWorkboardWorkspaceAccess(params: {
  config: WorkboardConfig;
  agentId?: string;
  gatewayClientScopes?: readonly string[];
}): WorkboardWorkspaceAccess {
  if (params.gatewayClientScopes) {
    return resolveConfiguredWorkboardWorkspaceAccess({
      config: params.config,
      unrestricted: params.gatewayClientScopes.includes("operator.admin"),
    });
  }
  return resolveAgentWorkboardWorkspaceAccess({
    config: params.config,
    agentId: params.agentId ?? resolveDefaultAgentId(params.config),
  });
}

export function resolveToolWorkboardWorkspaceAccess(
  context: OpenClawPluginToolContext | undefined,
): WorkboardWorkspaceAccess {
  if (!context?.sandboxed && context?.fsPolicy?.workspaceOnly !== true) {
    return { unrestricted: true };
  }
  return {
    unrestricted: false,
    roots: context.workspaceDir ? [context.workspaceDir] : [],
  };
}

export async function assertCanonicalWorkboardPathAccess(
  candidate: string,
  access: WorkboardWorkspaceAccess,
): Promise<string> {
  if (access.unrestricted) {
    return candidate;
  }
  for (const root of access.roots) {
    const canonicalRoot = await canonicalPathFromExistingAncestor(root);
    if (isPathInside(canonicalRoot, candidate)) {
      return candidate;
    }
  }
  throw new Error("workspace path is outside the caller's allowed workspaces.");
}

export async function assertCanonicalWorkboardRootAccess(
  candidate: string,
  access: WorkboardWorkspaceAccess,
): Promise<string> {
  if (access.unrestricted) {
    return candidate;
  }
  for (const root of access.roots) {
    const canonicalRoot = await canonicalPathFromExistingAncestor(root);
    if (canonicalRoot === candidate) {
      return candidate;
    }
  }
  throw new Error("workspace path must equal one of the caller's allowed workspace roots.");
}

async function assertPathAllowed(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const candidate = await canonicalPathFromExistingAncestor(value.trim());
  return await assertCanonicalWorkboardPathAccess(candidate, access);
}

async function assertWorkspaceAllowed(
  value: unknown,
  access: WorkboardWorkspaceAccess,
  options?: { sourceOnly?: boolean },
): Promise<string | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const workspace = value as Record<string, unknown>;
  if (options?.sourceOnly) {
    return await assertPathAllowed(workspace.sourcePath ?? workspace.path, access);
  }
  await assertPathAllowed(workspace.path, access);
  await assertPathAllowed(workspace.sourcePath, access);
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function assertWorkboardWorkspaceMutationAccess(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Promise<void> {
  if (access.unrestricted) {
    return;
  }
  const record = readRecord(value);
  if (!record) {
    return;
  }
  // Card creation and decomposition persist only explicit workspace fields;
  // board defaults and parent workspaces are metadata, not inherited inputs.
  await assertWorkspaceAllowed(record.workspace, access);
  await assertWorkspaceAllowed(record.defaultWorkspace, access);

  const patch = readRecord(record.patch);
  if (patch) {
    await assertWorkboardWorkspaceMutationAccess(patch, access);
  }
  const metadata = readRecord(record.metadata);
  const automation = readRecord(metadata?.automation);
  if (automation) {
    await assertWorkboardWorkspaceMutationAccess(automation, access);
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      await assertWorkboardWorkspaceMutationAccess(child, access);
    }
  }
}

export async function assertWorkboardWorkspaceSourceAccess(
  workspace: WorkboardWorkspace | undefined,
  access: WorkboardWorkspaceAccess,
): Promise<string | undefined> {
  return await assertWorkspaceAllowed(workspace, access, { sourceOnly: true });
}

export function guardWorkboardToolsForWorkspaceAccess(
  tools: AnyAgentTool[],
  context: OpenClawPluginToolContext | undefined,
): AnyAgentTool[] {
  const workspaceAccess = resolveToolWorkboardWorkspaceAccess(context);
  if (workspaceAccess.unrestricted) {
    return tools;
  }
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, rawParams, signal, onUpdate) => {
      await assertWorkboardWorkspaceMutationAccess(rawParams, workspaceAccess);
      return await tool.execute(toolCallId, rawParams, signal, onUpdate);
    },
  }));
}
