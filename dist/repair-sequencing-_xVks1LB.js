import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { t as sanitizeForLog } from "./ansi-Bk0Jp_0O.js";
import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-DDaGBMF_.js";
import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { d as resolveConfigDir, p as resolveUserPath } from "./utils-CKsuXgDI.js";
import { n as normalizeAccountId } from "./account-id-CwBWagLE.js";
import { s as normalizeStringEntries } from "./string-normalization-DEwYgSEp.js";
import { r as normalizeChatChannelId } from "./ids-DFu3Ho6n.js";
import { T as validateConfigObjectWithPlugins } from "./io-5xE1dPMK.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-DLIxCAM0.js";
import { s as setCanonicalDmAllowFrom } from "./dm-access-B2x-maJ2.js";
import { a as readChannelAllowFromStore } from "./pairing-store-DKcswb9w.js";
import { a as collectChannelDoctorRepairMutations, s as createChannelDoctorEmptyAllowlistPolicyHooks } from "./channel-doctor-Hz1Gt0yA.js";
import { t as asObjectRecord } from "./object-CfbLD2Ci.js";
import { i as isUpdatePackageSwapInProgress, t as repairMissingConfiguredPluginInstalls } from "./missing-configured-plugin-install-83JzzcYV.js";
import { t as applyDoctorConfigMutation } from "./config-mutation-state-C4Q9JfOC.js";
import { r as maybeRepairStaleManagedNpmBundledPlugins, t as maybeRepairManagedNpmOpenClawPeerLinks } from "./doctor-plugin-registry-CtNZl5tm.js";
import { n as maybeRepairOpenPolicyAllowFrom, r as resolveAllowFromMode } from "./open-policy-allowfrom-BI-rhk05.js";
import { n as hasAllowFromEntries, t as scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan-CBbtWpLd.js";
import { n as maybeRepairBundledPluginLoadPaths } from "./bundled-plugin-load-paths-BMJEQHZR.js";
import { n as maybeRepairCodexRoutes } from "./codex-route-warnings-BOnfk0QY.js";
import { r as maybeRepairExecSafeBinProfiles } from "./exec-safe-bins-B2y8Ozja.js";
import { n as maybeRepairLegacyToolsBySenderKeys } from "./legacy-tools-by-sender-D8M15NRq.js";
import { r as removeStalePluginRuntimeSymlinks } from "./plugin-runtime-symlinks-mJb0_3So.js";
import { r as maybeRepairStalePluginConfig } from "./stale-plugin-config-Bz-Z-2rW.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/doctor/shared/allowlist-policy-repair.ts
async function maybeRepairAllowlistPolicyAllowFrom(cfg) {
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return {
		config: cfg,
		changes: []
	};
	const next = structuredClone(cfg);
	const changes = [];
	const applyRecoveredAllowFrom = (params) => {
		const count = params.allowFrom.length;
		const noun = count === 1 ? "entry" : "entries";
		setCanonicalDmAllowFrom({
			entry: params.account,
			mode: params.mode,
			allowFrom: params.allowFrom,
			pathPrefix: params.prefix,
			changes,
			reason: `restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`
		});
	};
	const recoverAllowFromForAccount = async (params) => {
		const dmEntry = params.account.dm;
		const dm = dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry) ? dmEntry : void 0;
		if ((params.account.dmPolicy ?? dm?.policy) !== "allowlist") return;
		const topAllowFrom = params.account.allowFrom;
		const nestedAllowFrom = dm?.allowFrom;
		if (hasAllowFromEntries(topAllowFrom) || hasAllowFromEntries(nestedAllowFrom)) return;
		const normalizedChannelId = normalizeOptionalLowercaseString(normalizeChatChannelId(params.channelName) ?? params.channelName);
		if (!normalizedChannelId) return;
		const normalizedAccountId = normalizeAccountId(params.accountId) || "default";
		const fromStore = await readChannelAllowFromStore(normalizedChannelId, process.env, normalizedAccountId).catch(() => []);
		const recovered = Array.from(new Set(normalizeStringEntries(fromStore)));
		if (recovered.length === 0) return;
		applyRecoveredAllowFrom({
			account: params.account,
			allowFrom: recovered,
			mode: resolveAllowFromMode(params.channelName),
			prefix: params.prefix
		});
	};
	const nextChannels = next.channels;
	for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
		if (!channelConfig || typeof channelConfig !== "object") continue;
		if (channelConfig.enabled === false) continue;
		await recoverAllowFromForAccount({
			channelName,
			account: channelConfig,
			prefix: `channels.${channelName}`
		});
		const accounts = asObjectRecord(channelConfig.accounts);
		if (!accounts) continue;
		for (const [accountId, accountConfig] of Object.entries(accounts)) {
			if (!accountConfig || typeof accountConfig !== "object") continue;
			if (accountConfig.enabled === false) continue;
			await recoverAllowFromForAccount({
				channelName,
				account: accountConfig,
				accountId,
				prefix: `channels.${channelName}.accounts.${accountId}`
			});
		}
	}
	if (changes.length === 0) return {
		config: cfg,
		changes: []
	};
	return {
		config: next,
		changes
	};
}
//#endregion
//#region src/commands/doctor/shared/invalid-plugin-config.ts
const PLUGIN_CONFIG_ISSUE_RE = /^plugins\.entries\.([^.]+)\.config(?:\.|$)/;
function scanInvalidPluginConfig(cfg) {
	const validation = validateConfigObjectWithPlugins(cfg);
	if (validation.ok) return [];
	const hits = [];
	const seen = /* @__PURE__ */ new Set();
	for (const issue of validation.issues) {
		if (!issue.message.startsWith("invalid config:")) continue;
		const pluginId = issue.path.match(PLUGIN_CONFIG_ISSUE_RE)?.[1];
		if (!pluginId || seen.has(pluginId)) continue;
		seen.add(pluginId);
		hits.push({
			pluginId,
			pathLabel: `plugins.entries.${pluginId}.config`
		});
	}
	return hits;
}
function maybeRepairInvalidPluginConfig(cfg) {
	const hits = scanInvalidPluginConfig(cfg);
	if (hits.length === 0) return {
		config: cfg,
		changes: []
	};
	const next = structuredClone(cfg);
	const entries = asObjectRecord(next.plugins?.entries);
	if (!entries) return {
		config: cfg,
		changes: []
	};
	const quarantined = [];
	for (const hit of hits) {
		const entry = asObjectRecord(entries[hit.pluginId]);
		if (!entry) continue;
		if ("config" in entry) delete entry.config;
		entry.enabled = false;
		quarantined.push(hit.pluginId);
	}
	if (quarantined.length === 0) return {
		config: cfg,
		changes: []
	};
	return {
		config: next,
		changes: [sanitizeForLog(`- plugins.entries: quarantined ${quarantined.length} invalid plugin config${quarantined.length === 1 ? "" : "s"} (${quarantined.join(", ")})`)]
	};
}
//#endregion
//#region src/commands/doctor/shared/plugin-dependency-cleanup.ts
const LEGACY_DIRECT_CHILD_NAMES = new Set(["plugin-runtime-deps", "bundled-plugin-runtime-deps"]);
function uniqueSorted(values) {
	return [...new Set([...values].filter((value) => typeof value === "string" && value.length > 0).map((value) => path.resolve(value)))].toSorted((left, right) => left.localeCompare(right));
}
function splitPathList(value) {
	return value ? value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean) : [];
}
async function pathExists(targetPath) {
	try {
		await fs.lstat(targetPath);
		return true;
	} catch {
		return false;
	}
}
function isRuntimeDependencyMarkerName(name) {
	return name === ".openclaw-runtime-deps.json" || name === ".openclaw-runtime-deps-stamp.json" || name.startsWith(".openclaw-runtime-deps-");
}
function isLegacyDependencyDebrisName(name) {
	return isRuntimeDependencyMarkerName(name) || name === ".openclaw-pnpm-store" || name === ".openclaw-install-backups" || name.startsWith(".openclaw-install-stage-");
}
async function collectDirectChildren(root) {
	return (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).map((entry) => path.join(root, entry.name));
}
async function collectLegacyExtensionDebris(extensionsRoot) {
	const pluginDirs = await fs.readdir(extensionsRoot, { withFileTypes: true }).catch(() => []);
	const targets = [];
	for (const entry of pluginDirs) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const children = await collectDirectChildren(path.join(extensionsRoot, entry.name));
		const hasRuntimeDepsMarker = children.some((childPath) => isRuntimeDependencyMarkerName(path.basename(childPath)));
		for (const childPath of children) {
			const basename = path.basename(childPath);
			if (basename === "node_modules" && hasRuntimeDepsMarker) {
				targets.push(childPath);
				continue;
			}
			if (isLegacyDependencyDebrisName(basename)) targets.push(childPath);
		}
	}
	return targets;
}
async function collectLegacyPluginDependencyTargets(env = process.env, options = {}) {
	const packageRoot = options.packageRoot ?? resolveOpenClawPackageRootSync({
		argv1: process.argv[1],
		moduleUrl: import.meta.url,
		cwd: process.cwd()
	});
	const roots = uniqueSorted([
		resolveStateDir(env),
		resolveConfigDir(env),
		packageRoot
	]);
	const explicitStageRoots = splitPathList(env.OPENCLAW_PLUGIN_STAGE_DIR).map((entry) => resolveUserPath(entry, env));
	const stateDirectoryRoots = splitPathList(env.STATE_DIRECTORY).map((entry) => path.join(resolveUserPath(entry, env), "plugin-runtime-deps"));
	const targets = [
		...explicitStageRoots,
		...stateDirectoryRoots,
		...roots.flatMap((root) => [...[...LEGACY_DIRECT_CHILD_NAMES].map((name) => path.join(root, name)), path.join(root, ".local", "bundled-plugin-runtime-deps")])
	];
	for (const root of roots) {
		targets.push(...await collectLegacyExtensionDebris(path.join(root, "extensions")));
		targets.push(...await collectLegacyExtensionDebris(path.join(root, "dist", "extensions")));
	}
	return uniqueSorted(targets);
}
async function cleanupLegacyPluginDependencyState(params) {
	const env = params.env ?? process.env;
	const changes = [];
	const warnings = [];
	const packageRoot = params.packageRoot ?? resolveOpenClawPackageRootSync({
		argv1: process.argv[1],
		moduleUrl: import.meta.url,
		cwd: process.cwd()
	});
	const targets = await collectLegacyPluginDependencyTargets(env, { packageRoot });
	const staleSymlinks = await removeStalePluginRuntimeSymlinks(packageRoot, { staleRoots: targets });
	changes.push(...staleSymlinks.changes);
	warnings.push(...staleSymlinks.warnings);
	for (const target of targets) {
		if (!await pathExists(target)) continue;
		try {
			await fs.rm(target, {
				recursive: true,
				force: true
			});
			changes.push(`Removed legacy plugin dependency state: ${target}`);
		} catch (error) {
			warnings.push(`Failed to remove legacy plugin dependency state ${target}: ${String(error)}`);
		}
	}
	return {
		changes,
		warnings
	};
}
//#endregion
//#region src/commands/doctor/repair-sequencing.ts
async function runDoctorRepairSequence(params) {
	let state = params.state;
	const changeNotes = [];
	const warningNotes = [];
	const env = params.env ?? process.env;
	const sanitizeLines = (lines) => lines.map((line) => sanitizeForLog(line)).join("\n");
	const applyMutation = (mutation) => {
		if (mutation.changes.length > 0) {
			changeNotes.push(sanitizeLines(mutation.changes));
			state = applyDoctorConfigMutation({
				state,
				mutation,
				shouldRepair: true
			});
		}
		if (mutation.warnings && mutation.warnings.length > 0) warningNotes.push(sanitizeLines(mutation.warnings));
	};
	for (const mutation of await collectChannelDoctorRepairMutations({
		cfg: state.candidate,
		doctorFixCommand: params.doctorFixCommand,
		env
	})) applyMutation(mutation);
	applyMutation(maybeRepairOpenPolicyAllowFrom(state.candidate));
	applyMutation(maybeRepairBundledPluginLoadPaths(state.candidate, env));
	maybeRepairStaleManagedNpmBundledPlugins({
		config: state.candidate,
		env,
		prompter: { shouldRepair: true }
	});
	await maybeRepairManagedNpmOpenClawPeerLinks({
		config: state.candidate,
		env,
		prompter: { shouldRepair: true }
	});
	const codexRouteRepair = maybeRepairCodexRoutes({
		cfg: state.candidate,
		env,
		shouldRepair: true
	});
	applyMutation({
		config: codexRouteRepair.cfg,
		changes: codexRouteRepair.changes,
		warnings: codexRouteRepair.warnings
	});
	const missingConfiguredPluginInstallRepair = await repairMissingConfiguredPluginInstalls({
		cfg: state.candidate,
		env
	});
	if (missingConfiguredPluginInstallRepair.changes.length > 0) {
		changeNotes.push(sanitizeLines(missingConfiguredPluginInstallRepair.changes));
		applyMutation(applyPluginAutoEnable({
			config: state.candidate,
			env
		}));
	}
	if (missingConfiguredPluginInstallRepair.warnings.length > 0) warningNotes.push(sanitizeLines(missingConfiguredPluginInstallRepair.warnings));
	const missingConfiguredPluginInstallFailed = missingConfiguredPluginInstallRepair.warnings.length > 0;
	if (!isUpdatePackageSwapInProgress(env) && !missingConfiguredPluginInstallFailed) applyMutation(maybeRepairStalePluginConfig(state.candidate, env));
	applyMutation(maybeRepairInvalidPluginConfig(state.candidate));
	applyMutation(await maybeRepairAllowlistPolicyAllowFrom(state.candidate));
	const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(state.candidate, {
		doctorFixCommand: params.doctorFixCommand,
		...createChannelDoctorEmptyAllowlistPolicyHooks({
			cfg: state.candidate,
			env
		})
	});
	if (emptyAllowlistWarnings.length > 0) warningNotes.push(sanitizeLines(emptyAllowlistWarnings));
	applyMutation(maybeRepairLegacyToolsBySenderKeys(state.candidate));
	applyMutation(maybeRepairExecSafeBinProfiles(state.candidate));
	const pluginDependencyCleanup = await cleanupLegacyPluginDependencyState({ env });
	if (pluginDependencyCleanup.changes.length > 0) changeNotes.push(sanitizeLines(pluginDependencyCleanup.changes));
	if (pluginDependencyCleanup.warnings.length > 0) warningNotes.push(sanitizeLines(pluginDependencyCleanup.warnings));
	return {
		state,
		changeNotes,
		warningNotes
	};
}
//#endregion
export { runDoctorRepairSequence };
