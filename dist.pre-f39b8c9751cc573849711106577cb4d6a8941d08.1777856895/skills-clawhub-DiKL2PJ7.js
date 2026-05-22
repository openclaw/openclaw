import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { l as fileExists } from "./archive-SMPwZ5xH.js";
import { r as resolveSafeInstallDir } from "./install-safe-path-CvA8J7h7.js";
import { h as searchClawHubSkills, r as downloadClawHubSkillArchive, s as fetchClawHubSkillDetail, u as resolveClawHubBaseUrl } from "./clawhub-CyouiCKz.js";
import { i as withExtractedArchiveRoot, t as installPackageDir } from "./install-package-dir-BmNFOHGH.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/agents/skills-clawhub.ts
const DOT_DIR = ".clawhub";
const LEGACY_DOT_DIR = ".clawdhub";
const SKILL_ORIGIN_RELATIVE_PATH = path.join(DOT_DIR, "origin.json");
const VALID_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
function normalizeTrackedSlug(raw) {
	const slug = raw.trim();
	if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) throw new Error(`Invalid skill slug: ${raw}`);
	return slug;
}
function validateRequestedSlug(raw) {
	const slug = normalizeTrackedSlug(raw);
	if (NON_ASCII_PATTERN.test(slug) || !VALID_SLUG_PATTERN.test(slug)) throw new Error(`Invalid skill slug: ${raw}`);
	return slug;
}
async function resolveRequestedUpdateSlug(params) {
	const trackedSlug = normalizeTrackedSlug(params.requestedSlug);
	if (await readClawHubSkillOrigin(resolveSkillInstallDir(params.workspaceDir, trackedSlug)) || params.lock.skills[trackedSlug]) return trackedSlug;
	return validateRequestedSlug(params.requestedSlug);
}
function resolveSkillInstallDir(workspaceDir, slug) {
	const target = resolveSafeInstallDir({
		baseDir: path.join(path.resolve(workspaceDir), "skills"),
		id: slug,
		invalidNameMessage: "invalid skill target path"
	});
	if (!target.ok) throw new Error(target.error);
	return target.path;
}
async function ensureSkillRoot(rootDir) {
	for (const candidate of [
		"SKILL.md",
		"skill.md",
		"skills.md",
		"SKILL.MD"
	]) if (await fileExists(path.join(rootDir, candidate))) return;
	throw new Error("downloaded archive is missing SKILL.md");
}
async function readClawHubSkillsLockfile(workspaceDir) {
	const candidates = [path.join(workspaceDir, DOT_DIR, "lock.json"), path.join(workspaceDir, LEGACY_DOT_DIR, "lock.json")];
	for (const candidate of candidates) try {
		const raw = JSON.parse(await fs.readFile(candidate, "utf8"));
		if (raw.version === 1 && raw.skills && typeof raw.skills === "object") return {
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
	const targetPath = path.join(workspaceDir, DOT_DIR, "lock.json");
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.writeFile(targetPath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
}
async function readClawHubSkillOrigin(skillDir) {
	const candidates = [path.join(skillDir, DOT_DIR, "origin.json"), path.join(skillDir, LEGACY_DOT_DIR, "origin.json")];
	for (const candidate of candidates) try {
		const raw = JSON.parse(await fs.readFile(candidate, "utf8"));
		if (raw.version === 1 && typeof raw.registry === "string" && typeof raw.slug === "string" && typeof raw.installedVersion === "string" && typeof raw.installedAt === "number") return raw;
	} catch {}
	return null;
}
async function writeClawHubSkillOrigin(skillDir, origin) {
	const targetPath = path.join(skillDir, SKILL_ORIGIN_RELATIVE_PATH);
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.writeFile(targetPath, `${JSON.stringify(origin, null, 2)}\n`, "utf8");
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
async function installExtractedSkill(params) {
	await ensureSkillRoot(params.extractedRoot);
	const targetDir = resolveSkillInstallDir(params.workspaceDir, params.slug);
	const install = await installPackageDir({
		sourceDir: params.extractedRoot,
		targetDir,
		mode: params.mode,
		timeoutMs: 12e4,
		logger: params.logger,
		copyErrorPrefix: "failed to install skill",
		hasDeps: false,
		depsLogMessage: ""
	});
	if (!install.ok) return install;
	return {
		ok: true,
		targetDir
	};
}
async function performClawHubSkillInstall(params) {
	try {
		const { detail, version } = await resolveInstallVersion({
			slug: params.slug,
			version: params.version,
			baseUrl: params.baseUrl
		});
		const targetDir = resolveSkillInstallDir(params.workspaceDir, params.slug);
		if (!params.force && await fileExists(targetDir)) return {
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
				rootMarkers: ["SKILL.md"],
				onExtracted: async (rootDir) => await installExtractedSkill({
					workspaceDir: params.workspaceDir,
					slug: params.slug,
					extractedRoot: rootDir,
					mode: params.force ? "update" : "install",
					logger: params.logger
				})
			});
			if (!install.ok) return install;
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
			slug: validateRequestedSlug(params.slug)
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
			slug: normalizeTrackedSlug(params.slug)
		});
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
		};
	}
}
async function resolveTrackedUpdateTarget(params) {
	const origin = await readClawHubSkillOrigin(resolveSkillInstallDir(params.workspaceDir, params.slug)) ?? null;
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
	})] : Object.keys(lock.skills).map((slug) => normalizeTrackedSlug(slug));
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
//#endregion
export { updateSkillsFromClawHub as i, readTrackedClawHubSkillSlugs as n, searchSkillsFromClawHub as r, installSkillFromClawHub as t };
