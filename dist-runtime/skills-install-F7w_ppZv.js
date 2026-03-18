import { _ as resolveConfigDir, b as resolveUserPath, c as ensureDir, d as init_utils } from "./utils-BiUV1eIQ.js";
import { Fu as createTarEntryPreflightChecker, Gu as isWithinDir, Hu as prepareArchiveDestinationDir, Iu as extractArchive$1, Uu as withStagedArchiveDestination, Vu as mergeExtractedTreeIntoDestination, Wu as isWindowsDrivePath } from "./auth-profiles-DAOR1fRn.js";
import { C as fetchWithSsrFGuard } from "./plugins-allowlist-E4LSkJ7R.js";
import { t as resolveBrewExecutable } from "./brew-CAA1PAwX.js";
import { t as runCommandWithTimeout } from "./exec-BmPfiSbq.js";
import { f as resolveSkillKey } from "./env-overrides-Dbt5eAZJ.js";
import { N as writeFileFromPathWithinRoot } from "./query-expansion-V82ct97U.js";
import { f as hasBinary } from "./frontmatter-UI6LO8NQ.js";
import { o as loadWorkspaceSkillEntries, t as resolveSkillsInstallPreferences } from "./skills-DUmWDILI.js";
import { t as scanDirectoryWithSummary } from "./skill-scanner-PR6IiKx6.js";
import { i as safePathSegmentHashed, t as assertCanonicalPathWithinBase } from "./install-safe-path-BmwD_9Ds.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
//#region src/agents/skills-install-tar-verbose.ts
const TAR_VERBOSE_MONTHS = new Set([
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec"
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function mapTarVerboseTypeChar(typeChar) {
	switch (typeChar) {
		case "l": return "SymbolicLink";
		case "h": return "Link";
		case "b": return "BlockDevice";
		case "c": return "CharacterDevice";
		case "p": return "FIFO";
		case "s": return "Socket";
		case "d": return "Directory";
		default: return "File";
	}
}
function parseTarVerboseSize(line) {
	const tokens = line.trim().split(/\s+/).filter(Boolean);
	if (tokens.length < 6) throw new Error(`unable to parse tar verbose metadata: ${line}`);
	let dateIndex = tokens.findIndex((token) => TAR_VERBOSE_MONTHS.has(token));
	if (dateIndex > 0) {
		const size = Number.parseInt(tokens[dateIndex - 1] ?? "", 10);
		if (!Number.isFinite(size) || size < 0) throw new Error(`unable to parse tar entry size: ${line}`);
		return size;
	}
	dateIndex = tokens.findIndex((token) => ISO_DATE_PATTERN.test(token));
	if (dateIndex > 0) {
		const size = Number.parseInt(tokens[dateIndex - 1] ?? "", 10);
		if (!Number.isFinite(size) || size < 0) throw new Error(`unable to parse tar entry size: ${line}`);
		return size;
	}
	throw new Error(`unable to parse tar verbose metadata: ${line}`);
}
function parseTarVerboseMetadata(stdout) {
	return stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
		const typeChar = line[0] ?? "";
		if (!typeChar) throw new Error("unable to parse tar entry type");
		return {
			type: mapTarVerboseTypeChar(typeChar),
			size: parseTarVerboseSize(line)
		};
	});
}
//#endregion
//#region src/agents/skills-install-extract.ts
async function hashFileSha256(filePath) {
	const hash = createHash("sha256");
	const stream = fs.createReadStream(filePath);
	return await new Promise((resolve, reject) => {
		stream.on("data", (chunk) => {
			hash.update(chunk);
		});
		stream.on("error", reject);
		stream.on("end", () => {
			resolve(hash.digest("hex"));
		});
	});
}
function commandFailureResult(result, fallbackStderr) {
	return {
		stdout: result.stdout,
		stderr: result.stderr || fallbackStderr,
		code: result.code
	};
}
function buildTarExtractArgv(params) {
	const argv = [
		"tar",
		"xf",
		params.archivePath,
		"-C",
		params.targetDir
	];
	if (params.stripComponents > 0) argv.push("--strip-components", String(params.stripComponents));
	return argv;
}
async function readTarPreflight(params) {
	const listResult = await runCommandWithTimeout([
		"tar",
		"tf",
		params.archivePath
	], { timeoutMs: params.timeoutMs });
	if (listResult.code !== 0) return commandFailureResult(listResult, "tar list failed");
	const entries = listResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
	const verboseResult = await runCommandWithTimeout([
		"tar",
		"tvf",
		params.archivePath
	], { timeoutMs: params.timeoutMs });
	if (verboseResult.code !== 0) return commandFailureResult(verboseResult, "tar verbose list failed");
	const metadata = parseTarVerboseMetadata(verboseResult.stdout);
	if (metadata.length !== entries.length) return {
		stdout: verboseResult.stdout,
		stderr: `tar verbose/list entry count mismatch (${metadata.length} vs ${entries.length})`,
		code: 1
	};
	return {
		entries,
		metadata
	};
}
function isArchiveExtractFailure(value) {
	return "code" in value;
}
async function verifyArchiveHashStable(params) {
	if (await hashFileSha256(params.archivePath) === params.expectedHash) return null;
	return {
		stdout: "",
		stderr: "tar archive changed during safety preflight; refusing to extract",
		code: 1
	};
}
async function extractTarBz2WithStaging(params) {
	return await withStagedArchiveDestination({
		destinationRealDir: params.destinationRealDir,
		run: async (stagingDir) => {
			const extractResult = await runCommandWithTimeout(buildTarExtractArgv({
				archivePath: params.archivePath,
				targetDir: stagingDir,
				stripComponents: params.stripComponents
			}), { timeoutMs: params.timeoutMs });
			if (extractResult.code !== 0) return extractResult;
			await mergeExtractedTreeIntoDestination({
				sourceDir: stagingDir,
				destinationDir: params.destinationRealDir,
				destinationRealDir: params.destinationRealDir
			});
			return extractResult;
		}
	});
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
			const destinationRealDir = await prepareArchiveDestinationDir(targetDir);
			const preflightHash = await hashFileSha256(archivePath);
			const preflight = await readTarPreflight({
				archivePath,
				timeoutMs
			});
			if (isArchiveExtractFailure(preflight)) return preflight;
			const checkTarEntrySafety = createTarEntryPreflightChecker({
				rootDir: destinationRealDir,
				stripComponents: strip,
				escapeLabel: "targetDir"
			});
			for (let i = 0; i < preflight.entries.length; i += 1) {
				const entryPath = preflight.entries[i];
				const entryMeta = preflight.metadata[i];
				if (!entryPath || !entryMeta) return {
					stdout: "",
					stderr: "tar metadata parse failure",
					code: 1
				};
				checkTarEntrySafety({
					path: entryPath,
					type: entryMeta.type,
					size: entryMeta.size
				});
			}
			const hashFailure = await verifyArchiveHashStable({
				archivePath,
				expectedHash: preflightHash
			});
			if (hashFailure) return hashFailure;
			return await extractTarBz2WithStaging({
				archivePath,
				destinationRealDir,
				stripComponents: strip,
				timeoutMs
			});
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
//#endregion
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
init_utils();
function resolveSkillToolsRootDir(entry) {
	const safeKey = safePathSegmentHashed(resolveSkillKey(entry.skill, entry));
	return path.join(resolveConfigDir(), "tools", safeKey);
}
//#endregion
//#region src/agents/skills-install-download.ts
init_utils();
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
async function downloadFile(params) {
	const destPath = path.resolve(params.rootDir, params.relativePath);
	const stagingDir = path.join(params.rootDir, ".openclaw-download-staging");
	await ensureDir(stagingDir);
	await assertCanonicalPathWithinBase({
		baseDir: params.rootDir,
		candidatePath: stagingDir,
		boundaryLabel: "skill tools directory"
	});
	const tempPath = path.join(stagingDir, `${randomUUID()}.tmp`);
	const { response, release } = await fetchWithSsrFGuard({
		url: params.url,
		timeoutMs: Math.max(1e3, params.timeoutMs)
	});
	try {
		if (!response.ok || !response.body) throw new Error(`Download failed (${response.status} ${response.statusText})`);
		const file = fs.createWriteStream(tempPath);
		const body = response.body;
		await pipeline(isNodeReadableStream(body) ? body : Readable.fromWeb(body), file);
		await writeFileFromPathWithinRoot({
			rootDir: params.rootDir,
			relativePath: params.relativePath,
			sourcePath: tempPath
		});
		return { bytes: (await fs.promises.stat(destPath)).size };
	} finally {
		await fs.promises.rm(tempPath, { force: true }).catch(() => void 0);
		await release();
	}
}
async function installDownloadSpec(params) {
	const { entry, spec, timeoutMs } = params;
	const safeRoot = resolveSkillToolsRootDir(entry);
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
	let canonicalSafeRoot = "";
	let targetDir = "";
	try {
		await ensureDir(safeRoot);
		await assertCanonicalPathWithinBase({
			baseDir: safeRoot,
			candidatePath: safeRoot,
			boundaryLabel: "skill tools directory"
		});
		canonicalSafeRoot = await fs.promises.realpath(safeRoot);
		const requestedTargetDir = resolveDownloadTargetDir(entry, spec);
		await ensureDir(requestedTargetDir);
		await assertCanonicalPathWithinBase({
			baseDir: safeRoot,
			candidatePath: requestedTargetDir,
			boundaryLabel: "skill tools directory"
		});
		const targetRelativePath = path.relative(safeRoot, requestedTargetDir);
		targetDir = path.join(canonicalSafeRoot, targetRelativePath);
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
	const archiveRelativePath = path.relative(canonicalSafeRoot, archivePath);
	if (!archiveRelativePath || archiveRelativePath === ".." || archiveRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(archiveRelativePath)) return {
		ok: false,
		message: "invalid download archive path",
		stdout: "",
		stderr: "invalid download archive path",
		code: null
	};
	let downloaded = 0;
	try {
		downloaded = (await downloadFile({
			url,
			rootDir: canonicalSafeRoot,
			relativePath: archiveRelativePath,
			timeoutMs
		})).bytes;
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
	try {
		await assertCanonicalPathWithinBase({
			baseDir: canonicalSafeRoot,
			candidatePath: targetDir,
			boundaryLabel: "skill tools directory"
		});
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
init_utils();
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
