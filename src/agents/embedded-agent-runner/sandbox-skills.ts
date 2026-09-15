/**
 * Sandbox skill runtime input selection.
 *
 * Sandboxed runs must build prompt-facing skill entries from readable in-sandbox
 * copies instead of reusing host-path snapshots.
 */
import path from "node:path";
import { escapeSkillXml } from "../../skills/loading/skill-contract.js";
import { compactPromptSkills } from "../../skills/loading/skill-paths.js";
import { formatSkillsForPromptBounded } from "../../skills/loading/skill-prompt-limits.js";
import type {
  SkillEligibilityContext,
  SkillSnapshot,
  SkillUsagePath,
  SkillEntry,
} from "../../skills/types.js";
import { readPublishedSandboxSkills } from "../sandbox/published-skills-handoff.js";
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
  return params.entries.map((entry) => {
    const filePath =
      mapPathFromWorkspaceToContainer({
        filePath: entry.skill.filePath,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.skill.filePath;
    const baseDir =
      mapPathFromWorkspaceToContainer({
        filePath: entry.skill.baseDir,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.skill.baseDir;
    const sourceInfoPath =
      mapPathFromWorkspaceToContainer({
        filePath: entry.skill.sourceInfo.path,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.skill.sourceInfo.path;
    const sourceInfoBaseDir = mapPathFromWorkspaceToContainer({
      filePath: entry.skill.sourceInfo.baseDir,
      sourceWorkspaceDir: params.skillsWorkspaceDir,
      targetWorkspaceDir: params.skillsPromptWorkspaceDir,
    });
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
  publishedSkillsOwner?: object;
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
    const published = readPublishedSandboxSkills(params.publishedSkillsOwner ?? params.sandbox);
    // An explicit empty snapshot excludes instructions; it has no host paths to remap.
    let selectedSnapshot =
      params.skillsSnapshot && !params.skillsSnapshot.prompt.trim()
        ? params.skillsSnapshot
        : undefined;
    if (!published && params.skillsSnapshot?.librarySelections?.length) {
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
      skillsSnapshot: published
        ? remapPublishedSnapshot(published, skillsWorkspaceDir, skillsPromptWorkspaceDir)
        : selectedSnapshot,
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

function remapPublishedSnapshot(
  snapshot: SkillSnapshot,
  source: string,
  target: string,
): SkillSnapshot {
  if (source === target) {
    return snapshot;
  }
  const hostSkills = snapshot.resolvedSkills ?? [];
  const serialized = compactPromptSkills(hostSkills);
  const resolvedSkills = hostSkills.map((skill) => ({
    ...skill,
    filePath:
      mapPathFromWorkspaceToContainer({
        filePath: skill.filePath,
        sourceWorkspaceDir: source,
        targetWorkspaceDir: target,
      }) ?? skill.filePath,
    baseDir:
      mapPathFromWorkspaceToContainer({
        filePath: skill.baseDir,
        sourceWorkspaceDir: source,
        targetWorkspaceDir: target,
      }) ?? skill.baseDir,
    sourceInfo: {
      ...skill.sourceInfo,
      path:
        mapPathFromWorkspaceToContainer({
          filePath: skill.sourceInfo.path,
          sourceWorkspaceDir: source,
          targetWorkspaceDir: target,
        }) ?? skill.sourceInfo.path,
      ...(skill.sourceInfo.baseDir === undefined
        ? {}
        : {
            baseDir: mapPathFromWorkspaceToContainer({
              filePath: skill.sourceInfo.baseDir,
              sourceWorkspaceDir: source,
              targetWorkspaceDir: target,
            }),
          }),
    },
  }));
  let prompt = snapshot.prompt;
  const mappedLocations = new Map(resolvedSkills.map((skill) => [skill.name, skill.filePath]));
  // Configured roots can preserve absolute paths instead of the usual home shorthand.
  for (const skill of [...hostSkills, ...serialized]) {
    const location = mappedLocations.get(skill.name);
    if (location !== undefined) {
      prompt = prompt.replaceAll(
        `<location>${escapeSkillXml(skill.filePath)}</location>`,
        `<location>${escapeSkillXml(location)}</location>`,
      );
    }
  }
  return { ...snapshot, prompt, resolvedSkills };
}
