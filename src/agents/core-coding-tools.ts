import fs from "node:fs";
import path from "node:path";
import { root as fsRoot } from "../infra/fs-safe.js";
import type { SkillSnapshot } from "../skills/types.js";
import { bindAgentToolActionDescriptor } from "./agent-tool-metadata.js";
import {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  createOpenClawReadTool,
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  resolveAdaptiveReadMaxBytes,
  type SkillInstructionDeliveryCache,
  wrapReadToolWithSkillContent,
  wrapToolWorkspaceRootGuardWithOptions,
  wrapSandboxFileToolPath,
} from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import type { ApplyPatchContainmentSource } from "./apply-patch-containment-hint.js";
import { createApplyPatchTool } from "./apply-patch.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import type { ProcessToolDefaults } from "./bash-tools.process.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import { createLazyProcessTool } from "./lazy-process-tool.js";
import type { MemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import { relativePathInsideSandboxRoot } from "./path-policy.js";
import type { SandboxContext } from "./sandbox.js";
import { buildSandboxFsMounts } from "./sandbox/fs-paths.js";
import { resolveReadOnlyWorkspaceSkillMounts } from "./sandbox/workspace-mounts.js";
import { createLsTool, type LsOperations } from "./sessions/tools/ls.js";
import { createReadTool } from "./sessions/tools/read.js";
import { resolveToolResultBudget } from "./tool-result-limits.js";

function resolveSkillReadRoots(skills?: SkillSnapshot["resolvedSkills"]): string[] | undefined {
  const roots = new Set<string>();
  for (const skill of skills ?? []) {
    const baseDir = typeof skill.baseDir === "string" ? skill.baseDir.trim() : "";
    const filePath = typeof skill.filePath === "string" ? skill.filePath.trim() : "";
    const root = baseDir || (filePath ? path.dirname(filePath) : "");
    if (!root || !path.isAbsolute(root)) {
      continue;
    }
    roots.add(path.resolve(root));
  }
  return roots.size > 0 ? Array.from(roots) : undefined;
}

function guardHostWorkspaceTool(
  tool: AnyAgentTool,
  options: Pick<CoreCodingToolsOptions, "codingRoot" | "containmentRoot">,
): AnyAgentTool {
  return wrapToolWorkspaceRootGuardWithOptions(tool, options.containmentRoot, {
    resolutionCwd: options.codingRoot,
    normalizeGuardedPathParams: true,
  });
}

type CoreCodingToolsOptions = {
  abortSignal?: AbortSignal;
  attachmentReadRoot?: string;
  codingRoot: string;
  containmentRoot: string;
  includeBaseCodingTools: boolean;
  shellTools: "disabled" | "patch-only" | "full";
  workspaceOnly: boolean;
  readOnly: boolean;
  sandbox?: SandboxContext;
  skillsSnapshot?: SkillSnapshot;
  skillReadResources?: SkillSnapshot["resolvedSkills"];
  skillInstructionPaths?: readonly string[];
  skillInstructionDeliveryCache?: SkillInstructionDeliveryCache;
  modelContextWindowTokens?: number;
  imageSanitization?: ImageSanitizationLimits;
  modelHasVision?: boolean;
  memoryWriteProvenance?: MemoryWriteProvenanceObserver;
  applyPatchEnabled: boolean;
  applyPatchWorkspaceOnly: boolean;
  applyPatchContainmentSource?: ApplyPatchContainmentSource;
  execDefaults: ExecToolDefaults;
  processDefaults: ProcessToolDefaults;
  recordToolPrepStage?: (name: string) => void;
};

/** Materialize only the core file and shell families selected by the runtime owner. */
export function createCoreCodingTools(options: CoreCodingToolsOptions): AnyAgentTool[] {
  const sandbox = options.sandbox;
  const sandboxRoot = sandbox?.workspaceDir;
  const sandboxFsBridge = sandbox?.fsBridge;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  if (
    sandboxRoot &&
    !sandboxFsBridge &&
    (options.includeBaseCodingTools || options.shellTools !== "disabled")
  ) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }

  const skillReadResources = options.skillReadResources ?? options.skillsSnapshot?.resolvedSkills;
  const skillReadRoots = sandboxRoot ? undefined : resolveSkillReadRoots(skillReadResources);
  const attachmentReadRoot = !sandboxRoot ? options.attachmentReadRoot : undefined;
  const hostReadRoots = [
    ...(skillReadRoots ?? []),
    ...(attachmentReadRoot && fs.existsSync(attachmentReadRoot) ? [attachmentReadRoot] : []),
  ];
  const needsReadOnlyWorkspaceSkillMounts =
    options.shellTools !== "disabled" || (options.includeBaseCodingTools && options.workspaceOnly);
  const readOnlyWorkspaceSkillMounts =
    sandbox && needsReadOnlyWorkspaceSkillMounts
      ? resolveReadOnlyWorkspaceSkillMounts({
          workspaceDir: sandbox.workspaceDir,
          agentWorkspaceDir: sandbox.agentWorkspaceDir,
          skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
          workdir: sandbox.containerWorkdir,
          workspaceAccess: sandbox.workspaceAccess,
        })
      : [];

  // Older external SDK bridges predate pathMappings. Only absence selects
  // their reconstructed admission; a supplied empty table is authoritative.
  const sandboxFileMounts =
    sandbox &&
    ((options.includeBaseCodingTools && options.workspaceOnly) ||
      (options.shellTools !== "disabled" &&
        options.applyPatchEnabled &&
        options.applyPatchWorkspaceOnly))
      ? (sandboxFsBridge?.pathMappings ?? buildSandboxFsMounts(sandbox))
      : [];
  const sandboxWorkspaceMounts = sandbox
    ? sandboxFileMounts.filter(
        (mount) =>
          relativePathInsideSandboxRoot(sandbox.containerWorkdir, mount.containerRoot) !== null,
      )
    : [];
  // Declared mount read exceptions do not grant writes or enumeration outside
  // the container workspace. Both sets reuse the same effective selection.
  const sandboxReadMounts = sandboxFileMounts;

  const base: AnyAgentTool[] = [];
  if (options.includeBaseCodingTools) {
    const readDirectory = sandboxFsBridge?.readDirectory?.bind(sandboxFsBridge);
    const listingOperations: LsOperations | undefined = readDirectory
      ? {
          readDirectory: (filePath, signal) =>
            readDirectory({ filePath, cwd: sandbox?.containerWorkdir, signal }),
        }
      : options.workspaceOnly && !sandbox
        ? {
            readDirectory: async (filePath) => {
              const root = await fsRoot(options.containmentRoot);
              return (
                await root.list(path.relative(options.containmentRoot, filePath), {
                  withFileTypes: true,
                })
              ).map(({ name, isDirectory }) => ({ name, isDirectory }));
            },
          }
        : undefined;
    if (!sandbox || readDirectory) {
      const ls = createLsTool(options.codingRoot, {
        operations: listingOperations,
        modelBudget: resolveToolResultBudget(options.modelContextWindowTokens),
      });
      // Skill-content read exceptions do not grant directory enumeration outside the workspace.
      const guardedLs = options.workspaceOnly
        ? wrapToolWorkspaceRootGuardWithOptions(
            ls,
            sandboxRoot ?? options.containmentRoot,
            sandboxRoot
              ? {
                  containerMounts: sandboxWorkspaceMounts,
                  containerWorkdir: sandbox.containerWorkdir,
                  bridge: sandboxFsBridge,
                  normalizeGuardedPathParams: true,
                }
              : { resolutionCwd: options.codingRoot, normalizeGuardedPathParams: true },
          )
        : ls;
      // Resolve the default directory before the guard as well as execution.
      base.push(
        sandboxRoot
          ? wrapSandboxFileToolPath(guardedLs, {
              root: sandboxRoot,
              bridge: sandboxFsBridge!,
              defaultPath: ".",
            })
          : guardedLs,
      );
    }
    const read = sandboxRoot
      ? createSandboxedReadTool({
          root: sandboxRoot,
          bridge: sandboxFsBridge!,
          modelContextWindowTokens: options.modelContextWindowTokens,
          imageSanitization: options.imageSanitization,
          modelHasVision: options.modelHasVision,
        })
      : createReadTool(options.codingRoot, {
          maxBytes: resolveAdaptiveReadMaxBytes(options),
          modelBudget: resolveToolResultBudget(options.modelContextWindowTokens),
          modelHasVision: options.modelHasVision,
        });
    const guarded = options.workspaceOnly
      ? wrapToolWorkspaceRootGuardWithOptions(
          read,
          sandboxRoot ?? options.containmentRoot,
          sandboxRoot
            ? {
                containerMounts: sandboxReadMounts,
                containerWorkdir: sandbox.containerWorkdir,
                bridge: sandboxFsBridge,
                readPathValidation: "bridge",
              }
            : {
                additionalRoots: hostReadRoots.length > 0 ? hostReadRoots : undefined,
                resolutionCwd: options.codingRoot,
                normalizeGuardedPathParams: true,
              },
        )
      : read;
    // Relative read semantics (including optional daily journals) run before
    // the guard forwards its checked absolute path to the filesystem reader.
    const wrapped = sandboxRoot
      ? guarded
      : createOpenClawReadTool(guarded, {
          modelContextWindowTokens: options.modelContextWindowTokens,
          imageSanitization: options.imageSanitization,
          cwd: options.codingRoot,
        });
    base.push(
      wrapReadToolWithSkillContent(wrapped, skillReadResources, {
        modelContextWindowTokens: options.modelContextWindowTokens,
        imageSanitization: options.imageSanitization,
        cwd: options.codingRoot,
        containerWorkdir: sandbox?.containerWorkdir,
        instructionPaths: options.skillInstructionPaths,
        instructionDeliveryCache: options.skillInstructionDeliveryCache,
      }),
    );
    if (!options.readOnly && !sandboxRoot) {
      const edit = createHostWorkspaceEditTool(options.codingRoot, {
        containmentRoot: options.containmentRoot,
        workspaceOnly: options.workspaceOnly,
        memoryWriteProvenance: options.memoryWriteProvenance,
        abortSignal: options.abortSignal,
      });
      base.push(options.workspaceOnly ? guardHostWorkspaceTool(edit, options) : edit);
      const write = createHostWorkspaceWriteTool(options.codingRoot, {
        containmentRoot: options.containmentRoot,
        workspaceOnly: options.workspaceOnly,
        memoryWriteProvenance: options.memoryWriteProvenance,
        abortSignal: options.abortSignal,
      });
      base.push(options.workspaceOnly ? guardHostWorkspaceTool(write, options) : write);
    }
  }

  if (options.includeBaseCodingTools && !options.readOnly && sandboxRoot && allowWorkspaceWrites) {
    const toolOptions = {
      root: sandboxRoot,
      bridge: sandboxFsBridge!,
      memoryWriteProvenance: options.memoryWriteProvenance,
      abortSignal: options.abortSignal,
    };
    const edit = createSandboxedEditTool(toolOptions);
    const write = createSandboxedWriteTool(toolOptions);
    base.push(
      options.workspaceOnly
        ? wrapToolWorkspaceRootGuardWithOptions(edit, sandboxRoot, {
            containerMounts: sandboxWorkspaceMounts,
            containerWorkdir: sandbox.containerWorkdir,
            bridge: sandboxFsBridge,
            normalizeGuardedPathParams: true,
          })
        : edit,
      options.workspaceOnly
        ? wrapToolWorkspaceRootGuardWithOptions(write, sandboxRoot, {
            containerMounts: sandboxWorkspaceMounts,
            containerWorkdir: sandbox.containerWorkdir,
            bridge: sandboxFsBridge,
            normalizeGuardedPathParams: true,
          })
        : write,
    );
  }
  options.recordToolPrepStage?.("base-coding-tools");

  const shell: AnyAgentTool[] = [];
  if (
    options.shellTools !== "disabled" &&
    options.applyPatchEnabled &&
    (!sandboxRoot || allowWorkspaceWrites)
  ) {
    shell.push(
      createApplyPatchTool({
        cwd: options.codingRoot,
        root: options.containmentRoot,
        sandbox:
          sandboxRoot && allowWorkspaceWrites
            ? {
                root: sandboxRoot,
                bridge: sandboxFsBridge!,
                workspaceMounts: sandboxWorkspaceMounts,
              }
            : undefined,
        workspaceOnly: options.applyPatchWorkspaceOnly,
        containmentSource: options.applyPatchContainmentSource,
        memoryWriteProvenance: options.memoryWriteProvenance,
        abortSignal: options.abortSignal,
      }),
    );
  }
  if (options.shellTools === "full") {
    shell.push(
      createLazyExecTool({
        ...options.execDefaults,
        ...(sandbox?.required ? { sandboxRequired: true } : {}),
        cwd: options.codingRoot,
        sandbox: sandbox
          ? {
              containerName: sandbox.containerName,
              workspaceDir: sandbox.workspaceDir,
              containerWorkdir: sandbox.containerWorkdir,
              workdirValidation: sandbox.backend?.workdirValidation,
              validateWorkdir: sandbox.backend?.validateWorkdir?.bind(sandbox.backend),
              discardPreparedWorkdir: sandbox.backend?.discardPreparedWorkdir?.bind(
                sandbox.backend,
              ),
              workdirRoots: sandbox.backend?.workdirRoots,
              readOnlyWorkspaceSkillMounts,
              env: sandbox.backend?.env ?? sandbox.docker.env,
              buildExecSpec: sandbox.backend?.buildExecSpec.bind(sandbox.backend),
              finalizeExec: sandbox.backend?.finalizeExec?.bind(sandbox.backend),
            }
          : undefined,
      }),
      createLazyProcessTool(options.processDefaults),
    );
  }
  options.recordToolPrepStage?.("shell-tools");

  base.forEach((tool) =>
    bindAgentToolActionDescriptor(tool, { family: "data", operation: "filesystem" }),
  );
  shell.forEach((tool) =>
    bindAgentToolActionDescriptor(tool, { family: "tool", operation: "process" }),
  );
  return [...base, ...shell];
}
