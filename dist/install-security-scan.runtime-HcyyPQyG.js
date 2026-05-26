import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-CNp1Ofdk.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { o as tryReadJson } from "./json-files-C2hqjU--.js";
import { n as listBuiltRuntimeEntryCandidates } from "./package-entrypoints-j4m7Pzbb.js";
import { t as extensionUsesSkippedScannerPath } from "./scan-paths-BJFKmVji.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { i as scanDirectoryWithSummary } from "./skill-scanner-CWJxeJAd.js";
import path from "node:path";
import fs from "node:fs/promises";
const blockedInstallDependencyPackageNames = [...["plain-crypto-js"]];
const BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET = new Set(blockedInstallDependencyPackageNames);
const BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_LOWER_SET = new Set(blockedInstallDependencyPackageNames.map((packageName) => packageName.toLowerCase()));
function isBlockedInstallDependencyPackageName(packageName) {
	return BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET.has(packageName);
}
function isBlockedInstallDependencyPackagePathName(packageName) {
	return BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_LOWER_SET.has(packageName.toLowerCase());
}
function normalizePathSegments(relativePath) {
	return relativePath.split(/[\\/]+/).map((segment) => segment.trim()).filter(Boolean);
}
function parseBlockedNodeModulesPackageId(segments, packageNameSegmentTransform) {
	for (let index = 0; index < segments.length; index += 1) {
		if (segments[index]?.toLowerCase() !== "node_modules") continue;
		const packageScopeOrName = segments[index + 1];
		if (!packageScopeOrName) continue;
		if (packageScopeOrName.startsWith("@")) {
			const packageNameSegment = segments[index + 2];
			if (!packageNameSegment) continue;
			const packageName = packageNameSegmentTransform(packageNameSegment);
			if (!packageName) continue;
			const scopedPackageId = `${packageScopeOrName}/${packageName}`;
			if (!isBlockedInstallDependencyPackagePathName(scopedPackageId)) continue;
			return scopedPackageId;
		}
		const packageName = packageNameSegmentTransform(packageScopeOrName);
		if (!packageName || !isBlockedInstallDependencyPackagePathName(packageName)) continue;
		return packageName;
	}
}
function parseNpmAliasTargetPackageName(spec) {
	const normalized = spec.trim();
	if (!normalized.startsWith("npm:")) return;
	const aliasTarget = normalized.slice(4).trim();
	if (!aliasTarget) return;
	if (aliasTarget.startsWith("@")) {
		const slashIndex = aliasTarget.indexOf("/");
		if (slashIndex < 0) return;
		const versionSeparatorIndex = aliasTarget.indexOf("@", slashIndex + 1);
		return versionSeparatorIndex < 0 ? aliasTarget : aliasTarget.slice(0, versionSeparatorIndex);
	}
	const versionSeparatorIndex = aliasTarget.indexOf("@");
	return versionSeparatorIndex < 0 ? aliasTarget : aliasTarget.slice(0, versionSeparatorIndex);
}
function parsePackageNameFromOverrideSelector(selector) {
	const normalized = selector.trim();
	if (!normalized || normalized === ".") return;
	if (normalized.startsWith("@")) {
		const slashIndex = normalized.indexOf("/");
		if (slashIndex < 0) return;
		const versionSeparatorIndex = normalized.indexOf("@", slashIndex + 1);
		return versionSeparatorIndex < 0 ? normalized : normalized.slice(0, versionSeparatorIndex);
	}
	const versionSeparatorIndex = normalized.indexOf("@");
	return versionSeparatorIndex < 0 ? normalized : normalized.slice(0, versionSeparatorIndex);
}
function collectBlockedOverrideFindings(value, path = []) {
	if (typeof value === "string") {
		const aliasTargetPackageName = parseNpmAliasTargetPackageName(value);
		if (!aliasTargetPackageName) return [];
		if (!BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET.has(aliasTargetPackageName)) return [];
		return [{
			dependencyName: aliasTargetPackageName,
			declaredAs: path.join(" > "),
			field: "overrides"
		}];
	}
	const findings = [];
	for (const overrideKey of Object.keys(value).toSorted()) {
		const overrideSelectorPackageName = parsePackageNameFromOverrideSelector(overrideKey);
		if (overrideSelectorPackageName && BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET.has(overrideSelectorPackageName)) findings.push({
			dependencyName: overrideSelectorPackageName,
			declaredAs: [...path, overrideKey].join(" > "),
			field: "overrides"
		});
		findings.push(...collectBlockedOverrideFindings(value[overrideKey], [...path, overrideKey]));
	}
	return findings;
}
function isPackageOverrideObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function findBlockedManifestDependencies(manifest) {
	const findings = [];
	if (manifest.name && isBlockedInstallDependencyPackageName(manifest.name)) findings.push({
		dependencyName: manifest.name,
		field: "name"
	});
	if (isPackageOverrideObject(manifest.overrides)) findings.push(...collectBlockedOverrideFindings(manifest.overrides));
	for (const field of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies"
	]) {
		const dependencyMap = manifest[field];
		if (!dependencyMap) continue;
		for (const dependencyName of Object.keys(dependencyMap).toSorted()) {
			if (isBlockedInstallDependencyPackageName(dependencyName)) {
				findings.push({
					dependencyName,
					field
				});
				continue;
			}
			const aliasTargetPackageName = parseNpmAliasTargetPackageName(dependencyMap[dependencyName]);
			if (!aliasTargetPackageName) continue;
			if (!isBlockedInstallDependencyPackageName(aliasTargetPackageName)) continue;
			findings.push({
				dependencyName: aliasTargetPackageName,
				declaredAs: dependencyName,
				field
			});
		}
	}
	return findings;
}
function findBlockedNodeModulesDirectory(params) {
	const dependencyName = parseBlockedNodeModulesPackageId(normalizePathSegments(params.directoryRelativePath), (packageNameSegment) => packageNameSegment);
	return dependencyName ? {
		dependencyName,
		directoryRelativePath: params.directoryRelativePath
	} : void 0;
}
function parseBlockedPackageFileAliasName(fileName) {
	const extensionMatch = /^(.+)\.(js|json|node)$/i.exec(fileName);
	if (extensionMatch) return extensionMatch[1];
	if (fileName.includes(".")) return;
	return fileName;
}
function findBlockedNodeModulesFileAlias(params) {
	const dependencyName = parseBlockedNodeModulesPackageId(normalizePathSegments(params.fileRelativePath), parseBlockedPackageFileAliasName);
	return dependencyName ? {
		dependencyName,
		fileRelativePath: params.fileRelativePath
	} : void 0;
}
function findBlockedPackageDirectoryInPath(params) {
	const segments = normalizePathSegments(params.pathRelativeToRoot);
	for (let index = 0; index < segments.length; index += 1) {
		const packageScopeOrName = segments[index];
		if (!packageScopeOrName) continue;
		if (packageScopeOrName.startsWith("@")) {
			const packageName = segments[index + 1];
			if (!packageName) continue;
			const scopedPackageId = `${packageScopeOrName}/${packageName}`;
			if (!isBlockedInstallDependencyPackagePathName(scopedPackageId)) {
				index += 1;
				continue;
			}
			return {
				dependencyName: scopedPackageId,
				directoryRelativePath: params.pathRelativeToRoot
			};
		}
		if (!isBlockedInstallDependencyPackagePathName(packageScopeOrName)) continue;
		return {
			dependencyName: packageScopeOrName,
			directoryRelativePath: params.pathRelativeToRoot
		};
	}
}
function findBlockedPackageFileAliasInPath(params) {
	const fileName = normalizePathSegments(params.pathRelativeToRoot).at(-1);
	if (!fileName) return;
	const dependencyName = parseBlockedPackageFileAliasName(fileName);
	if (!dependencyName || !isBlockedInstallDependencyPackagePathName(dependencyName)) return;
	return {
		dependencyName,
		fileRelativePath: params.pathRelativeToRoot
	};
}
//#endregion
//#region src/plugins/install-policy-context.ts
function createBeforeInstallHookPayload(params) {
	return {
		event: {
			targetType: params.targetType,
			targetName: params.targetName,
			sourcePath: params.sourcePath,
			sourcePathKind: params.sourcePathKind,
			...params.origin ? { origin: params.origin } : {},
			request: params.request,
			builtinScan: params.builtinScan,
			...params.skill ? { skill: params.skill } : {},
			...params.plugin ? { plugin: params.plugin } : {}
		},
		ctx: {
			targetType: params.targetType,
			requestKind: params.request.kind,
			...params.origin ? { origin: params.origin } : {}
		}
	};
}
//#endregion
//#region src/plugins/install-security-scan.runtime.ts
const RUNTIME_GRAPH_SCAN_EXTENSIONS = [
	".js",
	".mjs",
	".cjs",
	".ts",
	".mts",
	".cts",
	".jsx",
	".tsx"
];
const RUNTIME_GRAPH_SCAN_MAX_FILES = 1e3;
const LOCAL_RUNTIME_IMPORT_PATTERN = /\b(?:import|export)\s+(?:[^"']*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
function buildCriticalDetails(params) {
	return params.findings.filter((finding) => finding.severity === "critical").map((finding) => `${finding.message} (${finding.file}:${finding.line})`).join("; ");
}
function buildCriticalBlockReason(params) {
	return `${params.targetLabel} blocked: dangerous code patterns detected: ${buildCriticalDetails({ findings: params.findings })}`;
}
function buildScanFailureBlockReason(params) {
	return `${params.targetLabel} blocked: code safety scan failed (${params.error}). Run "openclaw security audit --deep" for details.`;
}
function buildBlockedDependencyManifestLabel(params) {
	return typeof params.manifestPackageName === "string" && params.manifestPackageName.trim() ? `${params.manifestPackageName.trim()} (${params.manifestRelativePath})` : params.manifestRelativePath;
}
function buildBlockedDependencyReason(params) {
	const manifestLabel = buildBlockedDependencyManifestLabel({
		manifestPackageName: params.manifestPackageName,
		manifestRelativePath: params.manifestRelativePath
	});
	const findingSummary = params.findings.map((finding) => finding.field === "name" ? `"${finding.dependencyName}" as package name` : finding.declaredAs ? `"${finding.dependencyName}" via alias "${finding.declaredAs}" in ${finding.field}` : `"${finding.dependencyName}" in ${finding.field}`).join(", ");
	return `${params.targetLabel} blocked: blocked dependencies ${findingSummary} declared in ${manifestLabel}.`;
}
function buildBlockedDependencyDirectoryReason(params) {
	return `${params.targetLabel} blocked: blocked dependency directory "${params.dependencyName}" declared at ${params.directoryRelativePath}.`;
}
function buildBlockedDependencyFileReason(params) {
	return `${params.targetLabel} blocked: blocked dependency file alias "${params.dependencyName}" declared at ${params.fileRelativePath}.`;
}
function pathContainsNodeModulesSegment(relativePath) {
	return relativePath.split(/[\\/]+/).map((segment) => segment.trim().toLowerCase()).includes("node_modules");
}
function isPackageRootOpenClawPeerSymlink(segments) {
	return segments.length === 2 && segments[0] === "node_modules" && segments[1] === "openclaw" || segments.length === 3 && segments[0] === "node_modules" && segments[1] === ".bin" && segments[2] === "openclaw";
}
function isManagedNpmRootPackagePeerSymlink(segments) {
	if (segments[0] !== "node_modules") return false;
	const packageEndIndex = segments[1]?.startsWith("@") ? 3 : 2;
	const packageNameSegments = segments.slice(1, packageEndIndex);
	if (packageNameSegments.length === 0 || packageNameSegments.some((segment) => !segment || segment === "." || segment === "..")) return false;
	return isPackageRootOpenClawPeerSymlink(segments.slice(packageEndIndex));
}
function isTrustedOpenClawPeerSymlink(params) {
	const segments = params.relativePath.split(/[\\/]+/);
	return isPackageRootOpenClawPeerSymlink(segments) || params.allowManagedNpmRootPackagePeerSymlinks === true && isManagedNpmRootPackagePeerSymlink(segments);
}
async function resolveTrustedHostOpenClawRootRealPath() {
	const hostRoot = resolveOpenClawPackageRootSync({
		argv1: process.argv[1],
		cwd: process.cwd(),
		moduleUrl: import.meta.url
	});
	if (!hostRoot) return null;
	return await fs.realpath(hostRoot).catch(() => path.resolve(hostRoot));
}
function isTrustedHostOpenClawPath(params) {
	return params.trustedHostOpenClawRootRealPath !== null && isPathInside(params.trustedHostOpenClawRootRealPath, params.resolvedTargetPath);
}
async function inspectNodeModulesSymlinkTarget(params) {
	let resolvedTargetPath;
	try {
		resolvedTargetPath = await fs.realpath(params.symlinkPath);
	} catch (error) {
		throw new Error(`manifest dependency scan could not resolve symlink target ${params.symlinkRelativePath}: ${String(error)}`, { cause: error });
	}
	if (!isPathInside(params.rootRealPath, resolvedTargetPath)) {
		if (isTrustedOpenClawPeerSymlink({
			allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
			relativePath: params.symlinkRelativePath
		}) && isTrustedHostOpenClawPath({
			resolvedTargetPath,
			trustedHostOpenClawRootRealPath: params.trustedHostOpenClawRootRealPath
		})) return {};
		throw new Error(`manifest dependency scan found node_modules symlink target outside install root at ${params.symlinkRelativePath}`);
	}
	const resolvedTargetStats = await fs.stat(resolvedTargetPath);
	const resolvedTargetRelativePath = path.relative(params.rootRealPath, resolvedTargetPath);
	return {
		blockedDirectoryFinding: findBlockedPackageDirectoryInPath({ pathRelativeToRoot: resolvedTargetRelativePath }),
		blockedFileFinding: resolvedTargetStats.isFile() ? findBlockedPackageFileAliasInPath({ pathRelativeToRoot: resolvedTargetRelativePath }) : void 0
	};
}
function buildBuiltinScanFromError(error) {
	return {
		status: "error",
		scannedFiles: 0,
		critical: 0,
		warn: 0,
		info: 0,
		findings: [],
		error: String(error)
	};
}
function buildBuiltinScanFromSummary(summary) {
	return {
		status: "ok",
		scannedFiles: summary.scannedFiles,
		critical: summary.critical,
		warn: summary.warn,
		info: summary.info,
		findings: summary.findings
	};
}
const DEFAULT_PACKAGE_MANIFEST_TRAVERSAL_LIMITS = {
	maxDepth: 64,
	maxDirectories: 1e4,
	maxManifests: 1e4
};
function readPositiveIntegerEnv(name, fallback) {
	const rawValue = process.env[name];
	if (!rawValue) return fallback;
	const parsedValue = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsedValue) || parsedValue < 1) return fallback;
	return parsedValue;
}
function resolvePackageManifestTraversalLimits() {
	return {
		maxDepth: readPositiveIntegerEnv("OPENCLAW_INSTALL_SCAN_MAX_DEPTH", DEFAULT_PACKAGE_MANIFEST_TRAVERSAL_LIMITS.maxDepth),
		maxDirectories: readPositiveIntegerEnv("OPENCLAW_INSTALL_SCAN_MAX_DIRECTORIES", DEFAULT_PACKAGE_MANIFEST_TRAVERSAL_LIMITS.maxDirectories),
		maxManifests: readPositiveIntegerEnv("OPENCLAW_INSTALL_SCAN_MAX_MANIFESTS", DEFAULT_PACKAGE_MANIFEST_TRAVERSAL_LIMITS.maxManifests)
	};
}
function isSamePathOrInside(parentPath, candidatePath) {
	return parentPath === candidatePath || isPathInside(parentPath, candidatePath);
}
function getErrnoCode(error) {
	if (typeof error !== "object" || error === null || !("code" in error)) return;
	const code = error.code;
	return typeof code === "string" ? code : void 0;
}
function isInstallScannableDependencyName(name) {
	if (name.startsWith("@")) {
		const parts = name.split("/");
		return parts.length === 2 && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
	}
	return name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..";
}
function collectManifestRuntimeDependencyNames(manifest) {
	const dependencyNames = /* @__PURE__ */ new Set();
	for (const dependencies of [manifest.dependencies, manifest.optionalDependencies]) for (const dependencyName of Object.keys(dependencies ?? {})) if (isInstallScannableDependencyName(dependencyName)) dependencyNames.add(dependencyName);
	for (const dependencyName of Object.keys(manifest.peerDependencies ?? {})) if (dependencyName !== "openclaw" && isInstallScannableDependencyName(dependencyName)) dependencyNames.add(dependencyName);
	return [...dependencyNames].toSorted((left, right) => left.localeCompare(right));
}
async function resolveInstalledPackageScanRoot(params) {
	const packageDir = path.join(params.packageDir, "node_modules", params.dependencyName);
	let stats;
	try {
		stats = await fs.stat(packageDir);
	} catch (error) {
		if (getErrnoCode(error) === "ENOENT") return;
		throw error;
	}
	if (!stats.isDirectory()) return;
	const realPath = await fs.realpath(packageDir).catch(() => path.resolve(packageDir));
	if (!isSamePathOrInside(params.boundaryRealPath, realPath)) throw new Error(`installed dependency scan found package outside install root at ${packageDir}`);
	return {
		packageDir,
		realPath
	};
}
async function collectInstalledPackageScanRoots(params) {
	const limits = resolvePackageManifestTraversalLimits();
	const boundaryDir = params.dependencyScanRootDir ?? params.packageDir;
	const boundaryRealPath = await fs.realpath(boundaryDir).catch(() => path.resolve(boundaryDir));
	const packageRealPath = await fs.realpath(params.packageDir).catch(() => path.resolve(params.packageDir));
	if (!isSamePathOrInside(boundaryRealPath, packageRealPath)) throw new Error(`installed dependency scan found package outside install root at ${params.packageDir}`);
	const queue = [{
		packageDir: params.packageDir,
		realPath: packageRealPath
	}];
	for (const packageDir of params.additionalPackageDirs ?? []) {
		const realPath = await fs.realpath(packageDir).catch(() => path.resolve(packageDir));
		if (!isSamePathOrInside(boundaryRealPath, realPath)) throw new Error(`installed dependency scan found package outside install root at ${packageDir}`);
		queue.push({
			packageDir,
			realPath
		});
	}
	const visitedRealPaths = /* @__PURE__ */ new Set();
	const scanRoots = [];
	let queueIndex = 0;
	while (queueIndex < queue.length) {
		const current = queue[queueIndex];
		queueIndex += 1;
		if (!current || visitedRealPaths.has(current.realPath)) continue;
		visitedRealPaths.add(current.realPath);
		if (visitedRealPaths.size > limits.maxDirectories) throw new Error(`installed dependency scan exceeded max packages (${limits.maxDirectories}) under ${boundaryDir}`);
		scanRoots.push(current.packageDir);
		const manifest = await tryReadJson(path.join(current.packageDir, "package.json"));
		if (!manifest) continue;
		for (const dependencyName of collectManifestRuntimeDependencyNames(manifest)) {
			const candidate = await resolveInstalledPackageScanRoot({
				boundaryRealPath,
				dependencyName,
				packageDir: current.packageDir
			}) ?? (params.dependencyScanRootDir ? await resolveInstalledPackageScanRoot({
				boundaryRealPath,
				dependencyName,
				packageDir: params.dependencyScanRootDir
			}) : void 0);
			if (candidate && !visitedRealPaths.has(candidate.realPath)) queue.push(candidate);
		}
	}
	return scanRoots;
}
async function collectNonOverlappingPackageScanRoots(packageDirs) {
	const selectedRoots = [];
	for (const packageDir of packageDirs) {
		const realPath = await fs.realpath(packageDir).catch(() => path.resolve(packageDir));
		if (selectedRoots.some((selectedRoot) => isSamePathOrInside(selectedRoot.realPath, realPath))) continue;
		selectedRoots.push({
			packageDir,
			realPath
		});
	}
	return selectedRoots.map((selectedRoot) => selectedRoot.packageDir);
}
async function collectPackageManifestPaths(params) {
	const limits = resolvePackageManifestTraversalLimits();
	const rootDir = params.rootDir;
	const rootRealPath = await fs.realpath(rootDir).catch(() => rootDir);
	const trustedHostOpenClawRootRealPath = await resolveTrustedHostOpenClawRootRealPath();
	const queue = [{
		depth: 0,
		dir: rootDir
	}];
	const packageManifestPaths = [];
	const visitedDirectories = /* @__PURE__ */ new Set();
	let firstBlockedDirectoryFinding;
	let firstBlockedFileFinding;
	let queueIndex = 0;
	while (queueIndex < queue.length) {
		const current = queue[queueIndex];
		queueIndex += 1;
		if (!current) continue;
		if (current.depth > limits.maxDepth) throw new Error(`manifest dependency scan exceeded max depth (${limits.maxDepth}) at ${current.dir}`);
		const currentDir = current.dir;
		const currentRealPath = await fs.realpath(currentDir).catch(() => currentDir);
		if (visitedDirectories.has(currentRealPath)) continue;
		visitedDirectories.add(currentRealPath);
		if (visitedDirectories.size > limits.maxDirectories) throw new Error(`manifest dependency scan exceeded max directories (${limits.maxDirectories}) under ${rootDir}`);
		let entries;
		try {
			entries = await fs.readdir(currentDir, {
				encoding: "utf8",
				withFileTypes: true
			});
		} catch (error) {
			throw new Error(`manifest dependency scan could not read ${currentDir}: ${String(error)}`, { cause: error });
		}
		for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
			const nextPath = path.join(currentDir, entry.name);
			const relativeNextPath = path.relative(rootDir, nextPath) || entry.name;
			if (entry.isSymbolicLink()) {
				const blockedDirectoryFinding = findBlockedNodeModulesDirectory({ directoryRelativePath: relativeNextPath });
				if (blockedDirectoryFinding) firstBlockedDirectoryFinding ??= blockedDirectoryFinding;
				const blockedFileFinding = findBlockedNodeModulesFileAlias({ fileRelativePath: relativeNextPath });
				if (blockedFileFinding) firstBlockedFileFinding ??= blockedFileFinding;
				if (pathContainsNodeModulesSegment(relativeNextPath)) {
					const symlinkTargetInspection = await inspectNodeModulesSymlinkTarget({
						allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
						rootRealPath,
						symlinkPath: nextPath,
						symlinkRelativePath: relativeNextPath,
						trustedHostOpenClawRootRealPath
					});
					if (symlinkTargetInspection.blockedDirectoryFinding) firstBlockedDirectoryFinding ??= symlinkTargetInspection.blockedDirectoryFinding;
					if (symlinkTargetInspection.blockedFileFinding) firstBlockedFileFinding ??= symlinkTargetInspection.blockedFileFinding;
				}
				continue;
			}
			if (entry.isDirectory()) {
				const blockedDirectoryFinding = findBlockedNodeModulesDirectory({ directoryRelativePath: relativeNextPath });
				if (blockedDirectoryFinding) firstBlockedDirectoryFinding ??= blockedDirectoryFinding;
				queue.push({
					depth: current.depth + 1,
					dir: nextPath
				});
				continue;
			}
			if (entry.isFile()) {
				const blockedFileFinding = findBlockedNodeModulesFileAlias({ fileRelativePath: relativeNextPath });
				if (blockedFileFinding) firstBlockedFileFinding ??= blockedFileFinding;
			}
			if (entry.isFile() && entry.name === "package.json") {
				packageManifestPaths.push(nextPath);
				if (packageManifestPaths.length > limits.maxManifests) throw new Error(`manifest dependency scan exceeded max manifests (${limits.maxManifests}) under ${rootDir}`);
			}
		}
	}
	return {
		packageManifestPaths,
		blockedDirectoryFinding: firstBlockedDirectoryFinding,
		blockedFileFinding: firstBlockedFileFinding
	};
}
function formatPackageScanRelativePath(params) {
	if (!params.relativeRootDir) return params.relativePath;
	const packageRelativePath = path.relative(params.relativeRootDir, params.packageDir);
	return packageRelativePath ? path.join(packageRelativePath, params.relativePath) : params.relativePath;
}
async function scanManifestDependencyDenylist(params) {
	const traversalResult = await collectPackageManifestPaths({
		allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
		rootDir: params.packageDir
	});
	const packageManifestPaths = traversalResult.packageManifestPaths;
	for (const manifestPath of packageManifestPaths) {
		const manifest = await tryReadJson(manifestPath);
		if (!manifest) continue;
		const blockedDependencies = findBlockedManifestDependencies(manifest);
		if (blockedDependencies.length === 0) continue;
		const manifestRelativePath = formatPackageScanRelativePath({
			packageDir: params.packageDir,
			relativePath: path.relative(params.packageDir, manifestPath) || "package.json",
			relativeRootDir: params.relativeRootDir
		});
		const reason = buildBlockedDependencyReason({
			findings: blockedDependencies,
			manifestPackageName: manifest.name,
			manifestRelativePath,
			targetLabel: params.targetLabel
		});
		params.logger.warn?.(`WARNING: ${reason}`);
		return { blocked: {
			code: "security_scan_blocked",
			reason
		} };
	}
	if (traversalResult.blockedDirectoryFinding) {
		const reason = buildBlockedDependencyDirectoryReason({
			dependencyName: traversalResult.blockedDirectoryFinding.dependencyName,
			directoryRelativePath: formatPackageScanRelativePath({
				packageDir: params.packageDir,
				relativePath: traversalResult.blockedDirectoryFinding.directoryRelativePath,
				relativeRootDir: params.relativeRootDir
			}),
			targetLabel: params.targetLabel
		});
		params.logger.warn?.(`WARNING: ${reason}`);
		return { blocked: {
			code: "security_scan_blocked",
			reason
		} };
	}
	if (traversalResult.blockedFileFinding) {
		const reason = buildBlockedDependencyFileReason({
			dependencyName: traversalResult.blockedFileFinding.dependencyName,
			fileRelativePath: formatPackageScanRelativePath({
				packageDir: params.packageDir,
				relativePath: traversalResult.blockedFileFinding.fileRelativePath,
				relativeRootDir: params.relativeRootDir
			}),
			targetLabel: params.targetLabel
		});
		params.logger.warn?.(`WARNING: ${reason}`);
		return { blocked: {
			code: "security_scan_blocked",
			reason
		} };
	}
}
async function scanDirectoryTarget(params) {
	try {
		const scanSummary = await scanDirectoryWithSummary(params.path, {
			excludeTestFiles: params.excludeTestFiles ?? true,
			includeHiddenDirectories: params.includeHiddenDirectories,
			includeNestedNodeModulesTestFiles: params.includeNestedNodeModulesTestFiles,
			includeNodeModules: params.includeNodeModules,
			includeFiles: params.includeFiles,
			maxFiles: params.maxFiles,
			onlyIncludeFiles: params.onlyIncludeFiles
		});
		if (params.failOnTruncated && scanSummary.truncated) return buildBuiltinScanFromError(`code safety scan reached file limit (${params.maxFiles ?? "configured limit"})`);
		const builtinScan = buildBuiltinScanFromSummary(scanSummary);
		if (params.suppressBuiltinWarnings || params.deferBuiltinWarnings) return builtinScan;
		if (scanSummary.critical > 0) params.logger.warn?.(`${params.warningMessage}: ${buildCriticalDetails({ findings: scanSummary.findings })}`);
		else if (scanSummary.warn > 0) params.logger.warn?.(params.suspiciousMessage.replace("{count}", String(scanSummary.warn)).replace("{target}", params.targetName));
		return builtinScan;
	} catch (err) {
		return buildBuiltinScanFromError(err);
	}
}
function readStringList(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => normalizeOptionalString(entry)).filter((entry) => Boolean(entry));
}
function collectPackageExecutableScanEntries(params) {
	const entries = [];
	const metadata = params.packageMetadata;
	const runtimeExtensions = readStringList(metadata?.runtimeExtensions);
	for (const [index, extensionEntry] of params.extensions.entries()) {
		entries.push(extensionEntry);
		const runtimeEntry = runtimeExtensions[index];
		if (runtimeEntry) {
			entries.push(runtimeEntry);
			continue;
		}
		entries.push(...listBuiltRuntimeEntryCandidates(extensionEntry));
	}
	const setupEntry = normalizeOptionalString(metadata?.setupEntry);
	if (setupEntry) entries.push(setupEntry);
	const runtimeSetupEntry = normalizeOptionalString(metadata?.runtimeSetupEntry);
	if (runtimeSetupEntry) entries.push(runtimeSetupEntry);
	else if (setupEntry) entries.push(...listBuiltRuntimeEntryCandidates(setupEntry));
	return [...new Set(entries)];
}
async function resolveRuntimeGraphFileCandidate(filePath) {
	const resolvedPath = path.resolve(filePath);
	const candidates = path.extname(resolvedPath).toLowerCase() ? [resolvedPath] : [
		resolvedPath,
		...RUNTIME_GRAPH_SCAN_EXTENSIONS.map((runtimeExt) => `${resolvedPath}${runtimeExt}`),
		...RUNTIME_GRAPH_SCAN_EXTENSIONS.map((runtimeExt) => path.join(resolvedPath, `index${runtimeExt}`))
	];
	for (const candidate of candidates) {
		let stat;
		try {
			stat = await fs.stat(candidate);
		} catch {
			continue;
		}
		if (stat.isFile() && RUNTIME_GRAPH_SCAN_EXTENSIONS.includes(path.extname(candidate))) return candidate;
	}
}
function collectLocalRuntimeImportSpecifiers(source) {
	const specifiers = [];
	for (const match of source.matchAll(LOCAL_RUNTIME_IMPORT_PATTERN)) {
		const specifier = match[1] ?? match[2] ?? match[3];
		if (specifier?.startsWith(".")) specifiers.push(specifier);
	}
	return specifiers;
}
async function collectPackageRuntimeGraphScanEntries(params) {
	const packageDir = path.resolve(params.packageDir);
	const seen = /* @__PURE__ */ new Set();
	const queue = [];
	const out = [];
	for (const entryFile of params.entryFiles) {
		const resolvedEntry = await resolveRuntimeGraphFileCandidate(entryFile);
		if (resolvedEntry && isPathInside(packageDir, resolvedEntry)) queue.push(resolvedEntry);
	}
	while (queue.length > 0 && out.length < RUNTIME_GRAPH_SCAN_MAX_FILES) {
		const filePath = queue.shift();
		if (!filePath) break;
		const resolvedPath = path.resolve(filePath);
		if (seen.has(resolvedPath) || !isPathInside(packageDir, resolvedPath)) continue;
		seen.add(resolvedPath);
		out.push(resolvedPath);
		let source;
		try {
			source = await fs.readFile(resolvedPath, "utf-8");
		} catch {
			continue;
		}
		for (const specifier of collectLocalRuntimeImportSpecifiers(source)) {
			const importedPath = path.resolve(path.dirname(resolvedPath), specifier);
			if (!isPathInside(packageDir, importedPath)) continue;
			const resolvedImport = await resolveRuntimeGraphFileCandidate(importedPath);
			if (resolvedImport && !seen.has(path.resolve(resolvedImport))) queue.push(resolvedImport);
		}
	}
	return out;
}
function buildBlockedScanResult(params) {
	if (params.builtinScan.status === "error") return { blocked: {
		code: "security_scan_failed",
		reason: buildScanFailureBlockReason({
			error: params.builtinScan.error ?? "unknown error",
			targetLabel: params.targetLabel
		})
	} };
	if (params.builtinScan.critical > 0) {
		if (params.dangerouslyForceUnsafeInstall || params.trustedSourceLinkedOfficialInstall) return;
		return { blocked: {
			code: "security_scan_blocked",
			reason: buildCriticalBlockReason({
				findings: params.builtinScan.findings,
				targetLabel: params.targetLabel
			})
		} };
	}
}
function logDangerousForceUnsafeInstall(params) {
	params.logger.warn?.(`WARNING: ${params.targetLabel} forced despite dangerous code patterns via --dangerously-force-unsafe-install: ${buildCriticalDetails({ findings: params.findings })}`);
}
function resolveBuiltinScanDecision(params) {
	const builtinBlocked = buildBlockedScanResult({
		builtinScan: params.builtinScan,
		dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
		trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
		targetLabel: params.targetLabel
	});
	if (params.dangerouslyForceUnsafeInstall && params.builtinScan.critical > 0) logDangerousForceUnsafeInstall({
		findings: params.builtinScan.findings,
		logger: params.logger,
		targetLabel: params.targetLabel
	});
	return builtinBlocked;
}
async function scanFileTarget(params) {
	const directory = path.dirname(params.path);
	return await scanDirectoryTarget({
		includeFiles: [params.path],
		logger: params.logger,
		onlyIncludeFiles: true,
		path: directory,
		suspiciousMessage: params.suspiciousMessage,
		targetName: params.targetName,
		warningMessage: params.warningMessage
	});
}
async function runBeforeInstallHook(params) {
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("before_install")) return;
	try {
		const { event, ctx } = createBeforeInstallHookPayload({
			targetName: params.targetName,
			targetType: params.targetType,
			origin: params.origin,
			sourcePath: params.sourcePath,
			sourcePathKind: params.sourcePathKind,
			request: {
				kind: params.requestKind,
				mode: params.requestMode,
				...params.requestedSpecifier ? { requestedSpecifier: params.requestedSpecifier } : {}
			},
			builtinScan: params.builtinScan,
			...params.skill ? { skill: params.skill } : {},
			...params.plugin ? { plugin: params.plugin } : {}
		});
		const hookResult = await hookRunner.runBeforeInstall(event, ctx);
		if (hookResult?.block) {
			const reason = hookResult.blockReason || "Installation blocked by plugin hook";
			params.logger.warn?.(`WARNING: ${params.installLabel} blocked by plugin hook: ${reason}`);
			return { blocked: { reason } };
		}
		if (hookResult?.findings) {
			for (const finding of hookResult.findings) if (finding.severity === "critical" || finding.severity === "warn") params.logger.warn?.(`Plugin scanner: ${finding.message} (${finding.file}:${finding.line})`);
		}
	} catch {}
}
async function scanBundleInstallSourceRuntime(params) {
	const dependencyBlocked = await scanManifestDependencyDenylist({
		logger: params.logger,
		packageDir: params.sourceDir,
		targetLabel: `Bundle "${params.pluginId}" installation`
	});
	if (dependencyBlocked) return dependencyBlocked;
	const builtinScan = await scanDirectoryTarget({
		logger: params.logger,
		path: params.sourceDir,
		suspiciousMessage: `Bundle "{target}" has {count} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
		targetName: params.pluginId,
		warningMessage: `WARNING: Bundle "${params.pluginId}" contains dangerous code patterns`
	});
	const builtinBlocked = resolveBuiltinScanDecision({
		builtinScan,
		logger: params.logger,
		dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
		targetLabel: `Bundle "${params.pluginId}" installation`
	});
	const hookResult = await runBeforeInstallHook({
		logger: params.logger,
		installLabel: `Bundle "${params.pluginId}" installation`,
		origin: "plugin-bundle",
		sourcePath: params.sourceDir,
		sourcePathKind: "directory",
		targetName: params.pluginId,
		targetType: "plugin",
		requestKind: params.requestKind ?? "plugin-dir",
		requestMode: params.mode ?? "install",
		requestedSpecifier: params.requestedSpecifier,
		builtinScan,
		plugin: {
			contentType: "bundle",
			pluginId: params.pluginId,
			manifestId: params.pluginId,
			...params.version ? { version: params.version } : {}
		}
	});
	return hookResult?.blocked ? hookResult : builtinBlocked;
}
async function scanPackageInstallSourceRuntime(params) {
	const dependencyBlocked = await scanManifestDependencyDenylist({
		logger: params.logger,
		packageDir: params.packageDir,
		targetLabel: `Plugin "${params.pluginId}" installation`
	});
	if (dependencyBlocked) return dependencyBlocked;
	const forcedScanEntries = [];
	const executableEntries = collectPackageExecutableScanEntries({
		extensions: params.extensions,
		...params.packageMetadata ? { packageMetadata: params.packageMetadata } : {}
	});
	for (const entry of executableEntries) {
		const resolvedEntry = path.resolve(params.packageDir, entry);
		if (!isPathInside(params.packageDir, resolvedEntry)) {
			params.logger.warn?.(`plugin executable entry escapes plugin directory and will not be scanned: ${entry}`);
			continue;
		}
		if (extensionUsesSkippedScannerPath(entry)) params.logger.warn?.(`plugin executable entry is in a hidden/node_modules path and will receive targeted scan coverage: ${entry}`);
		forcedScanEntries.push(resolvedEntry);
	}
	const builtinScan = await scanDirectoryTarget({
		includeFiles: await collectPackageRuntimeGraphScanEntries({
			entryFiles: forcedScanEntries,
			packageDir: params.packageDir
		}),
		logger: params.logger,
		onlyIncludeFiles: true,
		path: params.packageDir,
		suppressBuiltinWarnings: params.trustedSourceLinkedOfficialInstall === true,
		suspiciousMessage: `Plugin "{target}" has {count} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
		targetName: params.pluginId,
		warningMessage: `WARNING: Plugin "${params.pluginId}" contains dangerous code patterns`
	});
	const builtinBlocked = resolveBuiltinScanDecision({
		builtinScan,
		logger: params.logger,
		dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
		trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
		targetLabel: `Plugin "${params.pluginId}" installation`
	});
	const hookResult = await runBeforeInstallHook({
		logger: params.logger,
		installLabel: `Plugin "${params.pluginId}" installation`,
		origin: "plugin-package",
		sourcePath: params.packageDir,
		sourcePathKind: "directory",
		targetName: params.pluginId,
		targetType: "plugin",
		requestKind: params.requestKind ?? "plugin-dir",
		requestMode: params.mode ?? "install",
		requestedSpecifier: params.requestedSpecifier,
		builtinScan,
		plugin: {
			contentType: "package",
			pluginId: params.pluginId,
			...params.packageName ? { packageName: params.packageName } : {},
			...params.manifestId ? { manifestId: params.manifestId } : {},
			...params.version ? { version: params.version } : {},
			extensions: params.extensions.slice()
		}
	});
	return hookResult?.blocked ? hookResult : builtinBlocked;
}
async function scanInstalledPackageDependencyTreeRuntime(params) {
	const manifestScanRoots = await collectNonOverlappingPackageScanRoots(await collectInstalledPackageScanRoots({
		...params.additionalPackageDirs ? { additionalPackageDirs: params.additionalPackageDirs } : {},
		dependencyScanRootDir: params.dependencyScanRootDir,
		packageDir: params.packageDir
	}));
	for (const packageDir of manifestScanRoots) {
		const dependencyBlocked = await scanManifestDependencyDenylist({
			logger: params.logger,
			packageDir,
			allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
			relativeRootDir: params.dependencyScanRootDir ?? params.packageDir,
			targetLabel: `Plugin "${params.pluginId}" installation`
		});
		if (dependencyBlocked) return dependencyBlocked;
	}
}
async function scanFileInstallSourceRuntime(params) {
	const builtinScan = await scanFileTarget({
		logger: params.logger,
		path: params.filePath,
		suspiciousMessage: `Plugin file "{target}" has {count} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
		targetName: params.pluginId,
		warningMessage: `WARNING: Plugin file "${params.pluginId}" contains dangerous code patterns`
	});
	const builtinBlocked = resolveBuiltinScanDecision({
		builtinScan,
		logger: params.logger,
		dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
		targetLabel: `Plugin file "${params.pluginId}" installation`
	});
	const hookResult = await runBeforeInstallHook({
		logger: params.logger,
		installLabel: `Plugin file "${params.pluginId}" installation`,
		origin: "plugin-file",
		sourcePath: params.filePath,
		sourcePathKind: "file",
		targetName: params.pluginId,
		targetType: "plugin",
		requestKind: "plugin-file",
		requestMode: params.mode ?? "install",
		requestedSpecifier: params.requestedSpecifier,
		builtinScan,
		plugin: {
			contentType: "file",
			pluginId: params.pluginId,
			extensions: [path.basename(params.filePath)]
		}
	});
	return hookResult?.blocked ? hookResult : builtinBlocked;
}
async function scanSkillInstallSourceRuntime(params) {
	const builtinScan = await scanDirectoryTarget({
		logger: params.logger,
		path: params.sourceDir,
		suspiciousMessage: "Skill \"{target}\" has {count} suspicious code pattern(s). Run \"openclaw security audit --deep\" for details.",
		targetName: params.skillName,
		warningMessage: `WARNING: Skill "${params.skillName}" contains dangerous code patterns`
	});
	const builtinBlocked = buildBlockedScanResult({
		builtinScan,
		dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
		trustedSourceLinkedOfficialInstall: false,
		targetLabel: `Skill "${params.skillName}" installation`
	});
	if (params.dangerouslyForceUnsafeInstall && builtinScan.critical > 0) logDangerousForceUnsafeInstall({
		findings: builtinScan.findings,
		logger: params.logger,
		targetLabel: `Skill "${params.skillName}" installation`
	});
	const hookResult = await runBeforeInstallHook({
		logger: params.logger,
		installLabel: `Skill "${params.skillName}" installation`,
		origin: params.origin,
		sourcePath: params.sourceDir,
		sourcePathKind: "directory",
		targetName: params.skillName,
		targetType: "skill",
		requestKind: "skill-install",
		requestMode: "install",
		builtinScan,
		skill: {
			installId: params.installId,
			...params.installSpec ? { installSpec: params.installSpec } : {}
		}
	});
	return hookResult?.blocked ? hookResult : builtinBlocked;
}
//#endregion
export { scanBundleInstallSourceRuntime, scanFileInstallSourceRuntime, scanInstalledPackageDependencyTreeRuntime, scanPackageInstallSourceRuntime, scanSkillInstallSourceRuntime };
