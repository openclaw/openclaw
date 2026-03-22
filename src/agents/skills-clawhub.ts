import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../infra/archive.js";
import {
  downloadClawHubSkillArchive,
  fetchClawHubSkillDetail,
  listClawHubSkills,
  resolveClawHubBaseUrl,
  searchClawHubSkills,
  type ClawHubSkillDetail,
  type ClawHubSkillSearchResult,
} from "../infra/clawhub.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { installPackageDir } from "../infra/install-package-dir.js";
import { resolveSafeInstallDir } from "../infra/install-safe-path.js";

const DOT_DIR = ".clawhub";
const LEGACY_DOT_DIR = ".clawdhub";
const SKILL_ORIGIN_RELATIVE_PATH = path.join(DOT_DIR, "origin.json");

export type ClawHubSkillOrigin = {
  version: 1;
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
};

export type ClawHubSkillsLockfile = {
  version: 1;
  skills: Record<
    string,
    {
      version: string;
      installedAt: number;
    }
  >;
};

export type InstallClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      version: string;
      targetDir: string;
      detail: ClawHubSkillDetail;
    }
  | { ok: false; error: string };

export type UpdateClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      previousVersion: string | null;
      version: string;
      changed: boolean;
      targetDir: string;
    }
  | { ok: false; error: string };

type Logger = {
  info?: (message: string) => void;
};

function normalizeSlug(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return trimmed;
}

function resolveSkillInstallDir(workspaceDir: string, slug: string): string {
  const skillsDir = path.join(path.resolve(workspaceDir), "skills");
  const target = resolveSafeInstallDir({
    baseDir: skillsDir,
    id: slug,
    invalidNameMessage: "invalid skill target path",
  });
  if (!target.ok) {
    throw new Error(target.error);
  }
  return target.path;
}

async function ensureSkillRoot(rootDir: string): Promise<void> {
  for (const candidate of ["SKILL.md", "skill.md", "skills.md", "SKILL.MD"]) {
    if (await fileExists(path.join(rootDir, candidate))) {
      return;
    }
  }
  throw new Error("downloaded archive is missing SKILL.md");
}

export async function readClawHubSkillsLockfile(
  workspaceDir: string,
): Promise<ClawHubSkillsLockfile> {
  const candidates = [
    path.join(workspaceDir, DOT_DIR, "lock.json"),
    path.join(workspaceDir, LEGACY_DOT_DIR, "lock.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(
        await fs.readFile(candidate, "utf8"),
      ) as Partial<ClawHubSkillsLockfile>;
      if (raw.version === 1 && raw.skills && typeof raw.skills === "object") {
        return {
          version: 1,
          skills: raw.skills,
        };
      }
    } catch {
      // ignore
    }
  }
  return { version: 1, skills: {} };
}

export async function writeClawHubSkillsLockfile(
  workspaceDir: string,
  lockfile: ClawHubSkillsLockfile,
): Promise<void> {
  const targetPath = path.join(workspaceDir, DOT_DIR, "lock.json");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
}

export async function readClawHubSkillOrigin(skillDir: string): Promise<ClawHubSkillOrigin | null> {
  const candidates = [
    path.join(skillDir, DOT_DIR, "origin.json"),
    path.join(skillDir, LEGACY_DOT_DIR, "origin.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(await fs.readFile(candidate, "utf8")) as Partial<ClawHubSkillOrigin>;
      if (
        raw.version === 1 &&
        typeof raw.registry === "string" &&
        typeof raw.slug === "string" &&
        typeof raw.installedVersion === "string" &&
        typeof raw.installedAt === "number"
      ) {
        return raw as ClawHubSkillOrigin;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export async function writeClawHubSkillOrigin(
  skillDir: string,
  origin: ClawHubSkillOrigin,
): Promise<void> {
  const targetPath = path.join(skillDir, SKILL_ORIGIN_RELATIVE_PATH);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(origin, null, 2)}\n`, "utf8");
}

export async function searchSkillsFromClawHub(params: {
  query?: string;
  limit?: number;
  baseUrl?: string;
}): Promise<ClawHubSkillSearchResult[]> {
  if (params.query?.trim()) {
    return await searchClawHubSkills({
      query: params.query,
      limit: params.limit,
      baseUrl: params.baseUrl,
    });
  }
  const list = await listClawHubSkills({
    limit: params.limit,
    baseUrl: params.baseUrl,
  });
  return list.items.map((item) => ({
    score: 0,
    slug: item.slug,
    displayName: item.displayName,
    summary: item.summary,
    version: item.latestVersion?.version,
    updatedAt: item.updatedAt,
  }));
}

async function resolveInstallVersion(params: {
  slug: string;
  version?: string;
  baseUrl?: string;
}): Promise<{ detail: ClawHubSkillDetail; version: string }> {
  const detail = await fetchClawHubSkillDetail({
    slug: params.slug,
    baseUrl: params.baseUrl,
  });
  if (!detail.skill) {
    throw new Error(`Skill "${params.slug}" not found on ClawHub.`);
  }
  const resolvedVersion = params.version ?? detail.latestVersion?.version;
  if (!resolvedVersion) {
    throw new Error(`Skill "${params.slug}" has no installable version.`);
  }
  return {
    detail,
    version: resolvedVersion,
  };
}

async function installExtractedSkill(params: {
  workspaceDir: string;
  slug: string;
  extractedRoot: string;
  mode: "install" | "update";
  logger?: Logger;
}): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  await ensureSkillRoot(params.extractedRoot);
  const targetDir = resolveSkillInstallDir(params.workspaceDir, params.slug);
  const install = await installPackageDir({
    sourceDir: params.extractedRoot,
    targetDir,
    mode: params.mode,
    timeoutMs: 120_000,
    logger: params.logger,
    copyErrorPrefix: "failed to install skill",
    hasDeps: false,
    depsLogMessage: "",
  });
  if (!install.ok) {
    return install;
  }
  return { ok: true, targetDir };
}

export async function installSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  logger?: Logger;
}): Promise<InstallClawHubSkillResult> {
  try {
    const slug = normalizeSlug(params.slug);
    const { detail, version } = await resolveInstallVersion({
      slug,
      version: params.version,
      baseUrl: params.baseUrl,
    });
    const targetDir = resolveSkillInstallDir(params.workspaceDir, slug);
    if (!params.force && (await fileExists(targetDir))) {
      return {
        ok: false,
        error: `Skill already exists at ${targetDir}. Re-run with force/update.`,
      };
    }

    params.logger?.info?.(`Downloading ${slug}@${version} from ClawHub…`);
    const archive = await downloadClawHubSkillArchive({
      slug,
      version,
      baseUrl: params.baseUrl,
    });
    try {
      const install = await withExtractedArchiveRoot({
        archivePath: archive.archivePath,
        tempDirPrefix: "openclaw-skill-clawhub-",
        timeoutMs: 120_000,
        rootMarkers: ["SKILL.md"],
        onExtracted: async (rootDir) =>
          await installExtractedSkill({
            workspaceDir: params.workspaceDir,
            slug,
            extractedRoot: rootDir,
            mode: params.force ? "update" : "install",
            logger: params.logger,
          }),
      });
      if (!install.ok) {
        return install;
      }

      const installedAt = Date.now();
      await writeClawHubSkillOrigin(install.targetDir, {
        version: 1,
        registry: resolveClawHubBaseUrl(params.baseUrl),
        slug,
        installedVersion: version,
        installedAt,
      });
      const lock = await readClawHubSkillsLockfile(params.workspaceDir);
      lock.skills[slug] = {
        version,
        installedAt,
      };
      await writeClawHubSkillsLockfile(params.workspaceDir, lock);

      return {
        ok: true,
        slug,
        version,
        targetDir: install.targetDir,
        detail,
      };
    } finally {
      await fs.rm(archive.archivePath, { force: true }).catch(() => undefined);
      await fs
        .rm(path.dirname(archive.archivePath), { recursive: true, force: true })
        .catch(() => undefined);
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function updateSkillsFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  logger?: Logger;
}): Promise<UpdateClawHubSkillResult[]> {
  const lock = await readClawHubSkillsLockfile(params.workspaceDir);
  const slugs = params.slug ? [normalizeSlug(params.slug)] : Object.keys(lock.skills);
  const results: UpdateClawHubSkillResult[] = [];
  for (const slug of slugs) {
    const targetDir = resolveSkillInstallDir(params.workspaceDir, slug);
    const origin = (await readClawHubSkillOrigin(targetDir)) ?? null;
    const baseUrl = origin?.registry ?? params.baseUrl;
    if (!origin && !lock.skills[slug]) {
      results.push({
        ok: false,
        error: `Skill "${slug}" is not tracked as a ClawHub install.`,
      });
      continue;
    }
    const previousVersion = origin?.installedVersion ?? lock.skills[slug]?.version ?? null;
    const install = await installSkillFromClawHub({
      workspaceDir: params.workspaceDir,
      slug,
      baseUrl,
      force: true,
      logger: params.logger,
    });
    if (!install.ok) {
      results.push(install);
      continue;
    }
    results.push({
      ok: true,
      slug,
      previousVersion,
      version: install.version,
      changed: previousVersion !== install.version,
      targetDir: install.targetDir,
    });
  }
  return results;
}

export async function readTrackedClawHubSkillSlugs(workspaceDir: string): Promise<string[]> {
  const lock = await readClawHubSkillsLockfile(workspaceDir);
  return Object.keys(lock.skills).toSorted();
}

export async function computeSkillFingerprint(skillDir: string): Promise<string> {
  const digest = createHash("sha256");
  const queue = [skillDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relPath = path.relative(skillDir, fullPath).split(path.sep).join("/");
      digest.update(relPath);
      digest.update("\n");
      digest.update(await fs.readFile(fullPath));
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}
