import { y as resolveUserPath } from "./utils-JhJvOE-Q.js";
import { a as openBoundaryFileSync } from "./openclaw-root-CGu4EGX8.js";
import { a as resolveBundledPluginSources, l as resolvePluginInstallDir, n as recordPluginInstall, o as PLUGIN_INSTALL_ERROR_CODE, s as installPluginFromNpmSpec, t as buildNpmResolutionInstallFields } from "./installs-B4O7dZlI.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/update.ts
function formatNpmInstallFailure(params) {
	if (params.result.code === PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) return `Failed to ${params.phase} ${params.pluginId}: npm package not found for ${params.spec}.`;
	return `Failed to ${params.phase} ${params.pluginId}: ${params.result.error}`;
}
function expectedIntegrityForUpdate(spec, integrity) {
	if (!integrity || !spec) return;
	const value = spec.trim();
	if (!value) return;
	const at = value.lastIndexOf("@");
	if (at <= 0 || at >= value.length - 1) return;
	const version = value.slice(at + 1).trim();
	if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return;
	return integrity;
}
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
function pathsEqual(left, right, env = process.env) {
	if (!left || !right) return false;
	return resolveUserPath(left, env) === resolveUserPath(right, env);
}
function buildLoadPathHelpers(existing, env = process.env) {
	let paths = [...existing];
	const resolveSet = () => new Set(paths.map((entry) => resolveUserPath(entry, env)));
	let resolved = resolveSet();
	let changed = false;
	const addPath = (value) => {
		const normalized = resolveUserPath(value, env);
		if (resolved.has(normalized)) return;
		paths.push(value);
		resolved.add(normalized);
		changed = true;
	};
	const removePath = (value) => {
		const normalized = resolveUserPath(value, env);
		if (!resolved.has(normalized)) return;
		paths = paths.filter((entry) => resolveUserPath(entry, env) !== normalized);
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
					expectedIntegrity: expectedIntegrityForUpdate(record.spec, record.integrity),
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
					message: formatNpmInstallFailure({
						pluginId,
						spec: record.spec,
						phase: "check",
						result: probe
					})
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
				expectedIntegrity: expectedIntegrityForUpdate(record.spec, record.integrity),
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
				message: formatNpmInstallFailure({
					pluginId,
					spec: record.spec,
					phase: "update",
					result
				})
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
	const env = params.env ?? process.env;
	const summary = {
		switchedToBundled: [],
		switchedToNpm: [],
		warnings: [],
		errors: []
	};
	const bundled = resolveBundledPluginSources({
		workspaceDir: params.workspaceDir,
		env
	});
	if (bundled.size === 0) return {
		config: params.config,
		changed: false,
		summary
	};
	let next = params.config;
	const loadHelpers = buildLoadPathHelpers(next.plugins?.load?.paths ?? [], env);
	const installs = next.plugins?.installs ?? {};
	let changed = false;
	if (params.channel === "dev") for (const [pluginId, record] of Object.entries(installs)) {
		const bundledInfo = bundled.get(pluginId);
		if (!bundledInfo) continue;
		loadHelpers.addPath(bundledInfo.localPath);
		if (record.source === "path" && pathsEqual(record.sourcePath, bundledInfo.localPath, env)) continue;
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
		if (!pathsEqual(record.sourcePath, bundledInfo.localPath, env)) continue;
		loadHelpers.addPath(bundledInfo.localPath);
		if (record.source === "path" && pathsEqual(record.sourcePath, bundledInfo.localPath, env) && pathsEqual(record.installPath, bundledInfo.localPath, env)) continue;
		next = recordPluginInstall(next, {
			pluginId,
			source: "path",
			sourcePath: bundledInfo.localPath,
			installPath: bundledInfo.localPath,
			spec: record.spec ?? bundledInfo.npmSpec,
			version: record.version
		});
		changed = true;
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
export { updateNpmInstalledPlugins as n, syncPluginsForUpdateChannel as t };
