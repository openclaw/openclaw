import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import "./fs-safe-defaults-B7hUN42l.js";
import { a as guardedRm, r as guardedRename } from "./write-queue-C9nceBqy.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { i as resolveDefaultPluginGitDir } from "./install-paths-B32RY-Gz.js";
import "./replace-file-C7_Inj8B.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { s as withTempDir } from "./install-source-utils-BA9AHTyU.js";
import { o as redactSensitiveUrlLikeString } from "./redact-sensitive-url-NNYIE41N.js";
import { n as createSafeNpmInstallEnv, t as createSafeNpmInstallArgs } from "./safe-package-install-CZ0VYBja.js";
import { r as installPluginFromInstalledPackageDir } from "./install-BG7jqqYt.js";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
//#region node_modules/@openclaw/fs-safe/dist/replace-directory.js
async function replaceDirectoryAtomic(options) {
	const targetDir = path.resolve(options.targetDir);
	const stagedDir = path.resolve(options.stagedDir);
	const parentDir = path.dirname(targetDir);
	const backupDir = path.join(parentDir, `${options.backupPrefix ?? ".fs-safe-dir-backup-"}${process.pid}-${Date.now()}`);
	let backupCreated = false;
	await fs.mkdir(parentDir, { recursive: true });
	try {
		await guardedRename({
			from: targetDir,
			to: backupDir
		});
		backupCreated = true;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	try {
		await guardedRename({
			from: stagedDir,
			to: targetDir
		});
	} catch (err) {
		if (backupCreated) {
			await guardedRename({
				from: backupDir,
				to: targetDir
			}).catch(() => void 0);
			backupCreated = false;
		}
		throw err;
	}
	if (backupCreated) await guardedRm({
		target: backupDir,
		recursive: true,
		force: true,
		verifyAfter: false
	});
}
//#endregion
//#region src/plugins/git-install.ts
const GIT_SPEC_PREFIX = "git:";
const DEFAULT_GIT_TIMEOUT_MS = 12e4;
function splitGitSpecRef(input) {
	const hashIndex = input.lastIndexOf("#");
	if (hashIndex > 0) return {
		base: input.slice(0, hashIndex),
		ref: normalizeOptionalString(input.slice(hashIndex + 1))
	};
	for (let atIndex = input.lastIndexOf("@"); atIndex > 0; atIndex = input.lastIndexOf("@", atIndex - 1)) {
		const base = input.slice(0, atIndex);
		const ref = normalizeOptionalString(input.slice(atIndex + 1));
		if (ref && isGitSpecBase(base)) return {
			base,
			ref
		};
	}
	return { base: input };
}
function isGitSpecBase(value) {
	return looksLikeGitHubRepoShorthand(value) || looksLikeGitHubHostPath(value) || looksLikeUrlGitSpecBase(value) || looksLikeScpGitUrl(value) || value.endsWith(".git") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/");
}
function looksLikeGitHubRepoShorthand(value) {
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value);
}
function looksLikeGitHubHostPath(value) {
	return /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(value);
}
function isHttpUrl(value) {
	return /^https?:\/\//i.test(value);
}
function isGitUrl(value) {
	return /^(?:ssh|git|file):\/\//i.test(value) || looksLikeScpGitUrl(value) || value.endsWith(".git");
}
function looksLikeScpGitUrl(value) {
	return /^[^@\s]+@[^:\s]+:.+/.test(value);
}
function looksLikeUrlGitSpecBase(value) {
	try {
		const url = new URL(value);
		if (![
			"http:",
			"https:",
			"ssh:",
			"git:",
			"file:"
		].includes(url.protocol)) return false;
		if (url.protocol === "file:") return url.pathname.length > 1;
		return Boolean(url.hostname) && url.pathname.length > 1;
	} catch {
		return false;
	}
}
function stripGitSuffix(value) {
	return value.replace(/\.git$/i, "");
}
function normalizeGitHubRepo(value) {
	const repo = stripGitSuffix(value.replace(/^github\.com\//i, ""));
	return {
		url: `https://github.com/${repo}.git`,
		label: repo
	};
}
function normalizeGitLabel(value) {
	if (isHttpUrl(value) || /^(?:ssh|git|file):\/\//i.test(value)) try {
		const url = new URL(value);
		return stripGitSuffix(`${url.hostname}${url.pathname}`).replace(/^\/+/, "");
	} catch {
		return stripGitSuffix(value);
	}
	return stripGitSuffix(value);
}
function parseGitPluginSpec(raw) {
	const trimmed = raw.trim();
	if (!trimmed.toLowerCase().startsWith(GIT_SPEC_PREFIX)) return null;
	const body = trimmed.slice(4).trim();
	if (!body) return null;
	const split = splitGitSpecRef(body);
	const base = split.base.trim();
	if (!base) return null;
	if (looksLikeGitHubRepoShorthand(base) || looksLikeGitHubHostPath(base)) {
		const normalized = normalizeGitHubRepo(base);
		return {
			input: trimmed,
			url: normalized.url,
			ref: split.ref,
			label: normalized.label,
			normalizedSpec: `${GIT_SPEC_PREFIX}${normalized.url}${split.ref ? `@${split.ref}` : ""}`
		};
	}
	if (isHttpUrl(base) || isGitUrl(base) || base.startsWith("./") || base.startsWith("../") || base.startsWith("~/")) {
		const url = base.startsWith("./") || base.startsWith("../") || base.startsWith("~/") ? resolveUserPath(base) : base;
		return {
			input: trimmed,
			url,
			ref: split.ref,
			label: normalizeGitLabel(url),
			normalizedSpec: `${GIT_SPEC_PREFIX}${url}${split.ref ? `@${split.ref}` : ""}`
		};
	}
	return null;
}
function createGitCommandEnv() {
	return {
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TEMPLATE_DIR: "",
		GIT_EDITOR: "",
		GIT_SEQUENCE_EDITOR: "",
		GIT_EXTERNAL_DIFF: "",
		GIT_DIR: void 0,
		GIT_WORK_TREE: void 0,
		GIT_COMMON_DIR: void 0,
		GIT_INDEX_FILE: void 0,
		GIT_OBJECT_DIRECTORY: void 0,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: void 0,
		GIT_NAMESPACE: void 0,
		GIT_EXEC_PATH: void 0,
		GIT_SSL_NO_VERIFY: void 0
	};
}
function resolveGitInstallRepoDir(params) {
	const gitRoot = params.gitDir ? resolveUserPath(params.gitDir) : resolveDefaultPluginGitDir();
	const redactedSpec = redactSensitiveUrlLikeString(params.source.normalizedSpec);
	const hash = createHash("sha256").update(redactedSpec).digest("hex").slice(0, 16);
	return path.join(gitRoot, `git-${hash}`, "repo");
}
async function replaceManagedGitRepo(params) {
	try {
		await replaceDirectoryAtomic({
			stagedDir: params.stagedRepoDir,
			targetDir: params.persistentRepoDir,
			backupPrefix: ".repo-backup-"
		});
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: `failed to replace managed git plugin repository: ${String(err)}`
		};
	}
}
function formatGitCommandFailure(params) {
	const detail = sanitizeForLog(redactSensitiveUrlLikeString(params.stderr.trim() || params.stdout.trim() || "git failed"));
	return `failed to ${params.action} ${sanitizeForLog(redactSensitiveUrlLikeString(params.source.label))}: ${detail}`;
}
async function runGitCommand(params) {
	const result = await runCommandWithTimeout(params.argv, {
		cwd: params.cwd,
		timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
		env: createGitCommandEnv()
	});
	if (result.code !== 0) return {
		ok: false,
		error: formatGitCommandFailure({
			action: params.action,
			source: params.source,
			stdout: result.stdout,
			stderr: result.stderr
		})
	};
	return {
		ok: true,
		stdout: result.stdout
	};
}
async function installPluginFromGitSpec(params) {
	const parsed = parseGitPluginSpec(params.spec);
	if (!parsed) return {
		ok: false,
		error: `unsupported git: plugin spec: ${params.spec}`
	};
	const persistentRepoDir = resolveGitInstallRepoDir({
		gitDir: params.gitDir,
		source: parsed
	});
	return await withTempDir("openclaw-git-plugin-", async (tmpDir) => {
		const repoDir = path.join(tmpDir, "repo");
		params.logger?.info?.(`Cloning ${sanitizeForLog(redactSensitiveUrlLikeString(parsed.label))}...`);
		const clone = await runGitCommand({
			argv: parsed.ref ? [
				"git",
				"clone",
				parsed.url,
				repoDir
			] : [
				"git",
				"clone",
				"--depth",
				"1",
				parsed.url,
				repoDir
			],
			action: "clone",
			source: parsed,
			timeoutMs: params.timeoutMs
		});
		if (!clone.ok) return clone;
		if (parsed.ref) {
			const checkout = await runGitCommand({
				argv: [
					"git",
					"switch",
					"--detach",
					"--",
					parsed.ref
				],
				action: `checkout ${parsed.ref}`,
				source: parsed,
				cwd: repoDir,
				timeoutMs: params.timeoutMs
			});
			if (!checkout.ok) return checkout;
		}
		const rev = await runGitCommand({
			argv: [
				"git",
				"rev-parse",
				"HEAD"
			],
			action: "resolve commit for",
			source: parsed,
			cwd: repoDir,
			timeoutMs: params.timeoutMs
		});
		if (!rev.ok) return rev;
		if (!params.dryRun) {
			params.logger?.info?.("Installing plugin dependencies with npm…");
			const install = await runCommandWithTimeout(["npm", ...createSafeNpmInstallArgs({
				omitDev: true,
				loglevel: "error",
				noAudit: true,
				noFund: true
			})], {
				cwd: repoDir,
				timeoutMs: Math.max(params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, 3e5),
				env: createSafeNpmInstallEnv(process.env, {
					npmConfigCwd: repoDir,
					packageLock: true,
					quiet: true
				})
			});
			if (install.code !== 0) return {
				ok: false,
				error: `npm install failed: ${install.stderr.trim() || install.stdout.trim()}`
			};
		}
		const result = await installPluginFromInstalledPackageDir({
			dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
			packageDir: repoDir,
			dryRun: params.dryRun,
			expectedPluginId: params.expectedPluginId,
			logger: params.logger,
			mode: params.mode,
			installPolicyRequest: {
				kind: "plugin-git",
				requestedSpecifier: parsed.input
			}
		});
		if (!result.ok) return result;
		if (!params.dryRun) {
			const replaceResult = await replaceManagedGitRepo({
				stagedRepoDir: repoDir,
				persistentRepoDir
			});
			if (!replaceResult.ok) return replaceResult;
		}
		return {
			...result,
			targetDir: params.dryRun ? result.targetDir : persistentRepoDir,
			git: {
				url: parsed.url,
				ref: parsed.ref,
				commit: normalizeOptionalString(rev.stdout),
				resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
			}
		};
	});
}
//#endregion
export { parseGitPluginSpec as n, installPluginFromGitSpec as t };
