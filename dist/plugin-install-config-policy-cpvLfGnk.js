import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { p as tryReadJsonSync } from "./json-files-C2hqjU--.js";
import { i as loadPluginManifest } from "./manifest-Cyo7Vmnr.js";
import { a as listOfficialExternalPluginCatalogEntries, c as resolveOfficialExternalPluginInstall, s as resolveOfficialExternalPluginId } from "./official-external-plugin-catalog-f6g4JsA2.js";
import { t as findBundledPluginSource } from "./bundled-sources-Bb5DSmIr.js";
import { d as resolveFileNpmSpecToLocalPath, l as parseNpmPrefixSpec } from "./plugins-command-helpers-BUsheNmo.js";
import fs from "node:fs";
import path from "node:path";
//#region src/cli/plugin-install-config-policy.ts
function isPluginInstallCommand(commandPath) {
	return commandPath[0] === "plugins" && commandPath[1] === "install";
}
function readBundledInstallRecoveryMetadata(rootDir) {
	const packageJsonPath = path.join(rootDir, "package.json");
	if (!fs.existsSync(packageJsonPath)) return { allowInvalidConfigRecovery: false };
	const manifest = loadPluginManifest(rootDir, false);
	const pluginId = manifest.ok ? manifest.manifest.id : void 0;
	const parsed = tryReadJsonSync(packageJsonPath);
	return {
		...pluginId ? { pluginId } : {},
		allowInvalidConfigRecovery: parsed?.openclaw?.install?.allowInvalidConfigRecovery === true
	};
}
function resolveBundledInstallRecoveryMetadata(request) {
	if (request.marketplace) return {};
	if (request.resolvedPath && fs.existsSync(path.join(request.resolvedPath, "package.json"))) {
		const direct = readBundledInstallRecoveryMetadata(request.resolvedPath);
		if (direct.pluginId || direct.allowInvalidConfigRecovery) return direct;
	}
	const rawNpmPrefixSpec = parseNpmPrefixSpec(request.rawSpec);
	const normalizedNpmPrefixSpec = parseNpmPrefixSpec(request.normalizedSpec);
	for (const value of [
		request.rawSpec.trim(),
		request.normalizedSpec.trim(),
		rawNpmPrefixSpec ?? "",
		normalizedNpmPrefixSpec ?? ""
	]) {
		if (!value) continue;
		const bundled = findBundledPluginSource({ lookup: {
			kind: "npmSpec",
			value
		} });
		if (!bundled) continue;
		const recovered = readBundledInstallRecoveryMetadata(bundled.localPath);
		return {
			pluginId: recovered.pluginId ?? bundled.pluginId,
			allowInvalidConfigRecovery: recovered.allowInvalidConfigRecovery
		};
	}
	return {};
}
function resolveOfficialExternalInstallRecoveryMetadata(request) {
	if (request.marketplace) return {};
	const rawNpmPrefixSpec = parseNpmPrefixSpec(request.rawSpec);
	const normalizedNpmPrefixSpec = parseNpmPrefixSpec(request.normalizedSpec);
	const values = new Set([
		request.rawSpec,
		request.normalizedSpec,
		rawNpmPrefixSpec ?? "",
		normalizedNpmPrefixSpec ?? ""
	].map((value) => value.trim()).filter(Boolean));
	if (values.size === 0) return {};
	for (const entry of listOfficialExternalPluginCatalogEntries()) {
		const install = resolveOfficialExternalPluginInstall(entry);
		const npmSpec = install?.npmSpec?.trim() || entry.name?.trim();
		if (!npmSpec || !values.has(npmSpec)) continue;
		const pluginId = resolveOfficialExternalPluginId(entry);
		return {
			...pluginId ? { pluginId } : {},
			allowInvalidConfigRecovery: install?.allowInvalidConfigRecovery === true
		};
	}
	return {};
}
function resolvePluginInstallArgvTokens(commandPath, argv) {
	const args = argv.slice(2);
	let cursor = 0;
	for (const segment of commandPath) {
		while (cursor < args.length && args[cursor] !== segment) cursor += 1;
		if (cursor >= args.length) return [];
		cursor += 1;
	}
	return args.slice(cursor);
}
function resolvePluginInstallArgvRequest(commandPath, argv) {
	if (!isPluginInstallCommand(commandPath)) return null;
	const tokens = resolvePluginInstallArgvTokens(commandPath, argv);
	let rawSpec = null;
	let marketplace;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.startsWith("--marketplace=")) {
			marketplace = token.slice(14);
			continue;
		}
		if (token === "--marketplace") {
			const value = tokens[index + 1];
			if (typeof value === "string") {
				marketplace = value;
				index += 1;
			}
			continue;
		}
		if (token.startsWith("-")) continue;
		rawSpec ??= token;
	}
	return rawSpec ? {
		rawSpec,
		marketplace
	} : null;
}
function resolvePluginInstallRequestContext(params) {
	if (params.marketplace) return {
		ok: true,
		request: {
			rawSpec: params.rawSpec,
			normalizedSpec: params.rawSpec,
			marketplace: params.marketplace
		}
	};
	const fileSpec = resolveFileNpmSpecToLocalPath(params.rawSpec);
	if (fileSpec && !fileSpec.ok) return {
		ok: false,
		error: fileSpec.error
	};
	const normalizedSpec = fileSpec && fileSpec.ok ? fileSpec.path : params.rawSpec;
	const bundledRecovered = resolveBundledInstallRecoveryMetadata({
		rawSpec: params.rawSpec,
		normalizedSpec,
		resolvedPath: resolveUserPath(normalizedSpec),
		marketplace: params.marketplace
	});
	const officialRecovered = resolveOfficialExternalInstallRecoveryMetadata({
		rawSpec: params.rawSpec,
		normalizedSpec,
		marketplace: params.marketplace
	});
	const recovered = officialRecovered.pluginId || officialRecovered.allowInvalidConfigRecovery !== void 0 ? officialRecovered : bundledRecovered;
	return {
		ok: true,
		request: {
			rawSpec: params.rawSpec,
			normalizedSpec,
			resolvedPath: resolveUserPath(normalizedSpec),
			...recovered.pluginId ? { bundledPluginId: recovered.pluginId } : {},
			...recovered.allowInvalidConfigRecovery !== void 0 ? { allowInvalidConfigRecovery: recovered.allowInvalidConfigRecovery } : {}
		}
	};
}
function resolvePluginInstallPreactionRequest(params) {
	if (!isPluginInstallCommand(params.commandPath)) return null;
	const argvRequest = resolvePluginInstallArgvRequest(params.commandPath, params.argv);
	const opts = params.actionCommand.opts();
	const marketplace = (typeof opts.marketplace === "string" && opts.marketplace.trim() ? opts.marketplace : argvRequest?.marketplace) || void 0;
	const rawSpec = (typeof params.actionCommand.processedArgs?.[0] === "string" ? params.actionCommand.processedArgs[0] : argvRequest?.rawSpec) ?? null;
	if (!rawSpec) return null;
	const request = resolvePluginInstallRequestContext({
		rawSpec,
		marketplace
	});
	return request.ok ? request.request : null;
}
function resolvePluginInstallInvalidConfigPolicy(request) {
	if (!request) return "deny";
	return request.allowInvalidConfigRecovery === true ? "allow-plugin-recovery" : "deny";
}
//#endregion
export { resolvePluginInstallPreactionRequest as n, resolvePluginInstallRequestContext as r, resolvePluginInstallInvalidConfigPolicy as t };
