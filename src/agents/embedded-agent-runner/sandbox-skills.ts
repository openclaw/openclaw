/**
 * Sandbox skill runtime input selection.
 *
 * Sandboxed runs must build prompt-facing skill entries from readable in-sandbox
 * copies instead of reusing host-path snapshots.
 */
import path from "node:path";
import { isPathRelativeEscape } from "@openclaw/fs-safe/path";
import { indexFirstByKey } from "../../shared/dedupe-by-key.js";
import { resolveExplicitSkillSelectionFileHost } from "../../skills/discovery/skill-command-provenance.js";
import { formatSkillsForPromptBounded } from "../../skills/loading/skill-prompt-limits.js";
import { clearSkillFileHost } from "../../skills/skill-file-host.js";
import type {
  SkillEligibilityContext,
  ExplicitSkillSelection,
  SkillSnapshot,
  SkillUsagePath,
  SkillEntry,
} from "../../skills/types.js";
import { resolveSkillReadPath } from "../../skills/workspace-skill-read-path.js";
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
  if (isPathRelativeEscape(relativePath)) {
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
    const snapshot = params.skillsSnapshot;
    const sourceReadPathBySkillName = indexFirstByKey(
      snapshot?.resolvedSkills ?? [],
      (skill) => skill.name,
    );
    const skillUsagePaths = params.sandbox.skillUsagePaths?.map((entry) => {
      const sourceSkill = sourceReadPathBySkillName.get(entry.skillName);
      const catalogSkill = snapshot?.skills.find((skill) => skill.name === entry.skillName);
      const sourceReadPath = sourceSkill
        ? resolveSkillReadPath(sourceSkill)
        : catalogSkill && catalogSkill.gatewayFilePath === undefined
          ? resolveSkillReadPath({ name: entry.skillName, filePath: entry.skillFile }, "workspace")
          : undefined;
      return {
        ...entry,
        readPath:
          skillsWorkspaceDir === skillsPromptWorkspaceDir
            ? entry.readPath
            : (mapPathFromWorkspaceToContainer({
                filePath: entry.readPath,
                sourceWorkspaceDir: skillsWorkspaceDir,
                targetWorkspaceDir: skillsPromptWorkspaceDir,
              }) ?? entry.readPath),
        ...(sourceReadPath && sourceReadPath !== entry.skillFile ? { sourceReadPath } : {}),
      };
    });
    // An explicit empty snapshot excludes instructions; it has no host paths to remap.
    let selectedSnapshot =
      params.skillsSnapshot &&
      !params.skillsSnapshot.prompt.trim() &&
      !params.skillsSnapshot.discoverySkills?.length
        ? params.skillsSnapshot
        : undefined;
    if (
      snapshot &&
      (snapshot.librarySelections?.length || (snapshot.discoverySkills && skillUsagePaths?.length))
    ) {
      const usageBySkillName = indexFirstByKey(skillUsagePaths ?? [], (usage) => usage.skillName);
      const mapSkill = (skill: NonNullable<SkillSnapshot["resolvedSkills"]>[number]) => {
        const materialized = usageBySkillName.get(skill.name);
        if (!materialized) {
          throw new Error(`Selected skill ${skill.name} was not delivered to the sandbox.`);
        }
        return clearSkillFileHost({
          ...skill,
          filePath: materialized.readPath,
          baseDir: path.posix.dirname(materialized.readPath),
        });
      };
      const resolvedSkills = snapshot.resolvedSkills
        ?.filter((skill) => snapshot.librarySelections?.length || usageBySkillName.has(skill.name))
        .map(mapSkill);
      // Discovery cannot advertise host resources absent from this sandbox's delivery.
      const discoverySkills = snapshot.discoverySkills
        ?.filter((skill) => usageBySkillName.has(skill.name))
        .map(mapSkill);
      if (!resolvedSkills) {
        throw new Error("Selected skill snapshot must be hydrated before sandbox delivery.");
      }
      selectedSnapshot = {
        ...snapshot,
        resolvedSkills,
        discoverySkills,
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
  paths?: readonly Pick<SkillUsagePath, "skillFile" | "readPath" | "sourceReadPath">[],
): string {
  let result = text;
  const items = paths ?? [];
  for (const item of items) {
    if (item.sourceReadPath) {
      result = result.replaceAll(
        item.sourceReadPath.slice(0, -"SKILL.md".length),
        item.readPath.slice(0, -"SKILL.md".length),
      );
    }
  }
  for (const item of indexFirstByKey(items, (entry) => entry.skillFile).values()) {
    const matches = items.filter((candidate) => candidate.skillFile === item.skillFile);
    const physicalTarget =
      matches.find((candidate) => candidate.sourceReadPath === undefined) ??
      (matches.length === 1 ? matches[0] : undefined);
    if (physicalTarget) {
      result = result.replaceAll(
        item.skillFile.slice(0, -"SKILL.md".length),
        physicalTarget.readPath.slice(0, -"SKILL.md".length),
      );
    }
  }
  return result;
}

export function remapExplicitSkillSelectionPath(
  selection: ExplicitSkillSelection,
  paths?: readonly Pick<SkillUsagePath, "skillFile" | "readPath" | "sourceReadPath">[],
): string {
  const fileHost = resolveExplicitSkillSelectionFileHost(selection);
  const match = paths?.find(
    (item) =>
      item.skillFile === selection.path &&
      (fileHost === "workspace"
        ? item.sourceReadPath !== undefined
        : fileHost === "gateway"
          ? item.sourceReadPath === undefined
          : true),
  );
  return match?.readPath ?? selection.path;
}
