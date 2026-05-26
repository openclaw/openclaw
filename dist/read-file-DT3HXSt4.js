import { a as isPathInsideWithRealpath, i as isPathInside } from "./path-BlG8lhgR.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import { c as assertNoSymlinkParents, o as statRegularFile, r as readRegularFile } from "./regular-file-DaVeNX32.js";
import { t as isFileMissingError } from "./fs-utils-DdhuqF2m.js";
import { a as resolveAgentWorkspaceDir, i as resolveAgentContextLimits, o as resolveMemorySearchConfig } from "./config-utils-8ZJTp-7r.js";
import { c as normalizeExtraMemoryPaths, o as isMemoryPath } from "./internal-CS1S1qm3.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region packages/memory-host-sdk/src/host/read-file-shared.ts
const DEFAULT_MEMORY_READ_LINES = 120;
const DEFAULT_MEMORY_READ_MAX_CHARS = 12e3;
function buildContinuationNotice(params) {
	const base = typeof params.nextFrom === "number" ? `[More content available. Use from=${params.nextFrom} to continue.]` : "[More content available. Requested excerpt exceeded the default maxChars budget.]";
	const fallback = params.suggestReadFallback ? " If you need the full raw line, use read on the source file." : "";
	return `\n\n${base.slice(0, -1)}${fallback}]`;
}
function fitLinesToCharBudget(params) {
	const { lines, maxChars } = params;
	if (lines.length === 0) return {
		text: "",
		includedLines: 0,
		hardTruncatedSingleLine: false
	};
	let includedLines = lines.length;
	let text = lines.join("\n");
	while (includedLines > 1 && text.length > maxChars) {
		includedLines -= 1;
		text = lines.slice(0, includedLines).join("\n");
	}
	if (text.length <= maxChars) return {
		text,
		includedLines,
		hardTruncatedSingleLine: false
	};
	return {
		text: text.slice(0, maxChars),
		includedLines: 1,
		hardTruncatedSingleLine: true
	};
}
function buildMemoryReadResultFromSlice(params) {
	const start = Math.max(1, params.startLine);
	const fitted = fitLinesToCharBudget({
		lines: params.selectedLines,
		maxChars: Math.max(1, params.maxChars ?? 12e3)
	});
	const moreSourceLinesRemain = params.moreSourceLinesRemain ?? false;
	const charCapTruncated = fitted.hardTruncatedSingleLine || fitted.includedLines < params.selectedLines.length;
	const nextFrom = !fitted.hardTruncatedSingleLine && (moreSourceLinesRemain || fitted.includedLines < params.selectedLines.length) ? start + fitted.includedLines : void 0;
	const truncated = charCapTruncated || moreSourceLinesRemain;
	return {
		text: truncated && fitted.text ? `${fitted.text}${buildContinuationNotice({
			nextFrom,
			suggestReadFallback: fitted.hardTruncatedSingleLine && params.suggestReadFallback
		})}` : fitted.text,
		path: params.relPath,
		from: start,
		lines: fitted.includedLines,
		...truncated ? { truncated: true } : {},
		...typeof nextFrom === "number" ? { nextFrom } : {}
	};
}
function buildMemoryReadResult(params) {
	const fileLines = params.content.split("\n");
	const start = Math.max(1, params.from ?? 1);
	const requestedCount = Math.max(1, params.lines ?? params.defaultLines ?? 120);
	const selectedLines = fileLines.slice(start - 1, start - 1 + requestedCount);
	const moreSourceLinesRemain = start - 1 + selectedLines.length < fileLines.length;
	return buildMemoryReadResultFromSlice({
		selectedLines,
		relPath: params.relPath,
		startLine: start,
		moreSourceLinesRemain,
		maxChars: params.maxChars,
		suggestReadFallback: params.suggestReadFallback
	});
}
//#endregion
//#region packages/memory-host-sdk/src/host/read-file.ts
async function isAllowedAdditionalDirectoryPath(additionalPath, absPath) {
	if (!isPathInside(additionalPath, absPath)) return false;
	try {
		await assertNoSymlinkParents({
			rootDir: additionalPath,
			targetPath: absPath
		});
	} catch {
		return false;
	}
	if (!isPathInsideWithRealpath(additionalPath, absPath)) {
		try {
			await fs.lstat(absPath);
		} catch (err) {
			return isFileMissingError(err);
		}
		return false;
	}
	return true;
}
async function readMemoryFile(params) {
	const rawPath = params.relPath.trim();
	if (!rawPath) throw new Error("path required");
	const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(params.workspaceDir, rawPath);
	const relPath = path.relative(params.workspaceDir, absPath).replace(/\\/g, "/");
	const allowedWorkspace = relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath) && isMemoryPath(relPath);
	let allowedAdditional = false;
	if (!allowedWorkspace && (params.extraPaths?.length ?? 0) > 0) {
		const additionalPaths = normalizeExtraMemoryPaths(params.workspaceDir, params.extraPaths);
		for (const additionalPath of additionalPaths) try {
			const stat = await fs.lstat(additionalPath);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				if (await isAllowedAdditionalDirectoryPath(additionalPath, absPath)) {
					if ((await fs.lstat(absPath).catch(() => null))?.isSymbolicLink()) continue;
					allowedAdditional = true;
					break;
				}
				continue;
			}
			if (stat.isFile() && absPath === additionalPath && absPath.endsWith(".md")) {
				allowedAdditional = true;
				break;
			}
		} catch {}
	}
	if (!allowedWorkspace && !allowedAdditional) throw new Error("path required");
	if (!absPath.endsWith(".md")) throw new Error("path required");
	if (allowedWorkspace) try {
		await (await root(params.workspaceDir)).resolve(relPath);
	} catch (err) {
		if (isFileMissingError(err)) return {
			text: "",
			path: relPath
		};
		throw err;
	}
	if ((await statRegularFile(absPath)).missing) return {
		text: "",
		path: relPath
	};
	let content;
	try {
		content = (await readRegularFile({ filePath: absPath })).buffer.toString("utf-8");
	} catch (err) {
		if (isFileMissingError(err)) return {
			text: "",
			path: relPath
		};
		throw err;
	}
	return buildMemoryReadResult({
		content,
		relPath,
		from: params.from,
		lines: params.lines,
		defaultLines: params.defaultLines ?? 120,
		maxChars: params.maxChars,
		suggestReadFallback: allowedWorkspace
	});
}
async function readAgentMemoryFile(params) {
	const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
	if (!settings) throw new Error("memory search disabled");
	const contextLimits = resolveAgentContextLimits(params.cfg, params.agentId);
	return await readMemoryFile({
		workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
		extraPaths: settings.extraPaths,
		relPath: params.relPath,
		from: params.from,
		lines: params.lines,
		defaultLines: contextLimits?.memoryGetDefaultLines,
		maxChars: contextLimits?.memoryGetMaxChars
	});
}
//#endregion
export { buildMemoryReadResult as a, DEFAULT_MEMORY_READ_MAX_CHARS as i, readMemoryFile as n, buildMemoryReadResultFromSlice as o, DEFAULT_MEMORY_READ_LINES as r, readAgentMemoryFile as t };
