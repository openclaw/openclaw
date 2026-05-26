import { o as hasErrnoCode } from "./errors-b3ZrCRlt.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import "./scan-paths-BJFKmVji.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/security/skill-scanner.ts
const SCANNABLE_EXTENSIONS = new Set([
	".js",
	".ts",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".jsx",
	".tsx"
]);
const DEFAULT_MAX_SCAN_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const FILE_SCAN_CACHE_MAX = 5e3;
const DIR_ENTRY_CACHE_MAX = 5e3;
const TEST_DIRECTORY_NAMES = new Set([
	"__fixtures__",
	"__mocks__",
	"__tests__",
	"test",
	"tests"
]);
const TEST_FILE_NAME_PATTERN = /\.(?:mock|spec|test)\.[^.]+$/i;
const FILE_SCAN_CACHE = /* @__PURE__ */ new Map();
const DIR_ENTRY_CACHE = /* @__PURE__ */ new Map();
function isScannable(filePath) {
	return SCANNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
function getCachedFileScanResult(params) {
	const cached = FILE_SCAN_CACHE.get(params.filePath);
	if (!cached) return;
	if (cached.size !== params.size || cached.mtimeMs !== params.mtimeMs || cached.maxFileBytes !== params.maxFileBytes) {
		FILE_SCAN_CACHE.delete(params.filePath);
		return;
	}
	return cached;
}
function setCachedFileScanResult(filePath, entry) {
	if (FILE_SCAN_CACHE.size >= FILE_SCAN_CACHE_MAX) {
		const oldest = FILE_SCAN_CACHE.keys().next();
		if (!oldest.done) FILE_SCAN_CACHE.delete(oldest.value);
	}
	FILE_SCAN_CACHE.set(filePath, entry);
}
function setCachedDirEntries(dirPath, entry) {
	if (DIR_ENTRY_CACHE.size >= DIR_ENTRY_CACHE_MAX) {
		const oldest = DIR_ENTRY_CACHE.keys().next();
		if (!oldest.done) DIR_ENTRY_CACHE.delete(oldest.value);
	}
	DIR_ENTRY_CACHE.set(dirPath, entry);
}
function clearSkillScanCacheForTest() {
	FILE_SCAN_CACHE.clear();
	DIR_ENTRY_CACHE.clear();
}
const LINE_RULES = [
	{
		ruleId: "dangerous-exec",
		severity: "critical",
		message: "Shell command execution detected (child_process)",
		pattern: /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/,
		requiresContext: /child_process/
	},
	{
		ruleId: "dynamic-code-execution",
		severity: "critical",
		message: "Dynamic code execution detected",
		pattern: /\beval\s*\(|new\s+Function\s*\(/
	},
	{
		ruleId: "crypto-mining",
		severity: "critical",
		message: "Possible crypto-mining reference detected",
		pattern: /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i
	},
	{
		ruleId: "suspicious-network",
		severity: "warn",
		message: "WebSocket connection to non-standard port",
		pattern: /new\s+WebSocket\s*\(\s*["']wss?:\/\/[^"']*:(\d+)/
	}
];
const STANDARD_PORTS = new Set([
	80,
	443,
	8080,
	8443,
	3e3
]);
const NETWORK_SEND_CONTEXT_PATTERN = /\bfetch\s*\(|\bpost\s*\(|\.\s*post\s*\(|http\.request\s*\(/i;
const SOURCE_RULES = [
	{
		ruleId: "potential-exfiltration",
		severity: "warn",
		message: "File read combined with network send — possible data exfiltration",
		pattern: /readFileSync|readFile/,
		requiresContext: NETWORK_SEND_CONTEXT_PATTERN
	},
	{
		ruleId: "obfuscated-code",
		severity: "warn",
		message: "Hex-encoded string sequence detected (possible obfuscation)",
		pattern: /(\\x[0-9a-fA-F]{2}){6,}/
	},
	{
		ruleId: "obfuscated-code",
		severity: "warn",
		message: "Large base64 payload with decode call detected (possible obfuscation)",
		pattern: /(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{200,}["']/
	},
	{
		ruleId: "env-harvesting",
		severity: "critical",
		message: "Environment variable access combined with network send — possible credential harvesting",
		pattern: /process\.env/,
		requiresContext: NETWORK_SEND_CONTEXT_PATTERN,
		requiresContextWindowLines: 8
	}
];
function truncateEvidence(evidence, maxLen = 120) {
	if (evidence.length <= maxLen) return evidence;
	return `${evidence.slice(0, maxLen)}…`;
}
function isBenignMemberExecMatch(line, match) {
	if (match[1] !== "exec") return false;
	const matchIndex = match.index;
	if (matchIndex <= 0 || line[matchIndex - 1] !== ".") return false;
	return !/\b(?:cp|childProcess|child_process)\s*\.\s*exec\s*\(/.test(line);
}
function stripCommentsForHeuristics(source) {
	let stripped = "";
	let quote = null;
	let escaped = false;
	let inBlockComment = false;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i] ?? "";
		const next = source[i + 1] ?? "";
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i++;
				continue;
			}
			if (ch === "\n") stripped += "\n";
			continue;
		}
		if (quote) {
			stripped += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === "\"" || ch === "`") {
			quote = ch;
			stripped += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			if (source[i] === "\n") stripped += "\n";
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		stripped += ch;
	}
	return stripped;
}
function findSourceRuleMatch(params) {
	if (!params.rule.pattern.test(params.source)) return null;
	if (params.rule.requiresContext && !params.rule.requiresContext.test(params.source)) return null;
	for (let i = 0; i < params.lines.length; i++) {
		if (!params.rule.pattern.test(params.lines[i] ?? "")) continue;
		if (params.rule.requiresContext && params.rule.requiresContextWindowLines !== void 0) {
			const start = Math.max(0, i - params.rule.requiresContextWindowLines);
			const end = Math.min(params.lines.length, i + params.rule.requiresContextWindowLines + 1);
			const windowSource = params.lines.slice(start, end).join("\n");
			if (!params.rule.requiresContext.test(windowSource)) continue;
		}
		return {
			line: i + 1,
			evidence: params.lines[i] ?? ""
		};
	}
	if (params.rule.requiresContextWindowLines !== void 0) return null;
	return {
		line: 1,
		evidence: params.source.slice(0, 120)
	};
}
function scanSource(source, filePath) {
	const findings = [];
	const lines = source.split("\n");
	const heuristicSource = stripCommentsForHeuristics(source);
	const heuristicLines = heuristicSource.split("\n");
	const matchedLineRules = /* @__PURE__ */ new Set();
	for (const rule of LINE_RULES) {
		if (matchedLineRules.has(rule.ruleId)) continue;
		if (rule.requiresContext && !rule.requiresContext.test(source)) continue;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const match = rule.pattern.exec(line);
			if (!match) continue;
			if (rule.ruleId === "dangerous-exec" && isBenignMemberExecMatch(line, match)) continue;
			if (rule.ruleId === "suspicious-network") {
				const port = Number.parseInt(match[1], 10);
				if (STANDARD_PORTS.has(port)) continue;
			}
			findings.push({
				ruleId: rule.ruleId,
				severity: rule.severity,
				file: filePath,
				line: i + 1,
				message: rule.message,
				evidence: truncateEvidence(line.trim())
			});
			matchedLineRules.add(rule.ruleId);
			break;
		}
	}
	const matchedSourceRules = /* @__PURE__ */ new Set();
	for (const rule of SOURCE_RULES) {
		const ruleKey = `${rule.ruleId}::${rule.message}`;
		if (matchedSourceRules.has(ruleKey)) continue;
		const match = findSourceRuleMatch({
			rule,
			source: heuristicSource,
			lines: heuristicLines
		});
		if (!match) continue;
		findings.push({
			ruleId: rule.ruleId,
			severity: rule.severity,
			file: filePath,
			line: match.line,
			message: rule.message,
			evidence: truncateEvidence(lines[match.line - 1]?.trim() ?? match.evidence.trim())
		});
		matchedSourceRules.add(ruleKey);
	}
	return findings;
}
function normalizeScanOptions(opts) {
	return {
		excludeTestFiles: opts?.excludeTestFiles ?? false,
		includeHiddenDirectories: opts?.includeHiddenDirectories ?? false,
		includeNestedNodeModulesTestFiles: opts?.includeNestedNodeModulesTestFiles ?? false,
		includeNodeModules: opts?.includeNodeModules ?? false,
		includeFiles: opts?.includeFiles ?? [],
		onlyIncludeFiles: opts?.onlyIncludeFiles ?? false,
		maxFiles: Math.max(1, opts?.maxFiles ?? DEFAULT_MAX_SCAN_FILES),
		maxFileBytes: Math.max(1, opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
	};
}
function isExcludedTestDirectoryName(name) {
	return TEST_DIRECTORY_NAMES.has(name);
}
function isExcludedTestFileName(name) {
	return TEST_FILE_NAME_PATTERN.test(name);
}
function pathContainsNodeModulesSegment(relativePath) {
	return relativePath.split(/[\\/]+/u).includes("node_modules");
}
async function walkDirWithLimit(rootDir, dirPath, candidateLimit, excludeTestFiles, includeHiddenDirectories, includeNestedNodeModulesTestFiles, includeNodeModules) {
	const files = [];
	const stack = [dirPath];
	while (stack.length > 0 && files.length < candidateLimit) {
		const currentDir = stack.pop();
		if (!currentDir) break;
		const entries = await readDirEntriesWithCache(currentDir);
		for (const entry of entries) {
			if (files.length >= candidateLimit) break;
			if (!includeHiddenDirectories && entry.name.startsWith(".") || !includeNodeModules && entry.name === "node_modules") continue;
			const fullPath = path.join(currentDir, entry.name);
			const isExcludedTestPath = entry.kind === "dir" ? isExcludedTestDirectoryName(entry.name) : isExcludedTestFileName(entry.name);
			if (excludeTestFiles && isExcludedTestPath && !(includeNestedNodeModulesTestFiles && pathContainsNodeModulesSegment(path.relative(rootDir, fullPath)))) continue;
			if (entry.kind === "dir") stack.push(fullPath);
			else if (entry.kind === "file" && isScannable(entry.name)) files.push(fullPath);
		}
	}
	return {
		files,
		truncated: files.length >= candidateLimit
	};
}
async function readDirEntriesWithCache(dirPath) {
	let st = null;
	try {
		st = await fs.stat(dirPath);
	} catch (err) {
		if (hasErrnoCode(err, "ENOENT")) return [];
		throw err;
	}
	if (!st?.isDirectory()) return [];
	const cached = DIR_ENTRY_CACHE.get(dirPath);
	if (cached && cached.mtimeMs === st.mtimeMs) return cached.entries;
	const dirents = await fs.readdir(dirPath, { withFileTypes: true });
	const entries = [];
	for (const entry of dirents) if (entry.isDirectory()) entries.push({
		name: entry.name,
		kind: "dir"
	});
	else if (entry.isFile()) entries.push({
		name: entry.name,
		kind: "file"
	});
	setCachedDirEntries(dirPath, {
		mtimeMs: st.mtimeMs,
		entries
	});
	return entries;
}
async function resolveForcedFiles(params) {
	if (params.includeFiles.length === 0) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const rawIncludePath of params.includeFiles) {
		const includePath = path.resolve(params.rootDir, rawIncludePath);
		if (!isPathInside(params.rootDir, includePath)) continue;
		if (!isScannable(includePath)) continue;
		if (seen.has(includePath)) continue;
		let st = null;
		try {
			st = await fs.stat(includePath);
		} catch (err) {
			if (hasErrnoCode(err, "ENOENT")) continue;
			throw err;
		}
		if (!st?.isFile()) continue;
		out.push(includePath);
		seen.add(includePath);
	}
	return out;
}
async function collectScannableFiles(dirPath, opts) {
	const forcedFiles = await resolveForcedFiles({
		rootDir: dirPath,
		includeFiles: opts.includeFiles
	});
	if (opts.onlyIncludeFiles) return {
		files: forcedFiles.slice(0, opts.maxFiles),
		truncated: forcedFiles.length > opts.maxFiles
	};
	if (forcedFiles.length > opts.maxFiles) return {
		files: forcedFiles.slice(0, opts.maxFiles),
		truncated: true
	};
	const walked = await walkDirWithLimit(dirPath, dirPath, opts.maxFiles + 1, opts.excludeTestFiles, opts.includeHiddenDirectories, opts.includeNestedNodeModulesTestFiles, opts.includeNodeModules);
	const seen = new Set(forcedFiles.map((f) => path.resolve(f)));
	const out = [...forcedFiles];
	for (const walkedFile of walked.files) {
		const resolved = path.resolve(walkedFile);
		if (seen.has(resolved)) continue;
		if (out.length >= opts.maxFiles) return {
			files: out.slice(0, opts.maxFiles),
			truncated: true
		};
		out.push(walkedFile);
		seen.add(resolved);
	}
	return {
		files: out,
		truncated: false
	};
}
async function scanFileWithCache(params) {
	const { filePath, maxFileBytes } = params;
	let st = null;
	try {
		st = await fs.stat(filePath);
	} catch (err) {
		if (hasErrnoCode(err, "ENOENT")) return {
			scanned: false,
			findings: []
		};
		throw err;
	}
	if (!st?.isFile()) return {
		scanned: false,
		findings: []
	};
	const cached = getCachedFileScanResult({
		filePath,
		size: st.size,
		mtimeMs: st.mtimeMs,
		maxFileBytes
	});
	if (cached) return {
		scanned: cached.scanned,
		findings: cached.findings
	};
	if (st.size > maxFileBytes) {
		setCachedFileScanResult(filePath, {
			size: st.size,
			mtimeMs: st.mtimeMs,
			maxFileBytes,
			scanned: false,
			findings: []
		});
		return {
			scanned: false,
			findings: []
		};
	}
	let source;
	try {
		source = await fs.readFile(filePath, "utf-8");
	} catch (err) {
		if (hasErrnoCode(err, "ENOENT")) return {
			scanned: false,
			findings: []
		};
		throw err;
	}
	const findings = scanSource(source, filePath);
	setCachedFileScanResult(filePath, {
		size: st.size,
		mtimeMs: st.mtimeMs,
		maxFileBytes,
		scanned: true,
		findings
	});
	return {
		scanned: true,
		findings
	};
}
async function scanDirectory(dirPath, opts) {
	const scanOptions = normalizeScanOptions(opts);
	const { files } = await collectScannableFiles(dirPath, scanOptions);
	const allFindings = [];
	for (const file of files) {
		const scanResult = await scanFileWithCache({
			filePath: file,
			maxFileBytes: scanOptions.maxFileBytes
		});
		if (!scanResult.scanned) continue;
		allFindings.push(...scanResult.findings);
	}
	return allFindings;
}
async function scanDirectoryWithSummary(dirPath, opts) {
	const scanOptions = normalizeScanOptions(opts);
	const { files, truncated } = await collectScannableFiles(dirPath, scanOptions);
	const allFindings = [];
	let scannedFiles = 0;
	let critical = 0;
	let warn = 0;
	let info = 0;
	for (const file of files) {
		const scanResult = await scanFileWithCache({
			filePath: file,
			maxFileBytes: scanOptions.maxFileBytes
		});
		if (!scanResult.scanned) continue;
		scannedFiles += 1;
		for (const finding of scanResult.findings) {
			allFindings.push(finding);
			if (finding.severity === "critical") critical += 1;
			else if (finding.severity === "warn") warn += 1;
			else info += 1;
		}
	}
	return {
		scannedFiles,
		critical,
		warn,
		info,
		truncated,
		findings: allFindings
	};
}
//#endregion
export { scanSource as a, scanDirectoryWithSummary as i, isScannable as n, scanDirectory as r, clearSkillScanCacheForTest as t };
