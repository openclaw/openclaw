import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme } from "./theme-CL08MjAq.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import { C as shortenHomePath, b as resolveUserPath, d as init_utils, t as CONFIG_DIR } from "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { Jb as writeConfigFile, Lu as fileExists, Ru as readJsonFile, zb as loadConfig, zu as resolveArchiveKind } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import { n as MANIFEST_KEY } from "./legacy-names-mMNqIp4j.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import { d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId } from "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import { g as validateRegistryNpmSpec } from "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import { B as promptYesNo } from "./config-DZ3oWznn.js";
import { n as isPathInside, r as isPathInsideWithRealpath } from "./scan-paths-Zo6qyBUS.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-BGZZcqHp.js";
import { a as unscopedPackageName, n as resolveSafeInstallDir } from "./install-safe-path-BmwD_9Ds.js";
import { a as parseFrontmatter, t as loadWorkspaceHookEntries } from "./workspace-BlrRoKxE.js";
import { t as buildWorkspaceHookStatus } from "./hooks-status-D5XisCkZ.js";
import { a as resolveInstallModeOptions, c as installFromNpmSpecArchiveWithInstaller, f as resolveArchiveSourcePath, i as installPackageDirWithManifestDeps, l as resolveExistingInstallPath, n as resolveCanonicalInstallTarget, o as resolveTimedInstallModeOptions, r as installPackageDir, s as finalizeNpmSpecArchiveInstall, t as ensureInstallTargetAvailable, u as withExtractedArchiveRoot } from "./install-target-RUKPUVdS.js";
import { i as buildPluginStatusReport, n as resolvePinnedNpmInstallRecordForCli, r as looksLikeLocalInstallSpec, t as buildNpmInstallRecordFields } from "./npm-resolution-BZVmqUov.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region src/infra/install-from-npm-spec.ts
async function installFromValidatedNpmSpecArchive(params) {
	const spec = params.spec.trim();
	const specError = validateRegistryNpmSpec(spec);
	if (specError) return {
		ok: false,
		error: specError
	};
	return finalizeNpmSpecArchiveInstall(await installFromNpmSpecArchiveWithInstaller({
		tempDirPrefix: params.tempDirPrefix,
		spec,
		timeoutMs: params.timeoutMs,
		expectedIntegrity: params.expectedIntegrity,
		onIntegrityDrift: params.onIntegrityDrift,
		warn: params.warn,
		installFromArchive: params.installFromArchive,
		archiveInstallParams: params.archiveInstallParams
	}));
}
//#endregion
//#region src/hooks/install.ts
init_utils();
const defaultLogger = {};
function buildHookInstallForwardParams(params) {
	return {
		hooksDir: params.hooksDir,
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedHookPackId: params.expectedHookPackId
	};
}
function validateHookId(hookId) {
	if (!hookId) return "invalid hook name: missing";
	if (hookId === "." || hookId === "..") return "invalid hook name: reserved path segment";
	if (hookId.includes("/") || hookId.includes("\\")) return "invalid hook name: path separators not allowed";
	return null;
}
function resolveHookInstallDir(hookId, hooksDir) {
	const hooksBase = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
	const hookIdError = validateHookId(hookId);
	if (hookIdError) throw new Error(hookIdError);
	const targetDirResult = resolveSafeInstallDir({
		baseDir: hooksBase,
		id: hookId,
		invalidNameMessage: "invalid hook name: path traversal detected"
	});
	if (!targetDirResult.ok) throw new Error(targetDirResult.error);
	return targetDirResult.path;
}
async function ensureOpenClawHooks(manifest) {
	const hooks = manifest[MANIFEST_KEY]?.hooks;
	if (!Array.isArray(hooks)) throw new Error("package.json missing openclaw.hooks");
	const list = hooks.map((e) => typeof e === "string" ? e.trim() : "").filter(Boolean);
	if (list.length === 0) throw new Error("package.json openclaw.hooks is empty");
	return list;
}
async function resolveInstallTargetDir(id, hooksDir) {
	return await resolveCanonicalInstallTarget({
		baseDir: hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks"),
		id,
		invalidNameMessage: "invalid hook name: path traversal detected",
		boundaryLabel: "hooks directory"
	});
}
async function resolveAvailableHookInstallTarget(params) {
	const targetDirResult = await resolveInstallTargetDir(params.id, params.hooksDir);
	if (!targetDirResult.ok) return targetDirResult;
	const targetDir = targetDirResult.targetDir;
	const availability = await ensureInstallTargetAvailable({
		mode: params.mode,
		targetDir,
		alreadyExistsError: params.alreadyExistsError(targetDir)
	});
	if (!availability.ok) return availability;
	return {
		ok: true,
		targetDir
	};
}
async function installFromResolvedHookDir(resolvedDir, params) {
	if (await fileExists(path.join(resolvedDir, "package.json"))) return await installHookPackageFromDir({
		packageDir: resolvedDir,
		hooksDir: params.hooksDir,
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedHookPackId: params.expectedHookPackId
	});
	return await installHookFromDir({
		hookDir: resolvedDir,
		hooksDir: params.hooksDir,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedHookPackId: params.expectedHookPackId
	});
}
async function resolveHookNameFromDir(hookDir) {
	const hookMdPath = path.join(hookDir, "HOOK.md");
	if (!await fileExists(hookMdPath)) throw new Error(`HOOK.md missing in ${hookDir}`);
	return parseFrontmatter(await fs$1.readFile(hookMdPath, "utf-8")).name || path.basename(hookDir);
}
async function validateHookDir(hookDir) {
	if (!await fileExists(path.join(hookDir, "HOOK.md"))) throw new Error(`HOOK.md missing in ${hookDir}`);
	if (!await Promise.all([
		"handler.ts",
		"handler.js",
		"index.ts",
		"index.js"
	].map(async (candidate) => fileExists(path.join(hookDir, candidate)))).then((results) => results.some(Boolean))) throw new Error(`handler.ts/handler.js/index.ts/index.js missing in ${hookDir}`);
}
async function installHookPackageFromDir(params) {
	const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);
	const manifestPath = path.join(params.packageDir, "package.json");
	if (!await fileExists(manifestPath)) return {
		ok: false,
		error: "package.json missing"
	};
	let manifest;
	try {
		manifest = await readJsonFile(manifestPath);
	} catch (err) {
		return {
			ok: false,
			error: `invalid package.json: ${String(err)}`
		};
	}
	let hookEntries;
	try {
		hookEntries = await ensureOpenClawHooks(manifest);
	} catch (err) {
		return {
			ok: false,
			error: String(err)
		};
	}
	const pkgName = typeof manifest.name === "string" ? manifest.name : "";
	const hookPackId = pkgName ? unscopedPackageName(pkgName) : path.basename(params.packageDir);
	const hookIdError = validateHookId(hookPackId);
	if (hookIdError) return {
		ok: false,
		error: hookIdError
	};
	if (params.expectedHookPackId && params.expectedHookPackId !== hookPackId) return {
		ok: false,
		error: `hook pack id mismatch: expected ${params.expectedHookPackId}, got ${hookPackId}`
	};
	const target = await resolveAvailableHookInstallTarget({
		id: hookPackId,
		hooksDir: params.hooksDir,
		mode,
		alreadyExistsError: (targetDir) => `hook pack already exists: ${targetDir} (delete it first)`
	});
	if (!target.ok) return target;
	const targetDir = target.targetDir;
	const resolvedHooks = [];
	for (const entry of hookEntries) {
		const hookDir = path.resolve(params.packageDir, entry);
		if (!isPathInside(params.packageDir, hookDir)) return {
			ok: false,
			error: `openclaw.hooks entry escapes package directory: ${entry}`
		};
		await validateHookDir(hookDir);
		if (!isPathInsideWithRealpath(params.packageDir, hookDir, { requireRealpath: true })) return {
			ok: false,
			error: `openclaw.hooks entry resolves outside package directory: ${entry}`
		};
		const hookName = await resolveHookNameFromDir(hookDir);
		resolvedHooks.push(hookName);
	}
	if (dryRun) return {
		ok: true,
		hookPackId,
		hooks: resolvedHooks,
		targetDir,
		version: typeof manifest.version === "string" ? manifest.version : void 0
	};
	const installRes = await installPackageDirWithManifestDeps({
		sourceDir: params.packageDir,
		targetDir,
		mode,
		timeoutMs,
		logger,
		copyErrorPrefix: "failed to copy hook pack",
		depsLogMessage: "Installing hook pack dependencies…",
		manifestDependencies: manifest.dependencies
	});
	if (!installRes.ok) return installRes;
	return {
		ok: true,
		hookPackId,
		hooks: resolvedHooks,
		targetDir,
		version: typeof manifest.version === "string" ? manifest.version : void 0
	};
}
async function installHookFromDir(params) {
	const { logger, mode, dryRun } = resolveInstallModeOptions(params, defaultLogger);
	await validateHookDir(params.hookDir);
	const hookName = await resolveHookNameFromDir(params.hookDir);
	const hookIdError = validateHookId(hookName);
	if (hookIdError) return {
		ok: false,
		error: hookIdError
	};
	if (params.expectedHookPackId && params.expectedHookPackId !== hookName) return {
		ok: false,
		error: `hook id mismatch: expected ${params.expectedHookPackId}, got ${hookName}`
	};
	const target = await resolveAvailableHookInstallTarget({
		id: hookName,
		hooksDir: params.hooksDir,
		mode,
		alreadyExistsError: (targetDir) => `hook already exists: ${targetDir} (delete it first)`
	});
	if (!target.ok) return target;
	const targetDir = target.targetDir;
	if (dryRun) return {
		ok: true,
		hookPackId: hookName,
		hooks: [hookName],
		targetDir
	};
	const installRes = await installPackageDir({
		sourceDir: params.hookDir,
		targetDir,
		mode,
		timeoutMs: 12e4,
		logger,
		copyErrorPrefix: "failed to copy hook",
		hasDeps: false,
		depsLogMessage: "Installing hook dependencies…"
	});
	if (!installRes.ok) return installRes;
	return {
		ok: true,
		hookPackId: hookName,
		hooks: [hookName],
		targetDir
	};
}
async function installHooksFromArchive(params) {
	const logger = params.logger ?? defaultLogger;
	const timeoutMs = params.timeoutMs ?? 12e4;
	const archivePathResult = await resolveArchiveSourcePath(params.archivePath);
	if (!archivePathResult.ok) return archivePathResult;
	const archivePath = archivePathResult.path;
	return await withExtractedArchiveRoot({
		archivePath,
		tempDirPrefix: "openclaw-hook-",
		timeoutMs,
		logger,
		onExtracted: async (rootDir) => await installFromResolvedHookDir(rootDir, buildHookInstallForwardParams({
			hooksDir: params.hooksDir,
			timeoutMs,
			logger,
			mode: params.mode,
			dryRun: params.dryRun,
			expectedHookPackId: params.expectedHookPackId
		}))
	});
}
async function installHooksFromNpmSpec(params) {
	const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);
	const expectedHookPackId = params.expectedHookPackId;
	const spec = params.spec;
	logger.info?.(`Downloading ${spec.trim()}…`);
	return await installFromValidatedNpmSpecArchive({
		tempDirPrefix: "openclaw-hook-pack-",
		spec,
		timeoutMs,
		expectedIntegrity: params.expectedIntegrity,
		onIntegrityDrift: params.onIntegrityDrift,
		warn: (message) => {
			logger.warn?.(message);
		},
		installFromArchive: installHooksFromArchive,
		archiveInstallParams: buildHookInstallForwardParams({
			hooksDir: params.hooksDir,
			timeoutMs,
			logger,
			mode,
			dryRun,
			expectedHookPackId
		})
	});
}
async function installHooksFromPath(params) {
	const pathResult = await resolveExistingInstallPath(params.path);
	if (!pathResult.ok) return pathResult;
	const { resolvedPath: resolved, stat } = pathResult;
	const forwardParams = buildHookInstallForwardParams({
		hooksDir: params.hooksDir,
		timeoutMs: params.timeoutMs,
		logger: params.logger,
		mode: params.mode,
		dryRun: params.dryRun,
		expectedHookPackId: params.expectedHookPackId
	});
	if (stat.isDirectory()) return await installFromResolvedHookDir(resolved, forwardParams);
	if (!resolveArchiveKind(resolved)) return {
		ok: false,
		error: `unsupported hook file: ${resolved}`
	};
	return await installHooksFromArchive({
		archivePath: resolved,
		...forwardParams
	});
}
//#endregion
//#region src/hooks/installs.ts
function recordHookInstall(cfg, update) {
	const { hookId, ...record } = update;
	const installs = {
		...cfg.hooks?.internal?.installs,
		[hookId]: {
			...cfg.hooks?.internal?.installs?.[hookId],
			...record,
			installedAt: record.installedAt ?? (/* @__PURE__ */ new Date()).toISOString()
		}
	};
	return {
		...cfg,
		hooks: {
			...cfg.hooks,
			internal: {
				...cfg.hooks?.internal,
				installs: {
					...installs,
					[hookId]: installs[hookId]
				}
			}
		}
	};
}
//#endregion
//#region src/cli/hooks-cli.ts
init_runtime();
init_theme();
init_utils();
function mergeHookEntries(pluginEntries, workspaceEntries) {
	const merged = /* @__PURE__ */ new Map();
	for (const entry of pluginEntries) merged.set(entry.hook.name, entry);
	for (const entry of workspaceEntries) merged.set(entry.hook.name, entry);
	return Array.from(merged.values());
}
function buildHooksReport(config) {
	const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
	const workspaceEntries = loadWorkspaceHookEntries(workspaceDir, { config });
	return buildWorkspaceHookStatus(workspaceDir, {
		config,
		entries: mergeHookEntries(buildPluginStatusReport({
			config,
			workspaceDir
		}).hooks.map((hook) => hook.entry), workspaceEntries)
	});
}
function resolveHookForToggle(report, hookName, opts) {
	const hook = report.hooks.find((h) => h.name === hookName);
	if (!hook) throw new Error(`Hook "${hookName}" not found`);
	if (hook.managedByPlugin) throw new Error(`Hook "${hookName}" is managed by plugin "${hook.pluginId ?? "unknown"}" and cannot be enabled/disabled.`);
	if (opts?.requireEligible && !hook.eligible) throw new Error(`Hook "${hookName}" is not eligible (missing requirements)`);
	return hook;
}
function buildConfigWithHookEnabled(params) {
	const entries = { ...params.config.hooks?.internal?.entries };
	entries[params.hookName] = {
		...entries[params.hookName],
		enabled: params.enabled
	};
	const internal = {
		...params.config.hooks?.internal,
		...params.ensureHooksEnabled ? { enabled: true } : {},
		entries
	};
	return {
		...params.config,
		hooks: {
			...params.config.hooks,
			internal
		}
	};
}
function formatHookStatus(hook) {
	if (hook.eligible) return theme.success("✓ ready");
	if (hook.disabled) return theme.warn("⏸ disabled");
	return theme.error("✗ missing");
}
function formatHookName(hook) {
	return `${hook.emoji ?? "🔗"} ${theme.command(hook.name)}`;
}
function formatHookSource(hook) {
	if (!hook.managedByPlugin) return hook.source;
	return `plugin:${hook.pluginId ?? "unknown"}`;
}
function formatHookMissingSummary(hook) {
	const missing = [];
	if (hook.missing.bins.length > 0) missing.push(`bins: ${hook.missing.bins.join(", ")}`);
	if (hook.missing.anyBins.length > 0) missing.push(`anyBins: ${hook.missing.anyBins.join(", ")}`);
	if (hook.missing.env.length > 0) missing.push(`env: ${hook.missing.env.join(", ")}`);
	if (hook.missing.config.length > 0) missing.push(`config: ${hook.missing.config.join(", ")}`);
	if (hook.missing.os.length > 0) missing.push(`os: ${hook.missing.os.join(", ")}`);
	return missing.join("; ");
}
function exitHooksCliWithError(err) {
	defaultRuntime.error(`${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
async function runHooksCliAction(action) {
	try {
		await action();
	} catch (err) {
		exitHooksCliWithError(err);
	}
}
function createInstallLogger() {
	return {
		info: (msg) => defaultRuntime.log(msg),
		warn: (msg) => defaultRuntime.log(theme.warn(msg))
	};
}
function logGatewayRestartHint() {
	defaultRuntime.log("Restart the gateway to load hooks.");
}
function logIntegrityDriftWarning(hookId, drift) {
	const specLabel = drift.resolution.resolvedSpec ?? drift.spec;
	defaultRuntime.log(theme.warn(`Integrity drift detected for "${hookId}" (${specLabel})\nExpected: ${drift.expectedIntegrity}\nActual:   ${drift.actualIntegrity}`));
}
async function readInstalledPackageVersion(dir) {
	try {
		const raw = await fs$1.readFile(path.join(dir, "package.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.version === "string" ? parsed.version : void 0;
	} catch {
		return;
	}
}
function enableInternalHookEntries(config, hookNames) {
	const entries = { ...config.hooks?.internal?.entries };
	for (const hookName of hookNames) entries[hookName] = {
		...entries[hookName],
		enabled: true
	};
	return {
		...config,
		hooks: {
			...config.hooks,
			internal: {
				...config.hooks?.internal,
				enabled: true,
				entries
			}
		}
	};
}
/**
* Format the hooks list output
*/
function formatHooksList(report, opts) {
	const hooks = opts.eligible ? report.hooks.filter((h) => h.eligible) : report.hooks;
	if (opts.json) {
		const jsonReport = {
			workspaceDir: report.workspaceDir,
			managedHooksDir: report.managedHooksDir,
			hooks: hooks.map((h) => ({
				name: h.name,
				description: h.description,
				emoji: h.emoji,
				eligible: h.eligible,
				disabled: h.disabled,
				source: h.source,
				pluginId: h.pluginId,
				events: h.events,
				homepage: h.homepage,
				missing: h.missing,
				managedByPlugin: h.managedByPlugin
			}))
		};
		return JSON.stringify(jsonReport, null, 2);
	}
	if (hooks.length === 0) return opts.eligible ? `No eligible hooks found. Run \`${formatCliCommand("openclaw hooks list")}\` to see all hooks.` : "No hooks found.";
	const eligible = hooks.filter((h) => h.eligible);
	const tableWidth = getTerminalTableWidth();
	const rows = hooks.map((hook) => {
		const missing = formatHookMissingSummary(hook);
		return {
			Status: formatHookStatus(hook),
			Hook: formatHookName(hook),
			Description: theme.muted(hook.description),
			Source: formatHookSource(hook),
			Missing: missing ? theme.warn(missing) : ""
		};
	});
	const columns = [
		{
			key: "Status",
			header: "Status",
			minWidth: 10
		},
		{
			key: "Hook",
			header: "Hook",
			minWidth: 18,
			flex: true
		},
		{
			key: "Description",
			header: "Description",
			minWidth: 24,
			flex: true
		},
		{
			key: "Source",
			header: "Source",
			minWidth: 12,
			flex: true
		}
	];
	if (opts.verbose) columns.push({
		key: "Missing",
		header: "Missing",
		minWidth: 18,
		flex: true
	});
	const lines = [];
	lines.push(`${theme.heading("Hooks")} ${theme.muted(`(${eligible.length}/${hooks.length} ready)`)}`);
	lines.push(renderTable({
		width: tableWidth,
		columns,
		rows
	}).trimEnd());
	return lines.join("\n");
}
/**
* Format detailed info for a single hook
*/
function formatHookInfo(report, hookName, opts) {
	const hook = report.hooks.find((h) => h.name === hookName || h.hookKey === hookName);
	if (!hook) {
		if (opts.json) return JSON.stringify({
			error: "not found",
			hook: hookName
		}, null, 2);
		return `Hook "${hookName}" not found. Run \`${formatCliCommand("openclaw hooks list")}\` to see available hooks.`;
	}
	if (opts.json) return JSON.stringify(hook, null, 2);
	const lines = [];
	const emoji = hook.emoji ?? "🔗";
	const status = hook.eligible ? theme.success("✓ Ready") : hook.disabled ? theme.warn("⏸ Disabled") : theme.error("✗ Missing requirements");
	lines.push(`${emoji} ${theme.heading(hook.name)} ${status}`);
	lines.push("");
	lines.push(hook.description);
	lines.push("");
	lines.push(theme.heading("Details:"));
	if (hook.managedByPlugin) lines.push(`${theme.muted("  Source:")} ${hook.source} (${hook.pluginId ?? "unknown"})`);
	else lines.push(`${theme.muted("  Source:")} ${hook.source}`);
	lines.push(`${theme.muted("  Path:")} ${shortenHomePath(hook.filePath)}`);
	lines.push(`${theme.muted("  Handler:")} ${shortenHomePath(hook.handlerPath)}`);
	if (hook.homepage) lines.push(`${theme.muted("  Homepage:")} ${hook.homepage}`);
	if (hook.events.length > 0) lines.push(`${theme.muted("  Events:")} ${hook.events.join(", ")}`);
	if (hook.managedByPlugin) lines.push(theme.muted("  Managed by plugin; enable/disable via hooks CLI not available."));
	if (hook.requirements.bins.length > 0 || hook.requirements.anyBins.length > 0 || hook.requirements.env.length > 0 || hook.requirements.config.length > 0 || hook.requirements.os.length > 0) {
		lines.push("");
		lines.push(theme.heading("Requirements:"));
		if (hook.requirements.bins.length > 0) {
			const binsStatus = hook.requirements.bins.map((bin) => {
				return hook.missing.bins.includes(bin) ? theme.error(`✗ ${bin}`) : theme.success(`✓ ${bin}`);
			});
			lines.push(`${theme.muted("  Binaries:")} ${binsStatus.join(", ")}`);
		}
		if (hook.requirements.anyBins.length > 0) {
			const anyBinsStatus = hook.missing.anyBins.length > 0 ? theme.error(`✗ (any of: ${hook.requirements.anyBins.join(", ")})`) : theme.success(`✓ (any of: ${hook.requirements.anyBins.join(", ")})`);
			lines.push(`${theme.muted("  Any binary:")} ${anyBinsStatus}`);
		}
		if (hook.requirements.env.length > 0) {
			const envStatus = hook.requirements.env.map((env) => {
				return hook.missing.env.includes(env) ? theme.error(`✗ ${env}`) : theme.success(`✓ ${env}`);
			});
			lines.push(`${theme.muted("  Environment:")} ${envStatus.join(", ")}`);
		}
		if (hook.requirements.config.length > 0) {
			const configStatus = hook.configChecks.map((check) => {
				return check.satisfied ? theme.success(`✓ ${check.path}`) : theme.error(`✗ ${check.path}`);
			});
			lines.push(`${theme.muted("  Config:")} ${configStatus.join(", ")}`);
		}
		if (hook.requirements.os.length > 0) {
			const osStatus = hook.missing.os.length > 0 ? theme.error(`✗ (${hook.requirements.os.join(", ")})`) : theme.success(`✓ (${hook.requirements.os.join(", ")})`);
			lines.push(`${theme.muted("  OS:")} ${osStatus}`);
		}
	}
	return lines.join("\n");
}
/**
* Format check output
*/
function formatHooksCheck(report, opts) {
	if (opts.json) {
		const eligible = report.hooks.filter((h) => h.eligible);
		const notEligible = report.hooks.filter((h) => !h.eligible);
		return JSON.stringify({
			total: report.hooks.length,
			eligible: eligible.length,
			notEligible: notEligible.length,
			hooks: {
				eligible: eligible.map((h) => h.name),
				notEligible: notEligible.map((h) => ({
					name: h.name,
					missing: h.missing
				}))
			}
		}, null, 2);
	}
	const eligible = report.hooks.filter((h) => h.eligible);
	const notEligible = report.hooks.filter((h) => !h.eligible);
	const lines = [];
	lines.push(theme.heading("Hooks Status"));
	lines.push("");
	lines.push(`${theme.muted("Total hooks:")} ${report.hooks.length}`);
	lines.push(`${theme.success("Ready:")} ${eligible.length}`);
	lines.push(`${theme.warn("Not ready:")} ${notEligible.length}`);
	if (notEligible.length > 0) {
		lines.push("");
		lines.push(theme.heading("Hooks not ready:"));
		for (const hook of notEligible) {
			const reasons = [];
			if (hook.disabled) reasons.push("disabled");
			if (hook.missing.bins.length > 0) reasons.push(`bins: ${hook.missing.bins.join(", ")}`);
			if (hook.missing.anyBins.length > 0) reasons.push(`anyBins: ${hook.missing.anyBins.join(", ")}`);
			if (hook.missing.env.length > 0) reasons.push(`env: ${hook.missing.env.join(", ")}`);
			if (hook.missing.config.length > 0) reasons.push(`config: ${hook.missing.config.join(", ")}`);
			if (hook.missing.os.length > 0) reasons.push(`os: ${hook.missing.os.join(", ")}`);
			lines.push(`  ${hook.emoji ?? "🔗"} ${hook.name} - ${reasons.join("; ")}`);
		}
	}
	return lines.join("\n");
}
async function enableHook(hookName) {
	const config = loadConfig();
	const hook = resolveHookForToggle(buildHooksReport(config), hookName, { requireEligible: true });
	await writeConfigFile(buildConfigWithHookEnabled({
		config,
		hookName,
		enabled: true,
		ensureHooksEnabled: true
	}));
	defaultRuntime.log(`${theme.success("✓")} Enabled hook: ${hook.emoji ?? "🔗"} ${theme.command(hookName)}`);
}
async function disableHook(hookName) {
	const config = loadConfig();
	const hook = resolveHookForToggle(buildHooksReport(config), hookName);
	await writeConfigFile(buildConfigWithHookEnabled({
		config,
		hookName,
		enabled: false
	}));
	defaultRuntime.log(`${theme.warn("⏸")} Disabled hook: ${hook.emoji ?? "🔗"} ${theme.command(hookName)}`);
}
function registerHooksCli(program) {
	const hooks = program.command("hooks").description("Manage internal agent hooks").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/hooks", "docs.openclaw.ai/cli/hooks")}\n`);
	hooks.command("list").description("List all hooks").option("--eligible", "Show only eligible hooks", false).option("--json", "Output as JSON", false).option("-v, --verbose", "Show more details including missing requirements", false).action(async (opts) => runHooksCliAction(async () => {
		const report = buildHooksReport(loadConfig());
		defaultRuntime.log(formatHooksList(report, opts));
	}));
	hooks.command("info <name>").description("Show detailed information about a hook").option("--json", "Output as JSON", false).action(async (name, opts) => runHooksCliAction(async () => {
		const report = buildHooksReport(loadConfig());
		defaultRuntime.log(formatHookInfo(report, name, opts));
	}));
	hooks.command("check").description("Check hooks eligibility status").option("--json", "Output as JSON", false).action(async (opts) => runHooksCliAction(async () => {
		const report = buildHooksReport(loadConfig());
		defaultRuntime.log(formatHooksCheck(report, opts));
	}));
	hooks.command("enable <name>").description("Enable a hook").action(async (name) => runHooksCliAction(async () => {
		await enableHook(name);
	}));
	hooks.command("disable <name>").description("Disable a hook").action(async (name) => runHooksCliAction(async () => {
		await disableHook(name);
	}));
	hooks.command("install").description("Install a hook pack (path, archive, or npm spec)").argument("<path-or-spec>", "Path to a hook pack or npm package spec").option("-l, --link", "Link a local path instead of copying", false).option("--pin", "Record npm installs as exact resolved <name>@<version>", false).action(async (raw, opts) => {
		const resolved = resolveUserPath(raw);
		const cfg = loadConfig();
		if (fs.existsSync(resolved)) {
			if (opts.link) {
				if (!fs.statSync(resolved).isDirectory()) {
					defaultRuntime.error("Linked hook paths must be directories.");
					process.exit(1);
				}
				const existing = cfg.hooks?.internal?.load?.extraDirs ?? [];
				const merged = Array.from(new Set([...existing, resolved]));
				const probe = await installHooksFromPath({
					path: resolved,
					dryRun: true
				});
				if (!probe.ok) {
					defaultRuntime.error(probe.error);
					process.exit(1);
				}
				let next = {
					...cfg,
					hooks: {
						...cfg.hooks,
						internal: {
							...cfg.hooks?.internal,
							enabled: true,
							load: {
								...cfg.hooks?.internal?.load,
								extraDirs: merged
							}
						}
					}
				};
				next = enableInternalHookEntries(next, probe.hooks);
				next = recordHookInstall(next, {
					hookId: probe.hookPackId,
					source: "path",
					sourcePath: resolved,
					installPath: resolved,
					version: probe.version,
					hooks: probe.hooks
				});
				await writeConfigFile(next);
				defaultRuntime.log(`Linked hook path: ${shortenHomePath(resolved)}`);
				logGatewayRestartHint();
				return;
			}
			const result = await installHooksFromPath({
				path: resolved,
				logger: createInstallLogger()
			});
			if (!result.ok) {
				defaultRuntime.error(result.error);
				process.exit(1);
			}
			let next = enableInternalHookEntries(cfg, result.hooks);
			const source = resolveArchiveKind(resolved) ? "archive" : "path";
			next = recordHookInstall(next, {
				hookId: result.hookPackId,
				source,
				sourcePath: resolved,
				installPath: result.targetDir,
				version: result.version,
				hooks: result.hooks
			});
			await writeConfigFile(next);
			defaultRuntime.log(`Installed hooks: ${result.hooks.join(", ")}`);
			logGatewayRestartHint();
			return;
		}
		if (opts.link) {
			defaultRuntime.error("`--link` requires a local path.");
			process.exit(1);
		}
		if (looksLikeLocalInstallSpec(raw, [
			".zip",
			".tgz",
			".tar.gz",
			".tar"
		])) {
			defaultRuntime.error(`Path not found: ${resolved}`);
			process.exit(1);
		}
		const result = await installHooksFromNpmSpec({
			spec: raw,
			logger: createInstallLogger()
		});
		if (!result.ok) {
			defaultRuntime.error(result.error);
			process.exit(1);
		}
		let next = enableInternalHookEntries(cfg, result.hooks);
		const installRecord = resolvePinnedNpmInstallRecordForCli(raw, Boolean(opts.pin), result.targetDir, result.version, result.npmResolution, defaultRuntime.log, theme.warn);
		next = recordHookInstall(next, {
			hookId: result.hookPackId,
			...installRecord,
			hooks: result.hooks
		});
		await writeConfigFile(next);
		defaultRuntime.log(`Installed hooks: ${result.hooks.join(", ")}`);
		logGatewayRestartHint();
	});
	hooks.command("update").description("Update installed hooks (npm installs only)").argument("[id]", "Hook pack id (omit with --all)").option("--all", "Update all tracked hooks", false).option("--dry-run", "Show what would change without writing", false).action(async (id, opts) => {
		const cfg = loadConfig();
		const installs = cfg.hooks?.internal?.installs ?? {};
		const targets = opts.all ? Object.keys(installs) : id ? [id] : [];
		if (targets.length === 0) {
			defaultRuntime.error("Provide a hook id or use --all.");
			process.exit(1);
		}
		let nextCfg = cfg;
		let updatedCount = 0;
		for (const hookId of targets) {
			const record = installs[hookId];
			if (!record) {
				defaultRuntime.log(theme.warn(`No install record for "${hookId}".`));
				continue;
			}
			if (record.source !== "npm") {
				defaultRuntime.log(theme.warn(`Skipping "${hookId}" (source: ${record.source}).`));
				continue;
			}
			if (!record.spec) {
				defaultRuntime.log(theme.warn(`Skipping "${hookId}" (missing npm spec).`));
				continue;
			}
			let installPath;
			try {
				installPath = record.installPath ?? resolveHookInstallDir(hookId);
			} catch (err) {
				defaultRuntime.log(theme.error(`Invalid install path for "${hookId}": ${String(err)}`));
				continue;
			}
			const currentVersion = await readInstalledPackageVersion(installPath);
			if (opts.dryRun) {
				const probe = await installHooksFromNpmSpec({
					spec: record.spec,
					mode: "update",
					dryRun: true,
					expectedHookPackId: hookId,
					expectedIntegrity: record.integrity,
					onIntegrityDrift: async (drift) => {
						logIntegrityDriftWarning(hookId, drift);
						return true;
					},
					logger: createInstallLogger()
				});
				if (!probe.ok) {
					defaultRuntime.log(theme.error(`Failed to check ${hookId}: ${probe.error}`));
					continue;
				}
				const nextVersion = probe.version ?? "unknown";
				const currentLabel = currentVersion ?? "unknown";
				if (currentVersion && probe.version && currentVersion === probe.version) defaultRuntime.log(`${hookId} is up to date (${currentLabel}).`);
				else defaultRuntime.log(`Would update ${hookId}: ${currentLabel} → ${nextVersion}.`);
				continue;
			}
			const result = await installHooksFromNpmSpec({
				spec: record.spec,
				mode: "update",
				expectedHookPackId: hookId,
				expectedIntegrity: record.integrity,
				onIntegrityDrift: async (drift) => {
					logIntegrityDriftWarning(hookId, drift);
					return await promptYesNo(`Continue updating "${hookId}" with this artifact?`);
				},
				logger: createInstallLogger()
			});
			if (!result.ok) {
				defaultRuntime.log(theme.error(`Failed to update ${hookId}: ${result.error}`));
				continue;
			}
			const nextVersion = result.version ?? await readInstalledPackageVersion(result.targetDir);
			nextCfg = recordHookInstall(nextCfg, {
				hookId,
				...buildNpmInstallRecordFields({
					spec: record.spec,
					installPath: result.targetDir,
					version: nextVersion,
					resolution: result.npmResolution
				}),
				hooks: result.hooks
			});
			updatedCount += 1;
			const currentLabel = currentVersion ?? "unknown";
			const nextLabel = nextVersion ?? "unknown";
			if (currentVersion && nextVersion && currentVersion === nextVersion) defaultRuntime.log(`${hookId} already at ${currentLabel}.`);
			else defaultRuntime.log(`Updated ${hookId}: ${currentLabel} → ${nextLabel}.`);
		}
		if (updatedCount > 0) {
			await writeConfigFile(nextCfg);
			logGatewayRestartHint();
		}
	});
	hooks.action(async () => runHooksCliAction(async () => {
		const report = buildHooksReport(loadConfig());
		defaultRuntime.log(formatHooksList(report, {}));
	}));
}
//#endregion
export { registerHooksCli };
