import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, r as lowercasePreservingWhitespace } from "./string-coerce-DyL154ka.js";
import { m as FsSafeError } from "./path-BlG8lhgR.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import { t as appendRegularFile } from "./regular-file-DaVeNX32.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { o as normalizeSingleOrTrimmedStringList } from "./string-normalization-DiPHgdft.js";
import { c as listActiveMemoryPublicArtifacts, r as getMemoryCapabilityRegistration } from "./memory-state-DKjCVvl8.js";
import { t as loadCombinedSessionStoreForGateway } from "./combined-store-gateway-NV2GSCR6.js";
import { i as writeJsonFileAtomically, n as readJsonFileWithFallback } from "./json-store-ChgPP2Sf.js";
import { o as resolveEffectiveSessionToolsVisibility, r as createSessionVisibilityGuard, t as createAgentToAgentPolicy } from "./session-visibility-DWz6M2DP.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./security-runtime-CcSekjBd.js";
import "./gateway-runtime-HxuTzDuS.js";
import { n as callGatewayFromCli } from "./gateway-rpc-COT1oBPJ.js";
import { r as resolveTranscriptStemToSessionKeys, t as extractTranscriptIdentityFromSessionsMemoryHit } from "./session-transcript-hit-nEFaYUz6.js";
import "./memory-host-core-BsjFNwCJ.js";
import { n as withTrailingNewline, t as replaceManagedMarkdownBlock } from "./memory-host-markdown-BiLGKFxW.js";
import { r as getActiveMemorySearchManager } from "./memory-host-search-nxwQAw_R.js";
import { d as resolveMemoryWikiConfig, o as WIKI_SEARCH_BACKENDS, s as WIKI_SEARCH_CORPORA } from "./config-B8Wtke0B.js";
import { constants } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import YAML from "yaml";
//#region extensions/memory-wiki/src/claim-health.ts
const DAY_MS = 1440 * 60 * 1e3;
const WIKI_STALE_DAYS = 90;
const CONTESTED_CLAIM_STATUSES = new Set([
	"contested",
	"contradicted",
	"refuted",
	"superseded"
]);
function parseTimestamp(value) {
	if (!value?.trim()) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function clampDaysSinceTouch(daysSinceTouch) {
	return Math.max(0, daysSinceTouch);
}
function normalizeClaimTextKey(text) {
	return normalizeLowercaseStringOrEmpty(text.replace(/\s+/g, " "));
}
function normalizeTextKey(text) {
	return normalizeLowercaseStringOrEmpty(text).replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").replace(/\s+/g, " ");
}
function buildFreshnessFromTimestamp(params) {
	const now = params.now ?? /* @__PURE__ */ new Date();
	const timestampMs = parseTimestamp(params.timestamp);
	if (timestampMs === null || !params.timestamp) return {
		level: "unknown",
		reason: "missing updatedAt"
	};
	const daysSinceTouch = clampDaysSinceTouch(Math.floor((now.getTime() - timestampMs) / DAY_MS));
	if (daysSinceTouch >= WIKI_STALE_DAYS) return {
		level: "stale",
		reason: `last touched ${params.timestamp}`,
		daysSinceTouch,
		lastTouchedAt: params.timestamp
	};
	if (daysSinceTouch >= 30) return {
		level: "aging",
		reason: `last touched ${params.timestamp}`,
		daysSinceTouch,
		lastTouchedAt: params.timestamp
	};
	return {
		level: "fresh",
		reason: `last touched ${params.timestamp}`,
		daysSinceTouch,
		lastTouchedAt: params.timestamp
	};
}
function resolveLatestTimestamp(candidates) {
	let bestValue;
	let bestMs = -1;
	for (const candidate of candidates) {
		const parsed = parseTimestamp(candidate);
		if (parsed === null || !candidate || parsed <= bestMs) continue;
		bestMs = parsed;
		bestValue = candidate;
	}
	return bestValue;
}
function normalizeClaimStatus(status) {
	return normalizeLowercaseStringOrEmpty(status) || "supported";
}
function isClaimContestedStatus(status) {
	return CONTESTED_CLAIM_STATUSES.has(normalizeClaimStatus(status));
}
function assessPageFreshness(page, now) {
	return buildFreshnessFromTimestamp({
		timestamp: page.updatedAt,
		now
	});
}
function assessClaimFreshness(params) {
	return buildFreshnessFromTimestamp({
		timestamp: resolveLatestTimestamp([
			params.claim.updatedAt,
			params.page.updatedAt,
			...params.claim.evidence.map((evidence) => evidence.updatedAt)
		]),
		now: params.now
	});
}
function buildWikiClaimHealth(params) {
	const claimId = params.claim.id?.trim();
	return {
		key: `${params.page.relativePath}#${claimId ?? `claim-${params.index + 1}`}`,
		pagePath: params.page.relativePath,
		pageTitle: params.page.title,
		...params.page.id ? { pageId: params.page.id } : {},
		...claimId ? { claimId } : {},
		text: params.claim.text,
		status: normalizeClaimStatus(params.claim.status),
		...typeof params.claim.confidence === "number" ? { confidence: params.claim.confidence } : {},
		evidenceCount: params.claim.evidence.length,
		missingEvidence: params.claim.evidence.length === 0,
		freshness: assessClaimFreshness({
			page: params.page,
			claim: params.claim,
			now: params.now
		})
	};
}
function collectWikiClaimHealth(pages, now) {
	return pages.flatMap((page) => page.claims.map((claim, index) => buildWikiClaimHealth({
		page,
		claim,
		index,
		now
	})));
}
function buildClaimContradictionClusters(params) {
	const claimHealth = collectWikiClaimHealth(params.pages, params.now);
	const byId = /* @__PURE__ */ new Map();
	for (const claim of claimHealth) {
		if (!claim.claimId) continue;
		const current = byId.get(claim.claimId) ?? [];
		current.push(claim);
		byId.set(claim.claimId, current);
	}
	return [...byId.entries()].flatMap(([claimId, entries]) => {
		if (entries.length < 2) return [];
		const distinctTexts = new Set(entries.map((entry) => normalizeClaimTextKey(entry.text)));
		const distinctStatuses = new Set(entries.map((entry) => entry.status));
		if (distinctTexts.size < 2 && distinctStatuses.size < 2) return [];
		return [{
			key: claimId,
			label: claimId,
			entries: [...entries].toSorted((left, right) => left.pagePath.localeCompare(right.pagePath))
		}];
	}).toSorted((left, right) => left.label.localeCompare(right.label));
}
function buildPageContradictionClusters(pages) {
	const byNote = /* @__PURE__ */ new Map();
	for (const page of pages) for (const note of page.contradictions) {
		const key = normalizeTextKey(note);
		if (!key) continue;
		const current = byNote.get(key) ?? [];
		current.push({
			pagePath: page.relativePath,
			pageTitle: page.title,
			...page.id ? { pageId: page.id } : {},
			note
		});
		byNote.set(key, current);
	}
	return [...byNote.entries()].map(([key, entries]) => ({
		key,
		label: entries[0]?.note ?? key,
		entries: [...entries].toSorted((left, right) => left.pagePath.localeCompare(right.pagePath))
	})).toSorted((left, right) => left.label.localeCompare(right.label));
}
//#endregion
//#region extensions/memory-wiki/src/log.ts
async function appendMemoryWikiLog(vaultRoot, entry) {
	const logPath = path.join(vaultRoot, ".openclaw-wiki", "log.jsonl");
	await fs$1.mkdir(path.dirname(logPath), { recursive: true });
	await appendRegularFile({
		filePath: logPath,
		content: `${JSON.stringify(entry)}\n`,
		rejectSymlinkParents: true
	});
}
//#endregion
//#region extensions/memory-wiki/src/markdown.ts
const WIKI_RELATED_START_MARKER = "<!-- openclaw:wiki:related:start -->";
const WIKI_RELATED_END_MARKER = "<!-- openclaw:wiki:related:end -->";
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/;
const OBSIDIAN_LINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(([^)]+)\)/g;
const RELATED_BLOCK_PATTERN$1 = new RegExp(`${WIKI_RELATED_START_MARKER}[\\s\\S]*?${WIKI_RELATED_END_MARKER}`, "g");
const MAX_WIKI_SEGMENT_BYTES = 240;
const MAX_WIKI_SAFE_WRITE_FILENAME_COMPONENT_BYTES = 255 - Buffer.byteLength(".00000000-0000-4000-8000-000000000000.fallback.tmp") - Buffer.byteLength(".");
const WIKI_SEGMENT_HASH_BYTES = 12;
function truncateUtf8CodePointSafe(value, maxBytes) {
	let result = "";
	let bytes = 0;
	for (const char of value) {
		const nextBytes = Buffer.byteLength(char);
		if (bytes + nextBytes > maxBytes) break;
		result += char;
		bytes += nextBytes;
	}
	return result;
}
function capWikiValueWithHash(raw, maxBytes, fallback) {
	if (Buffer.byteLength(raw) <= maxBytes) return raw;
	const suffix = createHash("sha1").update(raw).digest("hex").slice(0, WIKI_SEGMENT_HASH_BYTES);
	return `${truncateUtf8CodePointSafe(raw, maxBytes - Buffer.byteLength(`-${suffix}`)).replace(/-+$/g, "") || fallback}-${suffix}`;
}
function slugifyWikiSegment(raw) {
	const slug = normalizeLowercaseStringOrEmpty(raw).replace(/[^\p{L}\p{N}\p{M}]+/gu, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	if (!slug) return "page";
	return capWikiValueWithHash(slug, MAX_WIKI_SEGMENT_BYTES, "page");
}
function createWikiPageFilename(stem, extension = ".md") {
	const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
	return `${capWikiValueWithHash(stem, Math.max(1, MAX_WIKI_SAFE_WRITE_FILENAME_COMPONENT_BYTES - Buffer.byteLength(normalizedExtension)), "page")}${normalizedExtension}`;
}
function parseWikiMarkdown(content) {
	const match = content.match(FRONTMATTER_PATTERN);
	if (!match) return {
		frontmatter: {},
		body: content
	};
	const parsed = YAML.parse(match[1]);
	return {
		frontmatter: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
		body: content.slice(match[0].length)
	};
}
function renderWikiMarkdown(params) {
	return `---\n${YAML.stringify(params.frontmatter).trimEnd()}\n---\n\n${params.body.trimStart()}`;
}
function extractTitleFromMarkdown(body) {
	return normalizeOptionalString(body.match(/^#\s+(.+?)\s*$/m)?.[1]);
}
function normalizeSourceIds(value) {
	return normalizeSingleOrTrimmedStringList(value);
}
function normalizeWikiClaimEvidence(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value;
	const kind = normalizeOptionalString(record.kind);
	const sourceId = normalizeOptionalString(record.sourceId);
	const evidencePath = normalizeOptionalString(record.path);
	const lines = normalizeOptionalString(record.lines);
	const note = normalizeOptionalString(record.note);
	const updatedAt = normalizeOptionalString(record.updatedAt);
	const privacyTier = normalizeOptionalString(record.privacyTier);
	const weight = typeof record.weight === "number" && Number.isFinite(record.weight) ? record.weight : void 0;
	const confidence = normalizeOptionalNumber(record.confidence);
	if (!kind && !sourceId && !evidencePath && !lines && !note && weight === void 0 && confidence === void 0 && !privacyTier && !updatedAt) return null;
	return {
		...kind ? { kind } : {},
		...sourceId ? { sourceId } : {},
		...evidencePath ? { path: evidencePath } : {},
		...lines ? { lines } : {},
		...weight !== void 0 ? { weight } : {},
		...confidence !== void 0 ? { confidence } : {},
		...privacyTier ? { privacyTier } : {},
		...note ? { note } : {},
		...updatedAt ? { updatedAt } : {}
	};
}
function normalizeWikiClaims(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const record = entry;
		const text = normalizeOptionalString(record.text);
		if (!text) return [];
		const evidence = Array.isArray(record.evidence) ? record.evidence.flatMap((candidate) => {
			const normalized = normalizeWikiClaimEvidence(candidate);
			return normalized ? [normalized] : [];
		}) : [];
		const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence) ? record.confidence : void 0;
		return [{
			...normalizeOptionalString(record.id) ? { id: normalizeOptionalString(record.id) } : {},
			text,
			...normalizeOptionalString(record.status) ? { status: normalizeOptionalString(record.status) } : {},
			...confidence !== void 0 ? { confidence } : {},
			evidence,
			...normalizeOptionalString(record.updatedAt) ? { updatedAt: normalizeOptionalString(record.updatedAt) } : {}
		}];
	});
}
function normalizeOptionalNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function normalizeWikiPersonCard(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value;
	const card = {
		...normalizeOptionalString(record.canonicalId) ? { canonicalId: normalizeOptionalString(record.canonicalId) } : {},
		handles: normalizeSingleOrTrimmedStringList(record.handles),
		socials: normalizeSingleOrTrimmedStringList(record.socials),
		emails: normalizeSingleOrTrimmedStringList(record.emails ?? record.email),
		...normalizeOptionalString(record.timezone) ? { timezone: normalizeOptionalString(record.timezone) } : {},
		...normalizeOptionalString(record.lane) ? { lane: normalizeOptionalString(record.lane) } : {},
		askFor: normalizeSingleOrTrimmedStringList(record.askFor),
		avoidAskingFor: normalizeSingleOrTrimmedStringList(record.avoidAskingFor),
		bestUsedFor: normalizeSingleOrTrimmedStringList(record.bestUsedFor),
		notEnoughFor: normalizeSingleOrTrimmedStringList(record.notEnoughFor),
		...normalizeOptionalNumber(record.confidence) !== void 0 ? { confidence: normalizeOptionalNumber(record.confidence) } : {},
		...normalizeOptionalString(record.privacyTier) ? { privacyTier: normalizeOptionalString(record.privacyTier) } : {},
		...normalizeOptionalString(record.lastRefreshedAt) ? { lastRefreshedAt: normalizeOptionalString(record.lastRefreshedAt) } : {}
	};
	return Boolean(card.canonicalId || card.timezone || card.lane || card.privacyTier || card.lastRefreshedAt) || typeof card.confidence === "number" || card.handles.length > 0 || card.socials.length > 0 || card.emails.length > 0 || card.askFor.length > 0 || card.avoidAskingFor.length > 0 || card.bestUsedFor.length > 0 || card.notEnoughFor.length > 0 ? card : void 0;
}
function normalizeWikiRelationships(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const record = entry;
		const relationship = {
			...normalizeOptionalString(record.targetId) ? { targetId: normalizeOptionalString(record.targetId) } : {},
			...normalizeOptionalString(record.targetPath) ? { targetPath: normalizeOptionalString(record.targetPath) } : {},
			...normalizeOptionalString(record.targetTitle) ? { targetTitle: normalizeOptionalString(record.targetTitle) } : {},
			...normalizeOptionalString(record.kind) ? { kind: normalizeOptionalString(record.kind) } : {},
			...normalizeOptionalNumber(record.weight) !== void 0 ? { weight: normalizeOptionalNumber(record.weight) } : {},
			...normalizeOptionalNumber(record.confidence) !== void 0 ? { confidence: normalizeOptionalNumber(record.confidence) } : {},
			...normalizeOptionalString(record.evidenceKind) ? { evidenceKind: normalizeOptionalString(record.evidenceKind) } : {},
			...normalizeOptionalString(record.privacyTier) ? { privacyTier: normalizeOptionalString(record.privacyTier) } : {},
			...normalizeOptionalString(record.note) ? { note: normalizeOptionalString(record.note) } : {},
			...normalizeOptionalString(record.updatedAt) ? { updatedAt: normalizeOptionalString(record.updatedAt) } : {}
		};
		return Object.keys(relationship).length > 0 ? [relationship] : [];
	});
}
function extractWikiLinks(markdown) {
	const searchable = markdown.replace(RELATED_BLOCK_PATTERN$1, "");
	const links = [];
	for (const match of searchable.matchAll(OBSIDIAN_LINK_PATTERN)) {
		const target = match[1]?.trim();
		if (target) links.push(target);
	}
	for (const match of searchable.matchAll(MARKDOWN_LINK_PATTERN)) {
		const rawTarget = match[1]?.trim();
		if (!rawTarget || rawTarget.startsWith("#") || /^[a-z]+:/i.test(rawTarget)) continue;
		const target = rawTarget.split("#")[0]?.split("?")[0]?.replace(/\\/g, "/").trim();
		if (target) links.push(target);
	}
	return links;
}
function formatWikiLink(params) {
	const withoutExtension = params.relativePath.replace(/\.md$/i, "");
	return params.renderMode === "obsidian" ? `[[${withoutExtension}|${params.title}]]` : `[${params.title}](${params.relativePath})`;
}
function renderMarkdownFence(content, infoString = "text") {
	const fenceSize = Math.max(3, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length + 1));
	const fence = "`".repeat(fenceSize);
	return `${fence}${infoString}\n${content}\n${fence}`;
}
function inferWikiPageKind(relativePath) {
	const normalized = relativePath.split(path.sep).join("/");
	if (normalized.startsWith("entities/")) return "entity";
	if (normalized.startsWith("concepts/")) return "concept";
	if (normalized.startsWith("sources/")) return "source";
	if (normalized.startsWith("syntheses/")) return "synthesis";
	if (normalized.startsWith("reports/")) return "report";
	return null;
}
function toWikiPageSummary(params) {
	const kind = inferWikiPageKind(params.relativePath);
	if (!kind) return null;
	const parsed = parseWikiMarkdown(params.raw);
	const title = typeof parsed.frontmatter.title === "string" && parsed.frontmatter.title.trim() || extractTitleFromMarkdown(parsed.body) || path.basename(params.relativePath, ".md");
	return {
		absolutePath: params.absolutePath,
		relativePath: params.relativePath.split(path.sep).join("/"),
		kind,
		title,
		id: normalizeOptionalString(parsed.frontmatter.id),
		pageType: normalizeOptionalString(parsed.frontmatter.pageType),
		entityType: normalizeOptionalString(parsed.frontmatter.entityType),
		canonicalId: normalizeOptionalString(parsed.frontmatter.canonicalId),
		aliases: normalizeSingleOrTrimmedStringList(parsed.frontmatter.aliases),
		sourceIds: normalizeSourceIds(parsed.frontmatter.sourceIds),
		linkTargets: extractWikiLinks(params.raw),
		claims: normalizeWikiClaims(parsed.frontmatter.claims),
		contradictions: normalizeSingleOrTrimmedStringList(parsed.frontmatter.contradictions),
		questions: normalizeSingleOrTrimmedStringList(parsed.frontmatter.questions),
		confidence: typeof parsed.frontmatter.confidence === "number" && Number.isFinite(parsed.frontmatter.confidence) ? parsed.frontmatter.confidence : void 0,
		privacyTier: normalizeOptionalString(parsed.frontmatter.privacyTier),
		personCard: normalizeWikiPersonCard(parsed.frontmatter.personCard),
		relationships: normalizeWikiRelationships(parsed.frontmatter.relationships),
		bestUsedFor: normalizeSingleOrTrimmedStringList(parsed.frontmatter.bestUsedFor),
		notEnoughFor: normalizeSingleOrTrimmedStringList(parsed.frontmatter.notEnoughFor),
		sourceType: normalizeOptionalString(parsed.frontmatter.sourceType),
		provenanceMode: normalizeOptionalString(parsed.frontmatter.provenanceMode),
		sourcePath: normalizeOptionalString(parsed.frontmatter.sourcePath),
		bridgeRelativePath: normalizeOptionalString(parsed.frontmatter.bridgeRelativePath),
		bridgeWorkspaceDir: normalizeOptionalString(parsed.frontmatter.bridgeWorkspaceDir),
		unsafeLocalConfiguredPath: normalizeOptionalString(parsed.frontmatter.unsafeLocalConfiguredPath),
		unsafeLocalRelativePath: normalizeOptionalString(parsed.frontmatter.unsafeLocalRelativePath),
		lastRefreshedAt: normalizeOptionalString(parsed.frontmatter.lastRefreshedAt),
		updatedAt: normalizeOptionalString(parsed.frontmatter.updatedAt)
	};
}
//#endregion
//#region extensions/memory-wiki/src/vault.ts
const WIKI_VAULT_DIRECTORIES = [
	"entities",
	"concepts",
	"syntheses",
	"sources",
	"reports",
	"_attachments",
	"_views",
	".openclaw-wiki",
	".openclaw-wiki/locks",
	".openclaw-wiki/cache"
];
function buildIndexMarkdown() {
	return withTrailingNewline(replaceManagedMarkdownBlock({
		original: "# Wiki Index\n",
		heading: "## Generated",
		startMarker: "<!-- openclaw:wiki:index:start -->",
		endMarker: "<!-- openclaw:wiki:index:end -->",
		body: "- No compiled pages yet."
	}));
}
function buildAgentsMarkdown() {
	return withTrailingNewline(`\
# Memory Wiki Agent Guide

- Treat generated blocks as plugin-owned.
- Preserve human notes outside managed markers.
- Prefer source-backed claims over wiki-to-wiki citation loops.
- Prefer structured \`claims\` with evidence over burying key beliefs only in prose.
- Use \`.openclaw-wiki/cache/agent-digest.json\` and \`claims.jsonl\` for machine reads; markdown pages are the human view.
`);
}
function buildWikiOverviewMarkdown(config) {
	return withTrailingNewline(`\
# Memory Wiki

This vault is maintained by the OpenClaw memory-wiki plugin.

- Vault mode: \`${config.vaultMode}\`
- Render mode: \`${config.vault.renderMode}\`
- Search corpus default: \`${config.search.corpus}\`

## Architecture
- Raw sources remain the evidence layer.
- Wiki pages are the human-readable synthesis layer.
- \`.openclaw-wiki/cache/agent-digest.json\` is the agent-facing compiled digest.

## Notes
<!-- openclaw:human:start -->
<!-- openclaw:human:end -->
`);
}
async function writeFileIfMissing(rootDir, relativePath, content, createdFiles) {
	const root$6 = await root(rootDir);
	try {
		await root$6.create(relativePath, content);
	} catch (err) {
		if (err instanceof FsSafeError && err.code === "already-exists") return;
		throw err;
	}
	createdFiles.push(path.join(rootDir, relativePath));
}
async function initializeMemoryWikiVault(config, options) {
	const rootDir = config.vault.path;
	const createdDirectories = [];
	const createdFiles = [];
	if (!await pathExists(rootDir)) createdDirectories.push(rootDir);
	await fs$1.mkdir(rootDir, { recursive: true });
	for (const relativeDir of WIKI_VAULT_DIRECTORIES) {
		const fullPath = path.join(rootDir, relativeDir);
		if (!await pathExists(fullPath)) createdDirectories.push(fullPath);
		await fs$1.mkdir(fullPath, { recursive: true });
	}
	await writeFileIfMissing(rootDir, "AGENTS.md", buildAgentsMarkdown(), createdFiles);
	await writeFileIfMissing(rootDir, "WIKI.md", buildWikiOverviewMarkdown(config), createdFiles);
	await writeFileIfMissing(rootDir, "index.md", buildIndexMarkdown(), createdFiles);
	await writeFileIfMissing(rootDir, "inbox.md", withTrailingNewline("# Inbox\n\nDrop raw ideas, questions, and source links here.\n"), createdFiles);
	await writeFileIfMissing(rootDir, ".openclaw-wiki/state.json", withTrailingNewline(JSON.stringify({
		version: 1,
		createdAt: new Date(options?.nowMs ?? Date.now()).toISOString(),
		renderMode: config.vault.renderMode
	}, null, 2)), createdFiles);
	await writeFileIfMissing(rootDir, ".openclaw-wiki/log.jsonl", "", createdFiles);
	if (createdDirectories.length > 0 || createdFiles.length > 0) await appendMemoryWikiLog(rootDir, {
		type: "init",
		timestamp: new Date(options?.nowMs ?? Date.now()).toISOString(),
		details: {
			createdDirectories: createdDirectories.map((dir) => path.relative(rootDir, dir) || "."),
			createdFiles: createdFiles.map((file) => path.relative(rootDir, file))
		}
	});
	return {
		rootDir,
		created: createdDirectories.length > 0 || createdFiles.length > 0,
		createdDirectories,
		createdFiles
	};
}
//#endregion
//#region extensions/memory-wiki/src/compile.ts
const COMPILE_PAGE_GROUPS = [
	{
		kind: "source",
		dir: "sources",
		heading: "Sources"
	},
	{
		kind: "entity",
		dir: "entities",
		heading: "Entities"
	},
	{
		kind: "concept",
		dir: "concepts",
		heading: "Concepts"
	},
	{
		kind: "synthesis",
		dir: "syntheses",
		heading: "Syntheses"
	},
	{
		kind: "report",
		dir: "reports",
		heading: "Reports"
	}
];
const AGENT_DIGEST_PATH$1 = ".openclaw-wiki/cache/agent-digest.json";
const CLAIMS_DIGEST_PATH$1 = ".openclaw-wiki/cache/claims.jsonl";
const MAX_RELATED_PAGES_PER_SECTION = 12;
const MAX_SHARED_SOURCE_FANOUT = 24;
const DASHBOARD_PAGES = [
	{
		id: "report.open-questions",
		title: "Open Questions",
		relativePath: "reports/open-questions.md",
		buildBody: ({ config, pages }) => {
			const matches = pages.filter((page) => page.questions.length > 0);
			if (matches.length === 0) return "- No open questions right now.";
			return [
				`- Pages with open questions: ${matches.length}`,
				"",
				...matches.map((page) => `- ${formatWikiLink({
					renderMode: config.vault.renderMode,
					relativePath: page.relativePath,
					title: page.title
				})}: ${page.questions.join(" | ")}`)
			].join("\n");
		}
	},
	{
		id: "report.contradictions",
		title: "Contradictions",
		relativePath: "reports/contradictions.md",
		buildBody: ({ config, pages, now }) => {
			const pageClusters = buildPageContradictionClusters(pages);
			const claimClusters = buildClaimContradictionClusters({
				pages,
				now
			});
			if (pageClusters.length === 0 && claimClusters.length === 0) return "- No contradictions flagged right now.";
			const lines = [`- Contradiction note clusters: ${pageClusters.length}`, `- Competing claim clusters: ${claimClusters.length}`];
			if (pageClusters.length > 0) {
				lines.push("", "### Page Notes");
				for (const cluster of pageClusters) lines.push(formatPageContradictionClusterLine(config, cluster));
			}
			if (claimClusters.length > 0) {
				lines.push("", "### Claim Clusters");
				for (const cluster of claimClusters) lines.push(formatClaimContradictionClusterLine(config, cluster));
			}
			return lines.join("\n");
		}
	},
	{
		id: "report.low-confidence",
		title: "Low Confidence",
		relativePath: "reports/low-confidence.md",
		buildBody: ({ config, pages, now }) => {
			const pageMatches = pages.filter((page) => typeof page.confidence === "number" && page.confidence < .5).toSorted((left, right) => (left.confidence ?? 1) - (right.confidence ?? 1));
			const claimMatches = collectWikiClaimHealth(pages, now).filter((claim) => typeof claim.confidence === "number" && claim.confidence < .5).toSorted((left, right) => (left.confidence ?? 1) - (right.confidence ?? 1));
			if (pageMatches.length === 0 && claimMatches.length === 0) return "- No low-confidence pages or claims right now.";
			const lines = [`- Low-confidence pages: ${pageMatches.length}`, `- Low-confidence claims: ${claimMatches.length}`];
			if (pageMatches.length > 0) {
				lines.push("", "### Pages");
				for (const page of pageMatches) lines.push(`- ${formatPageLink(config, page)}: confidence ${(page.confidence ?? 0).toFixed(2)}`);
			}
			if (claimMatches.length > 0) {
				lines.push("", "### Claims");
				for (const claim of claimMatches) lines.push(`- ${formatClaimHealthLine(config, claim)}`);
			}
			return lines.join("\n");
		}
	},
	{
		id: "report.claim-health",
		title: "Claim Health",
		relativePath: "reports/claim-health.md",
		buildBody: ({ config, pages, now }) => {
			const claimHealth = collectWikiClaimHealth(pages, now);
			const missingEvidence = claimHealth.filter((claim) => claim.missingEvidence);
			const contestedClaims = claimHealth.filter((claim) => isClaimHealthContested(claim));
			const staleClaims = claimHealth.filter((claim) => claim.freshness.level === "stale" || claim.freshness.level === "unknown");
			if (missingEvidence.length === 0 && contestedClaims.length === 0 && staleClaims.length === 0) return "- No claim health issues right now.";
			const lines = [
				`- Claims missing evidence: ${missingEvidence.length}`,
				`- Contested claims: ${contestedClaims.length}`,
				`- Stale or unknown claims: ${staleClaims.length}`
			];
			if (missingEvidence.length > 0) {
				lines.push("", "### Missing Evidence");
				for (const claim of missingEvidence) lines.push(`- ${formatClaimHealthLine(config, claim)}`);
			}
			if (contestedClaims.length > 0) {
				lines.push("", "### Contested Claims");
				for (const claim of contestedClaims) lines.push(`- ${formatClaimHealthLine(config, claim)}`);
			}
			if (staleClaims.length > 0) {
				lines.push("", "### Stale Claims");
				for (const claim of staleClaims) lines.push(`- ${formatClaimHealthLine(config, claim)}`);
			}
			return lines.join("\n");
		}
	},
	{
		id: "report.stale-pages",
		title: "Stale Pages",
		relativePath: "reports/stale-pages.md",
		buildBody: ({ config, pages, now }) => {
			const matches = pages.filter((page) => page.kind !== "report").flatMap((page) => {
				const freshness = assessPageFreshness(page, now);
				if (freshness.level === "fresh") return [];
				return [{
					page,
					freshness
				}];
			}).toSorted((left, right) => left.page.title.localeCompare(right.page.title));
			if (matches.length === 0) return `- No aging or stale pages older than 30 days.`;
			return [
				`- Stale pages: ${matches.length}`,
				"",
				...matches.map(({ page, freshness }) => `- ${formatPageLink(config, page)}: ${formatFreshnessLabel(freshness)}`)
			].join("\n");
		}
	},
	{
		id: "report.person-agent-directory",
		title: "Person Agent Directory",
		relativePath: "reports/person-agent-directory.md",
		buildBody: ({ config, pages, now }) => {
			const matches = pages.filter((page) => page.kind !== "report" && isPersonLikePage(page)).toSorted((left, right) => left.title.localeCompare(right.title));
			if (matches.length === 0) return "- No person-like entity pages with agent cards yet.";
			const lines = [`- People with routing metadata: ${matches.length}`];
			for (const page of matches) {
				const freshness = assessPageFreshness(page, now);
				lines.push(`- ${formatPersonDirectoryLine(config, page, freshness)}`);
			}
			return lines.join("\n");
		}
	},
	{
		id: "report.relationship-graph",
		title: "Relationship Graph",
		relativePath: "reports/relationship-graph.md",
		buildBody: ({ config, pages }) => {
			const relationships = pages.flatMap((page) => page.relationships.map((relationship) => ({
				page,
				relationship
			}))).toSorted((left, right) => {
				const leftTitle = left.relationship.targetTitle ?? left.relationship.targetId ?? "";
				const rightTitle = right.relationship.targetTitle ?? right.relationship.targetId ?? "";
				return `${left.page.title} ${leftTitle}`.localeCompare(`${right.page.title} ${rightTitle}`);
			});
			if (relationships.length === 0) return "- No structured relationships yet.";
			return [
				`- Structured relationships: ${relationships.length}`,
				"",
				...relationships.map(({ page, relationship }) => `- ${formatRelationshipLine(config, page, relationship)}`)
			].join("\n");
		}
	},
	{
		id: "report.provenance-coverage",
		title: "Provenance Coverage",
		relativePath: "reports/provenance-coverage.md",
		buildBody: ({ config, pages }) => {
			const evidenceEntries = pages.flatMap((page) => page.claims.flatMap((claim) => claim.evidence.map((evidence) => ({
				page,
				claim,
				evidence
			}))));
			const missingEvidence = pages.flatMap((page) => page.claims.filter((claim) => claim.evidence.length === 0).map((claim) => ({
				page,
				claim
			})));
			if (evidenceEntries.length === 0 && missingEvidence.length === 0) return "- No structured claims with provenance coverage yet.";
			const kindCounts = countBy(evidenceEntries.map(({ evidence }) => evidence.kind ?? "unspecified"));
			const sourceCounts = countBy(evidenceEntries.map(({ evidence }) => evidence.sourceId ?? evidence.path ?? "inline"));
			const lines = [
				`- Evidence entries: ${evidenceEntries.length}`,
				`- Claims missing evidence: ${missingEvidence.length}`,
				"",
				"### Evidence Classes",
				...formatCountLines(kindCounts),
				"",
				"### Top Evidence Sources",
				...formatCountLines(sourceCounts).slice(0, 20)
			];
			if (missingEvidence.length > 0) {
				lines.push("", "### Missing Evidence");
				for (const { page, claim } of missingEvidence) lines.push(`- ${formatPageLink(config, page)}: ${formatClaimIdentityForPage(claim)}`);
			}
			return lines.join("\n");
		}
	},
	{
		id: "report.privacy-review",
		title: "Privacy Review",
		relativePath: "reports/privacy-review.md",
		buildBody: ({ config, pages }) => {
			const entries = collectPrivacyReviewEntries(config, pages);
			if (entries.length === 0) return "- No non-public privacy tiers flagged right now.";
			return [
				`- Privacy review entries: ${entries.length}`,
				"",
				...entries
			].join("\n");
		}
	}
];
async function collectMarkdownFiles(rootDir, relativeDir) {
	const dirPath = path.join(rootDir, relativeDir);
	return (await fs$1.readdir(dirPath, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => path.join(relativeDir, entry.name)).filter((relativePath) => path.basename(relativePath) !== "index.md").toSorted((left, right) => left.localeCompare(right));
}
async function readPageSummaries(rootDir) {
	const filePaths = (await Promise.all(COMPILE_PAGE_GROUPS.map((group) => collectMarkdownFiles(rootDir, group.dir)))).flat();
	return (await Promise.all(filePaths.map(async (relativePath) => {
		const absolutePath = path.join(rootDir, relativePath);
		return toWikiPageSummary({
			absolutePath,
			relativePath,
			raw: await fs$1.readFile(absolutePath, "utf8")
		});
	}))).flatMap((page) => page ? [page] : []).toSorted((left, right) => left.title.localeCompare(right.title));
}
function buildPageCounts(pages) {
	return {
		entity: pages.filter((page) => page.kind === "entity").length,
		concept: pages.filter((page) => page.kind === "concept").length,
		source: pages.filter((page) => page.kind === "source").length,
		synthesis: pages.filter((page) => page.kind === "synthesis").length,
		report: pages.filter((page) => page.kind === "report").length
	};
}
function formatPageLink(config, page) {
	return formatWikiLink({
		renderMode: config.vault.renderMode,
		relativePath: page.relativePath,
		title: page.title
	});
}
function formatFreshnessLabel(freshness) {
	switch (freshness.level) {
		case "fresh": return `fresh (${freshness.lastTouchedAt ?? "recent"})`;
		case "aging": return `aging (${freshness.lastTouchedAt ?? "unknown"})`;
		case "stale": return `stale (${freshness.lastTouchedAt ?? "unknown"})`;
		case "unknown": return freshness.reason;
	}
	throw new Error("Unsupported wiki freshness level");
}
function formatListPreview(values, maxItems = 3) {
	if (values.length === 0) return null;
	const shown = values.slice(0, maxItems).join(", ");
	return values.length > maxItems ? `${shown}, +${values.length - maxItems}` : shown;
}
function formatMaybeDetail(label, value) {
	return value ? `${label} ${value}` : null;
}
function isPersonLikePage(page) {
	const entityType = normalizeLowercaseStringOrEmpty(page.entityType);
	const pageType = normalizeLowercaseStringOrEmpty(page.pageType);
	return Boolean(page.personCard) || entityType === "person" || entityType === "maintainer" || pageType === "person" || pageType === "maintainer";
}
function formatPersonDirectoryLine(config, page, freshness) {
	const card = page.personCard;
	const details = [
		formatMaybeDetail("id", page.canonicalId ?? card?.canonicalId ?? page.id),
		formatMaybeDetail("aliases", formatListPreview(page.aliases)),
		formatMaybeDetail("handles", formatListPreview(card?.handles ?? [])),
		formatMaybeDetail("lane", card?.lane),
		formatMaybeDetail("ask", formatListPreview(card?.askFor ?? [])),
		formatMaybeDetail("best", formatListPreview([...page.bestUsedFor, ...card?.bestUsedFor ?? []])),
		formatMaybeDetail("privacy", page.privacyTier ?? card?.privacyTier),
		formatMaybeDetail("refreshed", page.lastRefreshedAt ?? card?.lastRefreshedAt),
		formatMaybeDetail("freshness", formatFreshnessLabel(freshness))
	].filter(Boolean);
	return `${formatPageLink(config, page)}${details.length > 0 ? `: ${details.join("; ")}` : ""}`;
}
function formatRelationshipTarget(config, relationship) {
	if (relationship.targetPath && relationship.targetTitle) return formatWikiLink({
		renderMode: config.vault.renderMode,
		relativePath: relationship.targetPath,
		title: relationship.targetTitle
	});
	return relationship.targetTitle ?? relationship.targetId ?? relationship.targetPath ?? "unknown";
}
function formatRelationshipLine(config, page, relationship) {
	const details = [
		relationship.kind ?? "related",
		typeof relationship.weight === "number" ? `weight ${relationship.weight.toFixed(2)}` : null,
		typeof relationship.confidence === "number" ? `confidence ${relationship.confidence.toFixed(2)}` : null,
		relationship.evidenceKind ? `evidence ${relationship.evidenceKind}` : null,
		relationship.privacyTier ? `privacy ${relationship.privacyTier}` : null,
		relationship.note
	].filter(Boolean);
	return `${formatPageLink(config, page)} -> ${formatRelationshipTarget(config, relationship)}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}
function countBy(values) {
	const counts = /* @__PURE__ */ new Map();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return counts;
}
function formatCountLines(counts) {
	const lines = [...counts].toSorted((left, right) => {
		if (left[1] !== right[1]) return right[1] - left[1];
		return left[0].localeCompare(right[0]);
	}).map(([label, count]) => `- ${label}: ${count}`);
	return lines.length > 0 ? lines : ["- None"];
}
function formatClaimIdentityForPage(claim) {
	return claim.id ? `\`${claim.id}\`: ${claim.text}` : claim.text;
}
function isReviewablePrivacyTier(value) {
	const tier = normalizeLowercaseStringOrEmpty(value);
	return tier !== "" && tier !== "public";
}
function formatEvidencePrivacyDetails(evidence) {
	return [
		evidence.kind ? `kind ${evidence.kind}` : null,
		evidence.sourceId ? `source ${evidence.sourceId}` : null,
		evidence.path ? `path ${evidence.path}` : null,
		evidence.lines ? `lines ${evidence.lines}` : null
	].filter(Boolean).join(", ");
}
function collectPrivacyReviewEntries(config, pages) {
	const entries = [];
	for (const page of pages) {
		if (isReviewablePrivacyTier(page.privacyTier)) entries.push(`- ${formatPageLink(config, page)}: page privacy ${page.privacyTier}`);
		if (isReviewablePrivacyTier(page.personCard?.privacyTier)) entries.push(`- ${formatPageLink(config, page)}: person card privacy ${page.personCard?.privacyTier}`);
		for (const relationship of page.relationships) if (isReviewablePrivacyTier(relationship.privacyTier)) entries.push(`- ${formatPageLink(config, page)}: relationship privacy ${relationship.privacyTier} -> ${formatRelationshipTarget(config, relationship)}`);
		for (const claim of page.claims) for (const evidence of claim.evidence) {
			if (!isReviewablePrivacyTier(evidence.privacyTier)) continue;
			const detail = formatEvidencePrivacyDetails(evidence);
			entries.push(`- ${formatPageLink(config, page)}: evidence privacy ${evidence.privacyTier} on ${formatClaimIdentityForPage(claim)}${detail ? ` (${detail})` : ""}`);
		}
	}
	return entries;
}
function formatClaimIdentity(claim) {
	return claim.claimId ? `\`${claim.claimId}\`: ${claim.text}` : claim.text;
}
function isClaimHealthContested(claim) {
	return isClaimContestedStatus(claim.status);
}
function formatClaimHealthLine(config, claim) {
	const details = [
		`status ${claim.status}`,
		typeof claim.confidence === "number" ? `confidence ${claim.confidence.toFixed(2)}` : null,
		claim.missingEvidence ? "missing evidence" : `${claim.evidenceCount} evidence`,
		formatFreshnessLabel(claim.freshness)
	].filter(Boolean);
	return `${formatWikiLink({
		renderMode: config.vault.renderMode,
		relativePath: claim.pagePath,
		title: claim.pageTitle
	})}: ${formatClaimIdentity(claim)} (${details.join(", ")})`;
}
function formatPageContradictionClusterLine(config, cluster) {
	const pageRefs = cluster.entries.map((entry) => formatWikiLink({
		renderMode: config.vault.renderMode,
		relativePath: entry.pagePath,
		title: entry.pageTitle
	}));
	return `- ${cluster.label}: ${pageRefs.join(" | ")}`;
}
function formatClaimContradictionClusterLine(config, cluster) {
	const entries = cluster.entries.map((entry) => `${formatWikiLink({
		renderMode: config.vault.renderMode,
		relativePath: entry.pagePath,
		title: entry.pageTitle
	})} -> ${formatClaimIdentity(entry)} (${entry.status}, ${formatFreshnessLabel(entry.freshness)})`);
	return `- \`${cluster.label}\`: ${entries.join(" | ")}`;
}
function normalizeComparableTarget(value) {
	return normalizeLowercaseStringOrEmpty(value.trim().replace(/\\/g, "/").replace(/\.md$/i, "").replace(/^\.\/+/, "").replace(/\/+$/, ""));
}
function uniquePages(pages) {
	const seen = /* @__PURE__ */ new Set();
	const unique = [];
	for (const page of pages) {
		const key = page.id ?? page.relativePath;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(page);
	}
	return unique;
}
function buildPageLookupKeys(page) {
	const keys = /* @__PURE__ */ new Set();
	keys.add(normalizeComparableTarget(page.relativePath));
	keys.add(normalizeComparableTarget(page.relativePath.replace(/\.md$/i, "")));
	keys.add(normalizeComparableTarget(page.title));
	if (page.id) keys.add(normalizeComparableTarget(page.id));
	return keys;
}
function renderWikiPageLinks(params) {
	return params.pages.map((page) => `- ${formatWikiLink({
		renderMode: params.config.vault.renderMode,
		relativePath: page.relativePath,
		title: page.title
	})}`).join("\n");
}
function sharedSourceFanout(page, allPages) {
	const sourceIds = new Set(page.sourceIds);
	const counts = /* @__PURE__ */ new Map();
	for (const candidate of allPages) {
		if (candidate.relativePath === page.relativePath) continue;
		for (const sourceId of candidate.sourceIds) {
			if (!sourceIds.has(sourceId)) continue;
			counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
		}
	}
	return counts;
}
function buildRelatedBlockBody(params) {
	const candidatePages = params.allPages.filter((candidate) => candidate.kind !== "report");
	const sourceFanout = sharedSourceFanout(params.page, candidatePages);
	const pagesById = new Map(candidatePages.flatMap((candidate) => candidate.id ? [[candidate.id, candidate]] : []));
	const sourcePages = uniquePages(params.page.sourceIds.flatMap((sourceId) => {
		const page = pagesById.get(sourceId);
		return page ? [page] : [];
	}));
	const backlinkKeys = buildPageLookupKeys(params.page);
	const backlinks = uniquePages(candidatePages.filter((candidate) => {
		if (candidate.relativePath === params.page.relativePath) return false;
		if (candidate.sourceIds.includes(params.page.id ?? "")) return true;
		return candidate.linkTargets.some((target) => backlinkKeys.has(normalizeComparableTarget(target)));
	}));
	const backlinkPages = backlinks.length <= MAX_SHARED_SOURCE_FANOUT ? backlinks.slice(0, MAX_RELATED_PAGES_PER_SECTION) : [];
	const relatedPages = uniquePages(candidatePages.filter((candidate) => {
		if (candidate.relativePath === params.page.relativePath) return false;
		if (sourcePages.some((sourcePage) => sourcePage.relativePath === candidate.relativePath)) return false;
		if (backlinkPages.some((backlink) => backlink.relativePath === candidate.relativePath)) return false;
		if (params.page.sourceIds.length === 0 || candidate.sourceIds.length === 0) return false;
		return params.page.sourceIds.some((sourceId) => candidate.sourceIds.includes(sourceId) && (sourceFanout.get(sourceId) ?? 0) <= MAX_SHARED_SOURCE_FANOUT);
	})).slice(0, MAX_RELATED_PAGES_PER_SECTION);
	const sections = [];
	if (sourcePages.length > 0) sections.push("### Sources", renderWikiPageLinks({
		config: params.config,
		pages: sourcePages
	}));
	if (backlinkPages.length > 0) sections.push("### Referenced By", renderWikiPageLinks({
		config: params.config,
		pages: backlinkPages
	}));
	if (relatedPages.length > 0) sections.push("### Related Pages", renderWikiPageLinks({
		config: params.config,
		pages: relatedPages
	}));
	if (sections.length === 0) return "- No related pages yet.";
	return sections.join("\n\n");
}
async function refreshPageRelatedBlocks(params) {
	if (!params.config.render.createBacklinks) return [];
	const root$2 = await root(params.config.vault.path);
	const updatedFiles = [];
	for (const page of params.pages) {
		if (page.kind === "report") continue;
		const original = await root$2.readText(page.relativePath);
		if (original.trim().length === 0) continue;
		const updated = withTrailingNewline(replaceManagedMarkdownBlock({
			original,
			heading: "## Related",
			startMarker: WIKI_RELATED_START_MARKER,
			endMarker: WIKI_RELATED_END_MARKER,
			body: buildRelatedBlockBody({
				config: params.config,
				page,
				allPages: params.pages
			})
		}));
		if (updated === original) continue;
		await root$2.write(page.relativePath, updated);
		updatedFiles.push(page.absolutePath);
	}
	return updatedFiles;
}
function renderSectionList(params) {
	if (params.pages.length === 0) return `- ${params.emptyText}`;
	return params.pages.map((page) => `- ${formatWikiLink({
		renderMode: params.config.vault.renderMode,
		relativePath: page.relativePath,
		title: page.title
	})}`).join("\n");
}
async function writeManagedMarkdownFile(params) {
	const root$3 = await root(params.rootDir);
	const original = await root$3.readText(params.relativePath).catch(() => `# ${params.title}\n`);
	const rendered = withTrailingNewline(replaceManagedMarkdownBlock({
		original,
		heading: "## Generated",
		startMarker: params.startMarker,
		endMarker: params.endMarker,
		body: params.body
	}));
	if (rendered === original) return false;
	await root$3.write(params.relativePath, rendered);
	return true;
}
async function writeDashboardPage(params) {
	const root$4 = await root(params.rootDir);
	const original = await root$4.readText(params.definition.relativePath).catch(() => renderWikiMarkdown({
		frontmatter: {
			pageType: "report",
			id: params.definition.id,
			title: params.definition.title,
			status: "active"
		},
		body: `# ${params.definition.title}\n`
	}));
	const parsed = parseWikiMarkdown(original);
	const updatedBody = replaceManagedMarkdownBlock({
		original: parsed.body.trim().length > 0 ? parsed.body : `# ${params.definition.title}\n`,
		heading: "## Generated",
		startMarker: `<!-- openclaw:wiki:${path.basename(params.definition.relativePath, ".md")}:start -->`,
		endMarker: `<!-- openclaw:wiki:${path.basename(params.definition.relativePath, ".md")}:end -->`,
		body: params.definition.buildBody({
			config: params.config,
			pages: params.pages,
			now: params.now
		})
	});
	const preservedUpdatedAt = typeof parsed.frontmatter.updatedAt === "string" && parsed.frontmatter.updatedAt.trim() ? parsed.frontmatter.updatedAt : params.now.toISOString();
	if (withTrailingNewline(renderWikiMarkdown({
		frontmatter: {
			...parsed.frontmatter,
			pageType: "report",
			id: params.definition.id,
			title: params.definition.title,
			status: typeof parsed.frontmatter.status === "string" && parsed.frontmatter.status.trim() ? parsed.frontmatter.status : "active",
			updatedAt: preservedUpdatedAt
		},
		body: updatedBody
	})) === original) return false;
	const rendered = withTrailingNewline(renderWikiMarkdown({
		frontmatter: {
			...parsed.frontmatter,
			pageType: "report",
			id: params.definition.id,
			title: params.definition.title,
			status: typeof parsed.frontmatter.status === "string" && parsed.frontmatter.status.trim() ? parsed.frontmatter.status : "active",
			updatedAt: params.now.toISOString()
		},
		body: updatedBody
	}));
	await root$4.write(params.definition.relativePath, rendered);
	return true;
}
async function refreshDashboardPages(params) {
	if (!params.config.render.createDashboards) return [];
	const now = /* @__PURE__ */ new Date();
	const updatedFiles = [];
	for (const definition of DASHBOARD_PAGES) if (await writeDashboardPage({
		config: params.config,
		rootDir: params.rootDir,
		definition,
		pages: params.pages,
		now
	})) updatedFiles.push(path.join(params.rootDir, definition.relativePath));
	return updatedFiles;
}
function buildRootIndexBody(params) {
	const claimCount = params.pages.reduce((total, page) => total + page.claims.length, 0);
	const lines = [
		`- Render mode: \`${params.config.vault.renderMode}\``,
		`- Total pages: ${params.pages.length}`,
		`- Claims: ${claimCount}`,
		`- Sources: ${params.counts.source}`,
		`- Entities: ${params.counts.entity}`,
		`- Concepts: ${params.counts.concept}`,
		`- Syntheses: ${params.counts.synthesis}`,
		`- Reports: ${params.counts.report}`
	];
	for (const group of COMPILE_PAGE_GROUPS) {
		lines.push("", `### ${group.heading}`);
		lines.push(renderSectionList({
			config: params.config,
			pages: params.pages.filter((page) => page.kind === group.kind),
			emptyText: `No ${normalizeLowercaseStringOrEmpty(group.heading)} yet.`
		}));
	}
	return lines.join("\n");
}
function buildDirectoryIndexBody(params) {
	return renderSectionList({
		config: params.config,
		pages: params.pages.filter((page) => page.kind === params.group.kind),
		emptyText: `No ${normalizeLowercaseStringOrEmpty(params.group.heading)} yet.`
	});
}
function createFreshnessSummary() {
	return {
		fresh: 0,
		aging: 0,
		stale: 0,
		unknown: 0
	};
}
function rankFreshnessLevel(level) {
	switch (level) {
		case "fresh": return 3;
		case "aging": return 2;
		case "stale": return 1;
		case "unknown": return 0;
	}
	throw new Error("Unsupported wiki freshness level");
}
function sortClaims(page) {
	return [...page.claims].toSorted((left, right) => {
		const leftConfidence = left.confidence ?? -1;
		const rightConfidence = right.confidence ?? -1;
		if (leftConfidence !== rightConfidence) return rightConfidence - leftConfidence;
		const leftFreshness = rankFreshnessLevel(assessClaimFreshness({
			page,
			claim: left
		}).level);
		const rightFreshness = rankFreshnessLevel(assessClaimFreshness({
			page,
			claim: right
		}).level);
		if (leftFreshness !== rightFreshness) return rightFreshness - leftFreshness;
		return left.text.localeCompare(right.text);
	});
}
function buildAgentDigestClaimHealthSummary(pages) {
	const freshness = createFreshnessSummary();
	let contested = 0;
	let lowConfidence = 0;
	let missingEvidence = 0;
	for (const claim of collectWikiClaimHealth(pages)) {
		freshness[claim.freshness.level] += 1;
		if (isClaimHealthContested(claim)) contested += 1;
		if (typeof claim.confidence === "number" && claim.confidence < .5) lowConfidence += 1;
		if (claim.missingEvidence) missingEvidence += 1;
	}
	return {
		freshness,
		contested,
		lowConfidence,
		missingEvidence
	};
}
function buildAgentDigestContradictionClusters(pages) {
	const pageClusters = buildPageContradictionClusters(pages).map((cluster) => ({
		key: cluster.key,
		label: cluster.label,
		kind: "page-note",
		entryCount: cluster.entries.length,
		paths: [...new Set(cluster.entries.map((entry) => entry.pagePath))].toSorted()
	}));
	const claimClusters = buildClaimContradictionClusters({ pages }).map((cluster) => ({
		key: cluster.key,
		label: cluster.label,
		kind: "claim-id",
		entryCount: cluster.entries.length,
		paths: [...new Set(cluster.entries.map((entry) => entry.pagePath))].toSorted()
	}));
	return [...pageClusters, ...claimClusters].toSorted((left, right) => left.label.localeCompare(right.label));
}
function buildAgentDigest(params) {
	const pages = [...params.pages].toSorted((left, right) => left.relativePath.localeCompare(right.relativePath)).map((page) => {
		const pageFreshness = assessPageFreshness(page);
		return Object.assign({}, page.id ? { id: page.id } : {}, {
			title: page.title,
			kind: page.kind,
			path: page.relativePath,
			aliases: [...page.aliases],
			sourceIds: [...page.sourceIds],
			questions: [...page.questions],
			contradictions: [...page.contradictions],
			bestUsedFor: [...page.bestUsedFor],
			notEnoughFor: [...page.notEnoughFor],
			relationshipCount: page.relationships.length,
			topRelationships: page.relationships.slice(0, 5)
		}, page.pageType ? { pageType: page.pageType } : {}, page.entityType ? { entityType: page.entityType } : {}, page.canonicalId ? { canonicalId: page.canonicalId } : {}, typeof page.confidence === "number" ? { confidence: page.confidence } : {}, page.privacyTier ? { privacyTier: page.privacyTier } : {}, page.personCard ? { personCard: page.personCard } : {}, { freshnessLevel: pageFreshness.level }, pageFreshness.lastTouchedAt ? { lastTouchedAt: pageFreshness.lastTouchedAt } : {}, page.lastRefreshedAt ? { lastRefreshedAt: page.lastRefreshedAt } : {}, {
			claimCount: page.claims.length,
			topClaims: sortClaims(page).slice(0, 5).map((claim) => {
				const freshness = assessClaimFreshness({
					page,
					claim
				});
				return Object.assign({}, claim.id ? { id: claim.id } : {}, {
					text: claim.text,
					status: normalizeClaimStatus(claim.status)
				}, typeof claim.confidence === "number" ? { confidence: claim.confidence } : {}, {
					evidenceCount: claim.evidence.length,
					missingEvidence: claim.evidence.length === 0,
					evidence: [...claim.evidence],
					freshnessLevel: freshness.level
				}, freshness.lastTouchedAt ? { lastTouchedAt: freshness.lastTouchedAt } : {});
			})
		});
	});
	return {
		pageCounts: params.pageCounts,
		claimCount: params.pages.reduce((total, page) => total + page.claims.length, 0),
		claimHealth: buildAgentDigestClaimHealthSummary(params.pages),
		contradictionClusters: buildAgentDigestContradictionClusters(params.pages),
		pages
	};
}
function buildClaimsDigestLines(params) {
	return params.pages.flatMap((page) => sortClaims(page).map((claim) => {
		const freshness = assessClaimFreshness({
			page,
			claim
		});
		return JSON.stringify({
			...claim.id ? { id: claim.id } : {},
			pageId: page.id,
			pageTitle: page.title,
			pageKind: page.kind,
			pagePath: page.relativePath,
			pageType: page.pageType,
			entityType: page.entityType,
			canonicalId: page.canonicalId,
			aliases: page.aliases,
			text: claim.text,
			status: normalizeClaimStatus(claim.status),
			confidence: claim.confidence,
			sourceIds: page.sourceIds,
			evidenceKinds: [...new Set(claim.evidence.flatMap((entry) => entry.kind ?? []))],
			privacyTiers: [...new Set([
				page.privacyTier,
				page.personCard?.privacyTier,
				...claim.evidence.map((entry) => entry.privacyTier)
			].flatMap((entry) => entry ?? []))],
			evidenceCount: claim.evidence.length,
			missingEvidence: claim.evidence.length === 0,
			evidence: claim.evidence,
			freshnessLevel: freshness.level,
			lastTouchedAt: freshness.lastTouchedAt
		});
	})).toSorted((left, right) => left.localeCompare(right));
}
async function writeAgentDigestArtifacts(params) {
	const updatedFiles = [];
	const agentDigestPath = path.join(params.rootDir, AGENT_DIGEST_PATH$1);
	const claimsDigestPath = path.join(params.rootDir, CLAIMS_DIGEST_PATH$1);
	const agentDigest = `${JSON.stringify(buildAgentDigest({
		pages: params.pages,
		pageCounts: params.pageCounts
	}), null, 2)}\n`;
	const claimsDigest = withTrailingNewline(buildClaimsDigestLines({ pages: params.pages }).join("\n"));
	for (const [filePath, content] of [[agentDigestPath, agentDigest], [claimsDigestPath, claimsDigest]]) {
		const relativePath = path.relative(params.rootDir, filePath);
		const root$5 = await root(params.rootDir);
		if (await root$5.readText(relativePath).catch(() => "") === content) continue;
		await root$5.write(relativePath, content);
		updatedFiles.push(filePath);
	}
	return updatedFiles;
}
async function compileMemoryWikiVault(config) {
	await initializeMemoryWikiVault(config);
	const rootDir = config.vault.path;
	let pages = await readPageSummaries(rootDir);
	const updatedFiles = await refreshPageRelatedBlocks({
		config,
		pages
	});
	if (updatedFiles.length > 0) pages = await readPageSummaries(rootDir);
	const dashboardUpdatedFiles = await refreshDashboardPages({
		config,
		rootDir,
		pages
	});
	updatedFiles.push(...dashboardUpdatedFiles);
	if (dashboardUpdatedFiles.length > 0) pages = await readPageSummaries(rootDir);
	const counts = buildPageCounts(pages);
	const digestUpdatedFiles = await writeAgentDigestArtifacts({
		rootDir,
		pages,
		pageCounts: counts
	});
	updatedFiles.push(...digestUpdatedFiles);
	const rootIndexPath = path.join(rootDir, "index.md");
	if (await writeManagedMarkdownFile({
		rootDir,
		relativePath: "index.md",
		title: "Wiki Index",
		startMarker: "<!-- openclaw:wiki:index:start -->",
		endMarker: "<!-- openclaw:wiki:index:end -->",
		body: buildRootIndexBody({
			config,
			pages,
			counts
		})
	})) updatedFiles.push(rootIndexPath);
	for (const group of COMPILE_PAGE_GROUPS) {
		const relativePath = path.join(group.dir, "index.md").replace(/\\/g, "/");
		const filePath = path.join(rootDir, relativePath);
		if (await writeManagedMarkdownFile({
			rootDir,
			relativePath,
			title: group.heading,
			startMarker: `<!-- openclaw:wiki:${group.dir}:index:start -->`,
			endMarker: `<!-- openclaw:wiki:${group.dir}:index:end -->`,
			body: buildDirectoryIndexBody({
				config,
				pages,
				group
			})
		})) updatedFiles.push(filePath);
	}
	if (updatedFiles.length > 0) await appendMemoryWikiLog(rootDir, {
		type: "compile",
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		details: {
			pageCounts: counts,
			updatedFiles: updatedFiles.map((filePath) => path.relative(rootDir, filePath))
		}
	});
	return {
		vaultRoot: rootDir,
		pageCounts: counts,
		pages,
		claimCount: pages.reduce((total, page) => total + page.claims.length, 0),
		updatedFiles
	};
}
async function hasMissingWikiIndexes(rootDir) {
	const required = [path.join(rootDir, "index.md"), ...COMPILE_PAGE_GROUPS.map((group) => path.join(rootDir, group.dir, "index.md"))];
	for (const filePath of required) if (!await fs$1.access(filePath).then(() => true).catch(() => false)) return true;
	return false;
}
async function refreshMemoryWikiIndexesAfterImport(params) {
	await initializeMemoryWikiVault(params.config);
	if (!params.config.ingest.autoCompile) return {
		refreshed: false,
		reason: "auto-compile-disabled"
	};
	const importChanged = params.syncResult.importedCount > 0 || params.syncResult.updatedCount > 0 || params.syncResult.removedCount > 0;
	const missingIndexes = await hasMissingWikiIndexes(params.config.vault.path);
	if (!importChanged && !missingIndexes) return {
		refreshed: false,
		reason: "no-import-changes"
	};
	const compile = await compileMemoryWikiVault(params.config);
	return {
		refreshed: true,
		reason: missingIndexes && !importChanged ? "missing-indexes" : "import-changed",
		compile
	};
}
//#endregion
//#region extensions/memory-wiki/src/query.ts
const QUERY_DIRS = [
	"entities",
	"concepts",
	"sources",
	"syntheses",
	"reports"
];
const AGENT_DIGEST_PATH = ".openclaw-wiki/cache/agent-digest.json";
const CLAIMS_DIGEST_PATH = ".openclaw-wiki/cache/claims.jsonl";
const RELATED_BLOCK_PATTERN = /<!-- openclaw:wiki:related:start -->[\s\S]*?<!-- openclaw:wiki:related:end -->/g;
const MARKDOWN_FRONTMATTER_PATTERN = /^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const ROUTE_QUESTION_STOP_WORDS = new Set([
	"a",
	"about",
	"am",
	"an",
	"are",
	"ask",
	"asking",
	"be",
	"been",
	"being",
	"can",
	"could",
	"did",
	"do",
	"does",
	"for",
	"help",
	"how",
	"i",
	"in",
	"is",
	"know",
	"knows",
	"me",
	"my",
	"need",
	"needs",
	"of",
	"on",
	"or",
	"our",
	"question",
	"questions",
	"should",
	"the",
	"to",
	"us",
	"we",
	"what",
	"when",
	"where",
	"who",
	"whom",
	"whose",
	"why",
	"with",
	"would"
]);
const WIKI_SEARCH_MODES = [
	"auto",
	"find-person",
	"route-question",
	"source-evidence",
	"raw-claim"
];
function sortWikiSearchResults(results) {
	return results.toSorted((left, right) => {
		if (left.score !== right.score) return right.score - left.score;
		return left.title.localeCompare(right.title);
	});
}
function mergeWikiSearchCorpusResults(params) {
	const wikiResults = sortWikiSearchResults(params.wikiResults);
	const memoryResults = sortWikiSearchResults(params.memoryResults);
	if (!params.balanceCorpora || wikiResults.length === 0 || memoryResults.length === 0) return sortWikiSearchResults([...wikiResults, ...memoryResults]).slice(0, params.maxResults);
	const perCorpusCap = Math.ceil(params.maxResults / 2);
	const selectedWiki = wikiResults.slice(0, perCorpusCap);
	const selectedMemory = memoryResults.slice(0, perCorpusCap);
	const selected = [...selectedWiki, ...selectedMemory];
	if (selected.length < params.maxResults) selected.push(...sortWikiSearchResults([...wikiResults.slice(selectedWiki.length), ...memoryResults.slice(selectedMemory.length)]).slice(0, params.maxResults - selected.length));
	return sortWikiSearchResults(selected).slice(0, params.maxResults);
}
async function listWikiMarkdownFiles(rootDir) {
	return (await Promise.all(QUERY_DIRS.map(async (relativeDir) => {
		const dirPath = path.join(rootDir, relativeDir);
		return (await fs$1.readdir(dirPath, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md").map((entry) => path.join(relativeDir, entry.name));
	}))).flat().toSorted((left, right) => left.localeCompare(right));
}
async function readQueryableWikiPages(rootDir) {
	return readQueryableWikiPagesByPaths(rootDir, await listWikiMarkdownFiles(rootDir));
}
async function readQueryableWikiPagesByPaths(rootDir, files) {
	return (await Promise.all(files.map(async (relativePath) => {
		const absolutePath = path.join(rootDir, relativePath);
		const raw = await fs$1.readFile(absolutePath, "utf8");
		const summary = toWikiPageSummary({
			absolutePath,
			relativePath,
			raw
		});
		return summary ? {
			...summary,
			raw
		} : null;
	}))).flatMap((page) => page ? [page] : []);
}
function parseClaimsDigest(raw) {
	return raw.split(/\r?\n/).flatMap((line) => {
		const trimmed = line.trim();
		if (!trimmed) return [];
		try {
			const parsed = JSON.parse(trimmed);
			if (!parsed || typeof parsed !== "object" || typeof parsed.pagePath !== "string") return [];
			return [parsed];
		} catch {
			return [];
		}
	});
}
async function readQueryDigestBundle(rootDir) {
	const [agentDigestRaw, claimsDigestRaw] = await Promise.all([fs$1.readFile(path.join(rootDir, AGENT_DIGEST_PATH), "utf8").catch(() => null), fs$1.readFile(path.join(rootDir, CLAIMS_DIGEST_PATH), "utf8").catch(() => null)]);
	if (!agentDigestRaw && !claimsDigestRaw) return null;
	const pages = (() => {
		if (!agentDigestRaw) return [];
		try {
			const parsed = JSON.parse(agentDigestRaw);
			return Array.isArray(parsed.pages) ? parsed.pages : [];
		} catch {
			return [];
		}
	})();
	const claims = claimsDigestRaw ? parseClaimsDigest(claimsDigestRaw) : [];
	if (pages.length === 0 && claims.length === 0) return null;
	return {
		pages,
		claims
	};
}
function buildSnippet(raw, query) {
	const queryLower = normalizeLowercaseStringOrEmpty(query);
	const queryTokens = buildQueryTokens(queryLower);
	const lines = buildSnippetSearchText(raw).split(/\r?\n/).filter((line) => line.trim().length > 0);
	return (lines.find((line) => lineMatchesQuery(normalizeLowercaseStringOrEmpty(line), queryLower, queryTokens)) ?? lines.map((line) => ({
		line,
		hits: queryTokens.filter((token) => normalizeLowercaseStringOrEmpty(line).includes(token)).length
	})).toSorted((left, right) => right.hits - left.hits).find((candidate) => candidate.hits > 0)?.line)?.trim() || lines.find((line) => line.trim() !== "---")?.trim() || "";
}
function buildPageSearchText(page) {
	return [
		page.title,
		page.relativePath,
		page.id ?? "",
		page.pageType ?? "",
		page.entityType ?? "",
		page.canonicalId ?? "",
		page.aliases.join(" "),
		page.sourceIds.join(" "),
		page.questions.join(" "),
		page.contradictions.join(" "),
		page.privacyTier ?? "",
		page.bestUsedFor.join(" "),
		page.notEnoughFor.join(" "),
		page.personCard?.canonicalId ?? "",
		page.personCard?.handles.join(" ") ?? "",
		page.personCard?.socials.join(" ") ?? "",
		page.personCard?.emails.join(" ") ?? "",
		page.personCard?.timezone ?? "",
		page.personCard?.lane ?? "",
		page.personCard?.askFor.join(" ") ?? "",
		page.personCard?.avoidAskingFor.join(" ") ?? "",
		page.personCard?.bestUsedFor.join(" ") ?? "",
		page.personCard?.notEnoughFor.join(" ") ?? "",
		page.relationships.flatMap((relationship) => [
			relationship.targetId ?? "",
			relationship.targetPath ?? "",
			relationship.targetTitle ?? "",
			relationship.kind ?? "",
			relationship.evidenceKind ?? "",
			relationship.note ?? ""
		]).join(" "),
		page.claims.map((claim) => claim.text).join(" "),
		page.claims.map((claim) => claim.id ?? "").join(" "),
		page.claims.flatMap((claim) => claim.evidence.flatMap((evidence) => [
			evidence.kind ?? "",
			evidence.sourceId ?? "",
			evidence.path ?? "",
			evidence.lines ?? "",
			evidence.note ?? "",
			evidence.privacyTier ?? ""
		])).join(" ")
	].filter(Boolean).join("\n");
}
function stripGeneratedRelatedBlock(raw) {
	return raw.replace(RELATED_BLOCK_PATTERN, "");
}
function buildSnippetSearchText(raw) {
	return stripGeneratedRelatedBlock(raw).replace(MARKDOWN_FRONTMATTER_PATTERN, "");
}
function buildQueryTokens(queryLower) {
	return [...new Set(queryLower.split(/[^a-z0-9@._-]+/i).map((token) => token.trim()).filter((token) => token.length >= 2))];
}
function buildRouteQuestionTokens(queryLower) {
	const tokens = buildQueryTokens(queryLower);
	const routedTokens = tokens.filter((token) => !ROUTE_QUESTION_STOP_WORDS.has(token));
	return routedTokens.length > 0 ? routedTokens : tokens;
}
function lineMatchesQuery(lineLower, queryLower, queryTokens) {
	if (queryLower.length > 0 && lineLower.includes(queryLower)) return true;
	return queryTokens.length > 0 && queryTokens.every((token) => lineLower.includes(token));
}
function buildDigestPageSearchText(page, claims) {
	return [
		page.title,
		page.path,
		page.id ?? "",
		page.pageType ?? "",
		page.entityType ?? "",
		page.canonicalId ?? "",
		page.aliases?.join(" ") ?? "",
		page.sourceIds.join(" "),
		page.questions.join(" "),
		page.contradictions.join(" "),
		page.privacyTier ?? "",
		page.bestUsedFor?.join(" ") ?? "",
		page.notEnoughFor?.join(" ") ?? "",
		page.personCard?.canonicalId ?? "",
		page.personCard?.handles.join(" ") ?? "",
		page.personCard?.socials.join(" ") ?? "",
		page.personCard?.emails.join(" ") ?? "",
		page.personCard?.timezone ?? "",
		page.personCard?.lane ?? "",
		page.personCard?.askFor.join(" ") ?? "",
		page.personCard?.avoidAskingFor.join(" ") ?? "",
		page.personCard?.bestUsedFor.join(" ") ?? "",
		page.personCard?.notEnoughFor.join(" ") ?? "",
		page.topRelationships?.flatMap((relationship) => [
			relationship.targetId ?? "",
			relationship.targetPath ?? "",
			relationship.targetTitle ?? "",
			relationship.kind ?? "",
			relationship.evidenceKind ?? "",
			relationship.note ?? ""
		]).join(" ") ?? "",
		claims.map((claim) => claim.text).join(" "),
		claims.map((claim) => claim.id ?? "").join(" "),
		claims.map((claim) => claim.evidenceKinds?.join(" ") ?? "").join(" "),
		claims.map((claim) => claim.privacyTiers?.join(" ") ?? "").join(" ")
	].filter(Boolean).join("\n");
}
function isClaimTextOrIdMatch(claim, queryLower, queryTokens = buildQueryTokens(queryLower)) {
	if (lineMatchesQuery(normalizeLowercaseStringOrEmpty(claim.text), queryLower, [...queryTokens])) return true;
	return lineMatchesQuery(normalizeLowercaseStringOrEmpty(claim.id), queryLower, [...queryTokens]);
}
function scoreClaimMatch(params) {
	let score = 0;
	if (normalizeLowercaseStringOrEmpty(params.text).includes(params.queryLower)) score += 25;
	else if (params.queryTokens?.length && params.queryTokens.every((token) => normalizeLowercaseStringOrEmpty(params.text).includes(token))) score += 18;
	if (normalizeLowercaseStringOrEmpty(params.id).includes(params.queryLower)) score += 10;
	if (typeof params.confidence === "number") score += Math.round(params.confidence * 10);
	switch (params.freshnessLevel) {
		case "fresh":
			score += 8;
			break;
		case "aging":
			score += 4;
			break;
		case "stale":
			score -= 2;
			break;
		case "unknown":
			score -= 4;
			break;
		case void 0: break;
	}
	score += isClaimContestedStatus(params.status) ? -6 : 4;
	return score;
}
function scoreDigestClaimMatch(claim, queryLower) {
	return scoreClaimMatch({
		text: claim.text,
		id: claim.id,
		confidence: claim.confidence,
		status: claim.status,
		freshnessLevel: claim.freshnessLevel,
		queryLower,
		queryTokens: buildQueryTokens(queryLower)
	});
}
function scoreWikiMetadataMatch(params) {
	let score = 0;
	const titleLower = normalizeLowercaseStringOrEmpty(params.title);
	const pathLower = normalizeLowercaseStringOrEmpty(params.path);
	const idLower = normalizeLowercaseStringOrEmpty(params.id);
	if (titleLower === params.queryLower) score += 50;
	else if (titleLower.includes(params.queryLower)) score += 20;
	if (pathLower.includes(params.queryLower)) score += 10;
	if (idLower.includes(params.queryLower)) score += 20;
	if (params.sourceIds.some((sourceId) => normalizeLowercaseStringOrEmpty(sourceId).includes(params.queryLower))) score += 12;
	return score;
}
function hasQueryMatch(value, queryLower, queryTokens) {
	return lineMatchesQuery(normalizeLowercaseStringOrEmpty(value), queryLower, [...queryTokens]);
}
function hasAnyQueryMatch(values, queryLower, queryTokens) {
	return values.some((value) => hasQueryMatch(value, queryLower, queryTokens));
}
function buildPageRouteQuestionFields(page) {
	return [
		page.personCard?.lane,
		...page.personCard?.askFor ?? [],
		...page.personCard?.avoidAskingFor ?? [],
		...page.bestUsedFor,
		...page.notEnoughFor,
		...page.personCard?.bestUsedFor ?? [],
		...page.personCard?.notEnoughFor ?? [],
		...page.relationships.flatMap((relationship) => [
			relationship.kind,
			relationship.targetTitle,
			relationship.note
		])
	].filter((value) => Boolean(value));
}
function buildDigestRouteQuestionFields(page) {
	return [
		page.personCard?.lane,
		...page.personCard?.askFor ?? [],
		...page.personCard?.avoidAskingFor ?? [],
		...page.bestUsedFor ?? [],
		...page.notEnoughFor ?? [],
		...page.personCard?.bestUsedFor ?? [],
		...page.personCard?.notEnoughFor ?? [],
		...page.topRelationships?.flatMap((relationship) => [
			relationship.kind,
			relationship.targetTitle,
			relationship.note
		]) ?? []
	].filter((value) => Boolean(value));
}
function hasRouteQuestionMatch(values, queryLower) {
	return hasAnyQueryMatch(values, queryLower, buildRouteQuestionTokens(queryLower));
}
function isPersonLikeSummary(page) {
	const entityType = normalizeLowercaseStringOrEmpty(page.entityType);
	const pageType = normalizeLowercaseStringOrEmpty(page.pageType);
	return Boolean(page.personCard) || entityType === "person" || entityType === "maintainer" || pageType === "person" || pageType === "maintainer";
}
function scorePageSearchModeBoost(params) {
	const { page, queryLower, queryTokens } = params;
	switch (params.mode) {
		case "auto": return 0;
		case "find-person": {
			let score = isPersonLikeSummary(page) ? 24 : -4;
			if (hasAnyQueryMatch([
				page.canonicalId,
				...page.aliases,
				page.personCard?.canonicalId,
				...page.personCard?.handles ?? [],
				...page.personCard?.emails ?? [],
				...page.personCard?.socials ?? []
			], queryLower, queryTokens)) score += 24;
			return score;
		}
		case "route-question": {
			let score = isPersonLikeSummary(page) ? 14 : 0;
			if (hasRouteQuestionMatch(buildPageRouteQuestionFields(page), queryLower)) score += 32;
			score += Math.min(8, page.relationships.length * 2);
			return score;
		}
		case "source-evidence": {
			let score = page.kind === "source" ? 22 : 0;
			if (hasAnyQueryMatch([
				page.sourcePath,
				...page.sourceIds,
				...page.claims.flatMap((claim) => claim.evidence.flatMap((evidence) => [
					evidence.kind,
					evidence.sourceId,
					evidence.path,
					evidence.lines,
					evidence.note
				]))
			], queryLower, queryTokens)) score += 30;
			return score;
		}
		case "raw-claim": return params.matchingClaims.length > 0 ? 42 : 0;
	}
	return 0;
}
function scoreDigestSearchModeBoost(params) {
	const { page, queryLower, queryTokens } = params;
	switch (params.mode) {
		case "auto": return 0;
		case "find-person": {
			let score = isPersonLikeSummary(page) ? 24 : -4;
			if (hasAnyQueryMatch([
				page.canonicalId,
				...page.aliases ?? [],
				page.personCard?.canonicalId,
				...page.personCard?.handles ?? [],
				...page.personCard?.emails ?? [],
				...page.personCard?.socials ?? []
			], queryLower, queryTokens)) score += 24;
			return score;
		}
		case "route-question": {
			let score = isPersonLikeSummary(page) ? 14 : 0;
			if (hasRouteQuestionMatch(buildDigestRouteQuestionFields(page), queryLower)) score += 32;
			score += Math.min(8, (page.relationshipCount ?? 0) * 2);
			return score;
		}
		case "source-evidence": {
			let score = page.kind === "source" ? 22 : 0;
			if (hasAnyQueryMatch([...page.sourceIds, ...params.claims.flatMap((claim) => [
				...claim.sourceIds ?? [],
				...claim.evidenceKinds ?? [],
				...claim.privacyTiers ?? []
			])], queryLower, queryTokens)) score += 30;
			return score;
		}
		case "raw-claim": return params.matchingClaims.length > 0 ? 42 : 0;
	}
	return 0;
}
function buildDigestCandidatePaths(params) {
	const queryLower = normalizeLowercaseStringOrEmpty(params.query);
	const queryTokens = buildQueryTokens(queryLower);
	const claimsByPage = /* @__PURE__ */ new Map();
	for (const claim of params.digest.claims) {
		const current = claimsByPage.get(claim.pagePath) ?? [];
		current.push(claim);
		claimsByPage.set(claim.pagePath, current);
	}
	return params.digest.pages.map((page) => {
		const claims = claimsByPage.get(page.path) ?? [];
		if (!normalizeLowercaseStringOrEmpty(buildDigestPageSearchText(page, claims)).includes(queryLower) && !(params.mode === "route-question" && hasRouteQuestionMatch(buildDigestRouteQuestionFields(page), queryLower))) return {
			path: page.path,
			score: 0
		};
		let score = 1 + scoreWikiMetadataMatch({
			title: page.title,
			path: page.path,
			id: page.id,
			sourceIds: page.sourceIds,
			queryLower
		});
		const matchingClaims = claims.filter((claim) => isClaimTextOrIdMatch(claim, queryLower, queryTokens)).toSorted((left, right) => scoreDigestClaimMatch(right, queryLower) - scoreDigestClaimMatch(left, queryLower));
		if (matchingClaims.length > 0) {
			score += scoreDigestClaimMatch(matchingClaims[0], queryLower);
			score += Math.min(10, (matchingClaims.length - 1) * 2);
		}
		score += scoreDigestSearchModeBoost({
			page,
			claims,
			matchingClaims,
			queryLower,
			queryTokens,
			mode: params.mode
		});
		return {
			path: page.path,
			score
		};
	}).filter((candidate) => candidate.score > 0).toSorted((left, right) => {
		if (left.score !== right.score) return right.score - left.score;
		return left.path.localeCompare(right.path);
	}).slice(0, Math.max(params.maxResults * 4, 20)).map((candidate) => candidate.path);
}
function isClaimMatch(claim, queryLower, queryTokens) {
	return isClaimTextOrIdMatch(claim, queryLower, queryTokens);
}
function rankClaimMatch(page, claim, queryLower, queryTokens) {
	const freshness = assessClaimFreshness({
		page,
		claim
	});
	return scoreClaimMatch({
		text: claim.text,
		id: claim.id,
		confidence: claim.confidence,
		status: claim.status,
		freshnessLevel: freshness.level,
		queryLower,
		queryTokens
	});
}
function getMatchingClaims(page, queryLower) {
	const queryTokens = buildQueryTokens(queryLower);
	return page.claims.filter((claim) => isClaimMatch(claim, queryLower, queryTokens)).toSorted((left, right) => rankClaimMatch(page, right, queryLower, queryTokens) - rankClaimMatch(page, left, queryLower, queryTokens));
}
function buildPageSnippet(page, query) {
	const matchingClaim = getMatchingClaims(page, normalizeLowercaseStringOrEmpty(query))[0];
	if (matchingClaim) return matchingClaim.text;
	return buildSnippet(page.raw, query);
}
function scorePage(page, query, mode) {
	const queryLower = normalizeLowercaseStringOrEmpty(query);
	const queryTokens = buildQueryTokens(queryLower);
	const titleLower = normalizeLowercaseStringOrEmpty(page.title);
	const pathLower = normalizeLowercaseStringOrEmpty(page.relativePath);
	const idLower = normalizeLowercaseStringOrEmpty(page.id);
	const metadataLower = normalizeLowercaseStringOrEmpty(buildPageSearchText(page));
	const rawLower = normalizeLowercaseStringOrEmpty(stripGeneratedRelatedBlock(page.raw));
	const combinedLower = [
		titleLower,
		pathLower,
		idLower,
		metadataLower,
		rawLower
	].join("\n");
	const hasExactMatch = titleLower.includes(queryLower) || pathLower.includes(queryLower) || idLower.includes(queryLower) || metadataLower.includes(queryLower) || rawLower.includes(queryLower);
	const hasAllTokens = queryTokens.length > 0 && queryTokens.every((token) => combinedLower.includes(token));
	const hasModeMatch = mode === "route-question" && hasRouteQuestionMatch(buildPageRouteQuestionFields(page), queryLower);
	if (!hasExactMatch && !hasAllTokens && !hasModeMatch) return 0;
	let score = 1 + scoreWikiMetadataMatch({
		title: page.title,
		path: page.relativePath,
		id: page.id,
		sourceIds: page.sourceIds,
		queryLower
	});
	const matchingClaims = getMatchingClaims(page, queryLower);
	if (matchingClaims.length > 0) {
		score += rankClaimMatch(page, matchingClaims[0], queryLower, queryTokens);
		score += Math.min(10, (matchingClaims.length - 1) * 2);
	}
	score += scorePageSearchModeBoost({
		page,
		matchingClaims,
		queryLower,
		queryTokens,
		mode
	});
	const bodyOccurrences = rawLower.split(queryLower).length - 1;
	score += Math.min(10, bodyOccurrences);
	for (const token of queryTokens) {
		if (titleLower.includes(token)) score += 8;
		if (pathLower.includes(token) || idLower.includes(token)) score += 6;
		if (metadataLower.includes(token)) score += 4;
		if (rawLower.includes(token)) score += 1;
	}
	return score;
}
function normalizeLookupKey(value) {
	const normalized = value.trim().replace(/\\/g, "/");
	return normalized.endsWith(".md") ? normalized : normalized.replace(/\/+$/, "");
}
function buildLookupCandidates(lookup) {
	const normalized = normalizeLookupKey(lookup);
	const withExtension = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
	return [...new Set([normalized, withExtension])];
}
function shouldEnforceSessionVisibility(params) {
	return params.sandboxed === true || Boolean(params.agentSessionKey?.trim()) || Boolean(params.agentId?.trim());
}
function shouldSearchSharedMemoryCorpus(config) {
	return config.search.corpus === "memory" || config.search.corpus === "all";
}
function shouldUseSharedMemory(config) {
	return config.search.backend === "shared" && shouldSearchSharedMemoryCorpus(config);
}
function assertSessionVisibilityAppConfig(params) {
	if (shouldUseSharedMemory(params.config) && shouldEnforceSessionVisibility(params) && !params.appConfig) throw new Error(`${params.operation} requires appConfig to enforce session visibility for session-bound shared memory calls.`);
}
const SESSION_MEMORY_PATH_PREFIXES = [
	"sessions/",
	"qmd/sessions/",
	"qmd/sessions-"
];
const SESSION_MEMORY_ROOT_PATHS = ["qmd/sessions"];
function isSessionMemoryPath(relPath) {
	const normalized = relPath.replace(/\\/g, "/");
	return SESSION_MEMORY_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix)) || SESSION_MEMORY_ROOT_PATHS.some((rootPath) => normalized === rootPath);
}
function shouldSearchWiki(config) {
	return config.search.corpus === "wiki" || config.search.corpus === "all";
}
function shouldSearchSharedMemory(config, appConfig) {
	return shouldUseSharedMemory(config) && appConfig !== void 0;
}
function resolveActiveMemoryAgentId(params) {
	if (!params.appConfig) return null;
	if (params.agentId?.trim()) return params.agentId.trim();
	if (params.agentSessionKey?.trim()) return resolveSessionAgentId({
		sessionKey: params.agentSessionKey,
		config: params.appConfig
	});
	return resolveDefaultAgentId(params.appConfig);
}
async function resolveActiveMemoryManager(params) {
	const agentId = resolveActiveMemoryAgentId(params);
	if (!params.appConfig || !agentId) return null;
	try {
		const { manager } = await getActiveMemorySearchManager({
			cfg: params.appConfig,
			agentId
		});
		return manager;
	} catch {
		return null;
	}
}
function buildMemorySearchTitle(resultPath) {
	const basename = path.basename(resultPath, path.extname(resultPath));
	return basename.length > 0 ? basename : resultPath;
}
function applySearchOverrides(config, overrides) {
	if (!overrides?.searchBackend && !overrides?.searchCorpus) return config;
	return {
		...config,
		search: {
			backend: overrides.searchBackend ?? config.search.backend,
			corpus: overrides.searchCorpus ?? config.search.corpus
		}
	};
}
function buildWikiProvenanceLabel(page) {
	if (page.sourceType === "memory-bridge-events") return `bridge events: ${page.bridgeRelativePath ?? page.relativePath}`;
	if (page.sourceType === "memory-bridge") return `bridge: ${page.bridgeRelativePath ?? page.relativePath}`;
	if (page.provenanceMode === "unsafe-local" || page.sourceType === "memory-unsafe-local") return `unsafe-local: ${page.unsafeLocalRelativePath ?? page.relativePath}`;
}
function buildWikiResultMetadata(page) {
	const provenanceLabel = buildWikiProvenanceLabel(page);
	return {
		...page.id ? { id: page.id } : {},
		...page.sourceType ? { sourceType: page.sourceType } : {},
		...page.provenanceMode ? { provenanceMode: page.provenanceMode } : {},
		...page.sourcePath ? { sourcePath: page.sourcePath } : {},
		...provenanceLabel ? { provenanceLabel } : {},
		...page.updatedAt ? { updatedAt: page.updatedAt } : {},
		..."entityType" in page && page.entityType ? { entityType: page.entityType } : {},
		..."canonicalId" in page && page.canonicalId ? { canonicalId: page.canonicalId } : {},
		..."aliases" in page && page.aliases.length > 0 ? { aliases: [...page.aliases] } : {},
		..."privacyTier" in page && page.privacyTier ? { privacyTier: page.privacyTier } : {}
	};
}
function buildClaimResultMetadata(claim) {
	if (!claim) return {};
	return {
		...claim.id ? { matchedClaimId: claim.id } : {},
		...claim.status ? { matchedClaimStatus: claim.status } : {},
		...typeof claim.confidence === "number" ? { matchedClaimConfidence: claim.confidence } : {},
		evidenceKinds: [...new Set(claim.evidence.flatMap((evidence) => evidence.kind ?? []))],
		evidenceSourceIds: [...new Set(claim.evidence.flatMap((evidence) => evidence.sourceId ?? []))]
	};
}
function toWikiSearchResult(page, query, mode) {
	const matchingClaim = getMatchingClaims(page, normalizeLowercaseStringOrEmpty(query))[0];
	return {
		corpus: "wiki",
		path: page.relativePath,
		title: page.title,
		kind: page.kind,
		score: scorePage(page, query, mode),
		snippet: buildPageSnippet(page, query),
		searchMode: mode,
		...buildWikiResultMetadata(page),
		...buildClaimResultMetadata(matchingClaim)
	};
}
function toMemoryWikiSearchResult(result, mode) {
	return {
		corpus: "memory",
		path: result.path,
		title: buildMemorySearchTitle(result.path),
		kind: "memory",
		score: result.score,
		snippet: result.snippet,
		startLine: result.startLine,
		endLine: result.endLine,
		memorySource: result.source,
		searchMode: mode,
		...result.citation ? { citation: result.citation } : {}
	};
}
async function filterMemoryWikiSearchHitsBySessionVisibility(params) {
	if (!params.hits.some((hit) => hit.source === "sessions")) return params.hits;
	return filterMemoryWikiSearchHitsWithSessionVisibility({
		canReadSessionPath: await createSessionMemoryPathVisibilityChecker({
			cfg: params.cfg,
			agentId: params.agentId,
			requesterSessionKey: params.requesterSessionKey,
			sandboxed: params.sandboxed
		}),
		hits: params.hits
	});
}
function filterSessionKeysByScopedAgent(params) {
	const scopedAgentId = normalizeLowercaseStringOrEmpty(params.scopedAgentId);
	if (!scopedAgentId) return params.keys;
	return params.keys.filter((key) => {
		if (params.cfg.session?.scope === "global" && key.trim().toLowerCase() === "global") return true;
		return normalizeLowercaseStringOrEmpty(resolveSessionAgentId({
			sessionKey: key,
			config: params.cfg
		})) === scopedAgentId;
	});
}
async function createSessionMemoryPathVisibilityChecker(params) {
	const visibility = resolveEffectiveSessionToolsVisibility({
		cfg: params.cfg,
		sandboxed: params.sandboxed
	});
	const a2aPolicy = createAgentToAgentPolicy(params.cfg);
	const requesterAgentId = params.requesterSessionKey ? resolveSessionAgentId({
		sessionKey: params.requesterSessionKey,
		config: params.cfg
	}) : void 0;
	const scopedAgentId = params.agentId?.trim() || requesterAgentId;
	const guard = params.requesterSessionKey ? await createSessionVisibilityGuard({
		action: "history",
		requesterSessionKey: params.requesterSessionKey,
		visibility,
		a2aPolicy
	}) : null;
	const { store: combinedSessionStore } = loadCombinedSessionStoreForGateway(params.cfg, scopedAgentId ? { agentId: scopedAgentId } : {});
	return (relPath) => {
		const identity = extractTranscriptIdentityFromSessionsMemoryHit(relPath);
		if (!identity) return false;
		const isQmdSessionPath = relPath.replace(/\\/g, "/").startsWith("qmd/");
		const normalizedScopedAgentId = normalizeLowercaseStringOrEmpty(scopedAgentId);
		const normalizedOwnerAgentId = normalizeLowercaseStringOrEmpty(identity.ownerAgentId);
		if (normalizedScopedAgentId && normalizedOwnerAgentId && normalizedOwnerAgentId !== normalizedScopedAgentId) return false;
		const archivedOwnerAgentId = Boolean(identity.archived && (identity.ownerAgentId && (!normalizedScopedAgentId || normalizedOwnerAgentId === normalizedScopedAgentId) || isQmdSessionPath && scopedAgentId)) ? identity.ownerAgentId ?? scopedAgentId : void 0;
		const liveKeys = identity.liveStem ? resolveTranscriptStemToSessionKeys({
			store: combinedSessionStore,
			stem: identity.liveStem,
			allowQmdSlugFallback: false
		}) : [];
		const keys = filterSessionKeysByScopedAgent({
			cfg: params.cfg,
			scopedAgentId,
			keys: liveKeys.length > 0 ? liveKeys : resolveTranscriptStemToSessionKeys({
				store: combinedSessionStore,
				stem: identity.stem,
				allowQmdSlugFallback: isQmdSessionPath && !identity.archived,
				...archivedOwnerAgentId ? { archivedOwnerAgentId } : {}
			})
		});
		if (!guard) return Boolean(scopedAgentId && keys.length > 0);
		return keys.some((key) => guard.check(key).allowed);
	};
}
function filterMemoryWikiSearchHitsWithSessionVisibility(params) {
	const next = [];
	for (const hit of params.hits) {
		if (hit.source !== "sessions") {
			next.push(hit);
			continue;
		}
		if (params.canReadSessionPath(hit.path)) next.push(hit);
	}
	return next;
}
function canReadSessionMemoryPath(params) {
	return filterMemoryWikiSearchHitsWithSessionVisibility({
		canReadSessionPath: params.canReadSessionPath,
		hits: [{
			path: params.relPath,
			startLine: 1,
			endLine: 1,
			score: 0,
			snippet: "",
			source: "sessions"
		}]
	}).length > 0;
}
async function searchWikiCorpus(params) {
	const digest = await readQueryDigestBundle(params.rootDir);
	const candidatePaths = digest ? buildDigestCandidatePaths({
		digest,
		query: params.query,
		maxResults: params.maxResults,
		mode: params.mode
	}) : [];
	const seenPaths = /* @__PURE__ */ new Set();
	const candidatePages = candidatePaths.length > 0 ? await readQueryableWikiPagesByPaths(params.rootDir, candidatePaths) : await readQueryableWikiPages(params.rootDir);
	for (const page of candidatePages) seenPaths.add(page.relativePath);
	const results = candidatePages.map((page) => toWikiSearchResult(page, params.query, params.mode)).filter((page) => page.score > 0);
	if (candidatePaths.length === 0 || results.length >= params.maxResults) return results;
	const remainingPaths = (await listWikiMarkdownFiles(params.rootDir)).filter((relativePath) => !seenPaths.has(relativePath));
	const remainingPages = await readQueryableWikiPagesByPaths(params.rootDir, remainingPaths);
	return [...results, ...remainingPages.map((page) => toWikiSearchResult(page, params.query, params.mode)).filter((page) => page.score > 0)];
}
function resolveDigestClaimLookup(digest, lookup) {
	const claimId = lookup.trim().replace(/^claim:/i, "");
	return digest.claims.find((claim) => claim.id === claimId)?.pagePath ?? null;
}
function resolveQueryableWikiPageByLookup(pages, lookup) {
	const key = normalizeLookupKey(lookup);
	const withExtension = key.endsWith(".md") ? key : `${key}.md`;
	return pages.find((page) => page.relativePath === key) ?? pages.find((page) => page.relativePath === withExtension) ?? pages.find((page) => page.relativePath.replace(/\.md$/i, "") === key) ?? pages.find((page) => path.basename(page.relativePath, ".md") === key) ?? pages.find((page) => page.id === key) ?? null;
}
async function searchMemoryWiki(params) {
	const effectiveConfig = applySearchOverrides(params.config, params);
	assertSessionVisibilityAppConfig({
		config: effectiveConfig,
		appConfig: params.appConfig,
		...params.agentId ? { agentId: params.agentId } : {},
		agentSessionKey: params.agentSessionKey,
		sandboxed: params.sandboxed,
		operation: "wiki_search"
	});
	await initializeMemoryWikiVault(effectiveConfig);
	const maxResults = Math.max(1, params.maxResults ?? 10);
	const mode = params.mode ?? "auto";
	const wikiResults = shouldSearchWiki(effectiveConfig) ? await searchWikiCorpus({
		rootDir: effectiveConfig.vault.path,
		query: params.query,
		maxResults,
		mode
	}) : [];
	const sharedMemoryManager = shouldSearchSharedMemory(effectiveConfig, params.appConfig) ? await resolveActiveMemoryManager({
		appConfig: params.appConfig,
		agentId: params.agentId,
		agentSessionKey: params.agentSessionKey
	}) : null;
	let rawMemoryResults = sharedMemoryManager ? await sharedMemoryManager.search(params.query, { maxResults }) : [];
	if (params.appConfig && shouldEnforceSessionVisibility(params) && rawMemoryResults.some((hit) => hit.source === "sessions")) rawMemoryResults = await filterMemoryWikiSearchHitsBySessionVisibility({
		cfg: params.appConfig,
		agentId: params.agentId,
		requesterSessionKey: params.agentSessionKey,
		sandboxed: params.sandboxed === true,
		hits: rawMemoryResults
	});
	return mergeWikiSearchCorpusResults({
		wikiResults,
		memoryResults: rawMemoryResults.map((result) => toMemoryWikiSearchResult(result, mode)),
		maxResults,
		balanceCorpora: effectiveConfig.search.corpus === "all"
	});
}
async function getMemoryWikiPage(params) {
	const effectiveConfig = applySearchOverrides(params.config, params);
	assertSessionVisibilityAppConfig({
		config: effectiveConfig,
		appConfig: params.appConfig,
		...params.agentId ? { agentId: params.agentId } : {},
		agentSessionKey: params.agentSessionKey,
		sandboxed: params.sandboxed,
		operation: "wiki_get"
	});
	await initializeMemoryWikiVault(effectiveConfig);
	const fromLine = Math.max(1, params.fromLine ?? 1);
	const lineCount = Math.max(1, params.lineCount ?? 200);
	if (shouldSearchWiki(effectiveConfig)) {
		const digest = await readQueryDigestBundle(effectiveConfig.vault.path);
		const digestClaimPagePath = digest ? resolveDigestClaimLookup(digest, params.lookup) : null;
		const digestLookupPage = digestClaimPagePath ? (await readQueryableWikiPagesByPaths(effectiveConfig.vault.path, [digestClaimPagePath]))[0] ?? null : null;
		const pages = digestLookupPage ? [digestLookupPage] : await readQueryableWikiPages(effectiveConfig.vault.path);
		const page = digestLookupPage ?? resolveQueryableWikiPageByLookup(pages, params.lookup);
		if (page) {
			const lines = parseWikiMarkdown(page.raw).body.split(/\r?\n/);
			const totalLines = lines.length;
			const slice = lines.slice(fromLine - 1, fromLine - 1 + lineCount).join("\n");
			const truncated = fromLine - 1 + lineCount < totalLines;
			return {
				corpus: "wiki",
				path: page.relativePath,
				title: page.title,
				kind: page.kind,
				content: slice,
				fromLine,
				lineCount,
				totalLines,
				truncated,
				...buildWikiResultMetadata(page)
			};
		}
	}
	if (!shouldSearchSharedMemory(effectiveConfig, params.appConfig)) return null;
	const manager = await resolveActiveMemoryManager({
		appConfig: params.appConfig,
		agentId: params.agentId,
		agentSessionKey: params.agentSessionKey
	});
	if (!manager) return null;
	const lookupCandidates = buildLookupCandidates(params.lookup);
	const canReadSessionPath = params.appConfig && shouldEnforceSessionVisibility(params) && lookupCandidates.some((relPath) => isSessionMemoryPath(relPath)) ? await createSessionMemoryPathVisibilityChecker({
		cfg: params.appConfig,
		agentId: params.agentId,
		requesterSessionKey: params.agentSessionKey,
		sandboxed: params.sandboxed === true
	}) : null;
	for (const relPath of lookupCandidates) {
		if (canReadSessionPath && isSessionMemoryPath(relPath) && !canReadSessionMemoryPath({
			canReadSessionPath,
			relPath
		})) continue;
		try {
			const result = await manager.readFile({
				relPath,
				from: fromLine,
				lines: lineCount
			});
			return {
				corpus: "memory",
				path: result.path,
				title: buildMemorySearchTitle(result.path),
				kind: "memory",
				content: result.text,
				fromLine,
				lineCount
			};
		} catch {
			continue;
		}
	}
	return null;
}
//#endregion
//#region extensions/memory-wiki/src/apply.ts
const GENERATED_START = "<!-- openclaw:wiki:generated:start -->";
const GENERATED_END = "<!-- openclaw:wiki:generated:end -->";
const HUMAN_START = "<!-- openclaw:human:start -->";
const HUMAN_END = "<!-- openclaw:human:end -->";
function normalizeMemoryWikiMutationInput(rawParams) {
	const params = rawParams;
	if (params.op === "create_synthesis") {
		if (!params.title?.trim()) throw new Error("wiki mutation requires title for create_synthesis.");
		if (!params.body?.trim()) throw new Error("wiki mutation requires body for create_synthesis.");
		if (!params.sourceIds || params.sourceIds.length === 0) throw new Error("wiki mutation requires at least one sourceId for create_synthesis.");
		return {
			op: "create_synthesis",
			title: params.title,
			body: params.body,
			sourceIds: params.sourceIds,
			...Array.isArray(params.claims) ? { claims: normalizeWikiClaims(params.claims) } : {},
			...params.contradictions ? { contradictions: params.contradictions } : {},
			...params.questions ? { questions: params.questions } : {},
			...typeof params.confidence === "number" ? { confidence: params.confidence } : {},
			...params.status ? { status: params.status } : {}
		};
	}
	if (!params.lookup?.trim()) throw new Error("wiki mutation requires lookup for update_metadata.");
	return {
		op: "update_metadata",
		lookup: params.lookup,
		...params.sourceIds ? { sourceIds: params.sourceIds } : {},
		...Array.isArray(params.claims) ? { claims: normalizeWikiClaims(params.claims) } : {},
		...params.contradictions ? { contradictions: params.contradictions } : {},
		...params.questions ? { questions: params.questions } : {},
		...params.confidence !== void 0 ? { confidence: params.confidence } : {},
		...params.status ? { status: params.status } : {}
	};
}
function normalizeUniqueStrings(values) {
	if (!values) return;
	return values.map((value) => value.trim()).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
}
function ensureHumanNotesBlock(body) {
	if (body.includes(HUMAN_START) && body.includes(HUMAN_END)) return body;
	const trimmed = body.trimEnd();
	return `${trimmed.length > 0 ? `${trimmed}\n\n` : ""}## Notes\n${HUMAN_START}\n${HUMAN_END}\n`;
}
function buildSynthesisBody(params) {
	return ensureHumanNotesBlock(replaceManagedMarkdownBlock({
		original: params.originalBody?.trim().length ? params.originalBody : `# ${params.title}\n\n## Notes\n${HUMAN_START}\n${HUMAN_END}\n`,
		heading: "## Summary",
		startMarker: GENERATED_START,
		endMarker: GENERATED_END,
		body: params.generatedBody
	}));
}
async function writeWikiPage(params) {
	const root$1 = await root(params.rootDir);
	const rendered = withTrailingNewline(renderWikiMarkdown({
		frontmatter: params.frontmatter,
		body: params.body
	}));
	if (await root$1.readText(params.relativePath).catch(() => "") === rendered) return false;
	await root$1.write(params.relativePath, rendered);
	return true;
}
async function resolveWritablePage(params) {
	return resolveQueryableWikiPageByLookup(await readQueryableWikiPages(params.config.vault.path), params.lookup);
}
async function applyCreateSynthesisMutation(params) {
	const slug = slugifyWikiSegment(params.mutation.title);
	const pagePath = path.join("syntheses", `${slug}.md`).replace(/\\/g, "/");
	const parsed = parseWikiMarkdown(await (await root(params.config.vault.path)).readText(pagePath).catch(() => ""));
	const pageId = typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.trim() || `synthesis.${slug}`;
	return {
		changed: await writeWikiPage({
			rootDir: params.config.vault.path,
			relativePath: pagePath,
			frontmatter: {
				...parsed.frontmatter,
				pageType: "synthesis",
				id: pageId,
				title: params.mutation.title,
				sourceIds: normalizeSourceIds(params.mutation.sourceIds),
				...params.mutation.claims ? { claims: normalizeWikiClaims(params.mutation.claims) } : {},
				...normalizeUniqueStrings(params.mutation.contradictions) ? { contradictions: normalizeUniqueStrings(params.mutation.contradictions) } : {},
				...normalizeUniqueStrings(params.mutation.questions) ? { questions: normalizeUniqueStrings(params.mutation.questions) } : {},
				...typeof params.mutation.confidence === "number" ? { confidence: params.mutation.confidence } : {},
				status: params.mutation.status?.trim() || "active",
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			},
			body: buildSynthesisBody({
				title: params.mutation.title,
				originalBody: parsed.body,
				generatedBody: params.mutation.body.trim()
			})
		}),
		pagePath,
		pageId
	};
}
function buildUpdatedFrontmatter(params) {
	const frontmatter = {
		...params.original,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	if (params.mutation.sourceIds) frontmatter.sourceIds = normalizeSourceIds(params.mutation.sourceIds);
	if (params.mutation.claims) {
		const claims = normalizeWikiClaims(params.mutation.claims);
		if (claims.length > 0) frontmatter.claims = claims;
		else delete frontmatter.claims;
	}
	if (params.mutation.contradictions) {
		const contradictions = normalizeUniqueStrings(params.mutation.contradictions) ?? [];
		if (contradictions.length > 0) frontmatter.contradictions = contradictions;
		else delete frontmatter.contradictions;
	}
	if (params.mutation.questions) {
		const questions = normalizeUniqueStrings(params.mutation.questions) ?? [];
		if (questions.length > 0) frontmatter.questions = questions;
		else delete frontmatter.questions;
	}
	if (params.mutation.confidence === null) delete frontmatter.confidence;
	else if (typeof params.mutation.confidence === "number") frontmatter.confidence = params.mutation.confidence;
	if (params.mutation.status?.trim()) frontmatter.status = params.mutation.status.trim();
	return frontmatter;
}
async function applyUpdateMetadataMutation(params) {
	const page = await resolveWritablePage({
		config: params.config,
		lookup: params.mutation.lookup
	});
	if (!page) throw new Error(`Wiki page not found: ${params.mutation.lookup}`);
	const parsed = parseWikiMarkdown(page.raw);
	return {
		changed: await writeWikiPage({
			rootDir: params.config.vault.path,
			relativePath: page.relativePath,
			frontmatter: buildUpdatedFrontmatter({
				original: parsed.frontmatter,
				mutation: params.mutation
			}),
			body: parsed.body
		}),
		pagePath: page.relativePath,
		...page.id ? { pageId: page.id } : {}
	};
}
async function applyMemoryWikiMutation(params) {
	await initializeMemoryWikiVault(params.config);
	const result = params.mutation.op === "create_synthesis" ? await applyCreateSynthesisMutation({
		config: params.config,
		mutation: params.mutation
	}) : await applyUpdateMetadataMutation({
		config: params.config,
		mutation: params.mutation
	});
	const compile = await compileMemoryWikiVault(params.config);
	return {
		changed: result.changed,
		operation: params.mutation.op,
		pagePath: result.pagePath,
		...result.pageId ? { pageId: result.pageId } : {},
		compile
	};
}
//#endregion
//#region extensions/memory-wiki/src/chatgpt-import.ts
const CHATGPT_PREFERENCE_SIGNAL_RE = /\b(prefer|prefers|preference|want|wants|need|needs|avoid|avoids|hate|hates|love|loves|default to|should default to|always use|don't want|does not want|likes|dislikes)\b/i;
const HUMAN_START_MARKER = "<!-- openclaw:human:start -->";
const HUMAN_END_MARKER = "<!-- openclaw:human:end -->";
const CHATGPT_RISK_RULES = [
	{
		label: "relationships",
		pattern: /\b(relationship|dating|breakup|jealous|sex|intimacy|partner|apology|trust|boyfriend|girlfriend|husband|wife)\b/i
	},
	{
		label: "health",
		pattern: /\b(supplement|medication|diagnosis|symptom|therapy|depression|anxiety|mri|migraine|injury|pain|cortisol|sleep)\b/i
	},
	{
		label: "legal_tax",
		pattern: /\b(contract|tax|legal|law|lawsuit|visa|immigration|license|insurance|claim|non-residence|residency)\b/i
	},
	{
		label: "finance",
		pattern: /\b(investment|invest|portfolio|dividend|yield|coupon|valuation|mortgage|loan|crypto|covered call|call option|put option)\b/i
	},
	{
		label: "drugs",
		pattern: /\b(vape|weed|cannabis|nicotine|opioid|ketamine)\b/i
	}
];
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function normalizeWhitespace(value) {
	return value.trim().replace(/\s+/g, " ");
}
function resolveConversationSourcePath(exportInputPath) {
	const resolved = path.resolve(exportInputPath);
	return {
		exportPath: resolved,
		conversationsPath: resolved.endsWith(".json") ? resolved : path.join(resolved, "conversations.json")
	};
}
async function loadConversations(exportInputPath) {
	const { exportPath, conversationsPath } = resolveConversationSourcePath(exportInputPath);
	const raw = await fs$1.readFile(conversationsPath, "utf8");
	const parsed = JSON.parse(raw);
	if (Array.isArray(parsed)) return {
		exportPath,
		conversationsPath,
		conversations: parsed.filter((entry) => asRecord(entry) !== null)
	};
	const record = asRecord(parsed);
	if (record) {
		for (const value of Object.values(record)) if (Array.isArray(value)) return {
			exportPath,
			conversationsPath,
			conversations: value.filter((entry) => asRecord(entry) !== null)
		};
	}
	throw new Error(`Unrecognized ChatGPT conversations export format: ${conversationsPath}`);
}
function isoFromUnix(raw) {
	if (typeof raw !== "number" && typeof raw !== "string") return;
	const numeric = Number(raw);
	if (!Number.isFinite(numeric)) return;
	return (/* @__PURE__ */ new Date(numeric * 1e3)).toISOString();
}
function cleanMessageText(value) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if ((trimmed.includes("asset_pointer") || trimmed.includes("image_asset_pointer") || trimmed.includes("dalle") || trimmed.includes("file_service")) && trimmed.length > 40) return "";
	if (trimmed.startsWith("{") && trimmed.length > 80 && (trimmed.includes(":") || trimmed.includes("content_type"))) {
		const textMatch = trimmed.match(/["']text["']\s*:\s*(["'])(.+?)\1/s);
		return textMatch?.[2] ? normalizeWhitespace(textMatch[2]) : "";
	}
	return trimmed;
}
function extractMessageText(message) {
	const content = asRecord(message.content);
	if (content) {
		const parts = content.parts;
		if (Array.isArray(parts)) {
			const collected = [];
			for (const part of parts) {
				if (typeof part === "string") {
					const cleaned = cleanMessageText(part);
					if (cleaned) collected.push(cleaned);
					continue;
				}
				const partRecord = asRecord(part);
				if (partRecord && typeof partRecord.text === "string" && partRecord.text.trim()) collected.push(partRecord.text.trim());
			}
			return collected.join("\n").trim();
		}
		if (typeof content.text === "string") return cleanMessageText(content.text);
	}
	return typeof message.text === "string" ? cleanMessageText(message.text) : "";
}
function activeBranchMessages(conversation) {
	const mapping = asRecord(conversation.mapping);
	if (!mapping) return [];
	let currentNode = typeof conversation.current_node === "string" ? conversation.current_node : void 0;
	const seen = /* @__PURE__ */ new Set();
	const chain = [];
	while (currentNode && !seen.has(currentNode)) {
		seen.add(currentNode);
		const node = asRecord(mapping[currentNode]);
		if (!node) break;
		const message = asRecord(node.message);
		if (message) {
			const author = asRecord(message.author);
			const role = typeof author?.role === "string" ? author.role : "unknown";
			const text = extractMessageText(message);
			if (text) chain.push({
				role,
				text
			});
		}
		currentNode = typeof node.parent === "string" ? node.parent : void 0;
	}
	return chain.toReversed();
}
function inferRisk(title, sampleText) {
	const blob = `${title}\n${sampleText}`.toLowerCase();
	const reasons = CHATGPT_RISK_RULES.filter((rule) => rule.pattern.test(blob)).map((rule) => rule.label);
	if (reasons.length > 0) return {
		level: "high",
		reasons: [...new Set(reasons)]
	};
	if (/\b(career|job|salary|interview|offer|resume|cover letter)\b/i.test(blob)) return {
		level: "medium",
		reasons: ["work_career"]
	};
	return {
		level: "low",
		reasons: []
	};
}
function inferLabels(title, sampleText) {
	const blob = `${title}\n${sampleText}`.toLowerCase();
	const labels = new Set(["domain/personal"]);
	const addAreaTopic = (area, topics) => {
		labels.add(area);
		for (const topic of topics) labels.add(topic);
	};
	const hasTranslation = /\b(translate|translation|traduc\w*|traducc\w*|traduç\w*|traducci[oó]n|traduccio|traducció|traduzione)\b/i.test(blob);
	const hasLearning = /\b(anki|flashcards?|grammar|conjugat\w*|declension|pronunciation|vocab(?:ular(?:y|io))?|lesson|tutor|teacher|jlpt|kanji|hiragana|katakana|study|learn|practice)\b/i.test(blob);
	const hasLanguageName = /\b(japanese|portuguese|catalan|castellano|espa[nñ]ol|franc[eé]s|french|italian|german|spanish)\b/i.test(blob);
	if (hasTranslation) labels.add("topic/translation");
	if (hasLearning || hasLanguageName && /\b(learn|study|practice|lesson|tutor|grammar)\b/i.test(blob)) addAreaTopic("area/language-learning", ["topic/language-learning"]);
	if (/\b(hike|trail|hotel|flight|trip|travel|airport|itinerary|booking|airbnb|train|stay)\b/i.test(blob)) {
		labels.add("area/travel");
		labels.add("topic/travel");
	}
	if (/\b(recipe|cook|cooking|bread|sourdough|pizza|espresso|coffee|mousse|cast iron|meatballs?)\b/i.test(blob)) addAreaTopic("area/cooking", ["topic/cooking"]);
	if (/\b(garden|orchard|plant|soil|compost|agroforestry|permaculture|mulch|beds?|irrigation|seeds?)\b/i.test(blob)) addAreaTopic("area/gardening", ["topic/gardening"]);
	if (/\b(dating|relationship|partner|jealous|breakup|trust)\b/i.test(blob)) addAreaTopic("area/relationships", ["topic/relationships"]);
	if (/\b(investment|invest|portfolio|dividend|yield|coupon|valuation|return|mortgage|loan|kraken|crypto|covered call|call option|put option|option chain|bond|stocks?)\b/i.test(blob)) addAreaTopic("area/finance", ["topic/finance"]);
	if (/\b(contract|mou|tax|impuesto|legal|law|lawsuit|visa|immigration|license|licencia|dispute|claim|insurance|non-residence|residency)\b/i.test(blob)) addAreaTopic("area/legal-tax", ["topic/legal-tax"]);
	if (/\b(supplement|medication|diagnos(?:is|e)|symptom|therapy|depress(?:ion|ed)|anxiet(?:y|ies)|mri|migraine|injur(?:y|ies)|pain|cortisol|sleep|dentist|dermatolog(?:ist|y))\b/i.test(blob)) addAreaTopic("area/health", ["topic/health"]);
	if (/\b(book (an )?appointment|rebook|open (a )?new account|driving test|exam|gestor(?:a)?|itv)\b/i.test(blob)) addAreaTopic("area/life-admin", ["topic/life-admin"]);
	if (/\b(frc|robot|robotics|wpilib|limelight|chiefdelphi)\b/i.test(blob)) addAreaTopic("area/work", ["topic/robotics"]);
	else if (/\b(docker|git|python|node|npm|pip|sql|postgres|api|bug|stack trace|permission denied)\b/i.test(blob)) addAreaTopic("area/work", ["topic/software"]);
	else if (/\b(job|interview|cover letter|resume|cv)\b/i.test(blob)) addAreaTopic("area/work", ["topic/career"]);
	if (/\b(wifi|wi-fi|starlink|router|mesh|network|orbi|milesight|coverage)\b/i.test(blob)) addAreaTopic("area/home", ["topic/home-infrastructure"]);
	if (/\b(p38|range rover|porsche|bmw|bobcat|excavator|auger|trailer|chainsaw|stihl)\b/i.test(blob)) addAreaTopic("area/vehicles", ["topic/vehicles"]);
	if (![...labels].some((label) => label.startsWith("area/"))) labels.add("area/other");
	return [...labels];
}
function collectPreferenceSignals(userTexts) {
	const signals = [];
	const seen = /* @__PURE__ */ new Set();
	for (const text of userTexts.slice(0, 25)) for (const rawLine of text.split(/\r?\n/)) {
		const line = normalizeWhitespace(rawLine);
		if (!line || !CHATGPT_PREFERENCE_SIGNAL_RE.test(line)) continue;
		const key = line.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		signals.push(line);
		if (signals.length >= 10) return signals;
	}
	return signals;
}
function buildTranscript(messages) {
	if (messages.length === 0) return "_No active-branch transcript could be reconstructed._";
	return messages.flatMap((message) => [
		`### ${message.role[0]?.toUpperCase() ?? "U"}${message.role.slice(1)}`,
		"",
		message.text,
		""
	]).join("\n").trim();
}
function resolveConversationPagePath(record) {
	const conversationSlug = record.conversationId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
	const pageId = `source.chatgpt.${conversationSlug || createHash("sha1").update(record.conversationId).digest("hex").slice(0, 12)}`;
	const datePrefix = record.createdAt?.slice(0, 10) ?? "undated";
	const shortId = conversationSlug.slice(0, 8) || "export";
	return {
		pageId,
		pagePath: path.join("sources", `chatgpt-${datePrefix}-${conversationSlug || shortId}.md`).replace(/\\/g, "/")
	};
}
function toConversationRecord(conversation, sourcePath) {
	const conversationId = typeof conversation.conversation_id === "string" ? conversation.conversation_id.trim() : "";
	if (!conversationId) return null;
	const title = typeof conversation.title === "string" && conversation.title.trim() ? conversation.title.trim() : "Untitled conversation";
	const transcript = activeBranchMessages(conversation);
	const userTexts = transcript.filter((entry) => entry.role === "user").map((entry) => entry.text);
	const assistantTexts = transcript.filter((entry) => entry.role === "assistant");
	const sampleText = userTexts.slice(0, 6).join("\n");
	const risk = inferRisk(title, sampleText);
	const labels = inferLabels(title, sampleText);
	const { pageId, pagePath } = resolveConversationPagePath({
		conversationId,
		createdAt: isoFromUnix(conversation.create_time)
	});
	return {
		conversationId,
		title,
		createdAt: isoFromUnix(conversation.create_time),
		updatedAt: isoFromUnix(conversation.update_time) ?? isoFromUnix(conversation.create_time),
		sourcePath,
		pageId,
		pagePath,
		labels,
		risk,
		userMessageCount: userTexts.length,
		assistantMessageCount: assistantTexts.length,
		preferenceSignals: risk.level === "low" ? collectPreferenceSignals(userTexts) : [],
		firstUserLine: userTexts[0]?.split(/\r?\n/)[0]?.trim(),
		lastUserLine: userTexts.at(-1)?.split(/\r?\n/)[0]?.trim(),
		transcript
	};
}
function renderConversationPage(record) {
	const autoDigestLines = record.risk.level === "low" ? [
		`- User messages: ${record.userMessageCount}`,
		`- Assistant messages: ${record.assistantMessageCount}`,
		...record.firstUserLine ? [`- First user line: ${record.firstUserLine}`] : [],
		...record.lastUserLine ? [`- Last user line: ${record.lastUserLine}`] : [],
		...record.preferenceSignals.length > 0 ? ["- Preference signals:", ...record.preferenceSignals.map((line) => `  - ${line}`)] : ["- Preference signals: none detected"]
	] : ["- Auto digest withheld from durable-candidate generation until reviewed.", `- Risk reasons: ${record.risk.reasons.length > 0 ? record.risk.reasons.join(", ") : "none recorded"}`];
	return renderWikiMarkdown({
		frontmatter: {
			pageType: "source",
			id: record.pageId,
			title: `ChatGPT Export: ${record.title}`,
			sourceType: "chatgpt-export",
			sourceSystem: "chatgpt",
			sourcePath: record.sourcePath,
			conversationId: record.conversationId,
			riskLevel: record.risk.level,
			riskReasons: record.risk.reasons,
			labels: record.labels,
			status: "draft",
			...record.createdAt ? { createdAt: record.createdAt } : {},
			...record.updatedAt ? { updatedAt: record.updatedAt } : {}
		},
		body: [
			`# ChatGPT Export: ${record.title}`,
			"",
			"## Source",
			`- Conversation id: \`${record.conversationId}\``,
			`- Export file: \`${record.sourcePath}\``,
			...record.createdAt ? [`- Created: ${record.createdAt}`] : [],
			...record.updatedAt ? [`- Updated: ${record.updatedAt}`] : [],
			"",
			"## Auto Triage",
			`- Risk level: \`${record.risk.level}\``,
			`- Labels: ${record.labels.join(", ")}`,
			`- Active-branch messages: ${record.transcript.length}`,
			"",
			"## Auto Digest",
			...autoDigestLines,
			"",
			"## Active Branch Transcript",
			buildTranscript(record.transcript),
			"",
			"## Notes",
			HUMAN_START_MARKER,
			HUMAN_END_MARKER,
			""
		].join("\n")
	});
}
function replaceSimpleManagedBlock(params) {
	const escapedStart = params.startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedEnd = params.endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const blockPattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`);
	return params.original.replace(blockPattern, params.replacement);
}
function extractSimpleManagedBlock(params) {
	const escapedStart = params.startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedEnd = params.endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const blockPattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`);
	return params.body.match(blockPattern)?.[0] ?? null;
}
function extractManagedBlockBody(params) {
	const escapedStart = params.startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedEnd = params.endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const blockPattern = new RegExp(`${escapedStart}\\n?([\\s\\S]*?)\\n?${escapedEnd}`);
	const captured = params.body.match(blockPattern)?.[1];
	return typeof captured === "string" ? captured.trim() : null;
}
function preserveExistingPageBlocks(rendered, existing) {
	if (!existing.trim()) return withTrailingNewline(rendered);
	const parsedExisting = parseWikiMarkdown(existing);
	const parsedRendered = parseWikiMarkdown(rendered);
	let nextBody = parsedRendered.body;
	const humanBlock = extractSimpleManagedBlock({
		body: parsedExisting.body,
		startMarker: HUMAN_START_MARKER,
		endMarker: HUMAN_END_MARKER
	});
	if (humanBlock) nextBody = replaceSimpleManagedBlock({
		original: nextBody,
		startMarker: HUMAN_START_MARKER,
		endMarker: HUMAN_END_MARKER,
		replacement: humanBlock
	});
	const relatedBody = extractManagedBlockBody({
		body: parsedExisting.body,
		startMarker: WIKI_RELATED_START_MARKER,
		endMarker: WIKI_RELATED_END_MARKER
	});
	if (relatedBody) nextBody = replaceManagedMarkdownBlock({
		original: nextBody,
		heading: "## Related",
		startMarker: WIKI_RELATED_START_MARKER,
		endMarker: WIKI_RELATED_END_MARKER,
		body: relatedBody
	});
	return withTrailingNewline(renderWikiMarkdown({
		frontmatter: parsedRendered.frontmatter,
		body: nextBody
	}));
}
function buildRunId(exportPath, nowIso) {
	const seed = `${exportPath}:${nowIso}:${Math.random()}`;
	return `chatgpt-${createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}
function resolveImportRunsDir(vaultRoot) {
	return path.join(vaultRoot, ".openclaw-wiki", "import-runs");
}
function resolveImportRunPath(vaultRoot, runId) {
	return path.join(resolveImportRunsDir(vaultRoot), `${runId}.json`);
}
function normalizeConversationActions(records, operations) {
	return records.map((record) => ({
		conversationId: record.conversationId,
		title: record.title,
		pagePath: record.pagePath,
		operation: operations.get(record.pagePath) ?? "skip",
		riskLevel: record.risk.level,
		labels: record.labels,
		userMessageCount: record.userMessageCount,
		assistantMessageCount: record.assistantMessageCount,
		preferenceSignals: record.preferenceSignals
	}));
}
async function writeImportRunRecord(vaultRoot, record) {
	await writeJsonFileAtomically(resolveImportRunPath(vaultRoot, record.runId), record);
}
async function readImportRunRecord(vaultRoot, runId) {
	const recordPath = resolveImportRunPath(vaultRoot, runId);
	const raw = await fs$1.readFile(recordPath, "utf8");
	return JSON.parse(raw);
}
async function writeTrackedImportPage(params) {
	const absolutePath = path.join(params.vaultRoot, params.relativePath);
	const existing = await fs$1.readFile(absolutePath, "utf8").catch(() => "");
	const rendered = preserveExistingPageBlocks(params.content, existing);
	if (existing === rendered) return "skip";
	await fs$1.mkdir(path.dirname(absolutePath), { recursive: true });
	if (!existing) {
		await fs$1.writeFile(absolutePath, rendered, "utf8");
		params.record.createdPaths.push(params.relativePath);
		return "create";
	}
	const snapshotHash = createHash("sha1").update(params.relativePath).digest("hex").slice(0, 12);
	const snapshotRelativePath = path.join("snapshots", `${snapshotHash}.md`).replace(/\\/g, "/");
	const snapshotAbsolutePath = path.join(params.runDir, snapshotRelativePath);
	await fs$1.mkdir(path.dirname(snapshotAbsolutePath), { recursive: true });
	await fs$1.writeFile(snapshotAbsolutePath, existing, "utf8");
	await fs$1.writeFile(absolutePath, rendered, "utf8");
	params.record.updatedPaths.push({
		path: params.relativePath,
		snapshotPath: snapshotRelativePath
	});
	return "update";
}
async function importChatGptConversations(params) {
	await initializeMemoryWikiVault(params.config, { nowMs: params.nowMs });
	const { exportPath, conversationsPath, conversations } = await loadConversations(params.exportPath);
	const records = conversations.map((conversation) => toConversationRecord(conversation, conversationsPath)).filter((entry) => entry !== null).toSorted((left, right) => left.pagePath.localeCompare(right.pagePath));
	const operations = /* @__PURE__ */ new Map();
	let createdCount = 0;
	let updatedCount = 0;
	let skippedCount = 0;
	let runId;
	const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();
	let importRunRecord;
	let importRunDir = "";
	if (!params.dryRun) {
		runId = buildRunId(exportPath, nowIso);
		importRunDir = path.join(resolveImportRunsDir(params.config.vault.path), runId);
		importRunRecord = {
			version: 1,
			runId,
			importType: "chatgpt",
			exportPath,
			sourcePath: conversationsPath,
			appliedAt: nowIso,
			conversationCount: records.length,
			createdCount: 0,
			updatedCount: 0,
			skippedCount: 0,
			createdPaths: [],
			updatedPaths: []
		};
	}
	for (const record of records) {
		const rendered = renderConversationPage(record);
		const absolutePath = path.join(params.config.vault.path, record.pagePath);
		const existing = await fs$1.readFile(absolutePath, "utf8").catch(() => "");
		const operation = existing === preserveExistingPageBlocks(rendered, existing) ? "skip" : existing ? "update" : "create";
		operations.set(record.pagePath, operation);
		if (operation === "create") createdCount += 1;
		else if (operation === "update") updatedCount += 1;
		else skippedCount += 1;
		if (!params.dryRun && importRunRecord) await writeTrackedImportPage({
			vaultRoot: params.config.vault.path,
			runDir: importRunDir,
			relativePath: record.pagePath,
			content: rendered,
			record: importRunRecord
		});
	}
	let indexUpdatedFiles = [];
	if (!params.dryRun && importRunRecord) {
		importRunRecord.createdCount = createdCount;
		importRunRecord.updatedCount = updatedCount;
		importRunRecord.skippedCount = skippedCount;
		if (importRunRecord.createdPaths.length > 0 || importRunRecord.updatedPaths.length > 0) {
			indexUpdatedFiles = (await compileMemoryWikiVault(params.config)).updatedFiles;
			await writeImportRunRecord(params.config.vault.path, importRunRecord);
			await appendMemoryWikiLog(params.config.vault.path, {
				type: "ingest",
				timestamp: nowIso,
				details: {
					sourceType: "chatgpt-export",
					runId: importRunRecord.runId,
					exportPath,
					sourcePath: conversationsPath,
					conversationCount: records.length,
					createdCount: importRunRecord.createdPaths.length,
					updatedCount: importRunRecord.updatedPaths.length,
					skippedCount
				}
			});
		} else runId = void 0;
	}
	return {
		dryRun: Boolean(params.dryRun),
		exportPath,
		sourcePath: conversationsPath,
		conversationCount: records.length,
		createdCount,
		updatedCount,
		skippedCount,
		actions: normalizeConversationActions(records, operations),
		pagePaths: records.map((record) => record.pagePath),
		...runId ? { runId } : {},
		indexUpdatedFiles
	};
}
async function rollbackChatGptImportRun(params) {
	await initializeMemoryWikiVault(params.config);
	const record = await readImportRunRecord(params.config.vault.path, params.runId);
	if (record.rolledBackAt) return {
		runId: record.runId,
		removedCount: 0,
		restoredCount: 0,
		pagePaths: [...record.createdPaths, ...record.updatedPaths.map((entry) => entry.path)].toSorted((left, right) => left.localeCompare(right)),
		indexUpdatedFiles: [],
		alreadyRolledBack: true
	};
	let removedCount = 0;
	for (const relativePath of record.createdPaths) {
		await fs$1.rm(path.join(params.config.vault.path, relativePath), { force: true }).catch(() => void 0);
		removedCount += 1;
	}
	let restoredCount = 0;
	const runDir = path.join(resolveImportRunsDir(params.config.vault.path), record.runId);
	for (const entry of record.updatedPaths) {
		if (!entry.snapshotPath) continue;
		const snapshotPath = path.join(runDir, entry.snapshotPath);
		const snapshot = await fs$1.readFile(snapshotPath, "utf8");
		const targetPath = path.join(params.config.vault.path, entry.path);
		await fs$1.mkdir(path.dirname(targetPath), { recursive: true });
		await fs$1.writeFile(targetPath, snapshot, "utf8");
		restoredCount += 1;
	}
	const compile = await compileMemoryWikiVault(params.config);
	record.rolledBackAt = (/* @__PURE__ */ new Date()).toISOString();
	await writeImportRunRecord(params.config.vault.path, record);
	await appendMemoryWikiLog(params.config.vault.path, {
		type: "ingest",
		timestamp: record.rolledBackAt,
		details: {
			sourceType: "chatgpt-export",
			runId: record.runId,
			rollback: true,
			removedCount,
			restoredCount
		}
	});
	return {
		runId: record.runId,
		removedCount,
		restoredCount,
		pagePaths: [...record.createdPaths, ...record.updatedPaths.map((entry) => entry.path)].toSorted((left, right) => left.localeCompare(right)),
		indexUpdatedFiles: compile.updatedFiles,
		alreadyRolledBack: false
	};
}
//#endregion
//#region extensions/memory-wiki/src/ingest.ts
function resolveSourceTitle(sourcePath, explicitTitle) {
	if (explicitTitle?.trim()) return explicitTitle.trim();
	return path.basename(sourcePath, path.extname(sourcePath)).replace(/[-_]+/g, " ").trim();
}
function assertUtf8Text(buffer, sourcePath) {
	if (buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0)) throw new Error(`Cannot ingest binary file as markdown source: ${sourcePath}`);
	return buffer.toString("utf8");
}
async function ingestMemoryWikiSource(params) {
	await initializeMemoryWikiVault(params.config, { nowMs: params.nowMs });
	const sourcePath = path.resolve(params.inputPath);
	const buffer = await fs$1.readFile(sourcePath);
	const content = assertUtf8Text(buffer, sourcePath);
	const title = resolveSourceTitle(sourcePath, params.title);
	const slug = slugifyWikiSegment(title);
	const pageId = `source.${slug}`;
	const pageRelativePath = path.join("sources", `${slug}.md`);
	const pagePath = path.join(params.config.vault.path, pageRelativePath);
	const created = !await pathExists(pagePath);
	const timestamp = new Date(params.nowMs ?? Date.now()).toISOString();
	const markdown = renderWikiMarkdown({
		frontmatter: {
			pageType: "source",
			id: pageId,
			title,
			sourceType: "local-file",
			sourcePath,
			ingestedAt: timestamp,
			updatedAt: timestamp,
			status: "active"
		},
		body: [
			`# ${title}`,
			"",
			"## Source",
			`- Type: \`local-file\``,
			`- Path: \`${sourcePath}\``,
			`- Bytes: ${buffer.byteLength}`,
			`- Updated: ${timestamp}`,
			"",
			"## Content",
			renderMarkdownFence(content, "text"),
			"",
			"## Notes",
			"<!-- openclaw:human:start -->",
			"<!-- openclaw:human:end -->",
			""
		].join("\n")
	});
	await fs$1.writeFile(pagePath, markdown, "utf8");
	await appendMemoryWikiLog(params.config.vault.path, {
		type: "ingest",
		timestamp,
		details: {
			inputPath: sourcePath,
			pageId,
			pagePath: pageRelativePath.split(path.sep).join("/"),
			bytes: buffer.byteLength,
			created
		}
	});
	const compile = await compileMemoryWikiVault(params.config);
	return {
		sourcePath,
		pageId,
		pagePath: pageRelativePath.split(path.sep).join("/"),
		title,
		bytes: buffer.byteLength,
		created,
		indexUpdatedFiles: compile.updatedFiles
	};
}
//#endregion
//#region extensions/memory-wiki/src/lint.ts
function toExpectedPageType(page) {
	return page.kind;
}
function collectBrokenLinkIssues(pages) {
	const validTargets = /* @__PURE__ */ new Set();
	for (const page of pages) {
		const withoutExtension = page.relativePath.replace(/\.md$/i, "");
		validTargets.add(page.relativePath);
		validTargets.add(withoutExtension);
		validTargets.add(path.basename(withoutExtension));
	}
	const issues = [];
	for (const page of pages) for (const linkTarget of page.linkTargets) if (!validTargets.has(linkTarget)) issues.push({
		severity: "warning",
		category: "links",
		code: "broken-wikilink",
		path: page.relativePath,
		message: `Broken wikilink target \`${linkTarget}\`.`
	});
	return issues;
}
function collectPageIssues(pages) {
	const issues = [];
	const pagesById = /* @__PURE__ */ new Map();
	const claimHealth = collectWikiClaimHealth(pages);
	for (const page of pages) {
		if (!page.id) issues.push({
			severity: "error",
			category: "structure",
			code: "missing-id",
			path: page.relativePath,
			message: "Missing `id` frontmatter."
		});
		else {
			const current = pagesById.get(page.id) ?? [];
			current.push(page);
			pagesById.set(page.id, current);
		}
		if (!page.pageType) issues.push({
			severity: "error",
			category: "structure",
			code: "missing-page-type",
			path: page.relativePath,
			message: "Missing `pageType` frontmatter."
		});
		else if (page.pageType !== toExpectedPageType(page)) issues.push({
			severity: "error",
			category: "structure",
			code: "page-type-mismatch",
			path: page.relativePath,
			message: `Expected pageType \`${toExpectedPageType(page)}\`, found \`${page.pageType}\`.`
		});
		if (!page.title.trim()) issues.push({
			severity: "error",
			category: "structure",
			code: "missing-title",
			path: page.relativePath,
			message: "Missing page title."
		});
		if (page.kind !== "source" && page.kind !== "report" && page.sourceIds.length === 0) issues.push({
			severity: "warning",
			category: "provenance",
			code: "missing-source-ids",
			path: page.relativePath,
			message: "Non-source page is missing `sourceIds` provenance."
		});
		if ((page.sourceType === "memory-bridge" || page.sourceType === "memory-bridge-events") && (!page.sourcePath || !page.bridgeRelativePath || !page.bridgeWorkspaceDir)) issues.push({
			severity: "warning",
			category: "provenance",
			code: "missing-import-provenance",
			path: page.relativePath,
			message: "Bridge-imported source page is missing `sourcePath`, `bridgeRelativePath`, or `bridgeWorkspaceDir` provenance."
		});
		if ((page.provenanceMode === "unsafe-local" || page.sourceType === "memory-unsafe-local") && (!page.sourcePath || !page.unsafeLocalConfiguredPath || !page.unsafeLocalRelativePath)) issues.push({
			severity: "warning",
			category: "provenance",
			code: "missing-import-provenance",
			path: page.relativePath,
			message: "Unsafe-local source page is missing `sourcePath`, `unsafeLocalConfiguredPath`, or `unsafeLocalRelativePath` provenance."
		});
		if (page.contradictions.length > 0) issues.push({
			severity: "warning",
			category: "contradictions",
			code: "contradiction-present",
			path: page.relativePath,
			message: `Page lists ${page.contradictions.length} contradiction${page.contradictions.length === 1 ? "" : "s"} to resolve.`
		});
		if (page.questions.length > 0) issues.push({
			severity: "warning",
			category: "open-questions",
			code: "open-question",
			path: page.relativePath,
			message: `Page lists ${page.questions.length} open question${page.questions.length === 1 ? "" : "s"}.`
		});
		if (typeof page.confidence === "number" && page.confidence < .5) issues.push({
			severity: "warning",
			category: "quality",
			code: "low-confidence",
			path: page.relativePath,
			message: `Page confidence is low (${page.confidence.toFixed(2)}).`
		});
		const freshness = assessPageFreshness(page);
		if (page.kind !== "report" && (freshness.level === "stale" || freshness.level === "unknown")) issues.push({
			severity: "warning",
			category: "quality",
			code: "stale-page",
			path: page.relativePath,
			message: `Page freshness needs review (${freshness.reason}).`
		});
	}
	for (const claim of claimHealth) {
		if (claim.missingEvidence) issues.push({
			severity: "warning",
			category: "provenance",
			code: "claim-missing-evidence",
			path: claim.pagePath,
			message: `Claim ${claim.claimId ? `\`${claim.claimId}\`` : `\`${claim.text}\``} is missing structured evidence.`
		});
		if (typeof claim.confidence === "number" && claim.confidence < .5) issues.push({
			severity: "warning",
			category: "quality",
			code: "claim-low-confidence",
			path: claim.pagePath,
			message: `Claim ${claim.claimId ? `\`${claim.claimId}\`` : `\`${claim.text}\``} has low confidence (${claim.confidence.toFixed(2)}).`
		});
		if (claim.freshness.level === "stale" || claim.freshness.level === "unknown") issues.push({
			severity: "warning",
			category: "quality",
			code: "stale-claim",
			path: claim.pagePath,
			message: `Claim ${claim.claimId ? `\`${claim.claimId}\`` : `\`${claim.text}\``} freshness needs review (${claim.freshness.reason}).`
		});
	}
	for (const cluster of buildClaimContradictionClusters({ pages })) for (const entry of cluster.entries) issues.push({
		severity: "warning",
		category: "contradictions",
		code: "claim-conflict",
		path: entry.pagePath,
		message: `Claim cluster \`${cluster.label}\` has competing variants across ${cluster.entries.length} pages.`
	});
	for (const [id, matches] of pagesById.entries()) if (matches.length > 1) for (const match of matches) issues.push({
		severity: "error",
		category: "structure",
		code: "duplicate-id",
		path: match.relativePath,
		message: `Duplicate page id \`${id}\`.`
	});
	issues.push(...collectBrokenLinkIssues(pages));
	return issues.toSorted((left, right) => left.path.localeCompare(right.path));
}
function buildIssuesByCategory(issues) {
	return {
		structure: issues.filter((issue) => issue.category === "structure"),
		provenance: issues.filter((issue) => issue.category === "provenance"),
		links: issues.filter((issue) => issue.category === "links"),
		contradictions: issues.filter((issue) => issue.category === "contradictions"),
		"open-questions": issues.filter((issue) => issue.category === "open-questions"),
		quality: issues.filter((issue) => issue.category === "quality")
	};
}
function buildLintReportBody(issues) {
	if (issues.length === 0) return "No issues found.";
	const errors = issues.filter((issue) => issue.severity === "error");
	const warnings = issues.filter((issue) => issue.severity === "warning");
	const byCategory = buildIssuesByCategory(issues);
	const lines = [`- Errors: ${errors.length}`, `- Warnings: ${warnings.length}`];
	if (errors.length > 0) {
		lines.push("", "### Errors");
		for (const issue of errors) lines.push(`- \`${issue.path}\`: ${issue.message}`);
	}
	if (warnings.length > 0) {
		lines.push("", "### Warnings");
		for (const issue of warnings) lines.push(`- \`${issue.path}\`: ${issue.message}`);
	}
	if (byCategory.contradictions.length > 0) {
		lines.push("", "### Contradictions");
		for (const issue of byCategory.contradictions) lines.push(`- \`${issue.path}\`: ${issue.message}`);
	}
	if (byCategory["open-questions"].length > 0) {
		lines.push("", "### Open Questions");
		for (const issue of byCategory["open-questions"]) lines.push(`- \`${issue.path}\`: ${issue.message}`);
	}
	if (byCategory.provenance.length > 0 || byCategory.quality.length > 0) {
		lines.push("", "### Quality Follow-Up");
		for (const issue of [...byCategory.provenance, ...byCategory.quality]) lines.push(`- \`${issue.path}\`: ${issue.message}`);
	}
	return lines.join("\n");
}
async function writeLintReport(rootDir, issues) {
	const reportPath = path.join(rootDir, "reports", "lint.md");
	const updated = replaceManagedMarkdownBlock({
		original: await fs$1.readFile(reportPath, "utf8").catch(() => renderWikiMarkdown({
			frontmatter: {
				pageType: "report",
				id: "report.lint",
				title: "Lint Report",
				status: "active"
			},
			body: "# Lint Report\n"
		})),
		heading: "## Generated",
		startMarker: "<!-- openclaw:wiki:lint:start -->",
		endMarker: "<!-- openclaw:wiki:lint:end -->",
		body: buildLintReportBody(issues)
	});
	await fs$1.writeFile(reportPath, withTrailingNewline(updated), "utf8");
	return reportPath;
}
async function lintMemoryWikiVault(config) {
	const issues = collectPageIssues((await compileMemoryWikiVault(config)).pages);
	const issuesByCategory = buildIssuesByCategory(issues);
	const reportPath = await writeLintReport(config.vault.path, issues);
	await appendMemoryWikiLog(config.vault.path, {
		type: "lint",
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		details: {
			issueCount: issues.length,
			reportPath: path.relative(config.vault.path, reportPath)
		}
	});
	return {
		vaultRoot: config.vault.path,
		issueCount: issues.length,
		issues,
		issuesByCategory,
		reportPath
	};
}
//#endregion
//#region extensions/memory-wiki/src/obsidian.ts
const execFileAsync = promisify(execFile);
async function isExecutableFile(inputPath) {
	try {
		await fs$1.access(inputPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
async function resolveCommandOnPath(command) {
	const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const windowsExts = process.platform === "win32" ? process.env.PATHEXT?.split(";").filter(Boolean) ?? [
		".EXE",
		".CMD",
		".BAT"
	] : [""];
	if (command.includes(path.sep)) return await isExecutableFile(command) ? command : null;
	for (const dir of pathEntries) for (const extension of windowsExts) {
		const candidate = path.join(dir, extension ? `${command}${extension}` : command);
		if (await isExecutableFile(candidate)) return candidate;
	}
	return null;
}
function buildVaultPrefix(config) {
	return config.obsidian.vaultName ? [`vault=${config.obsidian.vaultName}`] : [];
}
async function probeObsidianCli(deps) {
	const command = await (deps?.resolveCommand ?? resolveCommandOnPath)("obsidian");
	return {
		available: command !== null,
		command
	};
}
async function runObsidianCli(params) {
	const resolveCommand = params.deps?.resolveCommand ?? resolveCommandOnPath;
	const exec = params.deps?.exec ?? execFileAsync;
	const probe = await probeObsidianCli({ resolveCommand });
	if (!probe.command) throw new Error("Obsidian CLI is not available on PATH.");
	const argv = [
		...buildVaultPrefix(params.config),
		params.subcommand,
		...params.args ?? []
	];
	const { stdout, stderr } = await exec(probe.command, argv, { encoding: "utf8" });
	return {
		command: probe.command,
		argv,
		stdout,
		stderr
	};
}
async function runObsidianSearch(params) {
	return await runObsidianCli({
		config: params.config,
		subcommand: "search",
		args: [`query=${params.query}`],
		deps: params.deps
	});
}
async function runObsidianOpen(params) {
	return await runObsidianCli({
		config: params.config,
		subcommand: "open",
		args: [`path=${params.vaultPath}`],
		deps: params.deps
	});
}
async function runObsidianCommand(params) {
	return await runObsidianCli({
		config: params.config,
		subcommand: "command",
		args: [`id=${params.id}`],
		deps: params.deps
	});
}
async function runObsidianDaily(params) {
	return await runObsidianCli({
		config: params.config,
		subcommand: "daily",
		deps: params.deps
	});
}
//#endregion
//#region extensions/memory-wiki/src/source-sync-state.ts
const EMPTY_STATE = {
	version: 1,
	entries: {}
};
function resolveMemoryWikiSourceSyncStatePath(vaultRoot) {
	return path.join(vaultRoot, ".openclaw-wiki", "source-sync.json");
}
async function readMemoryWikiSourceSyncState(vaultRoot) {
	const { value: parsed } = await readJsonFileWithFallback(resolveMemoryWikiSourceSyncStatePath(vaultRoot), EMPTY_STATE);
	return {
		version: 1,
		entries: { ...parsed.entries }
	};
}
async function writeMemoryWikiSourceSyncState(vaultRoot, state) {
	await writeJsonFileAtomically(resolveMemoryWikiSourceSyncStatePath(vaultRoot), state);
}
async function shouldSkipImportedSourceWrite(params) {
	const entry = params.state.entries[params.syncKey];
	if (!entry) return false;
	if (entry.pagePath !== params.expectedPagePath || entry.sourcePath !== params.expectedSourcePath || entry.sourceUpdatedAtMs !== params.sourceUpdatedAtMs || entry.sourceSize !== params.sourceSize || entry.renderFingerprint !== params.renderFingerprint) return false;
	const pagePath = path.join(params.vaultRoot, params.expectedPagePath);
	return await fs$1.access(pagePath).then(() => true).catch(() => false);
}
async function pruneImportedSourceEntries(params) {
	let removedCount = 0;
	for (const [syncKey, entry] of Object.entries(params.state.entries)) {
		if (entry.group !== params.group || params.activeKeys.has(syncKey)) continue;
		const pageAbsPath = path.join(params.vaultRoot, entry.pagePath);
		await fs$1.rm(pageAbsPath, { force: true }).catch(() => void 0);
		delete params.state.entries[syncKey];
		removedCount += 1;
	}
	return removedCount;
}
function setImportedSourceEntry(params) {
	params.state.entries[params.syncKey] = params.entry;
}
//#endregion
//#region extensions/memory-wiki/src/source-page-shared.ts
function isRegularFileStat(value) {
	if (!value || typeof value !== "object") return false;
	const stat = value;
	return (typeof stat.isFile === "function" ? stat.isFile.call(stat) : stat.isFile === true) && typeof stat.nlink === "number";
}
async function writeImportedSourcePage(params) {
	const vault = await root(params.vaultRoot);
	const pageStat = await vault.stat(params.pagePath).catch((error) => {
		if (error instanceof FsSafeError && (error.code === "not-found" || error.code === "path-alias")) return null;
		throw error;
	});
	const created = !pageStat;
	const updatedAt = new Date(params.sourceUpdatedAtMs).toISOString();
	if (await shouldSkipImportedSourceWrite({
		vaultRoot: params.vaultRoot,
		syncKey: params.syncKey,
		expectedPagePath: params.pagePath,
		expectedSourcePath: params.sourcePath,
		sourceUpdatedAtMs: params.sourceUpdatedAtMs,
		sourceSize: params.sourceSize,
		renderFingerprint: params.renderFingerprint,
		state: params.state
	})) return {
		pagePath: params.pagePath,
		changed: false,
		created
	};
	const raw = await fs$1.readFile(params.sourcePath, "utf8");
	const rendered = params.buildRendered(raw, updatedAt);
	const existing = pageStat ? await vault.readText(params.pagePath).catch(() => "") : "";
	if (existing !== rendered) try {
		if (isRegularFileStat(pageStat) && pageStat.nlink > 1) await vault.remove(params.pagePath);
		await vault.write(params.pagePath, rendered);
	} catch (error) {
		if (error instanceof FsSafeError) {
			if (error.code !== "symlink" && error.code !== "path-alias") throw new Error(`Refusing to write imported source page (${error.code}): ${params.pagePath}: ${error.message}`, { cause: error });
			throw new Error(`Refusing to write imported source page through symlink: ${params.pagePath}`, { cause: error });
		}
		throw error;
	}
	setImportedSourceEntry({
		syncKey: params.syncKey,
		state: params.state,
		entry: {
			group: params.group,
			pagePath: params.pagePath,
			sourcePath: params.sourcePath,
			sourceUpdatedAtMs: params.sourceUpdatedAtMs,
			sourceSize: params.sourceSize,
			renderFingerprint: params.renderFingerprint
		}
	});
	return {
		pagePath: params.pagePath,
		changed: existing !== rendered,
		created
	};
}
//#endregion
//#region extensions/memory-wiki/src/source-path-shared.ts
async function resolveArtifactKey(absolutePath) {
	const canonicalPath = await fs$1.realpath(absolutePath).catch(() => path.resolve(absolutePath));
	return process.platform === "win32" ? lowercasePreservingWhitespace(canonicalPath) : canonicalPath;
}
//#endregion
//#region extensions/memory-wiki/src/bridge.ts
function shouldImportArtifact(artifact, bridgeConfig) {
	switch (artifact.kind) {
		case "memory-root": return bridgeConfig.indexMemoryRoot;
		case "daily-note": return bridgeConfig.indexDailyNotes;
		case "dream-report": return bridgeConfig.indexDreamReports;
		case "event-log": return bridgeConfig.followMemoryEvents;
		default: return false;
	}
}
async function collectBridgeArtifacts(bridgeConfig, artifacts) {
	const collected = [];
	for (const artifact of artifacts) {
		if (!shouldImportArtifact(artifact, bridgeConfig)) continue;
		const syncKey = await resolveArtifactKey(artifact.absolutePath);
		collected.push({
			syncKey,
			artifactType: artifact.kind === "event-log" ? "memory-events" : "markdown",
			workspaceDir: artifact.workspaceDir,
			relativePath: artifact.relativePath,
			absolutePath: artifact.absolutePath
		});
	}
	const deduped = /* @__PURE__ */ new Map();
	for (const artifact of collected) deduped.set(artifact.syncKey, artifact);
	return [...deduped.values()];
}
function resolveBridgeTitle(artifact, agentIds) {
	if (artifact.artifactType === "memory-events") {
		if (agentIds.length === 0) return "Memory Bridge: event journal";
		return `Memory Bridge (${agentIds.join(", ")}): event journal`;
	}
	const base = artifact.relativePath.replace(/\.md$/i, "").replace(/^memory\//, "").replace(/\//g, " / ");
	if (agentIds.length === 0) return `Memory Bridge: ${base}`;
	return `Memory Bridge (${agentIds.join(", ")}): ${base}`;
}
function resolveBridgePagePath(params) {
	const workspaceBaseSlug = slugifyWikiSegment(path.basename(params.workspaceDir));
	const workspaceHash = createHash("sha1").update(path.resolve(params.workspaceDir)).digest("hex");
	const artifactBaseSlug = slugifyWikiSegment(params.relativePath.replace(/\.md$/i, "").replace(/\//g, "-"));
	const artifactHash = createHash("sha1").update(params.relativePath).digest("hex");
	const workspaceSlug = `${workspaceBaseSlug}-${workspaceHash.slice(0, 8)}`;
	const artifactSlug = `${artifactBaseSlug}-${artifactHash.slice(0, 8)}`;
	const fileName = createWikiPageFilename(`bridge-${workspaceSlug}-${artifactSlug}`);
	return {
		pageId: `source.bridge.${workspaceSlug}.${artifactSlug}`,
		pagePath: path.join("sources", fileName).replace(/\\/g, "/"),
		workspaceSlug,
		artifactSlug
	};
}
async function writeBridgeSourcePage(params) {
	const { pageId, pagePath } = resolveBridgePagePath({
		workspaceDir: params.artifact.workspaceDir,
		relativePath: params.artifact.relativePath
	});
	const title = resolveBridgeTitle(params.artifact, params.agentIds);
	const renderFingerprint = createHash("sha1").update(JSON.stringify({
		artifactType: params.artifact.artifactType,
		workspaceDir: params.artifact.workspaceDir,
		relativePath: params.artifact.relativePath,
		agentIds: params.agentIds
	})).digest("hex");
	return writeImportedSourcePage({
		vaultRoot: params.config.vault.path,
		syncKey: params.artifact.syncKey,
		sourcePath: params.artifact.absolutePath,
		sourceUpdatedAtMs: params.sourceUpdatedAtMs,
		sourceSize: params.sourceSize,
		renderFingerprint,
		pagePath,
		group: "bridge",
		state: params.state,
		buildRendered: (raw, updatedAt) => {
			const contentLanguage = params.artifact.artifactType === "memory-events" ? "json" : "markdown";
			return renderWikiMarkdown({
				frontmatter: {
					pageType: "source",
					id: pageId,
					title,
					sourceType: params.artifact.artifactType === "memory-events" ? "memory-bridge-events" : "memory-bridge",
					sourcePath: params.artifact.absolutePath,
					bridgeRelativePath: params.artifact.relativePath,
					bridgeWorkspaceDir: params.artifact.workspaceDir,
					bridgeAgentIds: params.agentIds,
					status: "active",
					updatedAt
				},
				body: [
					`# ${title}`,
					"",
					"## Bridge Source",
					`- Workspace: \`${params.artifact.workspaceDir}\``,
					`- Relative path: \`${params.artifact.relativePath}\``,
					`- Kind: \`${params.artifact.artifactType}\``,
					`- Agents: ${params.agentIds.length > 0 ? params.agentIds.join(", ") : "unknown"}`,
					`- Updated: ${updatedAt}`,
					"",
					"## Content",
					renderMarkdownFence(raw, contentLanguage),
					"",
					"## Notes",
					"<!-- openclaw:human:start -->",
					"<!-- openclaw:human:end -->",
					""
				].join("\n")
			});
		}
	});
}
async function syncMemoryWikiBridgeSources(params) {
	await initializeMemoryWikiVault(params.config);
	if (params.config.vaultMode !== "bridge" || !params.config.bridge.enabled || !params.config.bridge.readMemoryArtifacts || !params.appConfig) return {
		importedCount: 0,
		updatedCount: 0,
		skippedCount: 0,
		removedCount: 0,
		artifactCount: 0,
		workspaces: 0,
		pagePaths: []
	};
	const publicArtifacts = await listActiveMemoryPublicArtifacts({ cfg: params.appConfig });
	const state = await readMemoryWikiSourceSyncState(params.config.vault.path);
	const results = [];
	let artifactCount = 0;
	const activeKeys = /* @__PURE__ */ new Set();
	const artifacts = await collectBridgeArtifacts(params.config.bridge, publicArtifacts);
	const agentIdsByWorkspace = /* @__PURE__ */ new Map();
	for (const artifact of publicArtifacts) agentIdsByWorkspace.set(artifact.workspaceDir, artifact.agentIds);
	artifactCount = artifacts.length;
	for (const artifact of artifacts) {
		const stats = await fs$1.stat(artifact.absolutePath);
		activeKeys.add(artifact.syncKey);
		results.push(await writeBridgeSourcePage({
			config: params.config,
			artifact,
			agentIds: agentIdsByWorkspace.get(artifact.workspaceDir) ?? [],
			sourceUpdatedAtMs: stats.mtimeMs,
			sourceSize: stats.size,
			state
		}));
	}
	const workspaceCount = new Set(publicArtifacts.map((artifact) => artifact.workspaceDir)).size;
	const removedCount = getMemoryCapabilityRegistration() ? await pruneImportedSourceEntries({
		vaultRoot: params.config.vault.path,
		group: "bridge",
		activeKeys,
		state
	}) : 0;
	await writeMemoryWikiSourceSyncState(params.config.vault.path, state);
	const importedCount = results.filter((result) => result.changed && result.created).length;
	const updatedCount = results.filter((result) => result.changed && !result.created).length;
	const skippedCount = results.filter((result) => !result.changed).length;
	const pagePaths = results.map((result) => result.pagePath).toSorted((left, right) => left.localeCompare(right));
	if (importedCount > 0 || updatedCount > 0 || removedCount > 0) await appendMemoryWikiLog(params.config.vault.path, {
		type: "ingest",
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		details: {
			sourceType: "memory-bridge",
			workspaces: workspaceCount,
			artifactCount,
			importedCount,
			updatedCount,
			skippedCount,
			removedCount
		}
	});
	return {
		importedCount,
		updatedCount,
		skippedCount,
		removedCount,
		artifactCount,
		workspaces: workspaceCount,
		pagePaths
	};
}
//#endregion
//#region extensions/memory-wiki/src/unsafe-local.ts
const DIRECTORY_TEXT_EXTENSIONS = new Set([
	".json",
	".jsonl",
	".md",
	".txt",
	".yaml",
	".yml"
]);
function detectFenceLanguage(filePath) {
	const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
	if (ext === ".json" || ext === ".jsonl") return "json";
	if (ext === ".yaml" || ext === ".yml") return "yaml";
	if (ext === ".txt") return "text";
	return "markdown";
}
async function listAllowedFilesRecursive(rootDir) {
	const entries = await fs$1.readdir(rootDir, { withFileTypes: true }).catch(() => []);
	const files = [];
	for (const entry of entries) {
		const fullPath = path.join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...await listAllowedFilesRecursive(fullPath));
			continue;
		}
		if (entry.isFile() && DIRECTORY_TEXT_EXTENSIONS.has(normalizeLowercaseStringOrEmpty(path.extname(entry.name)))) files.push(fullPath);
	}
	return files.toSorted((left, right) => left.localeCompare(right));
}
async function collectUnsafeLocalArtifacts(configuredPaths) {
	const artifacts = [];
	for (const configuredPath of configuredPaths) {
		const absoluteConfiguredPath = path.resolve(configuredPath);
		const stat = await fs$1.stat(absoluteConfiguredPath).catch(() => null);
		if (!stat) continue;
		if (stat.isDirectory()) {
			const files = await listAllowedFilesRecursive(absoluteConfiguredPath);
			for (const absolutePath of files) artifacts.push({
				syncKey: await resolveArtifactKey(absolutePath),
				configuredPath: absoluteConfiguredPath,
				absolutePath,
				relativePath: path.relative(absoluteConfiguredPath, absolutePath).replace(/\\/g, "/")
			});
			continue;
		}
		if (stat.isFile()) artifacts.push({
			syncKey: await resolveArtifactKey(absoluteConfiguredPath),
			configuredPath: absoluteConfiguredPath,
			absolutePath: absoluteConfiguredPath,
			relativePath: path.basename(absoluteConfiguredPath)
		});
	}
	const deduped = /* @__PURE__ */ new Map();
	for (const artifact of artifacts) deduped.set(artifact.syncKey, artifact);
	return [...deduped.values()];
}
function resolveUnsafeLocalPagePath(params) {
	const pageSlug = `${slugifyWikiSegment(path.basename(params.configuredPath))}-${createHash("sha1").update(path.resolve(params.configuredPath)).digest("hex").slice(0, 8)}-${slugifyWikiSegment(path.basename(params.absolutePath))}-${createHash("sha1").update(path.resolve(params.absolutePath)).digest("hex").slice(0, 8)}`;
	return {
		pageId: `source.unsafe-local.${pageSlug}`,
		pagePath: path.join("sources", createWikiPageFilename(`unsafe-local-${pageSlug}`)).replace(/\\/g, "/")
	};
}
function resolveUnsafeLocalTitle(artifact) {
	return `Unsafe Local Import: ${artifact.relativePath}`;
}
async function writeUnsafeLocalSourcePage(params) {
	const { pageId, pagePath } = resolveUnsafeLocalPagePath({
		configuredPath: params.artifact.configuredPath,
		absolutePath: params.artifact.absolutePath
	});
	const title = resolveUnsafeLocalTitle(params.artifact);
	const renderFingerprint = createHash("sha1").update(JSON.stringify({
		configuredPath: params.artifact.configuredPath,
		relativePath: params.artifact.relativePath
	})).digest("hex");
	return writeImportedSourcePage({
		vaultRoot: params.config.vault.path,
		syncKey: params.artifact.syncKey,
		sourcePath: params.artifact.absolutePath,
		sourceUpdatedAtMs: params.sourceUpdatedAtMs,
		sourceSize: params.sourceSize,
		renderFingerprint,
		pagePath,
		group: "unsafe-local",
		state: params.state,
		buildRendered: (raw, updatedAt) => renderWikiMarkdown({
			frontmatter: {
				pageType: "source",
				id: pageId,
				title,
				sourceType: "memory-unsafe-local",
				provenanceMode: "unsafe-local",
				sourcePath: params.artifact.absolutePath,
				unsafeLocalConfiguredPath: params.artifact.configuredPath,
				unsafeLocalRelativePath: params.artifact.relativePath,
				status: "active",
				updatedAt
			},
			body: [
				`# ${title}`,
				"",
				"## Unsafe Local Source",
				`- Configured path: \`${params.artifact.configuredPath}\``,
				`- Relative path: \`${params.artifact.relativePath}\``,
				`- Updated: ${updatedAt}`,
				"",
				"## Content",
				renderMarkdownFence(raw, detectFenceLanguage(params.artifact.absolutePath)),
				"",
				"## Notes",
				"<!-- openclaw:human:start -->",
				"<!-- openclaw:human:end -->",
				""
			].join("\n")
		})
	});
}
async function syncMemoryWikiUnsafeLocalSources(config) {
	await initializeMemoryWikiVault(config);
	if (config.vaultMode !== "unsafe-local" || !config.unsafeLocal.allowPrivateMemoryCoreAccess || config.unsafeLocal.paths.length === 0) return {
		importedCount: 0,
		updatedCount: 0,
		skippedCount: 0,
		removedCount: 0,
		artifactCount: 0,
		workspaces: 0,
		pagePaths: []
	};
	const artifacts = await collectUnsafeLocalArtifacts(config.unsafeLocal.paths);
	const state = await readMemoryWikiSourceSyncState(config.vault.path);
	const activeKeys = /* @__PURE__ */ new Set();
	const results = await Promise.all(artifacts.map(async (artifact) => {
		const stats = await fs$1.stat(artifact.absolutePath);
		activeKeys.add(artifact.syncKey);
		return await writeUnsafeLocalSourcePage({
			config,
			artifact,
			sourceUpdatedAtMs: stats.mtimeMs,
			sourceSize: stats.size,
			state
		});
	}));
	const removedCount = await pruneImportedSourceEntries({
		vaultRoot: config.vault.path,
		group: "unsafe-local",
		activeKeys,
		state
	});
	await writeMemoryWikiSourceSyncState(config.vault.path, state);
	const importedCount = results.filter((result) => result.changed && result.created).length;
	const updatedCount = results.filter((result) => result.changed && !result.created).length;
	const skippedCount = results.filter((result) => !result.changed).length;
	const pagePaths = results.map((result) => result.pagePath).toSorted((left, right) => left.localeCompare(right));
	if (importedCount > 0 || updatedCount > 0 || removedCount > 0) await appendMemoryWikiLog(config.vault.path, {
		type: "ingest",
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		details: {
			sourceType: "memory-unsafe-local",
			configuredPathCount: config.unsafeLocal.paths.length,
			artifactCount: artifacts.length,
			importedCount,
			updatedCount,
			skippedCount,
			removedCount
		}
	});
	return {
		importedCount,
		updatedCount,
		skippedCount,
		removedCount,
		artifactCount: artifacts.length,
		workspaces: 0,
		pagePaths
	};
}
//#endregion
//#region extensions/memory-wiki/src/source-sync.ts
async function syncMemoryWikiImportedSources(params) {
	let syncResult;
	if (params.config.vaultMode === "bridge") syncResult = await syncMemoryWikiBridgeSources(params);
	else if (params.config.vaultMode === "unsafe-local") syncResult = await syncMemoryWikiUnsafeLocalSources(params.config);
	else syncResult = {
		importedCount: 0,
		updatedCount: 0,
		skippedCount: 0,
		removedCount: 0,
		artifactCount: 0,
		workspaces: 0,
		pagePaths: []
	};
	const refreshResult = await refreshMemoryWikiIndexesAfterImport({
		config: params.config,
		syncResult
	});
	return {
		...syncResult,
		indexesRefreshed: refreshResult.refreshed,
		indexUpdatedFiles: refreshResult.compile?.updatedFiles ?? [],
		indexRefreshReason: refreshResult.reason
	};
}
//#endregion
//#region extensions/memory-wiki/src/status.ts
async function collectVaultCounts(vaultPath) {
	const pageCounts = {
		entity: 0,
		concept: 0,
		source: 0,
		synthesis: 0,
		report: 0
	};
	const sourceCounts = {
		native: 0,
		bridge: 0,
		bridgeEvents: 0,
		unsafeLocal: 0,
		other: 0
	};
	for (const dir of [
		"entities",
		"concepts",
		"sources",
		"syntheses",
		"reports"
	]) {
		const entries = await fs$1.readdir(path.join(vaultPath, dir), { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") continue;
			const kind = inferWikiPageKind(path.join(dir, entry.name));
			if (kind) pageCounts[kind] += 1;
			if (dir === "sources") {
				const absolutePath = path.join(vaultPath, dir, entry.name);
				const raw = await fs$1.readFile(absolutePath, "utf8").catch(() => null);
				if (!raw) continue;
				const page = toWikiPageSummary({
					absolutePath,
					relativePath: path.join(dir, entry.name),
					raw
				});
				if (!page) continue;
				if (page.sourceType === "memory-bridge-events") sourceCounts.bridgeEvents += 1;
				else if (page.sourceType === "memory-bridge") sourceCounts.bridge += 1;
				else if (page.provenanceMode === "unsafe-local" || page.sourceType === "memory-unsafe-local") sourceCounts.unsafeLocal += 1;
				else if (!page.sourceType) sourceCounts.native += 1;
				else sourceCounts.other += 1;
			}
		}
	}
	return {
		pageCounts,
		sourceCounts
	};
}
function buildWarnings(params) {
	const warnings = [];
	if (!params.vaultExists) warnings.push({
		code: "vault-missing",
		message: "Wiki vault has not been initialized yet."
	});
	if (params.config.obsidian.enabled && params.config.obsidian.useOfficialCli && !params.obsidianCommand) warnings.push({
		code: "obsidian-cli-missing",
		message: "Obsidian CLI is enabled in config but `obsidian` is not available on PATH."
	});
	if (params.config.vaultMode === "bridge" && !params.config.bridge.enabled) warnings.push({
		code: "bridge-disabled",
		message: "vaultMode is `bridge` but bridge.enabled is false."
	});
	if (params.config.vaultMode === "bridge" && params.config.bridge.enabled && params.config.bridge.readMemoryArtifacts && params.bridgePublicArtifactCount === 0) warnings.push({
		code: "bridge-artifacts-missing",
		message: "Bridge mode is enabled but the active memory plugin is not exporting any public memory artifacts yet."
	});
	if (params.config.vaultMode === "unsafe-local" && !params.config.unsafeLocal.allowPrivateMemoryCoreAccess) warnings.push({
		code: "unsafe-local-disabled",
		message: "vaultMode is `unsafe-local` but private memory-core access is disabled."
	});
	if (params.config.vaultMode === "unsafe-local" && params.config.unsafeLocal.allowPrivateMemoryCoreAccess && params.config.unsafeLocal.paths.length === 0) warnings.push({
		code: "unsafe-local-paths-missing",
		message: "unsafe-local access is enabled but no private paths are configured."
	});
	if (params.config.vaultMode !== "unsafe-local" && params.config.unsafeLocal.allowPrivateMemoryCoreAccess) warnings.push({
		code: "unsafe-local-without-mode",
		message: "Private memory-core access is enabled outside unsafe-local mode."
	});
	return warnings;
}
async function resolveMemoryWikiStatus(config, deps) {
	const vaultExists = await (deps?.pathExists ?? pathExists)(config.vault.path);
	const bridgePublicArtifactCount = deps?.appConfig && config.vaultMode === "bridge" && config.bridge.enabled ? (await (deps.listPublicArtifacts ?? listActiveMemoryPublicArtifacts)({ cfg: deps.appConfig })).length : null;
	const obsidianProbe = await probeObsidianCli({ resolveCommand: deps?.resolveCommand });
	const counts = vaultExists ? await collectVaultCounts(config.vault.path) : {
		pageCounts: {
			entity: 0,
			concept: 0,
			source: 0,
			synthesis: 0,
			report: 0
		},
		sourceCounts: {
			native: 0,
			bridge: 0,
			bridgeEvents: 0,
			unsafeLocal: 0,
			other: 0
		}
	};
	return {
		vaultMode: config.vaultMode,
		renderMode: config.vault.renderMode,
		vaultPath: config.vault.path,
		vaultExists,
		bridge: config.bridge,
		bridgePublicArtifactCount,
		obsidianCli: {
			enabled: config.obsidian.enabled,
			requested: config.obsidian.enabled && config.obsidian.useOfficialCli,
			available: obsidianProbe.available,
			command: obsidianProbe.command
		},
		unsafeLocal: {
			allowPrivateMemoryCoreAccess: config.unsafeLocal.allowPrivateMemoryCoreAccess,
			pathCount: config.unsafeLocal.paths.length
		},
		pageCounts: counts.pageCounts,
		sourceCounts: counts.sourceCounts,
		warnings: buildWarnings({
			config,
			bridgePublicArtifactCount,
			vaultExists,
			obsidianCommand: obsidianProbe.command
		})
	};
}
function buildMemoryWikiDoctorReport(status) {
	const fixes = status.warnings.map((warning) => ({
		code: warning.code,
		message: warning.code === "vault-missing" ? "Run `openclaw wiki init` to create the vault layout." : warning.code === "obsidian-cli-missing" ? "Install the official Obsidian CLI or disable `obsidian.useOfficialCli`." : warning.code === "bridge-disabled" ? "Enable `plugins.entries.memory-wiki.config.bridge.enabled` or switch vaultMode away from `bridge`." : warning.code === "bridge-artifacts-missing" ? "Use a memory plugin that exports public artifacts, create/import memory artifacts first, or switch the wiki back to isolated mode." : warning.code === "unsafe-local-disabled" ? "Enable `unsafeLocal.allowPrivateMemoryCoreAccess` or switch vaultMode away from `unsafe-local`." : warning.code === "unsafe-local-paths-missing" ? "Add explicit `unsafeLocal.paths` entries before running unsafe-local imports." : "Disable private memory-core access unless you explicitly want unsafe-local mode."
	}));
	return {
		healthy: status.warnings.length === 0,
		warningCount: status.warnings.length,
		status,
		fixes
	};
}
function renderMemoryWikiStatus(status) {
	const lines = [
		`Wiki vault mode: ${status.vaultMode}`,
		`Vault: ${status.vaultExists ? "ready" : "missing"} (${status.vaultPath})`,
		`Render mode: ${status.renderMode}`,
		`Obsidian CLI: ${status.obsidianCli.available ? "available" : "missing"}${status.obsidianCli.requested ? " (requested)" : ""}`,
		`Bridge: ${status.bridge.enabled ? "enabled" : "disabled"}${typeof status.bridgePublicArtifactCount === "number" ? ` (${status.bridgePublicArtifactCount} exported artifact${status.bridgePublicArtifactCount === 1 ? "" : "s"})` : ""}`,
		`Unsafe local: ${status.unsafeLocal.allowPrivateMemoryCoreAccess ? `enabled (${status.unsafeLocal.pathCount} paths)` : "disabled"}`,
		`Pages: ${status.pageCounts.source} sources, ${status.pageCounts.entity} entities, ${status.pageCounts.concept} concepts, ${status.pageCounts.synthesis} syntheses, ${status.pageCounts.report} reports`,
		`Source provenance: ${status.sourceCounts.native} native, ${status.sourceCounts.bridge} bridge, ${status.sourceCounts.bridgeEvents} bridge-events, ${status.sourceCounts.unsafeLocal} unsafe-local, ${status.sourceCounts.other} other`
	];
	if (status.warnings.length > 0) {
		lines.push("", "Warnings:");
		for (const warning of status.warnings) lines.push(`- ${warning.message}`);
	}
	return lines.join("\n");
}
function renderMemoryWikiDoctor(report) {
	const lines = [
		report.healthy ? "Wiki doctor: healthy" : `Wiki doctor: ${report.warningCount} issue(s) found`,
		"",
		renderMemoryWikiStatus(report.status)
	];
	if (report.fixes.length > 0) {
		lines.push("", "Suggested fixes:");
		for (const fix of report.fixes) lines.push(`- ${fix.message}`);
	}
	return lines.join("\n");
}
//#endregion
//#region extensions/memory-wiki/src/cli.ts
const WIKI_GATEWAY_TIMEOUT_MS = "30000";
const GATEWAY_TERMINAL_STRING_MAX_CHARS = 2e3;
const GATEWAY_RESPONSE_MAX_ARRAY_ITEMS = 1e4;
const GATEWAY_RESPONSE_MAX_STRING_CHARS = 1e4;
const GATEWAY_RESPONSE_MAX_CODE_CHARS = 256;
const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(String.raw`(?:\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\-_]|\x9B[0-?]*[ -/]*[@-~])`, "g");
const TERMINAL_CONTROL_CHARACTER_PATTERN = new RegExp(String.raw`[\x00-\x1F\x7F-\x9F]+`, "g");
const UNICODE_FORMAT_CONTROL_PATTERN = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
function isResolvedMemoryWikiConfig(config) {
	return Boolean(config && "vaultMode" in config && "vault" in config && "bridge" in config && "obsidian" in config && "unsafeLocal" in config);
}
function sanitizeGatewayStringForTerminal(value) {
	const sanitized = (value.length > GATEWAY_TERMINAL_STRING_MAX_CHARS ? value.slice(0, GATEWAY_TERMINAL_STRING_MAX_CHARS) : value).replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "").replace(TERMINAL_CONTROL_CHARACTER_PATTERN, " ").replace(UNICODE_FORMAT_CONTROL_PATTERN, "");
	return value.length > GATEWAY_TERMINAL_STRING_MAX_CHARS ? `${sanitized}... [truncated]` : sanitized;
}
function escapeGatewayJsonForTerminal(json) {
	return json.replace(UNICODE_FORMAT_CONTROL_PATTERN, (char) => {
		const codePoint = char.codePointAt(0);
		return typeof codePoint === "number" ? `\\u${codePoint.toString(16).padStart(4, "0")}` : "";
	});
}
function writeOutput(output, writer = process.stdout) {
	writer.write(output.endsWith("\n") ? output : `${output}\n`);
}
function shouldRouteBridgeRuntimeThroughGateway(config) {
	return config.vaultMode === "bridge" && config.bridge.enabled && config.bridge.readMemoryArtifacts;
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isBoundedGatewayString(value, maxChars = GATEWAY_RESPONSE_MAX_STRING_CHARS) {
	return typeof value === "string" && value.length <= maxChars;
}
function isStringArray(value, maxChars = GATEWAY_RESPONSE_MAX_STRING_CHARS) {
	return Array.isArray(value) && value.length <= GATEWAY_RESPONSE_MAX_ARRAY_ITEMS && value.every((item) => isBoundedGatewayString(item, maxChars));
}
function hasNumberFields(value, keys) {
	return keys.every((key) => typeof value[key] === "number");
}
function isWarningList(value) {
	return Array.isArray(value) && value.length <= GATEWAY_RESPONSE_MAX_ARRAY_ITEMS && value.every((item) => isRecord(item) && isBoundedGatewayString(item.code, GATEWAY_RESPONSE_MAX_CODE_CHARS) && isBoundedGatewayString(item.message));
}
function isMemoryWikiStatus(value) {
	if (!isRecord(value)) return false;
	const bridge = value.bridge;
	const obsidianCli = value.obsidianCli;
	const unsafeLocal = value.unsafeLocal;
	const pageCounts = value.pageCounts;
	const sourceCounts = value.sourceCounts;
	return isBoundedGatewayString(value.vaultMode, GATEWAY_RESPONSE_MAX_CODE_CHARS) && isBoundedGatewayString(value.renderMode, GATEWAY_RESPONSE_MAX_CODE_CHARS) && isBoundedGatewayString(value.vaultPath) && typeof value.vaultExists === "boolean" && (typeof value.bridgePublicArtifactCount === "number" || value.bridgePublicArtifactCount === null) && isRecord(bridge) && typeof bridge.enabled === "boolean" && isRecord(obsidianCli) && typeof obsidianCli.enabled === "boolean" && typeof obsidianCli.requested === "boolean" && typeof obsidianCli.available === "boolean" && (isBoundedGatewayString(obsidianCli.command) || obsidianCli.command === null) && isRecord(unsafeLocal) && typeof unsafeLocal.allowPrivateMemoryCoreAccess === "boolean" && typeof unsafeLocal.pathCount === "number" && isRecord(pageCounts) && hasNumberFields(pageCounts, [
		"source",
		"entity",
		"concept",
		"synthesis",
		"report"
	]) && isRecord(sourceCounts) && hasNumberFields(sourceCounts, [
		"native",
		"bridge",
		"bridgeEvents",
		"unsafeLocal",
		"other"
	]) && isWarningList(value.warnings);
}
function isMemoryWikiDoctorReport(value) {
	return isRecord(value) && typeof value.healthy === "boolean" && typeof value.warningCount === "number" && isMemoryWikiStatus(value.status) && Array.isArray(value.fixes) && value.fixes.length <= GATEWAY_RESPONSE_MAX_ARRAY_ITEMS && value.fixes.every((item) => isRecord(item) && isBoundedGatewayString(item.code, GATEWAY_RESPONSE_MAX_CODE_CHARS) && isBoundedGatewayString(item.message));
}
function isMemoryWikiImportResult(value) {
	return isRecord(value) && hasNumberFields(value, [
		"importedCount",
		"updatedCount",
		"skippedCount",
		"removedCount",
		"artifactCount",
		"workspaces"
	]) && isStringArray(value.pagePaths) && typeof value.indexesRefreshed === "boolean" && isStringArray(value.indexUpdatedFiles) && isBoundedGatewayString(value.indexRefreshReason, GATEWAY_RESPONSE_MAX_CODE_CHARS);
}
function validateWikiGatewayResult(method, value) {
	if (method === "wiki.status" && isMemoryWikiStatus(value)) return value;
	if (method === "wiki.doctor" && isMemoryWikiDoctorReport(value)) return value;
	if (method === "wiki.bridge.import" && isMemoryWikiImportResult(value)) return value;
	throw new Error(`Invalid Gateway response for ${method}.`);
}
async function callWikiGateway(method) {
	return validateWikiGatewayResult(method, await callGatewayFromCli(method, { timeout: WIKI_GATEWAY_TIMEOUT_MS }, void 0, { progress: false }));
}
function normalizeCliStringList(values) {
	if (!values) return;
	const normalized = values.map((value) => value.trim()).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
	return normalized.length > 0 ? normalized : void 0;
}
function collectCliValues(value, acc = []) {
	acc.push(value);
	return acc;
}
function parseWikiSearchEnumOption(value, allowed, label) {
	if (allowed.includes(value)) return value;
	throw new Error(`Invalid ${label}: ${value}. Expected one of: ${allowed.join(", ")}`);
}
async function resolveWikiApplyBody(params) {
	if (params.body?.trim()) return params.body;
	if (params.bodyFile?.trim()) return await fs$1.readFile(params.bodyFile, "utf8");
	throw new Error("wiki apply synthesis requires --body or --body-file.");
}
function formatMemoryWikiMutationSummary(result, json) {
	if (json) return JSON.stringify(result, null, 2);
	return `${result.changed ? "Updated" : "No changes for"} ${result.pagePath} via ${result.operation}. ${result.compile.updatedFiles.length > 0 ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.` : "Indexes unchanged."}`;
}
function formatJsonOrText(result, json, render) {
	return json ? JSON.stringify(result, null, 2) : render(result);
}
function formatGatewayJsonOrText(result, json, render) {
	return json ? escapeGatewayJsonForTerminal(JSON.stringify(result, null, 2)) : sanitizeGatewayStringForTerminal(render(result));
}
async function runWikiCommandWithSummary(params) {
	const result = await params.run();
	writeOutput(formatJsonOrText(result, params.json, params.render), params.stdout);
	return result;
}
async function runSyncedWikiCommandWithSummary(params) {
	await syncMemoryWikiImportedSources({
		config: params.config,
		appConfig: params.appConfig
	});
	return runWikiCommandWithSummary(params);
}
function addWikiSearchConfigOptions(command) {
	return command.option("--backend <backend>", `Search backend (${WIKI_SEARCH_BACKENDS.join(", ")})`, (value) => parseWikiSearchEnumOption(value, WIKI_SEARCH_BACKENDS, "backend")).option("--corpus <corpus>", `Search corpus (${WIKI_SEARCH_CORPORA.join(", ")})`, (value) => parseWikiSearchEnumOption(value, WIKI_SEARCH_CORPORA, "corpus"));
}
function addWikiApplyMutationOptions(command) {
	return command.option("--source-id <id>", "Source id", collectCliValues).option("--contradiction <text>", "Contradiction note", collectCliValues).option("--question <text>", "Open question", collectCliValues).option("--confidence <n>", "Confidence score between 0 and 1", (value) => Number(value)).option("--status <status>", "Page status");
}
async function runWikiStatus(params) {
	const routeThroughGateway = shouldRouteBridgeRuntimeThroughGateway(params.config);
	const status = routeThroughGateway ? await callWikiGateway("wiki.status") : await (async () => {
		await syncMemoryWikiImportedSources({
			config: params.config,
			appConfig: params.appConfig
		});
		return await resolveMemoryWikiStatus(params.config, { appConfig: params.appConfig });
	})();
	writeOutput(routeThroughGateway ? formatGatewayJsonOrText(status, params.json, renderMemoryWikiStatus) : formatJsonOrText(status, params.json, renderMemoryWikiStatus), params.stdout);
	return status;
}
async function runWikiDoctor(params) {
	const routeThroughGateway = shouldRouteBridgeRuntimeThroughGateway(params.config);
	const report = routeThroughGateway ? await callWikiGateway("wiki.doctor") : await (async () => {
		await syncMemoryWikiImportedSources({
			config: params.config,
			appConfig: params.appConfig
		});
		return buildMemoryWikiDoctorReport(await resolveMemoryWikiStatus(params.config, { appConfig: params.appConfig }));
	})();
	if (!report.healthy) process.exitCode = 1;
	writeOutput(routeThroughGateway ? formatGatewayJsonOrText(report, params.json, renderMemoryWikiDoctor) : formatJsonOrText(report, params.json, renderMemoryWikiDoctor), params.stdout);
	return report;
}
async function runWikiInit(params) {
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => initializeMemoryWikiVault(params.config),
		render: (value) => `Initialized wiki vault at ${value.rootDir} (${value.createdDirectories.length} dirs, ${value.createdFiles.length} files).`
	});
}
async function runWikiCompile(params) {
	return runSyncedWikiCommandWithSummary({
		config: params.config,
		appConfig: params.appConfig,
		json: params.json,
		stdout: params.stdout,
		run: () => compileMemoryWikiVault(params.config),
		render: (value) => `Compiled wiki vault at ${value.vaultRoot} (${value.pages.length} pages, ${value.updatedFiles.length} indexes updated).`
	});
}
async function runWikiLint(params) {
	return runSyncedWikiCommandWithSummary({
		config: params.config,
		appConfig: params.appConfig,
		json: params.json,
		stdout: params.stdout,
		run: () => lintMemoryWikiVault(params.config),
		render: (value) => `Linted wiki vault at ${value.vaultRoot} (${value.issueCount} issues, report: ${value.reportPath}).`
	});
}
async function runWikiIngest(params) {
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => ingestMemoryWikiSource({
			config: params.config,
			inputPath: params.inputPath,
			title: params.title
		}),
		render: (value) => `Ingested ${value.sourcePath} into ${value.pagePath}. Refreshed ${value.indexUpdatedFiles.length} index file${value.indexUpdatedFiles.length === 1 ? "" : "s"}.`
	});
}
async function runWikiSearch(params) {
	if (params.mode && !WIKI_SEARCH_MODES.includes(params.mode)) throw new Error(`wiki search --mode must be one of: ${WIKI_SEARCH_MODES.join(", ")}.`);
	await syncMemoryWikiImportedSources({
		config: params.config,
		appConfig: params.appConfig
	});
	const results = await searchMemoryWiki({
		config: params.config,
		appConfig: params.appConfig,
		query: params.query,
		maxResults: params.maxResults,
		searchBackend: params.searchBackend,
		searchCorpus: params.searchCorpus,
		mode: params.mode
	});
	writeOutput(params.json ? JSON.stringify(results, null, 2) : results.length === 0 ? "No wiki or memory results." : results.map((result, index) => `${index + 1}. ${result.title} (${result.corpus}/${result.kind})\nPath: ${result.path}${typeof result.startLine === "number" && typeof result.endLine === "number" ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${result.provenanceLabel}` : ""}${result.matchedClaimId ? `\nClaim: ${result.matchedClaimId}` : ""}${result.evidenceKinds && result.evidenceKinds.length > 0 ? `\nEvidence: ${result.evidenceKinds.join(", ")}` : ""}\nSnippet: ${result.snippet}`).join("\n\n"), params.stdout);
	return results;
}
async function runWikiGet(params) {
	await syncMemoryWikiImportedSources({
		config: params.config,
		appConfig: params.appConfig
	});
	const result = await getMemoryWikiPage({
		config: params.config,
		appConfig: params.appConfig,
		lookup: params.lookup,
		fromLine: params.fromLine,
		lineCount: params.lineCount,
		searchBackend: params.searchBackend,
		searchCorpus: params.searchCorpus
	});
	writeOutput(params.json ? JSON.stringify(result, null, 2) : result?.content ?? `Wiki page not found: ${params.lookup}`, params.stdout);
	return result;
}
async function runWikiApplySynthesis(params) {
	const sourceIds = normalizeCliStringList(params.sourceIds);
	if (!sourceIds) throw new Error("wiki apply synthesis requires at least one --source-id.");
	const body = await resolveWikiApplyBody({
		body: params.body,
		bodyFile: params.bodyFile
	});
	await syncMemoryWikiImportedSources({
		config: params.config,
		appConfig: params.appConfig
	});
	const result = await applyMemoryWikiMutation({
		config: params.config,
		mutation: {
			op: "create_synthesis",
			title: params.title,
			body,
			sourceIds,
			...normalizeCliStringList(params.contradictions) ? { contradictions: normalizeCliStringList(params.contradictions) } : {},
			...normalizeCliStringList(params.questions) ? { questions: normalizeCliStringList(params.questions) } : {},
			...typeof params.confidence === "number" ? { confidence: params.confidence } : {},
			...params.status?.trim() ? { status: params.status.trim() } : {}
		}
	});
	writeOutput(formatMemoryWikiMutationSummary(result, params.json), params.stdout);
	return result;
}
async function runWikiApplyMetadata(params) {
	await syncMemoryWikiImportedSources({
		config: params.config,
		appConfig: params.appConfig
	});
	const result = await applyMemoryWikiMutation({
		config: params.config,
		mutation: {
			op: "update_metadata",
			lookup: params.lookup,
			...normalizeCliStringList(params.sourceIds) ? { sourceIds: normalizeCliStringList(params.sourceIds) } : {},
			...normalizeCliStringList(params.contradictions) ? { contradictions: normalizeCliStringList(params.contradictions) } : {},
			...normalizeCliStringList(params.questions) ? { questions: normalizeCliStringList(params.questions) } : {},
			...params.clearConfidence ? { confidence: null } : typeof params.confidence === "number" ? { confidence: params.confidence } : {},
			...params.status?.trim() ? { status: params.status.trim() } : {}
		}
	});
	writeOutput(formatMemoryWikiMutationSummary(result, params.json), params.stdout);
	return result;
}
async function runWikiBridgeImport(params) {
	const render = (value) => `Bridge import synced ${value.artifactCount} artifacts across ${value.workspaces} workspaces (${value.importedCount} new, ${value.updatedCount} updated, ${value.skippedCount} unchanged, ${value.removedCount} removed). Indexes ${value.indexesRefreshed ? `refreshed (${value.indexUpdatedFiles.length} files)` : `not refreshed (${value.indexRefreshReason})`}.`;
	if (shouldRouteBridgeRuntimeThroughGateway(params.config)) {
		const result = await callWikiGateway("wiki.bridge.import");
		writeOutput(formatGatewayJsonOrText(result, params.json, render), params.stdout);
		return result;
	}
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => syncMemoryWikiImportedSources({
			config: params.config,
			appConfig: params.appConfig
		}),
		render
	});
}
async function runWikiUnsafeLocalImport(params) {
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => syncMemoryWikiImportedSources({
			config: params.config,
			appConfig: params.appConfig
		}),
		render: (value) => `Unsafe-local import synced ${value.artifactCount} artifacts (${value.importedCount} new, ${value.updatedCount} updated, ${value.skippedCount} unchanged, ${value.removedCount} removed). Indexes ${value.indexesRefreshed ? `refreshed (${value.indexUpdatedFiles.length} files)` : `not refreshed (${value.indexRefreshReason})`}.`
	});
}
async function runWikiObsidianStatus(params) {
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => probeObsidianCli(),
		render: (value) => value.available ? `Obsidian CLI available at ${value.command}` : "Obsidian CLI is not available on PATH."
	});
}
async function runWikiObsidianSearch(params) {
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => runObsidianSearch({
			config: params.config,
			query: params.query
		}),
		render: (value) => value.stdout.trim()
	});
}
async function runWikiObsidianOpenCli(params) {
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => runObsidianOpen({
			config: params.config,
			vaultPath: params.vaultPath
		}),
		render: (value) => value.stdout.trim() || "Opened in Obsidian."
	});
}
async function runWikiObsidianCommandCli(params) {
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => runObsidianCommand({
			config: params.config,
			id: params.id
		}),
		render: (value) => value.stdout.trim() || "Command sent to Obsidian."
	});
}
async function runWikiObsidianDailyCli(params) {
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => runObsidianDaily({ config: params.config }),
		render: (value) => value.stdout.trim() || "Opened today's daily note."
	});
}
function formatChatGptImportSummary(result) {
	if (result.dryRun) return `ChatGPT import dry run scanned ${result.conversationCount} conversations (${result.createdCount} new, ${result.updatedCount} updated, ${result.skippedCount} unchanged).`;
	const runSuffix = result.runId ? ` Run id: ${result.runId}.` : "";
	return `ChatGPT import applied ${result.conversationCount} conversations (${result.createdCount} new, ${result.updatedCount} updated, ${result.skippedCount} unchanged). Refreshed ${result.indexUpdatedFiles.length} index file${result.indexUpdatedFiles.length === 1 ? "" : "s"}.${runSuffix}`;
}
function formatChatGptRollbackSummary(result) {
	if (result.alreadyRolledBack) return `ChatGPT import run ${result.runId} was already rolled back.`;
	return `Rolled back ChatGPT import run ${result.runId} (${result.removedCount} removed, ${result.restoredCount} restored). Refreshed ${result.indexUpdatedFiles.length} index file${result.indexUpdatedFiles.length === 1 ? "" : "s"}.`;
}
async function runWikiChatGptImport(params) {
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => importChatGptConversations({
			config: params.config,
			exportPath: params.exportPath,
			dryRun: params.dryRun
		}),
		render: formatChatGptImportSummary
	});
}
async function runWikiChatGptRollback(params) {
	return runWikiCommandWithSummary({
		json: params.json,
		stdout: params.stdout,
		run: () => rollbackChatGptImportRun({
			config: params.config,
			runId: params.runId
		}),
		render: formatChatGptRollbackSummary
	});
}
function registerWikiCli(program, pluginConfig, appConfig) {
	const config = isResolvedMemoryWikiConfig(pluginConfig) ? pluginConfig : resolveMemoryWikiConfig(pluginConfig);
	const wiki = program.command("wiki").description("Inspect and initialize the memory wiki vault");
	wiki.command("status").description("Show wiki vault status").option("--json", "Print JSON").action(async (opts) => {
		await runWikiStatus({
			config,
			appConfig,
			json: opts.json
		});
	});
	wiki.command("doctor").description("Audit wiki vault setup and report actionable fixes").option("--json", "Print JSON").action(async (opts) => {
		await runWikiDoctor({
			config,
			appConfig,
			json: opts.json
		});
	});
	wiki.command("init").description("Initialize the wiki vault layout").option("--json", "Print JSON").action(async (opts) => {
		await runWikiInit({
			config,
			json: opts.json
		});
	});
	wiki.command("compile").description("Refresh generated wiki indexes").option("--json", "Print JSON").action(async (opts) => {
		await runWikiCompile({
			config,
			appConfig,
			json: opts.json
		});
	});
	wiki.command("lint").description("Lint the wiki vault and write a report").option("--json", "Print JSON").action(async (opts) => {
		await runWikiLint({
			config,
			appConfig,
			json: opts.json
		});
	});
	wiki.command("ingest").description("Ingest a local file into the wiki sources folder").argument("<path>", "Local file path to ingest").option("--title <title>", "Override the source title").option("--json", "Print JSON").action(async (inputPath, opts) => {
		await runWikiIngest({
			config,
			inputPath,
			title: opts.title,
			json: opts.json
		});
	});
	addWikiSearchConfigOptions(wiki.command("search").description("Search wiki pages and, when configured, the active memory corpus").argument("<query>", "Search query").option("--max-results <n>", "Maximum results", (value) => Number(value)).option("--mode <mode>", `Search mode (${WIKI_SEARCH_MODES.join(", ")})`)).option("--json", "Print JSON").action(async (query, opts) => {
		await runWikiSearch({
			config,
			appConfig,
			query,
			maxResults: opts.maxResults,
			searchBackend: opts.backend,
			searchCorpus: opts.corpus,
			mode: opts.mode,
			json: opts.json
		});
	});
	addWikiSearchConfigOptions(wiki.command("get").description("Read a wiki page by id or relative path, with optional active-memory fallback").argument("<lookup>", "Relative path or page id").option("--from <n>", "Start line", (value) => Number(value)).option("--lines <n>", "Number of lines", (value) => Number(value))).option("--json", "Print JSON").action(async (lookup, opts) => {
		await runWikiGet({
			config,
			appConfig,
			lookup,
			fromLine: opts.from,
			lineCount: opts.lines,
			searchBackend: opts.backend,
			searchCorpus: opts.corpus,
			json: opts.json
		});
	});
	const apply = wiki.command("apply").description("Apply narrow wiki mutations");
	addWikiApplyMutationOptions(apply.command("synthesis").description("Create or refresh a synthesis page with managed summary content").argument("<title>", "Synthesis title").option("--body <text>", "Summary body text").option("--body-file <path>", "Read summary body text from a file")).option("--json", "Print JSON").action(async (title, opts) => {
		await runWikiApplySynthesis({
			config,
			appConfig,
			title,
			body: opts.body,
			bodyFile: opts.bodyFile,
			sourceIds: opts.sourceId,
			contradictions: opts.contradiction,
			questions: opts.question,
			confidence: opts.confidence,
			status: opts.status,
			json: opts.json
		});
	});
	addWikiApplyMutationOptions(apply.command("metadata").description("Update metadata on an existing page").argument("<lookup>", "Relative path or page id")).option("--clear-confidence", "Remove any stored confidence value").option("--json", "Print JSON").action(async (lookup, opts) => {
		await runWikiApplyMetadata({
			config,
			appConfig,
			lookup,
			sourceIds: opts.sourceId,
			contradictions: opts.contradiction,
			questions: opts.question,
			confidence: opts.confidence,
			clearConfidence: opts.clearConfidence,
			status: opts.status,
			json: opts.json
		});
	});
	wiki.command("bridge").description("Import public memory artifacts into the wiki vault").command("import").description("Sync bridge-backed memory artifacts into wiki source pages").option("--json", "Print JSON").action(async (opts) => {
		await runWikiBridgeImport({
			config,
			appConfig,
			json: opts.json
		});
	});
	wiki.command("unsafe-local").description("Import explicitly configured private local paths into wiki source pages").command("import").description("Sync unsafe-local configured paths into wiki source pages").option("--json", "Print JSON").action(async (opts) => {
		await runWikiUnsafeLocalImport({
			config,
			appConfig,
			json: opts.json
		});
	});
	const chatgpt = wiki.command("chatgpt").description("Import ChatGPT export history into wiki source pages");
	chatgpt.command("import").description("Import a ChatGPT export into draft wiki source pages").requiredOption("--export <path>", "ChatGPT export directory or conversations.json path").option("--dry-run", "Preview changes without writing", false).option("--json", "Print JSON").action(async (opts) => {
		await runWikiChatGptImport({
			config,
			exportPath: opts.export,
			dryRun: opts.dryRun,
			json: opts.json
		});
	});
	chatgpt.command("rollback").description("Roll back a previously applied ChatGPT import run").argument("<run-id>", "Import run id").option("--json", "Print JSON").action(async (runId, opts) => {
		await runWikiChatGptRollback({
			config,
			runId,
			json: opts.json
		});
	});
	const obsidian = wiki.command("obsidian").description("Run official Obsidian CLI helpers");
	obsidian.command("status").description("Probe the Obsidian CLI").option("--json", "Print JSON").action(async (opts) => {
		await runWikiObsidianStatus({
			config,
			json: opts.json
		});
	});
	obsidian.command("search").description("Search the current Obsidian vault").argument("<query>", "Search query").option("--json", "Print JSON").action(async (query, opts) => {
		await runWikiObsidianSearch({
			config,
			query,
			json: opts.json
		});
	});
	obsidian.command("open").description("Open a file in Obsidian by vault-relative path").argument("<path>", "Vault-relative path").option("--json", "Print JSON").action(async (vaultPath, opts) => {
		await runWikiObsidianOpenCli({
			config,
			vaultPath,
			json: opts.json
		});
	});
	obsidian.command("command").description("Execute an Obsidian command palette command by id").argument("<id>", "Obsidian command id").option("--json", "Print JSON").action(async (id, opts) => {
		await runWikiObsidianCommandCli({
			config,
			id,
			json: opts.json
		});
	});
	obsidian.command("daily").description("Open today's daily note in Obsidian").option("--json", "Print JSON").action(async (opts) => {
		await runWikiObsidianDailyCli({
			config,
			json: opts.json
		});
	});
}
//#endregion
export { lintMemoryWikiVault as A, parseWikiMarkdown as B, resolveMemoryWikiStatus as C, runObsidianDaily as D, runObsidianCommand as E, getMemoryWikiPage as F, readQueryableWikiPages as I, searchMemoryWiki as L, applyMemoryWikiMutation as M, normalizeMemoryWikiMutationInput as N, runObsidianOpen as O, WIKI_SEARCH_MODES as P, compileMemoryWikiVault as R, renderMemoryWikiStatus as S, probeObsidianCli as T, runWikiObsidianStatus as _, runWikiChatGptImport as a, runWikiUnsafeLocalImport as b, runWikiDoctor as c, runWikiInit as d, runWikiLint as f, runWikiObsidianSearch as g, runWikiObsidianOpenCli as h, runWikiBridgeImport as i, ingestMemoryWikiSource as j, runObsidianSearch as k, runWikiGet as l, runWikiObsidianDailyCli as m, runWikiApplyMetadata as n, runWikiChatGptRollback as o, runWikiObsidianCommandCli as p, runWikiApplySynthesis as r, runWikiCompile as s, registerWikiCli as t, runWikiIngest as u, runWikiSearch as v, syncMemoryWikiImportedSources as w, buildMemoryWikiDoctorReport as x, runWikiStatus as y, initializeMemoryWikiVault as z };
