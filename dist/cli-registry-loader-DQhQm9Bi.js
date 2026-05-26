import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { C as collectUniqueCommandDescriptors } from "./argv-j42r4Rb7.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { t as resolveManifestActivationPluginIds } from "./activation-planner-Cd6anAX7.js";
import { c as loadOpenClawPlugins, s as loadOpenClawPluginCliRegistry } from "./loader-DKK7Ita0.js";
import { F as createEmptyPluginRegistry } from "./runtime-DHxRl5F1.js";
import { i as resolvePluginRuntimeLoadContext, r as createPluginRuntimeLoaderLogger, t as buildPluginRuntimeLoadOptions } from "./load-context-BO-9CJts.js";
import { randomUUID } from "node:crypto";
//#region src/plugins/cli-gateway-nodes-runtime.ts
function createPluginCliGatewayNodesRuntime() {
	return {
		async list(params) {
			const payload = await callGateway({
				method: "node.list",
				params: {},
				clientName: GATEWAY_CLIENT_NAMES.CLI,
				mode: GATEWAY_CLIENT_MODES.CLI
			});
			const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
			return { nodes: params?.connected === true ? nodes.filter((node) => node !== null && typeof node === "object" && node.connected === true) : nodes };
		},
		async invoke(params) {
			return await callGateway({
				method: "node.invoke",
				params: {
					nodeId: params.nodeId,
					command: params.command,
					...params.params !== void 0 && { params: params.params },
					timeoutMs: params.timeoutMs,
					idempotencyKey: params.idempotencyKey || randomUUID()
				},
				timeoutMs: params.timeoutMs ? params.timeoutMs + 5e3 : void 0,
				clientName: GATEWAY_CLIENT_NAMES.CLI,
				mode: GATEWAY_CLIENT_MODES.CLI
			});
		}
	};
}
//#endregion
//#region src/plugins/cli-registry-loader.ts
function createPluginCliLogger() {
	return createPluginRuntimeLoaderLogger();
}
function resolvePluginCliLogger(logger) {
	return logger ?? createPluginCliLogger();
}
function buildPluginCliLoaderParams(context, params, loaderOptions) {
	const onlyPluginIds = resolvePrimaryCommandManifestPluginIds(context, params?.primaryCommand);
	return buildPluginRuntimeLoadOptions(context, {
		...loaderOptions,
		...onlyPluginIds && onlyPluginIds.length > 0 ? { onlyPluginIds } : {}
	});
}
function normalizePluginCliRootName(value) {
	return normalizeLowercaseStringOrEmpty(value);
}
function resolvePrimaryCommandManifestPluginIds(context, primaryCommand) {
	const normalizedPrimary = normalizePluginCliRootName(primaryCommand);
	if (!normalizedPrimary) return;
	return resolveManifestActivationPluginIds({
		trigger: {
			kind: "command",
			command: normalizedPrimary
		},
		config: context.activationSourceConfig,
		workspaceDir: context.workspaceDir,
		env: context.env
	});
}
function listPluginCliRootOwnerIds(registry, primaryCommand) {
	const normalizedPrimary = normalizePluginCliRootName(primaryCommand);
	if (!normalizedPrimary) return [];
	return [...new Set(registry.cliRegistrars.filter((entry) => {
		const parentPath = entry.parentPath ?? [];
		return (parentPath.length > 0 ? [parentPath[0]] : [...entry.commands, ...entry.descriptors.map((descriptor) => descriptor.name)]).includes(normalizedPrimary);
	}).map((entry) => entry.pluginId))];
}
async function resolvePrimaryCommandPluginIds(context, primaryCommand, loaderOptions) {
	const normalizedPrimary = normalizePluginCliRootName(primaryCommand);
	if (!normalizedPrimary) return;
	const manifestPluginIds = resolvePrimaryCommandManifestPluginIds(context, normalizedPrimary);
	if (manifestPluginIds && manifestPluginIds.length > 0) return manifestPluginIds;
	const { registry } = await loadPluginCliMetadataRegistryWithContext(context, { primaryCommand: normalizedPrimary }, loaderOptions);
	return listPluginCliRootOwnerIds(registry, normalizedPrimary);
}
function resolvePluginCliLoadContext(params) {
	return resolvePluginRuntimeLoadContext({
		config: params.cfg,
		env: params.env,
		logger: params.logger
	});
}
async function loadPluginCliMetadataRegistryWithContext(context, params, loaderOptions) {
	return {
		...context,
		registry: await loadOpenClawPluginCliRegistry(buildPluginCliLoaderParams(context, params, loaderOptions))
	};
}
async function loadPluginCliCommandRegistryWithContext(params) {
	let onlyPluginIds;
	try {
		onlyPluginIds = await resolvePrimaryCommandPluginIds(params.context, params.primaryCommand, params.loaderOptions);
	} catch {
		onlyPluginIds = resolvePrimaryCommandManifestPluginIds(params.context, params.primaryCommand);
	}
	if (onlyPluginIds && onlyPluginIds.length === 0) return {
		...params.context,
		registry: createEmptyPluginRegistry()
	};
	return {
		...params.context,
		registry: loadOpenClawPlugins(buildPluginRuntimeLoadOptions(params.context, {
			...params.loaderOptions,
			...onlyPluginIds && onlyPluginIds.length > 0 ? { onlyPluginIds } : {},
			activate: false,
			cache: false,
			runtimeOptions: { nodes: createPluginCliGatewayNodesRuntime() }
		}))
	};
}
function buildPluginCliCommandGroupEntries(params) {
	return params.registry.cliRegistrars.map((entry) => ({
		pluginId: entry.pluginId,
		parentPath: entry.parentPath ?? [],
		placeholders: entry.descriptors,
		names: entry.commands,
		register: async (program) => {
			await entry.register({
				program,
				parentPath: entry.parentPath ?? [],
				config: params.config,
				workspaceDir: params.workspaceDir,
				logger: params.logger
			});
		}
	}));
}
async function loadPluginCliDescriptors(params) {
	try {
		const logger = resolvePluginCliLogger(params.logger);
		const { registry } = await loadPluginCliMetadataRegistryWithContext(resolvePluginCliLoadContext({
			cfg: params.cfg,
			env: params.env,
			logger
		}), { primaryCommand: params.primaryCommand }, params.loaderOptions);
		return collectUniqueCommandDescriptors(registry.cliRegistrars.filter((entry) => (entry.parentPath ?? []).length === 0).map((entry) => entry.descriptors));
	} catch {
		return [];
	}
}
async function loadPluginCliRegistrationEntries(params) {
	const resolvedLogger = resolvePluginCliLogger(params.logger);
	const { config, workspaceDir, logger, registry } = await loadPluginCliCommandRegistryWithContext({
		context: resolvePluginCliLoadContext({
			cfg: params.cfg,
			env: params.env,
			logger: resolvedLogger
		}),
		primaryCommand: params.primaryCommand,
		loaderOptions: params.loaderOptions
	});
	return buildPluginCliCommandGroupEntries({
		registry,
		config,
		workspaceDir,
		logger
	});
}
async function resolvePluginCliRootOwnerIds(params) {
	const primaryCommand = normalizePluginCliRootName(params.primaryCommand);
	if (!primaryCommand) return null;
	const logger = resolvePluginCliLogger(params.logger);
	return await resolvePrimaryCommandPluginIds(resolvePluginCliLoadContext({
		cfg: params.cfg,
		env: params.env,
		logger
	}), primaryCommand, params.loaderOptions) ?? null;
}
async function loadPluginCliRegistrationEntriesWithDefaults(params) {
	const logger = resolvePluginCliLogger(params.logger);
	return loadPluginCliRegistrationEntries({
		...params,
		logger
	});
}
//#endregion
export { loadPluginCliRegistrationEntries as a, resolvePluginCliRootOwnerIds as c, loadPluginCliMetadataRegistryWithContext as i, loadPluginCliCommandRegistryWithContext as n, loadPluginCliRegistrationEntriesWithDefaults as o, loadPluginCliDescriptors as r, resolvePluginCliLoadContext as s, createPluginCliLogger as t };
