/**
 * Sandbox skill runtime input selection.
 *
 * Sandboxed runs must build prompt-facing skill entries from readable in-sandbox
 * copies instead of reusing host-path snapshots.
 */
import path from "node:path";
import { formatSkillsForPromptBounded } from "../../skills/loading/skill-prompt-limits.js";
import type {
  SkillEligibilityContext,
  SkillSnapshot,
  SkillUsagePath,
  SkillEntry,
} from "../../skills/types.js";
import type { SandboxContext } from "../sandbox/types.js";

const MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS = [".openclaw", "sandbox-skills"] as const;
type SandboxSkillRuntimeContext = Pick<SandboxContext, "enabled"> &
  Partial<
    Pick<
      SandboxContext,
      | "skillsEligibility"
      | "skillsWorkspaceDir"
      | "containerWorkdir"
      | "workspaceAccess"
      | "skillUsagePaths"
    >
  >;

function containerJoin(root: string, ...parts: string[]): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const suffix = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot;
}

function pathEscapesRoot(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

function mapPathFromWorkspaceToContainer(params: {
  filePath: string | undefined;
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): string | undefined {
  if (!params.filePath || !path.isAbsolute(params.filePath)) {
    return params.filePath;
  }
  const relativePath = path.relative(
    path.resolve(params.sourceWorkspaceDir),
    path.resolve(params.filePath),
  );
  if (pathEscapesRoot(relativePath)) {
    return params.filePath;
  }
  if (!relativePath) {
    return params.targetWorkspaceDir.replace(/\\/g, "/");
  }
  return containerJoin(params.targetWorkspaceDir, ...relativePath.split(path.sep).filter(Boolean));
}

export function mapSandboxSkillEntriesForPrompt(params: {
  entries?: SkillEntry[];
  skillsWorkspaceDir: string;
  skillsPromptWorkspaceDir: string;
}): SkillEntry[] | undefined {
  if (!params.entries || params.skillsWorkspaceDir === params.skillsPromptWorkspaceDir) {
    return params.entries;
  }
  const mapPath = (filePath: string | undefined) =>
    mapPathFromWorkspaceToContainer({
      filePath,
      sourceWorkspaceDir: params.skillsWorkspaceDir,
      targetWorkspaceDir: params.skillsPromptWorkspaceDir,
    });
  return params.entries.map((entry) => {
    const filePath = mapPath(entry.skill.filePath) ?? entry.skill.filePath;
    const baseDir = mapPath(entry.skill.baseDir) ?? entry.skill.baseDir;
    const sourceInfoPath = mapPath(entry.skill.sourceInfo.path) ?? entry.skill.sourceInfo.path;
    const sourceInfoBaseDir = mapPath(entry.skill.sourceInfo.baseDir);
    return {
      ...entry,
      skill: {
        ...entry.skill,
        filePath,
        baseDir,
        sourceInfo: {
          ...entry.skill.sourceInfo,
          path: sourceInfoPath,
          ...(sourceInfoBaseDir === undefined ? {} : { baseDir: sourceInfoBaseDir }),
        },
      },
    };
  });
}

export function createSandboxPromptEntryLoader(params: {
  loadEntries: () => SkillEntry[] | Promise<SkillEntry[]>;
  skillsWorkspaceDir: string;
  skillsPromptWorkspaceDir: string;
}): () => Promise<SkillEntry[]> {
  return async () =>
    mapSandboxSkillEntriesForPrompt({
      entries: await params.loadEntries(),
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      skillsPromptWorkspaceDir: params.skillsPromptWorkspaceDir,
    }) ?? [];
}

function mapSandboxSkillUsagePaths(params: {
  paths?: SkillUsagePath[];
  skillsWorkspaceDir: string;
  skillsPromptWorkspaceDir: string;
}): SkillUsagePath[] | undefined {
  if (!params.paths || params.skillsWorkspaceDir === params.skillsPromptWorkspaceDir) {
    return params.paths;
  }
  return params.paths.map((entry) => ({
    ...entry,
    readPath:
      mapPathFromWorkspaceToContainer({
        filePath: entry.readPath,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.readPath,
  }));
}

export function resolveSandboxSkillRuntimeInputs(params: {
  sandbox?: SandboxSkillRuntimeContext | null;
  // Fallback skill discovery anchors to the configured agent workspace so
  // snapshot and fallback paths agree.
  skillsAnchorWorkspace: string;
  skillsSnapshot?: SkillSnapshot;
}): {
  skillsEligibility?: SkillEligibilityContext;
  skillUsagePaths?: SkillUsagePath[];
  skillsPromptWorkspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
  skillsWorkspaceDir: string;
  workspaceOnly: boolean;
} {
  if (params.sandbox?.enabled === true) {
    const skillsWorkspaceDir = params.sandbox.skillsWorkspaceDir ?? params.skillsAnchorWorkspace;
    const skillsPromptWorkspaceDir =
      params.sandbox.workspaceAccess === "rw" &&
      params.sandbox.skillsWorkspaceDir &&
      params.sandbox.containerWorkdir
        ? containerJoin(
            params.sandbox.containerWorkdir,
            ...MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS,
          )
        : (params.sandbox.containerWorkdir ?? skillsWorkspaceDir);
    const skillUsagePaths = mapSandboxSkillUsagePaths({
      paths: params.sandbox.skillUsagePaths,
      skillsWorkspaceDir,
      skillsPromptWorkspaceDir,
    });
    // An explicit empty snapshot excludes instructions; it has no host paths to remap.
    let selectedSnapshot =
      params.skillsSnapshot && !params.skillsSnapshot.prompt.trim()
        ? params.skillsSnapshot
        : undefined;
    if (params.skillsSnapshot?.librarySelections?.length) {
      const usageBySkillName = new Map<string, SkillUsagePath>();
      for (const usage of skillUsagePaths ?? []) {
        // Duplicate names keep their first delivered path.
        if (!usageBySkillName.has(usage.skillName)) {
          usageBySkillName.set(usage.skillName, usage);
        }
      }
      const resolvedSkills = params.skillsSnapshot.resolvedSkills?.map((skill) => {
        const materialized = usageBySkillName.get(skill.name);
        if (!materialized) {
          throw new Error(`Selected skill ${skill.name} was not delivered to the sandbox.`);
        }
        return {
          ...skill,
          filePath: materialized.readPath,
          baseDir: path.posix.dirname(materialized.readPath),
          hostFilePath: materialized.skillFile,
        };
      });
      if (!resolvedSkills) {
        throw new Error("Selected skill snapshot must be hydrated before sandbox delivery.");
      }
      selectedSnapshot = {
        ...params.skillsSnapshot,
        resolvedSkills,
        prompt: formatSkillsForPromptBounded({ skills: resolvedSkills, preserveOrder: true }),
      };
    }
    return {
      ...(params.sandbox.skillsEligibility
        ? { skillsEligibility: params.sandbox.skillsEligibility }
        : {}),
      ...(skillUsagePaths ? { skillUsagePaths } : {}),
      skillsPromptWorkspaceDir,
      skillsSnapshot: selectedSnapshot,
      skillsWorkspaceDir,
      workspaceOnly: true,
    };
  }
  return {
    ...(params.sandbox?.skillUsagePaths ? { skillUsagePaths: params.sandbox.skillUsagePaths } : {}),
    skillsPromptWorkspaceDir: params.skillsAnchorWorkspace,
    skillsSnapshot: params.skillsSnapshot,
    skillsWorkspaceDir: params.skillsAnchorWorkspace,
    workspaceOnly: false,
  };
}

/** Rewrites host-generated explicit skill references to the prepared runtime's exact copies. */
export function remapSkillReferencePaths(
  text: string,
  paths?: readonly Pick<SkillUsagePath, "skillFile" | "readPath">[],
): string {
  return (paths ?? []).reduce(
    (result, item) => result.replaceAll(item.skillFile, item.readPath),
    text,
  );
}
