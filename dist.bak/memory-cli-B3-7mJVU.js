import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { $t as resolveStateDir, Dt as isRich, Et as colorize, Ot as theme, St as setVerbose, lt as shortenHomeInString, s as createSubsystemLogger, st as resolveUserPath, ut as shortenHomePath, v as defaultRuntime } from "./entry.js";
import { Kt as splitShellArgs, j as loadConfig, rt as parseDurationMs } from "./auth-profiles-D6H-HVV8.js";
import { d as resolveDefaultAgentId, u as resolveAgentWorkspaceDir } from "./agent-scope-C2k6BQnt.js";
import { c as resolveSessionTranscriptsDirForAgent } from "./paths-DWsXK0S0.js";
import { n as formatErrorMessage } from "./errors-Cu3BYw29.js";
import { f as listMemoryFiles, p as normalizeExtraMemoryPaths } from "./query-expansion-y7PPmyIy.js";
import { t as formatDocsLink } from "./links-yQMT2QcX.js";
import { r as withManager } from "./cli-utils-CKDCmKAq.js";
import { t as formatHelpExamples } from "./help-format-Du-bXlH0.js";
import { n as withProgress, r as withProgressTotals } from "./progress-bvyZjsUc.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fs$1 from "node:fs/promises";

//#region src/memory/backend-config.ts
const DEFAULT_BACKEND = "builtin";
const DEFAULT_CITATIONS = "auto";
const DEFAULT_QMD_INTERVAL = "5m";
const DEFAULT_QMD_DEBOUNCE_MS = 15e3;
const DEFAULT_QMD_TIMEOUT_MS = 4e3;
const DEFAULT_QMD_SEARCH_MODE = "search";
const DEFAULT_QMD_EMBED_INTERVAL = "60m";
const DEFAULT_QMD_COMMAND_TIMEOUT_MS = 3e4;
const DEFAULT_QMD_UPDATE_TIMEOUT_MS = 12e4;
const DEFAULT_QMD_EMBED_TIMEOUT_MS = 12e4;
const DEFAULT_QMD_LIMITS = {
	maxResults: 6,
	maxSnippetChars: 700,
	maxInjectedChars: 4e3,
	timeoutMs: DEFAULT_QMD_TIMEOUT_MS
};
const DEFAULT_QMD_MCPORTER = {
	enabled: false,
	serverName: "qmd",
	startDaemon: true
};
const DEFAULT_QMD_SCOPE = {
	default: "deny",
	rules: [{
		action: "allow",
		match: { chatType: "direct" }
	}]
};
function sanitizeName(input) {
	return input.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "collection";
}
function scopeCollectionBase(base, agentId) {
	return `${base}-${sanitizeName(agentId)}`;
}
function ensureUniqueName(base, existing) {
	let name = sanitizeName(base);
	if (!existing.has(name)) {
		existing.add(name);
		return name;
	}
	let suffix = 2;
	while (existing.has(`${name}-${suffix}`)) suffix += 1;
	const unique = `${name}-${suffix}`;
	existing.add(unique);
	return unique;
}
function resolvePath(raw, workspaceDir) {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("path required");
	if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) return path.normalize(resolveUserPath(trimmed));
	return path.normalize(path.resolve(workspaceDir, trimmed));
}
function resolveIntervalMs(raw) {
	const value = raw?.trim();
	if (!value) return parseDurationMs(DEFAULT_QMD_INTERVAL, { defaultUnit: "m" });
	try {
		return parseDurationMs(value, { defaultUnit: "m" });
	} catch {
		return parseDurationMs(DEFAULT_QMD_INTERVAL, { defaultUnit: "m" });
	}
}
function resolveEmbedIntervalMs(raw) {
	const value = raw?.trim();
	if (!value) return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, { defaultUnit: "m" });
	try {
		return parseDurationMs(value, { defaultUnit: "m" });
	} catch {
		return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, { defaultUnit: "m" });
	}
}
function resolveDebounceMs(raw) {
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
	return DEFAULT_QMD_DEBOUNCE_MS;
}
function resolveTimeoutMs(raw, fallback) {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return fallback;
}
function resolveLimits(raw) {
	const parsed = { ...DEFAULT_QMD_LIMITS };
	if (raw?.maxResults && raw.maxResults > 0) parsed.maxResults = Math.floor(raw.maxResults);
	if (raw?.maxSnippetChars && raw.maxSnippetChars > 0) parsed.maxSnippetChars = Math.floor(raw.maxSnippetChars);
	if (raw?.maxInjectedChars && raw.maxInjectedChars > 0) parsed.maxInjectedChars = Math.floor(raw.maxInjectedChars);
	if (raw?.timeoutMs && raw.timeoutMs > 0) parsed.timeoutMs = Math.floor(raw.timeoutMs);
	return parsed;
}
function resolveSearchMode(raw) {
	if (raw === "search" || raw === "vsearch" || raw === "query") return raw;
	return DEFAULT_QMD_SEARCH_MODE;
}
function resolveSessionConfig(cfg, workspaceDir) {
	const enabled = Boolean(cfg?.enabled);
	const exportDirRaw = cfg?.exportDir?.trim();
	return {
		enabled,
		exportDir: exportDirRaw ? resolvePath(exportDirRaw, workspaceDir) : void 0,
		retentionDays: cfg?.retentionDays && cfg.retentionDays > 0 ? Math.floor(cfg.retentionDays) : void 0
	};
}
function resolveCustomPaths(rawPaths, workspaceDir, existing, agentId) {
	if (!rawPaths?.length) return [];
	const collections = [];
	rawPaths.forEach((entry, index) => {
		const trimmedPath = entry?.path?.trim();
		if (!trimmedPath) return;
		let resolved;
		try {
			resolved = resolvePath(trimmedPath, workspaceDir);
		} catch {
			return;
		}
		const pattern = entry.pattern?.trim() || "**/*.md";
		const name = ensureUniqueName(scopeCollectionBase(entry.name?.trim() || `custom-${index + 1}`, agentId), existing);
		collections.push({
			name,
			path: resolved,
			pattern,
			kind: "custom"
		});
	});
	return collections;
}
function resolveMcporterConfig(raw) {
	const parsed = { ...DEFAULT_QMD_MCPORTER };
	if (!raw) return parsed;
	if (raw.enabled !== void 0) parsed.enabled = raw.enabled;
	if (typeof raw.serverName === "string" && raw.serverName.trim()) parsed.serverName = raw.serverName.trim();
	if (raw.startDaemon !== void 0) parsed.startDaemon = raw.startDaemon;
	if (parsed.enabled && raw.startDaemon === void 0) parsed.startDaemon = true;
	return parsed;
}
function resolveDefaultCollections(include, workspaceDir, existing, agentId) {
	if (!include) return [];
	return [
		{
			path: workspaceDir,
			pattern: "MEMORY.md",
			base: "memory-root"
		},
		{
			path: workspaceDir,
			pattern: "memory.md",
			base: "memory-alt"
		},
		{
			path: path.join(workspaceDir, "memory"),
			pattern: "**/*.md",
			base: "memory-dir"
		}
	].map((entry) => ({
		name: ensureUniqueName(scopeCollectionBase(entry.base, agentId), existing),
		path: entry.path,
		pattern: entry.pattern,
		kind: "memory"
	}));
}
function resolveMemoryBackendConfig(params) {
	const backend = params.cfg.memory?.backend ?? DEFAULT_BACKEND;
	const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;
	if (backend !== "qmd") return {
		backend: "builtin",
		citations
	};
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
	const qmdCfg = params.cfg.memory?.qmd;
	const includeDefaultMemory = qmdCfg?.includeDefaultMemory !== false;
	const nameSet = /* @__PURE__ */ new Set();
	const collections = [...resolveDefaultCollections(includeDefaultMemory, workspaceDir, nameSet, params.agentId), ...resolveCustomPaths(qmdCfg?.paths, workspaceDir, nameSet, params.agentId)];
	const rawCommand = qmdCfg?.command?.trim() || "qmd";
	return {
		backend: "qmd",
		citations,
		qmd: {
			command: splitShellArgs(rawCommand)?.[0] || rawCommand.split(/\s+/)[0] || "qmd",
			mcporter: resolveMcporterConfig(qmdCfg?.mcporter),
			searchMode: resolveSearchMode(qmdCfg?.searchMode),
			collections,
			includeDefaultMemory,
			sessions: resolveSessionConfig(qmdCfg?.sessions, workspaceDir),
			update: {
				intervalMs: resolveIntervalMs(qmdCfg?.update?.interval),
				debounceMs: resolveDebounceMs(qmdCfg?.update?.debounceMs),
				onBoot: qmdCfg?.update?.onBoot !== false,
				waitForBootSync: qmdCfg?.update?.waitForBootSync === true,
				embedIntervalMs: resolveEmbedIntervalMs(qmdCfg?.update?.embedInterval),
				commandTimeoutMs: resolveTimeoutMs(qmdCfg?.update?.commandTimeoutMs, DEFAULT_QMD_COMMAND_TIMEOUT_MS),
				updateTimeoutMs: resolveTimeoutMs(qmdCfg?.update?.updateTimeoutMs, DEFAULT_QMD_UPDATE_TIMEOUT_MS),
				embedTimeoutMs: resolveTimeoutMs(qmdCfg?.update?.embedTimeoutMs, DEFAULT_QMD_EMBED_TIMEOUT_MS)
			},
			limits: resolveLimits(qmdCfg?.limits),
			scope: qmdCfg?.scope ?? DEFAULT_QMD_SCOPE
		}
	};
}

//#endregion
//#region src/memory/search-manager.ts
const log = createSubsystemLogger("memory");
const QMD_MANAGER_CACHE = /* @__PURE__ */ new Map();
async function getMemorySearchManager(params) {
	const resolved = resolveMemoryBackendConfig(params);
	if (resolved.backend === "qmd" && resolved.qmd) {
		const statusOnly = params.purpose === "status";
		const cacheKey = buildQmdCacheKey(params.agentId, resolved.qmd);
		if (!statusOnly) {
			const cached = QMD_MANAGER_CACHE.get(cacheKey);
			if (cached) return { manager: cached };
		}
		try {
			const { QmdMemoryManager } = await import("./qmd-manager-C30-vkeT.js");
			const primary = await QmdMemoryManager.create({
				cfg: params.cfg,
				agentId: params.agentId,
				resolved,
				mode: statusOnly ? "status" : "full"
			});
			if (primary) {
				if (statusOnly) return { manager: primary };
				const wrapper = new FallbackMemoryManager({
					primary,
					fallbackFactory: async () => {
						const { MemoryIndexManager } = await import("./manager-g3ZxmKKX.js").then((n) => n.t);
						return await MemoryIndexManager.get(params);
					}
				}, () => QMD_MANAGER_CACHE.delete(cacheKey));
				QMD_MANAGER_CACHE.set(cacheKey, wrapper);
				return { manager: wrapper };
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`qmd memory unavailable; falling back to builtin: ${message}`);
		}
	}
	try {
		const { MemoryIndexManager } = await import("./manager-g3ZxmKKX.js").then((n) => n.t);
		return { manager: await MemoryIndexManager.get(params) };
	} catch (err) {
		return {
			manager: null,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
var FallbackMemoryManager = class {
	constructor(deps, onClose) {
		this.deps = deps;
		this.onClose = onClose;
		this.fallback = null;
		this.primaryFailed = false;
		this.cacheEvicted = false;
	}
	async search(query, opts) {
		if (!this.primaryFailed) try {
			return await this.deps.primary.search(query, opts);
		} catch (err) {
			this.primaryFailed = true;
			this.lastError = err instanceof Error ? err.message : String(err);
			log.warn(`qmd memory failed; switching to builtin index: ${this.lastError}`);
			await this.deps.primary.close?.().catch(() => {});
			this.evictCacheEntry();
		}
		const fallback = await this.ensureFallback();
		if (fallback) return await fallback.search(query, opts);
		throw new Error(this.lastError ?? "memory search unavailable");
	}
	async readFile(params) {
		if (!this.primaryFailed) return await this.deps.primary.readFile(params);
		const fallback = await this.ensureFallback();
		if (fallback) return await fallback.readFile(params);
		throw new Error(this.lastError ?? "memory read unavailable");
	}
	status() {
		if (!this.primaryFailed) return this.deps.primary.status();
		const fallbackStatus = this.fallback?.status();
		const fallbackInfo = {
			from: "qmd",
			reason: this.lastError ?? "unknown"
		};
		if (fallbackStatus) {
			const custom = fallbackStatus.custom ?? {};
			return {
				...fallbackStatus,
				fallback: fallbackInfo,
				custom: {
					...custom,
					fallback: {
						disabled: true,
						reason: this.lastError ?? "unknown"
					}
				}
			};
		}
		const primaryStatus = this.deps.primary.status();
		const custom = primaryStatus.custom ?? {};
		return {
			...primaryStatus,
			fallback: fallbackInfo,
			custom: {
				...custom,
				fallback: {
					disabled: true,
					reason: this.lastError ?? "unknown"
				}
			}
		};
	}
	async sync(params) {
		if (!this.primaryFailed) {
			await this.deps.primary.sync?.(params);
			return;
		}
		await (await this.ensureFallback())?.sync?.(params);
	}
	async probeEmbeddingAvailability() {
		if (!this.primaryFailed) return await this.deps.primary.probeEmbeddingAvailability();
		const fallback = await this.ensureFallback();
		if (fallback) return await fallback.probeEmbeddingAvailability();
		return {
			ok: false,
			error: this.lastError ?? "memory embeddings unavailable"
		};
	}
	async probeVectorAvailability() {
		if (!this.primaryFailed) return await this.deps.primary.probeVectorAvailability();
		return await (await this.ensureFallback())?.probeVectorAvailability() ?? false;
	}
	async close() {
		await this.deps.primary.close?.();
		await this.fallback?.close?.();
		this.evictCacheEntry();
	}
	async ensureFallback() {
		if (this.fallback) return this.fallback;
		let fallback;
		try {
			fallback = await this.deps.fallbackFactory();
			if (!fallback) {
				log.warn("memory fallback requested but builtin index is unavailable");
				return null;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`memory fallback unavailable: ${message}`);
			return null;
		}
		this.fallback = fallback;
		return this.fallback;
	}
	evictCacheEntry() {
		if (this.cacheEvicted) return;
		this.cacheEvicted = true;
		this.onClose?.();
	}
};
function buildQmdCacheKey(agentId, config) {
	return `${agentId}:${stableSerialize(config)}`;
}
function stableSerialize(value) {
	return JSON.stringify(sortValue(value));
}
function sortValue(value) {
	if (Array.isArray(value)) return value.map((entry) => sortValue(entry));
	if (value && typeof value === "object") {
		const sortedEntries = Object.keys(value).toSorted((a, b) => a.localeCompare(b)).map((key) => [key, sortValue(value[key])]);
		return Object.fromEntries(sortedEntries);
	}
	return value;
}

//#endregion
//#region src/cli/memory-cli.ts
var memory_cli_exports = /* @__PURE__ */ __exportAll({
	registerMemoryCli: () => registerMemoryCli,
	runMemoryStatus: () => runMemoryStatus
});
function formatSourceLabel(source, workspaceDir, agentId) {
	if (source === "memory") return shortenHomeInString(`memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`);
	if (source === "sessions") {
		const stateDir = resolveStateDir(process.env, os.homedir);
		return shortenHomeInString(`sessions (${path.join(stateDir, "agents", agentId, "sessions")}${path.sep}*.jsonl)`);
	}
	return source;
}
function resolveAgent(cfg, agent) {
	const trimmed = agent?.trim();
	if (trimmed) return trimmed;
	return resolveDefaultAgentId(cfg);
}
function resolveAgentIds(cfg, agent) {
	const trimmed = agent?.trim();
	if (trimmed) return [trimmed];
	const list = cfg.agents?.list ?? [];
	if (list.length > 0) return list.map((entry) => entry.id).filter(Boolean);
	return [resolveDefaultAgentId(cfg)];
}
function formatExtraPaths(workspaceDir, extraPaths) {
	return normalizeExtraMemoryPaths(workspaceDir, extraPaths).map((entry) => shortenHomePath(entry));
}
async function withMemoryManagerForAgent(params) {
	const managerParams = {
		cfg: params.cfg,
		agentId: params.agentId
	};
	if (params.purpose) managerParams.purpose = params.purpose;
	await withManager({
		getManager: () => getMemorySearchManager(managerParams),
		onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
		onCloseError: (err) => defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
		close: async (manager) => {
			await manager.close?.();
		},
		run: params.run
	});
}
async function checkReadableFile(pathname) {
	try {
		await fs$1.access(pathname, fs.constants.R_OK);
		return { exists: true };
	} catch (err) {
		const code = err.code;
		if (code === "ENOENT") return { exists: false };
		return {
			exists: true,
			issue: `${shortenHomePath(pathname)} not readable (${code ?? "error"})`
		};
	}
}
async function scanSessionFiles(agentId) {
	const issues = [];
	const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
	try {
		return {
			source: "sessions",
			totalFiles: (await fs$1.readdir(sessionsDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).length,
			issues
		};
	} catch (err) {
		const code = err.code;
		if (code === "ENOENT") {
			issues.push(`sessions directory missing (${shortenHomePath(sessionsDir)})`);
			return {
				source: "sessions",
				totalFiles: 0,
				issues
			};
		}
		issues.push(`sessions directory not accessible (${shortenHomePath(sessionsDir)}): ${code ?? "error"}`);
		return {
			source: "sessions",
			totalFiles: null,
			issues
		};
	}
}
async function scanMemoryFiles(workspaceDir, extraPaths = []) {
	const issues = [];
	const memoryFile = path.join(workspaceDir, "MEMORY.md");
	const altMemoryFile = path.join(workspaceDir, "memory.md");
	const memoryDir = path.join(workspaceDir, "memory");
	const primary = await checkReadableFile(memoryFile);
	const alt = await checkReadableFile(altMemoryFile);
	if (primary.issue) issues.push(primary.issue);
	if (alt.issue) issues.push(alt.issue);
	const resolvedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
	for (const extraPath of resolvedExtraPaths) try {
		if ((await fs$1.lstat(extraPath)).isSymbolicLink()) continue;
		const extraCheck = await checkReadableFile(extraPath);
		if (extraCheck.issue) issues.push(extraCheck.issue);
	} catch (err) {
		const code = err.code;
		if (code === "ENOENT") issues.push(`additional memory path missing (${shortenHomePath(extraPath)})`);
		else issues.push(`additional memory path not accessible (${shortenHomePath(extraPath)}): ${code ?? "error"}`);
	}
	let dirReadable = null;
	try {
		await fs$1.access(memoryDir, fs.constants.R_OK);
		dirReadable = true;
	} catch (err) {
		const code = err.code;
		if (code === "ENOENT") {
			issues.push(`memory directory missing (${shortenHomePath(memoryDir)})`);
			dirReadable = false;
		} else {
			issues.push(`memory directory not accessible (${shortenHomePath(memoryDir)}): ${code ?? "error"}`);
			dirReadable = null;
		}
	}
	let listed = [];
	let listedOk = false;
	try {
		listed = await listMemoryFiles(workspaceDir, resolvedExtraPaths);
		listedOk = true;
	} catch (err) {
		const code = err.code;
		if (dirReadable !== null) {
			issues.push(`memory directory scan failed (${shortenHomePath(memoryDir)}): ${code ?? "error"}`);
			dirReadable = null;
		}
	}
	let totalFiles = 0;
	if (dirReadable === null) totalFiles = null;
	else {
		const files = new Set(listedOk ? listed : []);
		if (!listedOk) {
			if (primary.exists) files.add(memoryFile);
			if (alt.exists) files.add(altMemoryFile);
		}
		totalFiles = files.size;
	}
	if ((totalFiles ?? 0) === 0 && issues.length === 0) issues.push(`no memory files found in ${shortenHomePath(workspaceDir)}`);
	return {
		source: "memory",
		totalFiles,
		issues
	};
}
async function summarizeQmdIndexArtifact(manager) {
	const status = manager.status?.();
	if (!status || status.backend !== "qmd") return null;
	const dbPath = status.dbPath?.trim();
	if (!dbPath) return null;
	let stat;
	try {
		stat = await fs$1.stat(dbPath);
	} catch (err) {
		const code = err.code;
		if (code === "ENOENT") throw new Error(`QMD index file not found: ${shortenHomePath(dbPath)}`, { cause: err });
		throw new Error(`QMD index file check failed: ${shortenHomePath(dbPath)} (${code ?? "error"})`, { cause: err });
	}
	if (!stat.isFile() || stat.size <= 0) throw new Error(`QMD index file is empty: ${shortenHomePath(dbPath)}`);
	return `QMD index: ${shortenHomePath(dbPath)} (${stat.size} bytes)`;
}
async function scanMemorySources(params) {
	const scans = [];
	const extraPaths = params.extraPaths ?? [];
	for (const source of params.sources) {
		if (source === "memory") scans.push(await scanMemoryFiles(params.workspaceDir, extraPaths));
		if (source === "sessions") scans.push(await scanSessionFiles(params.agentId));
	}
	const issues = scans.flatMap((scan) => scan.issues);
	const totals = scans.map((scan) => scan.totalFiles);
	const numericTotals = totals.filter((total) => total !== null);
	return {
		sources: scans,
		totalFiles: totals.some((total) => total === null) ? null : numericTotals.reduce((sum, total) => sum + total, 0),
		issues
	};
}
async function runMemoryStatus(opts) {
	setVerbose(Boolean(opts.verbose));
	const cfg = loadConfig();
	const agentIds = resolveAgentIds(cfg, opts.agent);
	const allResults = [];
	for (const agentId of agentIds) await withMemoryManagerForAgent({
		cfg,
		agentId,
		purpose: opts.index ? "default" : "status",
		run: async (manager) => {
			const deep = Boolean(opts.deep || opts.index);
			let embeddingProbe;
			let indexError;
			const syncFn = manager.sync ? manager.sync.bind(manager) : void 0;
			if (deep) {
				await withProgress({
					label: "Checking memory…",
					total: 2
				}, async (progress) => {
					progress.setLabel("Probing vector…");
					await manager.probeVectorAvailability();
					progress.tick();
					progress.setLabel("Probing embeddings…");
					embeddingProbe = await manager.probeEmbeddingAvailability();
					progress.tick();
				});
				if (opts.index && syncFn) await withProgressTotals({
					label: "Indexing memory…",
					total: 0,
					fallback: opts.verbose ? "line" : void 0
				}, async (update, progress) => {
					try {
						await syncFn({
							reason: "cli",
							force: Boolean(opts.force),
							progress: (syncUpdate) => {
								update({
									completed: syncUpdate.completed,
									total: syncUpdate.total,
									label: syncUpdate.label
								});
								if (syncUpdate.label) progress.setLabel(syncUpdate.label);
							}
						});
					} catch (err) {
						indexError = formatErrorMessage(err);
						defaultRuntime.error(`Memory index failed: ${indexError}`);
						process.exitCode = 1;
					}
				});
				else if (opts.index && !syncFn) defaultRuntime.log("Memory backend does not support manual reindex.");
			} else await manager.probeVectorAvailability();
			const status = manager.status();
			const sources = status.sources?.length ? status.sources : ["memory"];
			const workspaceDir = status.workspaceDir;
			const scan = workspaceDir ? await scanMemorySources({
				workspaceDir,
				agentId,
				sources,
				extraPaths: status.extraPaths
			}) : void 0;
			allResults.push({
				agentId,
				status,
				embeddingProbe,
				indexError,
				scan
			});
		}
	});
	if (opts.json) {
		defaultRuntime.log(JSON.stringify(allResults, null, 2));
		return;
	}
	const rich = isRich();
	const heading = (text) => colorize(rich, theme.heading, text);
	const muted = (text) => colorize(rich, theme.muted, text);
	const info = (text) => colorize(rich, theme.info, text);
	const success = (text) => colorize(rich, theme.success, text);
	const warn = (text) => colorize(rich, theme.warn, text);
	const accent = (text) => colorize(rich, theme.accent, text);
	const label = (text) => muted(`${text}:`);
	for (const result of allResults) {
		const { agentId, status, embeddingProbe, indexError, scan } = result;
		const filesIndexed = status.files ?? 0;
		const chunksIndexed = status.chunks ?? 0;
		const totalFiles = scan?.totalFiles ?? null;
		const indexedLabel = totalFiles === null ? `${filesIndexed}/? files · ${chunksIndexed} chunks` : `${filesIndexed}/${totalFiles} files · ${chunksIndexed} chunks`;
		if (opts.index) {
			const line = indexError ? `Memory index failed: ${indexError}` : "Memory index complete.";
			defaultRuntime.log(line);
		}
		const requestedProvider = status.requestedProvider ?? status.provider;
		const modelLabel = status.model ?? status.provider;
		const storePath = status.dbPath ? shortenHomePath(status.dbPath) : "<unknown>";
		const workspacePath = status.workspaceDir ? shortenHomePath(status.workspaceDir) : "<unknown>";
		const sourceList = status.sources?.length ? status.sources.join(", ") : null;
		const extraPaths = status.workspaceDir ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? []) : [];
		const lines = [
			`${heading("Memory Search")} ${muted(`(${agentId})`)}`,
			`${label("Provider")} ${info(status.provider)} ${muted(`(requested: ${requestedProvider})`)}`,
			`${label("Model")} ${info(modelLabel)}`,
			sourceList ? `${label("Sources")} ${info(sourceList)}` : null,
			extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
			`${label("Indexed")} ${success(indexedLabel)}`,
			`${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
			`${label("Store")} ${info(storePath)}`,
			`${label("Workspace")} ${info(workspacePath)}`
		].filter(Boolean);
		if (embeddingProbe) {
			const state = embeddingProbe.ok ? "ready" : "unavailable";
			const stateColor = embeddingProbe.ok ? theme.success : theme.warn;
			lines.push(`${label("Embeddings")} ${colorize(rich, stateColor, state)}`);
			if (embeddingProbe.error) lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
		}
		if (status.sourceCounts?.length) {
			lines.push(label("By source"));
			for (const entry of status.sourceCounts) {
				const total = scan?.sources?.find((scanEntry) => scanEntry.source === entry.source)?.totalFiles;
				const counts = total === null ? `${entry.files}/? files · ${entry.chunks} chunks` : `${entry.files}/${total} files · ${entry.chunks} chunks`;
				lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
			}
		}
		if (status.fallback) lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
		if (status.vector) {
			const vectorState = status.vector.enabled ? status.vector.available === void 0 ? "unknown" : status.vector.available ? "ready" : "unavailable" : "disabled";
			const vectorColor = vectorState === "ready" ? theme.success : vectorState === "unavailable" ? theme.warn : theme.muted;
			lines.push(`${label("Vector")} ${colorize(rich, vectorColor, vectorState)}`);
			if (status.vector.dims) lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
			if (status.vector.extensionPath) lines.push(`${label("Vector path")} ${info(shortenHomePath(status.vector.extensionPath))}`);
			if (status.vector.loadError) lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
		}
		if (status.fts) {
			const ftsState = status.fts.enabled ? status.fts.available ? "ready" : "unavailable" : "disabled";
			const ftsColor = ftsState === "ready" ? theme.success : ftsState === "unavailable" ? theme.warn : theme.muted;
			lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState)}`);
			if (status.fts.error) lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
		}
		if (status.cache) {
			const cacheState = status.cache.enabled ? "enabled" : "disabled";
			const cacheColor = status.cache.enabled ? theme.success : theme.muted;
			const suffix = status.cache.enabled && typeof status.cache.entries === "number" ? ` (${status.cache.entries} entries)` : "";
			lines.push(`${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState)}${suffix}`);
			if (status.cache.enabled && typeof status.cache.maxEntries === "number") lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
		}
		if (status.batch) {
			const batchState = status.batch.enabled ? "enabled" : "disabled";
			const batchColor = status.batch.enabled ? theme.success : theme.warn;
			const batchSuffix = ` (failures ${status.batch.failures}/${status.batch.limit})`;
			lines.push(`${label("Batch")} ${colorize(rich, batchColor, batchState)}${muted(batchSuffix)}`);
			if (status.batch.lastError) lines.push(`${label("Batch error")} ${warn(status.batch.lastError)}`);
		}
		if (status.fallback?.reason) lines.push(muted(status.fallback.reason));
		if (indexError) lines.push(`${label("Index error")} ${warn(indexError)}`);
		if (scan?.issues.length) {
			lines.push(label("Issues"));
			for (const issue of scan.issues) lines.push(`  ${warn(issue)}`);
		}
		defaultRuntime.log(lines.join("\n"));
		defaultRuntime.log("");
	}
}
function registerMemoryCli(program) {
	const memory = program.command("memory").description("Search, inspect, and reindex memory files").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw memory status", "Show index and provider status."],
		["openclaw memory index --force", "Force a full reindex."],
		["openclaw memory search --query \"deployment notes\"", "Search indexed memory entries."],
		["openclaw memory status --json", "Output machine-readable JSON."]
	])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.openclaw.ai/cli/memory")}\n`);
	memory.command("status").description("Show memory search index status").option("--agent <id>", "Agent id (default: default agent)").option("--json", "Print JSON").option("--deep", "Probe embedding provider availability").option("--index", "Reindex if dirty (implies --deep)").option("--verbose", "Verbose logging", false).action(async (opts) => {
		await runMemoryStatus(opts);
	});
	memory.command("index").description("Reindex memory files").option("--agent <id>", "Agent id (default: default agent)").option("--force", "Force full reindex", false).option("--verbose", "Verbose logging", false).action(async (opts) => {
		setVerbose(Boolean(opts.verbose));
		const cfg = loadConfig();
		const agentIds = resolveAgentIds(cfg, opts.agent);
		for (const agentId of agentIds) await withMemoryManagerForAgent({
			cfg,
			agentId,
			run: async (manager) => {
				try {
					const syncFn = manager.sync ? manager.sync.bind(manager) : void 0;
					if (opts.verbose) {
						const status = manager.status();
						const rich = isRich();
						const heading = (text) => colorize(rich, theme.heading, text);
						const muted = (text) => colorize(rich, theme.muted, text);
						const info = (text) => colorize(rich, theme.info, text);
						const warn = (text) => colorize(rich, theme.warn, text);
						const label = (text) => muted(`${text}:`);
						const sourceLabels = (status.sources ?? []).map((source) => formatSourceLabel(source, status.workspaceDir ?? "", agentId));
						const extraPaths = status.workspaceDir ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? []) : [];
						const requestedProvider = status.requestedProvider ?? status.provider;
						const modelLabel = status.model ?? status.provider;
						const lines = [
							`${heading("Memory Index")} ${muted(`(${agentId})`)}`,
							`${label("Provider")} ${info(status.provider)} ${muted(`(requested: ${requestedProvider})`)}`,
							`${label("Model")} ${info(modelLabel)}`,
							sourceLabels.length ? `${label("Sources")} ${info(sourceLabels.join(", "))}` : null,
							extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null
						].filter(Boolean);
						if (status.fallback) lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
						defaultRuntime.log(lines.join("\n"));
						defaultRuntime.log("");
					}
					const startedAt = Date.now();
					let lastLabel = "Indexing memory…";
					let lastCompleted = 0;
					let lastTotal = 0;
					const formatElapsed = () => {
						const elapsedMs = Math.max(0, Date.now() - startedAt);
						const seconds = Math.floor(elapsedMs / 1e3);
						const minutes = Math.floor(seconds / 60);
						const remainingSeconds = seconds % 60;
						return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
					};
					const formatEta = () => {
						if (lastTotal <= 0 || lastCompleted <= 0) return null;
						const elapsedMs = Math.max(1, Date.now() - startedAt);
						const rate = lastCompleted / elapsedMs;
						if (!Number.isFinite(rate) || rate <= 0) return null;
						const remainingMs = Math.max(0, (lastTotal - lastCompleted) / rate);
						const seconds = Math.floor(remainingMs / 1e3);
						const minutes = Math.floor(seconds / 60);
						const remainingSeconds = seconds % 60;
						return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
					};
					const buildLabel = () => {
						const elapsed = formatElapsed();
						const eta = formatEta();
						return eta ? `${lastLabel} · elapsed ${elapsed} · eta ${eta}` : `${lastLabel} · elapsed ${elapsed}`;
					};
					if (!syncFn) {
						defaultRuntime.log("Memory backend does not support manual reindex.");
						return;
					}
					await withProgressTotals({
						label: "Indexing memory…",
						total: 0,
						fallback: opts.verbose ? "line" : void 0
					}, async (update, progress) => {
						const interval = setInterval(() => {
							progress.setLabel(buildLabel());
						}, 1e3);
						try {
							await syncFn({
								reason: "cli",
								force: Boolean(opts.force),
								progress: (syncUpdate) => {
									if (syncUpdate.label) lastLabel = syncUpdate.label;
									lastCompleted = syncUpdate.completed;
									lastTotal = syncUpdate.total;
									update({
										completed: syncUpdate.completed,
										total: syncUpdate.total,
										label: buildLabel()
									});
									progress.setLabel(buildLabel());
								}
							});
						} finally {
							clearInterval(interval);
						}
					});
					const qmdIndexSummary = await summarizeQmdIndexArtifact(manager);
					if (qmdIndexSummary) defaultRuntime.log(qmdIndexSummary);
					defaultRuntime.log(`Memory index updated (${agentId}).`);
				} catch (err) {
					const message = formatErrorMessage(err);
					defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
					process.exitCode = 1;
				}
			}
		});
	});
	memory.command("search").description("Search memory files").argument("[query]", "Search query").option("--query <text>", "Search query (alternative to positional argument)").option("--agent <id>", "Agent id (default: default agent)").option("--max-results <n>", "Max results", (value) => Number(value)).option("--min-score <n>", "Minimum score", (value) => Number(value)).option("--json", "Print JSON").action(async (queryArg, opts) => {
		const query = opts.query ?? queryArg;
		if (!query) {
			defaultRuntime.error("Missing search query. Provide a positional query or use --query <text>.");
			process.exitCode = 1;
			return;
		}
		const cfg = loadConfig();
		await withMemoryManagerForAgent({
			cfg,
			agentId: resolveAgent(cfg, opts.agent),
			run: async (manager) => {
				let results;
				try {
					results = await manager.search(query, {
						maxResults: opts.maxResults,
						minScore: opts.minScore
					});
				} catch (err) {
					const message = formatErrorMessage(err);
					defaultRuntime.error(`Memory search failed: ${message}`);
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					defaultRuntime.log(JSON.stringify({ results }, null, 2));
					return;
				}
				if (results.length === 0) {
					defaultRuntime.log("No matches.");
					return;
				}
				const rich = isRich();
				const lines = [];
				for (const result of results) {
					lines.push(`${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(rich, theme.accent, `${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`)}`);
					lines.push(colorize(rich, theme.muted, result.snippet));
					lines.push("");
				}
				defaultRuntime.log(lines.join("\n").trim());
			}
		});
	});
}

//#endregion
export { resolveMemoryBackendConfig as i, registerMemoryCli as n, getMemorySearchManager as r, memory_cli_exports as t };