import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { r as openRootFile } from "./root-file-jRMCpJW4.js";
import "./boundary-file-read-CBe_wA_B.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { f as registerInternalHook, h as unregisterInternalHook } from "./internal-hooks-DpfQDjis.js";
import { n as shouldIncludeHook } from "./config-CRTtlu4C.js";
import { n as resolveFunctionModuleExport } from "./module-loader-BF97Ap2W.js";
import { t as loadWorkspaceHookEntries } from "./workspace-CWRVtjYM.js";
import { n as resolveConfiguredInternalHookNames, r as getLegacyInternalHookHandlers, t as hasConfiguredInternalHooks } from "./configured-DmQDjcF5.js";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/hooks/import-url.ts
/**
* Build an import URL for a hook handler module.
*
* Bundled hooks (shipped in dist/) are immutable between installs, so they
* can be imported without a cache-busting suffix — letting V8 reuse its
* module cache across gateway restarts.
*
* Workspace, managed, and plugin hooks may be edited by the user between
* restarts. For those we append `?t=<mtime>&s=<size>` so the module key
* reflects on-disk changes while staying stable for unchanged files.
*/
/**
* Sources whose handler files never change between `npm install` runs.
* Imports from these sources skip cache busting entirely.
*/
const IMMUTABLE_SOURCES = new Set(["openclaw-bundled"]);
function buildImportUrl(handlerPath, source) {
	const base = pathToFileURL(handlerPath).href;
	if (IMMUTABLE_SOURCES.has(source)) return base;
	try {
		const { mtimeMs, size } = fs.statSync(handlerPath);
		return `${base}?t=${mtimeMs}&s=${size}`;
	} catch {
		return `${base}?t=${Date.now()}`;
	}
}
//#endregion
//#region src/hooks/loader.ts
/**
* Dynamic loader for hook handlers
*
* Loads hook handlers from external modules based on configuration
* and from directory-based discovery (bundled, managed, workspace)
*/
const log = createSubsystemLogger("hooks:loader");
const loadedHookRegistrations = resolveGlobalSingleton(Symbol.for("openclaw.loadedInternalHookRegistrations"), () => []);
function safeLogValue(value) {
	return sanitizeForLog(value);
}
function isNonEmptyRelativePathInsideRoot(relativePath) {
	return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}
function maybeWarnTrustedHookSource(source) {
	if (source === "openclaw-workspace") {
		log.warn("Loading workspace hook code into the gateway process. Workspace hooks are trusted local code.");
		return;
	}
	if (source === "openclaw-managed") log.warn("Loading managed hook code into the gateway process. Managed hooks are trusted local code.");
}
function resetLoadedInternalHooks() {
	while (loadedHookRegistrations.length > 0) {
		const registration = loadedHookRegistrations.pop();
		if (!registration) continue;
		unregisterInternalHook(registration.event, registration.handler);
	}
}
/**
* Load and register all hook handlers
*
* Loads hooks from both:
* 1. Directory-based discovery (bundled, managed, workspace)
* 2. Legacy config handlers (backwards compatibility)
*
* @param cfg - OpenClaw configuration
* @param workspaceDir - Workspace directory for hook discovery
* @returns Number of handlers successfully loaded
*
* @example
* ```ts
* const config = await getRuntimeConfig();
* const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
* const count = await loadInternalHooks(config, workspaceDir);
* console.log(`Loaded ${count} hook handlers`);
* ```
*/
async function loadInternalHooks(cfg, workspaceDir, opts) {
	resetLoadedInternalHooks();
	if (!hasConfiguredInternalHooks(cfg)) return 0;
	let loadedCount = 0;
	const configuredNames = resolveConfiguredInternalHookNames(cfg);
	try {
		const eligible = loadWorkspaceHookEntries(workspaceDir, {
			config: cfg,
			managedHooksDir: opts?.managedHooksDir,
			bundledHooksDir: opts?.bundledHooksDir
		}).filter((entry) => {
			if (configuredNames && !configuredNames.has(entry.hook.name)) return false;
			return shouldIncludeHook({
				entry,
				config: cfg
			});
		});
		for (const entry of eligible) try {
			const hookBaseDir = resolveExistingRealpath(entry.hook.baseDir);
			if (!hookBaseDir) {
				log.error(`Hook '${safeLogValue(entry.hook.name)}' base directory is no longer readable: ${safeLogValue(entry.hook.baseDir)}`);
				continue;
			}
			const opened = await openRootFile({
				absolutePath: entry.hook.handlerPath,
				rootPath: hookBaseDir,
				boundaryLabel: "hook directory"
			});
			if (!opened.ok) {
				log.error(`Hook '${safeLogValue(entry.hook.name)}' handler path fails boundary checks: ${safeLogValue(entry.hook.handlerPath)}`);
				continue;
			}
			const safeHandlerPath = opened.path;
			fs.closeSync(opened.fd);
			maybeWarnTrustedHookSource(entry.hook.source);
			const mod = await import(buildImportUrl(safeHandlerPath, entry.hook.source));
			const exportName = entry.metadata?.export ?? "default";
			const handler = resolveFunctionModuleExport({
				mod,
				exportName
			});
			if (!handler) {
				log.error(`Handler '${safeLogValue(exportName)}' from ${safeLogValue(entry.hook.name)} is not a function`);
				continue;
			}
			const events = entry.metadata?.events ?? [];
			if (events.length === 0) {
				log.warn(`Hook '${safeLogValue(entry.hook.name)}' has no events defined in metadata`);
				continue;
			}
			for (const event of events) {
				registerInternalHook(event, handler);
				loadedHookRegistrations.push({
					event,
					handler
				});
			}
			log.debug(`Registered hook: ${safeLogValue(entry.hook.name)} -> ${events.map((event) => safeLogValue(event)).join(", ")}${exportName !== "default" ? ` (export: ${safeLogValue(exportName)})` : ""}`);
			loadedCount++;
		} catch (err) {
			log.error(`Failed to load hook ${safeLogValue(entry.hook.name)}: ${safeLogValue(formatErrorMessage(err))}`);
		}
	} catch (err) {
		log.error(`Failed to load directory-based hooks: ${safeLogValue(formatErrorMessage(err))}`);
	}
	const handlers = getLegacyInternalHookHandlers(cfg);
	for (const handlerConfig of handlers) try {
		const rawModule = handlerConfig.module.trim();
		if (!rawModule) {
			log.error("Handler module path is empty");
			continue;
		}
		if (path.isAbsolute(rawModule)) {
			log.error(`Handler module path must be workspace-relative (got absolute path): ${safeLogValue(rawModule)}`);
			continue;
		}
		const baseDir = path.resolve(workspaceDir);
		const modulePath = path.resolve(baseDir, rawModule);
		const baseDirReal = resolveExistingRealpath(baseDir);
		if (!baseDirReal) {
			log.error(`Workspace directory is no longer readable while loading hooks: ${safeLogValue(baseDir)}`);
			continue;
		}
		const modulePathSafe = resolveExistingRealpath(modulePath);
		if (!modulePathSafe) {
			log.error(`Handler module path could not be resolved with realpath: ${safeLogValue(rawModule)}`);
			continue;
		}
		if (!isNonEmptyRelativePathInsideRoot(path.relative(baseDirReal, modulePathSafe))) {
			log.error(`Handler module path must stay within workspaceDir: ${safeLogValue(rawModule)}`);
			continue;
		}
		const opened = await openRootFile({
			absolutePath: modulePathSafe,
			rootPath: baseDirReal,
			boundaryLabel: "workspace directory"
		});
		if (!opened.ok) {
			log.error(`Handler module path fails boundary checks under workspaceDir: ${safeLogValue(rawModule)}`);
			continue;
		}
		const safeModulePath = opened.path;
		fs.closeSync(opened.fd);
		log.warn(`Loading legacy internal hook module from workspace path ${safeLogValue(rawModule)}. Legacy hook modules are trusted local code.`);
		const mod = await import(buildImportUrl(safeModulePath, "openclaw-workspace"));
		const exportName = handlerConfig.export ?? "default";
		const handler = resolveFunctionModuleExport({
			mod,
			exportName
		});
		if (!handler) {
			log.error(`Handler '${safeLogValue(exportName)}' from ${safeLogValue(modulePath)} is not a function`);
			continue;
		}
		registerInternalHook(handlerConfig.event, handler);
		loadedHookRegistrations.push({
			event: handlerConfig.event,
			handler
		});
		log.debug(`Registered hook (legacy): ${safeLogValue(handlerConfig.event)} -> ${safeLogValue(modulePath)}${exportName !== "default" ? `#${safeLogValue(exportName)}` : ""}`);
		loadedCount++;
	} catch (err) {
		log.error(`Failed to load hook handler from ${safeLogValue(handlerConfig.module)}: ${safeLogValue(formatErrorMessage(err))}`);
	}
	return loadedCount;
}
function resolveExistingRealpath(value) {
	try {
		return fs.realpathSync(value);
	} catch {
		return null;
	}
}
//#endregion
export { loadInternalHooks };
