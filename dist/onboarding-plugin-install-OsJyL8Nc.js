import { u as withTimeout } from "./fs-safe-CV86zY9G.js";
import { c as isRecord, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { r as resolveDefaultPluginExtensionsDir } from "./install-paths-B32RY-Gz.js";
import { t as parseClawHubPluginSpec } from "./clawhub-spec-J_MJr4Sl.js";
import { i as isOpenClawOrgNpmSpec, s as parseRegistryNpmSpec } from "./npm-registry-spec-BwaWslDm.js";
import { n as recordPluginInstall, t as buildNpmResolutionInstallFields } from "./installs-j3Id-apF.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { n as assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard-CW_6fgTB.js";
import { t as enablePluginInConfig } from "./enable-DL58ncJE.js";
import "./with-timeout-Dq1jBUaR.js";
import { n as t } from "./i18n-CWNhN747.js";
import { i as resolveBundledPluginSources, n as findBundledPluginSourceInMap } from "./bundled-sources-Bb5DSmIr.js";
import { a as installPluginFromNpmSpec, i as installPluginFromNpmPackArchive } from "./install-BG7jqqYt.js";
import { n as resolveBundledInstallPlanForCatalogEntry } from "./plugin-install-plan-DDY2BScO.js";
import { t as CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-CFGNynZy.js";
import { l as resolveRegistryUpdateChannel, s as normalizeUpdateChannel } from "./update-channels-f-ieRme5.js";
import { t as buildClawHubPluginInstallRecordFields } from "./clawhub-install-records-Dv-7kghM.js";
import { n as resolveNpmInstallSpecsForUpdateChannel, t as resolveClawHubInstallSpecsForUpdateChannel } from "./install-channel-specs-BOF5k8F8.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/install-overrides.ts
const PLUGIN_INSTALL_OVERRIDES_ENV = "OPENCLAW_PLUGIN_INSTALL_OVERRIDES";
const ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV = "OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES";
function overrideAllowed(env) {
	return env[ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV]?.trim() === "1";
}
function parseOverrideSpec(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("npm:")) {
		const spec = trimmed.slice(4).trim();
		return spec && parseRegistryNpmSpec(spec) ? {
			kind: "npm",
			spec
		} : null;
	}
	if (trimmed.startsWith("npm-pack:")) {
		const rawPath = trimmed.slice(9).trim();
		if (!rawPath) return null;
		return {
			kind: "npm-pack",
			archivePath: path.resolve(resolveUserPath(rawPath))
		};
	}
	return null;
}
function resolvePluginInstallOverride(params) {
	const env = params.env ?? process.env;
	if (!overrideAllowed(env)) return null;
	const raw = env[PLUGIN_INSTALL_OVERRIDES_ENV]?.trim();
	if (!raw) return null;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const value = parsed[params.pluginId];
	return typeof value === "string" ? parseOverrideSpec(value) : null;
}
//#endregion
//#region src/commands/onboarding-plugin-install.ts
const ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS = 300 * 1e3;
const ONBOARDING_PLUGIN_INSTALL_WATCHDOG_TIMEOUT_MS = 305e3;
function shouldFallbackClawHubToNpm(params) {
	if (!isOpenClawOrgNpmSpec(params.npmSpec)) return false;
	return params.result.code === CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND || params.result.code === CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND || params.result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE || params.result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE;
}
function resolveRealDirectory(dir) {
	try {
		const resolved = fs.realpathSync(dir);
		return fs.statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}
function resolveGitDirectoryMarker(dir) {
	const marker = path.join(dir, ".git");
	try {
		const stat = fs.statSync(marker);
		if (stat.isDirectory()) return resolveRealDirectory(marker);
		if (!stat.isFile()) return null;
		const content = fs.readFileSync(marker, "utf8").trim();
		const match = /^gitdir:\s*(.+)$/i.exec(content);
		if (!match) return null;
		const gitDir = match[1]?.trim();
		if (!gitDir) return null;
		return resolveRealDirectory(path.isAbsolute(gitDir) ? gitDir : path.resolve(dir, gitDir));
	} catch {
		return null;
	}
}
function isWithinBaseDirectory(baseDir, targetPath) {
	const relative = path.relative(baseDir, targetPath);
	return relative === "" || !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}
function hasTrustedGitWorkspace(root) {
	const realRoot = resolveRealDirectory(root);
	if (!realRoot) return false;
	for (let dir = realRoot;; dir = path.dirname(dir)) {
		if (resolveGitDirectoryMarker(dir)) return true;
		if (path.dirname(dir) === dir) return false;
	}
}
function hasGitWorkspace(workspaceDir) {
	const roots = [process.cwd()];
	if (workspaceDir && workspaceDir !== process.cwd()) roots.push(workspaceDir);
	return roots.some((root) => hasTrustedGitWorkspace(root));
}
function addPluginLoadPath(cfg, pluginPath) {
	const existing = cfg.plugins?.load?.paths ?? [];
	const merged = Array.from(new Set([...existing, pluginPath]));
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			load: {
				...cfg.plugins?.load,
				paths: merged
			}
		}
	};
}
function pathsReferToSameDirectory(left, right) {
	if (!left || !right) return false;
	const realLeft = resolveRealDirectory(left);
	const realRight = resolveRealDirectory(right);
	return Boolean(realLeft && realRight && realLeft === realRight);
}
function formatPortableLocalPath(localPath, workspaceDir) {
	const bases = [workspaceDir, process.cwd()].filter((entry) => Boolean(entry));
	for (const base of bases) {
		const realBase = resolveRealDirectory(base);
		if (!realBase) continue;
		const relative = path.relative(realBase, localPath);
		if (relative === "" || !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..") {
			const portable = relative.split(path.sep).join("/");
			return portable ? `./${portable}` : ".";
		}
	}
}
async function recordLocalPluginInstall(params) {
	const sourcePath = formatPortableLocalPath(params.localPath, params.workspaceDir);
	const install = {
		pluginId: params.entry.pluginId,
		source: "path",
		...sourcePath ? { sourcePath } : {},
		...params.npmSpec ? { spec: params.npmSpec } : {}
	};
	return recordPluginInstall(params.cfg, install);
}
function resolveLocalPath(params) {
	if (!params.allowLocal) return null;
	const raw = params.entry.install.localPath?.trim();
	if (!raw) return null;
	const candidates = /* @__PURE__ */ new Set();
	const bases = [process.cwd()];
	if (params.workspaceDir && params.workspaceDir !== process.cwd()) bases.push(params.workspaceDir);
	for (const base of bases) {
		const realBase = resolveRealDirectory(base);
		if (!realBase) continue;
		candidates.add(path.resolve(realBase, raw));
	}
	for (const candidate of candidates) try {
		const resolved = fs.realpathSync(candidate);
		if (!bases.some((base) => {
			const realBase = resolveRealDirectory(base);
			return realBase ? isWithinBaseDirectory(realBase, resolved) : false;
		})) continue;
		if (fs.statSync(resolved).isDirectory()) return resolved;
	} catch {
		continue;
	}
	return null;
}
function resolveBundledLocalPath(params) {
	const bundledSources = resolveBundledPluginSources({ workspaceDir: params.workspaceDir });
	const npmSpec = params.entry.install.npmSpec?.trim();
	if (npmSpec) return resolveBundledInstallPlanForCatalogEntry({
		pluginId: params.entry.pluginId,
		npmSpec,
		findBundledSource: (lookup) => findBundledPluginSourceInMap({
			bundled: bundledSources,
			lookup
		})
	})?.bundledSource.localPath ?? null;
	return findBundledPluginSourceInMap({
		bundled: bundledSources,
		lookup: {
			kind: "pluginId",
			value: params.entry.pluginId
		}
	})?.localPath ?? null;
}
function resolveNpmSpecForOnboarding(install) {
	const npmSpec = install.npmSpec?.trim();
	if (!npmSpec) return null;
	return parseRegistryNpmSpec(npmSpec) ? npmSpec : null;
}
function resolveClawHubSpecForOnboarding(install) {
	const clawhubSpec = install.clawhubSpec?.trim();
	if (!clawhubSpec) return null;
	return parseClawHubPluginSpec(clawhubSpec) ? clawhubSpec : null;
}
function resolveInstallDefaultChoice(params) {
	const { cfg, entry, localPath, bundledLocalPath, hasClawHubSpec, hasNpmSpec } = params;
	const hasRemoteSpec = hasClawHubSpec || hasNpmSpec;
	const entryDefault = entry.install.defaultChoice;
	const remoteDefault = () => {
		if (entryDefault === "clawhub" && hasClawHubSpec) return "clawhub";
		if (entryDefault === "npm" && hasNpmSpec) return "npm";
		return hasNpmSpec ? "npm" : "clawhub";
	};
	if (!hasRemoteSpec) return localPath ? "local" : "skip";
	if (!localPath) return remoteDefault();
	if (bundledLocalPath) return "local";
	const updateChannel = cfg.update?.channel;
	if (updateChannel === "dev") return "local";
	if (updateChannel === "stable" || updateChannel === "beta") return remoteDefault();
	if (entryDefault === "local") return "local";
	return remoteDefault();
}
async function promptInstallChoice(params) {
	const rawClawHubSpec = resolveClawHubSpecForOnboarding(params.entry.install);
	const rawNpmSpec = resolveNpmSpecForOnboarding(params.entry.install);
	const clawhubSpec = params.bundledLocalPath ? null : params.effectiveClawHubSpec ?? rawClawHubSpec;
	const npmSpec = params.bundledLocalPath ? null : params.effectiveNpmSpec ?? rawNpmSpec;
	const safeLabel = sanitizeTerminalText(params.entry.label);
	const safeClawHubSpec = clawhubSpec ? sanitizeTerminalText(clawhubSpec) : null;
	const safeNpmSpec = npmSpec ? sanitizeTerminalText(npmSpec) : null;
	const safeLocalPath = params.localPath ? sanitizeTerminalText(params.localPath) : null;
	const options = [];
	if (safeClawHubSpec) options.push({
		value: "clawhub",
		label: t("wizard.plugins.downloadFromClawHub", { spec: safeClawHubSpec })
	});
	if (safeNpmSpec) options.push({
		value: "npm",
		label: t("wizard.plugins.downloadFromNpm", { spec: safeNpmSpec })
	});
	if (params.localPath) options.push({
		value: "local",
		label: t("wizard.plugins.useLocalPluginPath"),
		...safeLocalPath ? { hint: safeLocalPath } : {}
	});
	if (params.autoConfirmSingleSource) {
		const realSources = [];
		if (safeClawHubSpec) realSources.push("clawhub");
		if (safeNpmSpec) realSources.push("npm");
		if (params.localPath) realSources.push("local");
		if (realSources.length === 1) return realSources[0];
	}
	options.push({
		value: "skip",
		label: t("common.skipForNow")
	});
	const initialValue = params.defaultChoice === "local" && !params.localPath ? clawhubSpec ? "clawhub" : npmSpec ? "npm" : "skip" : params.defaultChoice === "clawhub" && !clawhubSpec ? npmSpec ? "npm" : params.localPath ? "local" : "skip" : params.defaultChoice === "npm" && !npmSpec ? clawhubSpec ? "clawhub" : params.localPath ? "local" : "skip" : params.defaultChoice;
	return await params.prompter.select({
		message: t("wizard.plugins.installPluginPrompt", { plugin: safeLabel }),
		options,
		initialValue
	});
}
function formatDurationLabel(timeoutMs) {
	if (timeoutMs % 6e4 === 0) {
		const minutes = timeoutMs / 6e4;
		return t(minutes === 1 ? "common.minute" : "common.minutes", { count: minutes });
	}
	const seconds = Math.round(timeoutMs / 1e3);
	return t(seconds === 1 ? "common.second" : "common.seconds", { count: seconds });
}
function formatPluginInstallProgress(label) {
	return t("wizard.plugins.installingPlugin", { plugin: label });
}
function formatPluginInstalled(label) {
	return t("wizard.plugins.installedPlugin", { plugin: label });
}
function formatPluginInstallFailed(label) {
	return t("wizard.plugins.installFailedShort", { plugin: label });
}
function formatPluginInstallTimedOut(label) {
	return t("wizard.plugins.installTimedOutShort", { plugin: label });
}
function formatPluginInstallTimedOutNote(spec) {
	return [t("wizard.plugins.installTimedOut", {
		spec,
		duration: formatDurationLabel(ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS)
	}), t("wizard.plugins.returningToSelection")].join("\n");
}
function summarizeInstallError(message) {
	const cleaned = sanitizeTerminalText(message).replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "").trim();
	if (!cleaned) return "Unknown install failure";
	return cleaned.length > 180 ? `${cleaned.slice(0, 179)}…` : cleaned;
}
function isTimeoutError(error) {
	return error instanceof Error && error.message === "timeout";
}
async function applyPluginEnablement(params) {
	const enableResult = enablePluginInConfig(params.cfg, params.pluginId);
	if (enableResult.enabled) return enableResult;
	const safeLabel = sanitizeTerminalText(params.label);
	const reason = enableResult.reason ?? "plugin disabled";
	await params.prompter.note(t("wizard.plugins.enableFailed", {
		plugin: safeLabel,
		reason
	}), t("wizard.plugins.installTitle"));
	params.runtime.error?.(`Plugin install failed: ${sanitizeTerminalText(params.pluginId)} is disabled (${reason}).`);
	return enableResult;
}
const PROGRESS_BAR_WIDTH = 16;
const PROGRESS_BAR_TICK_MS = 200;
const PROGRESS_BAR_DURATION_MS = 1e4;
const PROGRESS_BAR_MAX_PERCENT = 99;
/**
* Maps a verbose install log line (e.g. `Downloading @scope/pkg@1.2.3 from
* ClawHub…`, `Extracting /tmp/…/wecom-…-2026.4.23.tgz…`, `Installing to
* /home/.../plugins/demo…`) to a short verb suitable for a progress label.
*
* Falls back to the raw message when no known verb prefix is recognised so
* that unexpected log lines still surface to the user instead of being
* swallowed.
*/
function shortenInstallLabel(message) {
	const trimmed = message.trim();
	for (const [pattern, label] of [
		[/^Downloading\b/i, "Downloading"],
		[/^Extracting\b/i, "Extracting"],
		[/^Installing\s+to\b/i, "Installing"],
		[/^Installing\b/i, "Installing"],
		[/^Resolving\b/i, "Resolving"],
		[/^Cloning\b/i, "Cloning"],
		[/^Verifying\b/i, "Verifying"],
		[/^Preparing\b/i, "Preparing"],
		[/^Linking\b/i, "Linking"],
		[/^Linked\b/i, "Linking"],
		[/^npm rejected managed npm alias overrides\b/i, "Retrying"],
		[/^Compatibility\b/i, "Resolving"],
		[/^ClawHub\b/i, "Resolving"]
	]) if (pattern.test(trimmed)) return label;
	return trimmed;
}
/**
* Wraps a {@link WizardProgress} so the spinner message keeps a steadily
* growing ASCII bar attached to whatever the current install step label is.
*
* The plugin install pipeline only emits coarse `info` log lines, so without
* animation the spinner can sit on the same string for many seconds with no
* visible feedback. We render a deterministic left-to-right filling bar that
* advances linearly over {@link PROGRESS_BAR_DURATION_MS} (default 10s) up to
* {@link PROGRESS_BAR_MAX_PERCENT} (99%). If the install takes longer than the
* preset duration the bar simply stays pinned at 99% — never wrapping back to
* 0% — so the user always sees forward motion and a ceiling that signals
* "almost there, just waiting on the last bit".
*
* The bare label is forwarded to `progress.update` first on every label
* change so callers/tests that assert on the unadorned message continue to
* observe it before any decorated frame is overlaid.
*/
function createAnimatedInstallProgress(progress, options = {}) {
	const totalMs = options.totalMs ?? PROGRESS_BAR_DURATION_MS;
	let currentLabel = "";
	const startedAt = Date.now();
	const computePercent = () => {
		const elapsed = Date.now() - startedAt;
		const raw = Math.floor(elapsed / totalMs * 100);
		return Math.max(0, Math.min(PROGRESS_BAR_MAX_PERCENT, raw));
	};
	const renderBar = () => {
		const percent = computePercent();
		const filled = Math.round(percent / 100 * PROGRESS_BAR_WIDTH);
		return `[${"█".repeat(filled) + "░".repeat(Math.max(0, PROGRESS_BAR_WIDTH - filled))}] ${percent}%`;
	};
	const decorate = (label) => {
		if (!label) return renderBar();
		return `${label}  ${renderBar()}`;
	};
	const timer = setInterval(() => {
		if (currentLabel) progress.update(decorate(currentLabel));
	}, PROGRESS_BAR_TICK_MS);
	if (typeof timer.unref === "function") timer.unref();
	return {
		setLabel: (label) => {
			currentLabel = label;
			progress.update(label);
		},
		stop: () => {
			clearInterval(timer);
		}
	};
}
function logInstallWarningWithSpacing(runtime, message) {
	const sanitized = sanitizeTerminalText(message).trim();
	if (!sanitized) return;
	runtime.log?.(`${sanitized}\n`);
}
async function installPluginFromNpmSpecWithProgress(params) {
	const safeLabel = sanitizeTerminalText(params.entry.label);
	const progress = params.prompter.progress(formatPluginInstallProgress(safeLabel));
	const animated = createAnimatedInstallProgress(progress);
	animated.setLabel(t("wizard.plugins.preparingInstall"));
	const updateProgress = (message) => {
		const sanitized = sanitizeTerminalText(message).trim();
		if (!sanitized) return;
		animated.setLabel(shortenInstallLabel(sanitized));
	};
	try {
		const result = await withTimeout(installPluginFromNpmSpec({
			spec: params.npmSpec,
			mode: "update",
			timeoutMs: ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS,
			expectedPluginId: params.entry.pluginId,
			expectedIntegrity: params.entry.install.expectedIntegrity,
			...params.trustedSourceLinkedOfficialInstall ?? params.entry.trustedSourceLinkedOfficialInstall ? { trustedSourceLinkedOfficialInstall: true } : {},
			extensionsDir: resolveDefaultPluginExtensionsDir(),
			logger: {
				info: updateProgress,
				warn: (message) => {
					updateProgress(message);
					logInstallWarningWithSpacing(params.runtime, message);
				}
			}
		}), ONBOARDING_PLUGIN_INSTALL_WATCHDOG_TIMEOUT_MS);
		animated.stop();
		if (result.ok) progress.stop(formatPluginInstalled(safeLabel));
		else progress.stop(formatPluginInstallFailed(safeLabel));
		return {
			status: "completed",
			result
		};
	} catch (error) {
		animated.stop();
		if (isTimeoutError(error)) {
			progress.stop(formatPluginInstallTimedOut(safeLabel));
			return { status: "timed_out" };
		}
		progress.stop(formatPluginInstallFailed(safeLabel));
		return {
			status: "completed",
			result: {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			}
		};
	}
}
async function installPluginFromNpmPackArchiveWithProgress(params) {
	const safeLabel = sanitizeTerminalText(params.entry.label);
	const progress = params.prompter.progress(formatPluginInstallProgress(safeLabel));
	const animated = createAnimatedInstallProgress(progress);
	animated.setLabel(t("wizard.plugins.preparingInstall"));
	const updateProgress = (message) => {
		const sanitized = sanitizeTerminalText(message).trim();
		if (!sanitized) return;
		animated.setLabel(shortenInstallLabel(sanitized));
	};
	try {
		const result = await withTimeout(installPluginFromNpmPackArchive({
			archivePath: params.archivePath,
			timeoutMs: ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS,
			expectedPluginId: params.entry.pluginId,
			expectedIntegrity: params.entry.install.expectedIntegrity,
			extensionsDir: resolveDefaultPluginExtensionsDir(),
			logger: {
				info: updateProgress,
				warn: (message) => {
					updateProgress(message);
					logInstallWarningWithSpacing(params.runtime, message);
				}
			}
		}), ONBOARDING_PLUGIN_INSTALL_WATCHDOG_TIMEOUT_MS);
		animated.stop();
		progress.stop(result.ok ? formatPluginInstalled(safeLabel) : formatPluginInstallFailed(safeLabel));
		return {
			status: "completed",
			result
		};
	} catch (error) {
		animated.stop();
		if (isTimeoutError(error)) {
			progress.stop(formatPluginInstallTimedOut(safeLabel));
			return { status: "timed_out" };
		}
		progress.stop(formatPluginInstallFailed(safeLabel));
		throw error;
	} finally {
		animated.stop();
	}
}
async function installPluginFromOverride(params) {
	const { entry, prompter, runtime } = params;
	runtime.log?.(`Using plugin install override for ${sanitizeTerminalText(entry.pluginId)} from ${PLUGIN_INSTALL_OVERRIDES_ENV} (${ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV}=1).`);
	const installOutcome = params.override.kind === "npm" ? await installPluginFromNpmSpecWithProgress({
		entry,
		npmSpec: params.override.spec,
		prompter,
		runtime,
		trustedSourceLinkedOfficialInstall: false
	}) : await installPluginFromNpmPackArchiveWithProgress({
		entry,
		archivePath: params.override.archivePath,
		prompter,
		runtime
	});
	const displaySpec = params.override.kind === "npm" ? params.override.spec : `npm-pack:${params.override.archivePath}`;
	if (installOutcome.status === "timed_out") {
		await prompter.note(formatPluginInstallTimedOutNote(sanitizeTerminalText(displaySpec)), t("wizard.plugins.installTitle"));
		runtime.error?.(`Plugin install timed out after ${ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS}ms: ${sanitizeTerminalText(displaySpec)}`);
		return {
			cfg: params.cfg,
			installed: false,
			pluginId: entry.pluginId,
			status: "timed_out"
		};
	}
	const { result } = installOutcome;
	if (!result.ok) {
		await prompter.note([t("wizard.plugins.installFailed", {
			spec: sanitizeTerminalText(displaySpec),
			error: summarizeInstallError(result.error)
		}), t("wizard.plugins.returningToSelection")].join("\n"), t("wizard.plugins.installTitle"));
		runtime.error?.(`Plugin install failed: ${sanitizeTerminalText(result.error)}`);
		return {
			cfg: params.cfg,
			installed: false,
			pluginId: entry.pluginId,
			status: "failed"
		};
	}
	const enableResult = await applyPluginEnablement({
		cfg: params.cfg,
		pluginId: result.pluginId,
		label: entry.label,
		prompter,
		runtime
	});
	if (!enableResult.enabled) return {
		cfg: enableResult.config,
		installed: false,
		pluginId: result.pluginId,
		status: "failed"
	};
	const npmTarballName = params.override.kind === "npm-pack" ? result.npmTarballName : void 0;
	const install = params.override.kind === "npm-pack" ? {
		pluginId: result.pluginId,
		source: "npm",
		spec: result.npmResolution?.resolvedSpec ?? result.manifestName ?? result.pluginId,
		sourcePath: params.override.archivePath,
		installPath: result.targetDir,
		...result.version ? { version: result.version } : {},
		...buildNpmResolutionInstallFields(result.npmResolution),
		artifactKind: "npm-pack",
		artifactFormat: "tgz",
		...result.npmResolution?.integrity ? { npmIntegrity: result.npmResolution.integrity } : {},
		...result.npmResolution?.shasum ? { npmShasum: result.npmResolution.shasum } : {},
		...npmTarballName ? { npmTarballName } : {}
	} : {
		pluginId: result.pluginId,
		source: "npm",
		spec: params.override.spec,
		installPath: result.targetDir,
		...result.version ? { version: result.version } : {},
		...buildNpmResolutionInstallFields(result.npmResolution)
	};
	return {
		cfg: recordPluginInstall(enableResult.config, install),
		installed: true,
		pluginId: result.pluginId,
		status: "installed"
	};
}
async function installPluginFromClawHubSpecWithProgress(params) {
	const safeLabel = sanitizeTerminalText(params.entry.label);
	const progress = params.prompter.progress(formatPluginInstallProgress(safeLabel));
	const animated = createAnimatedInstallProgress(progress);
	animated.setLabel(t("wizard.plugins.preparingInstall"));
	const updateProgress = (message) => {
		const sanitized = sanitizeTerminalText(message).trim();
		if (!sanitized) return;
		animated.setLabel(shortenInstallLabel(sanitized));
	};
	try {
		const { installPluginFromClawHub } = await import("./clawhub-D8OAOkbi.js");
		const result = await withTimeout(installPluginFromClawHub({
			spec: params.clawhubSpec,
			timeoutMs: ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS,
			extensionsDir: resolveDefaultPluginExtensionsDir(),
			expectedPluginId: params.entry.pluginId,
			mode: "install",
			logger: {
				info: updateProgress,
				warn: (message) => {
					updateProgress(message);
					logInstallWarningWithSpacing(params.runtime, message);
				}
			}
		}), ONBOARDING_PLUGIN_INSTALL_WATCHDOG_TIMEOUT_MS);
		animated.stop();
		if (result.ok) progress.stop(formatPluginInstalled(safeLabel));
		else progress.stop(formatPluginInstallFailed(safeLabel));
		return {
			status: "completed",
			result
		};
	} catch (error) {
		animated.stop();
		if (isTimeoutError(error)) {
			progress.stop(formatPluginInstallTimedOut(safeLabel));
			return { status: "timed_out" };
		}
		progress.stop(formatPluginInstallFailed(safeLabel));
		return {
			status: "completed",
			result: {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			}
		};
	}
}
async function ensureOnboardingPluginInstalled(params) {
	const { entry, prompter, runtime, workspaceDir } = params;
	let next = params.cfg;
	const installOverride = resolvePluginInstallOverride({ pluginId: entry.pluginId });
	if (installOverride) {
		assertConfigWriteAllowedInCurrentMode();
		return await installPluginFromOverride({
			cfg: next,
			entry,
			override: installOverride,
			prompter,
			runtime
		});
	}
	const allowLocal = hasGitWorkspace(workspaceDir);
	const bundledLocalPath = entry.preferRemoteInstall ? null : resolveBundledLocalPath({
		entry,
		workspaceDir
	});
	const localPath = bundledLocalPath ?? (entry.preferRemoteInstall ? null : resolveLocalPath({
		entry,
		workspaceDir,
		allowLocal
	}));
	const clawhubSpec = resolveClawHubSpecForOnboarding(entry.install);
	const npmSpec = resolveNpmSpecForOnboarding(entry.install);
	const updateChannel = resolveRegistryUpdateChannel({
		configChannel: normalizeUpdateChannel(next.update?.channel),
		currentVersion: VERSION
	});
	const clawhubSpecs = clawhubSpec ? resolveClawHubInstallSpecsForUpdateChannel({
		spec: clawhubSpec,
		updateChannel
	}) : null;
	const npmSpecs = npmSpec ? resolveNpmInstallSpecsForUpdateChannel({
		spec: npmSpec,
		updateChannel
	}) : null;
	const clawhubInstallSpec = clawhubSpecs?.installSpec ?? clawhubSpec;
	const npmInstallSpec = npmSpecs?.installSpec ?? npmSpec;
	const defaultChoice = resolveInstallDefaultChoice({
		cfg: next,
		entry,
		localPath,
		bundledLocalPath,
		hasClawHubSpec: Boolean(clawhubSpec),
		hasNpmSpec: Boolean(npmSpec)
	});
	const choice = params.promptInstall === false ? defaultChoice : await promptInstallChoice({
		entry,
		localPath,
		bundledLocalPath,
		defaultChoice,
		prompter,
		autoConfirmSingleSource: params.autoConfirmSingleSource,
		effectiveClawHubSpec: clawhubInstallSpec,
		effectiveNpmSpec: npmInstallSpec
	});
	if (choice === "skip") return {
		cfg: next,
		installed: false,
		pluginId: entry.pluginId,
		status: "skipped"
	};
	assertConfigWriteAllowedInCurrentMode();
	if (choice === "local" && localPath) {
		const enableResult = await applyPluginEnablement({
			cfg: next,
			pluginId: entry.pluginId,
			label: entry.label,
			prompter,
			runtime
		});
		if (!enableResult.enabled) return {
			cfg: enableResult.config,
			installed: false,
			pluginId: entry.pluginId,
			status: "failed"
		};
		if (pathsReferToSameDirectory(localPath, bundledLocalPath)) return {
			cfg: enableResult.config,
			installed: true,
			pluginId: entry.pluginId,
			status: "installed"
		};
		next = addPluginLoadPath(enableResult.config, localPath);
		next = await recordLocalPluginInstall({
			cfg: next,
			entry,
			localPath,
			npmSpec,
			workspaceDir
		});
		return {
			cfg: next,
			installed: true,
			pluginId: entry.pluginId,
			status: "installed"
		};
	}
	let shouldTryNpm = choice === "npm";
	if (choice === "clawhub" && clawhubInstallSpec) {
		const installOutcome = await installPluginFromClawHubSpecWithProgress({
			entry,
			clawhubSpec: clawhubInstallSpec,
			prompter,
			runtime
		});
		if (installOutcome.status === "timed_out") {
			await prompter.note(formatPluginInstallTimedOutNote(sanitizeTerminalText(clawhubInstallSpec)), t("wizard.plugins.installTitle"));
			runtime.error?.(`Plugin install timed out after ${ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS}ms: ${sanitizeTerminalText(clawhubInstallSpec)}`);
			return {
				cfg: next,
				installed: false,
				pluginId: entry.pluginId,
				status: "timed_out"
			};
		}
		const { result } = installOutcome;
		if (result.ok) {
			const enableResult = await applyPluginEnablement({
				cfg: next,
				pluginId: result.pluginId,
				label: entry.label,
				prompter,
				runtime
			});
			if (!enableResult.enabled) return {
				cfg: enableResult.config,
				installed: false,
				pluginId: result.pluginId,
				status: "failed"
			};
			next = enableResult.config;
			next = recordPluginInstall(next, {
				pluginId: result.pluginId,
				...buildClawHubPluginInstallRecordFields(result.clawhub),
				spec: clawhubSpecs?.recordSpec ?? clawhubInstallSpec,
				installPath: result.targetDir
			});
			return {
				cfg: next,
				installed: true,
				pluginId: result.pluginId,
				status: "installed"
			};
		}
		await prompter.note([t("wizard.plugins.installFailed", {
			spec: sanitizeTerminalText(clawhubInstallSpec),
			error: summarizeInstallError(result.error)
		}), t("wizard.plugins.returningToSelection")].join("\n"), t("wizard.plugins.installTitle"));
		if (!npmInstallSpec || !shouldFallbackClawHubToNpm({
			result,
			npmSpec: npmInstallSpec
		})) {
			runtime.error?.(`Plugin install failed: ${sanitizeTerminalText(result.error)}`);
			return {
				cfg: next,
				installed: false,
				pluginId: entry.pluginId,
				status: "failed"
			};
		}
		shouldTryNpm = await prompter.confirm({
			message: t("wizard.plugins.useNpmPackageInstead", { spec: sanitizeTerminalText(npmInstallSpec) }),
			initialValue: true
		});
		if (!shouldTryNpm) {
			runtime.error?.(`Plugin install failed: ${sanitizeTerminalText(result.error)}`);
			return {
				cfg: next,
				installed: false,
				pluginId: entry.pluginId,
				status: "failed"
			};
		}
	}
	if (!shouldTryNpm || !npmInstallSpec) {
		await prompter.note(t("wizard.plugins.noRemoteInstallSource", { plugin: sanitizeTerminalText(entry.label) }), t("wizard.plugins.installTitle"));
		runtime.error?.(`Plugin install failed: no remote spec available for ${sanitizeTerminalText(entry.pluginId)}.`);
		return {
			cfg: next,
			installed: false,
			pluginId: entry.pluginId,
			status: "failed"
		};
	}
	const installOutcome = await installPluginFromNpmSpecWithProgress({
		entry,
		npmSpec: npmInstallSpec,
		prompter,
		runtime
	});
	if (installOutcome.status === "timed_out") {
		await prompter.note(formatPluginInstallTimedOutNote(sanitizeTerminalText(npmInstallSpec)), t("wizard.plugins.installTitle"));
		runtime.error?.(`Plugin install timed out after ${ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS}ms: ${sanitizeTerminalText(npmInstallSpec)}`);
		return {
			cfg: next,
			installed: false,
			pluginId: entry.pluginId,
			status: "timed_out"
		};
	}
	const { result } = installOutcome;
	if (result.ok) {
		const enableResult = await applyPluginEnablement({
			cfg: next,
			pluginId: result.pluginId,
			label: entry.label,
			prompter,
			runtime
		});
		if (!enableResult.enabled) return {
			cfg: enableResult.config,
			installed: false,
			pluginId: result.pluginId,
			status: "failed"
		};
		next = enableResult.config;
		const install = {
			pluginId: result.pluginId,
			source: "npm",
			spec: npmSpecs?.recordSpec ?? npmInstallSpec,
			installPath: result.targetDir,
			version: result.version,
			...buildNpmResolutionInstallFields(result.npmResolution)
		};
		next = recordPluginInstall(next, install);
		return {
			cfg: next,
			installed: true,
			pluginId: result.pluginId,
			status: "installed"
		};
	}
	await prompter.note([t("wizard.plugins.installFailed", {
		spec: sanitizeTerminalText(npmInstallSpec),
		error: summarizeInstallError(result.error)
	}), t("wizard.plugins.returningToSelection")].join("\n"), t("wizard.plugins.installTitle"));
	if (localPath) {
		if (await prompter.confirm({
			message: t("wizard.plugins.useLocalPluginPathInstead", { path: sanitizeTerminalText(localPath) }),
			initialValue: true
		})) {
			const enableResult = await applyPluginEnablement({
				cfg: next,
				pluginId: entry.pluginId,
				label: entry.label,
				prompter,
				runtime
			});
			if (!enableResult.enabled) return {
				cfg: enableResult.config,
				installed: false,
				pluginId: entry.pluginId,
				status: "failed"
			};
			if (pathsReferToSameDirectory(localPath, bundledLocalPath)) return {
				cfg: enableResult.config,
				installed: true,
				pluginId: entry.pluginId,
				status: "installed"
			};
			next = addPluginLoadPath(enableResult.config, localPath);
			next = await recordLocalPluginInstall({
				cfg: next,
				entry,
				localPath,
				npmSpec,
				workspaceDir
			});
			return {
				cfg: next,
				installed: true,
				pluginId: entry.pluginId,
				status: "installed"
			};
		}
	}
	runtime.error?.(`Plugin install failed: ${sanitizeTerminalText(result.error)}`);
	return {
		cfg: next,
		installed: false,
		pluginId: entry.pluginId,
		status: "failed"
	};
}
//#endregion
export { ensureOnboardingPluginInstalled as t };
