import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { s as tracePluginLifecyclePhaseAsync } from "./discovery-GEDtU7uI.js";
import { s as resolveArchiveKind } from "./archive-DBeZ8ywX.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { r as resolveDefaultPluginExtensionsDir } from "./install-paths-B32RY-Gz.js";
import { n as parseGitPluginSpec, t as installPluginFromGitSpec } from "./git-install-NB3PSyj8.js";
import { t as parseClawHubPluginSpec } from "./clawhub-spec-J_MJr4Sl.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { c as resolveOfficialExternalPluginInstall, n as getOfficialExternalPluginCatalogEntryForPackage, s as resolveOfficialExternalPluginId, t as getOfficialExternalPluginCatalogEntry } from "./official-external-plugin-catalog-f6g4JsA2.js";
import { u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import "./archive-CBe_wA_B.js";
import { n as assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard-CW_6fgTB.js";
import { t as validateJsonSchemaValue } from "./schema-validator-CoHaB3Uu.js";
import "./config-B6Oplu5W.js";
import { t as findBundledPluginSource } from "./bundled-sources-Bb5DSmIr.js";
import { i as resolvePinnedNpmInstallRecordForCli, n as persistPluginInstall, t as persistHookPackInstall } from "./plugins-install-persist-VD_D5Xyc.js";
import { a as installPluginFromNpmSpec, i as installPluginFromNpmPackArchive, o as installPluginFromPath, t as PLUGIN_INSTALL_ERROR_CODE } from "./install-BG7jqqYt.js";
import { a as resolveOfficialExternalNpmPackageTrust, i as resolveOfficialExternalInstallPlanBeforeNpm, r as resolveBundledInstallPlanForNpmFailure, t as resolveBundledInstallPlanBeforeNpm } from "./plugin-install-plan-DDY2BScO.js";
import { a as formatPluginInstallWithHookFallbackError, c as parseNpmPackPrefixPath, l as parseNpmPrefixSpec, n as createHookPackInstallLogger, r as createPluginInstallLogger } from "./plugins-command-helpers-BUsheNmo.js";
import "./clawhub-B9rdLaiz.js";
import { r as installPluginFromClawHub } from "./clawhub-CFGNynZy.js";
import { t as buildClawHubPluginInstallRecordFields } from "./clawhub-install-records-Dv-7kghM.js";
import { o as collectChannelDoctorStaleConfigMutations } from "./channel-doctor-Br5Zk23t.js";
import { n as installHooksFromPath, t as installHooksFromNpmSpec } from "./install-ChKTQEPK.js";
import { r as resolveMarketplaceInstallShortcut, t as installPluginFromMarketplace } from "./marketplace-2RYnOgub.js";
import { r as resolvePluginInstallRequestContext, t as resolvePluginInstallInvalidConfigPolicy } from "./plugin-install-config-policy-cpvLfGnk.js";
import fs from "node:fs";
import path from "node:path";
//#region src/cli/install-spec.ts
function looksLikeLocalInstallSpec(spec, knownSuffixes) {
	return spec.startsWith(".") || spec.startsWith("~") || path.isAbsolute(spec) || knownSuffixes.some((suffix) => spec.endsWith(suffix));
}
//#endregion
//#region src/cli/plugins-install-command.ts
function resolveInstallMode(force) {
	return force ? "update" : "install";
}
function resolveInstallSafetyOverrides(overrides) {
	return { dangerouslyForceUnsafeInstall: overrides.dangerouslyForceUnsafeInstall };
}
function findTrustedCatalogPackageInstall(packageName) {
	const entry = getOfficialExternalPluginCatalogEntryForPackage(packageName);
	if (!entry) return;
	const pluginId = resolveOfficialExternalPluginId(entry);
	if (!pluginId) return;
	const install = resolveOfficialExternalPluginInstall(entry);
	return {
		pluginId,
		...install?.npmSpec ? { npmSpec: install.npmSpec } : {},
		...install?.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}
	};
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isEmptyRecord(value) {
	return Object.keys(value).length === 0;
}
function hasValidBundledPluginConfig(params) {
	if (!params.bundledSource.requiresConfig) return true;
	if (!isRecord(params.existingEntry)) return false;
	const config = params.existingEntry.config;
	if (!isRecord(config)) return false;
	if (!params.bundledSource.configSchema) return !isEmptyRecord(config);
	return validateJsonSchemaValue({
		schema: params.bundledSource.configSchema,
		cacheKey: `bundled-install:${params.bundledSource.pluginId}`,
		value: config,
		applyDefaults: true
	}).ok;
}
function prepareConfigForDisabledBundledInstall(config, pluginId) {
	const { [pluginId]: _removedEntry, ...nextEntries } = config.plugins?.entries ?? {};
	return {
		...config,
		plugins: {
			...config.plugins,
			entries: nextEntries
		}
	};
}
async function installBundledPluginSource(params) {
	const existingEntry = params.snapshot.config.plugins?.entries?.[params.bundledSource.pluginId];
	const shouldEnable = hasValidBundledPluginConfig({
		bundledSource: params.bundledSource,
		existingEntry
	});
	const configBase = shouldEnable ? params.snapshot.config : prepareConfigForDisabledBundledInstall(params.snapshot.config, params.bundledSource.pluginId);
	const configWarning = shouldEnable ? "" : `Installed bundled plugin "${params.bundledSource.pluginId}" without enabling it because it requires configuration first. Configure it, then run \`openclaw plugins enable ${params.bundledSource.pluginId}\`.`;
	await persistPluginInstall({
		snapshot: {
			config: configBase,
			baseHash: params.snapshot.baseHash
		},
		pluginId: params.bundledSource.pluginId,
		install: {
			source: "path",
			spec: params.rawSpec,
			sourcePath: params.bundledSource.localPath,
			installPath: params.bundledSource.localPath
		},
		enable: shouldEnable,
		warningMessage: [params.warning, configWarning].filter(Boolean).join("\n"),
		runtime: params.runtime
	});
}
async function tryInstallHookPackFromLocalPath(params) {
	if (params.link) {
		if (!fs.statSync(params.resolvedPath).isDirectory()) return {
			ok: false,
			error: "Linked hook pack paths must be directories."
		};
		const probe = await installHooksFromPath({
			...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
			path: params.resolvedPath,
			dryRun: true
		});
		if (!probe.ok) return probe;
		const existing = params.snapshot.config.hooks?.internal?.load?.extraDirs ?? [];
		const merged = Array.from(new Set([...existing, params.resolvedPath]));
		await persistHookPackInstall({
			snapshot: {
				config: {
					...params.snapshot.config,
					hooks: {
						...params.snapshot.config.hooks,
						internal: {
							...params.snapshot.config.hooks?.internal,
							enabled: true,
							load: {
								...params.snapshot.config.hooks?.internal?.load,
								extraDirs: merged
							}
						}
					}
				},
				baseHash: params.snapshot.baseHash
			},
			hookPackId: probe.hookPackId,
			hooks: probe.hooks,
			install: {
				source: "path",
				sourcePath: params.resolvedPath,
				installPath: params.resolvedPath,
				version: probe.version
			},
			successMessage: `Linked hook pack path: ${shortenHomePath(params.resolvedPath)}`,
			runtime: params.runtime
		});
		return { ok: true };
	}
	const result = await installHooksFromPath({
		...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
		path: params.resolvedPath,
		mode: params.installMode,
		logger: createHookPackInstallLogger(params.runtime)
	});
	if (!result.ok) return result;
	const source = resolveArchiveKind(params.resolvedPath) ? "archive" : "path";
	await persistHookPackInstall({
		snapshot: params.snapshot,
		hookPackId: result.hookPackId,
		hooks: result.hooks,
		install: {
			source,
			sourcePath: params.resolvedPath,
			installPath: result.targetDir,
			version: result.version
		},
		runtime: params.runtime
	});
	return { ok: true };
}
async function tryInstallHookPackFromNpmSpec(params) {
	const result = await installHooksFromNpmSpec({
		spec: params.spec,
		mode: params.installMode,
		...params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {},
		logger: createHookPackInstallLogger(params.runtime)
	});
	if (!result.ok) return result;
	const installRecord = resolvePinnedNpmInstallRecordForCli(params.spec, Boolean(params.pin), result.targetDir, result.version, result.npmResolution, params.runtime?.log ?? defaultRuntime.log, theme.warn);
	await persistHookPackInstall({
		snapshot: params.snapshot,
		hookPackId: result.hookPackId,
		hooks: result.hooks,
		install: installRecord,
		runtime: params.runtime
	});
	return { ok: true };
}
async function tryInstallPluginOrHookPackFromNpmSpec(params) {
	const result = await installPluginFromNpmSpec({
		...params.safetyOverrides,
		mode: params.installMode,
		spec: params.spec,
		...params.expectedPluginId ? { expectedPluginId: params.expectedPluginId } : {},
		...params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {},
		...params.trustedSourceLinkedOfficialInstall ? { trustedSourceLinkedOfficialInstall: true } : {},
		extensionsDir: params.extensionsDir,
		logger: createPluginInstallLogger(params.runtime)
	});
	if (!result.ok) {
		if (isTerminalPluginInstallSecurityFailure(result.code)) {
			(params.runtime ?? defaultRuntime).error(result.error);
			return { ok: false };
		}
		if (params.allowBundledFallback) {
			const bundledFallbackPlan = resolveBundledInstallPlanForNpmFailure({
				rawSpec: params.spec,
				code: result.code,
				findBundledSource: (lookup) => findBundledPluginSource({ lookup })
			});
			if (bundledFallbackPlan) {
				await installBundledPluginSource({
					snapshot: params.snapshot,
					rawSpec: params.spec,
					bundledSource: bundledFallbackPlan.bundledSource,
					warning: bundledFallbackPlan.warning,
					runtime: params.runtime
				});
				return { ok: true };
			}
		}
		const hookFallback = await tryInstallHookPackFromNpmSpec({
			snapshot: params.snapshot,
			installMode: params.installMode,
			spec: params.spec,
			pin: params.pin,
			expectedIntegrity: params.expectedIntegrity,
			runtime: params.runtime
		});
		if (hookFallback.ok) return { ok: true };
		(params.runtime ?? defaultRuntime).error(formatPluginInstallWithHookFallbackError(result.error, hookFallback.error));
		return { ok: false };
	}
	const installRecord = resolvePinnedNpmInstallRecordForCli(params.spec, Boolean(params.pin), result.targetDir, result.version, result.npmResolution, params.runtime?.log ?? defaultRuntime.log, theme.warn);
	await persistPluginInstall({
		snapshot: params.snapshot,
		pluginId: result.pluginId,
		install: installRecord,
		runtime: params.runtime
	});
	return { ok: true };
}
async function tryInstallPluginFromNpmPackArchive(params) {
	const result = await installPluginFromNpmPackArchive({
		...params.safetyOverrides,
		mode: params.installMode,
		archivePath: params.archivePath,
		extensionsDir: params.extensionsDir,
		logger: createPluginInstallLogger(params.runtime)
	});
	if (!result.ok) {
		(params.runtime ?? defaultRuntime).error(result.error);
		return { ok: false };
	}
	await persistPluginInstall({
		snapshot: params.snapshot,
		pluginId: result.pluginId,
		install: {
			source: "npm",
			spec: result.npmResolution?.resolvedSpec ?? result.manifestName ?? result.pluginId,
			sourcePath: params.archivePath,
			installPath: result.targetDir,
			...result.version ? { version: result.version } : {},
			...result.npmResolution?.name ? { resolvedName: result.npmResolution.name } : {},
			...result.npmResolution?.version ? { resolvedVersion: result.npmResolution.version } : {},
			...result.npmResolution?.resolvedSpec ? { resolvedSpec: result.npmResolution.resolvedSpec } : {},
			...result.npmResolution?.integrity ? { integrity: result.npmResolution.integrity } : {},
			...result.npmResolution?.shasum ? { shasum: result.npmResolution.shasum } : {},
			...result.npmResolution?.resolvedAt ? { resolvedAt: result.npmResolution.resolvedAt } : {},
			artifactKind: "npm-pack",
			artifactFormat: "tgz",
			...result.npmResolution?.integrity ? { npmIntegrity: result.npmResolution.integrity } : {},
			...result.npmResolution?.shasum ? { npmShasum: result.npmResolution.shasum } : {},
			...result.npmTarballName ? { npmTarballName: result.npmTarballName } : {}
		},
		runtime: params.runtime
	});
	return { ok: true };
}
async function tryInstallPluginFromGitSpec(params) {
	const result = await installPluginFromGitSpec({
		...params.safetyOverrides,
		mode: params.installMode,
		spec: params.spec,
		extensionsDir: params.extensionsDir,
		logger: createPluginInstallLogger(params.runtime)
	});
	if (!result.ok) {
		(params.runtime ?? defaultRuntime).error(result.error);
		return { ok: false };
	}
	await persistPluginInstall({
		snapshot: params.snapshot,
		pluginId: result.pluginId,
		install: {
			source: "git",
			spec: params.spec,
			installPath: result.targetDir,
			version: result.version,
			resolvedAt: result.git.resolvedAt,
			gitUrl: result.git.url,
			gitRef: result.git.ref,
			gitCommit: result.git.commit
		},
		runtime: params.runtime
	});
	return { ok: true };
}
function isTerminalPluginInstallSecurityFailure(code) {
	return code === PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED || code === PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED;
}
function isAllowedPluginRecoveryIssue(issue, request) {
	const pluginId = request.bundledPluginId?.trim();
	if (!pluginId) return false;
	return issue.path === `channels.${pluginId}` && issue.message === `unknown channel id: ${pluginId}` || issue.path === "plugins.load.paths" && typeof issue.message === "string" && issue.message.includes("plugin path not found") || issue.path === "plugins" && typeof issue.message === "string" && issue.message.includes("requires compiled runtime output") || issue.path === `plugins.entries.${pluginId}` && typeof issue.message === "string" && issue.message.includes("requires compiled runtime output") || issue.path === "tools.web.search.provider" && typeof issue.message === "string" && issue.message.includes(`plugin "${pluginId}"`);
}
function buildInvalidPluginInstallConfigError(message) {
	const error = new Error(message);
	error.code = "INVALID_CONFIG";
	return error;
}
async function loadConfigFromSnapshotForInstall(request, snapshot) {
	if (resolvePluginInstallInvalidConfigPolicy(request) !== "allow-plugin-recovery") throw buildInvalidPluginInstallConfigError("Config invalid; run `openclaw doctor --fix` before installing plugins.");
	const parsed = snapshot.parsed ?? {};
	if (!snapshot.exists || Object.keys(parsed).length === 0) throw buildInvalidPluginInstallConfigError("Config file could not be parsed; run `openclaw doctor` to repair it.");
	if (snapshot.legacyIssues.length > 0 || snapshot.issues.length === 0 || snapshot.issues.some((issue) => !isAllowedPluginRecoveryIssue(issue, request))) throw buildInvalidPluginInstallConfigError(`Config invalid outside the plugin recovery path for ${request.bundledPluginId ?? "the requested plugin"}; run \`openclaw doctor --fix\` before reinstalling it.`);
	let nextConfig = snapshot.config;
	for (const mutation of await collectChannelDoctorStaleConfigMutations(snapshot.config, { env: process.env })) nextConfig = mutation.config;
	return {
		config: nextConfig,
		baseHash: snapshot.hash
	};
}
async function loadConfigForInstall(request) {
	const snapshot = await tracePluginLifecyclePhaseAsync("config read", () => readConfigFileSnapshot(), { command: "install" });
	if (snapshot.valid) return {
		config: snapshot.sourceConfig,
		baseHash: snapshot.hash
	};
	return loadConfigFromSnapshotForInstall(request, snapshot);
}
async function runPluginInstallCommand(params) {
	assertConfigWriteAllowedInCurrentMode();
	const runtime = params.runtime ?? defaultRuntime;
	const shorthand = !params.opts.marketplace ? await tracePluginLifecyclePhaseAsync("marketplace shortcut resolution", () => resolveMarketplaceInstallShortcut(params.raw), { command: "install" }) : null;
	if (shorthand?.ok === false) {
		runtime.error(shorthand.error);
		return runtime.exit(1);
	}
	const raw = shorthand?.ok ? shorthand.plugin : params.raw;
	const opts = {
		...params.opts,
		marketplace: params.opts.marketplace ?? (shorthand?.ok ? shorthand.marketplaceSource : void 0)
	};
	if (opts.marketplace) {
		if (opts.link) {
			runtime.error(`--link is not supported with --marketplace. Remove --link, or install a local path with ${formatCliCommand("openclaw plugins install --link <path>")}.`);
			return runtime.exit(1);
		}
		if (opts.pin) {
			runtime.error(`--pin is not supported with --marketplace. Use ${formatCliCommand("openclaw plugins install <plugin> --marketplace <name>")} without --pin.`);
			return runtime.exit(1);
		}
	}
	const gitPrefix = raw.trim().toLowerCase().startsWith("git:");
	const gitSpec = parseGitPluginSpec(raw);
	if (gitPrefix && !gitSpec) {
		runtime.error(`Unsupported git plugin spec: ${raw}. Use ${formatCliCommand("openclaw plugins install git:<repo>@<ref>")}.`);
		return runtime.exit(1);
	}
	if (gitSpec && opts.link) {
		runtime.error(`--link is not supported with git: installs. Use ${formatCliCommand("openclaw plugins install git:<repo>@<ref>")} for Git installs or ${formatCliCommand("openclaw plugins install --link <path>")} for local paths.`);
		return runtime.exit(1);
	}
	if (gitSpec && opts.pin) {
		runtime.error(`--pin is not supported with git: installs. Pin the ref in the spec instead, for example ${formatCliCommand("openclaw plugins install git:<repo>@<ref>")}.`);
		return runtime.exit(1);
	}
	if (opts.link && opts.force) {
		runtime.error(`--force is not supported with --link. Linked plugins point at the source path directly; remove --force and re-run ${formatCliCommand("openclaw plugins install --link <path>")}.`);
		return runtime.exit(1);
	}
	const requestResolution = resolvePluginInstallRequestContext({
		rawSpec: raw,
		marketplace: opts.marketplace
	});
	if (!requestResolution.ok) {
		runtime.error(requestResolution.error);
		return runtime.exit(1);
	}
	const request = requestResolution.request;
	const snapshot = await loadConfigForInstall(request).catch((error) => {
		runtime.error(formatErrorMessage(error));
		return null;
	});
	if (!snapshot) return runtime.exit(1);
	const cfg = snapshot.config;
	const installMode = resolveInstallMode(opts.force);
	const safetyOverrides = resolveInstallSafetyOverrides(opts);
	const extensionsDir = resolveDefaultPluginExtensionsDir();
	if (opts.marketplace) {
		const result = await installPluginFromMarketplace({
			...safetyOverrides,
			marketplace: opts.marketplace,
			mode: installMode,
			plugin: raw,
			extensionsDir,
			logger: createPluginInstallLogger(runtime)
		});
		if (!result.ok) {
			runtime.error(result.error);
			return runtime.exit(1);
		}
		await persistPluginInstall({
			snapshot,
			pluginId: result.pluginId,
			install: {
				source: "marketplace",
				installPath: result.targetDir,
				version: result.version,
				marketplaceName: result.marketplaceName,
				marketplaceSource: result.marketplaceSource,
				marketplacePlugin: result.marketplacePlugin
			},
			runtime
		});
		return;
	}
	const resolved = request.resolvedPath ?? request.normalizedSpec;
	if (fs.existsSync(resolved)) {
		if (opts.link) {
			const existing = cfg.plugins?.load?.paths ?? [];
			const merged = Array.from(new Set([...existing, resolved]));
			const probe = await installPluginFromPath({
				...safetyOverrides,
				mode: installMode,
				path: resolved,
				dryRun: true,
				extensionsDir,
				logger: createPluginInstallLogger(runtime)
			});
			if (!probe.ok) {
				if (isTerminalPluginInstallSecurityFailure(probe.code)) {
					runtime.error(probe.error);
					return runtime.exit(1);
				}
				const hookFallback = await tryInstallHookPackFromLocalPath({
					snapshot,
					installMode,
					resolvedPath: resolved,
					safetyOverrides,
					link: true,
					runtime
				});
				if (hookFallback.ok) return;
				runtime.error(formatPluginInstallWithHookFallbackError(probe.error, hookFallback.error));
				return runtime.exit(1);
			}
			await persistPluginInstall({
				snapshot: {
					config: {
						...cfg,
						plugins: {
							...cfg.plugins,
							load: {
								...cfg.plugins?.load,
								paths: merged
							}
						}
					},
					baseHash: snapshot.baseHash
				},
				pluginId: probe.pluginId,
				install: {
					source: "path",
					sourcePath: resolved,
					installPath: resolved,
					version: probe.version
				},
				successMessage: `Linked plugin path: ${shortenHomePath(resolved)}`,
				runtime
			});
			return;
		}
		const result = await installPluginFromPath({
			...safetyOverrides,
			mode: installMode,
			path: resolved,
			extensionsDir,
			logger: createPluginInstallLogger(runtime)
		});
		if (!result.ok) {
			if (isTerminalPluginInstallSecurityFailure(result.code)) {
				runtime.error(result.error);
				return runtime.exit(1);
			}
			const hookFallback = await tryInstallHookPackFromLocalPath({
				snapshot,
				installMode,
				resolvedPath: resolved,
				safetyOverrides,
				runtime
			});
			if (hookFallback.ok) return;
			runtime.error(formatPluginInstallWithHookFallbackError(result.error, hookFallback.error));
			return runtime.exit(1);
		}
		const source = resolveArchiveKind(resolved) ? "archive" : "path";
		await persistPluginInstall({
			snapshot,
			pluginId: result.pluginId,
			install: {
				source,
				sourcePath: resolved,
				installPath: result.targetDir,
				version: result.version
			},
			runtime
		});
		return;
	}
	if (opts.link) {
		runtime.error(`--link requires a local path. Run ${formatCliCommand("openclaw plugins install --link <path>")}.`);
		return runtime.exit(1);
	}
	const npmPrefixSpec = parseNpmPrefixSpec(raw);
	if (npmPrefixSpec !== null) {
		if (!npmPrefixSpec) {
			runtime.error(`Unsupported npm plugin spec: missing package. Use ${formatCliCommand("openclaw plugins install npm:<package>")}.`);
			return runtime.exit(1);
		}
		const officialNpmTrust = resolveOfficialExternalNpmPackageTrust({
			npmSpec: npmPrefixSpec,
			findOfficialExternalPackage: findTrustedCatalogPackageInstall
		});
		if (!(await tryInstallPluginOrHookPackFromNpmSpec({
			snapshot,
			installMode,
			spec: npmPrefixSpec,
			pin: opts.pin,
			safetyOverrides,
			allowBundledFallback: false,
			extensionsDir,
			...officialNpmTrust ? {
				expectedPluginId: officialNpmTrust.pluginId,
				...officialNpmTrust.expectedIntegrity ? { expectedIntegrity: officialNpmTrust.expectedIntegrity } : {},
				trustedSourceLinkedOfficialInstall: true
			} : {},
			runtime
		})).ok) return runtime.exit(1);
		return;
	}
	const npmPackPath = parseNpmPackPrefixPath(raw);
	if (npmPackPath !== null) {
		if (!npmPackPath) {
			runtime.error(`Unsupported npm-pack plugin spec: missing archive path. Use ${formatCliCommand("openclaw plugins install npm-pack:<path-to.tgz>")}.`);
			return runtime.exit(1);
		}
		if (!(await tryInstallPluginFromNpmPackArchive({
			snapshot,
			installMode,
			archivePath: npmPackPath,
			safetyOverrides,
			extensionsDir,
			runtime
		})).ok) return runtime.exit(1);
		return;
	}
	if (gitSpec) {
		if (!(await tryInstallPluginFromGitSpec({
			snapshot,
			installMode,
			spec: raw,
			safetyOverrides,
			extensionsDir,
			runtime
		})).ok) return runtime.exit(1);
		return;
	}
	if (looksLikeLocalInstallSpec(raw, [
		".ts",
		".js",
		".mjs",
		".cjs",
		".tgz",
		".tar.gz",
		".tar",
		".zip"
	])) {
		runtime.error(`Plugin path not found: ${resolved}. Check the path, or install from npm with ${formatCliCommand("openclaw plugins install npm:<package>")}.`);
		return runtime.exit(1);
	}
	const bundledPreNpmPlan = resolveBundledInstallPlanBeforeNpm({
		rawSpec: raw,
		findBundledSource: (lookup) => findBundledPluginSource({ lookup })
	});
	if (bundledPreNpmPlan) {
		await tracePluginLifecyclePhaseAsync("install execution", () => installBundledPluginSource({
			snapshot,
			rawSpec: raw,
			bundledSource: bundledPreNpmPlan.bundledSource,
			warning: bundledPreNpmPlan.warning,
			runtime
		}), {
			command: "install",
			source: "bundled",
			pluginId: bundledPreNpmPlan.bundledSource.pluginId
		});
		return;
	}
	const officialExternalPlan = resolveOfficialExternalInstallPlanBeforeNpm({
		rawSpec: raw,
		findOfficialExternalPlugin: (pluginId) => {
			const entry = getOfficialExternalPluginCatalogEntry(pluginId);
			const resolvedPluginId = entry ? resolveOfficialExternalPluginId(entry) : void 0;
			const install = entry ? resolveOfficialExternalPluginInstall(entry) : null;
			const npmSpec = install?.npmSpec;
			return resolvedPluginId && npmSpec ? {
				pluginId: resolvedPluginId,
				npmSpec,
				...install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}
			} : void 0;
		}
	});
	if (officialExternalPlan) {
		if (!(await tryInstallPluginOrHookPackFromNpmSpec({
			snapshot,
			installMode,
			spec: officialExternalPlan.npmSpec,
			pin: opts.pin,
			safetyOverrides,
			allowBundledFallback: false,
			extensionsDir,
			expectedPluginId: officialExternalPlan.pluginId,
			expectedIntegrity: officialExternalPlan.expectedIntegrity,
			trustedSourceLinkedOfficialInstall: true,
			runtime
		})).ok) return runtime.exit(1);
		return;
	}
	if (parseClawHubPluginSpec(raw)) {
		const result = await installPluginFromClawHub({
			...safetyOverrides,
			mode: installMode,
			spec: raw,
			extensionsDir,
			logger: createPluginInstallLogger(runtime)
		});
		if (!result.ok) {
			runtime.error(result.error);
			return runtime.exit(1);
		}
		await persistPluginInstall({
			snapshot,
			pluginId: result.pluginId,
			install: {
				...buildClawHubPluginInstallRecordFields(result.clawhub),
				spec: raw,
				installPath: result.targetDir
			},
			runtime
		});
		return;
	}
	const officialNpmTrust = resolveOfficialExternalNpmPackageTrust({
		npmSpec: raw,
		findOfficialExternalPackage: findTrustedCatalogPackageInstall
	});
	if (!(await tryInstallPluginOrHookPackFromNpmSpec({
		snapshot,
		installMode,
		spec: raw,
		pin: opts.pin,
		safetyOverrides,
		allowBundledFallback: true,
		extensionsDir,
		...officialNpmTrust ? {
			expectedPluginId: officialNpmTrust.pluginId,
			...officialNpmTrust.expectedIntegrity ? { expectedIntegrity: officialNpmTrust.expectedIntegrity } : {},
			trustedSourceLinkedOfficialInstall: true
		} : {},
		runtime
	})).ok) return runtime.exit(1);
}
//#endregion
export { runPluginInstallCommand as n, loadConfigForInstall as t };
