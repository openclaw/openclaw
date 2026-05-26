import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { u as pathExists$1 } from "./utils-sBTEdeml.js";
import { i as resolveGatewayInstallEntrypoint } from "./gateway-entrypoint-Ccw3PW9J.js";
import { t as movePathWithCopyFallback } from "./replace-file-C7_Inj8B.js";
import { a as readJsonIfExists } from "./json-files-C2hqjU--.js";
import { a as parseSemver } from "./runtime-guard-DLdnBLFm.js";
import { t as resolveStableNodePath } from "./stable-node-path-COOLjGh2.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { n as applyPosixNpmScriptShellEnv, r as createNpmFreshnessBypassArgs, t as applyNpmFreshnessBypassEnv } from "./npm-install-env-BDr63VWf.js";
import { u as trimLogTail } from "./restart-sentinel-BDtpdKoy.js";
import { t as BUNDLED_RUNTIME_SIDECAR_PATHS } from "./runtime-sidecar-paths-Blgi5sh-.js";
import { t as applyPathPrepend } from "./path-prepend-6X5fKWgG.js";
import { a as isBetaTag, n as DEV_BRANCH, o as isStableTag, r as channelToNpmTag } from "./update-channels-f-ieRme5.js";
import { n as readPackageName, r as readPackageVersion } from "./package-json-CWP51tfk.js";
import { n as compareSemverStrings, s as detectPackageManager } from "./update-check-Bp4i15ma.js";
import { a as resolveControlUiDistIndexPathForRoot, r as resolveControlUiDistIndexHealth } from "./control-ui-assets-W5GRTbBr.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
//#region src/infra/package-tag.ts
function normalizePackageTagInput(value, packageNames) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return null;
	for (const packageName of packageNames) {
		if (trimmed === packageName) return null;
		const prefix = `${packageName}@`;
		if (trimmed.startsWith(prefix)) {
			const tag = trimmed.slice(prefix.length).trim();
			return tag ? tag : null;
		}
	}
	return trimmed;
}
const LOCAL_BUILD_METADATA_DIST_PATHS = Object.freeze([`dist/.buildstamp`, `dist/.runtime-postbuildstamp`]);
const LOCAL_BUILD_METADATA_DIST_PATH_SET = new Set(LOCAL_BUILD_METADATA_DIST_PATHS);
function isLocalBuildMetadataDistPath(relativePath) {
	return LOCAL_BUILD_METADATA_DIST_PATH_SET.has(relativePath);
}
//#endregion
//#region src/infra/package-dist-inventory.ts
const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";
const LEGACY_QA_CHANNEL_DIR = ["qa", "channel"].join("-");
const LEGACY_QA_LAB_DIR = ["qa", "lab"].join("-");
const OMITTED_QA_EXTENSION_PREFIXES = [
	`dist/extensions/${LEGACY_QA_CHANNEL_DIR}/`,
	`dist/extensions/${LEGACY_QA_LAB_DIR}/`,
	"dist/extensions/qa-matrix/"
];
const OMITTED_PRIVATE_QA_PLUGIN_SDK_PREFIXES = [`dist/plugin-sdk/extensions/${LEGACY_QA_CHANNEL_DIR}/`, `dist/plugin-sdk/extensions/${LEGACY_QA_LAB_DIR}/`];
const OMITTED_PRIVATE_QA_PLUGIN_SDK_FILES = new Set([
	`dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}.d.ts`,
	`dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}.js`,
	`dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}-protocol.d.ts`,
	`dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}-protocol.js`,
	`dist/plugin-sdk/${LEGACY_QA_LAB_DIR}.d.ts`,
	`dist/plugin-sdk/${LEGACY_QA_LAB_DIR}.js`,
	"dist/plugin-sdk/qa-runtime.d.ts",
	"dist/plugin-sdk/qa-runtime.js",
	`dist/plugin-sdk/src/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}.d.ts`,
	`dist/plugin-sdk/src/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}-protocol.d.ts`,
	`dist/plugin-sdk/src/plugin-sdk/${LEGACY_QA_LAB_DIR}.d.ts`,
	"dist/plugin-sdk/src/plugin-sdk/qa-runtime.d.ts"
]);
const OMITTED_PRIVATE_QA_DIST_PREFIXES = ["dist/qa-runtime-"];
const OMITTED_DIST_SUBTREE_PATTERNS = [
	/^dist\/extensions\/node_modules(?:\/|$)/u,
	/^dist\/extensions\/[^/]+\/node_modules(?:\/|$)/u,
	/^dist\/extensions\/qa-matrix(?:\/|$)/u,
	new RegExp(`^dist/plugin-sdk/extensions/${LEGACY_QA_CHANNEL_DIR}(?:/|$)`, "u"),
	new RegExp(`^dist/plugin-sdk/extensions/${LEGACY_QA_LAB_DIR}(?:/|$)`, "u")
];
function normalizeRelativePath(value) {
	return value.replace(/\\/g, "/");
}
function isLegacyPluginDependencyDirPath(relativePath) {
	const parts = normalizeRelativePath(relativePath).split("/");
	if (parts[0]?.toLowerCase() !== "dist" || parts[1]?.toLowerCase() !== "extensions") return false;
	if ((parts[2] ?? "").toLowerCase() === "node_modules") return true;
	return (parts[3] ?? "").toLowerCase() === "node_modules";
}
function collectExcludedPackagedExtensionDirs(rootPackageJson) {
	if (!rootPackageJson || typeof rootPackageJson !== "object") return /* @__PURE__ */ new Set();
	const files = rootPackageJson.files;
	if (!Array.isArray(files)) return /* @__PURE__ */ new Set();
	const excluded = /* @__PURE__ */ new Set();
	for (const entry of files) {
		if (typeof entry !== "string") continue;
		const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(entry);
		if (match?.[1]) excluded.add(match[1]);
	}
	return excluded;
}
function isExternalizedBundledExtensionDistPath(relativePath, externalizedExtensionIds) {
	if (externalizedExtensionIds.size === 0) return false;
	const parts = normalizeRelativePath(relativePath).split("/");
	return parts.length >= 3 && parts[0] === "dist" && parts[1] === "extensions" && Boolean(parts[2]) && externalizedExtensionIds.has(parts[2] ?? "");
}
async function collectExternalizedBundledExtensionIds(packageRoot) {
	return collectExcludedPackagedExtensionDirs(await readJsonIfExists(path.join(packageRoot, "package.json")));
}
function isPackagedDistPath(relativePath, externalizedExtensionIds) {
	if (!relativePath.startsWith("dist/")) return false;
	if (isExternalizedBundledExtensionDistPath(relativePath, externalizedExtensionIds)) return false;
	if (isLegacyPluginDependencyDirPath(relativePath)) return false;
	if (relativePath === "dist/postinstall-inventory.json") return false;
	if (isLocalBuildMetadataDistPath(relativePath)) return false;
	if (relativePath.endsWith(".map")) return false;
	if (relativePath === "dist/plugin-sdk/.tsbuildinfo") return false;
	if (OMITTED_PRIVATE_QA_PLUGIN_SDK_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) || OMITTED_PRIVATE_QA_PLUGIN_SDK_FILES.has(relativePath) || OMITTED_PRIVATE_QA_DIST_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return false;
	if (OMITTED_QA_EXTENSION_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return false;
	return true;
}
function isOmittedDistSubtree(relativePath, externalizedExtensionIds) {
	return isExternalizedBundledExtensionDistPath(relativePath, externalizedExtensionIds) || isLegacyPluginDependencyDirPath(relativePath) || OMITTED_DIST_SUBTREE_PATTERNS.some((pattern) => pattern.test(relativePath));
}
async function collectRelativeFiles(rootDir, baseDir, externalizedExtensionIds) {
	const rootRelativePath = normalizeRelativePath(path.relative(baseDir, rootDir));
	if (rootRelativePath && isOmittedDistSubtree(rootRelativePath, externalizedExtensionIds)) return [];
	try {
		const rootStats = await fs$1.lstat(rootDir);
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error(`Unsafe package dist path: ${normalizeRelativePath(path.relative(baseDir, rootDir))}`);
		const entries = await fs$1.readdir(rootDir, { withFileTypes: true });
		return (await Promise.all(entries.map(async (entry) => {
			const entryPath = path.join(rootDir, entry.name);
			const relativePath = normalizeRelativePath(path.relative(baseDir, entryPath));
			if (entry.isSymbolicLink()) throw new Error(`Unsafe package dist path: ${relativePath}`);
			if (entry.isDirectory()) return await collectRelativeFiles(entryPath, baseDir, externalizedExtensionIds);
			if (entry.isFile()) return isPackagedDistPath(relativePath, externalizedExtensionIds) ? [relativePath] : [];
			return [];
		}))).flat().toSorted((left, right) => left.localeCompare(right));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}
async function collectPackageDistInventory(packageRoot) {
	const externalizedExtensionIds = await collectExternalizedBundledExtensionIds(packageRoot);
	return await collectRelativeFiles(path.join(packageRoot, "dist"), packageRoot, externalizedExtensionIds);
}
async function readPackageDistInventoryOptional(packageRoot) {
	const parsed = await readJsonIfExists(path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH));
	if (parsed === null) return null;
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error(`Invalid package dist inventory at ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`);
	return [...new Set(parsed.map(normalizeRelativePath))].toSorted((left, right) => left.localeCompare(right));
}
async function readPackageDistInventoryIfPresent(packageRoot) {
	return await readPackageDistInventoryOptional(packageRoot);
}
//#endregion
//#region src/infra/update-global.ts
const PRIMARY_PACKAGE_NAME = "openclaw";
const ALL_PACKAGE_NAMES = [PRIMARY_PACKAGE_NAME];
const GLOBAL_RENAME_PREFIX = ".";
const OPENCLAW_MAIN_PACKAGE_SPEC = "github:openclaw/openclaw#main";
const COREPACK_ENABLE_DOWNLOAD_PROMPT_DEFAULT = "0";
const NPM_GLOBAL_INSTALL_QUIET_FLAGS = [
	"--no-fund",
	"--no-audit",
	"--loglevel=error"
];
const PNPM_OPENCLAW_BUILD_ALLOWLIST_FLAG = `--allow-build=${PRIMARY_PACKAGE_NAME}`;
const FIRST_PACKAGED_DIST_INVENTORY_VERSION = {
	major: 2026,
	minor: 4,
	patch: 15
};
const OMITTED_PRIVATE_QA_BUNDLED_PLUGIN_ROOTS = new Set([
	"dist/extensions/qa-channel",
	"dist/extensions/qa-lab",
	"dist/extensions/qa-matrix"
]);
function normalizePackageTarget(value) {
	return value.trim();
}
function normalizePackageVersionForComparison(value) {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	return trimmed.replace(/^[vV](?=\d)/, "");
}
function isMainPackageTarget(value) {
	return normalizeLowercaseStringOrEmpty(normalizePackageTarget(value)) === "main";
}
function isExplicitPackageInstallSpec(value) {
	const trimmed = normalizePackageTarget(value);
	if (!trimmed) return false;
	return /\.(?:tgz|tar\.gz)$/iu.test(trimmed) || trimmed.includes("://") || trimmed.includes("#") || /^(?:file|github|git\+ssh|git\+https|git\+http|git\+file|npm):/i.test(trimmed);
}
function stripPrimaryPackageAlias(spec) {
	const normalized = normalizePackageTarget(spec);
	const prefix = `${PRIMARY_PACKAGE_NAME}@`;
	return normalized.toLowerCase().startsWith(prefix) ? normalized.slice(prefix.length).trim() : normalized;
}
function isPnpmOpenClawSourceInstallSpec(spec) {
	const target = stripPrimaryPackageAlias(spec);
	return /^github:/i.test(target) || /^git\+(?:ssh|https|http|file):/i.test(target) || /^git:/i.test(target);
}
function resolveExpectedInstalledVersionFromSpec(packageName, spec) {
	const normalizedPackageName = packageName.trim();
	const normalizedSpec = normalizePackageTarget(spec);
	if (!normalizedPackageName || !normalizedSpec.startsWith(`${normalizedPackageName}@`)) return null;
	const rawVersion = normalizedSpec.slice(normalizedPackageName.length + 1).trim();
	if (!rawVersion || rawVersion.includes("/") || rawVersion.includes(":") || rawVersion.includes("#") || /^(latest|beta|next|main)$/i.test(rawVersion)) return null;
	return normalizePackageVersionForComparison(rawVersion);
}
async function collectInstalledGlobalPackageErrors(params) {
	const errors = [];
	errors.push(...await collectSourceCheckoutInstallErrors(params.packageRoot));
	const installedVersion = await readPackageVersion(params.packageRoot);
	const expectedComparable = normalizePackageVersionForComparison(params.expectedVersion);
	const installedComparable = normalizePackageVersionForComparison(installedVersion);
	if (expectedComparable && installedComparable !== expectedComparable) errors.push(`expected installed version ${expectedComparable}, found ${installedComparable ?? "<missing>"}`);
	errors.push(...await collectInstalledPackageDistErrors({
		packageRoot: params.packageRoot,
		installedVersion,
		expectedVersion: params.expectedVersion
	}));
	return errors;
}
async function collectSourceCheckoutInstallErrors(packageRoot) {
	const realPackageRoot = await tryRealpath(packageRoot);
	return (await pathExists$1(path.join(realPackageRoot, ".git")) || await pathExists$1(path.join(realPackageRoot, "pnpm-workspace.yaml"))) && await pathExists$1(path.join(realPackageRoot, "src")) && await pathExists$1(path.join(realPackageRoot, "extensions")) ? [`global package root resolves to source checkout: ${realPackageRoot}`] : [];
}
function shouldRequirePackagedDistInventory(version) {
	const parsed = parseSemver(version ?? null);
	if (!parsed) return false;
	if (parsed.major !== FIRST_PACKAGED_DIST_INVENTORY_VERSION.major) return parsed.major > FIRST_PACKAGED_DIST_INVENTORY_VERSION.major;
	if (parsed.minor !== FIRST_PACKAGED_DIST_INVENTORY_VERSION.minor) return parsed.minor > FIRST_PACKAGED_DIST_INVENTORY_VERSION.minor;
	return parsed.patch >= FIRST_PACKAGED_DIST_INVENTORY_VERSION.patch;
}
async function collectInstalledPackageDistErrors(params) {
	const criticalPaths = await collectCriticalInstalledPackageDistPaths(params.packageRoot);
	let inventoryFiles = null;
	let inventoryError = null;
	try {
		inventoryFiles = await readPackageDistInventoryIfPresent(params.packageRoot);
	} catch {
		inventoryError = `invalid package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`;
	}
	if (inventoryFiles !== null) {
		const actualFiles = await collectPackageDistInventory(params.packageRoot);
		const inventoryErrors = await collectInstalledPathErrors({
			packageRoot: params.packageRoot,
			expectedFiles: inventoryFiles,
			actualFiles,
			missingMessage: (relativePath) => `missing packaged dist file ${relativePath}`,
			unexpectedMessage: (relativePath) => `unexpected packaged dist file ${relativePath}`
		});
		const inventorySet = new Set(inventoryFiles);
		const supplementalCriticalPaths = criticalPaths.filter((relativePath) => !inventorySet.has(relativePath));
		if (supplementalCriticalPaths.length === 0) return inventoryErrors;
		return [...inventoryErrors, ...await collectInstalledPathErrors({
			packageRoot: params.packageRoot,
			expectedFiles: supplementalCriticalPaths,
			actualFiles,
			missingMessage: (relativePath) => `missing bundled runtime sidecar ${relativePath}`
		})];
	}
	const criticalErrors = await collectInstalledPathErrors({
		packageRoot: params.packageRoot,
		expectedFiles: await collectLegacyInstalledPackageDistPaths(params.packageRoot),
		actualFiles: null,
		missingMessage: (relativePath) => `missing bundled runtime sidecar ${relativePath}`
	});
	if (inventoryError) return [inventoryError, ...criticalErrors];
	if (shouldRequirePackagedDistInventory(params.installedVersion) || shouldRequirePackagedDistInventory(params.expectedVersion)) return [`missing package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`, ...criticalErrors];
	return criticalErrors;
}
async function collectLegacyInstalledPackageDistPaths(packageRoot) {
	return await collectCriticalInstalledPackageDistPaths(packageRoot);
}
async function collectCriticalInstalledPackageDistPaths(packageRoot) {
	const expectedFiles = /* @__PURE__ */ new Set();
	await Promise.all(BUNDLED_RUNTIME_SIDECAR_PATHS.map(async (relativePath) => {
		const pluginRoot = resolveBundledPluginRoot(relativePath);
		if (pluginRoot === null) return;
		if (OMITTED_PRIVATE_QA_BUNDLED_PLUGIN_ROOTS.has(pluginRoot)) return;
		if (await pathExists$1(path.join(packageRoot, pluginRoot, "package.json")) || await pathExists$1(path.join(packageRoot, pluginRoot, "openclaw.plugin.json"))) expectedFiles.add(relativePath);
	}));
	return [...expectedFiles].toSorted((left, right) => left.localeCompare(right));
}
function resolveBundledPluginRoot(relativePath) {
	const match = /^dist\/extensions\/[^/]+/u.exec(relativePath);
	return match ? match[0] : null;
}
async function collectInstalledPathErrors(params) {
	const errors = [];
	const actualSet = params.actualFiles ? new Set(params.actualFiles) : null;
	for (const relativePath of params.expectedFiles) if (!(actualSet !== null ? actualSet.has(relativePath) : await pathExists$1(path.join(params.packageRoot, relativePath)))) errors.push(params.missingMessage(relativePath));
	if (actualSet !== null && params.unexpectedMessage) {
		const expectedSet = new Set(params.expectedFiles);
		for (const relativePath of params.actualFiles ?? []) if (!expectedSet.has(relativePath)) errors.push(params.unexpectedMessage(relativePath));
	}
	return errors;
}
function canResolveRegistryVersionForPackageTarget(value) {
	const trimmed = normalizePackageTarget(value);
	if (!trimmed) return true;
	return !isMainPackageTarget(trimmed) && !isExplicitPackageInstallSpec(trimmed);
}
async function resolvePortableGitPathPrepend() {
	if (process.platform !== "win32") return [];
	const localAppData = process.env.LOCALAPPDATA?.trim();
	if (!localAppData) return [];
	const portableGitRoot = path.join(localAppData, "OpenClaw", "deps", "portable-git");
	const candidates = [
		path.join(portableGitRoot, "mingw64", "bin"),
		path.join(portableGitRoot, "usr", "bin"),
		path.join(portableGitRoot, "cmd"),
		path.join(portableGitRoot, "bin")
	];
	const existing = [];
	for (const candidate of candidates) if (await pathExists$1(candidate)) existing.push(candidate);
	return existing;
}
function applyWindowsPackageInstallEnv(env) {
	if (process.platform !== "win32") return;
	env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
	env.NPM_CONFIG_FUND = "false";
	env.NPM_CONFIG_AUDIT = "false";
	env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1";
}
function applyCorepackDownloadPromptEnv(env) {
	if (!env.COREPACK_ENABLE_DOWNLOAD_PROMPT?.trim()) env.COREPACK_ENABLE_DOWNLOAD_PROMPT = COREPACK_ENABLE_DOWNLOAD_PROMPT_DEFAULT;
}
function resolveGlobalInstallSpec(params) {
	const override = params.env?.OPENCLAW_UPDATE_PACKAGE_SPEC?.trim() || process.env.OPENCLAW_UPDATE_PACKAGE_SPEC?.trim();
	if (override) return override;
	const target = normalizePackageTarget(params.tag);
	if (isMainPackageTarget(target)) return OPENCLAW_MAIN_PACKAGE_SPEC;
	if (isExplicitPackageInstallSpec(target)) return target;
	return `${params.packageName}@${target}`;
}
async function createGlobalInstallEnv(env) {
	const pathPrepend = await resolvePortableGitPathPrepend();
	const sourceEnv = env ?? process.env;
	const merged = Object.fromEntries(Object.entries(sourceEnv).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
	applyPathPrepend(merged, pathPrepend);
	applyWindowsPackageInstallEnv(merged);
	applyCorepackDownloadPromptEnv(merged);
	applyNpmFreshnessBypassEnv(merged);
	applyPosixNpmScriptShellEnv(merged);
	return merged;
}
async function tryRealpath(targetPath) {
	try {
		return await fs$1.realpath(targetPath);
	} catch {
		return path.resolve(targetPath);
	}
}
function resolveBunGlobalRoot() {
	const bunInstall = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
	return path.join(bunInstall, "install", "global", "node_modules");
}
function inferNpmPrefixFromPackageRoot(pkgRoot) {
	const trimmed = pkgRoot?.trim();
	if (!trimmed) return null;
	const normalized = path.resolve(trimmed);
	const nodeModulesDir = path.dirname(normalized);
	if (path.basename(nodeModulesDir) !== "node_modules") return null;
	const parentDir = path.dirname(nodeModulesDir);
	if (path.basename(parentDir) === "lib") return path.dirname(parentDir);
	if (process.platform === "win32" && normalizeLowercaseStringOrEmpty(path.basename(parentDir)) === "npm") return parentDir;
	return null;
}
function resolveNpmGlobalPrefixLayoutFromGlobalRoot(globalRoot, options = {}) {
	const trimmed = globalRoot?.trim();
	if (!trimmed) return null;
	const normalized = path.resolve(trimmed);
	if (path.basename(normalized) !== "node_modules") return null;
	const parentDir = path.dirname(normalized);
	if (path.basename(parentDir) === "lib") {
		const prefix = path.dirname(parentDir);
		return {
			prefix,
			globalRoot: normalized,
			binDir: path.join(prefix, "bin")
		};
	}
	if (process.platform === "win32") return {
		prefix: parentDir,
		globalRoot: normalized,
		binDir: parentDir
	};
	if (options.allowDirectNodeModulesRoot) return {
		prefix: parentDir,
		globalRoot: normalized,
		binDir: path.join(normalized, ".bin")
	};
	return null;
}
function resolveNpmGlobalPrefixLayoutFromPrefix(prefix) {
	const resolvedPrefix = path.resolve(prefix);
	if (process.platform === "win32") return {
		prefix: resolvedPrefix,
		globalRoot: path.join(resolvedPrefix, "node_modules"),
		binDir: resolvedPrefix
	};
	return {
		prefix: resolvedPrefix,
		globalRoot: path.join(resolvedPrefix, "lib", "node_modules"),
		binDir: path.join(resolvedPrefix, "bin")
	};
}
function resolvePreferredNpmCommand(pkgRoot) {
	const prefix = inferNpmPrefixFromPackageRoot(pkgRoot);
	if (!prefix) return null;
	const candidate = process.platform === "win32" ? path.join(prefix, "npm.cmd") : path.join(prefix, "bin", "npm");
	return fs.existsSync(candidate) ? candidate : null;
}
function inferGlobalRootFromPackageRoot(pkgRoot) {
	const trimmed = pkgRoot?.trim();
	if (!trimmed) return null;
	const normalized = path.resolve(trimmed);
	const globalRoot = path.dirname(normalized);
	return path.basename(globalRoot) === "node_modules" ? globalRoot : null;
}
function isDirectNpmNodeModulesRoot(globalRoot) {
	return globalRoot !== null && resolveNpmGlobalPrefixLayoutFromGlobalRoot(globalRoot) === null && resolveNpmGlobalPrefixLayoutFromGlobalRoot(globalRoot, { allowDirectNodeModulesRoot: true }) !== null;
}
function inferBunGlobalRootFromPackageRoot(pkgRoot) {
	const directGlobalRoot = inferGlobalRootFromPackageRoot(pkgRoot);
	if (!directGlobalRoot) return null;
	return path.resolve(directGlobalRoot) === path.resolve(resolveBunGlobalRoot()) ? directGlobalRoot : null;
}
function inferPnpmGlobalRootFromPackageRoot(pkgRoot) {
	const directGlobalRoot = inferGlobalRootFromPackageRoot(pkgRoot);
	if (resolvePnpmGlobalDirFromGlobalRoot(directGlobalRoot)) return directGlobalRoot;
	const trimmed = pkgRoot?.trim();
	if (!trimmed) return null;
	const parts = path.resolve(trimmed).split(path.sep);
	const pnpmIndex = parts.lastIndexOf(".pnpm");
	if (pnpmIndex <= 0) return null;
	if (parts[pnpmIndex + 2] !== "node_modules") return null;
	const layoutDir = parts.slice(0, pnpmIndex).join(path.sep) || path.sep;
	const globalRoot = path.basename(layoutDir) === "node_modules" ? layoutDir : path.join(layoutDir, "node_modules");
	return resolvePnpmGlobalDirFromGlobalRoot(globalRoot) ? globalRoot : null;
}
function resolvePnpmGlobalDirFromGlobalRoot(globalRoot) {
	const trimmed = globalRoot?.trim();
	if (!trimmed) return null;
	const normalized = path.resolve(trimmed);
	if (path.basename(normalized) !== "node_modules") return null;
	const layoutDir = path.dirname(normalized);
	return /^\d+$/u.test(path.basename(layoutDir)) ? path.dirname(layoutDir) : null;
}
async function isPnpmGlobalPackageRoot(pkgRoot) {
	const globalRoot = inferPnpmGlobalRootFromPackageRoot(pkgRoot);
	if (!globalRoot) return false;
	const layoutDir = path.dirname(globalRoot);
	if (!await pathExists$1(path.join(globalRoot, ".modules.yaml"))) return false;
	return await pathExists$1(path.join(layoutDir, "pnpm-lock.yaml")) || await pathExists$1(path.join(layoutDir, "package.json"));
}
function resolvePreferredGlobalManagerCommand(manager, pkgRoot) {
	if (manager !== "npm") return manager;
	return resolvePreferredNpmCommand(pkgRoot) ?? manager;
}
function resolveGlobalInstallCommand(manager, pkgRoot) {
	return {
		manager,
		command: resolvePreferredGlobalManagerCommand(manager, pkgRoot)
	};
}
function normalizeGlobalInstallCommand(managerOrCommand, pkgRoot) {
	return typeof managerOrCommand === "string" ? resolveGlobalInstallCommand(managerOrCommand, pkgRoot) : managerOrCommand;
}
function resolveInstallCommandForManager(managerOrCommand, manager, pkgRoot) {
	const normalized = normalizeGlobalInstallCommand(managerOrCommand, pkgRoot);
	return normalized.manager === manager ? normalized : resolveGlobalInstallCommand(manager, pkgRoot);
}
async function resolveGlobalRoot(managerOrCommand, runCommand, timeoutMs, pkgRoot) {
	const resolved = normalizeGlobalInstallCommand(managerOrCommand, pkgRoot);
	if (resolved.manager === "bun") return resolveBunGlobalRoot();
	const res = await runCommand([
		resolved.command,
		"root",
		"-g"
	], { timeoutMs }).catch(() => null);
	if (!res || res.code !== 0) return null;
	return res.stdout.trim() || null;
}
async function resolveGlobalInstallTarget(params) {
	const honoredPackageRootGlobalRoot = params.honorPackageRoot ? inferGlobalRootFromPackageRoot(params.pkgRoot) : null;
	const pnpmPackageRootGlobalRoot = await isPnpmGlobalPackageRoot(params.pkgRoot) ? inferPnpmGlobalRootFromPackageRoot(params.pkgRoot) : null;
	const bunPackageRootGlobalRoot = inferBunGlobalRootFromPackageRoot(params.pkgRoot);
	const honoredDirectNpmRoot = pnpmPackageRootGlobalRoot === null && bunPackageRootGlobalRoot === null && isDirectNpmNodeModulesRoot(honoredPackageRootGlobalRoot);
	const command = bunPackageRootGlobalRoot ? resolveInstallCommandForManager(params.manager, "bun", params.pkgRoot) : pnpmPackageRootGlobalRoot ? resolveInstallCommandForManager(params.manager, "pnpm", params.pkgRoot) : honoredDirectNpmRoot ? resolveInstallCommandForManager(params.manager, "npm", params.pkgRoot) : normalizeGlobalInstallCommand(params.manager, params.pkgRoot);
	const globalRoot = await resolveGlobalRoot(command, params.runCommand, params.timeoutMs, params.pkgRoot);
	const pkgRootGlobalRoot = command.manager === "pnpm" ? pnpmPackageRootGlobalRoot : null;
	const targetGlobalRoot = (command.manager === "bun" ? bunPackageRootGlobalRoot : null) ?? pkgRootGlobalRoot ?? (command.manager === "npm" ? honoredPackageRootGlobalRoot : null) ?? globalRoot;
	return {
		...command,
		globalRoot: targetGlobalRoot,
		packageRoot: targetGlobalRoot ? path.join(targetGlobalRoot, PRIMARY_PACKAGE_NAME) : null,
		...honoredPackageRootGlobalRoot && targetGlobalRoot === honoredPackageRootGlobalRoot && honoredDirectNpmRoot ? { directNodeModulesRoot: true } : {}
	};
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
	if (await isPnpmGlobalPackageRoot(pkgRoot)) return "pnpm";
	const bunGlobalReal = await tryRealpath(resolveBunGlobalRoot());
	for (const name of ALL_PACKAGE_NAMES) {
		const bunExpectedReal = await tryRealpath(path.join(bunGlobalReal, name));
		if (path.resolve(bunExpectedReal) === path.resolve(pkgReal)) return "bun";
	}
	if (resolvePreferredNpmCommand(pkgRoot)) return "npm";
	return null;
}
async function detectGlobalInstallManagerByPresence(runCommand, timeoutMs) {
	for (const manager of ["npm", "pnpm"]) {
		const root = await resolveGlobalRoot(manager, runCommand, timeoutMs);
		if (!root) continue;
		for (const name of ALL_PACKAGE_NAMES) if (await pathExists$1(path.join(root, name))) return manager;
	}
	const bunRoot = resolveBunGlobalRoot();
	for (const name of ALL_PACKAGE_NAMES) if (await pathExists$1(path.join(bunRoot, name))) return "bun";
	return null;
}
function globalInstallArgs(managerOrCommand, spec, pkgRoot, installPrefix) {
	const resolved = normalizeGlobalInstallCommand(managerOrCommand, pkgRoot);
	if (resolved.manager === "pnpm") return [
		resolved.command,
		"add",
		"-g",
		...installPrefix ? ["--global-dir", installPrefix] : [],
		...isPnpmOpenClawSourceInstallSpec(spec) ? [PNPM_OPENCLAW_BUILD_ALLOWLIST_FLAG] : [],
		spec
	];
	if (resolved.manager === "bun") return [
		resolved.command,
		"add",
		"-g",
		spec
	];
	return [
		resolved.command,
		"i",
		"-g",
		...installPrefix ? ["--prefix", installPrefix] : [],
		spec,
		...NPM_GLOBAL_INSTALL_QUIET_FLAGS,
		...createNpmFreshnessBypassArgs(process.env, /* @__PURE__ */ new Date(), { npmConfigPrefix: installPrefix })
	];
}
function globalInstallFallbackArgs(managerOrCommand, spec, pkgRoot, installPrefix) {
	const resolved = normalizeGlobalInstallCommand(managerOrCommand, pkgRoot);
	if (resolved.manager !== "npm") return null;
	return [
		resolved.command,
		"i",
		"-g",
		...installPrefix ? ["--prefix", installPrefix] : [],
		spec,
		"--omit=optional",
		...NPM_GLOBAL_INSTALL_QUIET_FLAGS,
		...createNpmFreshnessBypassArgs(process.env, /* @__PURE__ */ new Date(), { npmConfigPrefix: installPrefix })
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
		entries = await fs$1.readdir(root);
	} catch {
		return { removed };
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const target = path.join(root, entry);
		try {
			if (!(await fs$1.lstat(target)).isDirectory()) continue;
			await fs$1.rm(target, {
				recursive: true,
				force: true
			});
			removed.push(entry);
		} catch {}
	}
	return { removed };
}
//#endregion
//#region src/infra/package-update-steps.ts
const NPM_PACK_QUIET_FLAGS = ["--json", "--loglevel=error"];
function formatError(err) {
	return err instanceof Error ? err.message : String(err);
}
async function removePathBestEffort(targetPath) {
	await fs$1.rm(targetPath, {
		recursive: true,
		force: true,
		maxRetries: process.platform === "win32" ? 5 : 2,
		retryDelay: 100
	}).catch(() => void 0);
}
async function readPackageVersionIfPresent(packageRoot) {
	if (!packageRoot) return null;
	try {
		return await readPackageVersion(packageRoot);
	} catch {
		return null;
	}
}
function isUnambiguousNpmPrefixGlobalRoot(globalRoot) {
	const trimmed = globalRoot?.trim();
	if (!trimmed) return false;
	const normalized = path.resolve(trimmed);
	if (path.basename(normalized) !== "node_modules") return false;
	const parentDir = path.dirname(normalized);
	if (path.basename(parentDir) === "lib") return true;
	return process.platform === "win32" && path.basename(parentDir).toLowerCase() === "npm";
}
function resolveStagedNpmTargetLayout(installTarget) {
	const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot, { allowDirectNodeModulesRoot: installTarget.directNodeModulesRoot === true });
	if (!targetLayout) return null;
	if (installTarget.manager === "npm" || isUnambiguousNpmPrefixGlobalRoot(installTarget.globalRoot)) return targetLayout;
	return null;
}
function stripPackageAlias(spec, packageName) {
	const trimmed = spec.trim();
	const prefix = `${packageName.trim()}@`;
	return trimmed.toLowerCase().startsWith(prefix.toLowerCase()) ? trimmed.slice(prefix.length).trim() : trimmed;
}
function isHttpGitUrlSpec(spec) {
	try {
		const url = new URL(spec);
		if (url.protocol !== "https:" && url.protocol !== "http:") return false;
		const pathname = url.pathname.replace(/\/+$/u, "");
		if (pathname.endsWith(".git")) return true;
		const parts = pathname.split("/").filter(Boolean);
		return url.hostname.toLowerCase() === "github.com" && parts.length === 2;
	} catch {
		return false;
	}
}
function isGitHubShorthandSpec(spec) {
	const [repo] = spec.split("#", 1);
	if (!repo || repo.startsWith(".") || repo.startsWith("/") || repo.startsWith("@")) return false;
	const parts = repo.split("/");
	return parts.length === 2 && parts.every((part) => /^[^\s/:@]+$/u.test(part));
}
function isNpmGitSourceInstallSpec(spec, packageName) {
	const target = stripPackageAlias(spec, packageName);
	return /^github:/i.test(target) || /^git\+(?:ssh|https|http|file):/i.test(target) || /^git:/i.test(target) || /^ssh:\/\//i.test(target) || /^[^@\s]+@[^:\s]+:[^#\s]+(?:#.*)?$/u.test(target) || isHttpGitUrlSpec(target) || isGitHubShorthandSpec(target);
}
async function createStagedNpmInstall(installTarget, packageName) {
	const targetLayout = resolveStagedNpmTargetLayout(installTarget);
	if (!targetLayout) return null;
	await fs$1.mkdir(targetLayout.globalRoot, { recursive: true });
	const prefix = await fs$1.mkdtemp(path.join(targetLayout.globalRoot, ".openclaw-update-stage-"));
	const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
	const command = installTarget.manager === "npm" ? installTarget.command : "npm";
	return {
		prefix,
		layout,
		packageRoot: path.join(layout.globalRoot, packageName),
		installTarget: {
			manager: "npm",
			command,
			globalRoot: layout.globalRoot,
			packageRoot: path.join(layout.globalRoot, packageName)
		}
	};
}
async function findPackedTarball(packDir) {
	const tarballs = (await fs$1.readdir(packDir).catch(() => [])).filter((entry) => entry.endsWith(".tgz"));
	if (tarballs.length !== 1) return null;
	return path.join(packDir, tarballs[0] ?? "");
}
async function prepareNpmGitSourceInstallSpec(params) {
	if (params.installTarget.manager !== "npm" || !isNpmGitSourceInstallSpec(params.installSpec, params.packageName)) return {
		installSpec: params.installSpec,
		packDir: null,
		steps: [],
		failedStep: null
	};
	const packDir = await fs$1.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pack-"));
	const packStep = await params.runStep({
		name: "global update pack",
		argv: [
			params.installTarget.command,
			"pack",
			params.installSpec,
			"--pack-destination",
			packDir,
			...NPM_PACK_QUIET_FLAGS
		],
		cwd: params.installCwd,
		env: params.env,
		timeoutMs: params.timeoutMs
	});
	if (packStep.exitCode !== 0) return {
		installSpec: params.installSpec,
		packDir,
		steps: [packStep],
		failedStep: packStep
	};
	const tarball = await findPackedTarball(packDir);
	if (!tarball) {
		const failedStep = {
			name: "global update pack verify",
			command: `find packed tarball in ${packDir}`,
			cwd: packDir,
			durationMs: 0,
			exitCode: 1,
			stdoutTail: null,
			stderrTail: `expected exactly one .tgz from npm pack ${params.installSpec}`
		};
		return {
			installSpec: params.installSpec,
			packDir,
			steps: [packStep, failedStep],
			failedStep
		};
	}
	return {
		installSpec: tarball,
		packDir,
		steps: [packStep],
		failedStep: null
	};
}
async function prepareStagedNpmInstall(installTarget, packageName) {
	const startedAt = Date.now();
	try {
		return {
			stagedInstall: await createStagedNpmInstall(installTarget, packageName),
			failedStep: null
		};
	} catch (err) {
		return {
			stagedInstall: null,
			failedStep: {
				name: "global install stage",
				command: "prepare staged npm install",
				cwd: (installTarget.manager === "npm" ? resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot, { allowDirectNodeModulesRoot: installTarget.directNodeModulesRoot === true }) : null)?.prefix ?? installTarget.globalRoot ?? process.cwd(),
				durationMs: Date.now() - startedAt,
				exitCode: 1,
				stdoutTail: null,
				stderrTail: formatError(err)
			}
		};
	}
}
async function cleanupStagedNpmInstall(stage) {
	if (!stage) return;
	await removePathBestEffort(stage.prefix);
}
async function copyPathEntry(source, destination) {
	const stat = await fs$1.lstat(source);
	await removePathBestEffort(destination);
	if (stat.isSymbolicLink()) {
		await fs$1.symlink(await fs$1.readlink(source), destination);
		return;
	}
	if (stat.isDirectory()) {
		await fs$1.cp(source, destination, {
			recursive: true,
			force: true,
			preserveTimestamps: false
		});
		return;
	}
	await fs$1.copyFile(source, destination);
	await fs$1.chmod(destination, stat.mode).catch(() => void 0);
}
async function replaceNpmBinShims(params) {
	let entries = [];
	try {
		entries = await fs$1.readdir(params.stageLayout.binDir);
	} catch {
		return;
	}
	const names = new Set([params.packageName, "openclaw"]);
	const shimEntries = entries.filter((entry) => {
		const parsed = path.parse(entry);
		return names.has(entry) || names.has(parsed.name);
	});
	if (shimEntries.length === 0) return;
	const backup = {
		backupDir: await fs$1.mkdtemp(path.join(params.targetLayout.globalRoot, ".openclaw-shim-backup-")),
		targetBinDir: params.targetLayout.binDir,
		entries: []
	};
	try {
		await fs$1.mkdir(params.targetLayout.binDir, { recursive: true });
		for (const entry of shimEntries) {
			const destination = path.join(params.targetLayout.binDir, entry);
			const hadExisting = await pathExists(destination);
			backup.entries.push({
				name: entry,
				hadExisting
			});
			if (hadExisting) await copyPathEntry(destination, path.join(backup.backupDir, entry));
		}
		for (const entry of shimEntries) await copyPathEntry(path.join(params.stageLayout.binDir, entry), path.join(params.targetLayout.binDir, entry));
	} catch (err) {
		await restoreNpmBinShimBackup(backup);
		throw err;
	} finally {
		await removePathBestEffort(backup.backupDir);
	}
}
async function restoreNpmBinShimBackup(backup) {
	await fs$1.mkdir(backup.targetBinDir, { recursive: true });
	for (const entry of backup.entries) {
		const destination = path.join(backup.targetBinDir, entry.name);
		await removePathBestEffort(destination);
		if (entry.hadExisting) await copyPathEntry(path.join(backup.backupDir, entry.name), destination);
	}
}
async function swapStagedNpmInstall(params) {
	const startedAt = Date.now();
	const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot, { allowDirectNodeModulesRoot: params.installTarget.directNodeModulesRoot === true });
	const targetPackageRoot = params.installTarget.packageRoot;
	if (!targetLayout || !targetPackageRoot) return {
		name: "global install swap",
		command: "swap staged npm install",
		cwd: params.stage.prefix,
		durationMs: Date.now() - startedAt,
		exitCode: 1,
		stdoutTail: null,
		stderrTail: "cannot resolve npm global prefix layout"
	};
	const backupRoot = path.join(targetLayout.globalRoot, `.openclaw-${process.pid}-${Date.now()}`);
	let movedExisting = false;
	let movedStaged = false;
	try {
		await fs$1.mkdir(targetLayout.globalRoot, { recursive: true });
		if (await pathExists(targetPackageRoot)) {
			await movePathWithCopyFallback({
				from: targetPackageRoot,
				sourceHardlinks: "reject",
				to: backupRoot
			});
			movedExisting = true;
		}
		await movePathWithCopyFallback({
			from: params.stage.packageRoot,
			sourceHardlinks: "reject",
			to: targetPackageRoot
		});
		movedStaged = true;
		if (params.installTarget.directNodeModulesRoot !== true) await replaceNpmBinShims({
			stageLayout: params.stage.layout,
			targetLayout,
			packageName: params.packageName
		});
		if (movedExisting) await removePathBestEffort(backupRoot);
		return {
			name: "global install swap",
			command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot}`,
			cwd: targetLayout.globalRoot,
			durationMs: Date.now() - startedAt,
			exitCode: 0,
			stdoutTail: movedExisting ? `replaced ${params.packageName}` : `installed ${params.packageName}`,
			stderrTail: null
		};
	} catch (err) {
		if (movedStaged) await removePathBestEffort(targetPackageRoot);
		if (movedExisting) await movePathWithCopyFallback({
			from: backupRoot,
			sourceHardlinks: "reject",
			to: targetPackageRoot
		}).catch(() => void 0);
		return {
			name: "global install swap",
			command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot}`,
			cwd: targetLayout.globalRoot,
			durationMs: Date.now() - startedAt,
			exitCode: 1,
			stdoutTail: null,
			stderrTail: formatError(err)
		};
	}
}
async function runGlobalPackageUpdateSteps(params) {
	const installCwd = params.installCwd === void 0 ? {} : { cwd: params.installCwd };
	const installEnv = params.env === void 0 ? {} : { env: params.env };
	let stagedInstall = null;
	let packedInstallDir = null;
	try {
		const preparedInstall = await prepareStagedNpmInstall(params.installTarget, params.packageName);
		stagedInstall = preparedInstall.stagedInstall;
		if (preparedInstall.failedStep) return {
			steps: [preparedInstall.failedStep],
			verifiedPackageRoot: params.packageRoot ?? null,
			afterVersion: null,
			failedStep: preparedInstall.failedStep
		};
		const steps = [];
		const installCommandTarget = stagedInstall?.installTarget ?? params.installTarget;
		const preparedSpec = await prepareNpmGitSourceInstallSpec({
			installTarget: installCommandTarget,
			installSpec: params.installSpec,
			packageName: params.packageName,
			runStep: params.runStep,
			timeoutMs: params.timeoutMs,
			env: params.env,
			installCwd: params.installCwd
		});
		packedInstallDir = preparedSpec.packDir;
		steps.push(...preparedSpec.steps);
		if (preparedSpec.failedStep) return {
			steps,
			verifiedPackageRoot: params.packageRoot ?? null,
			afterVersion: null,
			failedStep: preparedSpec.failedStep
		};
		const installLocation = stagedInstall?.prefix ?? (installCommandTarget.manager === "pnpm" ? resolvePnpmGlobalDirFromGlobalRoot(installCommandTarget.globalRoot) : null);
		const updateStep = await params.runStep({
			name: "global update",
			argv: globalInstallArgs(installCommandTarget, preparedSpec.installSpec, void 0, installLocation),
			...installCwd,
			...installEnv,
			timeoutMs: params.timeoutMs
		});
		steps.push(updateStep);
		let finalInstallStep = updateStep;
		if (updateStep.exitCode !== 0) {
			await cleanupStagedNpmInstall(stagedInstall);
			stagedInstall = null;
			const preparedFallbackInstall = await prepareStagedNpmInstall(params.installTarget, params.packageName);
			stagedInstall = preparedFallbackInstall.stagedInstall;
			if (preparedFallbackInstall.failedStep) {
				steps.push(preparedFallbackInstall.failedStep);
				return {
					steps,
					verifiedPackageRoot: params.packageRoot ?? null,
					afterVersion: null,
					failedStep: preparedFallbackInstall.failedStep
				};
			}
			const fallbackArgv = globalInstallFallbackArgs(stagedInstall?.installTarget ?? params.installTarget, preparedSpec.installSpec, void 0, stagedInstall?.prefix);
			if (fallbackArgv) {
				const fallbackStep = await params.runStep({
					name: "global update (omit optional)",
					argv: fallbackArgv,
					...installCwd,
					...installEnv,
					timeoutMs: params.timeoutMs
				});
				steps.push(fallbackStep);
				finalInstallStep = fallbackStep;
			} else {
				await cleanupStagedNpmInstall(stagedInstall);
				stagedInstall = null;
			}
		}
		const livePackageRoot = params.installTarget.packageRoot ?? params.packageRoot ?? (await resolveGlobalInstallTarget({
			manager: params.installTarget,
			runCommand: params.runCommand,
			timeoutMs: params.timeoutMs
		})).packageRoot ?? null;
		const verificationPackageRoot = stagedInstall?.packageRoot ?? livePackageRoot;
		let verifiedPackageRoot = livePackageRoot ?? verificationPackageRoot;
		let afterVersion = null;
		if (finalInstallStep.exitCode === 0 && verificationPackageRoot) {
			const candidateVersion = await readPackageVersion(verificationPackageRoot);
			if (!stagedInstall) afterVersion = candidateVersion;
			const verificationErrors = await collectInstalledGlobalPackageErrors({
				packageRoot: verificationPackageRoot,
				expectedVersion: resolveExpectedInstalledVersionFromSpec(params.packageName, params.installSpec)
			});
			if (verificationErrors.length > 0) steps.push({
				name: "global install verify",
				command: `verify ${verificationPackageRoot}`,
				cwd: verificationPackageRoot,
				durationMs: 0,
				exitCode: 1,
				stderrTail: verificationErrors.join("\n"),
				stdoutTail: null
			});
			if (stagedInstall && verificationErrors.length === 0) {
				const swapStep = await swapStagedNpmInstall({
					stage: stagedInstall,
					installTarget: params.installTarget,
					packageName: params.packageName
				});
				steps.push(swapStep);
				if (swapStep.exitCode === 0) {
					verifiedPackageRoot = params.installTarget.packageRoot ?? verifiedPackageRoot;
					afterVersion = candidateVersion;
				}
			}
			const failedVerifyOrSwap = steps.find((step) => (step.name === "global install verify" || step.name === "global install swap") && step.exitCode !== 0);
			const postVerifyStep = failedVerifyOrSwap ? null : verifiedPackageRoot ? await params.postVerifyStep?.(verifiedPackageRoot) : null;
			if (postVerifyStep) steps.push(postVerifyStep);
			if (failedVerifyOrSwap && stagedInstall) afterVersion = await readPackageVersionIfPresent(livePackageRoot);
		}
		const failedStep = finalInstallStep.exitCode !== 0 ? finalInstallStep : steps.find((step) => step !== updateStep && step.exitCode !== 0) ?? null;
		return {
			steps,
			verifiedPackageRoot,
			afterVersion,
			failedStep
		};
	} finally {
		await cleanupStagedNpmInstall(stagedInstall);
		if (packedInstallDir) await removePathBestEffort(packedInstallDir);
	}
}
//#endregion
//#region src/infra/update-package-manager.ts
const PNPM_NPM_FALLBACK_SPEC = "pnpm@11";
async function detectBuildManager(root) {
	return await detectPackageManager(root) ?? "npm";
}
function managerPreferenceOrder(preferred) {
	if (preferred === "pnpm") return [
		"pnpm",
		"npm",
		"bun"
	];
	if (preferred === "bun") return [
		"bun",
		"npm",
		"pnpm"
	];
	return [
		"npm",
		"pnpm",
		"bun"
	];
}
function managerVersionArgs(manager) {
	if (manager === "pnpm") return ["pnpm", "--version"];
	if (manager === "bun") return ["bun", "--version"];
	return ["npm", "--version"];
}
async function isManagerAvailable(runCommand, manager, timeoutMs, env) {
	try {
		return (await runCommand(managerVersionArgs(manager), {
			timeoutMs,
			env
		})).code === 0;
	} catch {
		return false;
	}
}
async function isCommandAvailable(runCommand, argv, timeoutMs, env) {
	try {
		return (await runCommand(argv, {
			timeoutMs,
			env
		})).code === 0;
	} catch {
		return false;
	}
}
function cloneCommandEnv(env) {
	return Object.fromEntries(Object.entries(env ?? process.env).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
}
async function enablePnpmViaCorepack(runCommand, timeoutMs, env) {
	if (!await isCommandAvailable(runCommand, ["corepack", "--version"], timeoutMs, env)) return "missing";
	try {
		if ((await runCommand(["corepack", "enable"], {
			timeoutMs,
			env
		})).code !== 0) return "failed";
	} catch {
		return "failed";
	}
	return await isManagerAvailable(runCommand, "pnpm", timeoutMs, env) ? "enabled" : "failed";
}
async function bootstrapPnpmViaNpm(params) {
	const tempRoot = await fs$1.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pnpm-"));
	const cleanup = async () => {
		await fs$1.rm(tempRoot, {
			recursive: true,
			force: true
		}).catch(() => {});
	};
	try {
		if ((await params.runCommand([
			"npm",
			"install",
			"--prefix",
			tempRoot,
			PNPM_NPM_FALLBACK_SPEC
		], {
			timeoutMs: params.timeoutMs,
			env: params.baseEnv
		})).code !== 0) {
			await cleanup();
			return null;
		}
		const env = cloneCommandEnv(params.baseEnv);
		applyPathPrepend(env, [path.join(tempRoot, "node_modules", ".bin")]);
		if (!await isManagerAvailable(params.runCommand, "pnpm", params.timeoutMs, env)) {
			await cleanup();
			return null;
		}
		return {
			env,
			cleanup
		};
	} catch {
		await cleanup();
		return null;
	}
}
async function resolveUpdateBuildManager(runCommand, root, timeoutMs, baseEnv, requirement = "allow-fallback") {
	const preferred = await detectBuildManager(root);
	if (preferred === "pnpm") {
		if (await isManagerAvailable(runCommand, "pnpm", timeoutMs, baseEnv)) return {
			kind: "resolved",
			manager: "pnpm",
			preferred,
			fallback: false
		};
		const corepackStatus = await enablePnpmViaCorepack(runCommand, timeoutMs, baseEnv);
		if (corepackStatus === "enabled") return {
			kind: "resolved",
			manager: "pnpm",
			preferred,
			fallback: false
		};
		if (await isManagerAvailable(runCommand, "npm", timeoutMs, baseEnv)) {
			const pnpmBootstrap = await bootstrapPnpmViaNpm({
				runCommand,
				timeoutMs,
				baseEnv
			});
			if (pnpmBootstrap) return {
				kind: "resolved",
				manager: "pnpm",
				preferred,
				fallback: false,
				env: pnpmBootstrap.env,
				cleanup: pnpmBootstrap.cleanup
			};
			if (requirement === "require-preferred") return {
				kind: "missing-required",
				preferred,
				reason: "pnpm-npm-bootstrap-failed"
			};
		}
		if (requirement === "require-preferred") {
			if (corepackStatus === "missing") return {
				kind: "missing-required",
				preferred,
				reason: "pnpm-corepack-missing"
			};
			if (corepackStatus === "failed") return {
				kind: "missing-required",
				preferred,
				reason: "pnpm-corepack-enable-failed"
			};
			return {
				kind: "missing-required",
				preferred,
				reason: "preferred-manager-unavailable"
			};
		}
	}
	for (const manager of managerPreferenceOrder(preferred)) if (await isManagerAvailable(runCommand, manager, timeoutMs, baseEnv)) return {
		kind: "resolved",
		manager,
		preferred,
		fallback: manager !== preferred
	};
	if (requirement === "require-preferred") return {
		kind: "missing-required",
		preferred,
		reason: "preferred-manager-unavailable"
	};
	return {
		kind: "resolved",
		manager: "npm",
		preferred,
		fallback: preferred !== "npm"
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
function managerInstallArgs(manager, opts) {
	if (manager === "pnpm") return ["pnpm", "install"];
	if (manager === "bun") return ["bun", "install"];
	if (opts?.compatFallback) return [
		"npm",
		"install",
		"--no-package-lock",
		"--legacy-peer-deps"
	];
	return ["npm", "install"];
}
function managerInstallIgnoreScriptsArgs(manager) {
	if (manager === "pnpm") return [
		"pnpm",
		"install",
		"--ignore-scripts"
	];
	if (manager === "bun") return [
		"bun",
		"install",
		"--ignore-scripts"
	];
	return [
		"npm",
		"install",
		"--ignore-scripts"
	];
}
//#endregion
//#region src/infra/update-runner.ts
function mapManagerResolutionFailure(reason) {
	return reason;
}
const DEFAULT_TIMEOUT_MS = 20 * 6e4;
const MAX_LOG_CHARS = 8e3;
const PREFLIGHT_MAX_COMMITS = 10;
const DEFAULT_PACKAGE_NAME = "openclaw";
const CORE_PACKAGE_NAMES = new Set([DEFAULT_PACKAGE_NAME]);
const UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV = "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR";
const UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV = "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE";
const PREFLIGHT_TEMP_PREFIX = process.platform === "win32" ? "ocu-pf-" : "openclaw-update-preflight-";
const PREFLIGHT_WORKTREE_DIRNAME = process.platform === "win32" ? "wt" : "worktree";
const PREFLIGHT_CLEANUP_TIMEOUT_MS = 6e4;
const WINDOWS_PREFLIGHT_BASE_DIR = "ocu";
const BUILD_MAX_OLD_SPACE_MB = 8192;
const DEV_PREFLIGHT_LINT_ENV = {
	OPENCLAW_LOCAL_CHECK: "1",
	OPENCLAW_LOCAL_CHECK_MODE: "throttled",
	OPENCLAW_OXLINT_SHARDS_SERIAL: "1"
};
const DEV_PREFLIGHT_LINT_OPT_IN_ENV = "OPENCLAW_UPDATE_PREFLIGHT_LINT";
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
	let proc = null;
	try {
		proc = normalizeDir(process.cwd());
	} catch {
		proc = null;
	}
	if (proc) dirs.push(proc);
	return Array.from(new Set(dirs));
}
function resolvePreflightTempRootPrefix() {
	return path.join(os.tmpdir(), PREFLIGHT_TEMP_PREFIX);
}
function resolvePreflightWorktreeDir(preflightRoot) {
	return path.join(preflightRoot, PREFLIGHT_WORKTREE_DIRNAME);
}
function shouldUseNativeWindowsTempRoot() {
	return process.platform === "win32" && path.sep === "\\";
}
async function createPreflightRoot() {
	if (shouldUseNativeWindowsTempRoot()) {
		const baseDir = path.win32.join(process.env.SystemDrive ?? "C:", WINDOWS_PREFLIGHT_BASE_DIR);
		await fs$1.mkdir(baseDir, { recursive: true });
		return fs$1.mkdtemp(path.win32.join(baseDir, PREFLIGHT_TEMP_PREFIX));
	}
	return fs$1.mkdtemp(resolvePreflightTempRootPrefix());
}
async function removePathRecursive(target) {
	await fs$1.rm(target, {
		recursive: true,
		force: true,
		maxRetries: 3,
		retryDelay: 200
	}).catch(() => {});
}
async function repairPreflightCleanup(worktreeDir, preflightRoot) {
	try {
		await fs$1.rm(worktreeDir, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 200
		});
		await fs$1.rm(preflightRoot, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 200
		});
		return true;
	} catch {
		return false;
	}
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
		], { timeoutMs }).catch(() => null);
		if (!res) continue;
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
				const raw = await fs$1.readFile(pkgPath, "utf-8");
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
function normalizeTag(tag) {
	return normalizePackageTagInput(tag, ["openclaw", DEFAULT_PACKAGE_NAME]) ?? "latest";
}
function normalizeDevTargetRef(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}
function looksLikeFullCommitSha(value) {
	return /^[0-9a-f]{40}$/i.test(value.trim());
}
function buildDevTargetRefResolutionCandidates(devTargetRef) {
	const trimmed = devTargetRef.trim();
	const candidates = [];
	const addCandidate = (candidate) => {
		if (!candidate || candidates.includes(candidate)) return;
		candidates.push(candidate);
	};
	if (looksLikeFullCommitSha(trimmed)) {
		addCandidate(trimmed);
		return candidates;
	}
	if (trimmed.startsWith("refs/remotes/")) {
		addCandidate(trimmed);
		return candidates;
	}
	if (trimmed.startsWith("refs/heads/")) {
		addCandidate(`refs/remotes/origin/${trimmed.slice(11)}`);
		return candidates;
	}
	if (trimmed.startsWith("origin/")) {
		addCandidate(`refs/remotes/${trimmed}`);
		return candidates;
	}
	if (trimmed.startsWith("refs/tags/")) {
		addCandidate(`${trimmed}^{}`);
		addCandidate(trimmed);
		return candidates;
	}
	addCandidate(`refs/remotes/origin/${trimmed}`);
	addCandidate(`refs/tags/${trimmed}^{}`);
	addCandidate(`refs/tags/${trimmed}`);
	return candidates;
}
async function resolveComparablePath(target) {
	return await fs$1.realpath(target).catch(() => path.resolve(target));
}
async function pathsReferToSameLocation(left, right) {
	return await resolveComparablePath(left) === await resolveComparablePath(right);
}
async function looksLikeGitCheckout(root) {
	try {
		await fs$1.access(path.join(root, ".git"));
		return true;
	} catch {
		return false;
	}
}
function shouldRetryWindowsInstallIgnoringScripts(manager) {
	return process.platform === "win32" && manager === "pnpm";
}
function shouldPreferIgnoreScriptsForWindowsPreflight(manager) {
	return process.platform === "win32" && manager === "pnpm";
}
function resolveBuildNodeOptions(baseOptions) {
	const current = baseOptions?.trim() ?? "";
	const desired = `--max-old-space-size=${BUILD_MAX_OLD_SPACE_MB}`;
	const existingMatch = /(?:^|\s)--max-old-space-size=(\d+)(?=\s|$)/.exec(current);
	if (!existingMatch) return current ? `${current} ${desired}` : desired;
	const existingValue = Number(existingMatch[1]);
	if (Number.isFinite(existingValue) && existingValue >= BUILD_MAX_OLD_SPACE_MB) return current;
	return current.replace(/(?:^|\s)--max-old-space-size=\d+(?=\s|$)/, ` ${desired}`).trim();
}
function resolveBuildEnv(env) {
	const currentNodeOptions = env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS;
	const nextNodeOptions = resolveBuildNodeOptions(currentNodeOptions);
	if (nextNodeOptions === currentNodeOptions) return env;
	return {
		...env,
		NODE_OPTIONS: nextNodeOptions
	};
}
function resolveInstallEnv(manager, env) {
	if (manager !== "pnpm") return env;
	return {
		...env,
		PNPM_CONFIG_RESOLUTION_MODE: env?.PNPM_CONFIG_RESOLUTION_MODE ?? "highest",
		npm_config_resolution_mode: env?.npm_config_resolution_mode ?? "highest",
		pnpm_config_resolution_mode: env?.pnpm_config_resolution_mode ?? "highest"
	};
}
function isSupersededInstallFailure(step, steps) {
	if (step.exitCode === 0) return false;
	if (step.name === "deps install") return steps.some((candidate) => candidate.name === "deps install (ignore scripts)" && candidate.exitCode === 0);
	const preflightMatch = /^preflight deps install \((.+)\)$/.exec(step.name);
	if (!preflightMatch) return false;
	const retryName = `preflight deps install (ignore scripts) (${preflightMatch[1]})`;
	return steps.some((candidate) => candidate.name === retryName && candidate.exitCode === 0);
}
function findBlockingGitFailure(steps) {
	return steps.find((step) => step.exitCode !== 0 && !isSupersededInstallFailure(step, steps));
}
function mergeCommandEnvironments(baseEnv, overrideEnv) {
	if (!baseEnv) return overrideEnv;
	if (!overrideEnv) return baseEnv;
	return {
		...baseEnv,
		...overrideEnv
	};
}
function shouldRunDevPreflightLint(env = process.env) {
	const value = env[DEV_PREFLIGHT_LINT_OPT_IN_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true";
}
function resolveDevPreflightLintEnv(env) {
	return {
		...env,
		...DEV_PREFLIGHT_LINT_ENV
	};
}
function normalizeFallbackFailureReason(stepName) {
	switch (stepName) {
		case "global update":
		case "global update (omit optional)":
		case "global install stage":
		case "global install verify":
		case "global install swap": return "global-install-failed";
		case "openclaw doctor": return "doctor-failed";
		case "ui:build (post-doctor repair)": return "ui-build-failed";
		default: return "unexpected-error";
	}
}
async function buildUpdateCommandRunner(runCommand) {
	const defaultCommandEnv = await createGlobalInstallEnv();
	if (runCommand) return {
		defaultCommandEnv,
		runCommand
	};
	return {
		defaultCommandEnv,
		runCommand: async (argv, options) => {
			const res = await runCommandWithTimeout(argv, {
				...options,
				env: mergeCommandEnvironments(defaultCommandEnv, options.env)
			});
			return {
				stdout: res.stdout,
				stderr: res.stderr,
				code: res.code
			};
		}
	};
}
async function resolveUpdateInstallSurface(opts = {}) {
	const { runCommand } = await buildUpdateCommandRunner(opts.runCommand);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const candidates = buildStartDirs(opts);
	const pkgRoot = await findPackageRoot(candidates);
	let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs);
	if (gitRoot && pkgRoot && path.resolve(gitRoot) !== path.resolve(pkgRoot)) gitRoot = null;
	if (gitRoot && !pkgRoot) return {
		kind: "missing",
		mode: "unknown",
		root: gitRoot
	};
	if (gitRoot && pkgRoot && path.resolve(gitRoot) === path.resolve(pkgRoot)) return {
		kind: "git",
		mode: "git",
		root: gitRoot,
		packageRoot: pkgRoot
	};
	if (!pkgRoot) return {
		kind: "missing",
		mode: "unknown"
	};
	const globalManager = await detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs);
	if (globalManager) return {
		kind: "global",
		mode: globalManager,
		root: pkgRoot,
		packageRoot: pkgRoot
	};
	return {
		kind: "package-root",
		mode: "unknown",
		root: pkgRoot,
		packageRoot: pkgRoot
	};
}
async function runGatewayUpdate(opts = {}) {
	const startedAt = Date.now();
	const { defaultCommandEnv, runCommand } = await buildUpdateCommandRunner(opts.runCommand);
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
	if (!gitRoot && pkgRoot) {
		const cwdRoot = normalizeDir(opts.cwd);
		if (cwdRoot && await pathsReferToSameLocation(cwdRoot, pkgRoot) && await looksLikeGitCheckout(cwdRoot)) gitRoot = await resolveComparablePath(cwdRoot);
	}
	if (gitRoot && pkgRoot && !await pathsReferToSameLocation(gitRoot, pkgRoot)) gitRoot = null;
	if (gitRoot && !pkgRoot) return {
		status: "error",
		mode: "unknown",
		root: gitRoot,
		reason: "not-openclaw-root",
		steps: [],
		durationMs: Date.now() - startedAt
	};
	if (gitRoot && pkgRoot && await pathsReferToSameLocation(gitRoot, pkgRoot)) {
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
		const devTargetRef = channel === "dev" ? normalizeDevTargetRef(opts.devTargetRef) : null;
		const branch = await readBranchName(runCommand, gitRoot, timeoutMs);
		const needsCheckoutMain = channel === "dev" && !devTargetRef && branch !== "main";
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
		const runRequiredGitStep = async (name, argv, reason) => {
			const gitStep = await runStep(step(name, argv, gitRoot));
			steps.push(gitStep);
			if (gitStep.exitCode !== 0) return buildGitErrorResult(reason);
			return null;
		};
		const appendRecoveryStep = async (name, argv) => {
			const started = Date.now();
			const result = await runCommand(argv, {
				cwd: gitRoot,
				timeoutMs
			});
			const recoveryStep = {
				name,
				command: argv.join(" "),
				cwd: gitRoot,
				durationMs: Date.now() - started,
				exitCode: result.code,
				stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
				stderrTail: trimLogTail(result.stderr, MAX_LOG_CHARS)
			};
			steps.push(recoveryStep);
			return recoveryStep.exitCode === 0;
		};
		const rollbackGitCheckout = async () => {
			if (!beforeSha) return;
			await appendRecoveryStep("git rollback clean", [
				"git",
				"-C",
				gitRoot,
				"reset",
				"--hard"
			]);
			if (branch && branch !== "HEAD") {
				if (await appendRecoveryStep("git rollback checkout", [
					"git",
					"-C",
					gitRoot,
					"checkout",
					"--force",
					branch
				])) await appendRecoveryStep("git rollback reset", [
					"git",
					"-C",
					gitRoot,
					"reset",
					"--hard",
					beforeSha
				]);
				return;
			}
			await appendRecoveryStep("git rollback checkout", [
				"git",
				"-C",
				gitRoot,
				"checkout",
				"--detach",
				beforeSha
			]);
		};
		const buildGitErrorResultWithRollback = async (reason) => {
			await rollbackGitCheckout();
			return buildGitErrorResult(reason);
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
				const failure = await runRequiredGitStep(`git checkout ${DEV_BRANCH}`, [
					"git",
					"-C",
					gitRoot,
					"checkout",
					DEV_BRANCH
				], "checkout-failed");
				if (failure) return failure;
			}
			const fetchFailure = await runRequiredGitStep("git fetch", [
				"git",
				"-C",
				gitRoot,
				"fetch",
				"--all",
				"--prune",
				"--tags"
			], "fetch-failed");
			if (fetchFailure) return fetchFailure;
			let preflightBaseSha = null;
			let candidates = [];
			if (devTargetRef) {
				let targetSha = null;
				for (const targetRefCandidate of buildDevTargetRefResolutionCandidates(devTargetRef)) {
					const targetShaStep = await runStep(step(`git rev-parse ${targetRefCandidate}`, [
						"git",
						"-C",
						gitRoot,
						"rev-parse",
						targetRefCandidate
					], gitRoot));
					steps.push(targetShaStep);
					const resolvedTargetSha = targetShaStep.stdoutTail?.trim();
					if (targetShaStep.exitCode === 0 && resolvedTargetSha) {
						targetSha = resolvedTargetSha;
						break;
					}
				}
				if (!targetSha) return {
					status: "error",
					mode: "git",
					root: gitRoot,
					reason: "no-target-sha",
					before: {
						sha: beforeSha,
						version: beforeVersion
					},
					steps,
					durationMs: Date.now() - startedAt
				};
				preflightBaseSha = targetSha;
				candidates = [targetSha];
			} else {
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
				candidates = (revListStep.stdoutTail ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
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
				preflightBaseSha = upstreamSha;
			}
			if (!preflightBaseSha) return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "preflight-base-missing",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
			const manager = await resolveUpdateBuildManager((argv, options) => runCommand(argv, {
				timeoutMs: options.timeoutMs,
				env: options.env
			}), gitRoot, timeoutMs, defaultCommandEnv, "require-preferred");
			if (manager.kind === "missing-required") return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: mapManagerResolutionFailure(manager.reason),
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
			const preflightRoot = await createPreflightRoot();
			const worktreeDir = resolvePreflightWorktreeDir(preflightRoot);
			const worktreeStep = await runStep(step("preflight worktree", [
				"git",
				"-C",
				gitRoot,
				"worktree",
				"add",
				"--detach",
				worktreeDir,
				preflightBaseSha
			], gitRoot));
			steps.push(worktreeStep);
			if (worktreeStep.exitCode !== 0) {
				await removePathRecursive(preflightRoot);
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
					const preflightIgnoreScripts = shouldPreferIgnoreScriptsForWindowsPreflight(manager.manager);
					const preflightIgnoreScriptsArgv = managerInstallIgnoreScriptsArgs(manager.manager);
					const depsStepArgv = preflightIgnoreScripts && preflightIgnoreScriptsArgv ? preflightIgnoreScriptsArgv : managerInstallArgs(manager.manager, { compatFallback: manager.fallback && manager.manager === "npm" });
					const depsStepName = preflightIgnoreScripts ? `preflight deps install (ignore scripts) (${shortSha})` : `preflight deps install (${shortSha})`;
					const installEnv = resolveInstallEnv(manager.manager, manager.env);
					const depsStep = await runStep(step(depsStepName, depsStepArgv, worktreeDir, installEnv));
					steps.push(depsStep);
					let finalDepsStep = depsStep;
					if (depsStep.exitCode !== 0 && !preflightIgnoreScripts && shouldRetryWindowsInstallIgnoringScripts(manager.manager)) {
						const retryArgv = managerInstallIgnoreScriptsArgs(manager.manager);
						if (retryArgv) {
							const retryStep = await runStep(step(`preflight deps install (ignore scripts) (${shortSha})`, retryArgv, worktreeDir, installEnv));
							steps.push(retryStep);
							finalDepsStep = retryStep;
						}
					}
					if (finalDepsStep.exitCode !== 0) continue;
					const buildStep = await runStep(step(`preflight build (${shortSha})`, managerScriptArgs(manager.manager, "build"), worktreeDir, resolveBuildEnv(manager.env)));
					steps.push(buildStep);
					if (buildStep.exitCode !== 0) continue;
					if (shouldRunDevPreflightLint()) {
						const lintStep = await runStep(step(`preflight lint (${shortSha})`, managerScriptArgs(manager.manager, "lint"), worktreeDir, resolveDevPreflightLintEnv(manager.env)));
						steps.push(lintStep);
						if (lintStep.exitCode !== 0) continue;
					}
					selectedSha = sha;
					break;
				}
			} finally {
				const removeStep = await runStep({
					...step("preflight cleanup", [
						"git",
						"-C",
						gitRoot,
						"worktree",
						"remove",
						"--force",
						worktreeDir
					], gitRoot),
					timeoutMs: Math.min(timeoutMs, PREFLIGHT_CLEANUP_TIMEOUT_MS)
				});
				if (removeStep.exitCode !== 0 && await repairPreflightCleanup(worktreeDir, preflightRoot)) {
					removeStep.exitCode = 0;
					const fallbackMessage = process.platform === "win32" ? "windows fallback cleanup removed preflight tree" : "fallback cleanup removed preflight tree";
					removeStep.stderrTail = trimLogTail([removeStep.stderrTail, fallbackMessage].filter(Boolean).join("\n"), MAX_LOG_CHARS);
				}
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
				await removePathRecursive(preflightRoot);
				await manager.cleanup?.();
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
			if (devTargetRef) {
				const failure = await runRequiredGitStep(`git checkout ${selectedSha}`, [
					"git",
					"-C",
					gitRoot,
					"checkout",
					"--detach",
					selectedSha
				], "checkout-failed");
				if (failure) return failure;
			} else {
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
			}
		} else {
			const fetchFailure = await runRequiredGitStep("git fetch", [
				"git",
				"-C",
				gitRoot,
				"fetch",
				"--all",
				"--prune",
				"--tags"
			], "fetch-failed");
			if (fetchFailure) return fetchFailure;
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
			const failure = await runRequiredGitStep(`git checkout ${tag}`, [
				"git",
				"-C",
				gitRoot,
				"checkout",
				"--detach",
				tag
			], "checkout-failed");
			if (failure) return failure;
		}
		const manager = await resolveUpdateBuildManager((argv, options) => runCommand(argv, {
			timeoutMs: options.timeoutMs,
			env: options.env
		}), gitRoot, timeoutMs, defaultCommandEnv, "require-preferred");
		if (manager.kind === "missing-required") return await buildGitErrorResultWithRollback(mapManagerResolutionFailure(manager.reason));
		try {
			const installEnv = resolveInstallEnv(manager.manager, manager.env);
			const depsStep = await runStep(step("deps install", managerInstallArgs(manager.manager, { compatFallback: manager.fallback && manager.manager === "npm" }), gitRoot, installEnv));
			steps.push(depsStep);
			let finalDepsStep = depsStep;
			if (depsStep.exitCode !== 0 && shouldRetryWindowsInstallIgnoringScripts(manager.manager)) {
				const retryArgv = managerInstallIgnoreScriptsArgs(manager.manager);
				if (retryArgv) {
					const retryStep = await runStep(step("deps install (ignore scripts)", retryArgv, gitRoot, installEnv));
					steps.push(retryStep);
					finalDepsStep = retryStep;
				}
			}
			if (finalDepsStep.exitCode !== 0) return await buildGitErrorResultWithRollback("deps-install-failed");
			const buildStep = await runStep(step("build", managerScriptArgs(manager.manager, "build"), gitRoot, resolveBuildEnv(manager.env)));
			steps.push(buildStep);
			if (buildStep.exitCode !== 0) return await buildGitErrorResultWithRollback("build-failed");
			const uiBuildStep = await runStep(step("ui:build", managerScriptArgs(manager.manager, "ui:build"), gitRoot, manager.env));
			steps.push(uiBuildStep);
			if (uiBuildStep.exitCode !== 0) return await buildGitErrorResultWithRollback("ui-build-failed");
			const doctorEntry = path.join(gitRoot, "openclaw.mjs");
			if (!await fs$1.stat(doctorEntry).then(() => true).catch(() => false)) {
				steps.push({
					name: "openclaw doctor entry",
					command: `verify ${doctorEntry}`,
					cwd: gitRoot,
					durationMs: 0,
					exitCode: 1,
					stderrTail: `missing ${doctorEntry}`
				});
				return await buildGitErrorResultWithRollback("doctor-entry-missing");
			}
			const doctorStep = await runStep(step("openclaw doctor", [
				await resolveStableNodePath(process.execPath),
				doctorEntry,
				"doctor",
				"--non-interactive",
				"--fix"
			], gitRoot, {
				OPENCLAW_UPDATE_IN_PROGRESS: "1",
				...opts.deferConfiguredPluginInstallRepair ? { [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1" } : {},
				[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1"
			}));
			steps.push(doctorStep);
			if (doctorStep.exitCode !== 0) return await buildGitErrorResultWithRollback("doctor-failed");
			if (!(await resolveControlUiDistIndexHealth({ root: gitRoot })).exists) {
				const repairArgv = managerScriptArgs(manager.manager, "ui:build");
				const started = Date.now();
				const repairResult = await runCommand(repairArgv, {
					cwd: gitRoot,
					timeoutMs,
					env: manager.env
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
				if (repairResult.code !== 0) return await buildGitErrorResultWithRollback("ui-build-failed");
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
					return await buildGitErrorResultWithRollback("ui-assets-missing");
				}
			}
			const failedStep = findBlockingGitFailure(steps);
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
				reason: failedStep ? normalizeFallbackFailureReason(failedStep.name) : void 0,
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
		} finally {
			await manager.cleanup?.();
		}
	}
	if (!pkgRoot) return {
		status: "error",
		mode: "unknown",
		reason: "not-openclaw-root",
		steps: [],
		durationMs: Date.now() - startedAt
	};
	const beforeVersion = await readPackageVersion(pkgRoot);
	const globalManager = await detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs);
	if (globalManager) {
		const installTarget = await resolveGlobalInstallTarget({
			manager: globalManager,
			runCommand,
			timeoutMs,
			pkgRoot
		});
		const packageName = await readPackageName(pkgRoot) ?? DEFAULT_PACKAGE_NAME;
		await cleanupGlobalRenameDirs({
			globalRoot: path.dirname(pkgRoot),
			packageName
		});
		const channel = opts.channel ?? "stable";
		const tag = normalizeTag(opts.tag ?? channelToNpmTag(channel));
		const globalInstallEnv = await createGlobalInstallEnv();
		const packageUpdate = await runGlobalPackageUpdateSteps({
			installTarget,
			installSpec: resolveGlobalInstallSpec({
				packageName,
				tag,
				env: globalInstallEnv
			}),
			packageName,
			packageRoot: pkgRoot,
			runCommand,
			timeoutMs,
			...globalInstallEnv === void 0 ? {} : { env: globalInstallEnv },
			installCwd: pkgRoot,
			runStep: (stepParams) => runStep({
				runCommand,
				...stepParams,
				cwd: stepParams.cwd ?? pkgRoot,
				progress,
				stepIndex: 0,
				totalSteps: 1
			}),
			postVerifyStep: async (verifiedPackageRoot) => {
				const doctorEntry = await resolveGatewayInstallEntrypoint(verifiedPackageRoot);
				if (!doctorEntry) return null;
				const doctorNodePath = await resolveStableNodePath(process.execPath);
				const candidateHostVersion = await readPackageVersion(verifiedPackageRoot);
				return await runStep({
					runCommand,
					name: "openclaw doctor",
					argv: [
						doctorNodePath,
						doctorEntry,
						"doctor",
						"--non-interactive",
						"--fix"
					],
					cwd: verifiedPackageRoot,
					timeoutMs,
					env: {
						OPENCLAW_UPDATE_IN_PROGRESS: "1",
						[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
						...candidateHostVersion === null ? {} : { OPENCLAW_COMPATIBILITY_HOST_VERSION: candidateHostVersion }
					},
					progress,
					stepIndex: 0,
					totalSteps: 1
				});
			}
		});
		return {
			status: packageUpdate.failedStep ? "error" : "ok",
			mode: globalManager,
			root: packageUpdate.verifiedPackageRoot ?? pkgRoot,
			reason: packageUpdate.failedStep ? normalizeFallbackFailureReason(packageUpdate.failedStep.name) : void 0,
			before: { version: beforeVersion },
			after: { version: packageUpdate.afterVersion },
			steps: packageUpdate.steps,
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
export { cleanupGlobalRenameDirs as a, detectGlobalInstallManagerForRoot as c, resolveGlobalInstallTarget as d, resolvePnpmGlobalDirFromGlobalRoot as f, canResolveRegistryVersionForPackageTarget as i, globalInstallArgs as l, runGatewayUpdate as n, createGlobalInstallEnv as o, normalizePackageTagInput as p, runGlobalPackageUpdateSteps as r, detectGlobalInstallManagerByPresence as s, resolveUpdateInstallSurface as t, resolveGlobalInstallSpec as u };
