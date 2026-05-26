import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { c as isWithinDir } from "./path-BlG8lhgR.js";
import "./fs-safe-CV86zY9G.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import { o as safePathSegmentHashed, r as assertCanonicalPathWithinBase } from "./install-safe-path-DEiFZ_bF.js";
import { h as isWindowsDrivePath } from "./archive-DBeZ8ywX.js";
import { d as resolveConfigDir, p as resolveUserPath, s as ensureDir } from "./utils-sBTEdeml.js";
import "./path-safety-CBe_wA_B.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { v as isContainerEnvironment } from "./net-DCUMtgJy.js";
import "./sandbox-paths-BTYunIeX.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { n as hasBinary } from "./config-eval-BH8jfSqo.js";
import { i as resolveSkillKey } from "./frontmatter-BTFF5uon.js";
import { t as resolveSkillSource } from "./source-SBWOzARs.js";
import { o as loadWorkspaceSkillEntries } from "./workspace-BoRIIBbL.js";
import { t as resolveSkillsInstallPreferences } from "./skills-JUNRkaHl.js";
import { t as resolveBrewExecutable } from "./brew-B6RYZvsE.js";
import { a as scanSkillInstallSource } from "./install-security-scan-Bg5dT8e-.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
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
const extractModuleLoader = createLazyImportLoader(() => import("./skills-install-extract-Cx8Oj3PP.js"));
async function loadExtractModule() {
	return await extractModuleLoader.load();
}
function isNodeReadableStream(value) {
	return Boolean(value && typeof value.pipe === "function");
}
function resolveDownloadTargetDir(entry, spec) {
	const root = resolveSkillToolsRootDir(entry);
	const raw = spec.targetDir?.trim();
	if (!raw) return root;
	const resolved = raw.startsWith("~") || path.isAbsolute(raw) || isWindowsDrivePath(raw) ? resolveUserPath(raw) : path.resolve(root, raw);
	if (!isWithinDir(root, resolved)) throw new Error(`Refusing to install outside the skill tools directory. targetDir="${raw}" resolves to "${resolved}". Allowed root: "${root}".`);
	return resolved;
}
function resolveArchiveType(spec, filename) {
	const explicit = normalizeOptionalLowercaseString(spec.archive);
	if (explicit) return explicit;
	const lower = normalizeOptionalLowercaseString(filename);
	if (!lower) return;
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
		await (await root(params.rootDir)).copyIn(params.relativePath, tempPath);
		return { bytes: (await fs.promises.stat(destPath)).size };
	} finally {
		await fs.promises.rm(tempPath, { force: true }).catch(() => void 0);
		await release();
	}
}
async function installDownloadSpec(params) {
	const { entry, spec, timeoutMs } = params;
	const root = resolveSkillToolsRootDir(entry);
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
	let canonicalRoot = "";
	let targetDir = "";
	try {
		await ensureDir(root);
		await assertCanonicalPathWithinBase({
			baseDir: root,
			candidatePath: root,
			boundaryLabel: "skill tools directory"
		});
		canonicalRoot = await fs.promises.realpath(root);
		const requestedTargetDir = resolveDownloadTargetDir(entry, spec);
		await ensureDir(requestedTargetDir);
		await assertCanonicalPathWithinBase({
			baseDir: root,
			candidatePath: requestedTargetDir,
			boundaryLabel: "skill tools directory"
		});
		const targetRelativePath = path.relative(root, requestedTargetDir);
		targetDir = path.join(canonicalRoot, targetRelativePath);
	} catch (err) {
		const message = formatErrorMessage(err);
		return {
			ok: false,
			message,
			stdout: "",
			stderr: message,
			code: null
		};
	}
	const archivePath = path.join(targetDir, filename);
	const archiveRelativePath = path.relative(canonicalRoot, archivePath);
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
			rootDir: canonicalRoot,
			relativePath: archiveRelativePath,
			timeoutMs
		})).bytes;
	} catch (err) {
		const message = formatErrorMessage(err);
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
			baseDir: canonicalRoot,
			candidatePath: targetDir,
			boundaryLabel: "skill tools directory"
		});
	} catch (err) {
		const message = formatErrorMessage(err);
		return {
			ok: false,
			message,
			stdout: "",
			stderr: message,
			code: null
		};
	}
	const { extractArchive } = await loadExtractModule();
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
let skillsInstallDeps = {
	hasBinary,
	loadWorkspaceSkillEntries,
	resolveNodeInstallStateDir: resolveDefaultNodeInstallStateDir,
	resolveBrewExecutable,
	isContainerEnvironment,
	resolveSkillsInstallPreferences
};
function getSkillsInstallDeps() {
	return skillsInstallDeps;
}
function withWarnings(result, warnings) {
	if (warnings.length === 0) return result;
	return {
		...result,
		warnings: warnings.slice()
	};
}
function resolveInstallId(spec, index) {
	return (spec.id ?? `${spec.kind}-${index}`).trim();
}
function findInstallSpec(entry, installId) {
	const specs = entry.metadata?.install ?? [];
	for (const [index, spec] of specs.entries()) if (resolveInstallId(spec, index) === installId) return spec;
}
function normalizeSkillInstallSpec(spec) {
	return {
		...spec.id ? { id: spec.id } : {},
		kind: spec.kind,
		...spec.label ? { label: spec.label } : {},
		...spec.bins ? { bins: spec.bins.slice() } : {},
		...spec.os ? { os: spec.os.slice() } : {},
		...spec.formula ? { formula: spec.formula } : {},
		...spec.package ? { package: spec.package } : {},
		...spec.module ? { module: spec.module } : {},
		...spec.url ? { url: spec.url } : {},
		...spec.archive ? { archive: spec.archive } : {},
		...spec.extract !== void 0 ? { extract: spec.extract } : {},
		...spec.stripComponents !== void 0 ? { stripComponents: spec.stripComponents } : {},
		...spec.targetDir ? { targetDir: spec.targetDir } : {}
	};
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
function resolveDefaultNodeInstallStateDir({ cwd = process.cwd(), getuid = process.getuid?.bind(process), homedir = os.homedir, platform = process.platform } = {}) {
	if (platform !== "win32" && getuid?.() === 0) return path.join(path.parse(cwd).root, "var", "lib", "openclaw");
	return path.join(homedir(), ".openclaw");
}
async function buildNodeInstallEnv(prefs) {
	if (prefs.nodeManager !== "npm") return {};
	const stateDir = getSkillsInstallDeps().resolveNodeInstallStateDir();
	const prefix = path.join(stateDir, "tools", "node", "npm");
	await fs.promises.mkdir(prefix, {
		recursive: true,
		mode: 448
	});
	return {
		NPM_CONFIG_PREFIX: prefix,
		npm_config_prefix: prefix
	};
}
const SAFE_BREW_FORMULA = /^[a-z0-9][a-z0-9+._@-]*(\/[a-z0-9][a-z0-9+._@-]*){0,2}$/;
const SAFE_NODE_PACKAGE = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[a-z0-9^~>=<.*|-]+)?$/;
const SAFE_GO_MODULE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*@[a-z0-9v._-]+$/;
const SAFE_UV_PACKAGE = /^[a-z0-9][a-z0-9._-]*(\[[a-z0-9,._-]+\])?(([><=!~]=?|===?)[a-z0-9.*_-]+)?$/i;
function assertSafeInstallerValue(value, kind, pattern) {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("-")) return `${kind} value is empty or starts with a dash`;
	if (!pattern.test(trimmed)) return `${kind} value contains invalid characters: ${trimmed}`;
	return null;
}
function buildInstallCommand(spec, prefs) {
	switch (spec.kind) {
		case "brew": {
			if (!spec.formula) return {
				argv: null,
				error: "missing brew formula"
			};
			const err = assertSafeInstallerValue(spec.formula, "brew formula", SAFE_BREW_FORMULA);
			if (err) return {
				argv: null,
				error: err
			};
			return { argv: [
				"brew",
				"install",
				spec.formula.trim()
			] };
		}
		case "node": {
			if (!spec.package) return {
				argv: null,
				error: "missing node package"
			};
			const err = assertSafeInstallerValue(spec.package, "node package", SAFE_NODE_PACKAGE);
			if (err) return {
				argv: null,
				error: err
			};
			return { argv: buildNodeInstallCommand(spec.package.trim(), prefs) };
		}
		case "go": {
			if (!spec.module) return {
				argv: null,
				error: "missing go module"
			};
			const err = assertSafeInstallerValue(spec.module, "go module", SAFE_GO_MODULE);
			if (err) return {
				argv: null,
				error: err
			};
			return { argv: [
				"go",
				"install",
				spec.module.trim()
			] };
		}
		case "uv": {
			if (!spec.package) return {
				argv: null,
				error: "missing uv package"
			};
			const err = assertSafeInstallerValue(spec.package, "uv package", SAFE_UV_PACKAGE);
			if (err) return {
				argv: null,
				error: err
			};
			return { argv: [
				"uv",
				"tool",
				"install",
				spec.package.trim()
			] };
		}
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
	const deps = getSkillsInstallDeps();
	const exe = brewExe ?? (deps.hasBinary("brew") ? "brew" : deps.resolveBrewExecutable());
	if (!exe) return;
	const prefixResult = await runCommandWithTimeout([exe, "--prefix"], { timeoutMs: Math.min(timeoutMs, 3e4) });
	if (prefixResult.code === 0) {
		const prefix = prefixResult.stdout.trim();
		if (prefix) return path.join(prefix, "bin");
	}
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
			stderr: formatErrorMessage(err)
		};
	}
}
async function runBestEffortCommand(argv, optionsOrTimeout) {
	await runCommandSafely(argv, optionsOrTimeout);
}
function resolveBrewMissingFailure(spec) {
	const formula = spec.formula ?? "this package";
	if (process.platform === "linux" && getSkillsInstallDeps().isContainerEnvironment()) return createInstallFailure({ message: `brew not installed — Homebrew is not installed in this Linux container. Build a custom image with Homebrew or install "${formula}" manually using a supported system package before enabling this skill.` });
	return createInstallFailure({ message: `brew not installed — ${process.platform === "linux" ? `Homebrew is not installed. Install it from https://brew.sh or install "${formula}" manually using your system package manager (e.g. apt, dnf, pacman).` : "Homebrew is not installed. Install it from https://brew.sh"}` });
}
async function ensureUvInstalled(params) {
	if (params.spec.kind !== "uv" || getSkillsInstallDeps().hasBinary("uv")) return;
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
	if (!getSkillsInstallDeps().hasBinary("sudo")) return createInstallFailure({ message: "go not installed — apt-get is available but sudo is not installed. Install manually: https://go.dev/doc/install" });
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
	if (params.spec.kind !== "go" || getSkillsInstallDeps().hasBinary("go")) return;
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
	if (getSkillsInstallDeps().hasBinary("apt-get")) return installGoViaApt(params.timeoutMs);
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
	const workspaceDir = resolveUserPath(params.workspaceDir);
	const deps = getSkillsInstallDeps();
	const entry = deps.loadWorkspaceSkillEntries(workspaceDir).find((item) => item.skill.name === params.skillName);
	if (!entry) return {
		ok: false,
		message: `Skill not found: ${params.skillName}`,
		stdout: "",
		stderr: "",
		code: null
	};
	const spec = findInstallSpec(entry, params.installId);
	const warnings = [];
	const skillSource = resolveSkillSource(entry.skill);
	const normalizedSpec = spec ? normalizeSkillInstallSpec(spec) : void 0;
	const scanResult = await scanSkillInstallSource({
		dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
		installId: params.installId,
		...normalizedSpec ? { installSpec: normalizedSpec } : {},
		logger: { warn: (message) => warnings.push(message) },
		origin: skillSource,
		skillName: params.skillName,
		sourceDir: path.resolve(entry.skill.baseDir)
	});
	if (scanResult?.blocked) return withWarnings({
		ok: false,
		message: scanResult.blocked.reason,
		stdout: "",
		stderr: "",
		code: null
	}, warnings);
	if (!new Set([
		"openclaw-bundled",
		"openclaw-managed",
		"openclaw-extra"
	]).has(skillSource)) warnings.push(`WARNING: Skill "${params.skillName}" install triggered from non-bundled source "${skillSource}". Verify the install recipe is trusted.`);
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
	const prefs = deps.resolveSkillsInstallPreferences(params.config);
	const command = buildInstallCommand(spec, prefs);
	if (command.error) return withWarnings({
		ok: false,
		message: command.error,
		stdout: "",
		stderr: "",
		code: null
	}, warnings);
	const brewExe = deps.hasBinary("brew") ? "brew" : deps.resolveBrewExecutable();
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
	const envOverrides = {};
	if (spec.kind === "node") Object.assign(envOverrides, await buildNodeInstallEnv(prefs));
	if (spec.kind === "go" && brewExe) {
		const brewBin = await resolveBrewBinDir(timeoutMs, brewExe);
		if (brewBin) envOverrides.GOBIN = brewBin;
	}
	return withWarnings(await executeInstallCommand({
		argv,
		timeoutMs,
		env: Object.keys(envOverrides).length > 0 ? envOverrides : void 0
	}), warnings);
}
//#endregion
export { installSkill as t };
