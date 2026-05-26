import { f as readStringValue } from "./string-coerce-DyL154ka.js";
import { t as resolveOpenClawPackageRoot } from "./openclaw-root-CNp1Ofdk.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { r as openRootFile } from "./root-file-jRMCpJW4.js";
import { p as resolveUserPath, u as pathExists$1 } from "./utils-sBTEdeml.js";
import { a as isSubagentSessionKey, i as isCronSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { t as DEFAULT_AGENT_WORKSPACE_DIR } from "./workspace-default--mMaLHGD.js";
import "./boundary-file-read-CBe_wA_B.js";
import { n as replaceFileAtomic } from "./replace-file-C7_Inj8B.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { r as exactWorkspaceEntryExists, t as CANONICAL_ROOT_MEMORY_FILENAME } from "./root-memory-files-P2Mok0xY.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region src/agents/workspace-templates.ts
const FALLBACK_TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/reference/templates");
let cachedTemplateDir;
let resolvingTemplateDir;
async function resolveWorkspaceTemplateDir(opts) {
	if (cachedTemplateDir) return cachedTemplateDir;
	if (resolvingTemplateDir) return resolvingTemplateDir;
	resolvingTemplateDir = (async () => {
		const moduleUrl = opts?.moduleUrl ?? import.meta.url;
		const argv1 = opts?.argv1 ?? process.argv[1];
		const cwd = opts?.cwd ?? process.cwd();
		const packageRoot = await resolveOpenClawPackageRoot({
			moduleUrl,
			argv1,
			cwd
		});
		const candidates = [
			packageRoot ? path.join(packageRoot, "docs", "reference", "templates") : null,
			cwd ? path.resolve(cwd, "docs", "reference", "templates") : null,
			FALLBACK_TEMPLATE_DIR
		].filter(Boolean);
		for (const candidate of candidates) if (await pathExists$1(candidate)) {
			cachedTemplateDir = candidate;
			return candidate;
		}
		cachedTemplateDir = candidates[0] ?? FALLBACK_TEMPLATE_DIR;
		return cachedTemplateDir;
	})();
	try {
		return await resolvingTemplateDir;
	} finally {
		resolvingTemplateDir = void 0;
	}
}
//#endregion
//#region src/agents/workspace.ts
const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
const DEFAULT_SOUL_FILENAME = "SOUL.md";
const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
const DEFAULT_USER_FILENAME = "USER.md";
const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
const DEFAULT_MEMORY_FILENAME = CANONICAL_ROOT_MEMORY_FILENAME;
const WORKSPACE_STATE_DIRNAME = ".openclaw";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;
const WORKSPACE_ONBOARDING_PROFILE_FILENAMES = [
	DEFAULT_SOUL_FILENAME,
	DEFAULT_IDENTITY_FILENAME,
	DEFAULT_USER_FILENAME
];
const workspaceTemplateCache = /* @__PURE__ */ new Map();
let gitAvailabilityPromise = null;
const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;
const workspaceFileCache = /* @__PURE__ */ new Map();
function workspaceFileIdentity(stat, canonicalPath) {
	return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}
async function readWorkspaceFileWithGuards(params) {
	const opened = await openRootFile({
		absolutePath: params.filePath,
		rootPath: params.workspaceDir,
		boundaryLabel: "workspace root",
		maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES
	});
	if (!opened.ok) {
		workspaceFileCache.delete(params.filePath);
		return opened;
	}
	const identity = workspaceFileIdentity(opened.stat, opened.path);
	const cached = workspaceFileCache.get(params.filePath);
	if (cached && cached.identity === identity) {
		fs.closeSync(opened.fd);
		return {
			ok: true,
			content: cached.content
		};
	}
	try {
		const content = fs.readFileSync(opened.fd, "utf-8");
		workspaceFileCache.set(params.filePath, {
			content,
			identity
		});
		return {
			ok: true,
			content
		};
	} catch (error) {
		workspaceFileCache.delete(params.filePath);
		return {
			ok: false,
			reason: "io",
			error
		};
	} finally {
		fs.closeSync(opened.fd);
	}
}
function stripFrontMatter(content) {
	if (!content.startsWith("---")) return content;
	const endIndex = content.indexOf("\n---", 3);
	if (endIndex === -1) return content;
	const start = endIndex + 4;
	let trimmed = content.slice(start);
	trimmed = trimmed.replace(/^\s+/, "");
	return trimmed;
}
async function loadTemplate(name) {
	const cached = workspaceTemplateCache.get(name);
	if (cached) return cached;
	const pending = (async () => {
		const templateDir = await resolveWorkspaceTemplateDir();
		const templatePath = path.join(templateDir, name);
		try {
			return stripFrontMatter(await fs$1.readFile(templatePath, "utf-8"));
		} catch {
			throw new Error(`Missing workspace template: ${name} (${templatePath}). Ensure docs/reference/templates are packaged.`);
		}
	})();
	workspaceTemplateCache.set(name, pending);
	try {
		return await pending;
	} catch (error) {
		workspaceTemplateCache.delete(name);
		throw error;
	}
}
/** Set of recognized bootstrap filenames for runtime validation */
const VALID_BOOTSTRAP_NAMES = new Set([
	DEFAULT_AGENTS_FILENAME,
	DEFAULT_SOUL_FILENAME,
	DEFAULT_TOOLS_FILENAME,
	DEFAULT_IDENTITY_FILENAME,
	DEFAULT_USER_FILENAME,
	DEFAULT_HEARTBEAT_FILENAME,
	DEFAULT_BOOTSTRAP_FILENAME,
	DEFAULT_MEMORY_FILENAME
]);
const OPTIONAL_BOOTSTRAP_FILENAMES = new Set([
	DEFAULT_SOUL_FILENAME,
	DEFAULT_IDENTITY_FILENAME,
	DEFAULT_USER_FILENAME,
	DEFAULT_HEARTBEAT_FILENAME
]);
async function writeFileIfMissing(filePath, content) {
	try {
		await fs$1.writeFile(filePath, content, {
			encoding: "utf-8",
			flag: "wx"
		});
		return true;
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		return false;
	}
}
async function fileContentDiffersFromTemplate(filePath, template) {
	try {
		return await fs$1.readFile(filePath, "utf-8") !== template;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
		return false;
	}
}
async function hasWorkspaceUserContentEvidence(dir, opts) {
	const indicators = [path.join(dir, "memory")];
	if (opts?.includeGit) indicators.push(path.join(dir, ".git"));
	for (const indicator of indicators) try {
		await fs$1.access(indicator);
		return true;
	} catch {}
	return await exactWorkspaceEntryExists(dir, DEFAULT_MEMORY_FILENAME);
}
async function workspaceProfileLooksConfigured(params) {
	return (await Promise.all(WORKSPACE_ONBOARDING_PROFILE_FILENAMES.map(async (fileName) => fileContentDiffersFromTemplate(path.join(params.dir, fileName), await loadTemplate(fileName))))).some(Boolean) || await hasWorkspaceUserContentEvidence(params.dir, { includeGit: params.includeGitEvidence });
}
async function workspaceHasBootstrapCompletionEvidence(params) {
	return await workspaceProfileLooksConfigured(params);
}
async function reconcileWorkspaceBootstrapCompletionState(params) {
	const bootstrapExists = params.bootstrapExists ?? await pathExists(params.bootstrapPath);
	if (typeof params.state.setupCompletedAt === "string" && params.state.setupCompletedAt.trim().length > 0) return {
		repaired: false,
		bootstrapExists,
		state: params.state
	};
	if (params.state.bootstrapSeededAt && !bootstrapExists) {
		const completedState = {
			...params.state,
			setupCompletedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await writeWorkspaceSetupState(params.statePath, completedState);
		return {
			repaired: true,
			bootstrapExists: false,
			state: completedState
		};
	}
	if (!bootstrapExists || !await workspaceHasBootstrapCompletionEvidence({ dir: params.dir })) return {
		repaired: false,
		bootstrapExists,
		state: params.state
	};
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const repairedState = {
		...params.state,
		bootstrapSeededAt: params.state.bootstrapSeededAt ?? now,
		setupCompletedAt: now
	};
	await writeWorkspaceSetupState(params.statePath, repairedState);
	try {
		await fs$1.rm(params.bootstrapPath, { force: true });
		return {
			repaired: true,
			bootstrapExists: false,
			state: repairedState
		};
	} catch {
		return {
			repaired: true,
			bootstrapExists: true,
			state: repairedState
		};
	}
}
function resolveWorkspaceStatePath(dir) {
	return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}
function parseWorkspaceSetupState(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const legacyCompletedAt = readStringValue(parsed.onboardingCompletedAt);
		return {
			version: WORKSPACE_STATE_VERSION,
			bootstrapSeededAt: readStringValue(parsed.bootstrapSeededAt),
			setupCompletedAt: readStringValue(parsed.setupCompletedAt) ?? legacyCompletedAt
		};
	} catch {
		return null;
	}
}
async function readWorkspaceSetupState(statePath, opts) {
	try {
		const raw = await fs$1.readFile(statePath, "utf-8");
		const parsed = parseWorkspaceSetupState(raw);
		if (opts?.persistLegacyMigration && parsed && raw.includes("\"onboardingCompletedAt\"") && !raw.includes("\"setupCompletedAt\"") && parsed.setupCompletedAt) await writeWorkspaceSetupState(statePath, parsed);
		return parsed ?? { version: WORKSPACE_STATE_VERSION };
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
		return { version: WORKSPACE_STATE_VERSION };
	}
}
async function readWorkspaceSetupStateForDir(dir) {
	return await readWorkspaceSetupState(resolveWorkspaceStatePath(resolveUserPath(dir)));
}
async function isWorkspaceSetupCompleted(dir) {
	const state = await readWorkspaceSetupStateForDir(dir);
	return typeof state.setupCompletedAt === "string" && state.setupCompletedAt.trim().length > 0;
}
async function resolveWorkspaceBootstrapStatus(dir) {
	const resolvedDir = resolveUserPath(dir);
	const state = await readWorkspaceSetupState(resolveWorkspaceStatePath(resolvedDir));
	if (typeof state.setupCompletedAt === "string" && state.setupCompletedAt.trim().length > 0) return "complete";
	if (!await pathExists(path.join(resolvedDir, "BOOTSTRAP.md"))) return "complete";
	return "pending";
}
async function isWorkspaceBootstrapPending(dir) {
	return await resolveWorkspaceBootstrapStatus(dir) === "pending";
}
async function reconcileWorkspaceBootstrapCompletion(dir) {
	const resolvedDir = resolveUserPath(dir);
	const statePath = resolveWorkspaceStatePath(resolvedDir);
	return await reconcileWorkspaceBootstrapCompletionState({
		dir: resolvedDir,
		bootstrapPath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
		statePath,
		state: await readWorkspaceSetupState(statePath, { persistLegacyMigration: true })
	});
}
async function writeWorkspaceSetupState(statePath, state) {
	await replaceFileAtomic({
		filePath: statePath,
		content: `${JSON.stringify(state, null, 2)}\n`,
		tempPrefix: ".workspace-state"
	});
}
async function hasGitRepo(dir) {
	try {
		await fs$1.stat(path.join(dir, ".git"));
		return true;
	} catch {
		return false;
	}
}
async function isGitAvailable() {
	if (gitAvailabilityPromise) return gitAvailabilityPromise;
	gitAvailabilityPromise = (async () => {
		try {
			return (await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2e3 })).code === 0;
		} catch {
			return false;
		}
	})();
	return gitAvailabilityPromise;
}
async function ensureGitRepo(dir, isBrandNewWorkspace) {
	if (!isBrandNewWorkspace) return;
	if (await hasGitRepo(dir)) return;
	if (!await isGitAvailable()) return;
	try {
		await runCommandWithTimeout(["git", "init"], {
			cwd: dir,
			timeoutMs: 1e4
		});
	} catch {}
}
async function ensureAgentWorkspace(params) {
	const dir = resolveUserPath(params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR);
	await fs$1.mkdir(dir, { recursive: true });
	if (!params?.ensureBootstrapFiles) return { dir };
	const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
	const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
	const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
	const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
	const userPath = path.join(dir, DEFAULT_USER_FILENAME);
	const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
	const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
	const statePath = resolveWorkspaceStatePath(dir);
	const isBrandNewWorkspace = await (async () => {
		const templatePaths = [
			agentsPath,
			soulPath,
			toolsPath,
			identityPath,
			userPath,
			heartbeatPath
		];
		const userContentPaths = [path.join(dir, "memory"), path.join(dir, ".git")];
		const paths = [...templatePaths, ...userContentPaths];
		const existing = await Promise.all(paths.map(async (p) => {
			try {
				await fs$1.access(p);
				return true;
			} catch {
				return false;
			}
		}));
		const hasCanonicalRootMemory = await exactWorkspaceEntryExists(dir, DEFAULT_MEMORY_FILENAME);
		return existing.every((v) => !v) && !hasCanonicalRootMemory;
	})();
	const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
	const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
	const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
	const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
	const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
	const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
	const skipOptionalBootstrapFiles = new Set(params?.skipOptionalBootstrapFiles ?? []);
	const shouldWriteBootstrapFile = (fileName) => !OPTIONAL_BOOTSTRAP_FILENAMES.has(fileName) || !skipOptionalBootstrapFiles.has(fileName);
	await writeFileIfMissing(agentsPath, agentsTemplate);
	if (shouldWriteBootstrapFile("SOUL.md")) await writeFileIfMissing(soulPath, soulTemplate);
	await writeFileIfMissing(toolsPath, toolsTemplate);
	const identityPathCreated = shouldWriteBootstrapFile("IDENTITY.md") ? await writeFileIfMissing(identityPath, identityTemplate) : false;
	if (shouldWriteBootstrapFile("USER.md")) await writeFileIfMissing(userPath, userTemplate);
	if (shouldWriteBootstrapFile("HEARTBEAT.md")) await writeFileIfMissing(heartbeatPath, heartbeatTemplate);
	let state = await readWorkspaceSetupState(statePath, { persistLegacyMigration: true });
	let stateDirty = false;
	const markState = (next) => {
		state = {
			...state,
			...next
		};
		stateDirty = true;
	};
	const nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
	let bootstrapExists = await pathExists(bootstrapPath);
	if (!state.bootstrapSeededAt && bootstrapExists) markState({ bootstrapSeededAt: nowIso() });
	if (!state.setupCompletedAt) {
		const repair = await reconcileWorkspaceBootstrapCompletionState({
			dir,
			bootstrapPath,
			statePath,
			state,
			bootstrapExists
		});
		if (repair.repaired) {
			state = repair.state;
			stateDirty = false;
			bootstrapExists = repair.bootstrapExists;
		}
	}
	if (!state.bootstrapSeededAt && !state.setupCompletedAt && !bootstrapExists) if (await workspaceProfileLooksConfigured({
		dir,
		includeGitEvidence: true
	})) markState({ setupCompletedAt: nowIso() });
	else {
		if (!await writeFileIfMissing(bootstrapPath, await loadTemplate("BOOTSTRAP.md"))) bootstrapExists = await pathExists(bootstrapPath);
		else bootstrapExists = true;
		if (bootstrapExists && !state.bootstrapSeededAt) markState({ bootstrapSeededAt: nowIso() });
	}
	if (stateDirty) await writeWorkspaceSetupState(statePath, state);
	await ensureGitRepo(dir, isBrandNewWorkspace);
	return {
		dir,
		agentsPath,
		soulPath,
		toolsPath,
		identityPath,
		userPath,
		heartbeatPath,
		bootstrapPath,
		identityPathCreated
	};
}
async function loadWorkspaceBootstrapFiles(dir) {
	const resolvedDir = resolveUserPath(dir);
	const entries = [
		{
			name: DEFAULT_AGENTS_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME)
		},
		{
			name: DEFAULT_SOUL_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME)
		},
		{
			name: DEFAULT_TOOLS_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME)
		},
		{
			name: DEFAULT_IDENTITY_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME)
		},
		{
			name: DEFAULT_USER_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME)
		},
		{
			name: DEFAULT_HEARTBEAT_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME)
		},
		{
			name: DEFAULT_BOOTSTRAP_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME)
		},
		{
			name: DEFAULT_MEMORY_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_MEMORY_FILENAME)
		}
	];
	const result = [];
	for (const entry of entries) {
		if (entry.name === DEFAULT_MEMORY_FILENAME && !await exactWorkspaceEntryExists(resolvedDir, DEFAULT_MEMORY_FILENAME)) continue;
		const loaded = await readWorkspaceFileWithGuards({
			filePath: entry.filePath,
			workspaceDir: resolvedDir
		});
		if (loaded.ok) result.push({
			name: entry.name,
			path: entry.filePath,
			content: loaded.content,
			missing: false
		});
		else result.push({
			name: entry.name,
			path: entry.filePath,
			missing: true
		});
	}
	return result;
}
const SUBAGENT_BOOTSTRAP_ALLOWLIST = new Set([DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME]);
const CRON_BOOTSTRAP_ALLOWLIST = new Set([
	DEFAULT_AGENTS_FILENAME,
	DEFAULT_TOOLS_FILENAME,
	DEFAULT_SOUL_FILENAME,
	DEFAULT_IDENTITY_FILENAME,
	DEFAULT_USER_FILENAME
]);
function filterBootstrapFilesForSession(files, sessionKey) {
	if (!sessionKey) return files;
	if (isSubagentSessionKey(sessionKey)) return files.filter((file) => SUBAGENT_BOOTSTRAP_ALLOWLIST.has(file.name));
	if (isCronSessionKey(sessionKey)) return files.filter((file) => CRON_BOOTSTRAP_ALLOWLIST.has(file.name));
	return files;
}
function hasGlobPattern(pattern) {
	return /[?*{}]/u.test(pattern);
}
function normalizeWorkspacePatternPath(value) {
	return value.replaceAll(path.sep, "/").replaceAll("\\", "/").replace(/^\.\/+/u, "");
}
function resolveGlobWalkRoot(pattern) {
	const normalized = normalizeWorkspacePatternPath(pattern);
	const globIndex = normalized.search(/[?*{}]/u);
	if (globIndex === -1) return normalized;
	const slashIndex = normalized.lastIndexOf("/", globIndex);
	return slashIndex === -1 ? "." : normalized.slice(0, slashIndex) || ".";
}
async function* walkWorkspaceFiles(workspaceDir, initialRelativeDir) {
	const stack = [initialRelativeDir === "." ? "" : initialRelativeDir];
	while (stack.length > 0) {
		const currentRelativeDir = stack.pop() ?? "";
		const currentDir = path.resolve(workspaceDir, currentRelativeDir);
		const relativeToWorkspace = path.relative(workspaceDir, currentDir);
		if (relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) continue;
		let entries;
		try {
			entries = await fs$1.readdir(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const childRelativePath = currentRelativeDir ? path.join(currentRelativeDir, entry.name) : entry.name;
			if (entry.isDirectory()) {
				stack.push(childRelativePath);
				continue;
			}
			if (entry.isFile() || entry.isSymbolicLink()) yield normalizeWorkspacePatternPath(childRelativePath);
		}
	}
}
async function resolveExtraBootstrapPatternPaths(workspaceDir, pattern) {
	if (typeof fs$1.glob === "function") try {
		const matches = [];
		for await (const match of fs$1.glob(pattern, { cwd: workspaceDir })) matches.push(match);
		return matches;
	} catch {}
	if (typeof path.matchesGlob !== "function") return [pattern];
	const normalizedPattern = normalizeWorkspacePatternPath(pattern);
	const matches = [];
	for await (const candidate of walkWorkspaceFiles(workspaceDir, resolveGlobWalkRoot(normalizedPattern))) if (path.matchesGlob(candidate, normalizedPattern)) matches.push(candidate);
	return matches.length > 0 ? matches : [pattern];
}
async function loadExtraBootstrapFiles(dir, extraPatterns) {
	return (await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns)).files;
}
async function loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns) {
	if (!extraPatterns.length) return {
		files: [],
		diagnostics: []
	};
	const resolvedDir = resolveUserPath(dir);
	const resolvedPaths = /* @__PURE__ */ new Set();
	for (const pattern of extraPatterns) if (hasGlobPattern(pattern)) {
		const matches = await resolveExtraBootstrapPatternPaths(resolvedDir, pattern);
		for (const match of matches) resolvedPaths.add(match);
	} else resolvedPaths.add(pattern);
	const files = [];
	const diagnostics = [];
	for (const relPath of resolvedPaths) {
		const filePath = path.resolve(resolvedDir, relPath);
		const baseName = path.basename(relPath);
		if (!VALID_BOOTSTRAP_NAMES.has(baseName)) {
			diagnostics.push({
				path: filePath,
				reason: "invalid-bootstrap-filename",
				detail: `unsupported bootstrap basename: ${baseName}`
			});
			continue;
		}
		const loaded = await readWorkspaceFileWithGuards({
			filePath,
			workspaceDir: resolvedDir
		});
		if (loaded.ok) {
			files.push({
				name: baseName,
				path: filePath,
				content: loaded.content,
				missing: false
			});
			continue;
		}
		const reason = loaded.reason === "path" ? "missing" : loaded.reason === "validation" ? "security" : "io";
		diagnostics.push({
			path: filePath,
			reason,
			detail: loaded.error instanceof Error ? loaded.error.message : typeof loaded.error === "string" ? loaded.error : reason
		});
	}
	return {
		files,
		diagnostics
	};
}
//#endregion
export { resolveWorkspaceBootstrapStatus as _, DEFAULT_MEMORY_FILENAME as a, DEFAULT_USER_FILENAME as c, isWorkspaceBootstrapPending as d, isWorkspaceSetupCompleted as f, reconcileWorkspaceBootstrapCompletion as g, loadWorkspaceBootstrapFiles as h, DEFAULT_IDENTITY_FILENAME as i, ensureAgentWorkspace as l, loadExtraBootstrapFilesWithDiagnostics as m, DEFAULT_BOOTSTRAP_FILENAME as n, DEFAULT_SOUL_FILENAME as o, loadExtraBootstrapFiles as p, DEFAULT_HEARTBEAT_FILENAME as r, DEFAULT_TOOLS_FILENAME as s, DEFAULT_AGENTS_FILENAME as t, filterBootstrapFilesForSession as u, resolveWorkspaceTemplateDir as v };
