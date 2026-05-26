import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as isRich, r as theme, t as colorize } from "./theme-D58JpUfy.js";
import { g as shortenHomePath, h as shortenHomeInString } from "./utils-sBTEdeml.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { r as setVerbose } from "./global-state-BAD7XgmL.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { n as asNullableRecord } from "./record-coerce-aMlBWINm.js";
import { G as resolveMemoryDreamingConfig, X as resolveMemoryRemDreamingConfig } from "./dreaming-CxCxWYoC.js";
import { l as resolveSessionTranscriptsDirForAgent } from "./paths-Bg3PO6Gj.js";
import { t as buildAgentSessionKey } from "./resolve-route-C8IahAyG.js";
import "./temp-path-DllZid8c.js";
import { t as resolveCommandSecretRefsViaGateway } from "./command-secret-gateway-BpOVXOFV.js";
import "./routing-79DRZvfm.js";
import { i as withProgressTotals, r as withProgress } from "./progress-CE2g1zbv.js";
import { r as withManager } from "./cli-utils-CdDa8OYO.js";
import "./memory-core-host-runtime-core-CkZUvQ_1.js";
import { c as normalizeExtraMemoryPaths, s as listMemoryFiles } from "./internal-CS1S1qm3.js";
import "./memory-core-host-status-CceUImkn.js";
import "./memory-core-host-runtime-cli-Bh4w9lk4.js";
import "./memory-core-host-runtime-files-DO0lUO6j.js";
import { i as seedHistoricalDailyMemorySignals, l as writeBackfillDiaryEntries, s as removeBackfillDiaryEntries } from "./dreaming-phases-B7KNuvKO.js";
import "./dreaming-shared-TJ4wErqZ.js";
import { a as rankShortTermPromotionCandidates, c as recordGroundedShortTermCandidates, d as repairShortTermPromotionArtifacts, f as resolveShortTermRecallLockPath, l as recordShortTermRecalls, n as applyShortTermPromotions, p as resolveShortTermRecallStorePath, r as auditShortTermPromotionArtifacts, u as removeGroundedShortTermCandidates } from "./short-term-promotion-BpCbM_k1.js";
import { n as resolveShortTermPromotionDreamingConfig } from "./dreaming-tnHCUW-G.js";
import { n as previewGroundedRemMarkdown, t as previewRemHarness } from "./rem-harness-CR-969c0.js";
import { i as formatMemoryVectorDegradedWriteReason } from "./manager-e4plhN8b.js";
import { r as getMemorySearchManager } from "./memory-Dei7fBTS.js";
import { n as repairDreamingArtifacts, t as auditDreamingArtifacts } from "./dreaming-repair-DTwFbOGC.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
//#region extensions/memory-core/src/cli.runtime.ts
function getMemoryCommandSecretTargetIds() {
	return new Set(["agents.defaults.memorySearch.remote.apiKey", "agents.list[].memorySearch.remote.apiKey"]);
}
async function loadMemoryCommandConfig(commandName) {
	const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
		config: getRuntimeConfig(),
		commandName,
		targetIds: getMemoryCommandSecretTargetIds()
	});
	return {
		config: resolvedConfig,
		diagnostics
	};
}
function emitMemorySecretResolveDiagnostics(diagnostics, params) {
	if (diagnostics.length === 0) return;
	const toStderr = params?.json === true;
	for (const entry of diagnostics) {
		const message = theme.warn(`[secrets] ${entry}`);
		if (toStderr) defaultRuntime.error(message);
		else defaultRuntime.log(message);
	}
}
function resolveMemoryPluginConfig(cfg) {
	return asNullableRecord(asNullableRecord(cfg.plugins?.entries?.["memory-core"])?.config) ?? {};
}
const DAILY_MEMORY_FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i;
async function listHistoricalDailyFiles(inputPath) {
	const resolvedPath = path.resolve(inputPath);
	let stat;
	try {
		stat = await fs$1.stat(resolvedPath);
	} catch (err) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
	if (stat.isFile()) return DAILY_MEMORY_FILE_NAME_RE.test(path.basename(resolvedPath)) ? [resolvedPath] : [];
	if (!stat.isDirectory()) return [];
	return (await fs$1.readdir(resolvedPath, { withFileTypes: true })).filter((entry) => entry.isFile() && DAILY_MEMORY_FILE_NAME_RE.test(entry.name)).map((entry) => path.join(resolvedPath, entry.name)).toSorted((a, b) => path.basename(a).localeCompare(path.basename(b)));
}
async function createHistoricalRemHarnessWorkspace(params) {
	const sourceFiles = await listHistoricalDailyFiles(params.inputPath);
	const workspaceDir = await fs$1.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-rem-harness-"));
	const memoryDir = path.join(workspaceDir, "memory");
	await fs$1.mkdir(memoryDir, { recursive: true });
	for (const filePath of sourceFiles) await fs$1.copyFile(filePath, path.join(memoryDir, path.basename(filePath)));
	const workspaceSourceFiles = sourceFiles.map((entry) => path.join(memoryDir, path.basename(entry)));
	const seeded = await seedHistoricalDailyMemorySignals({
		workspaceDir,
		filePaths: workspaceSourceFiles,
		limit: params.remLimit,
		nowMs: params.nowMs,
		timezone: params.timezone
	});
	return {
		workspaceDir,
		sourceFiles,
		workspaceSourceFiles,
		importedFileCount: seeded.importedFileCount,
		importedSignalCount: seeded.importedSignalCount,
		skippedPaths: seeded.skippedPaths
	};
}
function formatDreamingSummary(cfg) {
	const dreaming = resolveShortTermPromotionDreamingConfig({
		pluginConfig: resolveMemoryPluginConfig(cfg),
		cfg
	});
	if (!dreaming.enabled) return "off";
	const timezone = dreaming.timezone ? ` (${dreaming.timezone})` : "";
	return `${dreaming.cron}${timezone} · limit=${dreaming.limit} · minScore=${dreaming.minScore} · minRecallCount=${dreaming.minRecallCount} · minUniqueQueries=${dreaming.minUniqueQueries} · recencyHalfLifeDays=${dreaming.recencyHalfLifeDays} · maxAgeDays=${dreaming.maxAgeDays ?? "none"}`;
}
function formatAuditCounts(audit) {
	const scriptCoverage = audit.conceptTagScripts ? [
		audit.conceptTagScripts.latinEntryCount > 0 ? `${audit.conceptTagScripts.latinEntryCount} latin` : null,
		audit.conceptTagScripts.cjkEntryCount > 0 ? `${audit.conceptTagScripts.cjkEntryCount} cjk` : null,
		audit.conceptTagScripts.mixedEntryCount > 0 ? `${audit.conceptTagScripts.mixedEntryCount} mixed` : null,
		audit.conceptTagScripts.otherEntryCount > 0 ? `${audit.conceptTagScripts.otherEntryCount} other` : null
	].filter(Boolean).join(", ") : "";
	const suffix = scriptCoverage ? ` · scripts=${scriptCoverage}` : "";
	return `${audit.entryCount} entries · ${audit.promotedCount} promoted · ${audit.conceptTaggedEntryCount} concept-tagged · ${audit.spacedEntryCount} spaced${suffix}`;
}
function formatRepairSummary(repair) {
	const actions = [];
	if (repair.rewroteStore) actions.push(`rewrote store${repair.removedInvalidEntries > 0 ? ` (-${repair.removedInvalidEntries} invalid)` : ""}`);
	if (repair.removedStaleLock) actions.push("removed stale lock");
	return actions.length > 0 ? actions.join(" · ") : "no changes";
}
function formatDreamingAuditSummary(audit) {
	return [
		audit.dreamsPath ? "diary present" : "diary absent",
		`${audit.sessionCorpusFileCount} corpus files`,
		audit.sessionIngestionExists ? "ingestion state present" : "ingestion state absent",
		audit.suspiciousSessionCorpusLineCount > 0 ? `${audit.suspiciousSessionCorpusLineCount} suspicious lines` : null
	].filter(Boolean).join(" · ");
}
function formatDreamingRepairSummary(repair) {
	const actions = [];
	if (repair.archivedSessionCorpus) actions.push("archived session corpus");
	if (repair.archivedSessionIngestion) actions.push("archived ingestion state");
	if (repair.archivedDreamsDiary) actions.push("archived diary");
	if (repair.warnings.length > 0) actions.push(`${repair.warnings.length} warning${repair.warnings.length === 1 ? "" : "s"}`);
	return actions.length > 0 ? actions.join(" · ") : "no changes";
}
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
function buildCliMemorySearchSessionKey(agentId) {
	return buildAgentSessionKey({
		agentId,
		channel: "cli",
		peer: {
			kind: "direct",
			id: "memory-search"
		},
		dmScope: "per-channel-peer"
	});
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
function extractIsoDayFromPath(filePath) {
	return path.basename(filePath).match(DAILY_MEMORY_FILE_NAME_RE)?.[1] ?? null;
}
function normalizeRelativePath(baseDir, filePath) {
	return path.relative(baseDir, filePath).replace(/\\/g, "/");
}
function groundedMarkdownToDiaryLines(markdown) {
	return markdown.split(/\r?\n/).map((line) => line.replace(/^##\s+/, "").trimEnd()).filter((line, index, lines) => !(line.length === 0 && lines[index - 1]?.length === 0));
}
function parseGroundedRef(fallbackPath, ref) {
	const trimmed = ref.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/^(.*?):(\d+)(?:-(\d+))?$/);
	if (!match) return null;
	return {
		path: (match[1] ?? fallbackPath).replaceAll("\\", "/").replace(/^\.\//, ""),
		startLine: Math.max(1, Number(match[2])),
		endLine: Math.max(1, Number(match[3] ?? match[2]))
	};
}
function collectGroundedShortTermSeedItems(previews) {
	const items = [];
	const seen = /* @__PURE__ */ new Set();
	for (const file of previews) {
		const dayBucket = extractIsoDayFromPath(file.path) ?? void 0;
		const signals = [...file.memoryImplications.map((item) => ({
			text: item.text,
			refs: item.refs,
			score: .92,
			query: "__dreaming_grounded_backfill__:lasting-update",
			signalCount: 2
		})), ...file.candidates.filter((candidate) => candidate.lean === "likely_durable").map((candidate) => ({
			text: candidate.text,
			refs: candidate.refs,
			score: .82,
			query: "__dreaming_grounded_backfill__:candidate",
			signalCount: 1
		}))];
		for (const signal of signals) {
			if (!signal.text.trim()) continue;
			const firstRef = signal.refs.find((ref) => ref.trim().length > 0);
			const parsedRef = firstRef ? parseGroundedRef(file.path, firstRef) : null;
			if (!parsedRef) continue;
			const key = `${parsedRef.path}:${parsedRef.startLine}:${parsedRef.endLine}:${signal.query}:${signal.text.toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			items.push({
				path: parsedRef.path,
				startLine: parsedRef.startLine,
				endLine: parsedRef.endLine,
				snippet: signal.text,
				score: signal.score,
				query: signal.query,
				signalCount: signal.signalCount,
				...dayBucket ? { dayBucket } : {}
			});
		}
	}
	return items;
}
function matchesPromotionSelector(candidate, selector) {
	const trimmed = selector.trim().toLowerCase();
	if (!trimmed) return false;
	return candidate.key.toLowerCase() === trimmed || candidate.key.toLowerCase().includes(trimmed) || candidate.path.toLowerCase().includes(trimmed) || candidate.snippet.toLowerCase().includes(trimmed);
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
	const memoryDir = path.join(workspaceDir, "memory");
	const primary = await checkReadableFile(memoryFile);
	if (primary.issue) issues.push(primary.issue);
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
	const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory status");
	emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
	const agentIds = resolveAgentIds(cfg, opts.agent);
	const allResults = [];
	for (const agentId of agentIds) await withMemoryManagerForAgent({
		cfg,
		agentId,
		purpose: opts.index ? "cli" : "status",
		run: async (manager) => {
			const deep = Boolean(opts.deep || opts.index);
			let embeddingProbe;
			let indexError;
			const syncFn = manager.sync ? manager.sync.bind(manager) : void 0;
			if (deep) {
				const hasVectorStoreProbe = manager.status().backend === "builtin" && typeof manager.probeVectorStoreAvailability === "function";
				await withProgress({
					label: "Checking memory…",
					total: hasVectorStoreProbe ? 3 : 2
				}, async (progress) => {
					progress.setLabel(hasVectorStoreProbe ? "Probing vector store…" : "Probing vectors…");
					if (hasVectorStoreProbe) await manager.probeVectorStoreAvailability?.();
					else await manager.probeVectorAvailability();
					progress.tick();
					progress.setLabel("Probing embeddings…");
					embeddingProbe = await manager.probeEmbeddingAvailability();
					progress.tick();
					if (hasVectorStoreProbe) {
						progress.setLabel("Checking semantic vectors…");
						await manager.probeVectorAvailability();
						progress.tick();
					}
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
			}
			const status = manager.status();
			const sources = status.sources?.length ? status.sources : ["memory"];
			const workspaceDir = status.workspaceDir;
			const scan = workspaceDir ? await scanMemorySources({
				workspaceDir,
				agentId,
				sources,
				extraPaths: status.extraPaths
			}) : void 0;
			let audit;
			let repair;
			let dreamingAudit;
			let dreamingRepair;
			if (workspaceDir) {
				dreamingAudit = await auditDreamingArtifacts({ workspaceDir });
				if (opts.fix && dreamingAudit.issues.some((issue) => issue.fixable)) {
					dreamingRepair = await repairDreamingArtifacts({ workspaceDir });
					dreamingAudit = await auditDreamingArtifacts({ workspaceDir });
				}
				if (opts.fix) repair = await repairShortTermPromotionArtifacts({ workspaceDir });
				const customQmd = asNullableRecord(asNullableRecord(status.custom)?.qmd);
				audit = await auditShortTermPromotionArtifacts({
					workspaceDir,
					qmd: status.backend === "qmd" ? {
						dbPath: status.dbPath,
						collections: typeof customQmd?.collections === "number" ? customQmd.collections : void 0
					} : void 0
				});
			}
			allResults.push({
				agentId,
				status,
				embeddingProbe,
				indexError,
				scan,
				audit,
				repair,
				dreamingAudit,
				dreamingRepair
			});
		}
	});
	if (opts.json) {
		defaultRuntime.writeJson(allResults);
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
		const { agentId, status, embeddingProbe, indexError, scan, audit, repair, dreamingAudit, dreamingRepair } = result;
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
			`${label("Workspace")} ${info(workspacePath)}`,
			`${label("Dreaming")} ${info(formatDreamingSummary(cfg))}`
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
			const formatVectorState = (available) => status.vector?.enabled ? available === void 0 ? "unknown" : available ? "ready" : "unavailable" : "disabled";
			const formatVectorLine = (lineLabel, state) => {
				const vectorColor = state === "ready" ? theme.success : state === "unavailable" ? theme.warn : theme.muted;
				lines.push(`${label(lineLabel)} ${colorize(rich, vectorColor, state)}`);
			};
			if (status.backend === "builtin") {
				formatVectorLine("Vector store", formatVectorState(status.vector.storeAvailable));
				if (status.vector.semanticAvailable !== void 0) formatVectorLine("Semantic vectors", formatVectorState(status.vector.semanticAvailable));
			} else formatVectorLine("Vector", formatVectorState(status.vector.semanticAvailable ?? status.vector.available));
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
		if (audit) {
			lines.push(`${label("Recall store")} ${info(formatAuditCounts(audit))}`);
			lines.push(`${label("Recall path")} ${info(shortenHomePath(audit.storePath))}`);
			if (audit.updatedAt) lines.push(`${label("Recall updated")} ${info(audit.updatedAt)}`);
			if (status.backend === "qmd" && audit.qmd) {
				const qmdBits = [
					audit.qmd.dbPath ? shortenHomePath(audit.qmd.dbPath) : "<unknown>",
					typeof audit.qmd.dbBytes === "number" ? `${audit.qmd.dbBytes} bytes` : null,
					typeof audit.qmd.collections === "number" ? `${audit.qmd.collections} collections` : null
				].filter(Boolean);
				lines.push(`${label("QMD audit")} ${info(qmdBits.join(" · "))}`);
			}
		}
		if (dreamingAudit) {
			lines.push(`${label("Dreaming artifacts")} ${info(formatDreamingAuditSummary(dreamingAudit))}`);
			lines.push(`${label("Dream corpus")} ${info(shortenHomePath(dreamingAudit.sessionCorpusDir))}`);
			lines.push(`${label("Dream ingestion")} ${info(shortenHomePath(dreamingAudit.sessionIngestionPath))}`);
			if (dreamingAudit.dreamsPath) lines.push(`${label("Dream diary")} ${info(shortenHomePath(dreamingAudit.dreamsPath))}`);
		}
		if (repair) lines.push(`${label("Repair")} ${info(formatRepairSummary(repair))}`);
		if (dreamingRepair) {
			lines.push(`${label("Dream repair")} ${info(formatDreamingRepairSummary(dreamingRepair))}`);
			if (dreamingRepair.archiveDir) lines.push(`${label("Dream archive")} ${info(shortenHomePath(dreamingRepair.archiveDir))}`);
		}
		if (status.fallback?.reason) lines.push(muted(status.fallback.reason));
		if (indexError) lines.push(`${label("Index error")} ${warn(indexError)}`);
		if (scan?.issues.length) {
			lines.push(label("Issues"));
			for (const issue of scan.issues) lines.push(`  ${warn(issue)}`);
		}
		if (audit?.issues.length) {
			if (!scan?.issues.length) lines.push(label("Issues"));
			for (const issue of audit.issues) lines.push(`  ${issue.severity === "error" ? warn(issue.message) : muted(issue.message)}`);
			if (!opts.fix) lines.push(`  ${muted(`Fix: openclaw memory status --fix --agent ${agentId}`)}`);
		}
		if (dreamingAudit?.issues.length) {
			if (!scan?.issues.length && !audit?.issues.length) lines.push(label("Issues"));
			for (const issue of dreamingAudit.issues) lines.push(`  ${issue.severity === "error" ? warn(issue.message) : muted(issue.message)}`);
			if (!opts.fix) lines.push(`  ${muted(`Fix: openclaw memory status --fix --agent ${agentId}`)}`);
		}
		defaultRuntime.log(lines.join("\n"));
		defaultRuntime.log("");
	}
}
async function runMemoryIndex(opts) {
	setVerbose(Boolean(opts.verbose));
	const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory index");
	emitMemorySecretResolveDiagnostics(diagnostics);
	const agentIds = resolveAgentIds(cfg, opts.agent);
	for (const agentId of agentIds) await withMemoryManagerForAgent({
		cfg,
		agentId,
		purpose: "cli",
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
				let postIndexStatus = manager.status();
				let semanticVectorAvailable = postIndexStatus.vector?.semanticAvailable;
				const vectorStoreAvailable = postIndexStatus.vector?.storeAvailable ?? postIndexStatus.vector?.available;
				if (postIndexStatus.backend === "builtin" && (postIndexStatus.vector?.enabled ?? false) && semanticVectorAvailable === void 0 && vectorStoreAvailable !== false && typeof manager.probeVectorAvailability === "function") {
					semanticVectorAvailable = await manager.probeVectorAvailability();
					postIndexStatus = manager.status();
					semanticVectorAvailable = postIndexStatus.vector?.semanticAvailable ?? semanticVectorAvailable;
				}
				const vectorEnabled = postIndexStatus.vector?.enabled ?? false;
				const vectorAvailable = semanticVectorAvailable ?? postIndexStatus.vector?.semanticAvailable ?? postIndexStatus.vector?.available ?? postIndexStatus.vector?.storeAvailable;
				const vectorLoadErr = postIndexStatus.vector?.loadError;
				if (vectorEnabled && vectorAvailable === false) defaultRuntime.error(`Memory index WARNING (${agentId}): chunks_vec not updated — ${formatMemoryVectorDegradedWriteReason(vectorLoadErr)}. Vector recall degraded.`);
				else defaultRuntime.log(`Memory index updated (${agentId}).`);
			} catch (err) {
				const message = formatErrorMessage(err);
				defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
				process.exitCode = 1;
			}
		}
	});
}
async function runMemorySearch(queryArg, opts) {
	const query = opts.query ?? queryArg;
	if (!query) {
		defaultRuntime.error("Missing search query. Provide a positional query or use --query <text>.");
		process.exitCode = 1;
		return;
	}
	const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory search");
	emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
	const agentId = resolveAgent(cfg, opts.agent);
	const memoryPluginConfig = resolveMemoryPluginConfig(cfg);
	const dreamingEnabled = resolveMemoryDreamingConfig({
		pluginConfig: memoryPluginConfig,
		cfg
	}).enabled;
	const dreaming = resolveShortTermPromotionDreamingConfig({
		pluginConfig: memoryPluginConfig,
		cfg
	});
	await withMemoryManagerForAgent({
		cfg,
		agentId,
		purpose: "cli",
		run: async (manager) => {
			const sessionKey = buildCliMemorySearchSessionKey(agentId);
			let results;
			try {
				results = await manager.search(query, {
					maxResults: opts.maxResults,
					minScore: opts.minScore,
					sessionKey
				});
			} catch (err) {
				const message = formatErrorMessage(err);
				defaultRuntime.error(`Memory search failed: ${message}`);
				process.exitCode = 1;
				return;
			}
			const workspaceDir = typeof manager.status === "function" ? manager.status().workspaceDir : void 0;
			if (dreamingEnabled) recordShortTermRecalls({
				workspaceDir,
				query,
				results,
				timezone: dreaming.timezone
			}).catch(() => {});
			if (opts.json) {
				defaultRuntime.writeJson({ results });
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
}
async function runMemoryPromote(opts) {
	const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory promote");
	emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
	const agentId = resolveAgent(cfg, opts.agent);
	await withMemoryManagerForAgent({
		cfg,
		agentId,
		purpose: "status",
		run: async (manager) => {
			const status = manager.status();
			const workspaceDir = status.workspaceDir?.trim();
			const dreaming = resolveShortTermPromotionDreamingConfig({
				pluginConfig: resolveMemoryPluginConfig(cfg),
				cfg
			});
			if (!workspaceDir) {
				defaultRuntime.error("Memory promote requires a resolvable workspace directory.");
				process.exitCode = 1;
				return;
			}
			let candidates;
			try {
				candidates = await rankShortTermPromotionCandidates({
					workspaceDir,
					limit: opts.limit,
					minScore: opts.minScore ?? dreaming.minScore,
					minRecallCount: opts.minRecallCount ?? dreaming.minRecallCount,
					minUniqueQueries: opts.minUniqueQueries ?? dreaming.minUniqueQueries,
					recencyHalfLifeDays: dreaming.recencyHalfLifeDays,
					maxAgeDays: dreaming.maxAgeDays,
					includePromoted: Boolean(opts.includePromoted)
				});
			} catch (err) {
				defaultRuntime.error(`Memory promote ranking failed: ${formatErrorMessage(err)}`);
				process.exitCode = 1;
				return;
			}
			let applyResult;
			if (opts.apply) try {
				applyResult = await applyShortTermPromotions({
					workspaceDir,
					candidates,
					limit: opts.limit,
					minScore: opts.minScore ?? dreaming.minScore,
					minRecallCount: opts.minRecallCount ?? dreaming.minRecallCount,
					minUniqueQueries: opts.minUniqueQueries ?? dreaming.minUniqueQueries,
					maxAgeDays: dreaming.maxAgeDays,
					timezone: dreaming.timezone
				});
			} catch (err) {
				defaultRuntime.error(`Memory promote apply failed: ${formatErrorMessage(err)}`);
				process.exitCode = 1;
				return;
			}
			const storePath = resolveShortTermRecallStorePath(workspaceDir);
			const lockPath = resolveShortTermRecallLockPath(workspaceDir);
			const customQmd = asNullableRecord(asNullableRecord(status.custom)?.qmd);
			const audit = await auditShortTermPromotionArtifacts({
				workspaceDir,
				qmd: status.backend === "qmd" ? {
					dbPath: status.dbPath,
					collections: typeof customQmd?.collections === "number" ? customQmd.collections : void 0
				} : void 0
			});
			if (opts.json) {
				defaultRuntime.writeJson({
					workspaceDir,
					storePath,
					lockPath,
					audit,
					candidates,
					apply: applyResult ? {
						applied: applyResult.applied,
						appended: applyResult.appended,
						reconciledExisting: applyResult.reconciledExisting,
						memoryPath: applyResult.memoryPath,
						appliedCandidates: applyResult.appliedCandidates
					} : void 0
				});
				return;
			}
			if (candidates.length === 0) {
				defaultRuntime.log("No short-term recall candidates.");
				defaultRuntime.log(`Recall store: ${shortenHomePath(storePath)}`);
				if (audit.issues.length > 0) for (const issue of audit.issues) defaultRuntime.log(issue.message);
				return;
			}
			const rich = isRich();
			const lines = [];
			lines.push(`${colorize(rich, theme.heading, "Short-Term Promotion Candidates")} ${colorize(rich, theme.muted, `(${agentId})`)}`);
			lines.push(`${colorize(rich, theme.muted, "Recall store:")} ${shortenHomePath(storePath)}`);
			lines.push(colorize(rich, theme.muted, `Store health: ${formatAuditCounts(audit)}`));
			for (const candidate of candidates) {
				lines.push(`${colorize(rich, theme.success, candidate.score.toFixed(3))} ${colorize(rich, theme.accent, `${shortenHomePath(candidate.path)}:${candidate.startLine}-${candidate.endLine}`)}`);
				lines.push(colorize(rich, theme.muted, `recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} queries=${candidate.uniqueQueries} age=${candidate.ageDays.toFixed(1)}d consolidate=${candidate.components.consolidation.toFixed(2)} conceptual=${candidate.components.conceptual.toFixed(2)}`));
				if (candidate.conceptTags.length > 0) lines.push(colorize(rich, theme.muted, `concepts=${candidate.conceptTags.join(", ")}`));
				if (candidate.snippet) lines.push(colorize(rich, theme.muted, candidate.snippet));
				lines.push("");
			}
			if (audit.issues.length > 0) {
				lines.push(colorize(rich, theme.warn, "Audit issues:"));
				for (const issue of audit.issues) lines.push(colorize(rich, issue.severity === "error" ? theme.warn : theme.muted, issue.message));
				lines.push("");
			}
			if (applyResult) if (applyResult.applied > 0) {
				lines.push(colorize(rich, theme.success, `Processed ${applyResult.applied} candidate(s) for ${shortenHomePath(applyResult.memoryPath)}.`));
				lines.push(colorize(rich, theme.muted, `appended=${applyResult.appended} reconciledExisting=${applyResult.reconciledExisting}`));
			} else lines.push(colorize(rich, theme.warn, "No candidates met apply criteria."));
			defaultRuntime.log(lines.join("\n").trim());
		}
	});
}
async function runMemoryPromoteExplain(selectorArg, opts) {
	const selector = selectorArg?.trim();
	if (!selector) {
		defaultRuntime.error("Memory promote-explain requires a non-empty selector.");
		process.exitCode = 1;
		return;
	}
	const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory promote-explain");
	emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
	const agentId = resolveAgent(cfg, opts.agent);
	await withMemoryManagerForAgent({
		cfg,
		agentId,
		purpose: "status",
		run: async (manager) => {
			const workspaceDir = manager.status().workspaceDir?.trim();
			const dreaming = resolveShortTermPromotionDreamingConfig({
				pluginConfig: resolveMemoryPluginConfig(cfg),
				cfg
			});
			if (!workspaceDir) {
				defaultRuntime.error("Memory promote-explain requires a resolvable workspace directory.");
				process.exitCode = 1;
				return;
			}
			let candidates;
			try {
				candidates = await rankShortTermPromotionCandidates({
					workspaceDir,
					minScore: 0,
					minRecallCount: 0,
					minUniqueQueries: 0,
					includePromoted: Boolean(opts.includePromoted),
					recencyHalfLifeDays: dreaming.recencyHalfLifeDays,
					maxAgeDays: dreaming.maxAgeDays
				});
			} catch (err) {
				defaultRuntime.error(`Memory promote-explain failed: ${formatErrorMessage(err)}`);
				process.exitCode = 1;
				return;
			}
			const candidate = candidates.find((entry) => matchesPromotionSelector(entry, selector));
			if (!candidate) {
				defaultRuntime.error(`No promotion candidate matched "${selector}".`);
				process.exitCode = 1;
				return;
			}
			const thresholds = {
				minScore: dreaming.minScore,
				minRecallCount: dreaming.minRecallCount,
				minUniqueQueries: dreaming.minUniqueQueries,
				maxAgeDays: dreaming.maxAgeDays ?? null
			};
			if (opts.json) {
				defaultRuntime.writeJson({
					workspaceDir,
					thresholds,
					candidate,
					passes: {
						score: candidate.score >= thresholds.minScore,
						recallCount: candidate.recallCount >= thresholds.minRecallCount,
						uniqueQueries: candidate.uniqueQueries >= thresholds.minUniqueQueries,
						maxAge: thresholds.maxAgeDays === null ? true : candidate.ageDays <= thresholds.maxAgeDays
					}
				});
				return;
			}
			const rich = isRich();
			const lines = [
				`${colorize(rich, theme.heading, "Promotion Explain")} ${colorize(rich, theme.muted, "(" + agentId + ")")}`,
				colorize(rich, theme.accent, candidate.key),
				colorize(rich, theme.muted, `${shortenHomePath(candidate.path)}:${String(candidate.startLine)}-${String(candidate.endLine)}`),
				candidate.snippet,
				colorize(rich, theme.muted, `score=${candidate.score.toFixed(3)} recallCount=${candidate.recallCount} uniqueQueries=${candidate.uniqueQueries} ageDays=${candidate.ageDays.toFixed(1)}`),
				colorize(rich, theme.muted, `components: frequency=${candidate.components.frequency.toFixed(2)} relevance=${candidate.components.relevance.toFixed(2)} diversity=${candidate.components.diversity.toFixed(2)} recency=${candidate.components.recency.toFixed(2)} consolidation=${candidate.components.consolidation.toFixed(2)} conceptual=${candidate.components.conceptual.toFixed(2)}`),
				colorize(rich, theme.muted, `thresholds: minScore=${thresholds.minScore} minRecallCount=${thresholds.minRecallCount} minUniqueQueries=${thresholds.minUniqueQueries} maxAgeDays=${thresholds.maxAgeDays ?? "none"}`)
			];
			if (candidate.conceptTags.length > 0) lines.push(colorize(rich, theme.muted, `concepts=${candidate.conceptTags.join(", ")}`));
			defaultRuntime.log(lines.join("\n"));
		}
	});
}
async function runMemoryRemHarness(opts) {
	const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory rem-harness");
	emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
	const agentId = resolveAgent(cfg, opts.agent);
	await withMemoryManagerForAgent({
		cfg,
		agentId,
		purpose: "status",
		run: async (manager) => {
			const managerWorkspaceDir = manager.status().workspaceDir?.trim();
			const pluginConfig = resolveMemoryPluginConfig(cfg);
			if (!managerWorkspaceDir && !opts.path) {
				defaultRuntime.error("Memory rem-harness requires a resolvable workspace directory.");
				process.exitCode = 1;
				return;
			}
			const remConfig = resolveMemoryRemDreamingConfig({
				pluginConfig,
				cfg
			});
			const nowMs = Date.now();
			let workspaceDir = managerWorkspaceDir ?? "";
			let sourceFiles = [];
			let groundedInputPaths = [];
			let importedFileCount = 0;
			let importedSignalCount = 0;
			let skippedPaths = [];
			let cleanupWorkspaceDir = null;
			if (opts.path) {
				const historical = await createHistoricalRemHarnessWorkspace({
					inputPath: opts.path,
					remLimit: remConfig.limit,
					nowMs,
					timezone: remConfig.timezone
				});
				workspaceDir = historical.workspaceDir;
				cleanupWorkspaceDir = historical.workspaceDir;
				sourceFiles = historical.sourceFiles;
				groundedInputPaths = historical.workspaceSourceFiles;
				importedFileCount = historical.importedFileCount;
				importedSignalCount = historical.importedSignalCount;
				skippedPaths = historical.skippedPaths;
				if (sourceFiles.length === 0) {
					await fs$1.rm(historical.workspaceDir, {
						recursive: true,
						force: true
					});
					defaultRuntime.error(`Memory rem-harness found no YYYY-MM-DD.md files at ${shortenHomePath(path.resolve(opts.path))}.`);
					process.exitCode = 1;
					return;
				}
			}
			if (!workspaceDir) {
				defaultRuntime.error("Memory rem-harness requires a resolvable workspace directory.");
				process.exitCode = 1;
				return;
			}
			try {
				const preview = await previewRemHarness({
					workspaceDir,
					cfg,
					pluginConfig,
					grounded: Boolean(opts.grounded),
					groundedInputPaths,
					includePromoted: Boolean(opts.includePromoted),
					nowMs
				});
				groundedInputPaths = preview.groundedInputPaths;
				const remPreview = preview.rem;
				const groundedPreview = preview.grounded;
				const deepCandidates = preview.deep.candidates;
				if (opts.json) {
					defaultRuntime.writeJson({
						workspaceDir,
						sourcePath: opts.path ? path.resolve(opts.path) : null,
						sourceFiles,
						historicalImport: opts.path ? {
							importedFileCount,
							importedSignalCount,
							skippedPaths
						} : null,
						remConfig: preview.remConfig,
						deepConfig: {
							minScore: preview.deepConfig.minScore,
							minRecallCount: preview.deepConfig.minRecallCount,
							minUniqueQueries: preview.deepConfig.minUniqueQueries,
							recencyHalfLifeDays: preview.deepConfig.recencyHalfLifeDays,
							maxAgeDays: preview.deepConfig.maxAgeDays ?? null
						},
						rem: {
							skipped: preview.remSkipped,
							...remPreview
						},
						grounded: groundedPreview,
						deep: {
							candidateCount: preview.deep.candidateCount,
							candidates: deepCandidates
						}
					});
					return;
				}
				const rich = isRich();
				const lines = [
					`${colorize(rich, theme.heading, "REM Harness")} ${colorize(rich, theme.muted, `(${agentId})`)}`,
					colorize(rich, theme.muted, `workspace=${shortenHomePath(workspaceDir)}`),
					...opts.path ? [
						colorize(rich, theme.muted, `sourcePath=${shortenHomePath(path.resolve(opts.path))}`),
						colorize(rich, theme.muted, `historicalFiles=${sourceFiles.length} importedFiles=${importedFileCount} importedSignals=${importedSignalCount}`),
						...skippedPaths.length > 0 ? [colorize(rich, theme.warn, `skipped=${skippedPaths.map((entry) => shortenHomePath(entry)).join(", ")}`)] : []
					] : [],
					...opts.grounded ? [colorize(rich, theme.muted, `groundedInputs=${groundedInputPaths.length > 0 ? groundedInputPaths.map((entry) => shortenHomePath(entry)).join(", ") : "none"}`)] : [],
					colorize(rich, theme.muted, `recentRecallEntries=${preview.recallEntryCount} deepCandidates=${deepCandidates.length}`),
					"",
					colorize(rich, theme.heading, "REM Preview"),
					...remPreview.bodyLines,
					...groundedPreview ? [
						"",
						colorize(rich, theme.heading, "Grounded REM"),
						...groundedPreview.files.flatMap((file) => [
							colorize(rich, theme.muted, file.path),
							file.renderedMarkdown,
							""
						])
					] : [],
					"",
					colorize(rich, theme.heading, "Deep Candidates"),
					...deepCandidates.length > 0 ? deepCandidates.slice(0, 10).map((candidate) => `${candidate.score.toFixed(3)} ${candidate.snippet} [${shortenHomePath(candidate.path)}:${candidate.startLine}-${candidate.endLine}]`) : ["- No deep candidates."]
				];
				defaultRuntime.log(lines.join("\n"));
			} finally {
				if (cleanupWorkspaceDir) await fs$1.rm(cleanupWorkspaceDir, {
					recursive: true,
					force: true
				});
			}
		}
	});
}
async function runMemoryRemBackfill(opts) {
	const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory rem-backfill");
	emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
	const agentId = resolveAgent(cfg, opts.agent);
	await withMemoryManagerForAgent({
		cfg,
		agentId,
		purpose: "status",
		run: async (manager) => {
			const workspaceDir = manager.status().workspaceDir?.trim();
			const remConfig = resolveMemoryRemDreamingConfig({
				pluginConfig: resolveMemoryPluginConfig(cfg),
				cfg
			});
			if (!workspaceDir) {
				defaultRuntime.error("Memory rem-backfill requires a resolvable workspace directory.");
				process.exitCode = 1;
				return;
			}
			if (opts.rollback || opts.rollbackShortTerm) {
				const diaryRollback = opts.rollback ? await removeBackfillDiaryEntries({ workspaceDir }) : null;
				const shortTermRollback = opts.rollbackShortTerm ? await removeGroundedShortTermCandidates({ workspaceDir }) : null;
				if (opts.json) {
					defaultRuntime.writeJson({
						workspaceDir,
						rollback: Boolean(opts.rollback),
						rollbackShortTerm: Boolean(opts.rollbackShortTerm),
						...diaryRollback ? {
							dreamsPath: diaryRollback.dreamsPath,
							removedEntries: diaryRollback.removed
						} : {},
						...shortTermRollback ? {
							shortTermStorePath: shortTermRollback.storePath,
							removedShortTermEntries: shortTermRollback.removed
						} : {}
					});
					return;
				}
				defaultRuntime.log([
					`${colorize(isRich(), theme.heading, "REM Backfill")} ${colorize(isRich(), theme.muted, "(rollback)")}`,
					colorize(isRich(), theme.muted, `workspace=${shortenHomePath(workspaceDir)}`),
					...diaryRollback ? [colorize(isRich(), theme.muted, `dreamsPath=${shortenHomePath(diaryRollback.dreamsPath)}`), colorize(isRich(), theme.muted, `removedEntries=${diaryRollback.removed}`)] : [],
					...shortTermRollback ? [colorize(isRich(), theme.muted, `shortTermStorePath=${shortenHomePath(shortTermRollback.storePath)}`), colorize(isRich(), theme.muted, `removedShortTermEntries=${shortTermRollback.removed}`)] : []
				].join("\n"));
				return;
			}
			if (!opts.path) {
				defaultRuntime.error("Memory rem-backfill requires --path <file-or-dir> unless using --rollback.");
				process.exitCode = 1;
				return;
			}
			const scratchDir = await fs$1.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-rem-backfill-"));
			try {
				const sourceFiles = await listHistoricalDailyFiles(opts.path);
				if (sourceFiles.length === 0) {
					defaultRuntime.error(`Memory rem-backfill found no YYYY-MM-DD.md files at ${shortenHomePath(path.resolve(opts.path))}.`);
					process.exitCode = 1;
					return;
				}
				const scratchMemoryDir = path.join(scratchDir, "memory");
				await fs$1.mkdir(scratchMemoryDir, { recursive: true });
				const workspaceSourceFiles = [];
				for (const filePath of sourceFiles) {
					const dst = path.join(scratchMemoryDir, path.basename(filePath));
					await fs$1.copyFile(filePath, dst);
					workspaceSourceFiles.push(dst);
				}
				const grounded = await previewGroundedRemMarkdown({
					workspaceDir: scratchDir,
					inputPaths: workspaceSourceFiles
				});
				const sourcePathByScratchRelativePath = new Map(workspaceSourceFiles.map((scratchPath, index) => [normalizeRelativePath(scratchDir, scratchPath), sourceFiles[index] ?? scratchPath]));
				const written = await writeBackfillDiaryEntries({
					workspaceDir,
					entries: grounded.files.map((file) => {
						const isoDay = extractIsoDayFromPath(file.path);
						if (!isoDay) return null;
						return {
							isoDay,
							sourcePath: sourcePathByScratchRelativePath.get(file.path) ?? file.path,
							bodyLines: groundedMarkdownToDiaryLines(file.renderedMarkdown)
						};
					}).filter((entry) => entry !== null),
					timezone: remConfig.timezone
				});
				let stagedShortTermEntries = 0;
				let replacedShortTermEntries = 0;
				if (opts.stageShortTerm) {
					replacedShortTermEntries = (await removeGroundedShortTermCandidates({ workspaceDir })).removed;
					const shortTermSeedItems = collectGroundedShortTermSeedItems(grounded.files);
					if (shortTermSeedItems.length > 0) await recordGroundedShortTermCandidates({
						workspaceDir,
						query: "__dreaming_grounded_backfill__",
						items: shortTermSeedItems,
						dedupeByQueryPerDay: true,
						nowMs: Date.now(),
						timezone: remConfig.timezone
					});
					stagedShortTermEntries = shortTermSeedItems.length;
				}
				if (opts.json) {
					defaultRuntime.writeJson({
						workspaceDir,
						sourcePath: path.resolve(opts.path),
						sourceFiles,
						groundedFiles: grounded.scannedFiles,
						writtenEntries: written.written,
						replacedEntries: written.replaced,
						dreamsPath: written.dreamsPath,
						...opts.stageShortTerm ? {
							stagedShortTermEntries,
							replacedShortTermEntries
						} : {}
					});
					return;
				}
				const rich = isRich();
				defaultRuntime.log([
					`${colorize(rich, theme.heading, "REM Backfill")} ${colorize(rich, theme.muted, `(${agentId})`)}`,
					colorize(rich, theme.muted, `workspace=${shortenHomePath(workspaceDir)}`),
					colorize(rich, theme.muted, `sourcePath=${shortenHomePath(path.resolve(opts.path))}`),
					colorize(rich, theme.muted, `historicalFiles=${sourceFiles.length} writtenEntries=${written.written} replacedEntries=${written.replaced}`),
					...opts.stageShortTerm ? [colorize(rich, theme.muted, `stagedShortTermEntries=${stagedShortTermEntries} replacedShortTermEntries=${replacedShortTermEntries}`)] : [],
					colorize(rich, theme.muted, `dreamsPath=${shortenHomePath(written.dreamsPath)}`)
				].join("\n"));
			} finally {
				await fs$1.rm(scratchDir, {
					recursive: true,
					force: true
				});
			}
		}
	});
}
//#endregion
export { runMemoryIndex, runMemoryPromote, runMemoryPromoteExplain, runMemoryRemBackfill, runMemoryRemHarness, runMemorySearch, runMemoryStatus };
