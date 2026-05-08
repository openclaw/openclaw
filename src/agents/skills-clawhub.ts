import crypto from "node:crypto";
import path from "node:path";
import {
  downloadClawHubSkillArchive,
  fetchClawHubSkillDetail,
  resolveClawHubBaseUrl,
  searchClawHubSkills,
  type ClawHubSkillDetail,
  type ClawHubSkillSearchResult,
} from "../infra/clawhub.js";
import { formatErrorMessage } from "../infra/errors.js";
import { pathExists } from "../infra/fs-safe.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
  installExtractedSkillRoot,
  normalizeTrackedSkillSlug,
  resolveWorkspaceSkillInstallDir,
  validateRequestedSkillSlug,
} from "./skills-archive-install.js";

const CLAWHUB_SKILL_STATE_OWNER_ID = "core:clawhub-skills";
const CLAWHUB_SKILL_STATE_NAMESPACE = "skill-installs";
const CLAWHUB_SKILL_STATE_MAX_ENTRIES = 10_000;

const clawHubSkillInstallStore = createCorePluginStateKeyedStore<ClawHubSkillInstallRecord>({
  ownerId: CLAWHUB_SKILL_STATE_OWNER_ID,
  namespace: CLAWHUB_SKILL_STATE_NAMESPACE,
  maxEntries: CLAWHUB_SKILL_STATE_MAX_ENTRIES,
});

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

type ClawHubSkillInstallRecord = ClawHubSkillOrigin & {
  workspaceDir: string;
  targetDir: string;
  updatedAt: number;
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

async function resolveRequestedUpdateSlug(params: {
  workspaceDir: string;
  requestedSlug: string;
  lock: ClawHubSkillsLockfile;
}): Promise<string> {
  const trackedSlug = normalizeTrackedSkillSlug(params.requestedSlug);
  const trackedTargetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug);
  const trackedOrigin = await readClawHubSkillOrigin(trackedTargetDir);
  if (trackedOrigin || params.lock.skills[trackedSlug]) {
    return trackedSlug;
  }
  return validateRequestedSkillSlug(params.requestedSlug);
}

type ClawHubInstallParams = {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  logger?: Logger;
};

type TrackedUpdateTarget =
  | {
      ok: true;
      slug: string;
      baseUrl?: string;
      previousVersion: string | null;
    }
  | {
      ok: false;
      slug: string;
      error: string;
    };

function resolveClawHubWorkspaceDirFromSkillDir(skillDir: string): string | null {
  const resolved = path.resolve(skillDir);
  const skillsDir = path.dirname(resolved);
  if (path.basename(skillsDir) !== "skills") {
    return null;
  }
  return path.dirname(skillsDir);
}

function clawHubWorkspaceKey(workspaceDir: string): string {
  return crypto.createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 24);
}

function clawHubSkillInstallKey(workspaceDir: string, slug: string): string {
  return `${clawHubWorkspaceKey(workspaceDir)}:${normalizeTrackedSkillSlug(slug)}`;
}

function recordToOrigin(record: ClawHubSkillInstallRecord): ClawHubSkillOrigin {
  return {
    version: 1,
    registry: record.registry,
    slug: record.slug,
    installedVersion: record.installedVersion,
    installedAt: record.installedAt,
  };
}

async function readClawHubSkillsLockfile(workspaceDir: string): Promise<ClawHubSkillsLockfile> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const keyPrefix = `${clawHubWorkspaceKey(resolvedWorkspaceDir)}:`;
  const trackedRows = await clawHubSkillInstallStore.entries();
  const trackedSkills: ClawHubSkillsLockfile["skills"] = {};
  for (const row of trackedRows) {
    if (
      !row.key.startsWith(keyPrefix) ||
      path.resolve(row.value.workspaceDir) !== resolvedWorkspaceDir
    ) {
      continue;
    }
    trackedSkills[row.value.slug] = {
      version: row.value.installedVersion,
      installedAt: row.value.installedAt,
    };
  }
  if (Object.keys(trackedSkills).length > 0) {
    return { version: 1, skills: trackedSkills };
  }

  return { version: 1, skills: {} };
}

async function writeClawHubSkillsLockfile(
  workspaceDir: string,
  lockfile: ClawHubSkillsLockfile,
): Promise<void> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  for (const [slug, entry] of Object.entries(lockfile.skills)) {
    const targetDir = resolveWorkspaceSkillInstallDir(resolvedWorkspaceDir, slug);
    const existing = await readClawHubSkillOrigin(targetDir);
    await clawHubSkillInstallStore.register(clawHubSkillInstallKey(resolvedWorkspaceDir, slug), {
      version: 1,
      registry: existing?.registry ?? resolveClawHubBaseUrl(undefined),
      slug,
      installedVersion: entry.version,
      installedAt: entry.installedAt,
      workspaceDir: resolvedWorkspaceDir,
      targetDir,
      updatedAt: Date.now(),
    });
  }
}

async function readClawHubSkillOrigin(skillDir: string): Promise<ClawHubSkillOrigin | null> {
  const resolvedSkillDir = path.resolve(skillDir);
  const workspaceDir = resolveClawHubWorkspaceDirFromSkillDir(resolvedSkillDir);
  if (workspaceDir) {
    const slug = path.basename(resolvedSkillDir);
    const row = await clawHubSkillInstallStore.lookup(clawHubSkillInstallKey(workspaceDir, slug));
    if (row) {
      return recordToOrigin(row);
    }
  }

  return null;
}

async function writeClawHubSkillOrigin(
  skillDir: string,
  origin: ClawHubSkillOrigin,
): Promise<void> {
  const resolvedSkillDir = path.resolve(skillDir);
  const workspaceDir = resolveClawHubWorkspaceDirFromSkillDir(resolvedSkillDir);
  if (!workspaceDir) {
    throw new Error(`Invalid ClawHub skill install directory: ${skillDir}`);
  }
  await clawHubSkillInstallStore.register(clawHubSkillInstallKey(workspaceDir, origin.slug), {
    ...origin,
    workspaceDir: path.resolve(workspaceDir),
    targetDir: resolvedSkillDir,
    updatedAt: Date.now(),
  });
}

export async function searchSkillsFromClawHub(params: {
  query?: string;
  limit?: number;
  baseUrl?: string;
}): Promise<ClawHubSkillSearchResult[]> {
  return await searchClawHubSkills({
    query: params.query?.trim() || "*",
    limit: params.limit,
    baseUrl: params.baseUrl,
  });
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

async function performClawHubSkillInstall(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    const { detail, version } = await resolveInstallVersion({
      slug: params.slug,
      version: params.version,
      baseUrl: params.baseUrl,
    });
    const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
    if (!params.force && (await pathExists(targetDir))) {
      return {
        ok: false,
        error: `Skill already exists at ${targetDir}. Re-run with force/update.`,
      };
    }

    params.logger?.info?.(`Downloading ${params.slug}@${version} from ClawHub…`);
    const archive = await downloadClawHubSkillArchive({
      slug: params.slug,
      version,
      baseUrl: params.baseUrl,
    });
    try {
      const install = await withExtractedArchiveRoot({
        archivePath: archive.archivePath,
        tempDirPrefix: "openclaw-skill-clawhub-",
        timeoutMs: 120_000,
        rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
        onExtracted: async (rootDir) =>
          await installExtractedSkillRoot({
            workspaceDir: params.workspaceDir,
            slug: params.slug,
            extractedRoot: rootDir,
            mode: params.force ? "update" : "install",
            logger: params.logger,
            scan: false,
            rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
          }),
      });
      if (!install.ok) {
        return { ok: false, error: install.error };
      }

      const installedAt = Date.now();
      await writeClawHubSkillOrigin(install.targetDir, {
        version: 1,
        registry: resolveClawHubBaseUrl(params.baseUrl),
        slug: params.slug,
        installedVersion: version,
        installedAt,
      });
      const lock = await readClawHubSkillsLockfile(params.workspaceDir);
      lock.skills[params.slug] = {
        version,
        installedAt,
      };
      await writeClawHubSkillsLockfile(params.workspaceDir, lock);

      return {
        ok: true,
        slug: params.slug,
        version,
        targetDir: install.targetDir,
        detail,
      };
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

async function installRequestedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: validateRequestedSkillSlug(params.slug),
    });
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

async function installTrackedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: normalizeTrackedSkillSlug(params.slug),
    });
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

async function resolveTrackedUpdateTarget(params: {
  workspaceDir: string;
  slug: string;
  lock: ClawHubSkillsLockfile;
  baseUrl?: string;
}): Promise<TrackedUpdateTarget> {
  const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
  const origin = (await readClawHubSkillOrigin(targetDir)) ?? null;
  if (!origin && !params.lock.skills[params.slug]) {
    return {
      ok: false,
      slug: params.slug,
      error: `Skill "${params.slug}" is not tracked as a ClawHub install.`,
    };
  }
  return {
    ok: true,
    slug: params.slug,
    baseUrl: origin?.registry ?? params.baseUrl,
    previousVersion: origin?.installedVersion ?? params.lock.skills[params.slug]?.version ?? null,
  };
}

export async function installSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  logger?: Logger;
}): Promise<InstallClawHubSkillResult> {
  return await installRequestedSkillFromClawHub(params);
}

export async function updateSkillsFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  logger?: Logger;
}): Promise<UpdateClawHubSkillResult[]> {
  const lock = await readClawHubSkillsLockfile(params.workspaceDir);
  const slugs = params.slug
    ? [
        await resolveRequestedUpdateSlug({
          workspaceDir: params.workspaceDir,
          requestedSlug: params.slug,
          lock,
        }),
      ]
    : Object.keys(lock.skills).map((slug) => normalizeTrackedSkillSlug(slug));
  const results: UpdateClawHubSkillResult[] = [];
  for (const slug of slugs) {
    const tracked = await resolveTrackedUpdateTarget({
      workspaceDir: params.workspaceDir,
      slug,
      lock,
      baseUrl: params.baseUrl,
    });
    if (!tracked.ok) {
      results.push({
        ok: false,
        error: tracked.error,
      });
      continue;
    }
    const install = await installTrackedSkillFromClawHub({
      workspaceDir: params.workspaceDir,
      slug: tracked.slug,
      baseUrl: tracked.baseUrl,
      force: true,
      logger: params.logger,
    });
    if (!install.ok) {
      results.push(install);
      continue;
    }
    results.push({
      ok: true,
      slug: tracked.slug,
      previousVersion: tracked.previousVersion,
      version: install.version,
      changed: tracked.previousVersion !== install.version,
      targetDir: install.targetDir,
    });
  }
  return results;
}

export async function readTrackedClawHubSkillSlugs(workspaceDir: string): Promise<string[]> {
  const lock = await readClawHubSkillsLockfile(workspaceDir);
  return Object.keys(lock.skills).toSorted();
}
