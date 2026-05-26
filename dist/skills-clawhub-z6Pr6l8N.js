import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { i as resolveSafeInstallDir } from "./install-safe-path-DEiFZ_bF.js";
import { m as writeJson, o as tryReadJson } from "./json-files-C2hqjU--.js";
import { h as searchClawHubSkills, r as downloadClawHubSkillArchive, s as fetchClawHubSkillDetail, u as resolveClawHubBaseUrl } from "./clawhub-B9rdLaiz.js";
import { i as withExtractedArchiveRoot, t as installPackageDir } from "./install-package-dir-CRDuBtnD.js";
import { a as scanSkillInstallSource } from "./install-security-scan-Bg5dT8e-.js";
import path from "node:path";
//#region src/agents/skills-archive-install.ts
const VALID_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS = ["SKILL.md"];
const CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS = [
	"SKILL.md",
	"skill.md",
	"skills.md",
	"SKILL.MD"
];
function hasNonAscii(value) {
	for (const char of value) if (char.charCodeAt(0) > 127) return true;
	return false;
}
function normalizeTrackedSkillSlug(raw) {
	const slug = raw.trim();
	if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) throw new Error(`Invalid skill slug: ${raw}`);
	return slug;
}
function validateRequestedSkillSlug(raw) {
	const slug = normalizeTrackedSkillSlug(raw);
	if (hasNonAscii(slug) || !VALID_SLUG_PATTERN.test(slug)) throw new Error(`Invalid skill slug: ${raw}`);
	return slug;
}
function resolveWorkspaceSkillInstallDir(workspaceDir, slug) {
	const target = resolveSafeInstallDir({
		baseDir: path.join(path.resolve(workspaceDir), "skills"),
		id: slug,
		invalidNameMessage: "invalid skill target path"
	});
	if (!target.ok) throw new Error(target.error);
	return target.path;
}
function installFailure(error, failureKind) {
	return {
		ok: false,
		error,
		failureKind
	};
}
async function hasSkillArchiveRoot(rootDir, rootMarkers) {
	for (const candidate of rootMarkers) if (await pathExists(path.join(rootDir, candidate))) return true;
	return false;
}
function scanBlockedFailureKind(blocked) {
	return blocked.code === "security_scan_failed" ? "unavailable" : "invalid-request";
}
const TRANSIENT_ARCHIVE_ERROR_PATTERNS = [
	"enoent",
	"enospc",
	"eio",
	"eacces",
	"eperm",
	"ebusy",
	"emfile",
	"enfile",
	"timeout",
	"timed out"
];
function archiveFailureKind(error) {
	const lower = error.toLowerCase();
	if (lower.startsWith("failed to install skill:")) return "unavailable";
	for (const pattern of TRANSIENT_ARCHIVE_ERROR_PATTERNS) if (lower.includes(pattern)) return "unavailable";
	return "invalid-request";
}
async function installExtractedSkillRoot(params) {
	try {
		if (!await hasSkillArchiveRoot(params.extractedRoot, params.rootMarkers ?? DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS)) return installFailure("archive is missing SKILL.md", "invalid-request");
		let targetDir;
		try {
			targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
		} catch (err) {
			return installFailure(formatErrorMessage(err), "invalid-request");
		}
		if (params.mode === "install" && await pathExists(targetDir)) return installFailure(`Skill already exists at ${targetDir}. Re-run with force/update.`, "invalid-request");
		if (params.scan) {
			const scanResult = await scanSkillInstallSource({
				dangerouslyForceUnsafeInstall: params.scan.dangerouslyForceUnsafeInstall,
				installId: params.scan.installId ?? "archive",
				logger: params.logger ?? {},
				origin: params.scan.origin,
				skillName: params.slug,
				sourceDir: params.extractedRoot
			});
			if (scanResult?.blocked) return installFailure(scanResult.blocked.reason, scanBlockedFailureKind(scanResult.blocked));
		}
		const install = await installPackageDir({
			sourceDir: params.extractedRoot,
			targetDir,
			mode: params.mode,
			timeoutMs: params.timeoutMs ?? 12e4,
			logger: params.logger,
			copyErrorPrefix: "failed to install skill",
			hasDeps: false,
			depsLogMessage: ""
		});
		if (!install.ok) return installFailure(install.error, "unavailable");
		return {
			ok: true,
			targetDir
		};
	} catch (err) {
		return installFailure(formatErrorMessage(err), "unavailable");
	}
}
async function installSkillArchiveFromPath(params) {
	const result = await withExtractedArchiveRoot({
		archivePath: params.archivePath,
		tempDirPrefix: "openclaw-skill-archive-",
		timeoutMs: params.timeoutMs ?? 12e4,
		logger: params.logger,
		rootMarkers: ["SKILL.md"],
		onExtracted: async (rootDir) => await installExtractedSkillRoot({
			workspaceDir: params.workspaceDir,
			slug: params.slug,
			extractedRoot: rootDir,
			mode: params.force ? "update" : "install",
			timeoutMs: params.timeoutMs,
			logger: params.logger,
			scan: params.scan
		})
	});
	if (!result.ok) {
		const error = result.error.includes("unexpected archive layout") ? "archive is missing SKILL.md" : result.error;
		return installFailure(error, "failureKind" in result && (result.failureKind === "invalid-request" || result.failureKind === "unavailable") ? result.failureKind : archiveFailureKind(error));
	}
	return result;
}
//#endregion
//#region src/agents/skills-clawhub.ts
const DOT_DIR = ".clawhub";
const LEGACY_DOT_DIR = ".clawdhub";
const SKILL_ORIGIN_RELATIVE_PATH = path.join(DOT_DIR, "origin.json");
async function resolveRequestedUpdateSlug(params) {
	const trackedSlug = normalizeTrackedSkillSlug(params.requestedSlug);
	if (await readClawHubSkillOrigin(resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug)) || params.lock.skills[trackedSlug]) return trackedSlug;
	return validateRequestedSkillSlug(params.requestedSlug);
}
async function readClawHubSkillsLockfile(workspaceDir) {
	const candidates = [path.join(workspaceDir, DOT_DIR, "lock.json"), path.join(workspaceDir, LEGACY_DOT_DIR, "lock.json")];
	for (const candidate of candidates) try {
		const raw = await tryReadJson(candidate);
		if (raw?.version === 1 && raw.skills && typeof raw.skills === "object") return {
			version: 1,
			skills: raw.skills
		};
	} catch {}
	return {
		version: 1,
		skills: {}
	};
}
async function writeClawHubSkillsLockfile(workspaceDir, lockfile) {
	await writeJson(path.join(workspaceDir, DOT_DIR, "lock.json"), lockfile, { trailingNewline: true });
}
async function readClawHubSkillOrigin(skillDir) {
	const candidates = [path.join(skillDir, DOT_DIR, "origin.json"), path.join(skillDir, LEGACY_DOT_DIR, "origin.json")];
	for (const candidate of candidates) try {
		const raw = await tryReadJson(candidate);
		if (raw?.version === 1 && typeof raw.registry === "string" && typeof raw.slug === "string" && typeof raw.installedVersion === "string" && typeof raw.installedAt === "number") return raw;
	} catch {}
	return null;
}
async function writeClawHubSkillOrigin(skillDir, origin) {
	await writeJson(path.join(skillDir, SKILL_ORIGIN_RELATIVE_PATH), origin, { trailingNewline: true });
}
async function searchSkillsFromClawHub(params) {
	return await searchClawHubSkills({
		query: params.query?.trim() || "*",
		limit: params.limit,
		baseUrl: params.baseUrl
	});
}
async function resolveInstallVersion(params) {
	const detail = await fetchClawHubSkillDetail({
		slug: params.slug,
		baseUrl: params.baseUrl
	});
	if (!detail.skill) throw new Error(`Skill "${params.slug}" not found on ClawHub.`);
	const resolvedVersion = params.version ?? detail.latestVersion?.version;
	if (!resolvedVersion) throw new Error(`Skill "${params.slug}" has no installable version.`);
	return {
		detail,
		version: resolvedVersion
	};
}
async function performClawHubSkillInstall(params) {
	try {
		const { detail, version } = await resolveInstallVersion({
			slug: params.slug,
			version: params.version,
			baseUrl: params.baseUrl
		});
		const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
		if (!params.force && await pathExists(targetDir)) return {
			ok: false,
			error: `Skill already exists at ${targetDir}. Re-run with force/update.`
		};
		params.logger?.info?.(`Downloading ${params.slug}@${version} from ClawHub…`);
		const archive = await downloadClawHubSkillArchive({
			slug: params.slug,
			version,
			baseUrl: params.baseUrl
		});
		try {
			const install = await withExtractedArchiveRoot({
				archivePath: archive.archivePath,
				tempDirPrefix: "openclaw-skill-clawhub-",
				timeoutMs: 12e4,
				rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
				onExtracted: async (rootDir) => await installExtractedSkillRoot({
					workspaceDir: params.workspaceDir,
					slug: params.slug,
					extractedRoot: rootDir,
					mode: params.force ? "update" : "install",
					logger: params.logger,
					scan: false,
					rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS
				})
			});
			if (!install.ok) return {
				ok: false,
				error: install.error
			};
			const installedAt = Date.now();
			await writeClawHubSkillOrigin(install.targetDir, {
				version: 1,
				registry: resolveClawHubBaseUrl(params.baseUrl),
				slug: params.slug,
				installedVersion: version,
				installedAt
			});
			const lock = await readClawHubSkillsLockfile(params.workspaceDir);
			lock.skills[params.slug] = {
				version,
				installedAt
			};
			await writeClawHubSkillsLockfile(params.workspaceDir, lock);
			return {
				ok: true,
				slug: params.slug,
				version,
				targetDir: install.targetDir,
				detail
			};
		} finally {
			await archive.cleanup().catch(() => void 0);
		}
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
		};
	}
}
async function installRequestedSkillFromClawHub(params) {
	try {
		return await performClawHubSkillInstall({
			...params,
			slug: validateRequestedSkillSlug(params.slug)
		});
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
		};
	}
}
async function installTrackedSkillFromClawHub(params) {
	try {
		return await performClawHubSkillInstall({
			...params,
			slug: normalizeTrackedSkillSlug(params.slug)
		});
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
		};
	}
}
async function resolveTrackedUpdateTarget(params) {
	const origin = await readClawHubSkillOrigin(resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug)) ?? null;
	if (!origin && !params.lock.skills[params.slug]) return {
		ok: false,
		slug: params.slug,
		error: `Skill "${params.slug}" is not tracked as a ClawHub install.`
	};
	return {
		ok: true,
		slug: params.slug,
		baseUrl: origin?.registry ?? params.baseUrl,
		previousVersion: origin?.installedVersion ?? params.lock.skills[params.slug]?.version ?? null
	};
}
async function installSkillFromClawHub(params) {
	return await installRequestedSkillFromClawHub(params);
}
async function updateSkillsFromClawHub(params) {
	const lock = await readClawHubSkillsLockfile(params.workspaceDir);
	const slugs = params.slug ? [await resolveRequestedUpdateSlug({
		workspaceDir: params.workspaceDir,
		requestedSlug: params.slug,
		lock
	})] : Object.keys(lock.skills).map((slug) => normalizeTrackedSkillSlug(slug));
	const results = [];
	for (const slug of slugs) {
		const tracked = await resolveTrackedUpdateTarget({
			workspaceDir: params.workspaceDir,
			slug,
			lock,
			baseUrl: params.baseUrl
		});
		if (!tracked.ok) {
			results.push({
				ok: false,
				error: tracked.error
			});
			continue;
		}
		const install = await installTrackedSkillFromClawHub({
			workspaceDir: params.workspaceDir,
			slug: tracked.slug,
			baseUrl: tracked.baseUrl,
			force: true,
			logger: params.logger
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
			targetDir: install.targetDir
		});
	}
	return results;
}
async function readTrackedClawHubSkillSlugs(workspaceDir) {
	const lock = await readClawHubSkillsLockfile(workspaceDir);
	return Object.keys(lock.skills).toSorted();
}
async function untrackClawHubSkill(workspaceDir, slug) {
	const trackedSlug = normalizeTrackedSkillSlug(slug);
	const lock = await readClawHubSkillsLockfile(workspaceDir);
	if (!lock.skills[trackedSlug]) return;
	delete lock.skills[trackedSlug];
	await writeClawHubSkillsLockfile(workspaceDir, lock);
}
//#endregion
export { updateSkillsFromClawHub as a, validateRequestedSkillSlug as c, untrackClawHubSkill as i, readTrackedClawHubSkillSlugs as n, installExtractedSkillRoot as o, searchSkillsFromClawHub as r, installSkillArchiveFromPath as s, installSkillFromClawHub as t };
