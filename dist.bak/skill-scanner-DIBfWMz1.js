import { n as isPathInside } from "./scan-paths-CVkptOYB.js";
import { i as hasErrnoCode } from "./errors-Cu3BYw29.js";
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
function isScannable(filePath) {
	return SCANNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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
		const entries = await fs.readdir(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			if (files.length >= maxFiles) break;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) stack.push(fullPath);
			else if (isScannable(entry.name)) files.push(fullPath);
		}
	}
	return files;
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
async function readScannableSource(filePath, maxFileBytes) {
	let st = null;
	try {
		st = await fs.stat(filePath);
	} catch (err) {
		if (hasErrnoCode(err, "ENOENT")) return null;
		throw err;
	}
	if (!st?.isFile() || st.size > maxFileBytes) return null;
	try {
		return await fs.readFile(filePath, "utf-8");
	} catch (err) {
		if (hasErrnoCode(err, "ENOENT")) return null;
		throw err;
	}
}
async function scanDirectoryWithSummary(dirPath, opts) {
	const scanOptions = normalizeScanOptions(opts);
	const files = await collectScannableFiles(dirPath, scanOptions);
	const allFindings = [];
	let scannedFiles = 0;
	for (const file of files) {
		const source = await readScannableSource(file, scanOptions.maxFileBytes);
		if (source == null) continue;
		scannedFiles += 1;
		const findings = scanSource(source, file);
		allFindings.push(...findings);
	}
	return {
		scannedFiles,
		critical: allFindings.filter((f) => f.severity === "critical").length,
		warn: allFindings.filter((f) => f.severity === "warn").length,
		info: allFindings.filter((f) => f.severity === "info").length,
		findings: allFindings
	};
}

//#endregion
export { scanDirectoryWithSummary as t };