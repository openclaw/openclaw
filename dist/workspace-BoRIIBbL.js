import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as resolveOsHomeDir } from "./home-dir-BOPFpGo8.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { o as walkDirectorySync } from "./fs-safe-CV86zY9G.js";
import { i as openRootFileSync } from "./root-file-jRMCpJW4.js";
import { f as resolveHomeDir, p as resolveUserPath, t as CONFIG_DIR } from "./utils-sBTEdeml.js";
import "./path-guards-CBe_wA_B.js";
import { n as normalizeSkillFilter } from "./filter-CuPfbjn1.js";
import { n as resolveEffectiveAgentSkillsLimits, t as resolveEffectiveAgentSkillFilter } from "./agent-filter-CZoQBzQY.js";
import "./boundary-file-read-CBe_wA_B.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { a as resolveSandboxPath } from "./sandbox-paths-BTYunIeX.js";
import { n as resolveOpenClawMetadata, r as resolveSkillInvocationPolicy, t as parseFrontmatter } from "./frontmatter-BTFF5uon.js";
import { a as shouldIncludeSkill } from "./config-DU04JXyx.js";
import { t as resolveBundledSkillsDir } from "./bundled-dir-B-vmTgAr.js";
import { t as resolvePluginSkillDirs } from "./plugin-skills-D8eZ0xBY.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/agents/skills/skill-contract.ts
function createSyntheticSourceInfo(path, options) {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir
	};
}
function escapeXml$1(str) {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
/**
* Keep this formatter's XML layout byte-for-byte aligned with the upstream
* Agent Skills formatter so we can avoid importing the full pi-coding-agent
* package root on the cold skills path. Visibility policy is applied upstream
* before calling this helper.
*/
function formatSkillsForPrompt(skills) {
	if (skills.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>"
	];
	for (const skill of skills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml$1(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml$1(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml$1(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}
//#endregion
//#region src/agents/skills/local-loader.ts
function readSkillFileSync(params) {
	const opened = openRootFileSync({
		absolutePath: params.filePath,
		rootPath: params.rootRealPath,
		rootRealPath: params.rootRealPath,
		boundaryLabel: "skill root",
		maxBytes: params.maxBytes
	});
	if (!opened.ok) return null;
	try {
		return fs.readFileSync(opened.fd, "utf8");
	} finally {
		fs.closeSync(opened.fd);
	}
}
function loadSingleSkillDirectory(params) {
	const skillFilePath = path.join(params.skillDir, "SKILL.md");
	const raw = readSkillFileSync({
		rootRealPath: params.rootRealPath,
		filePath: skillFilePath,
		maxBytes: params.maxBytes
	});
	if (!raw) return null;
	let frontmatter;
	try {
		frontmatter = parseFrontmatter(raw);
	} catch {
		return null;
	}
	const fallbackName = path.basename(params.skillDir).trim();
	const name = frontmatter.name?.trim() || fallbackName;
	const description = frontmatter.description?.trim();
	if (!name || !description) return null;
	const invocation = resolveSkillInvocationPolicy(frontmatter);
	const filePath = path.resolve(skillFilePath);
	const baseDir = path.resolve(params.skillDir);
	return {
		skill: {
			name,
			description,
			filePath,
			baseDir,
			source: params.source,
			sourceInfo: createSyntheticSourceInfo(filePath, {
				source: params.source,
				baseDir,
				scope: "project",
				origin: "top-level"
			}),
			disableModelInvocation: invocation.disableModelInvocation
		},
		frontmatter
	};
}
function listCandidateSkillDirs(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules").map((entry) => path.join(dir, entry.name)).sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
}
function loadSkillsFromDirSafe(params) {
	const rootDir = path.resolve(params.dir);
	let rootRealPath;
	try {
		rootRealPath = fs.realpathSync(rootDir);
	} catch {
		return {
			skills: [],
			frontmatterByFilePath: /* @__PURE__ */ new Map()
		};
	}
	const rootSkill = loadSingleSkillDirectory({
		skillDir: rootDir,
		source: params.source,
		rootRealPath,
		maxBytes: params.maxBytes
	});
	if (rootSkill) return {
		skills: [rootSkill.skill],
		frontmatterByFilePath: new Map([[rootSkill.skill.filePath, rootSkill.frontmatter]])
	};
	const loadedSkills = listCandidateSkillDirs(rootDir).map((skillDir) => loadSingleSkillDirectory({
		skillDir,
		source: params.source,
		rootRealPath,
		maxBytes: params.maxBytes
	})).filter((skill) => skill !== null);
	const frontmatterByFilePath = /* @__PURE__ */ new Map();
	for (const loaded of loadedSkills) frontmatterByFilePath.set(loaded.skill.filePath, loaded.frontmatter);
	return {
		skills: loadedSkills.map((loaded) => loaded.skill),
		frontmatterByFilePath
	};
}
function readSkillFrontmatterSafe(params) {
	let rootRealPath;
	try {
		rootRealPath = fs.realpathSync(path.resolve(params.rootDir));
	} catch {
		return null;
	}
	const raw = readSkillFileSync({
		rootRealPath,
		filePath: path.resolve(params.filePath),
		maxBytes: params.maxBytes
	});
	if (!raw) return null;
	try {
		return parseFrontmatter(raw);
	} catch {
		return null;
	}
}
//#endregion
//#region src/agents/skills/serialize.ts
const SKILLS_SYNC_QUEUE = /* @__PURE__ */ new Map();
async function serializeByKey(key, task) {
	const next = (SKILLS_SYNC_QUEUE.get(key) ?? Promise.resolve()).then(task, task);
	SKILLS_SYNC_QUEUE.set(key, next);
	try {
		return await next;
	} finally {
		if (SKILLS_SYNC_QUEUE.get(key) === next) SKILLS_SYNC_QUEUE.delete(key);
	}
}
//#endregion
//#region src/agents/skills/workspace.ts
const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");
/**
* Replace the user's home directory prefix with `~` in skill file paths
* to reduce system prompt token usage. Models understand `~` expansion,
* and the read tool resolves `~` to the home directory.
*
* Example: `/Users/alice/.bun/.../skills/github/SKILL.md`
*       → `~/.bun/.../skills/github/SKILL.md`
*
* Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.
*/
function resolveUserHomeDir() {
	return resolveOsHomeDir(process.env, os.homedir);
}
function resolveNativeUserHomeDir() {
	try {
		return path.resolve(os.homedir());
	} catch {
		return;
	}
}
function resolveCompactHomePrefixes() {
	const resolvedHomes = [
		resolveHomeDir(),
		resolveUserHomeDir(),
		resolveNativeUserHomeDir()
	].filter((home) => !!home).map((home) => path.resolve(home));
	const realHomes = resolvedHomes.map((home) => tryRealpath(home)).filter((home) => !!home);
	return [...resolvedHomes, ...realHomes].filter((home, index, all) => all.indexOf(home) === index).sort((a, b) => b.length - a.length);
}
function compactSkillPaths(skills) {
	const homes = resolveCompactHomePrefixes();
	if (homes.length === 0) return skills;
	return skills.map((s) => ({
		...s,
		filePath: compactHomePath(s.filePath, homes)
	}));
}
function compactHomePath(filePath, homes) {
	for (const home of homes) for (const prefix of compactHomePrefixesForHome(home)) if (filePath.startsWith(prefix)) return "~/" + normalizeCompactedSkillPath(filePath.slice(prefix.length), prefix);
	return filePath;
}
function compactHomePrefixesForHome(home) {
	const prefixes = [home.endsWith(path.sep) ? home : home + path.sep];
	if (home.includes("\\") && !home.endsWith("\\")) prefixes.push(home + "\\");
	return prefixes;
}
function normalizeCompactedSkillPath(filePath, matchedHomePrefix) {
	return matchedHomePrefix.includes("\\") ? filePath.replace(/\\/g, "/") : filePath;
}
function compactPathForConsoleMessage(filePath) {
	return compactHomePath(filePath, resolveCompactHomePrefixes());
}
function isSkillVisibleInAvailableSkillsPrompt(entry) {
	if (entry.exposure) return entry.exposure.includeInAvailableSkillsPrompt !== false;
	if (entry.invocation) return entry.invocation.disableModelInvocation !== true;
	return entry.skill.disableModelInvocation !== true;
}
function filterSkillEntries(entries, config, skillFilter, eligibility) {
	let filtered = entries.filter((entry) => shouldIncludeSkill({
		entry,
		config,
		eligibility
	}));
	if (skillFilter !== void 0) {
		const normalized = normalizeSkillFilter(skillFilter) ?? [];
		const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
		skillsLogger.debug(`Applying skill filter: ${label}`);
		filtered = normalized.length > 0 ? filtered.filter((entry) => normalized.includes(entry.skill.name)) : [];
		skillsLogger.debug(`After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`);
	}
	return filtered;
}
const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18e3;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256e3;
const DEFAULT_MIN_RAW_ENTRIES_PER_DIRECTORY_SCAN = 1e3;
const DEFAULT_MAX_RAW_ENTRIES_PER_DIRECTORY_SCAN = 1e4;
function resolveSkillsLimits(config, agentId) {
	const limits = config?.skills?.limits;
	const agentSkillsLimits = resolveEffectiveAgentSkillsLimits(config, agentId);
	return {
		maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
		maxSkillsLoadedPerSource: limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
		maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
		maxSkillsPromptChars: agentSkillsLimits?.maxSkillsPromptChars ?? limits?.maxSkillsPromptChars ?? DEFAULT_MAX_SKILLS_PROMPT_CHARS,
		maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES
	};
}
function listChildDirectories(dir, opts) {
	const scan = walkDirectorySync(dir, {
		maxDepth: 1,
		maxEntries: opts?.maxRawEntriesToScan === void 0 ? resolveRawEntryScanLimit(opts?.maxCandidateDirs) : Math.max(0, opts.maxRawEntriesToScan),
		symlinks: "follow",
		include: (entry) => entry.kind === "directory" && !entry.name.startsWith(".") && entry.name !== "node_modules"
	});
	if (scan.scannedEntryCount === 0 && scan.entries.length === 0) return {
		dirs: [],
		scannedEntryCount: 0,
		truncated: false
	};
	return {
		dirs: scan.entries.map((entry) => entry.name),
		scannedEntryCount: scan.scannedEntryCount,
		truncated: scan.truncated
	};
}
function resolveRawEntryScanLimit(maxCandidateDirs) {
	if (maxCandidateDirs === void 0) return Number.POSITIVE_INFINITY;
	const normalized = Math.max(0, maxCandidateDirs);
	if (normalized === 0) return 0;
	return Math.min(DEFAULT_MAX_RAW_ENTRIES_PER_DIRECTORY_SCAN, Math.max(DEFAULT_MIN_RAW_ENTRIES_PER_DIRECTORY_SCAN, normalized * 10));
}
function tryRealpath(filePath) {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return null;
	}
}
function isSymlinkPath(filePath) {
	try {
		return fs.lstatSync(filePath).isSymbolicLink();
	} catch {
		return false;
	}
}
function buildEscapedSkillPathReason(params) {
	const candidateIsSymlink = isSymlinkPath(params.candidatePath);
	if (params.source === "openclaw-bundled" && candidateIsSymlink) return {
		reason: "bundled-symlink-escape",
		consoleHint: "reason=bundled-symlink-escape hint=likely-stray-local-symlink-or-checkout-mutation"
	};
	if (candidateIsSymlink) return {
		reason: "symlink-escape",
		consoleHint: "reason=symlink-escape"
	};
	if (params.source === "openclaw-bundled") return {
		reason: "bundled-root-escape",
		consoleHint: "reason=bundled-root-escape hint=likely-stray-local-symlink-or-checkout-mutation"
	};
	return {
		reason: "path-escape",
		consoleHint: "reason=path-escape"
	};
}
function warnEscapedSkillPath(params) {
	const compactRootDir = compactPathForConsoleMessage(params.rootDir);
	const compactRootRealPath = compactPathForConsoleMessage(params.rootRealPath);
	const compactCandidatePath = compactPathForConsoleMessage(params.candidatePath);
	const compactCandidateRealPath = compactPathForConsoleMessage(params.candidateRealPath);
	const rootResolved = path.resolve(params.rootDir) === params.rootRealPath ? "" : ` rootResolved=${compactRootRealPath}`;
	const escapeReason = buildEscapedSkillPathReason({
		source: params.source,
		candidatePath: params.candidatePath
	});
	skillsLogger.warn("Skipping escaped skill path outside its configured root.", {
		source: params.source,
		rootDir: params.rootDir,
		rootRealPath: params.rootRealPath,
		path: params.candidatePath,
		realPath: params.candidateRealPath,
		reason: escapeReason.reason,
		consoleMessage: `Skipping escaped skill path outside its configured root: source=${params.source} root=${compactRootDir}${rootResolved} ${escapeReason.consoleHint} requested=${compactCandidatePath} resolved=${compactCandidateRealPath}`
	});
}
function resolveContainedSkillPath(params) {
	const candidateRealPath = tryRealpath(params.candidatePath);
	if (!candidateRealPath) return null;
	if (isPathInside(params.rootRealPath, candidateRealPath) || isPathInsideAnyRoot(params.allowedSymlinkTargetRealPaths ?? [], candidateRealPath)) return candidateRealPath;
	warnEscapedSkillPath({
		source: params.source,
		rootDir: params.rootDir,
		rootRealPath: params.rootRealPath,
		candidatePath: path.resolve(params.candidatePath),
		candidateRealPath
	});
	return null;
}
function resolveNestedSkillsRoot(dir, opts) {
	const nested = path.join(dir, "skills");
	try {
		if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) return { baseDir: dir };
	} catch {
		return { baseDir: dir };
	}
	const nestedDirs = listChildDirectories(nested, { maxCandidateDirs: Math.max(0, opts?.maxEntriesToScan ?? 100) }).dirs;
	for (const name of nestedDirs) {
		const skillMd = path.join(nested, name, "SKILL.md");
		if (fs.existsSync(skillMd)) return {
			baseDir: nested,
			note: `Detected nested skills root at ${nested}`
		};
	}
	return { baseDir: dir };
}
function unwrapLoadedSkillRecords(loaded) {
	if (Array.isArray(loaded)) return loaded.map((skill) => ({ skill }));
	if (loaded && typeof loaded === "object" && "skills" in loaded) {
		const skills = loaded.skills;
		if (Array.isArray(skills)) {
			const loadedResult = loaded;
			const frontmatterByFilePath = loadedResult.frontmatterByFilePath instanceof Map ? loadedResult.frontmatterByFilePath : void 0;
			return skills.map((skill) => ({
				skill,
				frontmatter: frontmatterByFilePath?.get(skill.filePath)
			}));
		}
	}
	return [];
}
function loadContainedSkillRecords(params) {
	const expectedBaseDir = path.resolve(params.skillDir);
	const records = unwrapLoadedSkillRecords(loadSkillsFromDirSafe({
		dir: params.skillDir,
		source: params.source,
		maxBytes: params.maxSkillFileBytes
	})).filter((record) => path.resolve(record.skill.baseDir) === expectedBaseDir);
	const canonicalSkillDir = params.canonicalSkillDir;
	return canonicalSkillDir ? records.map((record) => canonicalizeLoadedSkillRecord(record, canonicalSkillDir)) : records;
}
function canonicalizeLoadedSkillRecord(record, canonicalSkillDir) {
	const originalBaseDir = path.resolve(record.skill.baseDir);
	const canonicalBaseDir = path.resolve(canonicalSkillDir);
	if (originalBaseDir === canonicalBaseDir) return record;
	const filePath = path.join(canonicalBaseDir, path.relative(originalBaseDir, record.skill.filePath));
	return {
		...record,
		syncSourceDir: canonicalBaseDir,
		syncDirName: path.basename(originalBaseDir),
		skill: {
			...record.skill,
			filePath,
			baseDir: canonicalBaseDir,
			sourceInfo: record.skill.sourceInfo ? {
				...record.skill.sourceInfo,
				path: filePath,
				baseDir: canonicalBaseDir
			} : record.skill.sourceInfo
		}
	};
}
function isPathInsideAnyRoot(rootRealPaths, candidateRealPath) {
	return rootRealPaths.some((rootRealPath) => isPathInside(rootRealPath, candidateRealPath));
}
function shouldEnforceConfiguredSkillRootContainment(source) {
	return source !== "openclaw-managed" && source !== "agents-skills-personal";
}
function shouldUseConfiguredSymlinkTargets(source) {
	return source === "openclaw-workspace" || source === "openclaw-extra" || source === "agents-skills-project";
}
function resolveSkillRootCandidatePath(params) {
	if (!shouldEnforceConfiguredSkillRootContainment(params.source)) return tryRealpath(params.candidatePath);
	return resolveContainedSkillPath({
		source: params.source,
		rootDir: params.rootDir,
		rootRealPath: params.rootRealPath,
		candidatePath: params.candidatePath,
		allowedSymlinkTargetRealPaths: shouldUseConfiguredSymlinkTargets(params.source) ? params.allowedSymlinkTargetRealPaths : []
	});
}
function canonicalSkillDirForSource(source, skillDirRealPath) {
	return shouldEnforceConfiguredSkillRootContainment(source) ? void 0 : skillDirRealPath;
}
function resolveSkillFilePath(params) {
	return resolveContainedSkillPath({
		source: params.source,
		rootDir: params.skillDir,
		rootRealPath: params.skillDirRealPath,
		candidatePath: params.candidatePath
	});
}
function resolvePluginSkillRootRealPaths(pluginSkillDirs) {
	return pluginSkillDirs.map((dir) => tryRealpath(dir)).filter((dir) => Boolean(dir)).filter((dir, index, all) => all.indexOf(dir) === index);
}
function resolveAllowedSymlinkTargetRealPaths(config) {
	return (config?.skills?.load?.allowSymlinkTargets ?? []).map((dir) => normalizeOptionalString(dir) ?? "").filter(Boolean).map((dir) => tryRealpath(resolveUserPath(dir))).filter((dir) => Boolean(dir)).filter((dir, index, all) => all.indexOf(dir) === index);
}
function loadGeneratedPluginSkillRecords(params) {
	const allowedRootRealPaths = resolvePluginSkillRootRealPaths(params.pluginSkillDirs);
	if (allowedRootRealPaths.length === 0) return [];
	const rootDir = path.resolve(params.pluginSkillsDir);
	if (!fs.existsSync(rootDir)) return [];
	const rootRealPath = tryRealpath(rootDir) ?? rootDir;
	const maxCandidatesPerRoot = Math.max(0, params.limits.maxCandidatesPerRoot);
	const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
	const childDirScan = listChildDirectories(rootDir, { maxCandidateDirs: maxCandidatesPerRoot });
	const childDirs = maxSkillsLoadedPerSource === 0 ? [] : childDirScan.dirs.toSorted().slice(0, maxCandidatesPerRoot);
	const loadedSkills = [];
	for (const name of childDirs) {
		const skillDir = path.join(rootDir, name);
		if (!isSymlinkPath(skillDir)) continue;
		const skillDirRealPath = tryRealpath(skillDir);
		if (!skillDirRealPath || !isPathInsideAnyRoot(allowedRootRealPaths, skillDirRealPath)) {
			if (skillDirRealPath) warnEscapedSkillPath({
				source: params.source,
				rootDir,
				rootRealPath,
				candidatePath: path.resolve(skillDir),
				candidateRealPath: skillDirRealPath
			});
			continue;
		}
		const skillMd = path.join(skillDir, "SKILL.md");
		let skillMdStat;
		try {
			skillMdStat = fs.lstatSync(skillMd);
		} catch {
			continue;
		}
		if (!skillMdStat.isFile() || skillMdStat.isSymbolicLink()) continue;
		const skillMdRealPath = tryRealpath(skillMd);
		if (!skillMdRealPath || !isPathInside(skillDirRealPath, skillMdRealPath)) continue;
		if (skillMdStat.size > params.limits.maxSkillFileBytes) {
			skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
				skill: name,
				filePath: skillMd,
				size: skillMdStat.size,
				maxSkillFileBytes: params.limits.maxSkillFileBytes
			});
			continue;
		}
		loadedSkills.push(...loadContainedSkillRecords({
			skillDir,
			source: params.source,
			maxSkillFileBytes: params.limits.maxSkillFileBytes
		}));
		if (loadedSkills.length >= maxSkillsLoadedPerSource) break;
	}
	if (loadedSkills.length > maxSkillsLoadedPerSource) return loadedSkills.slice().sort((a, b) => a.skill.name.localeCompare(b.skill.name, "en")).slice(0, maxSkillsLoadedPerSource);
	return loadedSkills;
}
function loadSkillEntries(workspaceDir, opts) {
	const limits = resolveSkillsLimits(opts?.config, opts?.agentId);
	const allowedSymlinkTargetRealPaths = resolveAllowedSymlinkTargetRealPaths(opts?.config);
	const loadSkills = (params) => {
		const rootDir = path.resolve(params.dir);
		if (!fs.existsSync(rootDir)) return [];
		const rootRealPath = tryRealpath(rootDir) ?? rootDir;
		const baseDir = resolveNestedSkillsRoot(params.dir, { maxEntriesToScan: limits.maxCandidatesPerRoot }).baseDir;
		const baseDirRealPath = resolveSkillRootCandidatePath({
			source: params.source,
			rootDir,
			rootRealPath,
			candidatePath: baseDir,
			allowedSymlinkTargetRealPaths
		});
		if (!baseDirRealPath) return [];
		const rootSkillMd = path.join(baseDir, "SKILL.md");
		if (fs.existsSync(rootSkillMd)) {
			const rootSkillRealPath = resolveSkillFilePath({
				source: params.source,
				skillDir: baseDir,
				skillDirRealPath: baseDirRealPath,
				candidatePath: rootSkillMd
			});
			if (!rootSkillRealPath) return [];
			try {
				const size = fs.statSync(rootSkillRealPath).size;
				if (size > limits.maxSkillFileBytes) {
					skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
						dir: baseDir,
						filePath: rootSkillMd,
						size,
						maxSkillFileBytes: limits.maxSkillFileBytes
					});
					return [];
				}
			} catch {
				return [];
			}
			return loadContainedSkillRecords({
				skillDir: baseDir,
				source: params.source,
				maxSkillFileBytes: limits.maxSkillFileBytes,
				canonicalSkillDir: canonicalSkillDirForSource(params.source, baseDirRealPath)
			});
		}
		const maxCandidatesPerRoot = Math.max(0, limits.maxCandidatesPerRoot);
		const maxSkillsLoadedPerSource = Math.max(0, limits.maxSkillsLoadedPerSource);
		const childDirScan = listChildDirectories(baseDir, { maxCandidateDirs: maxCandidatesPerRoot });
		const childDirs = childDirScan.dirs;
		const suspicious = childDirScan.truncated;
		const limitedChildren = maxSkillsLoadedPerSource === 0 ? [] : childDirs.toSorted().slice(0, maxCandidatesPerRoot);
		if (suspicious) skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
			dir: params.dir,
			baseDir,
			childDirCount: childDirs.length,
			scannedEntryCount: childDirScan.scannedEntryCount,
			maxEntriesToScan: resolveRawEntryScanLimit(maxCandidatesPerRoot),
			maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
			maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource
		});
		else if (childDirs.length > maxCandidatesPerRoot) skillsLogger.warn("Skills root has many entries, truncating discovery.", {
			dir: params.dir,
			baseDir,
			childDirCount: childDirs.length,
			maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
			maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource
		});
		const loadedSkills = [];
		const loadCandidateSkill = ({ skillDir, skillDirRealPath, name, skillMdRealPath }) => {
			try {
				const size = fs.statSync(skillMdRealPath).size;
				if (size > limits.maxSkillFileBytes) {
					skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
						skill: name,
						filePath: path.join(skillDir, "SKILL.md"),
						size,
						maxSkillFileBytes: limits.maxSkillFileBytes
					});
					return;
				}
			} catch {
				return;
			}
			loadedSkills.push(...loadContainedSkillRecords({
				skillDir,
				source: params.source,
				maxSkillFileBytes: limits.maxSkillFileBytes,
				canonicalSkillDir: canonicalSkillDirForSource(params.source, skillDirRealPath)
			}));
		};
		for (const name of limitedChildren) {
			const skillDir = path.join(baseDir, name);
			const skillDirRealPath = resolveSkillRootCandidatePath({
				source: params.source,
				rootDir,
				rootRealPath: baseDirRealPath,
				candidatePath: skillDir,
				allowedSymlinkTargetRealPaths
			});
			if (!skillDirRealPath) continue;
			const skillMd = path.join(skillDir, "SKILL.md");
			if (fs.existsSync(skillMd)) {
				const skillMdRealPath = resolveSkillFilePath({
					source: params.source,
					skillDir,
					skillDirRealPath,
					candidatePath: skillMd
				});
				if (skillMdRealPath) loadCandidateSkill({
					skillDir,
					skillDirRealPath,
					name,
					skillMdRealPath
				});
			} else {
				const nestedChildScan = listChildDirectories(skillDir, { maxCandidateDirs: maxCandidatesPerRoot });
				const nestedChildren = nestedChildScan.dirs;
				if (nestedChildScan.truncated) skillsLogger.warn("Nested skills directory looks suspiciously large, truncating discovery.", {
					dir: params.dir,
					baseDir,
					nestedDir: skillDir,
					nestedChildDirCount: nestedChildren.length,
					scannedEntryCount: nestedChildScan.scannedEntryCount,
					maxEntriesToScan: resolveRawEntryScanLimit(maxCandidatesPerRoot),
					maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
					maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource
				});
				else if (nestedChildren.length > maxCandidatesPerRoot) skillsLogger.warn("Nested skills directory has many entries, truncating discovery.", {
					dir: params.dir,
					baseDir,
					nestedDir: skillDir,
					nestedChildDirCount: nestedChildren.length,
					maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
					maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource
				});
				const limitedNested = nestedChildren.toSorted().slice(0, maxCandidatesPerRoot);
				for (const nestedName of limitedNested) {
					const nestedDir = path.join(skillDir, nestedName);
					const nestedSkillMd = path.join(nestedDir, "SKILL.md");
					if (fs.existsSync(nestedSkillMd)) {
						const nestedDirRealPath = resolveSkillRootCandidatePath({
							source: params.source,
							rootDir,
							rootRealPath: baseDirRealPath,
							candidatePath: nestedDir,
							allowedSymlinkTargetRealPaths
						});
						const nestedSkillMdRealPath = nestedDirRealPath ? resolveSkillFilePath({
							source: params.source,
							skillDir: nestedDir,
							skillDirRealPath: nestedDirRealPath,
							candidatePath: nestedSkillMd
						}) : null;
						if (nestedDirRealPath && nestedSkillMdRealPath) loadCandidateSkill({
							skillDir: nestedDir,
							skillDirRealPath: nestedDirRealPath,
							name: `${name}/${nestedName}`,
							skillMdRealPath: nestedSkillMdRealPath
						});
					}
					if (loadedSkills.length >= maxSkillsLoadedPerSource) break;
				}
			}
			if (loadedSkills.length >= maxSkillsLoadedPerSource) break;
		}
		if (loadedSkills.length > maxSkillsLoadedPerSource) return loadedSkills.slice().sort((a, b) => a.skill.name.localeCompare(b.skill.name, "en")).slice(0, maxSkillsLoadedPerSource);
		return loadedSkills;
	};
	const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
	const workspaceSkillsDir = path.resolve(workspaceDir, "skills");
	const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
	const pluginSkillsDir = opts?.pluginSkillsDir ?? path.join(CONFIG_DIR, "plugin-skills");
	const extraDirs = (opts?.config?.skills?.load?.extraDirs ?? []).map((d) => normalizeOptionalString(d) ?? "").filter(Boolean);
	const pluginSkillDirs = resolvePluginSkillDirs({
		workspaceDir,
		config: opts?.config,
		pluginSkillsDir
	});
	const mergedExtraDirs = [...extraDirs, ...pluginSkillDirs];
	const bundledSkills = bundledSkillsDir ? loadSkills({
		dir: bundledSkillsDir,
		source: "openclaw-bundled"
	}) : [];
	const extraSkills = [...mergedExtraDirs.flatMap((dir) => {
		return loadSkills({
			dir: resolveUserPath(dir),
			source: "openclaw-extra"
		});
	}), ...loadGeneratedPluginSkillRecords({
		pluginSkillsDir,
		pluginSkillDirs,
		source: "openclaw-extra",
		limits
	})];
	const managedSkills = loadSkills({
		dir: managedSkillsDir,
		source: "openclaw-managed"
	});
	const osHomeDir = resolveUserHomeDir();
	const personalAgentsSkills = loadSkills({
		dir: osHomeDir ? path.resolve(osHomeDir, ".agents", "skills") : path.resolve(".agents", "skills"),
		source: "agents-skills-personal"
	});
	const projectAgentsSkills = loadSkills({
		dir: path.resolve(workspaceDir, ".agents", "skills"),
		source: "agents-skills-project"
	});
	const workspaceSkills = loadSkills({
		dir: workspaceSkillsDir,
		source: "openclaw-workspace"
	});
	const merged = /* @__PURE__ */ new Map();
	for (const record of extraSkills) merged.set(record.skill.name, record);
	for (const record of bundledSkills) merged.set(record.skill.name, record);
	for (const record of managedSkills) merged.set(record.skill.name, record);
	for (const record of personalAgentsSkills) merged.set(record.skill.name, record);
	for (const record of projectAgentsSkills) merged.set(record.skill.name, record);
	for (const record of workspaceSkills) merged.set(record.skill.name, record);
	return Array.from(merged.values()).sort((a, b) => a.skill.name.localeCompare(b.skill.name, "en")).map((record) => {
		const skill = record.skill;
		const frontmatter = record.frontmatter ?? readSkillFrontmatterSafe({
			rootDir: skill.baseDir,
			filePath: skill.filePath,
			maxBytes: limits.maxSkillFileBytes
		}) ?? {};
		const invocation = resolveSkillInvocationPolicy(frontmatter);
		return {
			skill,
			frontmatter,
			metadata: resolveOpenClawMetadata(frontmatter),
			invocation,
			...record.syncSourceDir !== void 0 ? { syncSourceDir: record.syncSourceDir } : {},
			...record.syncDirName !== void 0 ? { syncDirName: record.syncDirName } : {},
			exposure: {
				includeInRuntimeRegistry: true,
				includeInAvailableSkillsPrompt: invocation.disableModelInvocation !== true,
				userInvocable: invocation.userInvocable !== false
			}
		};
	});
}
function escapeXml(str) {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
/**
* Compact skill catalog: name + location only (no description).
* Used as a fallback when the full format exceeds the char budget,
* preserving awareness of all skills before resorting to dropping.
*/
function formatSkillsCompact(skills) {
	if (skills.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its name.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>"
	];
	for (const skill of skills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}
const COMPACT_WARNING_OVERHEAD = 150;
function applySkillsPromptLimits(params) {
	const limits = resolveSkillsLimits(params.config, params.agentId);
	const total = params.skills.length;
	const byCount = params.skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));
	let skillsForPrompt = byCount;
	let truncated = total > byCount.length;
	let compact = false;
	const fitsFull = (skills) => formatSkillsForPrompt(skills).length <= limits.maxSkillsPromptChars;
	const compactBudget = limits.maxSkillsPromptChars - COMPACT_WARNING_OVERHEAD;
	const fitsCompact = (skills) => formatSkillsCompact(skills).length <= compactBudget;
	if (!fitsFull(skillsForPrompt)) if (fitsCompact(skillsForPrompt)) compact = true;
	else {
		compact = true;
		let lo = 0;
		let hi = skillsForPrompt.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (fitsCompact(skillsForPrompt.slice(0, mid))) lo = mid;
			else hi = mid - 1;
		}
		skillsForPrompt = skillsForPrompt.slice(0, lo);
		truncated = true;
	}
	return {
		skillsForPrompt,
		truncated,
		compact
	};
}
function buildWorkspaceSkillSnapshot(workspaceDir, opts) {
	const { eligible, prompt, resolvedSkills } = resolveWorkspaceSkillPromptState(workspaceDir, opts);
	const skillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
	return {
		prompt,
		skills: eligible.map((entry) => ({
			name: entry.skill.name,
			primaryEnv: entry.metadata?.primaryEnv,
			requiredEnv: entry.metadata?.requires?.env?.slice()
		})),
		...skillFilter === void 0 ? {} : { skillFilter },
		resolvedSkills,
		version: opts?.snapshotVersion
	};
}
function buildWorkspaceSkillsPrompt(workspaceDir, opts) {
	return resolveWorkspaceSkillPromptState(workspaceDir, opts).prompt;
}
function resolveEffectiveWorkspaceSkillFilter(opts) {
	if (opts?.skillFilter !== void 0) return normalizeSkillFilter(opts.skillFilter);
	if (!opts?.config || !opts.agentId) return;
	return resolveEffectiveAgentSkillFilter(opts.config, opts.agentId);
}
function resolveWorkspaceSkillPromptState(workspaceDir, opts) {
	const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
	const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
	const eligible = filterSkillEntries(skillEntries, opts?.config, effectiveSkillFilter, opts?.eligibility);
	const promptEntries = eligible.filter((entry) => isSkillVisibleInAvailableSkillsPrompt(entry));
	const remoteNote = opts?.eligibility?.remote?.note?.trim();
	const resolvedSkills = promptEntries.map((entry) => entry.skill);
	const { skillsForPrompt, truncated, compact } = applySkillsPromptLimits({
		skills: compactSkillPaths(resolvedSkills).slice().sort((a, b) => a.name.localeCompare(b.name, "en")),
		config: opts?.config,
		agentId: opts?.agentId
	});
	return {
		eligible,
		prompt: [
			remoteNote,
			truncated ? `⚠️ Skills truncated: included ${skillsForPrompt.length} of ${resolvedSkills.length}${compact ? " (compact format, descriptions omitted)" : ""}. Run \`openclaw skills check\` to audit.` : compact ? `⚠️ Skills catalog using compact format (descriptions omitted). Run \`openclaw skills check\` to audit.` : "",
			compact ? formatSkillsCompact(skillsForPrompt) : formatSkillsForPrompt(skillsForPrompt)
		].filter(Boolean).join("\n"),
		resolvedSkills
	};
}
function resolveSkillsPromptForRun(params) {
	const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
	if (snapshotPrompt) return snapshotPrompt;
	if (params.entries && params.entries.length > 0) {
		const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
			entries: params.entries,
			config: params.config,
			agentId: params.agentId
		});
		return prompt.trim() ? prompt : "";
	}
	return "";
}
function loadWorkspaceSkillEntries(workspaceDir, opts) {
	const entries = loadSkillEntries(workspaceDir, opts);
	const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
	if (effectiveSkillFilter === void 0) return entries;
	return filterSkillEntries(entries, opts?.config, effectiveSkillFilter, opts?.eligibility);
}
function loadVisibleWorkspaceSkillEntries(workspaceDir, opts) {
	const entries = loadSkillEntries(workspaceDir, opts);
	const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
	return filterSkillEntries(entries, opts?.config, effectiveSkillFilter, opts?.eligibility);
}
function resolveUniqueSyncedSkillDirName(base, used) {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	for (let index = 2; index < 1e4; index += 1) {
		const candidate = `${base}-${index}`;
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
	}
	let fallbackIndex = 1e4;
	let fallback = `${base}-${fallbackIndex}`;
	while (used.has(fallback)) {
		fallbackIndex += 1;
		fallback = `${base}-${fallbackIndex}`;
	}
	used.add(fallback);
	return fallback;
}
function resolveSyncedSkillDestinationPath(params) {
	const sourceDirName = (params.entry.syncDirName ?? path.basename(params.entry.skill.baseDir)).trim();
	if (!sourceDirName || sourceDirName === "." || sourceDirName === "..") return null;
	return resolveSandboxPath({
		filePath: resolveUniqueSyncedSkillDirName(sourceDirName, params.usedDirNames),
		cwd: params.targetSkillsDir,
		root: params.targetSkillsDir
	}).resolved;
}
async function syncSkillsToWorkspace(params) {
	const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
	const targetDir = resolveUserPath(params.targetWorkspaceDir);
	if (sourceDir === targetDir) return;
	await serializeByKey(`syncSkills:${targetDir}`, async () => {
		const targetSkillsDir = path.join(targetDir, "skills");
		const entries = loadWorkspaceSkillEntries(sourceDir, {
			config: params.config,
			skillFilter: params.skillFilter,
			agentId: params.agentId,
			eligibility: params.eligibility,
			managedSkillsDir: params.managedSkillsDir,
			bundledSkillsDir: params.bundledSkillsDir
		});
		await fsp.rm(targetSkillsDir, {
			recursive: true,
			force: true
		});
		await fsp.mkdir(targetSkillsDir, { recursive: true });
		const usedDirNames = /* @__PURE__ */ new Set();
		for (const entry of entries) {
			let dest = null;
			try {
				dest = resolveSyncedSkillDestinationPath({
					targetSkillsDir,
					entry,
					usedDirNames
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : JSON.stringify(error);
				skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
				continue;
			}
			if (!dest) {
				skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`);
				continue;
			}
			try {
				await fsp.cp(entry.syncSourceDir ?? entry.skill.baseDir, dest, {
					recursive: true,
					force: true,
					filter: (src) => {
						const name = path.basename(src);
						return !(name === ".git" || name === "node_modules");
					}
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : JSON.stringify(error);
				skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
			}
		}
	});
}
function filterWorkspaceSkillEntries(entries, config) {
	return filterSkillEntries(entries, config);
}
function filterWorkspaceSkillEntriesWithOptions(entries, opts) {
	return filterSkillEntries(entries, opts?.config, opts?.skillFilter, opts?.eligibility);
}
//#endregion
export { loadVisibleWorkspaceSkillEntries as a, syncSkillsToWorkspace as c, filterWorkspaceSkillEntriesWithOptions as i, loadSkillsFromDirSafe as l, buildWorkspaceSkillsPrompt as n, loadWorkspaceSkillEntries as o, filterWorkspaceSkillEntries as r, resolveSkillsPromptForRun as s, buildWorkspaceSkillSnapshot as t };
