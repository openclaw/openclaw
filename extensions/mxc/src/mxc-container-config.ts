import { statSync } from "node:fs";
import path from "node:path";
import type { ContainerRequest, FilesystemPolicy } from "@microsoft/mxc-sdk/v1";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import type { MxcConfig } from "./config.js";
import { normalizeMxcPathForComparison } from "./path-comparison.js";
import { resolveBaselineReadonlyPaths, type BaselineHostEnv } from "./sandbox-baseline.js";
import type {
  LoadedSandboxBaselinePolicy,
  SandboxConfiguredPathEntry,
} from "./sandbox-policy-loader.js";
import { buildCommandLine } from "./windows-command.js";
import { normalizeWindowsProcessEnvRecord } from "./windows-env.js";
import {
  resolveMxcReadOnlySkillMounts,
  type MxcWorkspaceAccess,
} from "./workspace-skill-mounts.js";

type FilesystemPathSpec = {
  path: string;
  required: boolean;
  sources?: readonly string[];
};

type BaselineApplicationContext = {
  projectDir: string;
  hostEnv: BaselineHostEnv;
};

type MxcWorkspaceContext = {
  workspaceDir: string;
  agentWorkspaceDir: string;
  activeWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: MxcWorkspaceAccess;
};

export function resolveCurrentBaselineContext(projectDir: string): BaselineApplicationContext {
  return {
    projectDir: path.resolve(projectDir),
    hostEnv: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ProgramFiles: process.env.ProgramFiles,
      ProgramW6432: process.env.ProgramW6432,
      "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  };
}

export function resolveMxcWorkspaceContext(params: {
  workdir: string;
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: MxcWorkspaceAccess;
}): MxcWorkspaceContext {
  const workspaceAccess = params.workspaceAccess ?? "rw";
  const workspaceDir = path.resolve(params.workdir);
  const agentWorkspaceDir = path.resolve(params.agentWorkspaceDir ?? params.workdir);
  return {
    workspaceDir,
    agentWorkspaceDir,
    activeWorkspaceDir: workspaceAccess === "rw" ? agentWorkspaceDir : workspaceDir,
    ...(params.skillsWorkspaceDir
      ? { skillsWorkspaceDir: path.resolve(params.skillsWorkspaceDir) }
      : {}),
    workdir: workspaceDir,
    workspaceAccess,
  };
}

export function resolveMxcRuntimeWorkdir(
  workspace: MxcWorkspaceContext,
  requestedWorkdir: string,
): string {
  if (workspace.workspaceAccess !== "rw") {
    return path.resolve(requestedWorkdir);
  }

  const relativePath = path.relative(workspace.workspaceDir, requestedWorkdir);
  return relativePath === ""
    ? workspace.activeWorkspaceDir
    : path.join(workspace.activeWorkspaceDir, relativePath);
}

export function buildMxcContainerRequest(params: {
  config: MxcConfig;
  baseline: LoadedSandboxBaselinePolicy;
  baselineContext: BaselineApplicationContext;
  containerName: string;
  command: string;
  args?: readonly string[];
  sandboxTempDir: string;
  workdir: string;
  workspace: MxcWorkspaceContext;
  env: Record<string, string>;
}): ContainerRequest {
  const networkAllowed = params.config.network === "default";
  const filesystem = buildFilesystemPolicy({
    baseline: params.baseline,
    context: params.baselineContext,
    sandboxTempDir: params.sandboxTempDir,
    workspace: params.workspace,
  });

  const environment = normalizeWindowsProcessEnvRecord({
    ...params.env,
    TEMP: params.sandboxTempDir,
    TMP: params.sandboxTempDir,
  });

  return {
    command: buildCommandLine(params.command, params.args ?? []),
    workingDirectory: params.workdir,
    // A supplied environment replaces the OS default block, so host
    // variables outside the minimal Windows defaults never reach the child.
    environment,
    inheritDefaultEnvironment: false,
    timeoutMs: resolveProcessTimeoutSeconds(params.config, params.baseline) * 1000,
    containerName: params.containerName,
    // Both configured containments have always meant the Windows
    // ProcessContainer backend; only the explicit form accepts its UI block.
    containment: {
      type: "processcontainer",
      config: {
        ui: {
          isolation: "container",
          desktopSystemControl: false,
          systemSettings: "none",
          ime: false,
        },
      },
    },
    filesystem,
    ui: {
      disable: true,
      clipboard: "none",
      allowInputInjection: false,
    },
    // MXC derives the internetClient capability from egress; ingress and
    // host loopback stay denied in both modes.
    network: {
      egress: { default: networkAllowed ? "allow" : "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
    },
  };
}

function buildFilesystemPolicy(params: {
  baseline: LoadedSandboxBaselinePolicy;
  context: BaselineApplicationContext;
  sandboxTempDir: string;
  workspace: MxcWorkspaceContext;
}): FilesystemPolicy {
  const readwritePathSpecs: FilesystemPathSpec[] = [];
  const readonlyPathSpecs: FilesystemPathSpec[] = [];
  const workspace = params.workspace;
  if (workspace.workspaceAccess === "rw") {
    readwritePathSpecs.push(requiredFilesystemPath(workspace.activeWorkspaceDir));
  } else {
    readonlyPathSpecs.push(requiredFilesystemPath(workspace.workspaceDir));
    if (
      workspace.workspaceAccess === "ro" &&
      normalizeMxcPathForComparison(workspace.agentWorkspaceDir) !==
        normalizeMxcPathForComparison(workspace.workspaceDir)
    ) {
      readonlyPathSpecs.push(requiredFilesystemPath(workspace.agentWorkspaceDir));
    }
  }
  readonlyPathSpecs.push(
    ...resolveBaselineReadonlyPaths(params.context.hostEnv).map(optionalFilesystemPath),
    ...params.baseline.configuredPaths.readonlyPaths.map(createConfiguredFilesystemPath),
    ...resolveMxcProtectedSkillPolicyPaths(workspace).map(optionalFilesystemPath),
  );

  // Policy admission accepts only restrictToProjectDir=true.
  const projectDirPath = params.context.projectDir;
  if (params.workspace.workspaceAccess === "rw") {
    readwritePathSpecs.push(requiredFilesystemPath(projectDirPath));
  } else {
    readonlyPathSpecs.push(requiredFilesystemPath(projectDirPath));
  }
  readwritePathSpecs.push(requiredFilesystemPath(params.sandboxTempDir));
  readwritePathSpecs.push(
    ...params.baseline.configuredPaths.readwritePaths.map(createConfiguredFilesystemPath),
  );

  const protectedSkillPolicyPaths = resolveMxcProtectedSkillPolicyPaths(params.workspace);
  // ProcessContainer writable-parent grants override nested read-only grants.
  // Fail closed instead of claiming protected skill overlays are enforceable.
  assertNoMxcReadwriteReadonlyOverlap({
    readwritePaths: resolveExistingFilesystemPaths(readwritePathSpecs, "readwrite"),
    readonlyPaths: protectedSkillPolicyPaths,
  });

  const readonlyPaths = resolveExistingFilesystemPaths(readonlyPathSpecs, "read-only");
  const readwritePaths = resolveExistingFilesystemPaths(readwritePathSpecs, "readwrite");
  assertNoMxcReadwriteReadonlyOverlap({ readwritePaths, readonlyPaths });

  return {
    readonlyPaths,
    readwritePaths,
    clearPolicyOnExit: true,
  };
}

function resolveMxcProtectedSkillPolicyPaths(context: MxcWorkspaceContext): string[] {
  const deduped = new Map<string, string>();
  for (const mount of resolveMxcReadOnlySkillMounts(context)) {
    const hostPath = path.resolve(mount.hostPath);
    deduped.set(normalizeMxcPathForComparison(hostPath), hostPath);
    const containerPath = path.resolve(mount.containerPath);
    deduped.set(normalizeMxcPathForComparison(containerPath), containerPath);
  }
  return [...deduped.values()];
}

function resolveExistingFilesystemPaths(
  pathSpecs: readonly FilesystemPathSpec[],
  accessLabel: "read-only" | "readwrite",
): string[] {
  const deduped = new Map<
    string,
    {
      path: string;
      required: boolean;
      sources: Set<string>;
    }
  >();

  for (const pathSpec of pathSpecs) {
    const key = normalizeMxcPathForComparison(pathSpec.path);
    const existing = deduped.get(key);
    if (existing) {
      existing.required ||= pathSpec.required;
      for (const source of pathSpec.sources ?? []) {
        existing.sources.add(source);
      }
      continue;
    }

    deduped.set(key, {
      path: pathSpec.path,
      required: pathSpec.required,
      sources: new Set(pathSpec.sources ?? []),
    });
  }

  const resolvedPaths: string[] = [];
  for (const pathSpec of deduped.values()) {
    if (hostPathExists(pathSpec.path)) {
      resolvedPaths.push(pathSpec.path);
      continue;
    }
    if (!pathSpec.required) {
      continue;
    }
    throw new Error(
      buildMissingFilesystemPathMessage(pathSpec.path, accessLabel, pathSpec.sources),
    );
  }
  return resolvedPaths;
}

function requiredFilesystemPath(pathValue: string): FilesystemPathSpec {
  return {
    path: path.resolve(pathValue),
    required: true,
  };
}

function optionalFilesystemPath(pathValue: string): FilesystemPathSpec {
  return {
    path: path.resolve(pathValue),
    required: false,
  };
}

function createConfiguredFilesystemPath(pathEntry: SandboxConfiguredPathEntry): FilesystemPathSpec {
  return {
    path: path.resolve(pathEntry.path),
    required: true,
    sources: pathEntry.sources,
  };
}

function buildMissingFilesystemPathMessage(
  pathValue: string,
  accessLabel: "read-only" | "readwrite",
  sources: ReadonlySet<string>,
): string {
  const sourceLabel = [...sources].join(", ");
  if (sourceLabel) {
    return (
      `MXC sandbox ${accessLabel} path ${pathValue} configured by ${sourceLabel} ` +
      `is missing on the host. Recreate the path or update the policy file before launching the sandbox.`
    );
  }
  return `MXC sandbox ${accessLabel} path ${pathValue} does not exist on the host.`;
}

function resolveProcessTimeoutSeconds(
  config: MxcConfig,
  baseline: LoadedSandboxBaselinePolicy,
): number {
  if (config.timeoutSecondsConfigured === true) {
    return Math.min(config.timeoutSeconds, baseline.process.timeoutSeconds);
  }
  return baseline.process.timeoutSeconds;
}

function assertNoMxcReadwriteReadonlyOverlap(params: {
  readwritePaths: readonly string[];
  readonlyPaths: readonly string[];
}): void {
  for (const readwritePath of params.readwritePaths) {
    for (const readonlyPath of params.readonlyPaths) {
      if (pathsOverlap(readwritePath, readonlyPath)) {
        throw new Error(
          `MXC readwrite path ${readwritePath} overlaps read-only path ${readonlyPath}. Windows MXC cannot safely enforce nested read-only overlays under writable paths.`,
        );
      }
    }
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const left = normalizeMxcPathForComparison(first);
  const right = normalizeMxcPathForComparison(second);
  return isPathInside(left, right) || isPathInside(right, left);
}

function hostPathExists(candidatePath: string): boolean {
  try {
    statSync(candidatePath);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err) {
      return false;
    }
    throw err;
  }
}
