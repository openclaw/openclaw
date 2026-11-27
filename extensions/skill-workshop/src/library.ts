import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { listDirectoryTreeStrict, root } from "openclaw/plugin-sdk/file-access-runtime";
import {
  listSkillCopyFiles,
  listSkillFiles,
  MAX_SKILL_SUPPORT_FILE_BYTES,
  normalizeSkillFilePath,
  readSkillCopyFile,
  readSkillFile,
  removeSkillFile,
  SKILL_FILE,
  SkillAuthoringError,
  splitSkillFrontmatter,
  validateSkillFile,
  writeSkillFile,
} from "openclaw/plugin-sdk/skill-authoring-runtime";
import {
  pathExists,
  listWorkshopChanges,
  type WorkshopChange,
} from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { resolveSkillWorkshopConfig } from "./config.js";
import { recoverDetachedRestore } from "./restore-undo-recovery.js";
import {
  prepareSkillMutation,
  type ApplySkillMutation,
  type WorkshopMutationContext,
} from "./skill-mutation.js";
import {
  ignoreMissingPath,
  listVersions,
  snapshotSkill,
  type MutationPaths,
  type SkillPaths,
  type SkillVersion,
  type WorkshopChangeAction,
} from "./skill-versions.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { WorkshopWriteError } from "./workshop-write-error.js";

export { listWorkshopChanges, WorkshopWriteError };
export type { WorkshopMutationContext } from "./skill-mutation.js";

export type WorkshopSkillSummary = {
  name: string;
  description: string;
  updatedAtMs: number;
  sizeBytes: number;
  files: string[];
};
export type WorkshopArchivedSkill = {
  name: string;
  live: boolean;
  versions: SkillVersion[];
};

const ARCHIVE_DIR = ".archive";
// New names follow the Agent Skills limit. Earlier releases named learned skills with
// normalizeSkillIndexName and no length cap, so existing skills are matched by charset and
// the filesystem's 255-byte name limit only; otherwise they stay loaded but unmanageable.
export const NEW_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const EXISTING_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,254}$/;

function resolveSkillPaths(config: OpenClawConfig, agentId: string, name: string): SkillPaths {
  if (!EXISTING_SKILL_NAME_PATTERN.test(name)) {
    throw new WorkshopWriteError(
      `Invalid skill name "${name}": use lowercase letters, digits, or hyphens, starting with a letter or digit (e.g. "deploy-staging").`,
    );
  }
  const skillsRoot = resolveWorkshopSkillsDir(config, agentId);
  return {
    root: skillsRoot,
    skillDir: path.join(skillsRoot, name),
    versionsDir: path.join(skillsRoot, ARCHIVE_DIR, name),
    target: { config, agentId },
  };
}

export function normalizeWorkshopFilePath(filePath: string | undefined): string {
  try {
    return normalizeSkillFilePath(filePath);
  } catch (error) {
    throw new WorkshopWriteError(
      `Invalid file_path "${filePath?.trim()}": ${formatErrorMessage(error)} Use "SKILL.md" or a file like "references/notes.md".`,
    );
  }
}

/** Validates one file's next content with the core authoring rules and Workshop's size limit. */
export function validateWorkshopSkillFile(
  config: OpenClawConfig,
  name: string,
  filePath: string,
  content: string,
): string | undefined {
  try {
    return validateSkillFile({
      skillName: name,
      filePath,
      content,
      maxSkillBytes: resolveSkillWorkshopConfig(config).maxSkillBytes,
    }).description;
  } catch (error) {
    throw toWorkshopWriteError(error, filePath);
  }
}

function toWorkshopWriteError(error: unknown, filePath: string): unknown {
  if (!(error instanceof SkillAuthoringError)) {
    return error;
  }
  const hint =
    error.code === "too_large" && filePath === SKILL_FILE
      ? " Keep SKILL.md to the procedure and move detail into references/<topic>.md with action=write_file."
      : "";
  return new WorkshopWriteError(`${error.message}${hint}`, { cause: error });
}

function workshopFileByteLimit(config: OpenClawConfig, filePath: string): number {
  return filePath === SKILL_FILE
    ? resolveSkillWorkshopConfig(config).maxSkillBytes
    : MAX_SKILL_SUPPORT_FILE_BYTES;
}

/** Reads a saved version only when a normal write could have produced every file in it. */
async function readRestorableVersion(
  config: OpenClawConfig,
  name: string,
  versionId: string,
  versionDir: string,
): Promise<Array<[string, Buffer]>> {
  const refuse = (problem: string) =>
    new WorkshopWriteError(
      `Cannot restore "${name}" version ${versionId}: ${problem} The live skill is unchanged; restore a different version instead.`,
    );
  if (!(await fs.lstat(versionDir)).isDirectory()) {
    throw refuse("the saved version is not a directory.");
  }
  const versionRoot = await root(versionDir);
  const files: Array<[string, Buffer]> = [];
  for (const { relativePath, dirent: entry } of await listDirectoryTreeStrict(versionDir)) {
    const filePath = relativePath.split(path.sep).join("/");
    // Dot entries (e.g. .DS_Store) are not part of a skill and are never restored.
    if (entry.isDirectory() || filePath.split("/").some((segment) => segment.startsWith("."))) {
      continue;
    }
    if (!entry.isFile()) {
      throw refuse(`${filePath} is a symlink or special file.`);
    }
    if (filePath !== SKILL_FILE) {
      let canonical: string;
      try {
        canonical = normalizeSkillFilePath(filePath);
      } catch (error) {
        throw refuse(`${filePath} is not an allowed skill file (${formatErrorMessage(error)})`);
      }
      // Restored files must stay addressable by view/patch, which use the canonical path.
      if (canonical !== filePath) {
        throw refuse(`${filePath} is not a valid skill file path.`);
      }
    }
    let content: Buffer;
    try {
      content = (
        await versionRoot.read(filePath, {
          hardlinks: "reject",
          maxBytes: workshopFileByteLimit(config, filePath),
          symlinks: "reject",
        })
      ).buffer;
    } catch (error) {
      throw refuse(`${filePath} could not be read safely (${formatErrorMessage(error)}).`);
    }
    try {
      validateWorkshopSkillFile(config, name, filePath, content.toString("utf8"));
    } catch (error) {
      throw refuse(formatErrorMessage(error));
    }
    files.push([filePath, content]);
  }
  if (!files.some(([filePath]) => filePath === SKILL_FILE)) {
    throw refuse("SKILL.md is missing.");
  }
  return files;
}

async function writeWorkshopFile(paths: MutationPaths, filePath: string, content: string) {
  try {
    await writeSkillFile({
      ...paths.target,
      skillName: path.basename(paths.skillDir),
      filePath,
      content,
      assertCurrent: paths.assertLive,
    });
  } catch (error) {
    throw toWorkshopWriteError(error, filePath);
  }
}

async function requireLiveSkill(paths: SkillPaths, name: string): Promise<void> {
  if (await pathExists(path.join(paths.skillDir, SKILL_FILE))) {
    return;
  }
  const archived = (await listVersions(paths.versionsDir)).length > 0;
  throw new WorkshopWriteError(
    archived
      ? `Skill "${name}" is archived. Restore it first with action=restore name=${name}.`
      : `No workshop skill named "${name}". Call action=list to see skills, or action=create to add one.`,
  );
}

/** Serializes one skill's mutation, then refreshes discovery and records the change. */
export async function mutateSkill(
  ctx: WorkshopMutationContext,
  name: string,
  action: WorkshopChangeAction,
  apply: ApplySkillMutation,
  alsoLock: readonly SkillPaths[] = [],
): Promise<WorkshopChange> {
  const paths = resolveSkillPaths(ctx.config, ctx.agentId, name);
  return await prepareSkillMutation(ctx, name, paths, action, apply, alsoLock).commit();
}

export async function listWorkshopSkills(
  config: OpenClawConfig,
  agentId: string,
): Promise<WorkshopSkillSummary[]> {
  const skillsRoot = resolveWorkshopSkillsDir(config, agentId);
  const entries = await fs
    .readdir(skillsRoot, { withFileTypes: true })
    .catch((error: unknown) => ignoreMissingPath(error) ?? []);
  const skills: WorkshopSkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !EXISTING_SKILL_NAME_PATTERN.test(entry.name)) {
      continue;
    }
    const target = { config, agentId, skillName: entry.name };
    const content = await readSkillFile({ ...target, filePath: SKILL_FILE });
    if (content === null) {
      continue;
    }
    // A hand-edited skill with broken frontmatter still lists; view shows the file.
    const description = splitSkillFrontmatter(content).frontmatter.description?.trim() ?? "";
    skills.push({ name: entry.name, description, ...(await listSkillFiles(target)) });
  }
  return skills.toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function listWorkshopArchive(
  config: OpenClawConfig,
  agentId: string,
): Promise<WorkshopArchivedSkill[]> {
  const skillsRoot = resolveWorkshopSkillsDir(config, agentId);
  const names: string[] = await fs
    .readdir(path.join(skillsRoot, ARCHIVE_DIR))
    .catch((error: unknown) => ignoreMissingPath(error) ?? []);
  const archived: WorkshopArchivedSkill[] = [];
  for (const name of names.toSorted()) {
    if (!EXISTING_SKILL_NAME_PATTERN.test(name)) {
      continue;
    }
    const versions = await listVersions(path.join(skillsRoot, ARCHIVE_DIR, name));
    if (versions.length > 0) {
      const live = await pathExists(path.join(skillsRoot, name, SKILL_FILE));
      archived.push({ name, live, versions });
    }
  }
  return archived;
}

export async function viewWorkshopSkill(
  config: OpenClawConfig,
  agentId: string,
  name: string,
  filePath?: string,
  versionId?: string,
): Promise<{ name: string; filePath: string; content: string; files: string[] }> {
  const paths = resolveSkillPaths(config, agentId, name);
  const file = normalizeWorkshopFilePath(filePath);
  let copyDir: string | undefined;
  if (versionId) {
    const versions = await listVersions(paths.versionsDir);
    if (!versions.some((version) => version.id === versionId)) {
      throw new WorkshopWriteError(
        `Skill "${name}" has no version "${versionId}". Versions: ${versions.map((version) => version.id).join(", ") || "none"}.`,
      );
    }
    copyDir = path.relative(paths.root, path.join(paths.versionsDir, versionId));
  } else {
    await requireLiveSkill(paths, name);
  }
  const { files } = copyDir
    ? await listSkillCopyFiles({ config, agentId, copyDir })
    : await listSkillFiles({ config, agentId, skillName: name });
  const content = copyDir
    ? await readSkillCopyFile({ config, agentId, copyDir, filePath: file })
    : await readSkillFile({ config, agentId, skillName: name, filePath: file });
  if (content === null) {
    throw new WorkshopWriteError(
      `${file} does not exist in "${name}". Files: ${files.join(", ")}.`,
    );
  }
  return { name, filePath: file, content, files };
}

export async function createWorkshopSkill(
  ctx: WorkshopMutationContext,
  params: { name: string; content: string; summary?: string },
): Promise<WorkshopChange> {
  if (!NEW_SKILL_NAME_PATTERN.test(params.name)) {
    throw new WorkshopWriteError(
      `Invalid skill name "${params.name}": use 1-63 lowercase letters, digits, or hyphens, starting with a letter or digit (e.g. "deploy-staging").`,
    );
  }
  return await mutateSkill(ctx, params.name, "create", async (paths) => {
    if (await pathExists(paths.skillDir)) {
      throw new WorkshopWriteError(
        `Skill "${params.name}" already exists. View it and use action=patch, or choose another name.`,
      );
    }
    const description = validateWorkshopSkillFile(
      ctx.config,
      params.name,
      SKILL_FILE,
      params.content,
    );
    try {
      await writeWorkshopFile(paths, SKILL_FILE, params.content);
    } catch (error) {
      await fs.rm(paths.skillDir, { recursive: true, force: true });
      throw error;
    }
    return { summary: params.summary ?? `created: ${description}` };
  });
}

export async function patchWorkshopSkill(
  ctx: WorkshopMutationContext,
  params: { name: string; oldText: string; newText: string; filePath?: string; summary?: string },
): Promise<WorkshopChange> {
  const file = normalizeWorkshopFilePath(params.filePath);
  return await mutateSkill(ctx, params.name, "patch", async (paths) => {
    await requireLiveSkill(paths, params.name);
    if (!params.oldText) {
      throw new WorkshopWriteError(
        "old_text is required: copy the exact text to replace from view.",
      );
    }
    if (params.oldText === params.newText) {
      throw new WorkshopWriteError("old_text and new_text are identical; nothing to change.");
    }
    const current = await readSkillFile({
      ...paths.target,
      skillName: params.name,
      filePath: file,
    });
    if (current === null) {
      throw new WorkshopWriteError(
        `${file} does not exist in "${params.name}". Use action=write_file to add it.`,
      );
    }
    const { oldText } = params;
    let matches = 0;
    for (let at = current.indexOf(oldText); at !== -1; at = current.indexOf(oldText, at + 1)) {
      matches++;
    }
    if (matches !== 1) {
      throw new WorkshopWriteError(
        matches === 0
          ? `old_text was not found in ${params.name}/${file}. View the file again and copy the exact text, including whitespace.`
          : `old_text matches ${matches} places in ${params.name}/${file}. Include more surrounding text so it matches once.`,
      );
    }
    const next = current.replace(params.oldText, () => params.newText);
    validateWorkshopSkillFile(ctx.config, params.name, file, next);
    const versionId = await snapshotSkill(paths, "patch");
    await writeWorkshopFile(paths, file, next);
    return { summary: params.summary ?? `patched ${file}`, versionId };
  });
}

export async function writeWorkshopSkillFile(
  ctx: WorkshopMutationContext,
  params: { name: string; filePath: string; content: string; summary?: string },
): Promise<WorkshopChange> {
  const file = normalizeWorkshopFilePath(params.filePath);
  return await mutateSkill(ctx, params.name, "write_file", async (paths) => {
    await requireLiveSkill(paths, params.name);
    if (
      (await readSkillFile({ ...paths.target, skillName: params.name, filePath: file })) ===
      params.content
    ) {
      throw new WorkshopWriteError(
        `${params.name}/${file} already has this content; nothing changed.`,
      );
    }
    validateWorkshopSkillFile(ctx.config, params.name, file, params.content);
    const versionId = await snapshotSkill(paths, "write_file");
    await writeWorkshopFile(paths, file, params.content);
    return {
      summary: params.summary ?? (file === SKILL_FILE ? "rewrote SKILL.md" : `wrote ${file}`),
      versionId,
    };
  });
}

/** Deletes one support file; SKILL.md goes only with the whole skill, through archive. */
export async function removeWorkshopSkillFile(
  ctx: WorkshopMutationContext,
  params: { name: string; filePath: string; summary?: string },
): Promise<WorkshopChange> {
  const file = normalizeWorkshopFilePath(params.filePath);
  if (file === SKILL_FILE) {
    throw new WorkshopWriteError(
      `SKILL.md cannot be removed. Archive the skill with action=archive name=${params.name} instead.`,
    );
  }
  return await mutateSkill(ctx, params.name, "remove_file", async (paths) => {
    await requireLiveSkill(paths, params.name);
    const { files } = await listSkillFiles({ ...paths.target, skillName: params.name });
    if (!files.includes(file)) {
      throw new WorkshopWriteError(
        `${file} does not exist in "${params.name}". Files: ${files.join(", ")}.`,
      );
    }
    const versionId = await snapshotSkill(paths, "remove_file");
    await removeSkillFile({
      ...paths.target,
      skillName: params.name,
      filePath: file,
      assertCurrent: paths.assertLive,
    });
    return { summary: params.summary ?? `removed ${file}`, versionId };
  });
}

function restoreUndoMismatch(name: string) {
  return new WorkshopWriteError(
    `Cannot undo this restore of "${name}": the live files no longer match a saved version. Archive the skill to keep its current contents.`,
  );
}

async function readRestoreUndoBundle(
  config: OpenClawConfig,
  directory: string,
  name: string,
): Promise<Map<string, Buffer>> {
  const entries = await listDirectoryTreeStrict(directory);
  const nonemptyDirs = new Set(entries.map(({ relativePath }) => path.dirname(relativePath)));
  const liveRoot = await root(directory);
  const live = new Map<string, Buffer>();
  for (const { relativePath, dirent } of entries) {
    if (dirent.isDirectory() && nonemptyDirs.has(relativePath)) {
      continue;
    }
    // Restore only produces regular files and their parent directories.
    if (!dirent.isFile()) {
      throw restoreUndoMismatch(name);
    }
    const file = relativePath.split(path.sep).join("/");
    try {
      const { buffer } = await liveRoot.read(file, {
        symlinks: "reject",
        hardlinks: "reject",
        maxBytes: workshopFileByteLimit(config, file),
      });
      live.set(file, buffer);
    } catch (cause) {
      throw new WorkshopWriteError(
        `Cannot verify "${name}/${file}" for undo. Check the file before trying again.`,
        { cause },
      );
    }
  }
  return live;
}

function matchesUndoBundle(files: Array<[string, Buffer]>, live: Map<string, Buffer>) {
  return (
    files.length === live.size && files.every(([file, bytes]) => live.get(file)?.equals(bytes))
  );
}

/** Reuse the retained copy for redo so the archived skill keeps its previous default. */
async function archivedRestoreUndoVersion(
  ctx: WorkshopMutationContext,
  paths: MutationPaths,
  name: string,
  changeId: string,
) {
  // Other skills can fill the visible page between a restore and its undo.
  const changes = await listWorkshopChanges(ctx.agentId, { limit: 500 });
  const latest = changes.find((change) => change.skillName === name);
  if (latest?.id !== changeId || latest.action !== "restore" || latest.versionId) {
    throw new WorkshopWriteError(
      `Cannot undo this restore of "${name}". Refresh its history first.`,
    );
  }
  const live = await readRestoreUndoBundle(ctx.config, paths.skillDir, name);
  for (const { id } of await listVersions(paths.versionsDir)) {
    let files: Array<[string, Buffer]>;
    try {
      files = await readRestorableVersion(ctx.config, name, id, path.join(paths.versionsDir, id));
    } catch (error) {
      if (error instanceof WorkshopWriteError) {
        continue;
      }
      throw error;
    }
    if (matchesUndoBundle(files, live)) {
      return { id, files };
    }
  }
  throw restoreUndoMismatch(name);
}

type WorkshopArchiveParams = {
  name: string;
  absorbedInto?: string;
  reason?: string;
  undoRestoreChangeId?: string;
};

function prepareArchive(ctx: WorkshopMutationContext, params: WorkshopArchiveParams) {
  const absorbedInto =
    params.absorbedInto === undefined
      ? undefined
      : resolveSkillPaths(ctx.config, ctx.agentId, params.absorbedInto);
  // The target stays locked until the source is gone, so it cannot be archived mid-merge.
  const source = resolveSkillPaths(ctx.config, ctx.agentId, params.name);
  return prepareSkillMutation(
    ctx,
    params.name,
    source,
    "archive",
    async (paths) => {
      await requireLiveSkill(paths, params.name);
      if (
        absorbedInto &&
        (params.absorbedInto === params.name ||
          !(await pathExists(path.join(absorbedInto.skillDir, SKILL_FILE))))
      ) {
        throw new WorkshopWriteError(
          `absorbed_into must name another live workshop skill; "${params.absorbedInto}" is not one.`,
        );
      }
      const undo = params.undoRestoreChangeId
        ? await archivedRestoreUndoVersion(ctx, paths, params.name, params.undoRestoreChangeId)
        : undefined;
      const versionId = undo?.id ?? (await snapshotSkill(paths, "archive"));
      // One fenced rename takes the skill out of service, so a refusal leaves it whole.
      const detached = path.join(paths.root, ARCHIVE_DIR, `.archiving-${randomUUID()}`);
      paths.assertLive();
      await fs.rename(paths.skillDir, detached);
      if (undo) {
        // Editors can replace or save the live directory during the version search. Verify the
        // directory the rename actually claimed before deleting anything from it.
        try {
          const claimed = await readRestoreUndoBundle(ctx.config, detached, params.name);
          if (!matchesUndoBundle(undo.files, claimed)) {
            throw restoreUndoMismatch(params.name);
          }
          if (await fs.lstat(paths.skillDir).catch(ignoreMissingPath)) {
            throw new WorkshopWriteError(
              `A new live copy of "${params.name}" appeared during undo.`,
            );
          }
          paths.assertLive();
        } catch (cause) {
          await recoverDetachedRestore(paths, params.name, detached);
          throw cause;
        }
      }
      await fs.rm(detached, { recursive: true, force: true });
      const detail = [
        params.absorbedInto ? `merged into ${params.absorbedInto}` : undefined,
        params.reason?.trim() || undefined,
      ].filter(Boolean);
      return {
        summary: detail.length > 0 ? `archived: ${detail.join("; ")}` : "archived",
        versionId,
      };
    },
    absorbedInto ? [absorbedInto] : [],
  );
}

export async function archiveWorkshopSkill(
  ctx: WorkshopMutationContext,
  params: WorkshopArchiveParams,
): Promise<WorkshopChange> {
  return await prepareArchive(ctx, params).commit();
}

export async function archiveUnusedWorkshopSkill(
  ctx: WorkshopMutationContext,
  params: { name: string; reason: string },
  cutoffMs: number,
): Promise<WorkshopChange | undefined> {
  return await prepareArchive(ctx, params).commitIfInactiveSince(cutoffMs);
}

/** Restores a saved version (default: newest); the live copy is versioned first, so undo is undoable. */
export async function restoreWorkshopSkill(
  ctx: WorkshopMutationContext,
  params: { name: string; versionId?: string; summary?: string },
): Promise<WorkshopChange> {
  return await mutateSkill(ctx, params.name, "restore", async (paths) => {
    const versions = await listVersions(paths.versionsDir);
    const target = params.versionId
      ? versions.find((version) => version.id === params.versionId)
      : versions[0];
    if (!target) {
      throw new WorkshopWriteError(
        versions.length === 0
          ? `Skill "${params.name}" has no saved versions to restore.`
          : `Skill "${params.name}" has no version "${params.versionId}". Versions: ${versions.map((version) => version.id).join(", ")}.`,
      );
    }
    const files = await readRestorableVersion(
      ctx.config,
      params.name,
      target.id,
      path.join(paths.versionsDir, target.id),
    );
    const versionId = await publishSkillBundle(paths, "restore", async (staging) => {
      for (const [filePath, content] of files) {
        await writeStagedFile(staging, filePath, content);
      }
    });
    const summary =
      params.summary ??
      (target.action === "archive"
        ? "restored from archive"
        : params.versionId
          ? `restored version ${target.id}`
          : `undid ${target.action.replace("_", " ")}`);
    return { summary, versionId };
  });
}

/**
 * Publishes the live skill with `files` written over it as one versioned swap. Files not listed
 * are kept byte for byte, binary assets included; without a live skill the files are the skill.
 */
export async function publishSkillOverlay(
  paths: MutationPaths,
  files: ReadonlyArray<readonly [string, string | Buffer]>,
): Promise<string | undefined> {
  const live = await pathExists(paths.skillDir);
  return await publishSkillBundle(paths, "write_file", async (staging) => {
    if (live) {
      await fs.cp(paths.skillDir, staging, {
        recursive: true,
        filter: async (source) => !(await fs.lstat(source)).isSymbolicLink(),
      });
    }
    for (const [file, content] of files) {
      await writeStagedFile(staging, file, content);
    }
  });
}

async function writeStagedFile(staging: string, filePath: string, content: string | Buffer) {
  const destination = path.join(staging, ...filePath.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
}

/**
 * Publishes a whole skill at once: `fill` builds the complete next copy in a staging directory,
 * the live skill is snapshotted, and the copies swap by rename. A failed fill, refused authority,
 * or failed rename leaves the previous live skill in place. Returns the snapshot's version id.
 */
async function publishSkillBundle(
  paths: MutationPaths,
  action: WorkshopChangeAction,
  fill: (staging: string) => Promise<void>,
): Promise<string | undefined> {
  const staging = path.join(paths.root, ARCHIVE_DIR, `.${action}-${randomUUID()}`);
  const previous = path.join(paths.root, ARCHIVE_DIR, `.${action}-previous-${randomUUID()}`);
  try {
    await fs.mkdir(staging, { recursive: true });
    await fill(staging);
    const versionId = await snapshotSkill(paths, action);
    const hadLive = await pathExists(paths.skillDir);
    if (hadLive) {
      paths.assertLive();
      await fs.rename(paths.skillDir, previous);
    }
    try {
      paths.assertLive();
      await fs.rename(staging, paths.skillDir);
    } catch (error) {
      if (hadLive) {
        await fs.rename(previous, paths.skillDir);
      }
      throw error;
    }
    // Only successful publication may discard the original live copy.
    await fs.rm(previous, { recursive: true, force: true });
    return versionId;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
