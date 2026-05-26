import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-CNp1Ofdk.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { d as resolveConfigDir, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { r as normalizeChatChannelId } from "./ids-BE_yccbC.js";
import { O as GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA, T as validateConfigObjectWithPlugins } from "./io-DoswVvYe.js";
import { a as normalizeAnyChannelId } from "./registry-CtWyD2pE.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-CuCUT4Z1.js";
import { a as readChannelAllowFromStore } from "./pairing-store-jPMfFWFn.js";
import { a as resolveChannelDmAllowFrom, s as setCanonicalDmAllowFrom } from "./dm-access-CP9QxWdj.js";
import { a as collectChannelDoctorRepairMutations, s as createChannelDoctorEmptyAllowlistPolicyHooks } from "./channel-doctor-Br5Zk23t.js";
import { s as isUpdatePackageSwapInProgress } from "./update-phase-2jBtHxsn.js";
import { t as asObjectRecord } from "./object-BsiS9JXh.js";
import { t as repairMissingConfiguredPluginInstalls } from "./missing-configured-plugin-install-D-EYU6f8.js";
import { t as maybeRepairLegacyOAuthSidecarProfiles } from "./doctor-auth-oauth-sidecar-DIF6V40h.js";
import { t as applyDoctorConfigMutation } from "./config-mutation-state-C1d35St0.js";
import { i as maybeRepairStaleManagedNpmBundledPlugins, t as maybeRepairManagedNpmOpenClawPeerLinks } from "./doctor-plugin-registry-C6ITjtCb.js";
import { t as getDoctorChannelCapabilities } from "./channel-capabilities-BJ5ncwpO.js";
import { n as maybeRepairOpenPolicyAllowFrom, r as resolveAllowFromMode } from "./open-policy-allowfrom-BbragdLC.js";
import { n as hasAllowFromEntries, t as scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan-Bpc_QSiQ.js";
import { n as maybeRepairBundledPluginLoadPaths } from "./bundled-plugin-load-paths-BQWJooPe.js";
import { n as maybeRepairCodexRoutes } from "./codex-route-warnings-CppMIDKk.js";
import { r as maybeRepairContextEngineHostCompatibility } from "./context-engine-host-compat-DeBRwh0f.js";
import { r as maybeRepairExecSafeBinProfiles } from "./exec-safe-bins-C1cxz4ap.js";
import { n as maybeRepairLegacyToolsBySenderKeys } from "./legacy-tools-by-sender-C4mLR_BY.js";
import { r as removeStalePluginRuntimeSymlinks } from "./plugin-runtime-symlinks-PYoRAyvp.js";
import { n as repairStaleOAuthProfileShadows } from "./stale-oauth-profile-shadows-BDw360q1.js";
import { r as maybeRepairStalePluginConfig } from "./stale-plugin-config-8u1nd6s9.js";
import { n as maybeRepairStaleSubagentAllowlists } from "./stale-subagent-allowlist-BIS3UCr1.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/doctor/shared/allowfrom-fallback-migration.ts
const PSEUDO_CHANNEL_KEYS = new Set([
	"defaults",
	"modelByChannel",
	"tools"
]);
const ACCOUNT_SCHEMA_WILDCARD = "*";
const CHANNEL_GROUP_ALLOW_FROM_PATH = ["groupAllowFrom"];
const ACCOUNT_GROUP_ALLOW_FROM_PATH = [
	"accounts",
	ACCOUNT_SCHEMA_WILDCARD,
	"groupAllowFrom"
];
function isDisabled(record) {
	return record.enabled === false;
}
function normalizeAllowFrom(raw) {
	return Array.from(new Set(normalizeStringEntries(Array.isArray(raw) ? raw : [])));
}
function readGroupAllowFrom(record) {
	return normalizeAllowFrom(record.groupAllowFrom);
}
function readDmAllowFrom(params) {
	return normalizeAllowFrom(resolveChannelDmAllowFrom({
		account: params.account,
		parent: params.parent,
		mode: getDoctorChannelCapabilities(params.channelName).dmAllowFromMode
	}));
}
function readOwnDmAllowFrom(params) {
	return normalizeAllowFrom(resolveChannelDmAllowFrom({
		account: params.account,
		mode: getDoctorChannelCapabilities(params.channelName).dmAllowFromMode
	}));
}
function findGeneratedChannelConfigSchema(channelName) {
	const normalizedChannelId = normalizeAnyChannelId(channelName);
	return GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find((entry) => entry.channelId === channelName || entry.channelId === normalizedChannelId)?.schema;
}
function schemaAllowsConfigPath(schema, path) {
	if (path.length === 0) return true;
	const node = asObjectRecord(schema);
	if (!node) return true;
	const anyOf = Array.isArray(node.anyOf) ? node.anyOf : void 0;
	if (anyOf) return anyOf.some((branch) => schemaAllowsConfigPath(branch, path));
	const oneOf = Array.isArray(node.oneOf) ? node.oneOf : void 0;
	if (oneOf) return oneOf.some((branch) => schemaAllowsConfigPath(branch, path));
	const allOf = Array.isArray(node.allOf) ? node.allOf : void 0;
	if (allOf) return allOf.every((branch) => schemaAllowsConfigPath(branch, path));
	const [segment, ...rest] = path;
	const properties = asObjectRecord(node.properties);
	if (segment !== ACCOUNT_SCHEMA_WILDCARD && properties && Object.prototype.hasOwnProperty.call(properties, segment)) return schemaAllowsConfigPath(properties[segment], rest);
	const additionalProperties = node.additionalProperties;
	if (additionalProperties === false) return false;
	if (additionalProperties && typeof additionalProperties === "object") return schemaAllowsConfigPath(additionalProperties, rest);
	return true;
}
function generatedSchemaAllowsGroupAllowFrom(channelName, path) {
	const schema = findGeneratedChannelConfigSchema(channelName);
	return !schema || schemaAllowsConfigPath(schema, path);
}
function migrateRecord(params) {
	if (!params.canWriteGroupAllowFrom) return false;
	if (readGroupAllowFrom(params.account).length > 0) return false;
	if (params.parent && params.parentHadGroupAllowFrom) return false;
	const ownAllowFrom = readOwnDmAllowFrom(params);
	if (params.parent && ownAllowFrom.length === 0 && readGroupAllowFrom(params.parent).length > 0) return false;
	const allowFrom = readDmAllowFrom(params);
	if (allowFrom.length === 0) return false;
	params.account.groupAllowFrom = allowFrom;
	const noun = allowFrom.length === 1 ? "entry" : "entries";
	params.changes.push(`${params.prefix}.groupAllowFrom: copied ${allowFrom.length} sender ${noun} from allowFrom for explicit group allowlist.`);
	return true;
}
function maybeRepairGroupAllowFromFallback(cfg) {
	if (!asObjectRecord(cfg.channels)) return {
		config: cfg,
		changes: []
	};
	const next = structuredClone(cfg);
	const nextChannels = next.channels;
	const changes = [];
	for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
		if (PSEUDO_CHANNEL_KEYS.has(channelName) || !channelConfig || typeof channelConfig !== "object") continue;
		if (isDisabled(channelConfig)) continue;
		if (!getDoctorChannelCapabilities(channelName).groupAllowFromFallbackToAllowFrom) continue;
		const hadGroupAllowFrom = readGroupAllowFrom(channelConfig).length > 0;
		migrateRecord({
			account: channelConfig,
			canWriteGroupAllowFrom: generatedSchemaAllowsGroupAllowFrom(channelName, CHANNEL_GROUP_ALLOW_FROM_PATH),
			channelName,
			changes,
			prefix: `channels.${channelName}`
		});
		const accounts = asObjectRecord(channelConfig.accounts);
		if (!accounts) continue;
		const canWriteAccountGroupAllowFrom = generatedSchemaAllowsGroupAllowFrom(channelName, ACCOUNT_GROUP_ALLOW_FROM_PATH);
		for (const [accountId, accountConfig] of Object.entries(accounts)) {
			const account = asObjectRecord(accountConfig);
			if (!account || isDisabled(account)) continue;
			migrateRecord({
				account,
				canWriteGroupAllowFrom: canWriteAccountGroupAllowFrom,
				channelName,
				changes,
				parent: channelConfig,
				parentHadGroupAllowFrom: hadGroupAllowFrom,
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
function hasParentPathSegment(value) {
	return value.split(/[\\/]+/u).includes("..");
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
function isInstallStageDebrisName(name) {
	return /^\.openclaw-install-stage(?:-.+)?$/u.test(name);
}
function isLegacyDependencyDebrisName(name) {
	return isRuntimeDependencyMarkerName(name) || name === ".openclaw-pnpm-store" || name === ".openclaw-install-backups" || isInstallStageDebrisName(name);
}
function isExpectedLegacyCleanupTargetName(name) {
	return name === "node_modules" || LEGACY_DIRECT_CHILD_NAMES.has(name) || isLegacyDependencyDebrisName(name);
}
async function isFile(targetPath) {
	return (await fs.lstat(targetPath).catch(() => null))?.isFile() === true;
}
function isPathInsideRoot(candidate, root) {
	const relativePath = path.relative(root, candidate);
	return relativePath === "" || !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
async function collectDirectChildren(root) {
	return (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).map((entry) => path.join(root, entry.name));
}
async function isDirectoryInCleanupRoot(candidate, cleanupRootRealPath) {
	const stat = await fs.lstat(candidate).catch(() => null);
	if (!stat?.isDirectory() && !stat?.isSymbolicLink()) return false;
	const realPath = await fs.realpath(candidate).catch(() => null);
	return realPath !== null && isPathInsideRoot(realPath, cleanupRootRealPath);
}
async function collectLegacyExtensionDebris(extensionsRoot, cleanupRootRealPath) {
	if (!await isDirectoryInCleanupRoot(extensionsRoot, cleanupRootRealPath)) return [];
	const pluginDirs = await fs.readdir(extensionsRoot, { withFileTypes: true }).catch(() => []);
	const targets = [];
	for (const entry of pluginDirs) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const pluginRoot = path.join(extensionsRoot, entry.name);
		if (!await isDirectoryInCleanupRoot(pluginRoot, cleanupRootRealPath)) continue;
		const children = await collectDirectChildren(pluginRoot);
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
function collectCleanupRootPaths(env, packageRoot) {
	const stateDirectoryRoots = splitPathList(env.STATE_DIRECTORY).map((entry) => resolveUserPath(entry, env));
	return uniqueSorted([
		resolveStateDir(env),
		resolveConfigDir(env),
		packageRoot,
		...stateDirectoryRoots
	]);
}
async function collectExistingCleanupRoots(cleanupRootPaths) {
	const roots = [];
	for (const rootPath of cleanupRootPaths) {
		if (!(await fs.stat(rootPath).catch(() => null))?.isDirectory()) continue;
		const realPath = await fs.realpath(rootPath).catch(() => null);
		if (realPath === null) continue;
		roots.push({ realPath });
	}
	return roots;
}
function collectExplicitStageTargets(env) {
	return splitPathList(env.OPENCLAW_PLUGIN_STAGE_DIR).map((entry) => ({
		kind: "explicit-stage",
		path: resolveUserPath(entry, env),
		rawPath: entry
	}));
}
async function hasOpenClawRenameResidue(root) {
	const nodeModulesRoot = path.join(root, "node_modules");
	if (await isFile(path.join(nodeModulesRoot, ".openclaw-rename-tmp"))) return true;
	const entries = await fs.readdir(nodeModulesRoot, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const entryPath = path.join(nodeModulesRoot, entry.name);
		if (await isFile(path.join(entryPath, ".openclaw-rename-tmp"))) return true;
		if (!entry.name.startsWith("@")) continue;
		const scopedEntries = await fs.readdir(entryPath, { withFileTypes: true }).catch(() => []);
		for (const scopedEntry of scopedEntries) {
			if (!scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) continue;
			if (await isFile(path.join(entryPath, scopedEntry.name, ".openclaw-rename-tmp"))) return true;
		}
	}
	return false;
}
async function hasExplicitStageDebrisProof(root) {
	if ((await collectDirectChildren(root)).some((childPath) => isRuntimeDependencyMarkerName(path.basename(childPath)))) return true;
	return await hasOpenClawRenameResidue(root);
}
function filterLegacyStaleRootCandidates(targets, cleanupRootPaths) {
	const safeTargets = [];
	const warnings = [];
	const seen = /* @__PURE__ */ new Set();
	for (const target of targets) {
		const targetPath = path.resolve(target.path);
		if (seen.has(targetPath)) continue;
		seen.add(targetPath);
		if (target.kind === "explicit-stage") {
			if (target.rawPath && hasParentPathSegment(target.rawPath)) {
				warnings.push(`Skipped legacy plugin dependency state ${targetPath}: parent path segments are not allowed`);
				continue;
			}
			safeTargets.push({
				...target,
				path: targetPath
			});
			continue;
		}
		if (!isExpectedLegacyCleanupTargetName(path.basename(targetPath))) {
			warnings.push(`Skipped legacy plugin dependency state ${targetPath}: unexpected path name`);
			continue;
		}
		if (!cleanupRootPaths.some((rootPath) => isPathInsideRoot(targetPath, rootPath))) {
			warnings.push(`Skipped legacy plugin dependency state ${targetPath}: outside OpenClaw cleanup roots`);
			continue;
		}
		safeTargets.push({
			...target,
			path: targetPath
		});
	}
	return {
		targets: safeTargets.toSorted((left, right) => left.path.localeCompare(right.path)),
		warnings
	};
}
async function resolveSafeRemovalTarget(target, cleanupRoots) {
	const targetPath = path.resolve(target.path);
	const stat = await fs.lstat(targetPath).catch(() => null);
	if (target.kind === "explicit-stage" && stat?.isSymbolicLink()) return { warning: `Skipped legacy plugin dependency state ${targetPath}: symbolic link roots are not removed` };
	const realPath = await fs.realpath(targetPath).catch(() => null);
	if (realPath === null) return { warning: `Skipped legacy plugin dependency state ${targetPath}: could not resolve path` };
	if (target.kind === "explicit-stage") {
		if (!isInstallStageDebrisName(path.basename(targetPath)) && !await hasExplicitStageDebrisProof(targetPath)) return { warning: `Skipped legacy plugin dependency state ${targetPath}: unexpected path name` };
		return { target: targetPath };
	}
	if (!cleanupRoots.some((root) => isPathInsideRoot(realPath, root.realPath))) return { warning: `Skipped legacy plugin dependency state ${targetPath}: resolved outside OpenClaw cleanup roots` };
	return { target: targetPath };
}
async function prepareCleanupTargets(targets, cleanupRoots) {
	const removalTargets = [];
	const staleRoots = [];
	const warnings = [];
	for (const target of targets) {
		if (!await pathExists(target.path)) continue;
		const safeTarget = await resolveSafeRemovalTarget(target, cleanupRoots);
		if ("warning" in safeTarget) {
			warnings.push(safeTarget.warning);
			continue;
		}
		removalTargets.push(safeTarget.target);
		staleRoots.push(safeTarget.target);
	}
	return {
		removalTargets: uniqueSorted(removalTargets),
		staleRoots: uniqueSorted(staleRoots),
		warnings
	};
}
async function collectLegacyPluginDependencyTargetEntries(env = process.env, options = {}) {
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
	const stateDirectoryRoots = splitPathList(env.STATE_DIRECTORY).map((entry) => ({
		kind: "legacy",
		path: path.join(resolveUserPath(entry, env), "plugin-runtime-deps")
	}));
	const targets = [
		...collectExplicitStageTargets(env),
		...stateDirectoryRoots,
		...roots.flatMap((root) => [...[...LEGACY_DIRECT_CHILD_NAMES].map((name) => ({
			kind: "legacy",
			path: path.join(root, name)
		})), {
			kind: "legacy",
			path: path.join(root, ".local", "bundled-plugin-runtime-deps")
		}])
	];
	for (const root of roots) {
		const rootRealPath = await fs.realpath(root).catch(() => null);
		if (rootRealPath === null) continue;
		targets.push(...(await collectLegacyExtensionDebris(path.join(root, "extensions"), rootRealPath)).map((targetPath) => ({
			kind: "legacy",
			path: targetPath
		})));
		targets.push(...(await collectLegacyExtensionDebris(path.join(root, "dist", "extensions"), rootRealPath)).map((targetPath) => ({
			kind: "legacy",
			path: targetPath
		})));
	}
	return targets.toSorted((left, right) => left.path.localeCompare(right.path));
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
	const targets = await collectLegacyPluginDependencyTargetEntries(env, { packageRoot });
	const cleanupRootPaths = collectCleanupRootPaths(env, packageRoot);
	const cleanupRoots = await collectExistingCleanupRoots(cleanupRootPaths);
	const staleRootCandidates = filterLegacyStaleRootCandidates(targets, cleanupRootPaths);
	warnings.push(...staleRootCandidates.warnings);
	const preparedTargets = await prepareCleanupTargets(staleRootCandidates.targets, cleanupRoots);
	warnings.push(...preparedTargets.warnings);
	const staleSymlinks = await removeStalePluginRuntimeSymlinks(packageRoot, { staleRoots: preparedTargets.staleRoots });
	changes.push(...staleSymlinks.changes);
	warnings.push(...staleSymlinks.warnings);
	for (const target of preparedTargets.removalTargets) try {
		await fs.rm(target, {
			recursive: true,
			force: true
		});
		changes.push(`Removed legacy plugin dependency state: ${target}`);
	} catch (error) {
		warnings.push(`Failed to remove legacy plugin dependency state ${target}: ${String(error)}`);
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
	applyMutation(await maybeRepairContextEngineHostCompatibility({
		cfg: state.candidate,
		doctorFixCommand: params.doctorFixCommand,
		env
	}));
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
	const failedPluginIds = missingConfiguredPluginInstallRepair.failedPluginIds ?? [];
	const hasUnscopedInstallRepairWarnings = missingConfiguredPluginInstallRepair.warnings.length > 0 && failedPluginIds.length === 0;
	if (!isUpdatePackageSwapInProgress(env) && !hasUnscopedInstallRepairWarnings) applyMutation(maybeRepairStalePluginConfig(state.candidate, env, { preservePluginIds: failedPluginIds }));
	applyMutation(maybeRepairInvalidPluginConfig(state.candidate));
	applyMutation(await maybeRepairAllowlistPolicyAllowFrom(state.candidate));
	applyMutation(maybeRepairOpenPolicyAllowFrom(state.candidate));
	applyMutation(maybeRepairGroupAllowFromFallback(state.candidate));
	applyMutation(maybeRepairStaleSubagentAllowlists(state.candidate));
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
	const legacyOAuthSidecarRepair = await maybeRepairLegacyOAuthSidecarProfiles({
		cfg: state.candidate,
		prompter: { confirmAutoFix: async () => true },
		emitNotes: false,
		env
	});
	if (legacyOAuthSidecarRepair.changes.length > 0) changeNotes.push(sanitizeLines(legacyOAuthSidecarRepair.changes));
	if (legacyOAuthSidecarRepair.warnings.length > 0) warningNotes.push(sanitizeLines(legacyOAuthSidecarRepair.warnings));
	const staleOAuthShadowRepair = await repairStaleOAuthProfileShadows({
		cfg: state.candidate,
		env
	});
	if (staleOAuthShadowRepair.changes.length > 0) changeNotes.push(sanitizeLines(staleOAuthShadowRepair.changes));
	if (staleOAuthShadowRepair.warnings.length > 0) warningNotes.push(sanitizeLines(staleOAuthShadowRepair.warnings));
	return {
		state,
		changeNotes,
		warningNotes
	};
}
//#endregion
export { runDoctorRepairSequence };
