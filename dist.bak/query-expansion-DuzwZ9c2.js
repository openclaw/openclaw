import { t as createSubsystemLogger } from "./subsystem-CYLd4dcj.js";
import { t as runTasksWithConcurrency } from "./run-with-concurrency-C0tgsauE.js";
import { t as redactSensitiveText } from "./redact-BsXsyykh.js";
import { c as resolveSessionTranscriptsDirForAgent } from "./paths-6XrpQmMB.js";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import syncFs from "node:fs";
import crypto from "node:crypto";

//#region src/memory/fs-utils.ts
function isFileMissingError(err) {
	return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}
async function statRegularFile(absPath) {
	let stat;
	try {
		stat = await fs.lstat(absPath);
	} catch (err) {
		if (isFileMissingError(err)) return { missing: true };
		throw err;
	}
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("path required");
	return {
		missing: false,
		stat
	};
}

//#endregion
//#region src/memory/internal.ts
function ensureDir(dir) {
	try {
		syncFs.mkdirSync(dir, { recursive: true });
	} catch {}
	return dir;
}
function normalizeRelPath(value) {
	return value.trim().replace(/^[./]+/, "").replace(/\\/g, "/");
}
function normalizeExtraMemoryPaths(workspaceDir, extraPaths) {
	if (!extraPaths?.length) return [];
	const resolved = extraPaths.map((value) => value.trim()).filter(Boolean).map((value) => path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value));
	return Array.from(new Set(resolved));
}
function isMemoryPath(relPath) {
	const normalized = normalizeRelPath(relPath);
	if (!normalized) return false;
	if (normalized === "MEMORY.md" || normalized === "memory.md") return true;
	return normalized.startsWith("memory/");
}
async function walkDir(dir, files) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			await walkDir(full, files);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".md")) continue;
		files.push(full);
	}
}
async function listMemoryFiles(workspaceDir, extraPaths) {
	const result = [];
	const memoryFile = path.join(workspaceDir, "MEMORY.md");
	const altMemoryFile = path.join(workspaceDir, "memory.md");
	const memoryDir = path.join(workspaceDir, "memory");
	const addMarkdownFile = async (absPath) => {
		try {
			const stat = await fs.lstat(absPath);
			if (stat.isSymbolicLink() || !stat.isFile()) return;
			if (!absPath.endsWith(".md")) return;
			result.push(absPath);
		} catch {}
	};
	await addMarkdownFile(memoryFile);
	await addMarkdownFile(altMemoryFile);
	try {
		const dirStat = await fs.lstat(memoryDir);
		if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) await walkDir(memoryDir, result);
	} catch {}
	const normalizedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
	if (normalizedExtraPaths.length > 0) for (const inputPath of normalizedExtraPaths) try {
		const stat = await fs.lstat(inputPath);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			await walkDir(inputPath, result);
			continue;
		}
		if (stat.isFile() && inputPath.endsWith(".md")) result.push(inputPath);
	} catch {}
	if (result.length <= 1) return result;
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const entry of result) {
		let key = entry;
		try {
			key = await fs.realpath(entry);
		} catch {}
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry);
	}
	return deduped;
}
function hashText(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}
async function buildFileEntry(absPath, workspaceDir) {
	let stat;
	try {
		stat = await fs.stat(absPath);
	} catch (err) {
		if (isFileMissingError(err)) return null;
		throw err;
	}
	let content;
	try {
		content = await fs.readFile(absPath, "utf-8");
	} catch (err) {
		if (isFileMissingError(err)) return null;
		throw err;
	}
	const hash = hashText(content);
	return {
		path: path.relative(workspaceDir, absPath).replace(/\\/g, "/"),
		absPath,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		hash
	};
}
function chunkMarkdown(content, chunking) {
	const lines = content.split("\n");
	if (lines.length === 0) return [];
	const maxChars = Math.max(32, chunking.tokens * 4);
	const overlapChars = Math.max(0, chunking.overlap * 4);
	const chunks = [];
	let current = [];
	let currentChars = 0;
	const flush = () => {
		if (current.length === 0) return;
		const firstEntry = current[0];
		const lastEntry = current[current.length - 1];
		if (!firstEntry || !lastEntry) return;
		let text = current.map((entry) => entry.line).join("\n");
		if (text.length > maxChars) text = text.slice(0, maxChars);
		const startLine = firstEntry.lineNo;
		const endLine = lastEntry.lineNo;
		chunks.push({
			startLine,
			endLine,
			text,
			hash: hashText(text)
		});
	};
	const carryOverlap = () => {
		const overlapCap = Math.min(overlapChars, Math.floor(maxChars / 2));
		if (overlapCap <= 0 || current.length === 0) {
			current = [];
			currentChars = 0;
			return;
		}
		let acc = 0;
		const kept = [];
		for (let i = current.length - 1; i >= 0; i -= 1) {
			const entry = current[i];
			if (!entry) continue;
			const entrySize = entry.line.length + 1;
			if (acc + entrySize > overlapCap && kept.length > 0) break;
			acc += entrySize;
			kept.unshift(entry);
			if (acc >= overlapCap) break;
		}
		current = kept;
		currentChars = kept.reduce((sum, entry) => sum + entry.line.length + 1, 0);
	};
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const lineNo = i + 1;
		const segments = [];
		if (line.length === 0) segments.push("");
		else for (let start = 0; start < line.length; start += maxChars) segments.push(line.slice(start, start + maxChars));
		for (const segment of segments) {
			const lineSize = segment.length + 1;
			if (currentChars + lineSize > maxChars && current.length > 0) {
				flush();
				carryOverlap();
			}
			current.push({
				line: segment,
				lineNo
			});
			currentChars += lineSize;
		}
	}
	flush();
	return chunks;
}
/**
* Remap chunk startLine/endLine from content-relative positions to original
* source file positions using a lineMap.  Each entry in lineMap gives the
* 1-indexed source line for the corresponding 0-indexed content line.
*
* This is used for session JSONL files where buildSessionEntry() flattens
* messages into a plain-text string before chunking.  Without remapping the
* stored line numbers would reference positions in the flattened text rather
* than the original JSONL file.
*/
function remapChunkLines(chunks, lineMap) {
	if (!lineMap || lineMap.length === 0) return;
	for (const chunk of chunks) {
		chunk.startLine = lineMap[chunk.startLine - 1] ?? chunk.startLine;
		chunk.endLine = lineMap[chunk.endLine - 1] ?? chunk.endLine;
	}
}
function parseEmbedding(raw) {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
function cosineSimilarity(a, b) {
	if (a.length === 0 || b.length === 0) return 0;
	const len = Math.min(a.length, b.length);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < len; i += 1) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
async function runWithConcurrency(tasks, limit) {
	const { results, firstError, hasError } = await runTasksWithConcurrency({
		tasks,
		limit,
		errorMode: "stop"
	});
	if (hasError) throw firstError;
	return results;
}

//#endregion
//#region src/memory/session-files.ts
const log = createSubsystemLogger("memory");
/**
* Break long lines at sentence boundaries for better chunk coherence.
* Lines shorter than maxLineLength are returned unchanged.
*/
function breakLongLines(text, maxLineLength) {
	if (text.length <= maxLineLength) return text;
	const result = [];
	let remaining = text;
	while (remaining.length > maxLineLength) {
		const searchRange = remaining.slice(0, maxLineLength);
		let splitPos = -1;
		for (let i = searchRange.length - 1; i >= Math.floor(maxLineLength / 2); i -= 1) {
			const ch = searchRange[i];
			if ((ch === "." || ch === "?" || ch === "!") && i + 1 < searchRange.length && searchRange[i + 1] === " ") {
				splitPos = i + 1;
				break;
			}
		}
		if (splitPos === -1) {
			const lastSpace = searchRange.lastIndexOf(" ");
			splitPos = lastSpace > Math.floor(maxLineLength / 2) ? lastSpace : maxLineLength;
		}
		result.push(remaining.slice(0, splitPos).trim());
		remaining = remaining.slice(splitPos).trim();
	}
	if (remaining) result.push(remaining);
	return result.join("\n");
}
async function listSessionFilesForAgent(agentId) {
	const dir = resolveSessionTranscriptsDirForAgent(agentId);
	try {
		return (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name));
	} catch {
		return [];
	}
}
function sessionPathForFile(absPath) {
	return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}
function normalizeSessionText(value) {
	return value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
}
function extractSessionText(content) {
	if (typeof content === "string") {
		const normalized = normalizeSessionText(content);
		return normalized ? normalized : null;
	}
	if (!Array.isArray(content)) return null;
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block;
		if (record.type !== "text" || typeof record.text !== "string") continue;
		const normalized = normalizeSessionText(record.text);
		if (normalized) parts.push(normalized);
	}
	if (parts.length === 0) return null;
	return parts.join(" ");
}
async function buildSessionEntry(absPath) {
	try {
		const stat = await fs.stat(absPath);
		const lines = (await fs.readFile(absPath, "utf-8")).split("\n");
		const collected = [];
		const lineMap = [];
		for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
			const line = lines[jsonlIdx];
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (!record || typeof record !== "object" || record.type !== "message") continue;
			const message = record.message;
			if (!message || typeof message.role !== "string") continue;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = extractSessionText(message.content);
			if (!text) continue;
			const safe = redactSensitiveText(text, { mode: "tools" });
			const label = message.role === "user" ? "User" : "Assistant";
			collected.push(`${label}: ${breakLongLines(safe, 1e3)}`);
			lineMap.push(jsonlIdx + 1);
		}
		const content = collected.join("\n\n");
		return {
			path: sessionPathForFile(absPath),
			absPath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			hash: hashText(content + "\n" + lineMap.join(",")),
			content,
			lineMap
		};
	} catch (err) {
		log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
		return null;
	}
}

//#endregion
//#region src/infra/warning-filter.ts
const warningFilterKey = Symbol.for("openclaw.warning-filter");
function shouldIgnoreWarning(warning) {
	if (warning.code === "DEP0040" && warning.message?.includes("punycode")) return true;
	if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) return true;
	if (warning.name === "ExperimentalWarning" && warning.message?.includes("SQLite is an experimental feature")) return true;
	return false;
}
function normalizeWarningArgs(args) {
	const warningArg = args[0];
	const secondArg = args[1];
	const thirdArg = args[2];
	let name;
	let code;
	let message;
	if (warningArg instanceof Error) {
		name = warningArg.name;
		message = warningArg.message;
		code = warningArg.code;
	} else if (typeof warningArg === "string") message = warningArg;
	if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
		const options = secondArg;
		if (typeof options.type === "string") name = options.type;
		if (typeof options.code === "string") code = options.code;
	} else {
		if (typeof secondArg === "string") name = secondArg;
		if (typeof thirdArg === "string") code = thirdArg;
	}
	return {
		name,
		code,
		message
	};
}
function installProcessWarningFilter() {
	const globalState = globalThis;
	if (globalState[warningFilterKey]?.installed) return;
	const originalEmitWarning = process.emitWarning.bind(process);
	const wrappedEmitWarning = ((...args) => {
		if (shouldIgnoreWarning(normalizeWarningArgs(args))) return;
		return Reflect.apply(originalEmitWarning, process, args);
	});
	process.emitWarning = wrappedEmitWarning;
	globalState[warningFilterKey] = { installed: true };
}

//#endregion
//#region src/memory/sqlite.ts
const require = createRequire(import.meta.url);
function requireNodeSqlite() {
	installProcessWarningFilter();
	try {
		return require("node:sqlite");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`, { cause: err });
	}
}

//#endregion
//#region src/memory/query-expansion.ts
/**
* Query expansion for FTS-only search mode.
*
* When no embedding provider is available, we fall back to FTS (full-text search).
* FTS works best with specific keywords, but users often ask conversational queries
* like "that thing we discussed yesterday" or "之前讨论的那个方案".
*
* This module extracts meaningful keywords from such queries to improve FTS results.
*/
const STOP_WORDS_EN = new Set([
	"a",
	"an",
	"the",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"we",
	"our",
	"you",
	"your",
	"he",
	"she",
	"it",
	"they",
	"them",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"can",
	"may",
	"might",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"by",
	"from",
	"about",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"under",
	"over",
	"and",
	"or",
	"but",
	"if",
	"then",
	"because",
	"as",
	"while",
	"when",
	"where",
	"what",
	"which",
	"who",
	"how",
	"why",
	"yesterday",
	"today",
	"tomorrow",
	"earlier",
	"later",
	"recently",
	"before",
	"ago",
	"just",
	"now",
	"thing",
	"things",
	"stuff",
	"something",
	"anything",
	"everything",
	"nothing",
	"please",
	"help",
	"find",
	"show",
	"get",
	"tell",
	"give"
]);
const STOP_WORDS_ES = new Set([
	"el",
	"la",
	"los",
	"las",
	"un",
	"una",
	"unos",
	"unas",
	"este",
	"esta",
	"ese",
	"esa",
	"yo",
	"me",
	"mi",
	"nosotros",
	"nosotras",
	"tu",
	"tus",
	"usted",
	"ustedes",
	"ellos",
	"ellas",
	"de",
	"del",
	"a",
	"en",
	"con",
	"por",
	"para",
	"sobre",
	"entre",
	"y",
	"o",
	"pero",
	"si",
	"porque",
	"como",
	"es",
	"son",
	"fue",
	"fueron",
	"ser",
	"estar",
	"haber",
	"tener",
	"hacer",
	"ayer",
	"hoy",
	"mañana",
	"antes",
	"despues",
	"después",
	"ahora",
	"recientemente",
	"que",
	"qué",
	"cómo",
	"cuando",
	"cuándo",
	"donde",
	"dónde",
	"porqué",
	"favor",
	"ayuda"
]);
const STOP_WORDS_PT = new Set([
	"o",
	"a",
	"os",
	"as",
	"um",
	"uma",
	"uns",
	"umas",
	"este",
	"esta",
	"esse",
	"essa",
	"eu",
	"me",
	"meu",
	"minha",
	"nos",
	"nós",
	"você",
	"vocês",
	"ele",
	"ela",
	"eles",
	"elas",
	"de",
	"do",
	"da",
	"em",
	"com",
	"por",
	"para",
	"sobre",
	"entre",
	"e",
	"ou",
	"mas",
	"se",
	"porque",
	"como",
	"é",
	"são",
	"foi",
	"foram",
	"ser",
	"estar",
	"ter",
	"fazer",
	"ontem",
	"hoje",
	"amanhã",
	"antes",
	"depois",
	"agora",
	"recentemente",
	"que",
	"quê",
	"quando",
	"onde",
	"porquê",
	"favor",
	"ajuda"
]);
const STOP_WORDS_AR = new Set([
	"ال",
	"و",
	"أو",
	"لكن",
	"ثم",
	"بل",
	"أنا",
	"نحن",
	"هو",
	"هي",
	"هم",
	"هذا",
	"هذه",
	"ذلك",
	"تلك",
	"هنا",
	"هناك",
	"من",
	"إلى",
	"الى",
	"في",
	"على",
	"عن",
	"مع",
	"بين",
	"ل",
	"ب",
	"ك",
	"كان",
	"كانت",
	"يكون",
	"تكون",
	"صار",
	"أصبح",
	"يمكن",
	"ممكن",
	"بالأمس",
	"امس",
	"اليوم",
	"غدا",
	"الآن",
	"قبل",
	"بعد",
	"مؤخرا",
	"لماذا",
	"كيف",
	"ماذا",
	"متى",
	"أين",
	"هل",
	"من فضلك",
	"فضلا",
	"ساعد"
]);
const STOP_WORDS_KO = new Set([
	"은",
	"는",
	"이",
	"가",
	"을",
	"를",
	"의",
	"에",
	"에서",
	"로",
	"으로",
	"와",
	"과",
	"도",
	"만",
	"까지",
	"부터",
	"한테",
	"에게",
	"께",
	"처럼",
	"같이",
	"보다",
	"마다",
	"밖에",
	"대로",
	"나",
	"나는",
	"내가",
	"나를",
	"너",
	"우리",
	"저",
	"저희",
	"그",
	"그녀",
	"그들",
	"이것",
	"저것",
	"그것",
	"여기",
	"저기",
	"거기",
	"있다",
	"없다",
	"하다",
	"되다",
	"이다",
	"아니다",
	"보다",
	"주다",
	"오다",
	"가다",
	"것",
	"거",
	"등",
	"수",
	"때",
	"곳",
	"중",
	"분",
	"잘",
	"더",
	"또",
	"매우",
	"정말",
	"아주",
	"많이",
	"너무",
	"좀",
	"그리고",
	"하지만",
	"그래서",
	"그런데",
	"그러나",
	"또는",
	"그러면",
	"왜",
	"어떻게",
	"뭐",
	"언제",
	"어디",
	"누구",
	"무엇",
	"어떤",
	"어제",
	"오늘",
	"내일",
	"최근",
	"지금",
	"아까",
	"나중",
	"전에",
	"제발",
	"부탁"
]);
const KO_TRAILING_PARTICLES = [
	"에서",
	"으로",
	"에게",
	"한테",
	"처럼",
	"같이",
	"보다",
	"까지",
	"부터",
	"마다",
	"밖에",
	"대로",
	"은",
	"는",
	"이",
	"가",
	"을",
	"를",
	"의",
	"에",
	"로",
	"와",
	"과",
	"도",
	"만"
].toSorted((a, b) => b.length - a.length);
function stripKoreanTrailingParticle(token) {
	for (const particle of KO_TRAILING_PARTICLES) if (token.length > particle.length && token.endsWith(particle)) return token.slice(0, -particle.length);
	return null;
}
function isUsefulKoreanStem(stem) {
	if (/[\uac00-\ud7af]/.test(stem)) return stem.length >= 2;
	return /^[a-z0-9_]+$/i.test(stem);
}
const STOP_WORDS_JA = new Set([
	"これ",
	"それ",
	"あれ",
	"この",
	"その",
	"あの",
	"ここ",
	"そこ",
	"あそこ",
	"する",
	"した",
	"して",
	"です",
	"ます",
	"いる",
	"ある",
	"なる",
	"できる",
	"の",
	"こと",
	"もの",
	"ため",
	"そして",
	"しかし",
	"また",
	"でも",
	"から",
	"まで",
	"より",
	"だけ",
	"なぜ",
	"どう",
	"何",
	"いつ",
	"どこ",
	"誰",
	"どれ",
	"昨日",
	"今日",
	"明日",
	"最近",
	"今",
	"さっき",
	"前",
	"後"
]);
const STOP_WORDS_ZH = new Set([
	"我",
	"我们",
	"你",
	"你们",
	"他",
	"她",
	"它",
	"他们",
	"这",
	"那",
	"这个",
	"那个",
	"这些",
	"那些",
	"的",
	"了",
	"着",
	"过",
	"得",
	"地",
	"吗",
	"呢",
	"吧",
	"啊",
	"呀",
	"嘛",
	"啦",
	"是",
	"有",
	"在",
	"被",
	"把",
	"给",
	"让",
	"用",
	"到",
	"去",
	"来",
	"做",
	"说",
	"看",
	"找",
	"想",
	"要",
	"能",
	"会",
	"可以",
	"和",
	"与",
	"或",
	"但",
	"但是",
	"因为",
	"所以",
	"如果",
	"虽然",
	"而",
	"也",
	"都",
	"就",
	"还",
	"又",
	"再",
	"才",
	"只",
	"之前",
	"以前",
	"之后",
	"以后",
	"刚才",
	"现在",
	"昨天",
	"今天",
	"明天",
	"最近",
	"东西",
	"事情",
	"事",
	"什么",
	"哪个",
	"哪些",
	"怎么",
	"为什么",
	"多少",
	"请",
	"帮",
	"帮忙",
	"告诉"
]);
/**
* Check if a token looks like a meaningful keyword.
* Returns false for short tokens, numbers-only, etc.
*/
function isValidKeyword(token) {
	if (!token || token.length === 0) return false;
	if (/^[a-zA-Z]+$/.test(token) && token.length < 3) return false;
	if (/^\d+$/.test(token)) return false;
	if (/^[\p{P}\p{S}]+$/u.test(token)) return false;
	return true;
}
/**
* Simple tokenizer that handles English, Chinese, Korean, and Japanese text.
* For Chinese, we do character-based splitting since we don't have a proper segmenter.
* For English, we split on whitespace and punctuation.
*/
function tokenize(text) {
	const tokens = [];
	const segments = text.toLowerCase().trim().split(/[\s\p{P}]+/u).filter(Boolean);
	for (const segment of segments) if (/[\u3040-\u30ff]/.test(segment)) {
		const jpParts = segment.match(/[a-z0-9_]+|[\u30a0-\u30ffー]+|[\u4e00-\u9fff]+|[\u3040-\u309f]{2,}/g) ?? [];
		for (const part of jpParts) if (/^[\u4e00-\u9fff]+$/.test(part)) {
			tokens.push(part);
			for (let i = 0; i < part.length - 1; i++) tokens.push(part[i] + part[i + 1]);
		} else tokens.push(part);
	} else if (/[\u4e00-\u9fff]/.test(segment)) {
		const chars = Array.from(segment).filter((c) => /[\u4e00-\u9fff]/.test(c));
		tokens.push(...chars);
		for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
	} else if (/[\uac00-\ud7af\u3131-\u3163]/.test(segment)) {
		const stem = stripKoreanTrailingParticle(segment);
		const stemIsStopWord = stem !== null && STOP_WORDS_KO.has(stem);
		if (!STOP_WORDS_KO.has(segment) && !stemIsStopWord) tokens.push(segment);
		if (stem && !STOP_WORDS_KO.has(stem) && isUsefulKoreanStem(stem)) tokens.push(stem);
	} else tokens.push(segment);
	return tokens;
}
/**
* Extract keywords from a conversational query for FTS search.
*
* Examples:
* - "that thing we discussed about the API" → ["discussed", "API"]
* - "之前讨论的那个方案" → ["讨论", "方案"]
* - "what was the solution for the bug" → ["solution", "bug"]
*/
function extractKeywords(query) {
	const tokens = tokenize(query);
	const keywords = [];
	const seen = /* @__PURE__ */ new Set();
	for (const token of tokens) {
		if (STOP_WORDS_EN.has(token) || STOP_WORDS_ES.has(token) || STOP_WORDS_PT.has(token) || STOP_WORDS_AR.has(token) || STOP_WORDS_ZH.has(token) || STOP_WORDS_KO.has(token) || STOP_WORDS_JA.has(token)) continue;
		if (!isValidKeyword(token)) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		keywords.push(token);
	}
	return keywords;
}

//#endregion
export { isFileMissingError as _, sessionPathForFile as a, cosineSimilarity as c, isMemoryPath as d, listMemoryFiles as f, runWithConcurrency as g, remapChunkLines as h, listSessionFilesForAgent as i, ensureDir as l, parseEmbedding as m, requireNodeSqlite as n, buildFileEntry as o, normalizeExtraMemoryPaths as p, buildSessionEntry as r, chunkMarkdown as s, extractKeywords as t, hashText as u, statRegularFile as v };