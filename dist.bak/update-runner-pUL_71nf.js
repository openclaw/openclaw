import { rt as pathExists } from "./entry.js";
import { t as runCommandWithTimeout } from "./exec-BhaMholX.js";
import { At as trimLogTail } from "./subagent-registry-BrzwRDvR.js";
import { n as resolveControlUiDistIndexHealth, r as resolveControlUiDistIndexPathForRoot } from "./control-ui-assets-D-OQDxpR.js";
import { d as channelToNpmTag, l as DEFAULT_PACKAGE_CHANNEL, m as isStableTag, p as isBetaTag, r as compareSemverStrings, s as detectPackageManager$1, u as DEV_BRANCH } from "./channel-account-context-CvN7490K.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

//#region src/infra/package-json.ts
async function readPackageVersion(root) {
	try {
		const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed?.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}
async function readPackageName(root) {
	try {
		const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
		const name = JSON.parse(raw)?.name?.trim();
		return name ? name : null;
	} catch {
		return null;
	}
}

//#endregion
//#region src/infra/update-global.ts
const PRIMARY_PACKAGE_NAME = "openclaw";
const ALL_PACKAGE_NAMES = [PRIMARY_PACKAGE_NAME];
const GLOBAL_RENAME_PREFIX = ".";
const NPM_GLOBAL_INSTALL_QUIET_FLAGS = [
	"--no-fund",
	"--no-audit",
	"--loglevel=error"
];
const NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS = ["--omit=optional", ...NPM_GLOBAL_INSTALL_QUIET_FLAGS];
async function tryRealpath(targetPath) {
	try {
		return await fs.realpath(targetPath);
	} catch {
		return path.resolve(targetPath);
	}
}
function resolveBunGlobalRoot() {
	const bunInstall = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
	return path.join(bunInstall, "install", "global", "node_modules");
}
async function resolveGlobalRoot(manager, runCommand, timeoutMs) {
	if (manager === "bun") return resolveBunGlobalRoot();
	const res = await runCommand(manager === "pnpm" ? [
		"pnpm",
		"root",
		"-g"
	] : [
		"npm",
		"root",
		"-g"
	], { timeoutMs }).catch(() => null);
	if (!res || res.code !== 0) return null;
	return res.stdout.trim() || null;
}
async function resolveGlobalPackageRoot(manager, runCommand, timeoutMs) {
	const root = await resolveGlobalRoot(manager, runCommand, timeoutMs);
	if (!root) return null;
	return path.join(root, PRIMARY_PACKAGE_NAME);
}
async function detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs) {
	const pkgReal = await tryRealpath(pkgRoot);
	for (const { manager, argv } of [{
		manager: "npm",
		argv: [
			"npm",
			"root",
			"-g"
		]
	}, {
		manager: "pnpm",
		argv: [
			"pnpm",
			"root",
			"-g"
		]
	}]) {
		const res = await runCommand(argv, { timeoutMs }).catch(() => null);
		if (!res || res.code !== 0) continue;
		const globalRoot = res.stdout.trim();
		if (!globalRoot) continue;
		const globalReal = await tryRealpath(globalRoot);
		for (const name of ALL_PACKAGE_NAMES) {
			const expectedReal = await tryRealpath(path.join(globalReal, name));
			if (path.resolve(expectedReal) === path.resolve(pkgReal)) return manager;
		}
	}
	const bunGlobalReal = await tryRealpath(resolveBunGlobalRoot());
	for (const name of ALL_PACKAGE_NAMES) {
		const bunExpectedReal = await tryRealpath(path.join(bunGlobalReal, name));
		if (path.resolve(bunExpectedReal) === path.resolve(pkgReal)) return "bun";
	}
	return null;
}
async function detectGlobalInstallManagerByPresence(runCommand, timeoutMs) {
	for (const manager of ["npm", "pnpm"]) {
		const root = await resolveGlobalRoot(manager, runCommand, timeoutMs);
		if (!root) continue;
		for (const name of ALL_PACKAGE_NAMES) if (await pathExists(path.join(root, name))) return manager;
	}
	const bunRoot = resolveBunGlobalRoot();
	for (const name of ALL_PACKAGE_NAMES) if (await pathExists(path.join(bunRoot, name))) return "bun";
	return null;
}
function globalInstallArgs(manager, spec) {
	if (manager === "pnpm") return [
		"pnpm",
		"add",
		"-g",
		spec
	];
	if (manager === "bun") return [
		"bun",
		"add",
		"-g",
		spec
	];
	return [
		"npm",
		"i",
		"-g",
		spec,
		...NPM_GLOBAL_INSTALL_QUIET_FLAGS
	];
}
function globalInstallFallbackArgs(manager, spec) {
	if (manager !== "npm") return null;
	return [
		"npm",
		"i",
		"-g",
		spec,
		...NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS
	];
}
async function cleanupGlobalRenameDirs(params) {
	const removed = [];
	const root = params.globalRoot.trim();
	const name = params.packageName.trim();
	if (!root || !name) return { removed };
	const prefix = `${GLOBAL_RENAME_PREFIX}${name}-`;
	let entries = [];
	try {
		entries = await fs.readdir(root);
	} catch {
		return { removed };
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const target = path.join(root, entry);
		try {
			if (!(await fs.lstat(target)).isDirectory()) continue;
			await fs.rm(target, {
				recursive: true,
				force: true
			});
			removed.push(entry);
		} catch {}
	}
	return { removed };
}

//#endregion
//#region src/infra/update-runner.ts
const DEFAULT_TIMEOUT_MS = 20 * 6e4;
const MAX_LOG_CHARS = 8e3;
const PREFLIGHT_MAX_COMMITS = 10;
const START_DIRS = [
	"cwd",
	"argv1",
	"process"
];
const DEFAULT_PACKAGE_NAME = "openclaw";
const CORE_PACKAGE_NAMES = new Set([DEFAULT_PACKAGE_NAME]);
function normalizeDir(value) {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return path.resolve(trimmed);
}
function resolveNodeModulesBinPackageRoot(argv1) {
	const normalized = path.resolve(argv1);
	const parts = normalized.split(path.sep);
	const binIndex = parts.lastIndexOf(".bin");
	if (binIndex <= 0) return null;
	if (parts[binIndex - 1] !== "node_modules") return null;
	const binName = path.basename(normalized);
	const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
	return path.join(nodeModulesDir, binName);
}
function buildStartDirs(opts) {
	const dirs = [];
	const cwd = normalizeDir(opts.cwd);
	if (cwd) dirs.push(cwd);
	const argv1 = normalizeDir(opts.argv1);
	if (argv1) {
		dirs.push(path.dirname(argv1));
		const packageRoot = resolveNodeModulesBinPackageRoot(argv1);
		if (packageRoot) dirs.push(packageRoot);
	}
	const proc = normalizeDir(process.cwd());
	if (proc) dirs.push(proc);
	return Array.from(new Set(dirs));
}
async function readBranchName(runCommand, root, timeoutMs) {
	const res = await runCommand([
		"git",
		"-C",
		root,
		"rev-parse",
		"--abbrev-ref",
		"HEAD"
	], { timeoutMs }).catch(() => null);
	if (!res || res.code !== 0) return null;
	return res.stdout.trim() || null;
}
async function listGitTags(runCommand, root, timeoutMs, pattern = "v*") {
	const res = await runCommand([
		"git",
		"-C",
		root,
		"tag",
		"--list",
		pattern,
		"--sort=-v:refname"
	], { timeoutMs }).catch(() => null);
	if (!res || res.code !== 0) return [];
	return res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}
async function resolveChannelTag(runCommand, root, timeoutMs, channel) {
	const tags = await listGitTags(runCommand, root, timeoutMs);
	if (channel === "beta") {
		const betaTag = tags.find((tag) => isBetaTag(tag)) ?? null;
		const stableTag = tags.find((tag) => isStableTag(tag)) ?? null;
		if (!betaTag) return stableTag;
		if (!stableTag) return betaTag;
		const cmp = compareSemverStrings(betaTag, stableTag);
		if (cmp != null && cmp < 0) return stableTag;
		return betaTag;
	}
	return tags.find((tag) => isStableTag(tag)) ?? null;
}
async function resolveGitRoot(runCommand, candidates, timeoutMs) {
	for (const dir of candidates) {
		const res = await runCommand([
			"git",
			"-C",
			dir,
			"rev-parse",
			"--show-toplevel"
		], { timeoutMs });
		if (res.code === 0) {
			const root = res.stdout.trim();
			if (root) return root;
		}
	}
	return null;
}
async function findPackageRoot(candidates) {
	for (const dir of candidates) {
		let current = dir;
		for (let i = 0; i < 12; i += 1) {
			const pkgPath = path.join(current, "package.json");
			try {
				const raw = await fs.readFile(pkgPath, "utf-8");
				const name = JSON.parse(raw)?.name?.trim();
				if (name && CORE_PACKAGE_NAMES.has(name)) return current;
			} catch {}
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	return null;
}
async function detectPackageManager(root) {
	return await detectPackageManager$1(root) ?? "npm";
}
async function runStep(opts) {
	const { runCommand, name, argv, cwd, timeoutMs, env, progress, stepIndex, totalSteps } = opts;
	const command = argv.join(" ");
	const stepInfo = {
		name,
		command,
		index: stepIndex,
		total: totalSteps
	};
	progress?.onStepStart?.(stepInfo);
	const started = Date.now();
	const result = await runCommand(argv, {
		cwd,
		timeoutMs,
		env
	});
	const durationMs = Date.now() - started;
	const stderrTail = trimLogTail(result.stderr, MAX_LOG_CHARS);
	progress?.onStepComplete?.({
		...stepInfo,
		durationMs,
		exitCode: result.code,
		stderrTail
	});
	return {
		name,
		command,
		cwd,
		durationMs,
		exitCode: result.code,
		stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
		stderrTail: trimLogTail(result.stderr, MAX_LOG_CHARS)
	};
}
function managerScriptArgs(manager, script, args = []) {
	if (manager === "pnpm") return [
		"pnpm",
		script,
		...args
	];
	if (manager === "bun") return [
		"bun",
		"run",
		script,
		...args
	];
	if (args.length > 0) return [
		"npm",
		"run",
		script,
		"--",
		...args
	];
	return [
		"npm",
		"run",
		script
	];
}
function managerInstallArgs(manager) {
	if (manager === "pnpm") return ["pnpm", "install"];
	if (manager === "bun") return ["bun", "install"];
	return ["npm", "install"];
}
function normalizeTag(tag) {
	const trimmed = tag?.trim();
	if (!trimmed) return "latest";
	if (trimmed.startsWith("openclaw@")) return trimmed.slice(9);
	if (trimmed.startsWith(`${DEFAULT_PACKAGE_NAME}@`)) return trimmed.slice(`${DEFAULT_PACKAGE_NAME}@`.length);
	return trimmed;
}
async function runGatewayUpdate(opts = {}) {
	const startedAt = Date.now();
	const runCommand = opts.runCommand ?? (async (argv, options) => {
		const res = await runCommandWithTimeout(argv, options);
		return {
			stdout: res.stdout,
			stderr: res.stderr,
			code: res.code
		};
	});
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const progress = opts.progress;
	const steps = [];
	const candidates = buildStartDirs(opts);
	let stepIndex = 0;
	let gitTotalSteps = 0;
	const step = (name, argv, cwd, env) => {
		const currentIndex = stepIndex;
		stepIndex += 1;
		return {
			runCommand,
			name,
			argv,
			cwd,
			timeoutMs,
			env,
			progress,
			stepIndex: currentIndex,
			totalSteps: gitTotalSteps
		};
	};
	const pkgRoot = await findPackageRoot(candidates);
	let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs);
	if (gitRoot && pkgRoot && path.resolve(gitRoot) !== path.resolve(pkgRoot)) gitRoot = null;
	if (gitRoot && !pkgRoot) return {
		status: "error",
		mode: "unknown",
		root: gitRoot,
		reason: "not-openclaw-root",
		steps: [],
		durationMs: Date.now() - startedAt
	};
	if (gitRoot && pkgRoot && path.resolve(gitRoot) === path.resolve(pkgRoot)) {
		const beforeSha = (await runCommand([
			"git",
			"-C",
			gitRoot,
			"rev-parse",
			"HEAD"
		], {
			cwd: gitRoot,
			timeoutMs
		})).stdout.trim() || null;
		const beforeVersion = await readPackageVersion(gitRoot);
		const channel = opts.channel ?? "dev";
		const branch = channel === "dev" ? await readBranchName(runCommand, gitRoot, timeoutMs) : null;
		const needsCheckoutMain = channel === "dev" && branch !== DEV_BRANCH;
		gitTotalSteps = channel === "dev" ? needsCheckoutMain ? 11 : 10 : 9;
		const buildGitErrorResult = (reason) => ({
			status: "error",
			mode: "git",
			root: gitRoot,
			reason,
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		});
		const runGitCheckoutOrFail = async (name, argv) => {
			const checkoutStep = await runStep(step(name, argv, gitRoot));
			steps.push(checkoutStep);
			if (checkoutStep.exitCode !== 0) return buildGitErrorResult("checkout-failed");
			return null;
		};
		const statusCheck = await runStep(step("clean check", [
			"git",
			"-C",
			gitRoot,
			"status",
			"--porcelain",
			"--",
			":!dist/control-ui/"
		], gitRoot));
		steps.push(statusCheck);
		if (statusCheck.stdoutTail && statusCheck.stdoutTail.trim().length > 0) return {
			status: "skipped",
			mode: "git",
			root: gitRoot,
			reason: "dirty",
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		};
		if (channel === "dev") {
			if (needsCheckoutMain) {
				const failure = await runGitCheckoutOrFail(`git checkout ${DEV_BRANCH}`, [
					"git",
					"-C",
					gitRoot,
					"checkout",
					DEV_BRANCH
				]);
				if (failure) return failure;
			}
			const upstreamStep = await runStep(step("upstream check", [
				"git",
				"-C",
				gitRoot,
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{upstream}"
			], gitRoot));
			steps.push(upstreamStep);
			if (upstreamStep.exitCode !== 0) return {
				status: "skipped",
				mode: "git",
				root: gitRoot,
				reason: "no-upstream",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
			const fetchStep = await runStep(step("git fetch", [
				"git",
				"-C",
				gitRoot,
				"fetch",
				"--all",
				"--prune",
				"--tags"
			], gitRoot));
			steps.push(fetchStep);
			const upstreamShaStep = await runStep(step("git rev-parse @{upstream}", [
				"git",
				"-C",
				gitRoot,
				"rev-parse",
				"@{upstream}"
			], gitRoot));
			steps.push(upstreamShaStep);
			const upstreamSha = upstreamShaStep.stdoutTail?.trim();
			if (!upstreamShaStep.stdoutTail || !upstreamSha) return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "no-upstream-sha",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
			const revListStep = await runStep(step("git rev-list", [
				"git",
				"-C",
				gitRoot,
				"rev-list",
				`--max-count=${PREFLIGHT_MAX_COMMITS}`,
				upstreamSha
			], gitRoot));
			steps.push(revListStep);
			if (revListStep.exitCode !== 0) return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "preflight-revlist-failed",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
			const candidates = (revListStep.stdoutTail ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
			if (candidates.length === 0) return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "preflight-no-candidates",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
			const manager = await detectPackageManager(gitRoot);
			const preflightRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-preflight-"));
			const worktreeDir = path.join(preflightRoot, "worktree");
			const worktreeStep = await runStep(step("preflight worktree", [
				"git",
				"-C",
				gitRoot,
				"worktree",
				"add",
				"--detach",
				worktreeDir,
				upstreamSha
			], gitRoot));
			steps.push(worktreeStep);
			if (worktreeStep.exitCode !== 0) {
				await fs.rm(preflightRoot, {
					recursive: true,
					force: true
				}).catch(() => {});
				return {
					status: "error",
					mode: "git",
					root: gitRoot,
					reason: "preflight-worktree-failed",
					before: {
						sha: beforeSha,
						version: beforeVersion
					},
					steps,
					durationMs: Date.now() - startedAt
				};
			}
			let selectedSha = null;
			try {
				for (const sha of candidates) {
					const shortSha = sha.slice(0, 8);
					const checkoutStep = await runStep(step(`preflight checkout (${shortSha})`, [
						"git",
						"-C",
						worktreeDir,
						"checkout",
						"--detach",
						sha
					], worktreeDir));
					steps.push(checkoutStep);
					if (checkoutStep.exitCode !== 0) continue;
					const depsStep = await runStep(step(`preflight deps install (${shortSha})`, managerInstallArgs(manager), worktreeDir));
					steps.push(depsStep);
					if (depsStep.exitCode !== 0) continue;
					const buildStep = await runStep(step(`preflight build (${shortSha})`, managerScriptArgs(manager, "build"), worktreeDir));
					steps.push(buildStep);
					if (buildStep.exitCode !== 0) continue;
					const lintStep = await runStep(step(`preflight lint (${shortSha})`, managerScriptArgs(manager, "lint"), worktreeDir));
					steps.push(lintStep);
					if (lintStep.exitCode !== 0) continue;
					selectedSha = sha;
					break;
				}
			} finally {
				const removeStep = await runStep(step("preflight cleanup", [
					"git",
					"-C",
					gitRoot,
					"worktree",
					"remove",
					"--force",
					worktreeDir
				], gitRoot));
				steps.push(removeStep);
				await runCommand([
					"git",
					"-C",
					gitRoot,
					"worktree",
					"prune"
				], {
					cwd: gitRoot,
					timeoutMs
				}).catch(() => null);
				await fs.rm(preflightRoot, {
					recursive: true,
					force: true
				}).catch(() => {});
			}
			if (!selectedSha) return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "preflight-no-good-commit",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
			const rebaseStep = await runStep(step("git rebase", [
				"git",
				"-C",
				gitRoot,
				"rebase",
				selectedSha
			], gitRoot));
			steps.push(rebaseStep);
			if (rebaseStep.exitCode !== 0) {
				const abortResult = await runCommand([
					"git",
					"-C",
					gitRoot,
					"rebase",
					"--abort"
				], {
					cwd: gitRoot,
					timeoutMs
				});
				steps.push({
					name: "git rebase --abort",
					command: "git rebase --abort",
					cwd: gitRoot,
					durationMs: 0,
					exitCode: abortResult.code,
					stdoutTail: trimLogTail(abortResult.stdout, MAX_LOG_CHARS),
					stderrTail: trimLogTail(abortResult.stderr, MAX_LOG_CHARS)
				});
				return {
					status: "error",
					mode: "git",
					root: gitRoot,
					reason: "rebase-failed",
					before: {
						sha: beforeSha,
						version: beforeVersion
					},
					steps,
					durationMs: Date.now() - startedAt
				};
			}
		} else {
			const fetchStep = await runStep(step("git fetch", [
				"git",
				"-C",
				gitRoot,
				"fetch",
				"--all",
				"--prune",
				"--tags"
			], gitRoot));
			steps.push(fetchStep);
			if (fetchStep.exitCode !== 0) return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "fetch-failed",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
			const tag = await resolveChannelTag(runCommand, gitRoot, timeoutMs, channel);
			if (!tag) return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "no-release-tag",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
			const failure = await runGitCheckoutOrFail(`git checkout ${tag}`, [
				"git",
				"-C",
				gitRoot,
				"checkout",
				"--detach",
				tag
			]);
			if (failure) return failure;
		}
		const manager = await detectPackageManager(gitRoot);
		const depsStep = await runStep(step("deps install", managerInstallArgs(manager), gitRoot));
		steps.push(depsStep);
		if (depsStep.exitCode !== 0) return {
			status: "error",
			mode: "git",
			root: gitRoot,
			reason: "deps-install-failed",
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		};
		const buildStep = await runStep(step("build", managerScriptArgs(manager, "build"), gitRoot));
		steps.push(buildStep);
		if (buildStep.exitCode !== 0) return {
			status: "error",
			mode: "git",
			root: gitRoot,
			reason: "build-failed",
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		};
		const uiBuildStep = await runStep(step("ui:build", managerScriptArgs(manager, "ui:build"), gitRoot));
		steps.push(uiBuildStep);
		if (uiBuildStep.exitCode !== 0) return {
			status: "error",
			mode: "git",
			root: gitRoot,
			reason: "ui-build-failed",
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		};
		const doctorEntry = path.join(gitRoot, "openclaw.mjs");
		if (!await fs.stat(doctorEntry).then(() => true).catch(() => false)) {
			steps.push({
				name: "openclaw doctor entry",
				command: `verify ${doctorEntry}`,
				cwd: gitRoot,
				durationMs: 0,
				exitCode: 1,
				stderrTail: `missing ${doctorEntry}`
			});
			return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "doctor-entry-missing",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
		}
		const doctorStep = await runStep(step("openclaw doctor", [
			process.execPath,
			doctorEntry,
			"doctor",
			"--non-interactive",
			"--fix"
		], gitRoot, { OPENCLAW_UPDATE_IN_PROGRESS: "1" }));
		steps.push(doctorStep);
		if (!(await resolveControlUiDistIndexHealth({ root: gitRoot })).exists) {
			const repairArgv = managerScriptArgs(manager, "ui:build");
			const started = Date.now();
			const repairResult = await runCommand(repairArgv, {
				cwd: gitRoot,
				timeoutMs
			});
			const repairStep = {
				name: "ui:build (post-doctor repair)",
				command: repairArgv.join(" "),
				cwd: gitRoot,
				durationMs: Date.now() - started,
				exitCode: repairResult.code,
				stdoutTail: trimLogTail(repairResult.stdout, MAX_LOG_CHARS),
				stderrTail: trimLogTail(repairResult.stderr, MAX_LOG_CHARS)
			};
			steps.push(repairStep);
			if (repairResult.code !== 0) return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: repairStep.name,
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
			const repairedUiIndexHealth = await resolveControlUiDistIndexHealth({ root: gitRoot });
			if (!repairedUiIndexHealth.exists) {
				const uiIndexPath = repairedUiIndexHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(gitRoot);
				steps.push({
					name: "ui assets verify",
					command: `verify ${uiIndexPath}`,
					cwd: gitRoot,
					durationMs: 0,
					exitCode: 1,
					stderrTail: `missing ${uiIndexPath}`
				});
				return {
					status: "error",
					mode: "git",
					root: gitRoot,
					reason: "ui-assets-missing",
					before: {
						sha: beforeSha,
						version: beforeVersion
					},
					steps,
					durationMs: Date.now() - startedAt
				};
			}
		}
		const failedStep = steps.find((s) => s.exitCode !== 0);
		const afterShaStep = await runStep(step("git rev-parse HEAD (after)", [
			"git",
			"-C",
			gitRoot,
			"rev-parse",
			"HEAD"
		], gitRoot));
		steps.push(afterShaStep);
		const afterVersion = await readPackageVersion(gitRoot);
		return {
			status: failedStep ? "error" : "ok",
			mode: "git",
			root: gitRoot,
			reason: failedStep ? failedStep.name : void 0,
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			after: {
				sha: afterShaStep.stdoutTail?.trim() ?? null,
				version: afterVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		};
	}
	if (!pkgRoot) return {
		status: "error",
		mode: "unknown",
		reason: `no root (${START_DIRS.join(",")})`,
		steps: [],
		durationMs: Date.now() - startedAt
	};
	const beforeVersion = await readPackageVersion(pkgRoot);
	const globalManager = await detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs);
	if (globalManager) {
		const packageName = await readPackageName(pkgRoot) ?? DEFAULT_PACKAGE_NAME;
		await cleanupGlobalRenameDirs({
			globalRoot: path.dirname(pkgRoot),
			packageName
		});
		const channel = opts.channel ?? DEFAULT_PACKAGE_CHANNEL;
		const spec = `${packageName}@${normalizeTag(opts.tag ?? channelToNpmTag(channel))}`;
		const steps = [];
		const updateStep = await runStep({
			runCommand,
			name: "global update",
			argv: globalInstallArgs(globalManager, spec),
			cwd: pkgRoot,
			timeoutMs,
			progress,
			stepIndex: 0,
			totalSteps: 1
		});
		steps.push(updateStep);
		let finalStep = updateStep;
		if (updateStep.exitCode !== 0) {
			const fallbackArgv = globalInstallFallbackArgs(globalManager, spec);
			if (fallbackArgv) {
				const fallbackStep = await runStep({
					runCommand,
					name: "global update (omit optional)",
					argv: fallbackArgv,
					cwd: pkgRoot,
					timeoutMs,
					progress,
					stepIndex: 0,
					totalSteps: 1
				});
				steps.push(fallbackStep);
				finalStep = fallbackStep;
			}
		}
		const afterVersion = await readPackageVersion(pkgRoot);
		return {
			status: finalStep.exitCode === 0 ? "ok" : "error",
			mode: globalManager,
			root: pkgRoot,
			reason: finalStep.exitCode === 0 ? void 0 : finalStep.name,
			before: { version: beforeVersion },
			after: { version: afterVersion },
			steps,
			durationMs: Date.now() - startedAt
		};
	}
	return {
		status: "skipped",
		mode: "unknown",
		root: pkgRoot,
		reason: "not-git-install",
		before: { version: beforeVersion },
		steps: [],
		durationMs: Date.now() - startedAt
	};
}

//#endregion
export { globalInstallArgs as a, readPackageVersion as c, detectGlobalInstallManagerForRoot as i, cleanupGlobalRenameDirs as n, resolveGlobalPackageRoot as o, detectGlobalInstallManagerByPresence as r, readPackageName as s, runGatewayUpdate as t };