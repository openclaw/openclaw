import { i as formatErrorMessage } from "../../errors-b3ZrCRlt.js";
import { c as resolveDefaultAgentId } from "../../agent-scope-config-CMp71_27.js";
import "../../error-runtime-DGHc7DZw.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import "../../memory-host-core-BsjFNwCJ.js";
import "../../api-DPrhLRY7.js";
import { A as lintMemoryWikiVault, B as parseWikiMarkdown, C as resolveMemoryWikiStatus, D as runObsidianDaily, E as runObsidianCommand, F as getMemoryWikiPage, I as readQueryableWikiPages, L as searchMemoryWiki, M as applyMemoryWikiMutation, N as normalizeMemoryWikiMutationInput, O as runObsidianOpen, P as WIKI_SEARCH_MODES, R as compileMemoryWikiVault, S as renderMemoryWikiStatus, T as probeObsidianCli, j as ingestMemoryWikiSource, k as runObsidianSearch, t as registerWikiCli, w as syncMemoryWikiImportedSources, x as buildMemoryWikiDoctorReport, z as initializeMemoryWikiVault } from "../../cli-DEGawZSi.js";
import { d as resolveMemoryWikiConfig, l as memoryWikiConfigSchema, o as WIKI_SEARCH_BACKENDS, s as WIKI_SEARCH_CORPORA } from "../../config-B8Wtke0B.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { Type } from "typebox";
//#region extensions/memory-wiki/src/corpus-supplement.ts
function createWikiCorpusSupplement(params) {
	return {
		search: async (input) => await searchMemoryWiki({
			config: params.config,
			appConfig: params.appConfig,
			agentSessionKey: input.agentSessionKey,
			query: input.query,
			maxResults: input.maxResults,
			searchBackend: "local",
			searchCorpus: "wiki"
		}),
		get: async (input) => await getMemoryWikiPage({
			config: params.config,
			appConfig: params.appConfig,
			agentSessionKey: input.agentSessionKey,
			lookup: input.lookup,
			fromLine: input.fromLine,
			lineCount: input.lineCount,
			searchBackend: "local",
			searchCorpus: "wiki"
		})
	};
}
//#endregion
//#region extensions/memory-wiki/src/import-insights.ts
function normalizeStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}
function normalizeFiniteInt(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}
function normalizeTimestamp$1(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function humanizeLabelSuffix(label) {
	return (label.includes("/") ? label.split("/").slice(1).join("/") : label).split(/[/-]/g).filter((part) => part.length > 0).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function resolveTopic(labels) {
	const preferred = labels.find((label) => label.startsWith("topic/")) ?? labels.find((label) => label.startsWith("area/")) ?? labels.find((label) => label.startsWith("domain/")) ?? "topic/other";
	return {
		key: preferred,
		label: humanizeLabelSuffix(preferred)
	};
}
function extractHeadingSection(body, heading) {
	const lines = body.split(/\r?\n/);
	const headingLine = `## ${heading}`;
	const startIndex = lines.findIndex((line) => line.trim() === headingLine);
	if (startIndex < 0) return [];
	const section = [];
	for (const line of lines.slice(startIndex + 1)) {
		if (line.startsWith("## ")) break;
		if (line.trim().length > 0) section.push(line.trimEnd());
	}
	return section;
}
function extractDigestField(lines, prefix) {
	const needle = `- ${prefix}:`;
	const line = lines.find((entry) => entry.startsWith(needle));
	if (!line) return;
	const value = line.slice(needle.length).trim();
	return value.length > 0 ? value : void 0;
}
function extractIntegerField(lines, prefix) {
	const raw = extractDigestField(lines, prefix);
	if (!raw) return 0;
	const match = raw.match(/\d+/);
	return match ? normalizeFiniteInt(Number(match[0])) : 0;
}
function extractPreferenceSignals(lines) {
	const startIndex = lines.findIndex((line) => line.startsWith("- Preference signals:"));
	if (startIndex < 0) return [];
	if (lines[startIndex]?.includes("none detected")) return [];
	const signals = [];
	for (const line of lines.slice(startIndex + 1)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("- ")) break;
		const signal = trimmed.slice(2).trim();
		if (signal.length > 0) signals.push(signal);
	}
	return signals;
}
function parseTranscriptTurns(body) {
	const transcriptLines = extractHeadingSection(body, "Active Branch Transcript");
	if (transcriptLines.length === 0) return [];
	const turns = [];
	let currentRole = null;
	let currentLines = [];
	const flush = () => {
		if (!currentRole) {
			currentLines = [];
			return;
		}
		const text = currentLines.join("\n").trim();
		if (text) turns.push({
			role: currentRole,
			text
		});
		currentLines = [];
	};
	for (const rawLine of transcriptLines) {
		const line = rawLine.trimEnd();
		if (line.trim() === "### User") {
			flush();
			currentRole = "user";
			continue;
		}
		if (line.trim() === "### Assistant") {
			flush();
			currentRole = "assistant";
			continue;
		}
		if (currentRole) currentLines.push(line);
	}
	flush();
	return turns;
}
function firstParagraph(text) {
	return text.split(/\n\s*\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0);
}
function shortenSentence(value, maxLength = 180) {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}
function extractCorrectionSignals(turns) {
	const correctionPatterns = [
		"you're right",
		"you’re right",
		"bad assumption",
		"let's reset",
		"let’s reset",
		"does not exist anymore",
		"that was a bad assumption",
		"what actually works today"
	];
	return turns.filter((turn) => turn.role === "assistant").flatMap((turn) => {
		const first = firstParagraph(turn.text);
		if (!first) return [];
		const normalized = first.toLowerCase();
		return correctionPatterns.some((pattern) => normalized.includes(pattern)) ? [shortenSentence(first, 160)] : [];
	}).slice(0, 2);
}
function deriveCandidateSignals(params) {
	const output = [];
	for (const signal of params.preferenceSignals) if (!output.includes(signal)) output.push(signal);
	for (const correction of params.correctionSignals) {
		const summary = `Correction detected: ${correction}`;
		if (!output.includes(summary)) output.push(summary);
	}
	return output.slice(0, 4);
}
function deriveSummary(params) {
	if (params.digestStatus === "withheld") {
		if (params.riskReasons.length > 0) return `Sensitive ${params.topicLabel.toLowerCase()} chat withheld from durable-memory extraction because it touches ${params.riskReasons.join(", ")}.`;
		return `Sensitive ${params.topicLabel.toLowerCase()} chat withheld from durable-memory extraction pending review.`;
	}
	if (params.assistantOpener) return shortenSentence(params.assistantOpener, 180);
	if (params.firstUserLine) return shortenSentence(params.firstUserLine, 180);
	return params.title;
}
function shouldExposeImportContent(digestStatus) {
	return digestStatus === "available";
}
function normalizeRiskLevel(value) {
	if (value === "low" || value === "medium" || value === "high") return value;
	return "unknown";
}
function compareItemsByUpdated(left, right) {
	const leftKey = left.updatedAt ?? left.createdAt ?? "";
	const rightKey = right.updatedAt ?? right.createdAt ?? "";
	if (rightKey !== leftKey) return rightKey.localeCompare(leftKey);
	return left.title.localeCompare(right.title);
}
async function listMemoryWikiImportInsights(config) {
	const items = (await readQueryableWikiPages(config.vault.path)).flatMap((page) => {
		if (page.pageType !== "source") return [];
		const parsed = parseWikiMarkdown(page.raw);
		if (parsed.frontmatter.sourceType !== "chatgpt-export") return [];
		const labels = normalizeStringArray(parsed.frontmatter.labels);
		const topic = resolveTopic(labels);
		const triageLines = extractHeadingSection(parsed.body, "Auto Triage");
		const digestLines = extractHeadingSection(parsed.body, "Auto Digest");
		const transcriptTurns = parseTranscriptTurns(parsed.body);
		const digestStatus = digestLines.some((line) => line.toLowerCase().includes("withheld from durable-candidate generation")) ? "withheld" : "available";
		const exposeImportContent = shouldExposeImportContent(digestStatus);
		const userTurns = transcriptTurns.filter((turn) => turn.role === "user");
		const assistantTurns = transcriptTurns.filter((turn) => turn.role === "assistant");
		const assistantOpener = exposeImportContent ? firstParagraph(assistantTurns[0]?.text ?? "") : void 0;
		const correctionSignals = exposeImportContent ? extractCorrectionSignals(transcriptTurns) : [];
		const preferenceSignals = exposeImportContent ? extractPreferenceSignals(digestLines) : [];
		const candidateSignals = exposeImportContent ? deriveCandidateSignals({
			preferenceSignals,
			correctionSignals
		}) : [];
		const firstUserLine = exposeImportContent ? extractDigestField(digestLines, "First user line") : void 0;
		const lastUserLine = exposeImportContent ? extractDigestField(digestLines, "Last user line") : void 0;
		return [{
			pagePath: page.relativePath,
			title: page.title.replace(/^ChatGPT Export:\s*/i, ""),
			riskLevel: normalizeRiskLevel(parsed.frontmatter.riskLevel),
			riskReasons: normalizeStringArray(parsed.frontmatter.riskReasons),
			labels,
			topicKey: topic.key,
			topicLabel: topic.label,
			digestStatus,
			activeBranchMessages: extractIntegerField(triageLines, "Active-branch messages"),
			userMessageCount: Math.max(extractIntegerField(digestLines, "User messages"), userTurns.length),
			assistantMessageCount: Math.max(extractIntegerField(digestLines, "Assistant messages"), assistantTurns.length),
			...firstUserLine ? { firstUserLine } : {},
			...lastUserLine ? { lastUserLine } : {},
			...assistantOpener ? { assistantOpener } : {},
			summary: deriveSummary({
				title: page.title.replace(/^ChatGPT Export:\s*/i, ""),
				digestStatus,
				...assistantOpener ? { assistantOpener } : {},
				...firstUserLine ? { firstUserLine } : {},
				riskReasons: normalizeStringArray(parsed.frontmatter.riskReasons),
				topicLabel: topic.label
			}),
			candidateSignals,
			correctionSignals,
			preferenceSignals,
			...normalizeTimestamp$1(parsed.frontmatter.createdAt) ? { createdAt: normalizeTimestamp$1(parsed.frontmatter.createdAt) } : {},
			...normalizeTimestamp$1(parsed.frontmatter.updatedAt) ? { updatedAt: normalizeTimestamp$1(parsed.frontmatter.updatedAt) } : {}
		}];
	}).toSorted(compareItemsByUpdated);
	const clustersByKey = /* @__PURE__ */ new Map();
	for (const item of items) {
		const list = clustersByKey.get(item.topicKey) ?? [];
		list.push(item);
		clustersByKey.set(item.topicKey, list);
	}
	const clusters = [...clustersByKey.entries()].map(([key, clusterItems]) => {
		const sortedItems = [...clusterItems].toSorted(compareItemsByUpdated);
		const updatedAt = sortedItems.map((item) => item.updatedAt ?? item.createdAt).find((value) => typeof value === "string" && value.length > 0);
		return Object.assign({
			key,
			label: sortedItems[0]?.topicLabel ?? humanizeLabelSuffix(key),
			itemCount: sortedItems.length,
			highRiskCount: sortedItems.filter((item) => item.riskLevel === `high`).length,
			withheldCount: sortedItems.filter((item) => item.digestStatus === `withheld`).length,
			preferenceSignalCount: sortedItems.reduce((sum, item) => sum + item.preferenceSignals.length, 0)
		}, updatedAt ? { updatedAt } : {}, { items: sortedItems });
	}).toSorted((left, right) => {
		const leftKey = left.updatedAt ?? "";
		const rightKey = right.updatedAt ?? "";
		if (rightKey !== leftKey) return rightKey.localeCompare(leftKey);
		if (right.itemCount !== left.itemCount) return right.itemCount - left.itemCount;
		return left.label.localeCompare(right.label);
	});
	return {
		sourceType: "chatgpt",
		totalItems: items.length,
		totalClusters: clusters.length,
		clusters
	};
}
//#endregion
//#region extensions/memory-wiki/src/import-runs.ts
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function asStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}
function normalizeImportRunSummary(raw) {
	const record = asRecord(raw);
	if (!record) return null;
	const runId = typeof record?.runId === "string" ? record.runId.trim() : "";
	const importType = typeof record?.importType === "string" ? record.importType.trim() : "";
	const appliedAt = typeof record?.appliedAt === "string" ? record.appliedAt.trim() : "";
	const exportPath = typeof record?.exportPath === "string" ? record.exportPath.trim() : "";
	const sourcePath = typeof record?.sourcePath === "string" ? record.sourcePath.trim() : "";
	if (!runId || !importType || !appliedAt || !exportPath || !sourcePath) return null;
	const createdPaths = asStringArray(record.createdPaths);
	const updatedPaths = Array.isArray(record.updatedPaths) ? record.updatedPaths.map((entry) => asRecord(entry)).map((entry) => typeof entry?.path === "string" ? entry.path.trim() : "").filter((entry) => entry.length > 0) : [];
	const pagePaths = [...new Set([...createdPaths, ...updatedPaths])];
	const conversationCount = typeof record.conversationCount === "number" && Number.isFinite(record.conversationCount) ? Math.max(0, Math.floor(record.conversationCount)) : createdPaths.length + updatedPaths.length;
	const createdCount = typeof record.createdCount === "number" && Number.isFinite(record.createdCount) ? Math.max(0, Math.floor(record.createdCount)) : createdPaths.length;
	const updatedCount = typeof record.updatedCount === "number" && Number.isFinite(record.updatedCount) ? Math.max(0, Math.floor(record.updatedCount)) : updatedPaths.length;
	const skippedCount = typeof record.skippedCount === "number" && Number.isFinite(record.skippedCount) ? Math.max(0, Math.floor(record.skippedCount)) : Math.max(0, conversationCount - createdCount - updatedCount);
	const rolledBackAt = typeof record.rolledBackAt === "string" && record.rolledBackAt.trim().length > 0 ? record.rolledBackAt.trim() : void 0;
	return {
		runId,
		importType,
		appliedAt,
		exportPath,
		sourcePath,
		conversationCount,
		createdCount,
		updatedCount,
		skippedCount,
		status: rolledBackAt ? "rolled_back" : "applied",
		...rolledBackAt ? { rolledBackAt } : {},
		pagePaths,
		samplePaths: pagePaths.slice(0, 5)
	};
}
function resolveImportRunsDir(vaultRoot) {
	return path.join(vaultRoot, ".openclaw-wiki", "import-runs");
}
async function listMemoryWikiImportRuns(config, options) {
	const limit = Math.max(1, Math.floor(options?.limit ?? 10));
	const importRunsDir = resolveImportRunsDir(config.vault.path);
	const entries = await fs$1.readdir(importRunsDir, { withFileTypes: true }).catch((error) => {
		if (error?.code === "ENOENT") return [];
		throw error;
	});
	const runs = (await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
		const raw = await fs$1.readFile(path.join(importRunsDir, entry.name), "utf8");
		return normalizeImportRunSummary(JSON.parse(raw));
	}))).filter((entry) => entry !== null).toSorted((left, right) => right.appliedAt.localeCompare(left.appliedAt));
	return {
		runs: runs.slice(0, limit),
		totalRuns: runs.length,
		activeRuns: runs.filter((entry) => entry.status === "applied").length,
		rolledBackRuns: runs.filter((entry) => entry.status === "rolled_back").length
	};
}
//#endregion
//#region extensions/memory-wiki/src/memory-palace.ts
const PALACE_KIND_ORDER = [
	"synthesis",
	"entity",
	"concept",
	"source",
	"report"
];
const PRIMARY_PALACE_KINDS = new Set([
	"synthesis",
	"entity",
	"concept"
]);
const PALACE_KIND_LABELS = {
	synthesis: "Syntheses",
	entity: "Entities",
	concept: "Concepts",
	source: "Sources",
	report: "Reports"
};
function normalizeTimestamp(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function extractSnippet(body) {
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("```") || line.startsWith("<!--") || line.startsWith("- ") || line.startsWith("* ")) continue;
		return line;
	}
}
function comparePalaceItems(left, right) {
	const leftKey = left.updatedAt ?? "";
	const rightKey = right.updatedAt ?? "";
	if (rightKey !== leftKey) return rightKey.localeCompare(leftKey);
	if (right.claimCount !== left.claimCount) return right.claimCount - left.claimCount;
	return left.title.localeCompare(right.title);
}
async function listMemoryWikiPalace(config) {
	const items = (await readQueryableWikiPages(config.vault.path)).map((page) => {
		const parsed = parseWikiMarkdown(page.raw);
		return Object.assign({
			pagePath: page.relativePath,
			title: page.title,
			kind: page.kind
		}, page.id ? { id: page.id } : {}, normalizeTimestamp(page.updatedAt) ? { updatedAt: normalizeTimestamp(page.updatedAt) } : {}, typeof page.sourceType === `string` && page.sourceType.trim().length > 0 ? { sourceType: page.sourceType.trim() } : {}, {
			claimCount: page.claims.length,
			questionCount: page.questions.length,
			contradictionCount: page.contradictions.length,
			claims: page.claims.map((claim) => claim.text).slice(0, 3),
			questions: page.questions.slice(0, 3),
			contradictions: page.contradictions.slice(0, 3)
		}, extractSnippet(parsed.body) ? { snippet: extractSnippet(parsed.body) } : {});
	}).filter((item) => PRIMARY_PALACE_KINDS.has(item.kind) || item.claimCount > 0 || item.questionCount > 0 || item.contradictionCount > 0).toSorted(comparePalaceItems);
	const clusters = PALACE_KIND_ORDER.map((kind) => {
		const clusterItems = items.filter((item) => item.kind === kind);
		if (clusterItems.length === 0) return null;
		return Object.assign({
			key: kind,
			label: PALACE_KIND_LABELS[kind],
			itemCount: clusterItems.length,
			claimCount: clusterItems.reduce((sum, item) => sum + item.claimCount, 0),
			questionCount: clusterItems.reduce((sum, item) => sum + item.questionCount, 0),
			contradictionCount: clusterItems.reduce((sum, item) => sum + item.contradictionCount, 0)
		}, clusterItems[0]?.updatedAt ? { updatedAt: clusterItems[0].updatedAt } : {}, { items: clusterItems });
	}).filter((entry) => entry !== null);
	return {
		totalItems: items.length,
		totalClaims: items.reduce((sum, item) => sum + item.claimCount, 0),
		totalQuestions: items.reduce((sum, item) => sum + item.questionCount, 0),
		totalContradictions: items.reduce((sum, item) => sum + item.contradictionCount, 0),
		clusters
	};
}
//#endregion
//#region extensions/memory-wiki/src/gateway.ts
const READ_SCOPE = "operator.read";
const WRITE_SCOPE = "operator.write";
const LOCAL_FILE_INGEST_SCOPE = "operator.admin";
function readStringParam(params, key, options) {
	const value = params[key];
	if (typeof value === "string" && value.trim()) return value.trim();
	if (options?.required) throw new Error(`${key} is required.`);
}
function readNumberParam(params, key) {
	const value = params[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
}
function readEnumParam(params, key, allowed) {
	const value = readStringParam(params, key);
	if (!value) return;
	if (allowed.includes(value)) return value;
	throw new Error(`${key} must be one of: ${allowed.join(", ")}.`);
}
function respondError(respond, error) {
	respond(false, void 0, {
		code: "internal_error",
		message: formatErrorMessage(error)
	});
}
function resolveGatewayAgentId(requestParams, appConfig) {
	return readStringParam(requestParams, "agentId") ?? (appConfig ? resolveDefaultAgentId(appConfig) : void 0);
}
async function syncImportedSourcesIfNeeded$1(config, appConfig) {
	await syncMemoryWikiImportedSources({
		config,
		appConfig
	});
}
function registerMemoryWikiGatewayMethods(params) {
	const { api, config, appConfig } = params;
	api.registerGatewayMethod("wiki.status", async ({ respond }) => {
		try {
			await syncImportedSourcesIfNeeded$1(config, appConfig);
			respond(true, await resolveMemoryWikiStatus(config, { appConfig }));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: READ_SCOPE });
	api.registerGatewayMethod("wiki.importRuns", async ({ params: requestParams, respond }) => {
		try {
			const limit = readNumberParam(requestParams, "limit");
			respond(true, await listMemoryWikiImportRuns(config, limit !== void 0 ? { limit } : {}));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: READ_SCOPE });
	api.registerGatewayMethod("wiki.importInsights", async ({ respond }) => {
		try {
			await syncImportedSourcesIfNeeded$1(config, appConfig);
			respond(true, await listMemoryWikiImportInsights(config));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: READ_SCOPE });
	api.registerGatewayMethod("wiki.palace", async ({ respond }) => {
		try {
			await syncImportedSourcesIfNeeded$1(config, appConfig);
			respond(true, await listMemoryWikiPalace(config));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: READ_SCOPE });
	api.registerGatewayMethod("wiki.init", async ({ respond }) => {
		try {
			respond(true, await initializeMemoryWikiVault(config));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: WRITE_SCOPE });
	api.registerGatewayMethod("wiki.doctor", async ({ respond }) => {
		try {
			await syncImportedSourcesIfNeeded$1(config, appConfig);
			respond(true, buildMemoryWikiDoctorReport(await resolveMemoryWikiStatus(config, { appConfig })));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: READ_SCOPE });
	api.registerGatewayMethod("wiki.compile", async ({ respond }) => {
		try {
			await syncImportedSourcesIfNeeded$1(config, appConfig);
			respond(true, await compileMemoryWikiVault(config));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: WRITE_SCOPE });
	api.registerGatewayMethod("wiki.ingest", async ({ params: requestParams, respond }) => {
		try {
			const inputPath = readStringParam(requestParams, "inputPath", { required: true });
			const title = readStringParam(requestParams, "title");
			respond(true, await ingestMemoryWikiSource({
				config,
				inputPath,
				...title ? { title } : {}
			}));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: LOCAL_FILE_INGEST_SCOPE });
	api.registerGatewayMethod("wiki.lint", async ({ respond }) => {
		try {
			await syncImportedSourcesIfNeeded$1(config, appConfig);
			respond(true, await lintMemoryWikiVault(config));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: WRITE_SCOPE });
	api.registerGatewayMethod("wiki.bridge.import", async ({ respond }) => {
		try {
			respond(true, await syncMemoryWikiImportedSources({
				config: {
					...config,
					vaultMode: "bridge"
				},
				appConfig
			}));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: WRITE_SCOPE });
	api.registerGatewayMethod("wiki.unsafeLocal.import", async ({ respond }) => {
		try {
			respond(true, await syncMemoryWikiImportedSources({
				config: {
					...config,
					vaultMode: "unsafe-local"
				},
				appConfig
			}));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: WRITE_SCOPE });
	api.registerGatewayMethod("wiki.search", async ({ params: requestParams, respond }) => {
		try {
			await syncImportedSourcesIfNeeded$1(config, appConfig);
			const query = readStringParam(requestParams, "query", { required: true });
			const maxResults = readNumberParam(requestParams, "maxResults");
			const searchBackend = readEnumParam(requestParams, "backend", WIKI_SEARCH_BACKENDS);
			const searchCorpus = readEnumParam(requestParams, "corpus", WIKI_SEARCH_CORPORA);
			const mode = readEnumParam(requestParams, "mode", WIKI_SEARCH_MODES);
			const agentId = resolveGatewayAgentId(requestParams, appConfig);
			respond(true, await searchMemoryWiki({
				config,
				appConfig,
				...agentId ? { agentId } : {},
				query,
				maxResults,
				searchBackend,
				searchCorpus,
				mode
			}));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: READ_SCOPE });
	api.registerGatewayMethod("wiki.apply", async ({ params: requestParams, respond }) => {
		try {
			await syncImportedSourcesIfNeeded$1(config, appConfig);
			respond(true, await applyMemoryWikiMutation({
				config,
				mutation: normalizeMemoryWikiMutationInput(requestParams)
			}));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: WRITE_SCOPE });
	api.registerGatewayMethod("wiki.get", async ({ params: requestParams, respond }) => {
		try {
			await syncImportedSourcesIfNeeded$1(config, appConfig);
			const lookup = readStringParam(requestParams, "lookup", { required: true });
			const fromLine = readNumberParam(requestParams, "fromLine");
			const lineCount = readNumberParam(requestParams, "lineCount");
			const searchBackend = readEnumParam(requestParams, "backend", WIKI_SEARCH_BACKENDS);
			const searchCorpus = readEnumParam(requestParams, "corpus", WIKI_SEARCH_CORPORA);
			const agentId = resolveGatewayAgentId(requestParams, appConfig);
			respond(true, await getMemoryWikiPage({
				config,
				appConfig,
				...agentId ? { agentId } : {},
				lookup,
				fromLine,
				lineCount,
				searchBackend,
				searchCorpus
			}));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: READ_SCOPE });
	api.registerGatewayMethod("wiki.obsidian.status", async ({ respond }) => {
		try {
			respond(true, await probeObsidianCli());
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: READ_SCOPE });
	api.registerGatewayMethod("wiki.obsidian.search", async ({ params: requestParams, respond }) => {
		try {
			respond(true, await runObsidianSearch({
				config,
				query: readStringParam(requestParams, "query", { required: true })
			}));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: WRITE_SCOPE });
	api.registerGatewayMethod("wiki.obsidian.open", async ({ params: requestParams, respond }) => {
		try {
			respond(true, await runObsidianOpen({
				config,
				vaultPath: readStringParam(requestParams, "path", { required: true })
			}));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: WRITE_SCOPE });
	api.registerGatewayMethod("wiki.obsidian.command", async ({ params: requestParams, respond }) => {
		try {
			respond(true, await runObsidianCommand({
				config,
				id: readStringParam(requestParams, "id", { required: true })
			}));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: WRITE_SCOPE });
	api.registerGatewayMethod("wiki.obsidian.daily", async ({ respond }) => {
		try {
			respond(true, await runObsidianDaily({ config }));
		} catch (error) {
			respondError(respond, error);
		}
	}, { scope: WRITE_SCOPE });
}
//#endregion
//#region extensions/memory-wiki/src/prompt-section.ts
const AGENT_DIGEST_PATH = ".openclaw-wiki/cache/agent-digest.json";
const DIGEST_MAX_PAGES = 4;
const DIGEST_MAX_CLAIMS_PER_PAGE = 2;
function tryReadPromptDigest(config) {
	const digestPath = path.join(config.vault.path, AGENT_DIGEST_PATH);
	try {
		const raw = fs.readFileSync(digestPath, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}
function rankPromptDigestPage(page) {
	return (page.contradictions?.length ?? 0) * 6 + (page.questions?.length ?? 0) * 4 + Math.min(page.claimCount ?? 0, 6) * 2 + Math.min(page.topClaims?.length ?? 0, 3);
}
function rankPromptClaimFreshness(level) {
	switch (level) {
		case "fresh": return 3;
		case "aging": return 2;
		case "stale": return 1;
		default: return 0;
	}
}
function sortPromptClaims(claims) {
	return [...claims].toSorted((left, right) => {
		const leftConfidence = typeof left.confidence === "number" ? left.confidence : -1;
		const rightConfidence = typeof right.confidence === "number" ? right.confidence : -1;
		if (leftConfidence !== rightConfidence) return rightConfidence - leftConfidence;
		const leftFreshness = rankPromptClaimFreshness(left.freshnessLevel);
		const rightFreshness = rankPromptClaimFreshness(right.freshnessLevel);
		if (leftFreshness !== rightFreshness) return rightFreshness - leftFreshness;
		return left.text.localeCompare(right.text);
	});
}
function formatPromptClaim(claim) {
	const qualifiers = [
		claim.status?.trim() ? `status ${claim.status.trim()}` : null,
		typeof claim.confidence === "number" ? `confidence ${claim.confidence.toFixed(2)}` : null,
		claim.freshnessLevel?.trim() ? `freshness ${claim.freshnessLevel.trim()}` : null
	].filter(Boolean);
	if (qualifiers.length === 0) return claim.text;
	return `${claim.text} (${qualifiers.join(", ")})`;
}
function buildDigestPromptSection(config) {
	if (!config.context.includeCompiledDigestPrompt) return [];
	const digest = tryReadPromptDigest(config);
	if (!digest?.pages?.length) return [];
	const selectedPages = [...digest.pages].filter((page) => (page.claimCount ?? 0) > 0 || (page.questions?.length ?? 0) > 0 || (page.contradictions?.length ?? 0) > 0).toSorted((left, right) => {
		const leftScore = rankPromptDigestPage(left);
		const rightScore = rankPromptDigestPage(right);
		if (leftScore !== rightScore) return rightScore - leftScore;
		return left.title.localeCompare(right.title);
	}).slice(0, DIGEST_MAX_PAGES);
	if (selectedPages.length === 0) return [];
	const lines = ["## Compiled Wiki Snapshot", `Compiled wiki currently tracks ${digest.claimCount ?? 0} claims across ${selectedPages.length} high-signal pages.`];
	if (Array.isArray(digest.contradictionClusters)) lines.push(`Contradiction clusters: ${digest.contradictionClusters.length}.`);
	for (const page of selectedPages) {
		const details = [
			page.kind,
			`${page.claimCount} claims`,
			(page.questions?.length ?? 0) > 0 ? `${page.questions?.length} open questions` : null,
			(page.contradictions?.length ?? 0) > 0 ? `${page.contradictions?.length} contradiction notes` : null
		].filter(Boolean);
		lines.push(`- ${page.title}: ${details.join(", ")}`);
		for (const claim of sortPromptClaims(page.topClaims ?? []).slice(0, DIGEST_MAX_CLAIMS_PER_PAGE)) lines.push(`  - ${formatPromptClaim(claim)}`);
	}
	lines.push("");
	return lines;
}
function buildWikiToolGuidance(availableTools) {
	const hasMemorySearch = availableTools.has("memory_search");
	const hasMemoryGet = availableTools.has("memory_get");
	const hasWikiSearch = availableTools.has("wiki_search");
	const hasWikiGet = availableTools.has("wiki_get");
	const hasWikiApply = availableTools.has("wiki_apply");
	const hasWikiLint = availableTools.has("wiki_lint");
	if (!hasMemorySearch && !hasMemoryGet && !hasWikiSearch && !hasWikiGet && !hasWikiApply && !hasWikiLint) return [];
	const lines = ["## Compiled Wiki", "Use the wiki when the answer depends on accumulated project knowledge, prior syntheses, entity pages, or source-backed notes that should survive beyond one conversation."];
	if (hasMemorySearch) lines.push("Prefer `memory_search` with `corpus=all` for one recall pass across durable memory and the compiled wiki when both are relevant.");
	if (hasMemoryGet) lines.push("Use `memory_get` with `corpus=wiki` or `corpus=all` when you already know the page path and want a small excerpt without leaving the shared memory tool flow.");
	if (hasWikiSearch && hasWikiGet) lines.push("Workflow: `wiki_search` first, then `wiki_get` for the exact page or imported memory file you need. Use this when you want wiki-specific ranking or provenance details instead of the broader shared memory flow.");
	else if (hasWikiSearch) lines.push("Use `wiki_search` before answering from stored knowledge when you want wiki-specific ranking or provenance details.");
	else if (hasWikiGet) lines.push("Use `wiki_get` to inspect specific wiki pages or imported memory files by path/id.");
	if (hasWikiApply) lines.push("Use `wiki_apply` for narrow synthesis filing and metadata repair instead of rewriting managed markdown blocks by hand.");
	if (hasWikiLint) lines.push("After meaningful wiki updates, run `wiki_lint` before trusting the vault.");
	lines.push("");
	return lines;
}
function createWikiPromptSectionBuilder(config) {
	return ({ availableTools }) => {
		const digestLines = buildDigestPromptSection(config);
		const toolGuidance = buildWikiToolGuidance(availableTools);
		if (digestLines.length === 0 && toolGuidance.length === 0) return [];
		return [...toolGuidance, ...digestLines];
	};
}
//#endregion
//#region extensions/memory-wiki/src/tool.ts
function formatWikiToolReportPath(config, reportPath) {
	const vaultRoot = path.resolve(config.vault.path);
	const resolvedReportPath = path.resolve(reportPath);
	const relativeReportPath = path.relative(vaultRoot, resolvedReportPath);
	if (!relativeReportPath || relativeReportPath.startsWith("..") || path.isAbsolute(relativeReportPath)) return reportPath;
	return relativeReportPath.replace(/\\/g, "/");
}
const WikiStatusSchema = Type.Object({}, { additionalProperties: false });
const WikiLintSchema = Type.Object({}, { additionalProperties: false });
const WikiSearchBackendSchema = Type.Union(WIKI_SEARCH_BACKENDS.map((value) => Type.Literal(value)));
const WikiSearchCorpusSchema = Type.Union(WIKI_SEARCH_CORPORA.map((value) => Type.Literal(value)));
const WikiSearchModeSchema = Type.Union(WIKI_SEARCH_MODES.map((value) => Type.Literal(value)));
const WikiSearchSchema = Type.Object({
	query: Type.String({ minLength: 1 }),
	maxResults: Type.Optional(Type.Number({ minimum: 1 })),
	backend: Type.Optional(WikiSearchBackendSchema),
	corpus: Type.Optional(WikiSearchCorpusSchema),
	mode: Type.Optional(WikiSearchModeSchema)
}, { additionalProperties: false });
const WikiGetSchema = Type.Object({
	lookup: Type.String({ minLength: 1 }),
	fromLine: Type.Optional(Type.Number({ minimum: 1 })),
	lineCount: Type.Optional(Type.Number({ minimum: 1 })),
	backend: Type.Optional(WikiSearchBackendSchema),
	corpus: Type.Optional(WikiSearchCorpusSchema)
}, { additionalProperties: false });
const WikiClaimEvidenceSchema = Type.Object({
	kind: Type.Optional(Type.String({ minLength: 1 })),
	sourceId: Type.Optional(Type.String({ minLength: 1 })),
	path: Type.Optional(Type.String({ minLength: 1 })),
	lines: Type.Optional(Type.String({ minLength: 1 })),
	weight: Type.Optional(Type.Number({ minimum: 0 })),
	note: Type.Optional(Type.String({ minLength: 1 })),
	confidence: Type.Optional(Type.Number({
		minimum: 0,
		maximum: 1
	})),
	privacyTier: Type.Optional(Type.String({ minLength: 1 })),
	updatedAt: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });
const WikiClaimSchema = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1 })),
	text: Type.String({ minLength: 1 }),
	status: Type.Optional(Type.String({ minLength: 1 })),
	confidence: Type.Optional(Type.Number({
		minimum: 0,
		maximum: 1
	})),
	evidence: Type.Optional(Type.Array(WikiClaimEvidenceSchema)),
	updatedAt: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });
const WikiApplySchema = Type.Object({
	op: Type.Union([Type.Literal("create_synthesis"), Type.Literal("update_metadata")]),
	title: Type.Optional(Type.String({ minLength: 1 })),
	body: Type.Optional(Type.String({ minLength: 1 })),
	lookup: Type.Optional(Type.String({ minLength: 1 })),
	sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	claims: Type.Optional(Type.Array(WikiClaimSchema)),
	contradictions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	questions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	confidence: Type.Optional(Type.Union([Type.Number({
		minimum: 0,
		maximum: 1
	}), Type.Null()])),
	status: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });
async function syncImportedSourcesIfNeeded(config, appConfig) {
	await syncMemoryWikiImportedSources({
		config,
		appConfig
	});
}
function createWikiStatusTool(config, appConfig) {
	return {
		name: "wiki_status",
		label: "Wiki Status",
		description: "Inspect the current memory wiki vault mode, health, and Obsidian CLI availability.",
		parameters: WikiStatusSchema,
		execute: async () => {
			await syncImportedSourcesIfNeeded(config, appConfig);
			const status = await resolveMemoryWikiStatus(config, { appConfig });
			return {
				content: [{
					type: "text",
					text: renderMemoryWikiStatus(status)
				}],
				details: status
			};
		}
	};
}
function createWikiSearchTool(config, appConfig, memoryContext = {}) {
	return {
		name: "wiki_search",
		label: "Wiki Search",
		description: "Search wiki pages and, when shared search is enabled, the active memory corpus by title, path, id, or body text.",
		parameters: WikiSearchSchema,
		execute: async (_toolCallId, rawParams) => {
			const params = rawParams;
			await syncImportedSourcesIfNeeded(config, appConfig);
			const results = await searchMemoryWiki({
				config,
				appConfig,
				agentId: memoryContext.agentId,
				agentSessionKey: memoryContext.agentSessionKey,
				sandboxed: memoryContext.sandboxed,
				query: params.query,
				maxResults: params.maxResults,
				...params.backend ? { searchBackend: params.backend } : {},
				...params.corpus ? { searchCorpus: params.corpus } : {},
				...params.mode ? { mode: params.mode } : {}
			});
			return {
				content: [{
					type: "text",
					text: results.length === 0 ? "No wiki or memory results." : results.map((result, index) => `${index + 1}. ${result.title} (${result.corpus}/${result.kind})\nPath: ${result.path}${typeof result.startLine === "number" && typeof result.endLine === "number" ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${result.provenanceLabel}` : ""}${result.matchedClaimId ? `\nClaim: ${result.matchedClaimId}` : ""}${result.evidenceKinds && result.evidenceKinds.length > 0 ? `\nEvidence: ${result.evidenceKinds.join(", ")}` : ""}\nSnippet: ${result.snippet}`).join("\n\n")
				}],
				details: { results }
			};
		}
	};
}
function createWikiLintTool(config, appConfig) {
	return {
		name: "wiki_lint",
		label: "Wiki Lint",
		description: "Lint the wiki vault and surface structural issues, provenance gaps, contradictions, and open questions.",
		parameters: WikiLintSchema,
		execute: async () => {
			await syncImportedSourcesIfNeeded(config, appConfig);
			const result = await lintMemoryWikiVault(config);
			const contradictions = result.issuesByCategory.contradictions.length;
			const openQuestions = result.issuesByCategory["open-questions"].length;
			const provenance = result.issuesByCategory.provenance.length;
			const errors = result.issues.filter((issue) => issue.severity === "error").length;
			const warnings = result.issues.filter((issue) => issue.severity === "warning").length;
			const reportPath = formatWikiToolReportPath(config, result.reportPath);
			return {
				content: [{
					type: "text",
					text: result.issueCount === 0 ? "No wiki lint issues." : [
						`Issues: ${result.issueCount} total (${errors} errors, ${warnings} warnings)`,
						`Contradictions: ${contradictions}`,
						`Open questions: ${openQuestions}`,
						`Provenance gaps: ${provenance}`,
						`Report: ${reportPath}`
					].join("\n")
				}],
				details: {
					issueCount: result.issueCount,
					issues: result.issues,
					issuesByCategory: result.issuesByCategory,
					reportPath
				}
			};
		}
	};
}
function createWikiApplyTool(config, appConfig) {
	return {
		name: "wiki_apply",
		label: "Wiki Apply",
		description: "Apply narrow wiki mutations for syntheses and page metadata without freeform markdown surgery.",
		parameters: WikiApplySchema,
		execute: async (_toolCallId, rawParams) => {
			const mutation = normalizeMemoryWikiMutationInput(rawParams);
			await syncImportedSourcesIfNeeded(config, appConfig);
			const result = await applyMemoryWikiMutation({
				config,
				mutation
			});
			const action = result.changed ? "Updated" : "No changes for";
			const compileSummary = result.compile.updatedFiles.length > 0 ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.` : "Indexes unchanged.";
			return {
				content: [{
					type: "text",
					text: `${action} ${result.pagePath} via ${result.operation}. ${compileSummary}`
				}],
				details: result
			};
		}
	};
}
function createWikiGetTool(config, appConfig, memoryContext = {}) {
	return {
		name: "wiki_get",
		label: "Wiki Get",
		description: "Read a wiki page by id or relative path, or fall back to the active memory corpus when shared search is enabled.",
		parameters: WikiGetSchema,
		execute: async (_toolCallId, rawParams) => {
			const params = rawParams;
			await syncImportedSourcesIfNeeded(config, appConfig);
			const result = await getMemoryWikiPage({
				config,
				appConfig,
				agentId: memoryContext.agentId,
				agentSessionKey: memoryContext.agentSessionKey,
				sandboxed: memoryContext.sandboxed,
				lookup: params.lookup,
				fromLine: params.fromLine,
				lineCount: params.lineCount,
				...params.backend ? { searchBackend: params.backend } : {},
				...params.corpus ? { searchCorpus: params.corpus } : {}
			});
			if (!result) return {
				content: [{
					type: "text",
					text: `Wiki page not found: ${params.lookup}`
				}],
				details: { found: false }
			};
			return {
				content: [{
					type: "text",
					text: result.content
				}],
				details: {
					found: true,
					...result
				}
			};
		}
	};
}
//#endregion
//#region extensions/memory-wiki/index.ts
var memory_wiki_default = definePluginEntry({
	id: "memory-wiki",
	name: "Memory Wiki",
	description: "Persistent wiki compiler and Obsidian-friendly knowledge vault for OpenClaw.",
	configSchema: memoryWikiConfigSchema,
	register(api) {
		const config = resolveMemoryWikiConfig(api.pluginConfig);
		api.registerMemoryPromptSupplement(createWikiPromptSectionBuilder(config));
		api.registerMemoryCorpusSupplement(createWikiCorpusSupplement({
			config,
			appConfig: api.config
		}));
		registerMemoryWikiGatewayMethods({
			api,
			config,
			appConfig: api.config
		});
		api.registerTool(createWikiStatusTool(config, api.config), { name: "wiki_status" });
		api.registerTool(createWikiLintTool(config, api.config), { name: "wiki_lint" });
		api.registerTool(createWikiApplyTool(config, api.config), { name: "wiki_apply" });
		api.registerTool((ctx) => createWikiSearchTool(config, api.config, {
			agentId: ctx.agentId,
			agentSessionKey: ctx.sessionKey,
			sandboxed: ctx.sandboxed
		}), { name: "wiki_search" });
		api.registerTool((ctx) => createWikiGetTool(config, api.config, {
			agentId: ctx.agentId,
			agentSessionKey: ctx.sessionKey,
			sandboxed: ctx.sandboxed
		}), { name: "wiki_get" });
		api.registerCli(({ program }) => {
			registerWikiCli(program, config, api.config);
		}, { descriptors: [{
			name: "wiki",
			description: "Inspect and initialize the memory wiki vault",
			hasSubcommands: true
		}] });
	}
});
//#endregion
export { memory_wiki_default as default };
