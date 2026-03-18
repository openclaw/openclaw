import { a as hasErrnoCode } from "./errors-nCFRNLA6.js";
import { n as isPathInside } from "./scan-paths-Zo6qyBUS.js";
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
const SOURCE_RULES = [
	{
		ruleId: "potential-exfiltration",
		severity: "warn",
		message: "File read combined with network send — possible data exfiltration",
		pattern: /readFileSync|readFile/,
		requiresContext: /\bfetch\b|\bpost\b|http\.request/i
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
		requiresContext: /\bfetch\b|\bpost\b|http\.request/i
	}
];
function truncateEvidence(evidence, maxLen = 120) {
	if (evidence.length <= maxLen) return evidence;
	return `${evidence.slice(0, maxLen)}…`;
}
function scanSource(source, filePath) {
	const findings = [];
	const lines = source.split("\n");
	const matchedLineRules = /* @__PURE__ */ new Set();
	for (const rule of LINE_RULES) {
		if (matchedLineRules.has(rule.ruleId)) continue;
		if (rule.requiresContext && !rule.requiresContext.test(source)) continue;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const match = rule.pattern.exec(line);
			if (!match) continue;
			if (rule.ruleId === "suspicious-network") {
				const port = parseInt(match[1], 10);
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
		if (!rule.pattern.test(source)) continue;
		if (rule.requiresContext && !rule.requiresContext.test(source)) continue;
		let matchLine = 0;
		let matchEvidence = "";
		for (let i = 0; i < lines.length; i++) if (rule.pattern.test(lines[i])) {
			matchLine = i + 1;
			matchEvidence = lines[i].trim();
			break;
		}
		if (matchLine === 0) {
			matchLine = 1;
			matchEvidence = source.slice(0, 120);
		}
		findings.push({
			ruleId: rule.ruleId,
			severity: rule.severity,
			file: filePath,
			line: matchLine,
			message: rule.message,
			evidence: truncateEvidence(matchEvidence)
		});
		matchedSourceRules.add(ruleKey);
	}
	return findings;
}
function normalizeScanOptions(opts) {
	return {
		includeFiles: opts?.includeFiles ?? [],
		maxFiles: Math.max(1, opts?.maxFiles ?? DEFAULT_MAX_SCAN_FILES),
		maxFileBytes: Math.max(1, opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
	};
}
async function walkDirWithLimit(dirPath, maxFiles) {
	const files = [];
	const stack = [dirPath];
	while (stack.length > 0 && files.length < maxFiles) {
		const currentDir = stack.pop();
		if (!currentDir) break;
		const entries = await readDirEntriesWithCache(currentDir);
		for (const entry of entries) {
			if (files.length >= maxFiles) break;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = path.join(currentDir, entry.name);
			if (entry.kind === "dir") stack.push(fullPath);
			else if (entry.kind === "file" && isScannable(entry.name)) files.push(fullPath);
		}
	}
	return files;
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
	if (forcedFiles.length >= opts.maxFiles) return forcedFiles.slice(0, opts.maxFiles);
	const walkedFiles = await walkDirWithLimit(dirPath, opts.maxFiles);
	const seen = new Set(forcedFiles.map((f) => path.resolve(f)));
	const out = [...forcedFiles];
	for (const walkedFile of walkedFiles) {
		if (out.length >= opts.maxFiles) break;
		const resolved = path.resolve(walkedFile);
		if (seen.has(resolved)) continue;
		out.push(walkedFile);
		seen.add(resolved);
	}
	return out;
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
async function scanDirectoryWithSummary(dirPath, opts) {
	const scanOptions = normalizeScanOptions(opts);
	const files = await collectScannableFiles(dirPath, scanOptions);
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
		findings: allFindings
	};
}
//#endregion
export { scanDirectoryWithSummary as t };
