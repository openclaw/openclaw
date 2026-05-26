import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-CNp1Ofdk.js";
import { a as readJsonIfExists, m as writeJson, n as readJson } from "./json-files-C2hqjU--.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { n as createSafeNpmInstallEnv, t as createSafeNpmInstallArgs } from "./safe-package-install-CZ0VYBja.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region src/infra/npm-managed-root.ts
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
function isSafePackageName(name) {
	if (name.startsWith("@")) {
		const parts = name.split("/");
		return parts.length === 2 && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
	}
	return name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..";
}
function isManagedNpmRootHostPeerPackageName(name) {
	return name === "openclaw";
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
function isOptionalPeerDependency(manifest, peerName) {
	if (!isRecord(manifest.peerDependenciesMeta)) return false;
	const peerMetadata = manifest.peerDependenciesMeta[peerName];
	return isRecord(peerMetadata) && peerMetadata.optional === true;
}
function isDevOnlyLockPackage(value) {
	return isRecord(value) && value.dev === true;
}
function readStringList(value) {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return;
	const values = value.filter((entry) => typeof entry === "string");
	return values.length > 0 ? values : void 0;
}
function matchesNpmPlatformList(value, list) {
	if (!list) return true;
	if (list.length === 1 && list[0] === "any") return true;
	if (!value) return false;
	let negated = 0;
	let matched = false;
	for (const entry of list) {
		const negate = entry.startsWith("!");
		const test = negate ? entry.slice(1) : entry;
		if (negate) {
			negated += 1;
			if (value === test) return false;
		} else matched = matched || value === test;
	}
	return matched || negated === list.length;
}
function resolveCurrentLibc() {
	if (process.platform !== "linux") return;
	const report = process.report?.getReport();
	const header = isRecord(report) ? report.header : void 0;
	if (isRecord(header) && header.glibcVersionRuntime) return "glibc";
	const sharedObjects = isRecord(report) ? report.sharedObjects : void 0;
	if (Array.isArray(sharedObjects) && sharedObjects.some((file) => typeof file === "string" && file.includes("musl"))) return "musl";
}
function isUnsupportedOptionalLockPackage(value) {
	if (!isRecord(value) || value.optional !== true) return false;
	return !matchesNpmPlatformList(process.platform, readStringList(value.os)) || !matchesNpmPlatformList(process.arch, readStringList(value.cpu)) || !matchesNpmPlatformList(resolveCurrentLibc(), readStringList(value.libc));
}
function readLockPackageName(location, value) {
	if (isRecord(value)) {
		const packageName = readOptionalString(value.name);
		if (packageName) return packageName;
	}
	const parts = location.split("/");
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		if (parts[index] !== "node_modules") continue;
		const first = parts[index + 1];
		if (!first) return;
		if (!first.startsWith("@")) return first;
		const second = parts[index + 2];
		return second ? `${first}/${second}` : void 0;
	}
}
function isTopLevelLockPackageLocation(location) {
	return location.split("/").filter((part) => part === "node_modules").length === 1;
}
function findLockPackageVersion(params) {
	if (!isRecord(params.lockfile.packages)) return;
	const preferredLocation = `node_modules/${params.packageName}`;
	const preferredPackage = params.lockfile.packages[preferredLocation];
	if (isRecord(preferredPackage) && !isDevOnlyLockPackage(preferredPackage) && !isUnsupportedOptionalLockPackage(preferredPackage)) {
		const preferredVersion = readOptionalString(preferredPackage.version);
		if (preferredVersion) return preferredVersion;
	}
}
function collectNpmLockPeerDependencyPins(params) {
	const pins = /* @__PURE__ */ new Map();
	const packages = isRecord(params.lockfile.packages) ? params.lockfile.packages : {};
	for (const [location, value] of Object.entries(packages).toSorted(([left], [right]) => left.localeCompare(right))) {
		if (location === "" || !isRecord(value) || isDevOnlyLockPackage(value) || isUnsupportedOptionalLockPackage(value)) continue;
		const packageName = readLockPackageName(location, value);
		if (packageName && isManagedNpmRootHostPeerPackageName(packageName)) continue;
		const peerDependencies = readDependencyRecord(value.peerDependencies);
		for (const [peerName, peerRange] of Object.entries(peerDependencies)) {
			if (isManagedNpmRootHostPeerPackageName(peerName) || pins.has(peerName) || !isSafePackageName(peerName)) continue;
			const version = findLockPackageVersion({
				lockfile: params.lockfile,
				packageName: peerName
			});
			if (!version && isOptionalPeerDependency(value, peerName)) continue;
			if (!version && !isTopLevelLockPackageLocation(location)) continue;
			pins.set(peerName, version ?? peerRange);
		}
	}
	return Object.fromEntries([...pins.entries()].toSorted(([left], [right]) => left.localeCompare(right)));
}
async function copyPathIfExists(source, destination) {
	try {
		await fs.cp(source, destination, { recursive: true });
	} catch (err) {
		if (err.code === "ENOENT") return;
		throw err;
	}
}
function scrubHostPeerFromLockPackage(value) {
	if (!isRecord(value)) return false;
	let changed = false;
	if (isRecord(value.peerDependencies) && "openclaw" in value.peerDependencies) {
		const peerDependencies = { ...value.peerDependencies };
		delete peerDependencies.openclaw;
		if (Object.keys(peerDependencies).length > 0) value.peerDependencies = peerDependencies;
		else delete value.peerDependencies;
		changed = true;
	}
	if (isRecord(value.peerDependenciesMeta) && "openclaw" in value.peerDependenciesMeta) {
		const peerDependenciesMeta = { ...value.peerDependenciesMeta };
		delete peerDependenciesMeta.openclaw;
		if (Object.keys(peerDependenciesMeta).length > 0) value.peerDependenciesMeta = peerDependenciesMeta;
		else delete value.peerDependenciesMeta;
		changed = true;
	}
	return changed;
}
async function scrubHostPeerFromTempPackageLock(lockPath) {
	const parsed = await readJsonIfExists(lockPath);
	if (!isRecord(parsed)) return;
	let changed = false;
	if (isRecord(parsed.packages)) for (const value of Object.values(parsed.packages)) changed = scrubHostPeerFromLockPackage(value) || changed;
	if (isRecord(parsed.dependencies)) for (const value of Object.values(parsed.dependencies)) changed = scrubHostPeerFromLockPackage(value) || changed;
	if (changed) await writeJson(lockPath, parsed, { trailingNewline: true });
}
function collectExistingManagedPeerDependencyPins(dependencies, previousManagedPeerDependencies) {
	const pins = {};
	for (const packageName of previousManagedPeerDependencies) {
		const dependencySpec = dependencies[packageName];
		if (dependencySpec) pins[packageName] = dependencySpec;
	}
	return pins;
}
function isHostPeerResolutionFailure(result) {
	const output = `${result.stdout}\n${result.stderr}`;
	return /(^|[^@\w.-])openclaw(?=$|[@\s:,"'])/i.test(output);
}
function createManagedNpmPeerPlanArgs(params) {
	return [
		"npm",
		"install",
		"--package-lock-only",
		...params?.force ? ["--force"] : [],
		...createSafeNpmInstallArgs({
			omitDev: true,
			omitPeer: true,
			legacyPeerDeps: params?.legacyPeerDeps,
			loglevel: "error",
			ignoreWorkspaces: true,
			noAudit: true,
			noFund: true
		}).slice(1)
	];
}
async function collectNpmResolvedManagedNpmRootPeerDependencyPins(params) {
	const manifest = await readManagedNpmRootManifest(path.join(params.npmRoot, "package.json"));
	const dependencies = readDependencyRecord(manifest.dependencies);
	const previousManagedPeerDependencies = readManagedPeerDependencyKeys(manifest.openclaw);
	const fallbackPeerPins = collectExistingManagedPeerDependencyPins(dependencies, previousManagedPeerDependencies);
	for (const packageName of previousManagedPeerDependencies) delete dependencies[packageName];
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-peer-plan-"));
	try {
		delete dependencies.openclaw;
		await writeJson(path.join(tempRoot, "package.json"), {
			...manifest,
			private: true,
			dependencies
		}, { trailingNewline: true });
		await copyPathIfExists(path.join(params.npmRoot, "package-lock.json"), path.join(tempRoot, "package-lock.json"));
		const tempLockPath = path.join(tempRoot, "package-lock.json");
		await scrubHostPeerFromTempPackageLock(tempLockPath);
		await copyPathIfExists(path.join(params.npmRoot, ".npmrc"), path.join(tempRoot, ".npmrc"));
		await copyPathIfExists(path.join(params.npmRoot, "_openclaw-pack-archives"), path.join(tempRoot, "_openclaw-pack-archives"));
		const command = params.runCommand ?? runCommandWithTimeout;
		const npmPeerPlanArgs = createManagedNpmPeerPlanArgs({ force: true });
		const npmPlanOptions = {
			cwd: tempRoot,
			timeoutMs: Math.max(params.timeoutMs ?? 3e5, 3e5),
			env: createSafeNpmInstallEnv(process.env, {
				legacyPeerDeps: false,
				npmConfigCwd: tempRoot,
				packageLock: true,
				quiet: true
			})
		};
		const result = await command(npmPeerPlanArgs, npmPlanOptions);
		if (result.code !== 0) {
			if (isHostPeerResolutionFailure(result)) {
				if ((await command(createManagedNpmPeerPlanArgs({
					force: true,
					legacyPeerDeps: true
				}), {
					...npmPlanOptions,
					env: createSafeNpmInstallEnv(process.env, {
						legacyPeerDeps: true,
						npmConfigCwd: tempRoot,
						packageLock: true,
						quiet: true
					})
				})).code === 0) return collectNpmLockPeerDependencyPins({ lockfile: await readManagedNpmRootManifest(tempLockPath) });
			}
			return fallbackPeerPins;
		}
		return collectNpmLockPeerDependencyPins({ lockfile: await readManagedNpmRootManifest(tempLockPath) });
	} finally {
		await fs.rm(tempRoot, {
			recursive: true,
			force: true
		});
	}
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
	const peerPins = await collectNpmResolvedManagedNpmRootPeerDependencyPins({
		npmRoot: params.npmRoot,
		runCommand: params.runCommand,
		timeoutMs: params.timeoutMs
	});
	const nextDependencies = { ...dependencies };
	for (const packageName of previousManagedPeerDependencies) if (!Object.hasOwn(peerPins, packageName)) delete nextDependencies[packageName];
	for (const [packageName, dependencySpec] of Object.entries(peerPins)) nextDependencies[packageName] = dependencies[packageName] ?? dependencySpec;
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
	const activeHostState = await readManagedNpmRootOpenClawHostState({
		npmRoot: params.npmRoot,
		packageRoot: params.packageRoot
	});
	if (activeHostState === "managed-active-host") return false;
	const hasManifestDependency = "openclaw" in readDependencyRecord((await readManagedNpmRootManifest(path.join(params.npmRoot, "package.json"))).dependencies);
	const hasLockDependency = await managedNpmRootLockfileHasOpenClawPeer(params.npmRoot);
	const hasPackageDir = await pathExists(path.join(params.npmRoot, "node_modules", "openclaw"));
	const preserveActiveHostLink = activeHostState === "linked-active-host";
	if (!hasManifestDependency && !hasLockDependency && (!hasPackageDir || preserveActiveHostLink)) return false;
	if (preserveActiveHostLink) {
		await scrubManagedNpmRootOpenClawPeer({
			npmRoot: params.npmRoot,
			preservePackageDir: true
		});
		return true;
	}
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
				npmConfigCwd: params.npmRoot,
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
async function readManagedNpmRootOpenClawHostState(params) {
	const packageRoot = params.packageRoot === void 0 ? resolveOpenClawPackageRootSync({
		argv1: process.argv[1],
		moduleUrl: import.meta.url,
		cwd: process.cwd()
	}) : params.packageRoot;
	if (!packageRoot) return "none";
	const managedOpenClawPackageDir = path.join(params.npmRoot, "node_modules", "openclaw");
	const [hostPackageRoot, managedPackageRoot, managedPackageStat] = await Promise.all([
		realpathIfExists(packageRoot),
		realpathIfExists(managedOpenClawPackageDir),
		lstatIfExists(managedOpenClawPackageDir)
	]);
	if (hostPackageRoot === null || hostPackageRoot !== managedPackageRoot) return "none";
	return managedPackageStat?.isSymbolicLink() ? "linked-active-host" : "managed-active-host";
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
async function realpathIfExists(filePath) {
	try {
		return await fs.realpath(filePath);
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}
async function lstatIfExists(filePath) {
	try {
		return await fs.lstat(filePath);
	} catch (err) {
		if (err.code === "ENOENT") return null;
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
	if (!params.preservePackageDir && await pathExists(openclawPackageDir)) await fs.rm(openclawPackageDir, {
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
