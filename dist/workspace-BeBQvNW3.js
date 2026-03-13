import { t as createSubsystemLogger } from "./subsystem-DBBM_0ww.js";
import { t as CONFIG_DIR, y as resolveUserPath } from "./utils-JhJvOE-Q.js";
import { a as openBoundaryFileSync } from "./openclaw-root-CGu4EGX8.js";
import { r as isPathInsideWithRealpath } from "./scan-paths-B5Yx6Npu.js";
import { a as parseOpenClawManifestInstallBase, c as resolveOpenClawManifestOs, d as evaluateRuntimeEligibility, f as hasBinary, i as parseFrontmatterBool, l as resolveOpenClawManifestRequires, m as MANIFEST_KEY, n as getFrontmatterString, o as resolveOpenClawManifestBlock, p as isConfigPathTruthyWithDefaults, r as normalizeStringList, s as resolveOpenClawManifestInstall, t as applyOpenClawManifestInstallCommonFields, u as parseFrontmatterBlock } from "./frontmatter-BngyYhS0.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/hooks/frontmatter.ts
function parseFrontmatter(content) {
	return parseFrontmatterBlock(content);
}
function parseInstallSpec(input) {
	const parsed = parseOpenClawManifestInstallBase(input, [
		"bundled",
		"npm",
		"git"
	]);
	if (!parsed) return;
	const { raw } = parsed;
	const spec = applyOpenClawManifestInstallCommonFields({ kind: parsed.kind }, parsed);
	if (typeof raw.package === "string") spec.package = raw.package;
	if (typeof raw.repository === "string") spec.repository = raw.repository;
	return spec;
}
function resolveOpenClawMetadata(frontmatter) {
	const metadataObj = resolveOpenClawManifestBlock({ frontmatter });
	if (!metadataObj) return;
	const requires = resolveOpenClawManifestRequires(metadataObj);
	const install = resolveOpenClawManifestInstall(metadataObj, parseInstallSpec);
	const osRaw = resolveOpenClawManifestOs(metadataObj);
	const eventsRaw = normalizeStringList(metadataObj.events);
	return {
		always: typeof metadataObj.always === "boolean" ? metadataObj.always : void 0,
		emoji: typeof metadataObj.emoji === "string" ? metadataObj.emoji : void 0,
		homepage: typeof metadataObj.homepage === "string" ? metadataObj.homepage : void 0,
		hookKey: typeof metadataObj.hookKey === "string" ? metadataObj.hookKey : void 0,
		export: typeof metadataObj.export === "string" ? metadataObj.export : void 0,
		os: osRaw.length > 0 ? osRaw : void 0,
		events: eventsRaw.length > 0 ? eventsRaw : [],
		requires,
		install: install.length > 0 ? install : void 0
	};
}
function resolveHookInvocationPolicy(frontmatter) {
	return { enabled: parseFrontmatterBool(getFrontmatterString(frontmatter, "enabled"), true) };
}
function resolveHookKey(hookName, entry) {
	return entry?.metadata?.hookKey ?? hookName;
}
//#endregion
//#region src/hooks/config.ts
const DEFAULT_CONFIG_VALUES = {
	"browser.enabled": true,
	"browser.evaluateEnabled": true,
	"workspace.dir": true
};
function isConfigPathTruthy(config, pathStr) {
	return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}
function resolveHookConfig(config, hookKey) {
	const hooks = config?.hooks?.internal?.entries;
	if (!hooks || typeof hooks !== "object") return;
	const entry = hooks[hookKey];
	if (!entry || typeof entry !== "object") return;
	return entry;
}
function evaluateHookRuntimeEligibility(params) {
	const { entry, config, hookConfig, eligibility } = params;
	const remote = eligibility?.remote;
	return evaluateRuntimeEligibility({
		os: entry.metadata?.os,
		remotePlatforms: remote?.platforms,
		always: entry.metadata?.always,
		requires: entry.metadata?.requires,
		hasRemoteBin: remote?.hasBin,
		hasAnyRemoteBin: remote?.hasAnyBin,
		hasBin: hasBinary,
		hasEnv: (envName) => Boolean(process.env[envName] || hookConfig?.env?.[envName]),
		isConfigPathTruthy: (configPath) => isConfigPathTruthy(config, configPath)
	});
}
function shouldIncludeHook(params) {
	const { entry, config, eligibility } = params;
	const hookConfig = resolveHookConfig(config, resolveHookKey(entry.hook.name, entry));
	if (!(entry.hook.source === "openclaw-plugin") && hookConfig?.enabled === false) return false;
	return evaluateHookRuntimeEligibility({
		entry,
		config,
		hookConfig,
		eligibility
	});
}
//#endregion
//#region src/hooks/bundled-dir.ts
function resolveBundledHooksDir() {
	const override = process.env.OPENCLAW_BUNDLED_HOOKS_DIR?.trim();
	if (override) return override;
	try {
		const execDir = path.dirname(process.execPath);
		const sibling = path.join(execDir, "hooks", "bundled");
		if (fs.existsSync(sibling)) return sibling;
	} catch {}
	try {
		const moduleDir = path.dirname(fileURLToPath(import.meta.url));
		const distBundled = path.join(moduleDir, "bundled");
		if (fs.existsSync(distBundled)) return distBundled;
	} catch {}
	try {
		const moduleDir = path.dirname(fileURLToPath(import.meta.url));
		const root = path.resolve(moduleDir, "..", "..");
		const srcBundled = path.join(root, "src", "hooks", "bundled");
		if (fs.existsSync(srcBundled)) return srcBundled;
	} catch {}
}
//#endregion
//#region src/hooks/workspace.ts
const log = createSubsystemLogger("hooks/workspace");
function readHookPackageManifest(dir) {
	const raw = readBoundaryFileUtf8({
		absolutePath: path.join(dir, "package.json"),
		rootPath: dir,
		boundaryLabel: "hook package directory"
	});
	if (raw === null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
function resolvePackageHooks(manifest) {
	const raw = manifest[MANIFEST_KEY]?.hooks;
	if (!Array.isArray(raw)) return [];
	return raw.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function resolveContainedDir(baseDir, targetDir) {
	const base = path.resolve(baseDir);
	const resolved = path.resolve(baseDir, targetDir);
	if (!isPathInsideWithRealpath(base, resolved, { requireRealpath: true })) return null;
	return resolved;
}
function loadHookFromDir(params) {
	const hookMdPath = path.join(params.hookDir, "HOOK.md");
	const content = readBoundaryFileUtf8({
		absolutePath: hookMdPath,
		rootPath: params.hookDir,
		boundaryLabel: "hook directory"
	});
	if (content === null) return null;
	try {
		const frontmatter = parseFrontmatter(content);
		const name = frontmatter.name || params.nameHint || path.basename(params.hookDir);
		const description = frontmatter.description || "";
		const handlerCandidates = [
			"handler.ts",
			"handler.js",
			"index.ts",
			"index.js"
		];
		let handlerPath;
		for (const candidate of handlerCandidates) {
			const safeCandidatePath = resolveBoundaryFilePath({
				absolutePath: path.join(params.hookDir, candidate),
				rootPath: params.hookDir,
				boundaryLabel: "hook directory"
			});
			if (safeCandidatePath) {
				handlerPath = safeCandidatePath;
				break;
			}
		}
		if (!handlerPath) {
			log.warn(`Hook "${name}" has HOOK.md but no handler file in ${params.hookDir}`);
			return null;
		}
		return {
			name,
			description,
			source: params.source,
			pluginId: params.pluginId,
			filePath: hookMdPath,
			baseDir: params.hookDir,
			handlerPath
		};
	} catch (err) {
		const message = err instanceof Error ? err.stack ?? err.message : String(err);
		log.warn(`Failed to load hook from ${params.hookDir}: ${message}`);
		return null;
	}
}
/**
* Scan a directory for hooks (subdirectories containing HOOK.md)
*/
function loadHooksFromDir(params) {
	const { dir, source, pluginId } = params;
	if (!fs.existsSync(dir)) return [];
	if (!fs.statSync(dir).isDirectory()) return [];
	const hooks = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const hookDir = path.join(dir, entry.name);
		const manifest = readHookPackageManifest(hookDir);
		const packageHooks = manifest ? resolvePackageHooks(manifest) : [];
		if (packageHooks.length > 0) {
			for (const hookPath of packageHooks) {
				const resolvedHookDir = resolveContainedDir(hookDir, hookPath);
				if (!resolvedHookDir) {
					log.warn(`Ignoring out-of-package hook path "${hookPath}" in ${hookDir} (must be within package directory)`);
					continue;
				}
				const hook = loadHookFromDir({
					hookDir: resolvedHookDir,
					source,
					pluginId,
					nameHint: path.basename(resolvedHookDir)
				});
				if (hook) hooks.push(hook);
			}
			continue;
		}
		const hook = loadHookFromDir({
			hookDir,
			source,
			pluginId,
			nameHint: entry.name
		});
		if (hook) hooks.push(hook);
	}
	return hooks;
}
function loadHookEntries(workspaceDir, opts) {
	const managedHooksDir = opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks");
	const workspaceHooksDir = path.join(workspaceDir, "hooks");
	const bundledHooksDir = opts?.bundledHooksDir ?? resolveBundledHooksDir();
	const extraDirs = (opts?.config?.hooks?.internal?.load?.extraDirs ?? []).map((d) => typeof d === "string" ? d.trim() : "").filter(Boolean);
	const bundledHooks = bundledHooksDir ? loadHooksFromDir({
		dir: bundledHooksDir,
		source: "openclaw-bundled"
	}) : [];
	const extraHooks = extraDirs.flatMap((dir) => {
		return loadHooksFromDir({
			dir: resolveUserPath(dir),
			source: "openclaw-workspace"
		});
	});
	const managedHooks = loadHooksFromDir({
		dir: managedHooksDir,
		source: "openclaw-managed"
	});
	const workspaceHooks = loadHooksFromDir({
		dir: workspaceHooksDir,
		source: "openclaw-workspace"
	});
	const merged = /* @__PURE__ */ new Map();
	for (const hook of extraHooks) merged.set(hook.name, hook);
	for (const hook of bundledHooks) merged.set(hook.name, hook);
	for (const hook of managedHooks) merged.set(hook.name, hook);
	for (const hook of workspaceHooks) merged.set(hook.name, hook);
	return Array.from(merged.values()).map((hook) => {
		let frontmatter = {};
		const raw = readBoundaryFileUtf8({
			absolutePath: hook.filePath,
			rootPath: hook.baseDir,
			boundaryLabel: "hook directory"
		});
		if (raw !== null) frontmatter = parseFrontmatter(raw);
		return {
			hook,
			frontmatter,
			metadata: resolveOpenClawMetadata(frontmatter),
			invocation: resolveHookInvocationPolicy(frontmatter)
		};
	});
}
function loadWorkspaceHookEntries(workspaceDir, opts) {
	return loadHookEntries(workspaceDir, opts);
}
function readBoundaryFileUtf8(params) {
	return withOpenedBoundaryFileSync(params, (opened) => {
		try {
			return fs.readFileSync(opened.fd, "utf-8");
		} catch {
			return null;
		}
	});
}
function withOpenedBoundaryFileSync(params, read) {
	const opened = openBoundaryFileSync({
		absolutePath: params.absolutePath,
		rootPath: params.rootPath,
		boundaryLabel: params.boundaryLabel
	});
	if (!opened.ok) return null;
	try {
		return read({
			fd: opened.fd,
			path: opened.path
		});
	} finally {
		fs.closeSync(opened.fd);
	}
}
function resolveBoundaryFilePath(params) {
	return withOpenedBoundaryFileSync(params, (opened) => opened.path);
}
//#endregion
export { parseFrontmatter as a, shouldIncludeHook as i, isConfigPathTruthy as n, resolveHookConfig as r, loadWorkspaceHookEntries as t };
