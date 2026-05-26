import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import { n as asNullableRecord } from "./record-coerce-aMlBWINm.js";
import { V as formatMemoryDreamingDay } from "./dreaming-CxCxWYoC.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./security-runtime-CcSekjBd.js";
import { n as appendMemoryHostEvent } from "./events-mq9owIje.js";
import "./memory-core-host-status-CceUImkn.js";
import "./memory-host-events-B9F8o8ue.js";
import "./dreaming-shared-TJ4wErqZ.js";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
const CONCEPT_STOP_WORDS = new Set(Object.values({
	shared: [
		"about",
		"after",
		"agent",
		"again",
		"also",
		"assistant",
		"because",
		"before",
		"being",
		"between",
		"build",
		"called",
		"could",
		"daily",
		"default",
		"deploy",
		"during",
		"every",
		"file",
		"files",
		"from",
		"have",
		"into",
		"just",
		"line",
		"lines",
		"long",
		"main",
		"make",
		"memory",
		"month",
		"more",
		"most",
		"move",
		"much",
		"next",
		"note",
		"notes",
		"over",
		"part",
		"past",
		"port",
		"same",
		"score",
		"search",
		"session",
		"sessions",
		"short",
		"should",
		"since",
		"some",
		"subagent",
		"system",
		"than",
		"that",
		"their",
		"there",
		"these",
		"they",
		"this",
		"through",
		"today",
		"user",
		"using",
		"with",
		"work",
		"workspace",
		"year"
	],
	english: [
		"and",
		"are",
		"for",
		"into",
		"its",
		"our",
		"the",
		"then",
		"were",
		"you",
		"your"
	],
	spanish: [
		"al",
		"con",
		"como",
		"de",
		"del",
		"el",
		"en",
		"es",
		"la",
		"las",
		"los",
		"para",
		"por",
		"que",
		"se",
		"sin",
		"su",
		"sus",
		"una",
		"uno",
		"unos",
		"unas",
		"y"
	],
	french: [
		"au",
		"aux",
		"avec",
		"dans",
		"de",
		"des",
		"du",
		"en",
		"est",
		"et",
		"la",
		"le",
		"les",
		"ou",
		"pour",
		"que",
		"qui",
		"sans",
		"ses",
		"son",
		"sur",
		"une",
		"un"
	],
	german: [
		"auf",
		"aus",
		"bei",
		"das",
		"dem",
		"den",
		"der",
		"des",
		"die",
		"ein",
		"eine",
		"einem",
		"einen",
		"einer",
		"für",
		"im",
		"in",
		"mit",
		"nach",
		"oder",
		"ohne",
		"über",
		"und",
		"von",
		"zu",
		"zum",
		"zur"
	],
	cjk: [
		"が",
		"から",
		"する",
		"して",
		"した",
		"で",
		"と",
		"に",
		"の",
		"は",
		"へ",
		"まで",
		"も",
		"や",
		"を",
		"与",
		"为",
		"了",
		"及",
		"和",
		"在",
		"将",
		"或",
		"把",
		"是",
		"用",
		"的",
		"과",
		"는",
		"도",
		"로",
		"를",
		"에",
		"에서",
		"와",
		"은",
		"으로",
		"을",
		"이",
		"하다",
		"한",
		"할",
		"해",
		"했다",
		"했다"
	],
	pathNoise: [
		"cjs",
		"cpp",
		"cts",
		"jsx",
		"json",
		"md",
		"mjs",
		"mts",
		"text",
		"toml",
		"ts",
		"tsx",
		"txt",
		"yaml",
		"yml"
	]
}).flatMap((words) => words).map((word) => normalizeLowercaseStringOrEmpty(word)));
const PROTECTED_GLOSSARY = [
	"backup",
	"backups",
	"embedding",
	"embeddings",
	"failover",
	"gateway",
	"glacier",
	"gpt",
	"kv",
	"network",
	"openai",
	"qmd",
	"router",
	"s3",
	"vlan",
	"sauvegarde",
	"routeur",
	"passerelle",
	"konfiguration",
	"sicherung",
	"überwachung",
	"configuración",
	"respaldo",
	"enrutador",
	"puerta-de-enlace",
	"バックアップ",
	"フェイルオーバー",
	"ルーター",
	"ネットワーク",
	"ゲートウェイ",
	"障害対応",
	"路由器",
	"备份",
	"故障转移",
	"网络",
	"网关",
	"라우터",
	"백업",
	"페일오버",
	"네트워크",
	"게이트웨이",
	"장애대응"
].map((word) => normalizeLowercaseStringOrEmpty(word.normalize("NFKC")));
const COMPOUND_TOKEN_RE = /[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)+/gu;
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const LATIN_RE = /\p{Script=Latin}/u;
const HAN_RE = /\p{Script=Han}/u;
const HIRAGANA_RE = /\p{Script=Hiragana}/u;
const KATAKANA_RE = /\p{Script=Katakana}/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
const DEFAULT_WORD_SEGMENTER = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("und", { granularity: "word" }) : null;
function containsLetterOrNumber(value) {
	return LETTER_OR_NUMBER_RE.test(value);
}
function classifyConceptTagScript(tag) {
	const normalized = tag.normalize("NFKC");
	const hasLatin = LATIN_RE.test(normalized);
	const hasCjk = HAN_RE.test(normalized) || HIRAGANA_RE.test(normalized) || KATAKANA_RE.test(normalized) || HANGUL_RE.test(normalized);
	if (hasLatin && hasCjk) return "mixed";
	if (hasCjk) return "cjk";
	if (hasLatin) return "latin";
	return "other";
}
function minimumTokenLengthForScript(script) {
	if (script === "cjk") return 2;
	return 3;
}
function isKanaOnlyToken(value) {
	return !HAN_RE.test(value) && !HANGUL_RE.test(value) && (HIRAGANA_RE.test(value) || KATAKANA_RE.test(value));
}
function normalizeConceptToken(rawToken) {
	const normalized = normalizeLowercaseStringOrEmpty(rawToken.normalize("NFKC").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replaceAll("_", "-"));
	if (!normalized || !containsLetterOrNumber(normalized) || normalized.length > 32) return null;
	if (/^\d+$/.test(normalized) || /^\d{4}-\d{2}-\d{2}$/u.test(normalized) || /^\d{4}-\d{2}-\d{2}\.[\p{L}\p{N}]+$/u.test(normalized)) return null;
	const script = classifyConceptTagScript(normalized);
	if (normalized.length < minimumTokenLengthForScript(script)) return null;
	if (isKanaOnlyToken(normalized) && normalized.length < 3) return null;
	if (CONCEPT_STOP_WORDS.has(normalized)) return null;
	return normalized;
}
function collectGlossaryMatches(source) {
	const normalizedSource = normalizeLowercaseStringOrEmpty(source.normalize("NFKC"));
	const matches = [];
	for (const entry of PROTECTED_GLOSSARY) {
		if (!normalizedSource.includes(entry)) continue;
		matches.push(entry);
	}
	return matches;
}
function collectCompoundTokens(source) {
	return source.match(COMPOUND_TOKEN_RE) ?? [];
}
function collectSegmentTokens(source) {
	if (DEFAULT_WORD_SEGMENTER) return Array.from(DEFAULT_WORD_SEGMENTER.segment(source), (part) => part.isWordLike ? part.segment : "").filter(Boolean);
	return source.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
function pushNormalizedTag(tags, rawToken, limit) {
	const normalized = normalizeConceptToken(rawToken);
	if (!normalized || tags.includes(normalized)) return;
	tags.push(normalized);
	if (tags.length > limit) tags.splice(limit);
}
function deriveConceptTags(params) {
	const source = `${path.basename(params.path)} ${params.snippet}`;
	const limit = Number.isFinite(params.limit) ? Math.max(0, Math.floor(params.limit)) : 8;
	if (limit === 0) return [];
	const tags = [];
	for (const rawToken of [
		...collectGlossaryMatches(source),
		...collectCompoundTokens(source),
		...collectSegmentTokens(source)
	]) {
		pushNormalizedTag(tags, rawToken, limit);
		if (tags.length >= limit) break;
	}
	return tags;
}
function summarizeConceptTagScriptCoverage(conceptTagsByEntry) {
	const coverage = {
		latinEntryCount: 0,
		cjkEntryCount: 0,
		mixedEntryCount: 0,
		otherEntryCount: 0
	};
	for (const conceptTags of conceptTagsByEntry) {
		let hasLatin = false;
		let hasCjk = false;
		let hasOther = false;
		for (const tag of conceptTags) {
			const family = classifyConceptTagScript(tag);
			if (family === "mixed") {
				hasLatin = true;
				hasCjk = true;
				continue;
			}
			if (family === "latin") {
				hasLatin = true;
				continue;
			}
			if (family === "cjk") {
				hasCjk = true;
				continue;
			}
			hasOther = true;
		}
		if (hasLatin && hasCjk) coverage.mixedEntryCount += 1;
		else if (hasCjk) coverage.cjkEntryCount += 1;
		else if (hasLatin) coverage.latinEntryCount += 1;
		else if (hasOther) coverage.otherEntryCount += 1;
	}
	return coverage;
}
//#endregion
//#region extensions/memory-core/src/memory-budget.ts
/**
* Bounded MEMORY.md compaction for dreaming/promotion writes.
*
* Background: the dreaming pipeline appends promoted entries to MEMORY.md
* via short-term-promotion.applyShortTermPromotions. Without a size budget,
* MEMORY.md grows unboundedly across deep-phase sweeps and eventually
* exceeds bootstrap's per-file injection cap, breaking session bootstrap.
* See issue #73691.
*
* Strategy: drop the OLDEST auto-promoted sections (date-ordered) until
* the file plus the new section fit within the budget. User-authored
* content (anything that is not a `## Promoted From Short-Term Memory
* (DATE)` section) is preserved unconditionally — only dreaming-owned
* sections are eligible for compaction.
*/
const PROMOTION_SECTION_HEADING_RE = /^## Promoted From Short-Term Memory \(([^)]+)\)\s*$/;
/**
* Default budget for MEMORY.md content on disk, in characters. Chosen to
* stay safely below the bootstrap injection cap (~12KB per file at the
* time of writing) so promoted memory keeps reaching new sessions instead
* of being silently dropped by bootstrap truncation.
*/
const DEFAULT_MEMORY_FILE_MAX_CHARS = 1e4;
/**
* Reserve for writer-side overhead that the helper does not see directly:
* the `# Long-Term Memory\n\n` header re-emitted when compaction empties
* out (20 chars) and `withTrailingNewline`'s trailing `\n` (1 char). See
* the actual write expression in `applyShortTermPromotions`. Subtracting
* this from `budgetChars` keeps the on-disk file inside the caller's
* stated budget instead of exceeding it by up to ~21 chars in edge cases.
*/
const WRITE_OVERHEAD_RESERVE = 21;
function parseMemoryBlocks(content) {
	if (content.length === 0) return [];
	const lines = content.split(/\r?\n/);
	const blocks = [];
	let currentLines = [];
	let currentKind = "preserved";
	let currentDate;
	const flush = () => {
		if (currentLines.length === 0) return;
		const text = currentLines.join("\n");
		if (currentKind === "promotion" && currentDate) blocks.push({
			kind: "promotion",
			date: currentDate,
			text
		});
		else blocks.push({
			kind: "preserved",
			text
		});
		currentLines = [];
		currentKind = "preserved";
		currentDate = void 0;
	};
	for (const line of lines) if (line.startsWith("## ")) {
		flush();
		const match = PROMOTION_SECTION_HEADING_RE.exec(line);
		if (match) {
			currentKind = "promotion";
			currentDate = match[1];
		} else currentKind = "preserved";
		currentLines = [line];
	} else currentLines.push(line);
	flush();
	return blocks;
}
function joinBlocks(blocks) {
	return blocks.map((block) => block.text).join("\n");
}
/**
* Drop oldest auto-promotion sections from `existingMemory` until
* `existingMemory + newSection` fits within `budgetChars`. Returns the
* (possibly trimmed) existing memory and the dates of dropped sections.
*
* Guarantees:
* - Non-promotion content (user-authored markdown, the file header, any
*   `##` heading not matching the promotion pattern) is preserved.
* - Promotion sections are dropped in ascending date order (oldest first).
* - If `existingMemory + newSection` already fits the budget, the existing
*   memory is returned unchanged.
* - If the budget cannot be satisfied even by dropping every promotion
*   section, the function drops them all and returns; the caller writes
*   the new section anyway. This is the "log and continue" failure mode —
*   refusing the new write would silently swallow the freshest material.
*/
function compactMemoryForBudget(params) {
	const { existingMemory, newSection, budgetChars } = params;
	if (budgetChars <= 0) return {
		compacted: existingMemory,
		droppedDates: []
	};
	const effectiveBudget = Math.max(0, budgetChars - WRITE_OVERHEAD_RESERVE);
	if (existingMemory.length + newSection.length <= effectiveBudget) return {
		compacted: existingMemory,
		droppedDates: []
	};
	const blocks = parseMemoryBlocks(existingMemory);
	const promotionEntries = blocks.map((block, index) => block.kind === "promotion" ? {
		index,
		date: block.date,
		length: block.text.length
	} : null).filter((entry) => entry !== null).toSorted((a, b) => a.date.localeCompare(b.date));
	if (promotionEntries.length === 0) return {
		compacted: existingMemory,
		droppedDates: []
	};
	const droppedIndices = /* @__PURE__ */ new Set();
	const droppedDates = [];
	let projectedExistingSize = existingMemory.length;
	const blockSeparatorCost = blocks.length > 1 ? 1 : 0;
	for (const entry of promotionEntries) {
		if (projectedExistingSize + newSection.length <= effectiveBudget) break;
		droppedIndices.add(entry.index);
		droppedDates.push(entry.date);
		projectedExistingSize = Math.max(0, projectedExistingSize - entry.length - blockSeparatorCost);
	}
	if (droppedIndices.size === 0) return {
		compacted: existingMemory,
		droppedDates: []
	};
	return {
		compacted: joinBlocks(blocks.filter((_, index) => !droppedIndices.has(index))),
		droppedDates
	};
}
//#endregion
//#region extensions/memory-core/src/short-term-promotion.ts
const SHORT_TERM_PATH_RE = /(?:^|\/)memory\/(?:[^/]+\/)*(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;
const DREAMING_MEMORY_PATH_RE = /(?:^|\/)memory\/dreaming\//;
const SHORT_TERM_SESSION_CORPUS_RE = /(?:^|\/)memory\/\.dreams\/session-corpus\/(\d{4})-(\d{2})-(\d{2})\.(?:md|txt)$/;
const SHORT_TERM_BASENAME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;
const DAY_MS = 1440 * 60 * 1e3;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;
const DEFAULT_PROMOTION_MIN_SCORE = .75;
const PROMOTION_MARKER_PREFIX = "openclaw-memory-promotion:";
const MAX_QUERY_HASHES = 32;
const MAX_RECALL_DAYS = 16;
const SHORT_TERM_STORE_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-recall.json");
const SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH = path.join("memory", ".dreams", "phase-signals.json");
const SHORT_TERM_LOCK_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-promotion.lock");
const SHORT_TERM_LOCK_WAIT_TIMEOUT_MS = 1e4;
const SHORT_TERM_LOCK_STALE_MS = 6e4;
const SHORT_TERM_LOCK_RETRY_DELAY_MS = 40;
const PHASE_SIGNAL_LIGHT_BOOST_MAX = .06;
const PHASE_SIGNAL_REM_BOOST_MAX = .09;
const PHASE_SIGNAL_HALF_LIFE_DAYS = 14;
const DREAMING_TRANSCRIPT_PROMPT_LINE_RE = /\[[^\]]*dreaming-narrative[^\]]*]\s*(?:User|Assistant):\s*Write a dream diary entry from these memory fragments:?/i;
const DREAMING_DIFF_PREFIX_RE = /@@\s*-\d+(?:,\d+)?\s+[-*+]\s+/iy;
const inProcessShortTermLocks = /* @__PURE__ */ new Map();
const ensuredShortTermDirs = /* @__PURE__ */ new Map();
const DEFAULT_PROMOTION_WEIGHTS = {
	frequency: .24,
	relevance: .3,
	diversity: .15,
	recency: .15,
	consolidation: .1,
	conceptual: .06
};
function clampScore(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}
function toFiniteScore(value, fallback) {
	const num = Number(value);
	if (!Number.isFinite(num)) return fallback;
	if (num < 0 || num > 1) return fallback;
	return num;
}
function normalizeSnippet(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	return trimmed.replace(/\s+/g, " ");
}
function consumeDreamingLeadPrefix(snippet) {
	let index = 0;
	while (index < snippet.length) {
		DREAMING_DIFF_PREFIX_RE.lastIndex = index;
		if (DREAMING_DIFF_PREFIX_RE.exec(snippet)) {
			index = DREAMING_DIFF_PREFIX_RE.lastIndex;
			continue;
		}
		const char = snippet[index];
		if (char === "[" || char === "(") {
			index += 1;
			while (snippet[index] === " ") index += 1;
			continue;
		}
		if ((char === "-" || char === "*" || char === "+" || char === ">") && snippet[index + 1] === " ") {
			index += 2;
			continue;
		}
		break;
	}
	return snippet.slice(index);
}
function hasDreamingNarrativeLead(snippet) {
	const withoutPrefix = consumeDreamingLeadPrefix(snippet);
	if (/^(?:Candidate|Reflections?):/i.test(withoutPrefix)) return true;
	const head = withoutPrefix.slice(0, 200);
	return /\b(?:Candidate|Reflections?):/i.test(head);
}
function isContaminatedDreamingSnippet(raw) {
	const snippet = normalizeSnippet(raw);
	if (!snippet) return false;
	if (/<!--\s*openclaw-memory-promotion:/i.test(snippet) || DREAMING_TRANSCRIPT_PROMPT_LINE_RE.test(snippet)) return true;
	const hasNarrativeLead = hasDreamingNarrativeLead(snippet);
	const hasConfidence = /\bconfidence:\s*\d/i.test(snippet);
	const hasEvidence = /\bevidence:\s*(?:memory\/\.dreams\/session-corpus\/|memory\/)/i.test(snippet);
	const hasStatus = /\bstatus:\s*staged\b/i.test(snippet);
	const hasRecalls = /\brecalls:\s*\d+\b/i.test(snippet);
	return hasNarrativeLead && hasConfidence && hasEvidence && hasStatus && hasRecalls;
}
function normalizeMemoryPath(rawPath) {
	return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}
function buildClaimHash(snippet) {
	return createHash("sha1").update(normalizeSnippet(snippet)).digest("hex").slice(0, 12);
}
function buildEntryKey(result) {
	const base = `${result.source}:${normalizeMemoryPath(result.path)}:${result.startLine}:${result.endLine}`;
	return result.claimHash ? `${base}:${result.claimHash}` : base;
}
function hashQuery(query) {
	return createHash("sha1").update(normalizeLowercaseStringOrEmpty(query)).digest("hex").slice(0, 12);
}
function mergeQueryHashes(existing, queryHash) {
	if (!queryHash) return existing;
	const seen = /* @__PURE__ */ new Set();
	const next = existing.filter((value) => {
		if (!value || seen.has(value)) return false;
		seen.add(value);
		return true;
	});
	if (!seen.has(queryHash)) next.push(queryHash);
	if (next.length <= MAX_QUERY_HASHES) return next;
	return next.slice(next.length - MAX_QUERY_HASHES);
}
function mergeRecentDistinct(existing, nextValue, limit) {
	const seen = /* @__PURE__ */ new Set();
	const next = existing.filter((value) => {
		if (typeof value !== "string" || value.length === 0 || seen.has(value)) return false;
		seen.add(value);
		return true;
	});
	if (nextValue && !next.includes(nextValue)) next.push(nextValue);
	if (next.length <= limit) return next;
	return next.slice(next.length - limit);
}
function normalizeIsoDay(isoLike) {
	if (typeof isoLike !== "string") return null;
	return isoLike.trim().match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}
function normalizeDistinctStrings(values, limit) {
	const seen = /* @__PURE__ */ new Set();
	const normalized = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
		if (normalized.length >= limit) break;
	}
	return normalized;
}
function totalSignalCountForEntry(entry) {
	return Math.max(0, Math.floor(entry.recallCount ?? 0)) + Math.max(0, Math.floor(entry.dailyCount ?? 0)) + Math.max(0, Math.floor(entry.groundedCount ?? 0));
}
function calculateConsolidationComponent(recallDays) {
	if (recallDays.length === 0) return 0;
	if (recallDays.length === 1) return .2;
	const parsed = recallDays.map((value) => Date.parse(`${value}T00:00:00.000Z`)).filter((value) => Number.isFinite(value)).toSorted((left, right) => left - right);
	if (parsed.length <= 1) return .2;
	const spanDays = Math.max(0, (parsed.at(-1) - parsed[0]) / DAY_MS);
	const spacing = clampScore(Math.log1p(parsed.length - 1) / Math.log1p(4));
	const span = clampScore(spanDays / 7);
	return clampScore(.55 * spacing + .45 * span);
}
function calculateConceptualComponent(conceptTags) {
	return clampScore(conceptTags.length / 6);
}
function emptyStore(nowIso) {
	return {
		version: 1,
		updatedAt: nowIso,
		entries: {}
	};
}
function normalizeStore(raw, nowIso) {
	if (!raw || typeof raw !== "object") return emptyStore(nowIso);
	const record = raw;
	const entriesRaw = record.entries;
	const entries = {};
	if (entriesRaw && typeof entriesRaw === "object") for (const [key, value] of Object.entries(entriesRaw)) {
		if (!value || typeof value !== "object") continue;
		const entry = value;
		const entryPath = typeof entry.path === "string" ? normalizeMemoryPath(entry.path) : "";
		const startLine = Number(entry.startLine);
		const endLine = Number(entry.endLine);
		const source = entry.source === "memory" ? "memory" : null;
		if (!entryPath || !Number.isInteger(startLine) || !Number.isInteger(endLine) || !source) continue;
		const recallCount = Math.max(0, Math.floor(Number(entry.recallCount) || 0));
		const dailyCount = Math.max(0, Math.floor(Number(entry.dailyCount) || 0));
		const groundedCount = Math.max(0, Math.floor(Number(entry.groundedCount) || 0));
		const totalScore = Math.max(0, Number(entry.totalScore) || 0);
		const maxScore = clampScore(Number(entry.maxScore) || 0);
		const firstRecalledAt = typeof entry.firstRecalledAt === "string" ? entry.firstRecalledAt : nowIso;
		const lastRecalledAt = typeof entry.lastRecalledAt === "string" ? entry.lastRecalledAt : nowIso;
		const promotedAt = typeof entry.promotedAt === "string" ? entry.promotedAt : void 0;
		const claimHash = typeof entry.claimHash === "string" && entry.claimHash.trim().length > 0 ? entry.claimHash.trim() : void 0;
		const snippet = typeof entry.snippet === "string" ? normalizeSnippet(entry.snippet) : "";
		if (snippet && isContaminatedDreamingSnippet(snippet)) continue;
		const queryHashes = Array.isArray(entry.queryHashes) ? normalizeDistinctStrings(entry.queryHashes, MAX_QUERY_HASHES) : [];
		const recallDays = Array.isArray(entry.recallDays) ? entry.recallDays.map((value) => normalizeIsoDay(String(value))).filter((value) => value !== null) : [];
		const conceptTags = Array.isArray(entry.conceptTags) ? normalizeDistinctStrings(entry.conceptTags.map((tag) => typeof tag === "string" ? normalizeLowercaseStringOrEmpty(tag) : tag), 8) : deriveConceptTags({
			path: entryPath,
			snippet
		});
		const normalizedKey = key || buildEntryKey({
			path: entryPath,
			startLine,
			endLine,
			source,
			claimHash
		});
		entries[normalizedKey] = {
			key: normalizedKey,
			path: entryPath,
			startLine,
			endLine,
			source,
			snippet,
			recallCount,
			dailyCount,
			groundedCount,
			totalScore,
			maxScore,
			firstRecalledAt,
			lastRecalledAt,
			queryHashes,
			recallDays: recallDays.slice(-16),
			conceptTags,
			...claimHash ? { claimHash } : {},
			...promotedAt ? { promotedAt } : {}
		};
	}
	return {
		version: 1,
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso,
		entries
	};
}
function toFinitePositive(value, fallback) {
	const num = Number(value);
	if (!Number.isFinite(num) || num <= 0) return fallback;
	return num;
}
function toFiniteNonNegativeInt(value, fallback) {
	const num = Number(value);
	if (!Number.isFinite(num)) return fallback;
	const floored = Math.floor(num);
	if (floored < 0) return fallback;
	return floored;
}
function normalizeWeights(weights) {
	const merged = {
		...DEFAULT_PROMOTION_WEIGHTS,
		...weights
	};
	const frequency = Math.max(0, merged.frequency);
	const relevance = Math.max(0, merged.relevance);
	const diversity = Math.max(0, merged.diversity);
	const recency = Math.max(0, merged.recency);
	const consolidation = Math.max(0, merged.consolidation);
	const conceptual = Math.max(0, merged.conceptual);
	const sum = frequency + relevance + diversity + recency + consolidation + conceptual;
	if (sum <= 0) return { ...DEFAULT_PROMOTION_WEIGHTS };
	return {
		frequency: frequency / sum,
		relevance: relevance / sum,
		diversity: diversity / sum,
		recency: recency / sum,
		consolidation: consolidation / sum,
		conceptual: conceptual / sum
	};
}
function calculateRecencyComponent(ageDays, halfLifeDays) {
	if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
	if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
	const lambda = Math.LN2 / halfLifeDays;
	return Math.exp(-lambda * ageDays);
}
function calculatePhaseSignalAgeDays(lastSeenAt, nowMs) {
	if (!lastSeenAt) return null;
	const parsed = Date.parse(lastSeenAt);
	if (!Number.isFinite(parsed)) return null;
	return Math.max(0, (nowMs - parsed) / DAY_MS);
}
function calculatePhaseSignalBoost(entry, nowMs) {
	if (!entry) return 0;
	const lightStrength = clampScore(Math.log1p(Math.max(0, entry.lightHits)) / Math.log1p(6));
	const remStrength = clampScore(Math.log1p(Math.max(0, entry.remHits)) / Math.log1p(6));
	const lightAgeDays = calculatePhaseSignalAgeDays(entry.lastLightAt, nowMs);
	const remAgeDays = calculatePhaseSignalAgeDays(entry.lastRemAt, nowMs);
	const lightRecency = lightAgeDays === null ? 0 : clampScore(calculateRecencyComponent(lightAgeDays, PHASE_SIGNAL_HALF_LIFE_DAYS));
	const remRecency = remAgeDays === null ? 0 : clampScore(calculateRecencyComponent(remAgeDays, PHASE_SIGNAL_HALF_LIFE_DAYS));
	return clampScore(PHASE_SIGNAL_LIGHT_BOOST_MAX * lightStrength * lightRecency + PHASE_SIGNAL_REM_BOOST_MAX * remStrength * remRecency);
}
function resolveStorePath(workspaceDir) {
	return path.join(workspaceDir, SHORT_TERM_STORE_RELATIVE_PATH);
}
function resolveLockPath(workspaceDir) {
	return path.join(workspaceDir, SHORT_TERM_LOCK_RELATIVE_PATH);
}
function resolveShortTermArtifactsDir(workspaceDir) {
	return path.dirname(resolveLockPath(workspaceDir));
}
async function ensureShortTermArtifactsDir(workspaceDir) {
	const artifactsDir = resolveShortTermArtifactsDir(workspaceDir);
	const existing = ensuredShortTermDirs.get(artifactsDir);
	if (existing) {
		await existing;
		return;
	}
	const ensuring = fs.mkdir(artifactsDir, { recursive: true }).then(() => void 0).catch((err) => {
		ensuredShortTermDirs.delete(artifactsDir);
		throw err;
	});
	ensuredShortTermDirs.set(artifactsDir, ensuring);
	await ensuring;
}
function parseLockOwnerPid(raw) {
	const match = raw.trim().match(/^(\d+):/);
	if (!match) return null;
	const pid = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	return pid;
}
function isProcessLikelyAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if (err.code === "ESRCH") return false;
		return true;
	}
}
async function canStealStaleLock(lockPath) {
	const ownerPid = await fs.readFile(lockPath, "utf-8").then((raw) => parseLockOwnerPid(raw)).catch(() => null);
	if (ownerPid === null) return true;
	return !isProcessLikelyAlive(ownerPid);
}
async function sleep(ms) {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
async function withInProcessShortTermLock(lockPath, task) {
	const previous = inProcessShortTermLocks.get(lockPath) ?? Promise.resolve();
	let releaseCurrent;
	const current = new Promise((resolve) => {
		releaseCurrent = resolve;
	});
	const queued = previous.catch(() => void 0).then(() => current);
	inProcessShortTermLocks.set(lockPath, queued);
	await previous.catch(() => void 0);
	try {
		return await task();
	} finally {
		releaseCurrent();
		if (inProcessShortTermLocks.get(lockPath) === queued) inProcessShortTermLocks.delete(lockPath);
	}
}
async function withShortTermLock(workspaceDir, task) {
	const lockPath = resolveLockPath(workspaceDir);
	return withInProcessShortTermLock(lockPath, async () => {
		await ensureShortTermArtifactsDir(workspaceDir);
		const startedAt = Date.now();
		while (true) try {
			const lockHandle = await fs.open(lockPath, "wx");
			await lockHandle.writeFile(`${process.pid}:${Date.now()}\n`, "utf-8").catch(() => void 0);
			try {
				return await task();
			} finally {
				await lockHandle.close().catch(() => void 0);
				await fs.unlink(lockPath).catch(() => void 0);
			}
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
			if (await fs.stat(lockPath).then((stats) => Date.now() - stats.mtimeMs).catch(() => 0) > SHORT_TERM_LOCK_STALE_MS) {
				if (await canStealStaleLock(lockPath)) {
					await fs.unlink(lockPath).catch(() => void 0);
					continue;
				}
			}
			if (Date.now() - startedAt >= SHORT_TERM_LOCK_WAIT_TIMEOUT_MS) throw new Error(`Timed out waiting for short-term promotion lock at ${lockPath}`, { cause: err });
			await sleep(SHORT_TERM_LOCK_RETRY_DELAY_MS);
		}
	});
}
async function readStore(workspaceDir, nowIso) {
	try {
		return normalizeStore(await privateFileStore(workspaceDir).readJsonIfExists(SHORT_TERM_STORE_RELATIVE_PATH), nowIso);
	} catch (err) {
		if (err?.code === "ENOENT") return emptyStore(nowIso);
		throw err;
	}
}
function emptyPhaseSignalStore(nowIso) {
	return {
		version: 1,
		updatedAt: nowIso,
		entries: {}
	};
}
function normalizePhaseSignalStore(raw, nowIso) {
	const record = asNullableRecord(raw);
	if (!record) return emptyPhaseSignalStore(nowIso);
	const entriesRaw = asNullableRecord(record?.entries);
	if (!entriesRaw) return emptyPhaseSignalStore(nowIso);
	const entries = {};
	for (const [mapKey, value] of Object.entries(entriesRaw)) {
		const entry = asNullableRecord(value);
		if (!entry) continue;
		const key = typeof entry.key === "string" && entry.key.trim().length > 0 ? entry.key : mapKey;
		const lightHits = toFiniteNonNegativeInt(entry.lightHits, 0);
		const remHits = toFiniteNonNegativeInt(entry.remHits, 0);
		if (lightHits === 0 && remHits === 0) continue;
		const lastLightAt = typeof entry.lastLightAt === "string" && entry.lastLightAt.trim().length > 0 ? entry.lastLightAt : void 0;
		const lastRemAt = typeof entry.lastRemAt === "string" && entry.lastRemAt.trim().length > 0 ? entry.lastRemAt : void 0;
		entries[key] = {
			key,
			lightHits,
			remHits,
			...lastLightAt ? { lastLightAt } : {},
			...lastRemAt ? { lastRemAt } : {}
		};
	}
	return {
		version: 1,
		updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim().length > 0 ? record.updatedAt : nowIso,
		entries
	};
}
async function readPhaseSignalStore(workspaceDir, nowIso) {
	try {
		return normalizePhaseSignalStore(await privateFileStore(workspaceDir).readJsonIfExists(SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH), nowIso);
	} catch {
		return emptyPhaseSignalStore(nowIso);
	}
}
async function writePhaseSignalStore(workspaceDir, store) {
	await ensureShortTermArtifactsDir(workspaceDir);
	await privateFileStore(workspaceDir).writeJson(SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH, store, { trailingNewline: true });
}
async function writeStore(workspaceDir, store) {
	await ensureShortTermArtifactsDir(workspaceDir);
	await privateFileStore(workspaceDir).writeJson(SHORT_TERM_STORE_RELATIVE_PATH, store, { trailingNewline: true });
}
function isShortTermMemoryPath(filePath) {
	const normalized = normalizeMemoryPath(filePath);
	if (DREAMING_MEMORY_PATH_RE.test(normalized)) return false;
	if (SHORT_TERM_PATH_RE.test(normalized)) return true;
	if (SHORT_TERM_SESSION_CORPUS_RE.test(normalized)) return true;
	return SHORT_TERM_BASENAME_RE.test(normalized);
}
async function shortTermRecallSourceExists(params) {
	const workspaceDir = params.workspaceDir.trim();
	if (!workspaceDir) return false;
	for (const sourcePath of resolveShortTermSourcePathCandidates(workspaceDir, params.entry.path)) try {
		if ((await fs.stat(sourcePath)).isFile()) return true;
	} catch (err) {
		if (err.code === "ENOENT") continue;
		throw err;
	}
	return false;
}
async function filterLiveShortTermRecallEntries(params) {
	return (await Promise.all(params.entries.map(async (entry) => ({
		entry,
		exists: await shortTermRecallSourceExists({
			workspaceDir: params.workspaceDir,
			entry
		})
	})))).filter((result) => result.exists).map((result) => result.entry);
}
async function recordShortTermRecalls(params) {
	const workspaceDir = params.workspaceDir?.trim();
	if (!workspaceDir) return;
	const query = params.query.trim();
	if (!query) return;
	const relevant = params.results.filter((result) => result.source === "memory" && isShortTermMemoryPath(result.path));
	if (relevant.length === 0) return;
	const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const signalType = params.signalType ?? "recall";
	const queryHash = hashQuery(query);
	const todayBucket = normalizeIsoDay(params.dayBucket ?? "") ?? formatMemoryDreamingDay(nowMs, params.timezone);
	await withShortTermLock(workspaceDir, async () => {
		const store = await readStore(workspaceDir, nowIso);
		for (const result of relevant) {
			const normalizedPath = normalizeMemoryPath(result.path);
			const snippet = normalizeSnippet(result.snippet);
			if (!snippet || isContaminatedDreamingSnippet(snippet)) continue;
			const claimHash = snippet ? buildClaimHash(snippet) : void 0;
			const groundedKey = claimHash ? buildEntryKey({
				path: normalizedPath,
				startLine: Math.max(1, Math.floor(result.startLine)),
				endLine: Math.max(1, Math.floor(result.endLine)),
				source: "memory",
				claimHash
			}) : null;
			const baseKey = buildEntryKey(result);
			const key = groundedKey && store.entries[groundedKey] ? groundedKey : baseKey;
			const existing = store.entries[key];
			const score = clampScore(result.score);
			const recallDaysBase = existing?.recallDays ?? [];
			const queryHashesBase = existing?.queryHashes ?? [];
			const dedupeSignal = Boolean(params.dedupeByQueryPerDay) && queryHashesBase.includes(queryHash) && recallDaysBase.includes(todayBucket);
			const recallCount = signalType === "recall" ? Math.max(0, Math.floor(existing?.recallCount ?? 0) + (dedupeSignal ? 0 : 1)) : Math.max(0, Math.floor(existing?.recallCount ?? 0));
			const dailyCount = signalType === "daily" ? Math.max(0, Math.floor(existing?.dailyCount ?? 0) + (dedupeSignal ? 0 : 1)) : Math.max(0, Math.floor(existing?.dailyCount ?? 0));
			const totalScore = Math.max(0, (existing?.totalScore ?? 0) + (dedupeSignal ? 0 : score));
			const maxScore = Math.max(existing?.maxScore ?? 0, dedupeSignal ? 0 : score);
			const queryHashes = mergeQueryHashes(existing?.queryHashes ?? [], queryHash);
			const recallDays = mergeRecentDistinct(recallDaysBase, todayBucket, MAX_RECALL_DAYS);
			const conceptTags = deriveConceptTags({
				path: normalizedPath,
				snippet
			});
			store.entries[key] = {
				key,
				path: normalizedPath,
				startLine: Math.max(1, Math.floor(result.startLine)),
				endLine: Math.max(1, Math.floor(result.endLine)),
				source: "memory",
				snippet: snippet || existing?.snippet || "",
				recallCount,
				dailyCount,
				groundedCount: Math.max(0, Math.floor(existing?.groundedCount ?? 0)),
				totalScore,
				maxScore,
				firstRecalledAt: existing?.firstRecalledAt ?? nowIso,
				lastRecalledAt: nowIso,
				queryHashes,
				recallDays,
				conceptTags: conceptTags.length > 0 ? conceptTags : existing?.conceptTags ?? [],
				...existing?.claimHash ? { claimHash: existing.claimHash } : {},
				...existing?.promotedAt ? { promotedAt: existing.promotedAt } : {}
			};
		}
		store.updatedAt = nowIso;
		await writeStore(workspaceDir, store);
		await appendMemoryHostEvent(workspaceDir, {
			type: "memory.recall.recorded",
			timestamp: nowIso,
			query,
			resultCount: relevant.length,
			results: relevant.map((result) => ({
				path: normalizeMemoryPath(result.path),
				startLine: Math.max(1, Math.floor(result.startLine)),
				endLine: Math.max(1, Math.floor(result.endLine)),
				score: clampScore(result.score)
			}))
		});
	});
}
async function recordGroundedShortTermCandidates(params) {
	const workspaceDir = params.workspaceDir?.trim();
	if (!workspaceDir) return;
	const query = params.query.trim();
	if (!query) return;
	const relevant = params.items.map((item) => {
		const snippet = normalizeSnippet(item.snippet);
		const normalizedPath = normalizeMemoryPath(item.path);
		if (!snippet || isContaminatedDreamingSnippet(snippet) || !normalizedPath || !isShortTermMemoryPath(normalizedPath) || !Number.isFinite(item.startLine) || !Number.isFinite(item.endLine)) return null;
		return {
			path: normalizedPath,
			startLine: Math.max(1, Math.floor(item.startLine)),
			endLine: Math.max(1, Math.floor(item.endLine)),
			snippet,
			score: clampScore(item.score),
			query: normalizeSnippet(item.query ?? query),
			signalCount: Math.max(1, Math.floor(item.signalCount ?? 1)),
			dayBucket: normalizeIsoDay(item.dayBucket ?? params.dayBucket ?? "")
		};
	}).filter((item) => item !== null);
	if (relevant.length === 0) return;
	const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const fallbackDayBucket = formatMemoryDreamingDay(nowMs, params.timezone);
	await withShortTermLock(workspaceDir, async () => {
		const store = await readStore(workspaceDir, nowIso);
		for (const item of relevant) {
			const dayBucket = item.dayBucket ?? fallbackDayBucket;
			const effectiveQuery = item.query || query;
			if (!effectiveQuery) continue;
			const queryHash = hashQuery(effectiveQuery);
			const claimHash = buildClaimHash(item.snippet);
			const key = buildEntryKey({
				path: item.path,
				startLine: item.startLine,
				endLine: item.endLine,
				source: "memory",
				claimHash
			});
			const existing = store.entries[key];
			const recallDaysBase = existing?.recallDays ?? [];
			const queryHashesBase = existing?.queryHashes ?? [];
			const dedupeSignal = Boolean(params.dedupeByQueryPerDay) && queryHashesBase.includes(queryHash) && recallDaysBase.includes(dayBucket);
			const groundedCount = Math.max(0, Math.floor(existing?.groundedCount ?? 0) + (dedupeSignal ? 0 : item.signalCount));
			const totalScore = Math.max(0, (existing?.totalScore ?? 0) + (dedupeSignal ? 0 : item.score * item.signalCount));
			const maxScore = Math.max(existing?.maxScore ?? 0, dedupeSignal ? 0 : item.score);
			const queryHashes = mergeQueryHashes(existing?.queryHashes ?? [], queryHash);
			const recallDays = mergeRecentDistinct(recallDaysBase, dayBucket, MAX_RECALL_DAYS);
			const conceptTags = deriveConceptTags({
				path: item.path,
				snippet: item.snippet
			});
			store.entries[key] = {
				key,
				path: item.path,
				startLine: item.startLine,
				endLine: item.endLine,
				source: "memory",
				snippet: item.snippet,
				recallCount: Math.max(0, Math.floor(existing?.recallCount ?? 0)),
				dailyCount: Math.max(0, Math.floor(existing?.dailyCount ?? 0)),
				groundedCount,
				totalScore,
				maxScore,
				firstRecalledAt: existing?.firstRecalledAt ?? nowIso,
				lastRecalledAt: nowIso,
				queryHashes,
				recallDays,
				conceptTags: conceptTags.length > 0 ? conceptTags : existing?.conceptTags ?? [],
				claimHash,
				...existing?.promotedAt ? { promotedAt: existing.promotedAt } : {}
			};
		}
		store.updatedAt = nowIso;
		await writeStore(workspaceDir, store);
	});
}
async function recordDreamingPhaseSignals(params) {
	const workspaceDir = params.workspaceDir?.trim();
	if (!workspaceDir) return;
	const keys = [...new Set(params.keys.map((key) => key.trim()).filter(Boolean))];
	if (keys.length === 0) return;
	const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
	const nowIso = new Date(nowMs).toISOString();
	await withShortTermLock(workspaceDir, async () => {
		const [store, phaseSignals] = await Promise.all([readStore(workspaceDir, nowIso), readPhaseSignalStore(workspaceDir, nowIso)]);
		const knownKeys = new Set(Object.keys(store.entries));
		for (const key of keys) {
			if (!knownKeys.has(key)) continue;
			const entry = phaseSignals.entries[key] ?? {
				key,
				lightHits: 0,
				remHits: 0
			};
			if (params.phase === "light") {
				entry.lightHits = Math.min(9999, entry.lightHits + 1);
				entry.lastLightAt = nowIso;
			} else {
				entry.remHits = Math.min(9999, entry.remHits + 1);
				entry.lastRemAt = nowIso;
			}
			phaseSignals.entries[key] = entry;
		}
		for (const [key, entry] of Object.entries(phaseSignals.entries)) if (!knownKeys.has(key) || entry.lightHits <= 0 && entry.remHits <= 0) delete phaseSignals.entries[key];
		phaseSignals.updatedAt = nowIso;
		await writePhaseSignalStore(workspaceDir, phaseSignals);
	});
}
async function rankShortTermPromotionCandidates(options) {
	const workspaceDir = options.workspaceDir.trim();
	if (!workspaceDir) return [];
	const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const minScore = toFiniteScore(options.minScore, DEFAULT_PROMOTION_MIN_SCORE);
	const minRecallCount = toFiniteNonNegativeInt(options.minRecallCount, 3);
	const minUniqueQueries = toFiniteNonNegativeInt(options.minUniqueQueries, 2);
	const maxAgeDays = toFiniteNonNegativeInt(options.maxAgeDays, -1);
	const includePromoted = Boolean(options.includePromoted);
	const halfLifeDays = toFinitePositive(options.recencyHalfLifeDays, DEFAULT_RECENCY_HALF_LIFE_DAYS);
	const weights = normalizeWeights(options.weights);
	const [store, phaseSignals] = await Promise.all([readStore(workspaceDir, nowIso), readPhaseSignalStore(workspaceDir, nowIso)]);
	const candidates = [];
	for (const entry of Object.values(store.entries)) {
		if (!entry || entry.source !== "memory" || !isShortTermMemoryPath(entry.path)) continue;
		if (isContaminatedDreamingSnippet(entry.snippet)) continue;
		if (!includePromoted && entry.promotedAt) continue;
		const recallCount = Math.max(0, Math.floor(entry.recallCount ?? 0));
		const dailyCount = Math.max(0, Math.floor(entry.dailyCount ?? 0));
		const groundedCount = Math.max(0, Math.floor(entry.groundedCount ?? 0));
		const signalCount = totalSignalCountForEntry(entry);
		if (signalCount <= 0) continue;
		if (signalCount < minRecallCount) continue;
		const avgScore = clampScore(entry.totalScore / Math.max(1, signalCount));
		const frequency = clampScore(Math.log1p(signalCount) / Math.log1p(10));
		const uniqueQueries = entry.queryHashes?.length ?? 0;
		const contextDiversity = Math.max(uniqueQueries, entry.recallDays?.length ?? 0);
		if (contextDiversity < minUniqueQueries) continue;
		const diversity = clampScore(contextDiversity / 5);
		const lastRecalledAtMs = Date.parse(entry.lastRecalledAt);
		const ageDays = Number.isFinite(lastRecalledAtMs) ? Math.max(0, (nowMs - lastRecalledAtMs) / DAY_MS) : 0;
		if (maxAgeDays >= 0 && ageDays > maxAgeDays) continue;
		const recency = clampScore(calculateRecencyComponent(ageDays, halfLifeDays));
		const recallDays = entry.recallDays ?? [];
		const conceptTags = entry.conceptTags ?? [];
		const consolidation = Math.max(calculateConsolidationComponent(recallDays), clampScore(groundedCount / 3));
		const conceptual = calculateConceptualComponent(conceptTags);
		const phaseBoost = calculatePhaseSignalBoost(phaseSignals.entries[entry.key], nowMs);
		const score = weights.frequency * frequency + weights.relevance * avgScore + weights.diversity * diversity + weights.recency * recency + weights.consolidation * consolidation + weights.conceptual * conceptual + phaseBoost;
		if (score < minScore) continue;
		candidates.push({
			key: entry.key,
			path: entry.path,
			startLine: entry.startLine,
			endLine: entry.endLine,
			source: entry.source,
			snippet: entry.snippet,
			recallCount,
			dailyCount,
			groundedCount,
			signalCount,
			avgScore,
			maxScore: clampScore(entry.maxScore),
			uniqueQueries,
			...entry.claimHash ? { claimHash: entry.claimHash } : {},
			promotedAt: entry.promotedAt,
			firstRecalledAt: entry.firstRecalledAt,
			lastRecalledAt: entry.lastRecalledAt,
			ageDays,
			score: clampScore(score),
			recallDays,
			conceptTags,
			components: {
				frequency,
				relevance: avgScore,
				diversity,
				recency,
				consolidation,
				conceptual
			}
		});
	}
	const sorted = candidates.toSorted((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (b.recallCount !== a.recallCount) return b.recallCount - a.recallCount;
		return a.path.localeCompare(b.path);
	});
	const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : sorted.length;
	return sorted.slice(0, limit);
}
async function readShortTermRecallEntries(params) {
	const workspaceDir = params.workspaceDir.trim();
	if (!workspaceDir) return [];
	const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
	const store = await readStore(workspaceDir, new Date(nowMs).toISOString());
	return Object.values(store.entries).filter((entry) => Boolean(entry) && entry.source === "memory" && isShortTermMemoryPath(entry.path));
}
function resolveShortTermSourcePathCandidates(workspaceDir, candidatePath) {
	const normalizedPath = normalizeMemoryPath(candidatePath);
	const basenames = [normalizedPath];
	if (!normalizedPath.startsWith("memory/")) basenames.push(path.posix.join("memory", path.posix.basename(normalizedPath)));
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	for (const relativePath of basenames) {
		const absolutePath = path.resolve(workspaceDir, relativePath);
		if (seen.has(absolutePath)) continue;
		seen.add(absolutePath);
		resolved.push(absolutePath);
	}
	return resolved;
}
function normalizeRangeSnippet(lines, startLine, endLine) {
	const startIndex = Math.max(0, startLine - 1);
	const endIndex = Math.min(lines.length, endLine);
	if (startIndex >= endIndex) return "";
	return normalizeSnippet(lines.slice(startIndex, endIndex).join(" "));
}
function compareCandidateWindow(targetSnippet, windowSnippet) {
	if (!targetSnippet || !windowSnippet) return {
		matched: false,
		quality: 0
	};
	if (windowSnippet === targetSnippet) return {
		matched: true,
		quality: 3
	};
	if (windowSnippet.includes(targetSnippet)) return {
		matched: true,
		quality: 2
	};
	if (targetSnippet.includes(windowSnippet)) return {
		matched: true,
		quality: 1
	};
	return {
		matched: false,
		quality: 0
	};
}
function relocateCandidateRange(lines, candidate) {
	const targetSnippet = normalizeSnippet(candidate.snippet);
	const preferredSpan = Math.max(1, candidate.endLine - candidate.startLine + 1);
	if (targetSnippet.length === 0) {
		const fallbackSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
		if (!fallbackSnippet) return null;
		return {
			startLine: candidate.startLine,
			endLine: candidate.endLine,
			snippet: fallbackSnippet
		};
	}
	const exactSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
	if (exactSnippet === targetSnippet) return {
		startLine: candidate.startLine,
		endLine: candidate.endLine,
		snippet: exactSnippet
	};
	const maxSpan = Math.min(lines.length, Math.max(preferredSpan + 3, 8));
	let bestMatch;
	for (let startIndex = 0; startIndex < lines.length; startIndex += 1) for (let span = 1; span <= maxSpan && startIndex + span <= lines.length; span += 1) {
		const startLine = startIndex + 1;
		const endLine = startIndex + span;
		const snippet = normalizeRangeSnippet(lines, startLine, endLine);
		const comparison = compareCandidateWindow(targetSnippet, snippet);
		if (!comparison.matched) continue;
		const distance = Math.abs(startLine - candidate.startLine);
		if (!bestMatch || comparison.quality > bestMatch.quality || comparison.quality === bestMatch.quality && distance < bestMatch.distance || comparison.quality === bestMatch.quality && distance === bestMatch.distance && Math.abs(span - preferredSpan) < Math.abs(bestMatch.endLine - bestMatch.startLine + 1 - preferredSpan)) bestMatch = {
			startLine,
			endLine,
			snippet,
			quality: comparison.quality,
			distance
		};
	}
	if (!bestMatch) return null;
	return {
		startLine: bestMatch.startLine,
		endLine: bestMatch.endLine,
		snippet: bestMatch.snippet
	};
}
const DREAMING_FENCE_START_RE = /<!--\s*openclaw:dreaming:[a-z][a-z0-9-]*:start\s*-->/i;
const DREAMING_FENCE_END_RE = /<!--\s*openclaw:dreaming:[a-z][a-z0-9-]*:end\s*-->/i;
function lineRangeOverlapsDreamingFence(lines, startLine, endLine) {
	if (lines.length === 0) return false;
	const safeStart = Math.max(1, Math.min(startLine, lines.length));
	const safeEnd = Math.max(safeStart, Math.min(endLine, lines.length));
	let insideFence = false;
	for (let i = 0; i < safeEnd; i += 1) {
		const line = lines[i] ?? "";
		if (DREAMING_FENCE_START_RE.test(line)) {
			insideFence = true;
			continue;
		}
		if (DREAMING_FENCE_END_RE.test(line)) {
			insideFence = false;
			continue;
		}
		const oneIndexed = i + 1;
		if (insideFence && oneIndexed >= safeStart && oneIndexed <= safeEnd) return true;
	}
	return false;
}
async function rehydratePromotionCandidate(workspaceDir, candidate) {
	const sourcePaths = resolveShortTermSourcePathCandidates(workspaceDir, candidate.path);
	for (const sourcePath of sourcePaths) {
		let rawSource;
		try {
			rawSource = await fs.readFile(sourcePath, "utf-8");
		} catch (err) {
			if (err?.code === "ENOENT") continue;
			throw err;
		}
		const lines = rawSource.split(/\r?\n/);
		const relocated = relocateCandidateRange(lines, candidate);
		if (!relocated) continue;
		if (lineRangeOverlapsDreamingFence(lines, relocated.startLine, relocated.endLine)) continue;
		return {
			...candidate,
			startLine: relocated.startLine,
			endLine: relocated.endLine,
			snippet: relocated.snippet
		};
	}
	return null;
}
function buildPromotionSection(candidates, nowMs, timezone) {
	const lines = [
		"",
		`## Promoted From Short-Term Memory (${formatMemoryDreamingDay(nowMs, timezone)})`,
		""
	];
	for (const candidate of candidates) {
		const source = `${candidate.path}:${candidate.startLine}-${candidate.endLine}`;
		const snippet = candidate.snippet || "(no snippet captured)";
		lines.push(`<!-- ${PROMOTION_MARKER_PREFIX}${candidate.key} -->`);
		lines.push(`- ${snippet} [score=${candidate.score.toFixed(3)} recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} source=${source}]`);
	}
	lines.push("");
	return lines.join("\n");
}
function withTrailingNewline(content) {
	if (!content) return "";
	return content.endsWith("\n") ? content : `${content}\n`;
}
function extractPromotionMarkers(memoryText) {
	const markers = /* @__PURE__ */ new Set();
	const matches = memoryText.matchAll(/<!--\s*openclaw-memory-promotion:([^\n]+?)\s*-->/gi);
	for (const match of matches) {
		const key = match[1]?.trim();
		if (key) markers.add(key);
	}
	return markers;
}
async function applyShortTermPromotions(options) {
	const workspaceDir = options.workspaceDir.trim();
	const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : options.candidates.length;
	const minScore = toFiniteScore(options.minScore, DEFAULT_PROMOTION_MIN_SCORE);
	const minRecallCount = toFiniteNonNegativeInt(options.minRecallCount, 3);
	const minUniqueQueries = toFiniteNonNegativeInt(options.minUniqueQueries, 2);
	const maxAgeDays = toFiniteNonNegativeInt(options.maxAgeDays, -1);
	const memoryPath = path.join(workspaceDir, "MEMORY.md");
	return await withShortTermLock(workspaceDir, async () => {
		const store = await readStore(workspaceDir, nowIso);
		const selected = options.candidates.filter((candidate) => {
			if (isContaminatedDreamingSnippet(candidate.snippet)) return false;
			if (candidate.promotedAt) return false;
			if (candidate.score < minScore) return false;
			if (Math.max(0, candidate.signalCount ?? totalSignalCountForEntry({
				recallCount: candidate.recallCount,
				dailyCount: candidate.dailyCount,
				groundedCount: candidate.groundedCount
			})) < minRecallCount) return false;
			if (Math.max(candidate.uniqueQueries, candidate.recallDays.length) < minUniqueQueries) return false;
			if (maxAgeDays >= 0 && candidate.ageDays > maxAgeDays) return false;
			if (store.entries[candidate.key]?.promotedAt) return false;
			return true;
		}).slice(0, limit);
		const rehydratedSelected = [];
		for (const candidate of selected) {
			const rehydrated = await rehydratePromotionCandidate(workspaceDir, candidate);
			if (rehydrated && !isContaminatedDreamingSnippet(rehydrated.snippet)) rehydratedSelected.push(rehydrated);
		}
		if (rehydratedSelected.length === 0) return {
			memoryPath,
			applied: 0,
			appended: 0,
			reconciledExisting: 0,
			appliedCandidates: [],
			compactedSections: 0,
			compactedDates: []
		};
		const existingMemory = await fs.readFile(memoryPath, "utf-8").catch((err) => {
			if (err?.code === "ENOENT") return "";
			throw err;
		});
		const existingMarkers = extractPromotionMarkers(existingMemory);
		const alreadyWritten = rehydratedSelected.filter((candidate) => existingMarkers.has(candidate.key));
		const toAppend = rehydratedSelected.filter((candidate) => !existingMarkers.has(candidate.key));
		let compactedDates = [];
		if (toAppend.length > 0) {
			const section = buildPromotionSection(toAppend, nowMs, options.timezone);
			const compaction = compactMemoryForBudget({
				existingMemory,
				newSection: section,
				budgetChars: typeof options.memoryFileMaxChars === "number" && Number.isFinite(options.memoryFileMaxChars) ? Math.max(0, Math.floor(options.memoryFileMaxChars)) : DEFAULT_MEMORY_FILE_MAX_CHARS
			});
			compactedDates = compaction.droppedDates;
			const baseMemory = compaction.compacted;
			const header = baseMemory.trim().length > 0 ? "" : "# Long-Term Memory\n\n";
			await fs.writeFile(memoryPath, `${header}${withTrailingNewline(baseMemory)}${section}`, "utf-8");
		}
		for (const candidate of rehydratedSelected) {
			const entry = store.entries[candidate.key];
			if (!entry) continue;
			entry.startLine = candidate.startLine;
			entry.endLine = candidate.endLine;
			entry.snippet = candidate.snippet;
			entry.promotedAt = nowIso;
		}
		store.updatedAt = nowIso;
		await writeStore(workspaceDir, store);
		await appendMemoryHostEvent(workspaceDir, {
			type: "memory.promotion.applied",
			timestamp: nowIso,
			memoryPath,
			applied: rehydratedSelected.length,
			candidates: rehydratedSelected.map((candidate) => ({
				key: candidate.key,
				path: candidate.path,
				startLine: candidate.startLine,
				endLine: candidate.endLine,
				score: candidate.score,
				recallCount: candidate.recallCount
			}))
		});
		return {
			memoryPath,
			applied: rehydratedSelected.length,
			appended: toAppend.length,
			reconciledExisting: alreadyWritten.length,
			appliedCandidates: rehydratedSelected,
			compactedSections: compactedDates.length,
			compactedDates
		};
	});
}
function resolveShortTermRecallStorePath(workspaceDir) {
	return resolveStorePath(workspaceDir);
}
function resolveShortTermRecallLockPath(workspaceDir) {
	return resolveLockPath(workspaceDir);
}
async function auditShortTermPromotionArtifacts(params) {
	const workspaceDir = params.workspaceDir.trim();
	const storePath = resolveStorePath(workspaceDir);
	const lockPath = resolveLockPath(workspaceDir);
	const issues = [];
	let exists = false;
	let entryCount = 0;
	let promotedCount = 0;
	let spacedEntryCount = 0;
	let conceptTaggedEntryCount = 0;
	let conceptTagScripts;
	let invalidEntryCount = 0;
	let updatedAt;
	try {
		const raw = await fs.readFile(storePath, "utf-8");
		exists = true;
		if (raw.trim().length === 0) issues.push({
			severity: "warn",
			code: "recall-store-empty",
			message: "Short-term recall store is empty.",
			fixable: true
		});
		else {
			const nowIso = (/* @__PURE__ */ new Date()).toISOString();
			const parsed = JSON.parse(raw);
			const store = normalizeStore(parsed, nowIso);
			updatedAt = store.updatedAt;
			entryCount = Object.keys(store.entries).length;
			promotedCount = Object.values(store.entries).filter((entry) => Boolean(entry.promotedAt)).length;
			spacedEntryCount = Object.values(store.entries).filter((entry) => (entry.recallDays?.length ?? 0) > 1).length;
			conceptTaggedEntryCount = Object.values(store.entries).filter((entry) => (entry.conceptTags?.length ?? 0) > 0).length;
			conceptTagScripts = summarizeConceptTagScriptCoverage(Object.values(store.entries).filter((entry) => (entry.conceptTags?.length ?? 0) > 0).map((entry) => entry.conceptTags ?? []));
			invalidEntryCount = Object.keys(asNullableRecord(parsed)?.entries ?? {}).length - entryCount;
			if (invalidEntryCount > 0) issues.push({
				severity: "warn",
				code: "recall-store-invalid",
				message: `Short-term recall store contains ${invalidEntryCount} invalid entr${invalidEntryCount === 1 ? "y" : "ies"}.`,
				fixable: true
			});
		}
	} catch (err) {
		const code = err.code;
		if (code !== "ENOENT") issues.push({
			severity: "error",
			code: "recall-store-unreadable",
			message: `Short-term recall store is unreadable: ${code ?? "error"}.`,
			fixable: false
		});
	}
	try {
		const stat = await fs.stat(lockPath);
		if (Date.now() - stat.mtimeMs > SHORT_TERM_LOCK_STALE_MS && await canStealStaleLock(lockPath)) issues.push({
			severity: "warn",
			code: "recall-lock-stale",
			message: "Short-term promotion lock appears stale.",
			fixable: true
		});
	} catch (err) {
		const code = err.code;
		if (code !== "ENOENT") issues.push({
			severity: "warn",
			code: "recall-lock-unreadable",
			message: `Short-term promotion lock could not be inspected: ${code ?? "error"}.`,
			fixable: false
		});
	}
	let qmd;
	if (params.qmd) {
		qmd = {
			dbPath: params.qmd.dbPath,
			collections: params.qmd.collections
		};
		if (typeof params.qmd.collections === "number" && params.qmd.collections <= 0) issues.push({
			severity: "warn",
			code: "qmd-collections-empty",
			message: "QMD reports zero managed collections.",
			fixable: false
		});
		const dbPath = params.qmd.dbPath?.trim();
		if (dbPath) try {
			const stat = await fs.stat(dbPath);
			qmd.dbBytes = stat.size;
			if (!stat.isFile() || stat.size <= 0) issues.push({
				severity: "error",
				code: "qmd-index-empty",
				message: "QMD index file exists but is empty.",
				fixable: false
			});
		} catch (err) {
			if (err.code === "ENOENT") issues.push({
				severity: "error",
				code: "qmd-index-missing",
				message: "QMD index file is missing.",
				fixable: false
			});
			else throw err;
		}
	}
	return {
		storePath,
		lockPath,
		updatedAt,
		exists,
		entryCount,
		promotedCount,
		spacedEntryCount,
		conceptTaggedEntryCount,
		...conceptTagScripts ? { conceptTagScripts } : {},
		invalidEntryCount,
		issues,
		...qmd ? { qmd } : {}
	};
}
async function repairShortTermPromotionArtifacts(params) {
	const workspaceDir = params.workspaceDir.trim();
	const nowIso = (/* @__PURE__ */ new Date()).toISOString();
	let rewroteStore = false;
	let removedInvalidEntries = 0;
	let removedStaleLock = false;
	try {
		const lockPath = resolveLockPath(workspaceDir);
		const stat = await fs.stat(lockPath);
		if (Date.now() - stat.mtimeMs > SHORT_TERM_LOCK_STALE_MS && await canStealStaleLock(lockPath)) {
			await fs.unlink(lockPath).catch(() => void 0);
			removedStaleLock = true;
		}
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	await withShortTermLock(workspaceDir, async () => {
		const storePath = resolveStorePath(workspaceDir);
		try {
			const raw = await fs.readFile(storePath, "utf-8");
			const parsed = raw.trim().length > 0 ? JSON.parse(raw) : emptyStore(nowIso);
			const rawEntries = Object.keys(asNullableRecord(parsed)?.entries ?? {}).length;
			const normalized = normalizeStore(parsed, nowIso);
			removedInvalidEntries = Math.max(0, rawEntries - Object.keys(normalized.entries).length);
			const nextEntries = Object.fromEntries(Object.entries(normalized.entries).map(([key, entry]) => {
				const conceptTags = deriveConceptTags({
					path: entry.path,
					snippet: entry.snippet
				});
				const fallbackDay = normalizeIsoDay(entry.lastRecalledAt) ?? nowIso.slice(0, 10);
				return [key, {
					...entry,
					dailyCount: Math.max(0, Math.floor(entry.dailyCount ?? 0)),
					groundedCount: Math.max(0, Math.floor(entry.groundedCount ?? 0)),
					queryHashes: (entry.queryHashes ?? []).slice(-32),
					recallDays: mergeRecentDistinct(entry.recallDays ?? [], fallbackDay, MAX_RECALL_DAYS),
					conceptTags: conceptTags.length > 0 ? conceptTags : entry.conceptTags ?? []
				}];
			}));
			const comparableStore = {
				version: 1,
				updatedAt: normalized.updatedAt,
				entries: nextEntries
			};
			if (`${JSON.stringify(comparableStore, null, 2)}\n` !== `${raw.trimEnd()}\n`) {
				await writeStore(workspaceDir, {
					...comparableStore,
					updatedAt: nowIso
				});
				rewroteStore = true;
			}
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
		}
	});
	return {
		changed: rewroteStore || removedStaleLock,
		removedInvalidEntries,
		rewroteStore,
		removedStaleLock
	};
}
async function removeGroundedShortTermCandidates(params) {
	const workspaceDir = params.workspaceDir.trim();
	const storePath = resolveStorePath(workspaceDir);
	const nowIso = (/* @__PURE__ */ new Date()).toISOString();
	let removed = 0;
	await withShortTermLock(workspaceDir, async () => {
		const [store, phaseSignals] = await Promise.all([readStore(workspaceDir, nowIso), readPhaseSignalStore(workspaceDir, nowIso)]);
		for (const [key, entry] of Object.entries(store.entries)) if (Math.max(0, Math.floor(entry.groundedCount ?? 0)) > 0 && Math.max(0, Math.floor(entry.recallCount ?? 0)) === 0 && Math.max(0, Math.floor(entry.dailyCount ?? 0)) === 0) {
			delete store.entries[key];
			removed += 1;
		}
		for (const key of Object.keys(phaseSignals.entries)) if (!Object.hasOwn(store.entries, key)) delete phaseSignals.entries[key];
		if (removed > 0) {
			store.updatedAt = nowIso;
			phaseSignals.updatedAt = nowIso;
			await Promise.all([writeStore(workspaceDir, store), writePhaseSignalStore(workspaceDir, phaseSignals)]);
		}
	});
	return {
		removed,
		storePath
	};
}
//#endregion
export { rankShortTermPromotionCandidates as a, recordGroundedShortTermCandidates as c, repairShortTermPromotionArtifacts as d, resolveShortTermRecallLockPath as f, filterLiveShortTermRecallEntries as i, recordShortTermRecalls as l, applyShortTermPromotions as n, readShortTermRecallEntries as o, resolveShortTermRecallStorePath as p, auditShortTermPromotionArtifacts as r, recordDreamingPhaseSignals as s, DEFAULT_PROMOTION_MIN_SCORE as t, removeGroundedShortTermCandidates as u };
