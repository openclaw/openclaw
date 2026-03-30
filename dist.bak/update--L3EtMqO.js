import { y as resolveUserPath } from "./utils-BKDT474X.js";
import { a as openBoundaryFileSync } from "./openclaw-root-PhSD0wUu.js";
import { o as loadPluginManifest, r as discoverOpenClawPlugins } from "./manifest-registry-BvFf4Q1K.js";
import { a as resolvePluginInstallDir, n as recordPluginInstall, r as installPluginFromNpmSpec, t as buildNpmResolutionInstallFields } from "./installs-CHBiOuBt.js";
import fs from "node:fs";
import path from "node:path";

//#region src/plugins/bundled-sources.ts
function resolveBundledPluginSources(params) {
	const discovery = discoverOpenClawPlugins({ workspaceDir: params.workspaceDir });
	const bundled = /* @__PURE__ */ new Map();
	for (const candidate of discovery.candidates) {
		if (candidate.origin !== "bundled") continue;
		const manifest = loadPluginManifest(candidate.rootDir);
		if (!manifest.ok) continue;
		const pluginId = manifest.manifest.id;
		if (bundled.has(pluginId)) continue;
		const npmSpec = candidate.packageManifest?.install?.npmSpec?.trim() || candidate.packageName?.trim() || void 0;
		bundled.set(pluginId, {
			pluginId,
			localPath: candidate.rootDir,
			npmSpec
		});
	}
	return bundled;
}
function findBundledPluginByNpmSpec(params) {
	const targetSpec = params.spec.trim();
	if (!targetSpec) return;
	const bundled = resolveBundledPluginSources({ workspaceDir: params.workspaceDir });
	for (const source of bundled.values()) if (source.npmSpec === targetSpec) return source;
}

//#endregion
//#region src/plugins/update.ts
async function readInstalledPackageVersion(dir) {
	const opened = openBoundaryFileSync({
		absolutePath: path.join(dir, "package.json"),
		rootPath: dir,
		boundaryLabel: "installed plugin directory"
	});
	if (!opened.ok) return;
	try {
		const raw = fs.readFileSync(opened.fd, "utf-8");
		const parsed = JSON.parse(raw);
		return typeof parsed.version === "string" ? parsed.version : void 0;
	} catch {
		return;
	} finally {
		fs.closeSync(opened.fd);
	}
}
function pathsEqual(left, right) {
	if (!left || !right) return false;
	return resolveUserPath(left) === resolveUserPath(right);
}
function buildLoadPathHelpers(existing) {
	let paths = [...existing];
	const resolveSet = () => new Set(paths.map((entry) => resolveUserPath(entry)));
	let resolved = resolveSet();
	let changed = false;
	const addPath = (value) => {
		const normalized = resolveUserPath(value);
		if (resolved.has(normalized)) return;
		paths.push(value);
		resolved.add(normalized);
		changed = true;
	};
	const removePath = (value) => {
		const normalized = resolveUserPath(value);
		if (!resolved.has(normalized)) return;
		paths = paths.filter((entry) => resolveUserPath(entry) !== normalized);
		resolved = resolveSet();
		changed = true;
	};
	return {
		addPath,
		removePath,
		get changed() {
			return changed;
		},
		get paths() {
			return paths;
		}
	};
}
function createPluginUpdateIntegrityDriftHandler(params) {
	return async (drift) => {
		const payload = {
			pluginId: params.pluginId,
			spec: drift.spec,
			expectedIntegrity: drift.expectedIntegrity,
			actualIntegrity: drift.actualIntegrity,
			resolvedSpec: drift.resolution.resolvedSpec,
			resolvedVersion: drift.resolution.version,
			dryRun: params.dryRun
		};
		if (params.onIntegrityDrift) return await params.onIntegrityDrift(payload);
		params.logger.warn?.(`Integrity drift for "${params.pluginId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`);
		return true;
	};
}
async function updateNpmInstalledPlugins(params) {
	const logger = params.logger ?? {};
	const installs = params.config.plugins?.installs ?? {};
	const targets = params.pluginIds?.length ? params.pluginIds : Object.keys(installs);
	const outcomes = [];
	let next = params.config;
	let changed = false;
	for (const pluginId of targets) {
		if (params.skipIds?.has(pluginId)) {
			outcomes.push({
				pluginId,
				status: "skipped",
				message: `Skipping "${pluginId}" (already updated).`
			});
			continue;
		}
		const record = installs[pluginId];
		if (!record) {
			outcomes.push({
				pluginId,
				status: "skipped",
				message: `No install record for "${pluginId}".`
			});
			continue;
		}
		if (record.source !== "npm") {
			outcomes.push({
				pluginId,
				status: "skipped",
				message: `Skipping "${pluginId}" (source: ${record.source}).`
			});
			continue;
		}
		if (!record.spec) {
			outcomes.push({
				pluginId,
				status: "skipped",
				message: `Skipping "${pluginId}" (missing npm spec).`
			});
			continue;
		}
		let installPath;
		try {
			installPath = record.installPath ?? resolvePluginInstallDir(pluginId);
		} catch (err) {
			outcomes.push({
				pluginId,
				status: "error",
				message: `Invalid install path for "${pluginId}": ${String(err)}`
			});
			continue;
		}
		const currentVersion = await readInstalledPackageVersion(installPath);
		if (params.dryRun) {
			let probe;
			try {
				probe = await installPluginFromNpmSpec({
					spec: record.spec,
					mode: "update",
					dryRun: true,
					expectedPluginId: pluginId,
					expectedIntegrity: record.integrity,
					onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
						pluginId,
						dryRun: true,
						logger,
						onIntegrityDrift: params.onIntegrityDrift
					}),
					logger
				});
			} catch (err) {
				outcomes.push({
					pluginId,
					status: "error",
					message: `Failed to check ${pluginId}: ${String(err)}`
				});
				continue;
			}
			if (!probe.ok) {
				outcomes.push({
					pluginId,
					status: "error",
					message: `Failed to check ${pluginId}: ${probe.error}`
				});
				continue;
			}
			const nextVersion = probe.version ?? "unknown";
			const currentLabel = currentVersion ?? "unknown";
			if (currentVersion && probe.version && currentVersion === probe.version) outcomes.push({
				pluginId,
				status: "unchanged",
				currentVersion: currentVersion ?? void 0,
				nextVersion: probe.version ?? void 0,
				message: `${pluginId} is up to date (${currentLabel}).`
			});
			else outcomes.push({
				pluginId,
				status: "updated",
				currentVersion: currentVersion ?? void 0,
				nextVersion: probe.version ?? void 0,
				message: `Would update ${pluginId}: ${currentLabel} -> ${nextVersion}.`
			});
			continue;
		}
		let result;
		try {
			result = await installPluginFromNpmSpec({
				spec: record.spec,
				mode: "update",
				expectedPluginId: pluginId,
				expectedIntegrity: record.integrity,
				onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
					pluginId,
					dryRun: false,
					logger,
					onIntegrityDrift: params.onIntegrityDrift
				}),
				logger
			});
		} catch (err) {
			outcomes.push({
				pluginId,
				status: "error",
				message: `Failed to update ${pluginId}: ${String(err)}`
			});
			continue;
		}
		if (!result.ok) {
			outcomes.push({
				pluginId,
				status: "error",
				message: `Failed to update ${pluginId}: ${result.error}`
			});
			continue;
		}
		const nextVersion = result.version ?? await readInstalledPackageVersion(result.targetDir);
		next = recordPluginInstall(next, {
			pluginId,
			source: "npm",
			spec: record.spec,
			installPath: result.targetDir,
			version: nextVersion,
			...buildNpmResolutionInstallFields(result.npmResolution)
		});
		changed = true;
		const currentLabel = currentVersion ?? "unknown";
		const nextLabel = nextVersion ?? "unknown";
		if (currentVersion && nextVersion && currentVersion === nextVersion) outcomes.push({
			pluginId,
			status: "unchanged",
			currentVersion: currentVersion ?? void 0,
			nextVersion: nextVersion ?? void 0,
			message: `${pluginId} already at ${currentLabel}.`
		});
		else outcomes.push({
			pluginId,
			status: "updated",
			currentVersion: currentVersion ?? void 0,
			nextVersion: nextVersion ?? void 0,
			message: `Updated ${pluginId}: ${currentLabel} -> ${nextLabel}.`
		});
	}
	return {
		config: next,
		changed,
		outcomes
	};
}
async function syncPluginsForUpdateChannel(params) {
	const summary = {
		switchedToBundled: [],
		switchedToNpm: [],
		warnings: [],
		errors: []
	};
	const bundled = resolveBundledPluginSources({ workspaceDir: params.workspaceDir });
	if (bundled.size === 0) return {
		config: params.config,
		changed: false,
		summary
	};
	let next = params.config;
	const loadHelpers = buildLoadPathHelpers(next.plugins?.load?.paths ?? []);
	const installs = next.plugins?.installs ?? {};
	let changed = false;
	if (params.channel === "dev") for (const [pluginId, record] of Object.entries(installs)) {
		const bundledInfo = bundled.get(pluginId);
		if (!bundledInfo) continue;
		loadHelpers.addPath(bundledInfo.localPath);
		if (record.source === "path" && pathsEqual(record.sourcePath, bundledInfo.localPath)) continue;
		next = recordPluginInstall(next, {
			pluginId,
			source: "path",
			sourcePath: bundledInfo.localPath,
			installPath: bundledInfo.localPath,
			spec: record.spec ?? bundledInfo.npmSpec,
			version: record.version
		});
		summary.switchedToBundled.push(pluginId);
		changed = true;
	}
	else for (const [pluginId, record] of Object.entries(installs)) {
		const bundledInfo = bundled.get(pluginId);
		if (!bundledInfo) continue;
		if (record.source === "npm") {
			loadHelpers.removePath(bundledInfo.localPath);
			continue;
		}
		if (record.source !== "path") continue;
		if (!pathsEqual(record.sourcePath, bundledInfo.localPath)) continue;
		const spec = record.spec ?? bundledInfo.npmSpec;
		if (!spec) {
			summary.warnings.push(`Missing npm spec for ${pluginId}; keeping local path.`);
			continue;
		}
		let result;
		try {
			result = await installPluginFromNpmSpec({
				spec,
				mode: "update",
				expectedPluginId: pluginId,
				logger: params.logger
			});
		} catch (err) {
			summary.errors.push(`Failed to install ${pluginId}: ${String(err)}`);
			continue;
		}
		if (!result.ok) {
			summary.errors.push(`Failed to install ${pluginId}: ${result.error}`);
			continue;
		}
		next = recordPluginInstall(next, {
			pluginId,
			source: "npm",
			spec,
			installPath: result.targetDir,
			version: result.version,
			...buildNpmResolutionInstallFields(result.npmResolution),
			sourcePath: void 0
		});
		summary.switchedToNpm.push(pluginId);
		changed = true;
		loadHelpers.removePath(bundledInfo.localPath);
	}
	if (loadHelpers.changed) {
		next = {
			...next,
			plugins: {
				...next.plugins,
				load: {
					...next.plugins?.load,
					paths: loadHelpers.paths
				}
			}
		};
		changed = true;
	}
	return {
		config: next,
		changed,
		summary
	};
}

//#endregion
export { updateNpmInstalledPlugins as n, findBundledPluginByNpmSpec as r, syncPluginsForUpdateChannel as t };