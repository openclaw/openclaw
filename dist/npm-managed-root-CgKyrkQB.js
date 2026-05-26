import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-DDaGBMF_.js";
import { d as writeJson, i as readJsonIfExists, r as readJson } from "./json-files-CahFuwKs.js";
import { r as runCommandWithTimeout } from "./exec-DusmGtXL.js";
import { n as createSafeNpmInstallEnv } from "./safe-package-install-CslfQxx3.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/infra/npm-managed-root.ts
const DEFAULT_MANAGED_NPM_PEER_TRAVERSAL_LIMITS = {
	maxDepth: 64,
	maxDirectories: 1e4
};
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readOptionalString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readDependencyRecord(value) {
	if (!isRecord(value)) return {};
	const dependencies = {};
	for (const [key, raw] of Object.entries(value)) if (typeof raw === "string") dependencies[key] = raw;
	return dependencies;
}
function readPositiveIntegerEnv(name, fallback) {
	const rawValue = process.env[name];
	if (!rawValue) return fallback;
	const parsedValue = Number.parseInt(rawValue, 10);
	return Number.isFinite(parsedValue) && parsedValue >= 1 ? parsedValue : fallback;
}
function resolveManagedNpmPeerTraversalLimits() {
	return {
		maxDepth: readPositiveIntegerEnv("OPENCLAW_INSTALL_SCAN_MAX_DEPTH", DEFAULT_MANAGED_NPM_PEER_TRAVERSAL_LIMITS.maxDepth),
		maxDirectories: readPositiveIntegerEnv("OPENCLAW_INSTALL_SCAN_MAX_DIRECTORIES", DEFAULT_MANAGED_NPM_PEER_TRAVERSAL_LIMITS.maxDirectories)
	};
}
function isSamePathOrInside(parentPath, candidatePath) {
	const relative = path.relative(parentPath, candidatePath);
	return relative === "" || !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function isSafePackageName(name) {
	if (name.startsWith("@")) {
		const parts = name.split("/");
		return parts.length === 2 && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
	}
	return name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..";
}
function readOverrideRecord(value) {
	if (!isRecord(value)) return {};
	const overrides = {};
	for (const [key, raw] of Object.entries(value)) if (key.trim()) overrides[key] = raw;
	return overrides;
}
function readManagedOverrideKeys(value) {
	if (!isRecord(value) || !Array.isArray(value.managedOverrides)) return [];
	return value.managedOverrides.filter((key) => typeof key === "string");
}
function readManagedPeerDependencyKeys(value) {
	if (!isRecord(value) || !Array.isArray(value.managedPeerDependencies)) return [];
	return value.managedPeerDependencies.filter((key) => typeof key === "string");
}
function buildManagedOpenClawMetadata(params) {
	const metadata = isRecord(params.current) ? { ...params.current } : {};
	if (params.managedOverrideKeys.length > 0) metadata.managedOverrides = params.managedOverrideKeys;
	else delete metadata.managedOverrides;
	const managedPeerDependencyKeys = params.managedPeerDependencyKeys;
	if (managedPeerDependencyKeys && managedPeerDependencyKeys.length > 0) metadata.managedPeerDependencies = managedPeerDependencyKeys;
	else if (managedPeerDependencyKeys) delete metadata.managedPeerDependencies;
	return Object.keys(metadata).length > 0 ? metadata : void 0;
}
async function readManagedNpmRootManifest(filePath) {
	const parsed = await readJsonIfExists(filePath);
	return isRecord(parsed) ? { ...parsed } : {};
}
function readHostDependencySpec(manifest, packageName) {
	return manifest.dependencies?.[packageName] ?? manifest.optionalDependencies?.[packageName] ?? manifest.peerDependencies?.[packageName] ?? manifest.devDependencies?.[packageName];
}
function resolveHostOverrideReferences(value, manifest) {
	if (typeof value === "string" && value.startsWith("$")) return readHostDependencySpec(manifest, value.slice(1)) ?? value;
	if (!isRecord(value)) return value;
	const resolved = {};
	for (const [key, nested] of Object.entries(value)) resolved[key] = resolveHostOverrideReferences(nested, manifest);
	return resolved;
}
function isUnsupportedManagedNpmOverride(value) {
	return typeof value === "string" && value.trim().startsWith("npm:");
}
function filterUnsupportedManagedNpmRootOverrides(value) {
	const overrides = readOverrideRecord(value);
	const filtered = {};
	for (const [key, raw] of Object.entries(overrides)) {
		if (isUnsupportedManagedNpmOverride(raw)) continue;
		if (isRecord(raw)) {
			const nested = filterUnsupportedManagedNpmRootOverrides(raw);
			if (Object.keys(nested).length > 0) filtered[key] = nested;
			continue;
		}
		filtered[key] = raw;
	}
	return filtered;
}
async function readOpenClawManagedNpmRootOverrides(params) {
	const packageRoot = params?.packageRoot ?? resolveOpenClawPackageRootSync({
		argv1: params?.argv1 ?? process.argv[1],
		moduleUrl: params?.moduleUrl ?? import.meta.url,
		cwd: params?.cwd ?? process.cwd()
	});
	if (!packageRoot) return {};
	try {
		const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
		if (!isRecord(manifest)) return {};
		const hostManifest = manifest;
		const overrides = readOverrideRecord(hostManifest.overrides);
		return Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, resolveHostOverrideReferences(value, hostManifest)]));
	} catch {
		return {};
	}
}
function resolveManagedNpmRootDependencySpec(params) {
	return params.resolution.version ?? params.parsedSpec.selector ?? "latest";
}
async function upsertManagedNpmRootDependency(params) {
	await fs.mkdir(params.npmRoot, { recursive: true });
	const manifestPath = path.join(params.npmRoot, "package.json");
	const manifest = await readManagedNpmRootManifest(manifestPath);
	const dependencies = readDependencyRecord(manifest.dependencies);
	const managedOverrides = params.omitUnsupportedManagedOverrides ? filterUnsupportedManagedNpmRootOverrides(params.managedOverrides) : readOverrideRecord(params.managedOverrides);
	const managedOverrideKeys = Object.keys(managedOverrides).toSorted();
	const overrides = readOverrideRecord(manifest.overrides);
	for (const key of readManagedOverrideKeys(manifest.openclaw)) delete overrides[key];
	Object.assign(overrides, managedOverrides);
	const openclawMetadata = buildManagedOpenClawMetadata({
		current: manifest.openclaw,
		managedOverrideKeys
	});
	const next = {
		...manifest,
		private: true,
		dependencies: {
			...dependencies,
			[params.packageName]: params.dependencySpec
		}
	};
	if (Object.keys(overrides).length > 0) next.overrides = overrides;
	else delete next.overrides;
	if (openclawMetadata) next.openclaw = openclawMetadata;
	else delete next.openclaw;
	await writeJson(manifestPath, next, { trailingNewline: true });
}
async function readPackageJsonIfExists(packageDir) {
	try {
		const parsed = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}
async function readPackageVersion(packageDir) {
	const parsed = await readPackageJsonIfExists(packageDir);
	return parsed ? readOptionalString(parsed.version) : void 0;
}
function isOptionalPeerDependency(manifest, peerName) {
	if (!isRecord(manifest.peerDependenciesMeta)) return false;
	const peerMetadata = manifest.peerDependenciesMeta[peerName];
	return isRecord(peerMetadata) && peerMetadata.optional === true;
}
async function listNodeModulesPackageDirs(nodeModulesDir) {
	let entries;
	try {
		entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });
	} catch (err) {
		if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
		throw err;
	}
	const packageDirs = [];
	for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
		if (entry.name === ".bin" || entry.name === "openclaw" || entry.name.startsWith(".")) continue;
		const entryPath = path.join(nodeModulesDir, entry.name);
		if (entry.name.startsWith("@") && entry.isDirectory()) {
			let scopedEntries;
			try {
				scopedEntries = await fs.readdir(entryPath, { withFileTypes: true });
			} catch (err) {
				if (err.code === "ENOENT" || err.code === "ENOTDIR") continue;
				throw err;
			}
			for (const scopedEntry of scopedEntries.toSorted((left, right) => left.name.localeCompare(right.name))) if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) packageDirs.push(path.join(entryPath, scopedEntry.name));
			continue;
		}
		if (entry.isDirectory() || entry.isSymbolicLink()) packageDirs.push(entryPath);
	}
	return packageDirs;
}
async function collectManagedNpmRootPeerDependencyPins(params) {
	const pins = /* @__PURE__ */ new Map();
	const limits = resolveManagedNpmPeerTraversalLimits();
	const boundaryRealPath = await fs.realpath(params.npmRoot).catch(() => path.resolve(params.npmRoot));
	const queue = (await listNodeModulesPackageDirs(path.join(params.npmRoot, "node_modules"))).map((packageDir) => ({
		depth: 0,
		packageDir
	}));
	const visitedRealPaths = /* @__PURE__ */ new Set();
	for (let index = 0; index < queue.length; index += 1) {
		const current = queue[index];
		if (!current) continue;
		if (current.depth > limits.maxDepth) throw new Error(`managed npm peer dependency scan exceeded max depth (${limits.maxDepth}) at ${current.packageDir}`);
		const packageDirRealPath = await fs.realpath(current.packageDir).catch(() => path.resolve(current.packageDir));
		if (!isSamePathOrInside(boundaryRealPath, packageDirRealPath)) throw new Error(`managed npm peer dependency scan found package outside managed npm root at ${current.packageDir}`);
		if (visitedRealPaths.has(packageDirRealPath)) continue;
		visitedRealPaths.add(packageDirRealPath);
		if (visitedRealPaths.size > limits.maxDirectories) throw new Error(`managed npm peer dependency scan exceeded max packages (${limits.maxDirectories}) under ${params.npmRoot}`);
		const packageDir = current.packageDir;
		const manifest = await readPackageJsonIfExists(packageDir);
		if (manifest) {
			const packageName = readOptionalString(manifest.name);
			if (packageName === "openclaw") continue;
			const isPreferredPackage = packageName === params.preferredPackageName;
			const peerDependencies = readDependencyRecord(manifest.peerDependencies);
			for (const [peerName, peerRange] of Object.entries(peerDependencies)) {
				if (peerName === "openclaw" || pins.has(peerName) && !isPreferredPackage || !isSafePackageName(peerName)) continue;
				const installedVersion = await readPackageVersion(path.join(params.npmRoot, "node_modules", ...peerName.split("/")));
				if (!installedVersion && isOptionalPeerDependency(manifest, peerName)) continue;
				const previousManagedSpec = params.previousManagedPeerDependencySpecs?.get(peerName);
				pins.set(peerName, isPreferredPackage ? peerRange : previousManagedSpec ?? installedVersion ?? peerRange);
			}
		}
		queue.push(...(await listNodeModulesPackageDirs(path.join(packageDir, "node_modules"))).map((nestedPackageDir) => ({
			depth: current.depth + 1,
			packageDir: nestedPackageDir
		})));
	}
	return Object.fromEntries([...pins.entries()].toSorted(([left], [right]) => left.localeCompare(right)));
}
async function readManagedNpmRootPeerDependencySnapshot(params) {
	const manifest = await readManagedNpmRootManifest(path.join(params.npmRoot, "package.json"));
	const dependencies = readDependencyRecord(manifest.dependencies);
	const managedPeerDependencies = readManagedPeerDependencyKeys(manifest.openclaw).toSorted();
	const dependencySnapshot = {};
	for (const packageName of managedPeerDependencies) {
		const dependencySpec = dependencies[packageName];
		if (dependencySpec) dependencySnapshot[packageName] = dependencySpec;
	}
	return {
		dependencies: dependencySnapshot,
		managedPeerDependencies
	};
}
async function restoreManagedNpmRootPeerDependencySnapshot(params) {
	const manifestPath = path.join(params.npmRoot, "package.json");
	const manifest = await readManagedNpmRootManifest(manifestPath);
	const dependencies = readDependencyRecord(manifest.dependencies);
	for (const packageName of readManagedPeerDependencyKeys(manifest.openclaw)) delete dependencies[packageName];
	Object.assign(dependencies, params.snapshot.dependencies);
	const managedOverrideKeys = readManagedOverrideKeys(manifest.openclaw).toSorted();
	const openclawMetadata = buildManagedOpenClawMetadata({
		current: manifest.openclaw,
		managedOverrideKeys,
		managedPeerDependencyKeys: params.snapshot.managedPeerDependencies.toSorted()
	});
	const next = {
		...manifest,
		private: true,
		dependencies
	};
	if (openclawMetadata) next.openclaw = openclawMetadata;
	else delete next.openclaw;
	await writeJson(manifestPath, next, { trailingNewline: true });
}
async function syncManagedNpmRootPeerDependencies(params) {
	const manifestPath = path.join(params.npmRoot, "package.json");
	const manifest = await readManagedNpmRootManifest(manifestPath);
	const dependencies = readDependencyRecord(manifest.dependencies);
	const previousManagedPeerDependencies = readManagedPeerDependencyKeys(manifest.openclaw);
	const previousManagedPeerDependencySet = new Set(previousManagedPeerDependencies);
	const previousManagedPeerDependencySpecs = new Map(previousManagedPeerDependencies.flatMap((packageName) => {
		const dependencySpec = dependencies[packageName];
		return dependencySpec ? [[packageName, dependencySpec]] : [];
	}));
	const peerPins = await collectManagedNpmRootPeerDependencyPins({
		npmRoot: params.npmRoot,
		preferredPackageName: params.preferredPackageName,
		previousManagedPeerDependencySet,
		previousManagedPeerDependencySpecs
	});
	const nextDependencies = { ...dependencies };
	for (const packageName of previousManagedPeerDependencies) if (!Object.hasOwn(peerPins, packageName)) delete nextDependencies[packageName];
	for (const [packageName, dependencySpec] of Object.entries(peerPins)) if (previousManagedPeerDependencySet.has(packageName) || !Object.hasOwn(dependencies, packageName)) nextDependencies[packageName] = dependencySpec;
	const managedOverrides = params.omitUnsupportedManagedOverrides ? filterUnsupportedManagedNpmRootOverrides(params.managedOverrides) : readOverrideRecord(params.managedOverrides);
	const managedOverrideKeys = Object.keys(managedOverrides).toSorted();
	const overrides = readOverrideRecord(manifest.overrides);
	for (const key of readManagedOverrideKeys(manifest.openclaw)) delete overrides[key];
	Object.assign(overrides, managedOverrides);
	const managedPeerDependencyKeys = Object.keys(peerPins).filter((packageName) => previousManagedPeerDependencySet.has(packageName) || !Object.hasOwn(dependencies, packageName)).toSorted();
	const openclawMetadata = buildManagedOpenClawMetadata({
		current: manifest.openclaw,
		managedOverrideKeys,
		managedPeerDependencyKeys
	});
	const next = {
		...manifest,
		private: true,
		dependencies: nextDependencies
	};
	if (Object.keys(overrides).length > 0) next.overrides = overrides;
	else delete next.overrides;
	if (openclawMetadata) next.openclaw = openclawMetadata;
	else delete next.openclaw;
	const changed = JSON.stringify(next) !== JSON.stringify(manifest);
	if (changed) await writeJson(manifestPath, next, { trailingNewline: true });
	return changed;
}
async function repairManagedNpmRootOpenClawPeer(params) {
	await fs.mkdir(params.npmRoot, { recursive: true });
	const hasManifestDependency = "openclaw" in readDependencyRecord((await readManagedNpmRootManifest(path.join(params.npmRoot, "package.json"))).dependencies);
	const hasLockDependency = await managedNpmRootLockfileHasOpenClawPeer(params.npmRoot);
	const hasPackageDir = await pathExists(path.join(params.npmRoot, "node_modules", "openclaw"));
	if (!hasManifestDependency && !hasLockDependency && !hasPackageDir) return false;
	const command = params.runCommand ?? runCommandWithTimeout;
	const npmArgs = hasManifestDependency ? [
		"npm",
		"uninstall",
		"--loglevel=error",
		"--legacy-peer-deps",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"openclaw"
	] : [
		"npm",
		"prune",
		"--loglevel=error",
		"--legacy-peer-deps",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund"
	];
	try {
		const result = await command(npmArgs, {
			cwd: params.npmRoot,
			timeoutMs: Math.max(params.timeoutMs ?? 3e5, 3e5),
			env: createSafeNpmInstallEnv(process.env, {
				legacyPeerDeps: true,
				packageLock: true,
				quiet: true
			})
		});
		if (result.code !== 0) params.logger?.warn?.(`npm ${hasManifestDependency ? "uninstall openclaw" : "prune"} failed while repairing managed npm root; falling back to direct cleanup: ${result.stderr.trim() || result.stdout.trim()}`);
	} catch (error) {
		params.logger?.warn?.(`npm ${hasManifestDependency ? "uninstall openclaw" : "prune"} failed while repairing managed npm root; falling back to direct cleanup: ${String(error)}`);
	}
	await scrubManagedNpmRootOpenClawPeer({ npmRoot: params.npmRoot });
	return true;
}
async function managedNpmRootLockfileHasOpenClawPeer(npmRoot) {
	const lockPath = path.join(npmRoot, "package-lock.json");
	try {
		const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
		if (isRecord(parsed.packages)) {
			const rootPackage = parsed.packages[""];
			if (isRecord(rootPackage) && isRecord(rootPackage.dependencies) && "openclaw" in rootPackage.dependencies) return true;
			if ("node_modules/openclaw" in parsed.packages) return true;
		}
		return isRecord(parsed.dependencies) && "openclaw" in parsed.dependencies;
	} catch (err) {
		if (err.code === "ENOENT") return false;
		throw err;
	}
}
async function pathExists(filePath) {
	return await fs.lstat(filePath).then(() => true).catch((err) => {
		if (err.code === "ENOENT") return false;
		throw err;
	});
}
async function scrubManagedNpmRootOpenClawPeer(params) {
	const manifestPath = path.join(params.npmRoot, "package.json");
	const manifest = await readManagedNpmRootManifest(manifestPath);
	const dependencies = readDependencyRecord(manifest.dependencies);
	if ("openclaw" in dependencies) {
		const { openclaw: _removed, ...nextDependencies } = dependencies;
		await fs.writeFile(manifestPath, `${JSON.stringify({
			...manifest,
			private: true,
			dependencies: nextDependencies
		}, null, 2)}\n`, "utf8");
	}
	const lockPath = path.join(params.npmRoot, "package-lock.json");
	try {
		const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
		let lockChanged = false;
		if (isRecord(parsed.packages)) {
			const rootPackage = parsed.packages[""];
			if (isRecord(rootPackage) && isRecord(rootPackage.dependencies)) {
				const dependencies = { ...rootPackage.dependencies };
				if ("openclaw" in dependencies) {
					delete dependencies.openclaw;
					parsed.packages[""] = {
						...rootPackage,
						dependencies
					};
					lockChanged = true;
				}
			}
			if ("node_modules/openclaw" in parsed.packages) {
				delete parsed.packages["node_modules/openclaw"];
				lockChanged = true;
			}
		}
		if (isRecord(parsed.dependencies) && "openclaw" in parsed.dependencies) {
			const dependencies = { ...parsed.dependencies };
			delete dependencies.openclaw;
			parsed.dependencies = dependencies;
			lockChanged = true;
		}
		if (lockChanged) await fs.writeFile(lockPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	const openclawPackageDir = path.join(params.npmRoot, "node_modules", "openclaw");
	if (await pathExists(openclawPackageDir)) await fs.rm(openclawPackageDir, {
		recursive: true,
		force: true
	});
	const binDir = path.join(params.npmRoot, "node_modules", ".bin");
	await Promise.all([
		"openclaw",
		"openclaw.cmd",
		"openclaw.ps1"
	].map((binName) => fs.rm(path.join(binDir, binName), { force: true })));
	await fs.rm(path.join(params.npmRoot, "node_modules", ".package-lock.json"), { force: true });
}
async function readManagedNpmRootInstalledDependency(params) {
	const parsed = await readJson(path.join(params.npmRoot, "package-lock.json"));
	if (!isRecord(parsed) || !isRecord(parsed.packages)) return null;
	const entry = parsed.packages[`node_modules/${params.packageName}`];
	if (!isRecord(entry)) return null;
	return {
		version: readOptionalString(entry.version),
		integrity: readOptionalString(entry.integrity),
		resolved: readOptionalString(entry.resolved)
	};
}
async function removeManagedNpmRootDependency(params) {
	const manifestPath = path.join(params.npmRoot, "package.json");
	const manifest = await readManagedNpmRootManifest(manifestPath);
	const dependencies = readDependencyRecord(manifest.dependencies);
	if (!(params.packageName in dependencies)) return;
	const { [params.packageName]: _removed, ...nextDependencies } = dependencies;
	await writeJson(manifestPath, {
		...manifest,
		private: true,
		dependencies: nextDependencies
	}, { trailingNewline: true });
}
//#endregion
export { repairManagedNpmRootOpenClawPeer as a, syncManagedNpmRootPeerDependencies as c, removeManagedNpmRootDependency as i, upsertManagedNpmRootDependency as l, readManagedNpmRootPeerDependencySnapshot as n, resolveManagedNpmRootDependencySpec as o, readOpenClawManagedNpmRootOverrides as r, restoreManagedNpmRootPeerDependencySnapshot as s, readManagedNpmRootInstalledDependency as t };
