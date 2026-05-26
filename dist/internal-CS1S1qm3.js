import { a as walkDirectory } from "./fs-safe-CV86zY9G.js";
import { o as statRegularFile, r as readRegularFile } from "./regular-file-DaVeNX32.js";
import { t as runTasksWithConcurrency } from "./run-with-concurrency-5cC57eDC.js";
import { n as detectMime } from "./mime-DppuT-pZ.js";
import { t as estimateStringChars } from "./cjk-chars-BtjJDifS.js";
import { c as shouldSkipRootMemoryAuxiliaryPath, i as resolveCanonicalRootMemoryFile } from "./root-memory-files-P2Mok0xY.js";
import { n as buildMemoryMultimodalLabel, r as classifyMemoryMultimodalPath } from "./multimodal-DsKQmW5D.js";
import "./openclaw-runtime-memory-B0KU6IIj.js";
import { t as isFileMissingError } from "./fs-utils-DdhuqF2m.js";
import "./config-utils-8ZJTp-7r.js";
import { t as hashText } from "./hash-C0FSXO-A.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { homedir } from "node:os";
import crypto from "node:crypto";
//#region packages/memory-host-sdk/src/host/embedding-input-limits.ts
function estimateUtf8Bytes(text) {
	if (!text) return 0;
	return Buffer.byteLength(text, "utf8");
}
function estimateStructuredEmbeddingInputBytes(input) {
	if (!input.parts?.length) return estimateUtf8Bytes(input.text);
	let total = 0;
	for (const part of input.parts) {
		if (part.type === "text") {
			total += estimateUtf8Bytes(part.text);
			continue;
		}
		total += estimateUtf8Bytes(part.mimeType);
		total += estimateUtf8Bytes(part.data);
	}
	return total;
}
function splitTextToUtf8ByteLimit(text, maxUtf8Bytes) {
	if (maxUtf8Bytes <= 0) return [text];
	if (estimateUtf8Bytes(text) <= maxUtf8Bytes) return [text];
	const parts = [];
	let cursor = 0;
	while (cursor < text.length) {
		let low = cursor + 1;
		let high = Math.min(text.length, cursor + maxUtf8Bytes);
		let best = cursor;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (estimateUtf8Bytes(text.slice(cursor, mid)) <= maxUtf8Bytes) {
				best = mid;
				low = mid + 1;
			} else high = mid - 1;
		}
		if (best <= cursor) best = Math.min(text.length, cursor + 1);
		if (best < text.length && best > cursor && text.charCodeAt(best - 1) >= 55296 && text.charCodeAt(best - 1) <= 56319 && text.charCodeAt(best) >= 56320 && text.charCodeAt(best) <= 57343) best -= 1;
		const part = text.slice(cursor, best);
		if (!part) break;
		parts.push(part);
		cursor = best;
	}
	return parts;
}
//#endregion
//#region packages/memory-host-sdk/src/host/embedding-inputs.ts
function buildTextEmbeddingInput(text) {
	return { text };
}
function isInlineDataEmbeddingInputPart(part) {
	return part.type === "inline-data";
}
function hasNonTextEmbeddingParts(input) {
	if (!input?.parts?.length) return false;
	return input.parts.some((part) => isInlineDataEmbeddingInputPart(part));
}
//#endregion
//#region packages/memory-host-sdk/src/host/internal.ts
const DISABLED_MULTIMODAL_SETTINGS = {
	enabled: false,
	modalities: [],
	maxFileBytes: 0
};
function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}
function normalizeRelPath(value) {
	return value.trim().replace(/^[./]+/, "").replace(/\\/g, "/");
}
function expandHomePath(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2));
	return value;
}
function normalizeExtraMemoryPaths(workspaceDir, extraPaths) {
	if (!extraPaths?.length) return [];
	const resolved = extraPaths.map((value) => value.trim()).filter(Boolean).map((value) => expandHomePath(value)).map((value) => path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value));
	return Array.from(new Set(resolved));
}
function isMemoryPath(relPath) {
	const normalized = normalizeRelPath(relPath);
	if (!normalized) return false;
	if (normalized === "MEMORY.md" || normalized.toLowerCase() === "dreams.md") return true;
	return normalized.startsWith("memory/");
}
function isAllowedMemoryFilePath(filePath, multimodal) {
	if (filePath.endsWith(".md")) return true;
	return classifyMemoryMultimodalPath(filePath, multimodal ?? DISABLED_MULTIMODAL_SETTINGS) !== null;
}
function shouldDescendMemoryEntry(entry, shouldSkipPath) {
	if (shouldSkipPath?.(entry.path)) return false;
	return entry.kind === "directory" && entry.name !== ".openclaw-repair";
}
async function collectMemoryFilesFromDir(dir, files, multimodal, shouldSkipPath) {
	const scan = await walkDirectory(dir, {
		symlinks: "skip",
		descend: (entry) => shouldDescendMemoryEntry(entry, shouldSkipPath),
		include: (entry) => !shouldSkipPath?.(entry.path) && entry.kind === "file" && isAllowedMemoryFilePath(entry.path, multimodal)
	});
	files.push(...scan.entries.map((entry) => entry.path));
}
async function listMemoryFiles(workspaceDir, extraPaths, multimodal) {
	const result = [];
	const memoryDir = path.join(workspaceDir, "memory");
	const shouldSkipWorkspaceMemoryPath = (absPath) => shouldSkipRootMemoryAuxiliaryPath({
		workspaceDir,
		absPath
	});
	const addMarkdownFile = async (absPath) => {
		try {
			if ((await statRegularFile(absPath)).missing) return;
			if (!absPath.endsWith(".md")) return;
			result.push(absPath);
		} catch {}
	};
	const memoryFile = await resolveCanonicalRootMemoryFile(workspaceDir);
	if (memoryFile) await addMarkdownFile(memoryFile);
	try {
		const dirStat = await fs$1.lstat(memoryDir);
		if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) await collectMemoryFilesFromDir(memoryDir, result, multimodal, shouldSkipWorkspaceMemoryPath);
	} catch {}
	const normalizedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
	if (normalizedExtraPaths.length > 0) for (const inputPath of normalizedExtraPaths) {
		if (shouldSkipWorkspaceMemoryPath(inputPath)) continue;
		try {
			const stat = await fs$1.lstat(inputPath);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				await collectMemoryFilesFromDir(inputPath, result, multimodal, shouldSkipWorkspaceMemoryPath);
				continue;
			}
			if (stat.isFile() && isAllowedMemoryFilePath(inputPath, multimodal)) result.push(inputPath);
		} catch {}
	}
	if (result.length <= 1) return result;
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const entry of result) {
		let key = entry;
		try {
			key = await fs$1.realpath(entry);
		} catch {}
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry);
	}
	return deduped;
}
async function buildFileEntry(absPath, workspaceDir, multimodal) {
	const regularFile = await statRegularFile(absPath);
	if (regularFile.missing) return null;
	const stat = regularFile.stat;
	const normalizedPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
	const multimodalSettings = multimodal ?? DISABLED_MULTIMODAL_SETTINGS;
	const modality = classifyMemoryMultimodalPath(absPath, multimodalSettings);
	if (modality) {
		if (stat.size > multimodalSettings.maxFileBytes) return null;
		let buffer;
		try {
			buffer = (await readRegularFile({
				filePath: absPath,
				maxBytes: multimodalSettings.maxFileBytes
			})).buffer;
		} catch (err) {
			if (isFileMissingError(err)) return null;
			throw err;
		}
		const mimeType = await detectMime({
			buffer: buffer.subarray(0, 512),
			filePath: absPath
		});
		if (!mimeType || !mimeType.startsWith(`${modality}/`)) return null;
		const contentText = buildMemoryMultimodalLabel(modality, normalizedPath);
		const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
		const chunkHash = hashText(JSON.stringify({
			path: normalizedPath,
			contentText,
			mimeType,
			dataHash
		}));
		return {
			path: normalizedPath,
			absPath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			hash: chunkHash,
			dataHash,
			kind: "multimodal",
			contentText,
			modality,
			mimeType
		};
	}
	let content;
	try {
		content = (await readRegularFile({ filePath: absPath })).buffer.toString("utf-8");
	} catch (err) {
		if (isFileMissingError(err)) return null;
		throw err;
	}
	const hash = hashText(content);
	return {
		path: normalizedPath,
		absPath,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		hash,
		kind: "markdown"
	};
}
async function loadMultimodalEmbeddingInput(entry) {
	if (entry.kind !== "multimodal" || !entry.contentText || !entry.mimeType) return null;
	const regularFile = await statRegularFile(entry.absPath);
	if (regularFile.missing) return null;
	if (regularFile.stat.size !== entry.size) return null;
	let buffer;
	try {
		buffer = (await readRegularFile({
			filePath: entry.absPath,
			maxBytes: entry.size
		})).buffer;
	} catch (err) {
		if (isFileMissingError(err)) return null;
		throw err;
	}
	const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
	if (entry.dataHash && entry.dataHash !== dataHash) return null;
	return {
		text: entry.contentText,
		parts: [{
			type: "text",
			text: entry.contentText
		}, {
			type: "inline-data",
			mimeType: entry.mimeType,
			data: buffer.toString("base64")
		}]
	};
}
async function buildMultimodalChunkForIndexing(entry) {
	const embeddingInput = await loadMultimodalEmbeddingInput(entry);
	if (!embeddingInput) return null;
	return {
		chunk: {
			startLine: 1,
			endLine: 1,
			text: entry.contentText ?? embeddingInput.text,
			hash: entry.hash,
			embeddingInput
		},
		structuredInputBytes: estimateStructuredEmbeddingInputBytes(embeddingInput)
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
		const text = current.map((entry) => entry.line).join("\n");
		const startLine = firstEntry.lineNo;
		const endLine = lastEntry.lineNo;
		chunks.push({
			startLine,
			endLine,
			text,
			hash: hashText(text),
			embeddingInput: buildTextEmbeddingInput(text)
		});
	};
	const carryOverlap = () => {
		if (overlapChars <= 0 || current.length === 0) {
			current = [];
			currentChars = 0;
			return;
		}
		let acc = 0;
		const kept = [];
		for (let i = current.length - 1; i >= 0; i -= 1) {
			const entry = current[i];
			if (!entry) continue;
			acc += estimateStringChars(entry.line) + 1;
			kept.unshift(entry);
			if (acc >= overlapChars) break;
		}
		current = kept;
		currentChars = acc;
	};
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const lineNo = i + 1;
		const segments = [];
		if (line.length === 0) segments.push("");
		else for (let start = 0; start < line.length; start += maxChars) {
			const coarse = line.slice(start, start + maxChars);
			if (estimateStringChars(coarse) > maxChars) {
				const fineStep = Math.max(1, chunking.tokens);
				for (let j = 0; j < coarse.length;) {
					let end = Math.min(j + fineStep, coarse.length);
					if (end < coarse.length) {
						const code = coarse.charCodeAt(end - 1);
						if (code >= 55296 && code <= 56319) end += 1;
					}
					segments.push(coarse.slice(j, end));
					j = end;
				}
			} else segments.push(coarse);
		}
		for (const segment of segments) {
			const lineSize = estimateStringChars(segment) + 1;
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
export { ensureDir as a, normalizeExtraMemoryPaths as c, runWithConcurrency as d, hasNonTextEmbeddingParts as f, splitTextToUtf8ByteLimit as h, cosineSimilarity as i, parseEmbedding as l, estimateUtf8Bytes as m, buildMultimodalChunkForIndexing as n, isMemoryPath as o, estimateStructuredEmbeddingInputBytes as p, chunkMarkdown as r, listMemoryFiles as s, buildFileEntry as t, remapChunkLines as u };
