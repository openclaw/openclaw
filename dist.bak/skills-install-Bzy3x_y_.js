import { c as ensureDir, g as resolveConfigDir, y as resolveUserPath } from "./utils-BKDT474X.js";
import { t as runCommandWithTimeout } from "./exec-NrPPwdAe.js";
import { d as hasBinary } from "./frontmatter-C8fqIiB_.js";
import { i as loadWorkspaceSkillEntries, t as resolveSkillsInstallPreferences, x as resolveSkillKey } from "./skills-dyOFjtQH.js";
import { t as fetchWithSsrFGuard } from "./fetch-guard-DGmDGmTu.js";
import { t as resolveBrewExecutable } from "./brew-Ougu-Knk.js";
import { t as isWithinDir } from "./path-safety-Dgp0AHn7.js";
import { a as extractArchive$1, d as resolveArchiveOutputPath, f as stripArchivePath, p as validateArchiveEntryPath, r as safePathSegmentHashed, u as isWindowsDrivePath } from "./install-safe-path-X5i-D74M.js";
import { t as scanDirectoryWithSummary } from "./skill-scanner-CsafCWHi.js";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

//#region src/agents/skills-install-output.ts
function summarizeInstallOutput(text) {
	const raw = text.trim();
	if (!raw) return;
	const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return;
	const preferred = lines.find((line) => /^error\b/i.test(line)) ?? lines.find((line) => /\b(err!|error:|failed)\b/i.test(line)) ?? lines.at(-1);
	if (!preferred) return;
	const normalized = preferred.replace(/\s+/g, " ").trim();
	const maxLen = 200;
	return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized;
}
function formatInstallFailureMessage(result) {
	const code = typeof result.code === "number" ? `exit ${result.code}` : "unknown exit";
	const summary = summarizeInstallOutput(result.stderr) ?? summarizeInstallOutput(result.stdout);
	if (!summary) return `Install failed (${code})`;
	return `Install failed (${code}): ${summary}`;
}

//#endregion
//#region src/agents/skills/tools-dir.ts
function resolveSkillToolsRootDir(entry) {
	const safeKey = safePathSegmentHashed(resolveSkillKey(entry.skill, entry));
	return path.join(resolveConfigDir(), "tools", safeKey);
}

//#endregion
//#region src/agents/skills-install-download.ts
function isNodeReadableStream(value) {
	return Boolean(value && typeof value.pipe === "function");
}
function resolveDownloadTargetDir(entry, spec) {
	const safeRoot = resolveSkillToolsRootDir(entry);
	const raw = spec.targetDir?.trim();
	if (!raw) return safeRoot;
	const resolved = raw.startsWith("~") || path.isAbsolute(raw) || isWindowsDrivePath(raw) ? resolveUserPath(raw) : path.resolve(safeRoot, raw);
	if (!isWithinDir(safeRoot, resolved)) throw new Error(`Refusing to install outside the skill tools directory. targetDir="${raw}" resolves to "${resolved}". Allowed root: "${safeRoot}".`);
	return resolved;
}
function resolveArchiveType(spec, filename) {
	const explicit = spec.archive?.trim().toLowerCase();
	if (explicit) return explicit;
	const lower = filename.toLowerCase();
	if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
	if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "tar.bz2";
	if (lower.endsWith(".zip")) return "zip";
}
async function downloadFile(url, destPath, timeoutMs) {
	const { response, release } = await fetchWithSsrFGuard({
		url,
		timeoutMs: Math.max(1e3, timeoutMs)
	});
	try {
		if (!response.ok || !response.body) throw new Error(`Download failed (${response.status} ${response.statusText})`);
		await ensureDir(path.dirname(destPath));
		const file = fs.createWriteStream(destPath);
		const body = response.body;
		await pipeline(isNodeReadableStream(body) ? body : Readable.fromWeb(body), file);
		return { bytes: (await fs.promises.stat(destPath)).size };
	} finally {
		await release();
	}
}
async function extractArchive(params) {
	const { archivePath, archiveType, targetDir, stripComponents, timeoutMs } = params;
	const strip = typeof stripComponents === "number" && Number.isFinite(stripComponents) ? Math.max(0, Math.floor(stripComponents)) : 0;
	try {
		if (archiveType === "zip") {
			await extractArchive$1({
				archivePath,
				destDir: targetDir,
				timeoutMs,
				kind: "zip",
				stripComponents: strip
			});
			return {
				stdout: "",
				stderr: "",
				code: 0
			};
		}
		if (archiveType === "tar.gz") {
			await extractArchive$1({
				archivePath,
				destDir: targetDir,
				timeoutMs,
				kind: "tar",
				stripComponents: strip,
				tarGzip: true
			});
			return {
				stdout: "",
				stderr: "",
				code: 0
			};
		}
		if (archiveType === "tar.bz2") {
			if (!hasBinary("tar")) return {
				stdout: "",
				stderr: "tar not found on PATH",
				code: null
			};
			const listResult = await runCommandWithTimeout([
				"tar",
				"tf",
				archivePath
			], { timeoutMs });
			if (listResult.code !== 0) return {
				stdout: listResult.stdout,
				stderr: listResult.stderr || "tar list failed",
				code: listResult.code
			};
			const entries = listResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
			const verboseResult = await runCommandWithTimeout([
				"tar",
				"tvf",
				archivePath
			], { timeoutMs });
			if (verboseResult.code !== 0) return {
				stdout: verboseResult.stdout,
				stderr: verboseResult.stderr || "tar verbose list failed",
				code: verboseResult.code
			};
			for (const line of verboseResult.stdout.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const typeChar = trimmed[0];
				if (typeChar === "l" || typeChar === "h" || trimmed.includes(" -> ")) return {
					stdout: verboseResult.stdout,
					stderr: "tar archive contains link entries; refusing to extract for safety",
					code: 1
				};
			}
			for (const entry of entries) {
				validateArchiveEntryPath(entry, { escapeLabel: "targetDir" });
				const relPath = stripArchivePath(entry, strip);
				if (!relPath) continue;
				validateArchiveEntryPath(relPath, { escapeLabel: "targetDir" });
				resolveArchiveOutputPath({
					rootDir: targetDir,
					relPath,
					originalPath: entry,
					escapeLabel: "targetDir"
				});
			}
			const argv = [
				"tar",
				"xf",
				archivePath,
				"-C",
				targetDir
			];
			if (strip > 0) argv.push("--strip-components", String(strip));
			return await runCommandWithTimeout(argv, { timeoutMs });
		}
		return {
			stdout: "",
			stderr: `unsupported archive type: ${archiveType}`,
			code: null
		};
	} catch (err) {
		return {
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			code: 1
		};
	}
}
async function installDownloadSpec(params) {
	const { entry, spec, timeoutMs } = params;
	const url = spec.url?.trim();
	if (!url) return {
		ok: false,
		message: "missing download url",
		stdout: "",
		stderr: "",
		code: null
	};
	let filename = "";
	try {
		const parsed = new URL(url);
		filename = path.basename(parsed.pathname);
	} catch {
		filename = path.basename(url);
	}
	if (!filename) filename = "download";
	let targetDir = "";
	try {
		targetDir = resolveDownloadTargetDir(entry, spec);
		await ensureDir(targetDir);
		const stat = await fs.promises.lstat(targetDir);
		if (stat.isSymbolicLink()) throw new Error(`targetDir is a symlink: ${targetDir}`);
		if (!stat.isDirectory()) throw new Error(`targetDir is not a directory: ${targetDir}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			message,
			stdout: "",
			stderr: message,
			code: null
		};
	}
	const archivePath = path.join(targetDir, filename);
	let downloaded = 0;
	try {
		downloaded = (await downloadFile(url, archivePath, timeoutMs)).bytes;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			message,
			stdout: "",
			stderr: message,
			code: null
		};
	}
	const archiveType = resolveArchiveType(spec, filename);
	if (!(spec.extract ?? Boolean(archiveType))) return {
		ok: true,
		message: `Downloaded to ${archivePath}`,
		stdout: `downloaded=${downloaded}`,
		stderr: "",
		code: 0
	};
	if (!archiveType) return {
		ok: false,
		message: "extract requested but archive type could not be detected",
		stdout: "",
		stderr: "",
		code: null
	};
	const extractResult = await extractArchive({
		archivePath,
		archiveType,
		targetDir,
		stripComponents: spec.stripComponents,
		timeoutMs
	});
	const success = extractResult.code === 0;
	return {
		ok: success,
		message: success ? `Downloaded and extracted to ${targetDir}` : formatInstallFailureMessage(extractResult),
		stdout: extractResult.stdout.trim(),
		stderr: extractResult.stderr.trim(),
		code: extractResult.code
	};
}

//#endregion
//#region src/agents/skills-install.ts
function withWarnings(result, warnings) {
	if (warnings.length === 0) return result;
	return {
		...result,
		warnings: warnings.slice()
	};
}
function formatScanFindingDetail(rootDir, finding) {
	const relativePath = path.relative(rootDir, finding.file);
	const filePath = relativePath && relativePath !== "." && !relativePath.startsWith("..") ? relativePath : path.basename(finding.file);
	return `${finding.message} (${filePath}:${finding.line})`;
}
async function collectSkillInstallScanWarnings(entry) {
	const warnings = [];
	const skillName = entry.skill.name;
	const skillDir = path.resolve(entry.skill.baseDir);
	try {
		const summary = await scanDirectoryWithSummary(skillDir);
		if (summary.critical > 0) {
			const criticalDetails = summary.findings.filter((finding) => finding.severity === "critical").map((finding) => formatScanFindingDetail(skillDir, finding)).join("; ");
			warnings.push(`WARNING: Skill "${skillName}" contains dangerous code patterns: ${criticalDetails}`);
		} else if (summary.warn > 0) warnings.push(`Skill "${skillName}" has ${summary.warn} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`);
	} catch (err) {
		warnings.push(`Skill "${skillName}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`);
	}
	return warnings;
}
function resolveInstallId(spec, index) {
	return (spec.id ?? `${spec.kind}-${index}`).trim();
}
function findInstallSpec(entry, installId) {
	const specs = entry.metadata?.install ?? [];
	for (const [index, spec] of specs.entries()) if (resolveInstallId(spec, index) === installId) return spec;
}
function buildNodeInstallCommand(packageName, prefs) {
	switch (prefs.nodeManager) {
		case "pnpm": return [
			"pnpm",
			"add",
			"-g",
			"--ignore-scripts",
			packageName
		];
		case "yarn": return [
			"yarn",
			"global",
			"add",
			"--ignore-scripts",
			packageName
		];
		case "bun": return [
			"bun",
			"add",
			"-g",
			"--ignore-scripts",
			packageName
		];
		default: return [
			"npm",
			"install",
			"-g",
			"--ignore-scripts",
			packageName
		];
	}
}
function buildInstallCommand(spec, prefs) {
	switch (spec.kind) {
		case "brew":
			if (!spec.formula) return {
				argv: null,
				error: "missing brew formula"
			};
			return { argv: [
				"brew",
				"install",
				spec.formula
			] };
		case "node":
			if (!spec.package) return {
				argv: null,
				error: "missing node package"
			};
			return { argv: buildNodeInstallCommand(spec.package, prefs) };
		case "go":
			if (!spec.module) return {
				argv: null,
				error: "missing go module"
			};
			return { argv: [
				"go",
				"install",
				spec.module
			] };
		case "uv":
			if (!spec.package) return {
				argv: null,
				error: "missing uv package"
			};
			return { argv: [
				"uv",
				"tool",
				"install",
				spec.package
			] };
		case "download": return {
			argv: null,
			error: "download install handled separately"
		};
		default: return {
			argv: null,
			error: "unsupported installer"
		};
	}
}
async function resolveBrewBinDir(timeoutMs, brewExe) {
	const exe = brewExe ?? (hasBinary("brew") ? "brew" : resolveBrewExecutable());
	if (!exe) return;
	const prefixResult = await runCommandWithTimeout([exe, "--prefix"], { timeoutMs: Math.min(timeoutMs, 3e4) });
	if (prefixResult.code === 0) {
		const prefix = prefixResult.stdout.trim();
		if (prefix) return path.join(prefix, "bin");
	}
	const envPrefix = process.env.HOMEBREW_PREFIX?.trim();
	if (envPrefix) return path.join(envPrefix, "bin");
	for (const candidate of ["/opt/homebrew/bin", "/usr/local/bin"]) try {
		if (fs.existsSync(candidate)) return candidate;
	} catch {}
}
function createInstallFailure(params) {
	return {
		ok: false,
		message: params.message,
		stdout: params.stdout?.trim() ?? "",
		stderr: params.stderr?.trim() ?? "",
		code: params.code ?? null
	};
}
function createInstallSuccess(result) {
	return {
		ok: true,
		message: "Installed",
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
		code: result.code
	};
}
async function runCommandSafely(argv, optionsOrTimeout) {
	try {
		const result = await runCommandWithTimeout(argv, optionsOrTimeout);
		return {
			code: result.code,
			stdout: result.stdout,
			stderr: result.stderr
		};
	} catch (err) {
		return {
			code: null,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err)
		};
	}
}
async function runBestEffortCommand(argv, optionsOrTimeout) {
	await runCommandSafely(argv, optionsOrTimeout);
}
function resolveBrewMissingFailure(spec) {
	const formula = spec.formula ?? "this package";
	return createInstallFailure({ message: `brew not installed — ${process.platform === "linux" ? `Homebrew is not installed. Install it from https://brew.sh or install "${formula}" manually using your system package manager (e.g. apt, dnf, pacman).` : "Homebrew is not installed. Install it from https://brew.sh"}` });
}
async function ensureUvInstalled(params) {
	if (params.spec.kind !== "uv" || hasBinary("uv")) return;
	if (!params.brewExe) return createInstallFailure({ message: "uv not installed — install manually: https://docs.astral.sh/uv/getting-started/installation/" });
	const brewResult = await runCommandSafely([
		params.brewExe,
		"install",
		"uv"
	], { timeoutMs: params.timeoutMs });
	if (brewResult.code === 0) return;
	return createInstallFailure({
		message: "Failed to install uv (brew)",
		...brewResult
	});
}
async function installGoViaApt(timeoutMs) {
	const aptInstallArgv = [
		"apt-get",
		"install",
		"-y",
		"golang-go"
	];
	const aptUpdateArgv = [
		"apt-get",
		"update",
		"-qq"
	];
	const aptFailureMessage = "go not installed — automatic install via apt failed. Install manually: https://go.dev/doc/install";
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		await runBestEffortCommand(aptUpdateArgv, { timeoutMs });
		const aptResult = await runCommandSafely(aptInstallArgv, { timeoutMs });
		if (aptResult.code === 0) return;
		return createInstallFailure({
			message: aptFailureMessage,
			...aptResult
		});
	}
	if (!hasBinary("sudo")) return createInstallFailure({ message: "go not installed — apt-get is available but sudo is not installed. Install manually: https://go.dev/doc/install" });
	const sudoCheck = await runCommandSafely([
		"sudo",
		"-n",
		"true"
	], { timeoutMs: 5e3 });
	if (sudoCheck.code !== 0) return createInstallFailure({
		message: "go not installed — apt-get is available but sudo is not usable (missing or requires a password). Install manually: https://go.dev/doc/install",
		...sudoCheck
	});
	await runBestEffortCommand(["sudo", ...aptUpdateArgv], { timeoutMs });
	const aptResult = await runCommandSafely(["sudo", ...aptInstallArgv], { timeoutMs });
	if (aptResult.code === 0) return;
	return createInstallFailure({
		message: aptFailureMessage,
		...aptResult
	});
}
async function ensureGoInstalled(params) {
	if (params.spec.kind !== "go" || hasBinary("go")) return;
	if (params.brewExe) {
		const brewResult = await runCommandSafely([
			params.brewExe,
			"install",
			"go"
		], { timeoutMs: params.timeoutMs });
		if (brewResult.code === 0) return;
		return createInstallFailure({
			message: "Failed to install go (brew)",
			...brewResult
		});
	}
	if (hasBinary("apt-get")) return installGoViaApt(params.timeoutMs);
	return createInstallFailure({ message: "go not installed — install manually: https://go.dev/doc/install" });
}
async function executeInstallCommand(params) {
	if (!params.argv || params.argv.length === 0) return createInstallFailure({ message: "invalid install command" });
	const result = await runCommandSafely(params.argv, {
		timeoutMs: params.timeoutMs,
		env: params.env
	});
	if (result.code === 0) return createInstallSuccess(result);
	return createInstallFailure({
		message: formatInstallFailureMessage(result),
		...result
	});
}
async function installSkill(params) {
	const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 3e5, 1e3), 9e5);
	const entry = loadWorkspaceSkillEntries(resolveUserPath(params.workspaceDir)).find((item) => item.skill.name === params.skillName);
	if (!entry) return {
		ok: false,
		message: `Skill not found: ${params.skillName}`,
		stdout: "",
		stderr: "",
		code: null
	};
	const spec = findInstallSpec(entry, params.installId);
	const warnings = await collectSkillInstallScanWarnings(entry);
	if (!spec) return withWarnings({
		ok: false,
		message: `Installer not found: ${params.installId}`,
		stdout: "",
		stderr: "",
		code: null
	}, warnings);
	if (spec.kind === "download") return withWarnings(await installDownloadSpec({
		entry,
		spec,
		timeoutMs
	}), warnings);
	const command = buildInstallCommand(spec, resolveSkillsInstallPreferences(params.config));
	if (command.error) return withWarnings({
		ok: false,
		message: command.error,
		stdout: "",
		stderr: "",
		code: null
	}, warnings);
	const brewExe = hasBinary("brew") ? "brew" : resolveBrewExecutable();
	if (spec.kind === "brew" && !brewExe) return withWarnings(resolveBrewMissingFailure(spec), warnings);
	const uvInstallFailure = await ensureUvInstalled({
		spec,
		brewExe,
		timeoutMs
	});
	if (uvInstallFailure) return withWarnings(uvInstallFailure, warnings);
	const goInstallFailure = await ensureGoInstalled({
		spec,
		brewExe,
		timeoutMs
	});
	if (goInstallFailure) return withWarnings(goInstallFailure, warnings);
	const argv = command.argv ? [...command.argv] : null;
	if (spec.kind === "brew" && brewExe && argv?.[0] === "brew") argv[0] = brewExe;
	let env;
	if (spec.kind === "go" && brewExe) {
		const brewBin = await resolveBrewBinDir(timeoutMs, brewExe);
		if (brewBin) env = { GOBIN: brewBin };
	}
	return withWarnings(await executeInstallCommand({
		argv,
		timeoutMs,
		env
	}), warnings);
}

//#endregion
export { installSkill as t };