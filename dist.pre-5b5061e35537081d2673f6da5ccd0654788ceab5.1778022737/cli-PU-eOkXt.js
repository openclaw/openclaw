import { x as collectUniqueCommandDescriptors } from "./argv-DLAsQBp6.js";
import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-BD1XQ5lD.js";
import "./config-CshcuIUd.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-C_DWi525.js";
import { t as resolveManifestActivationPluginIds } from "./activation-planner-DFbl9o-f.js";
import { c as loadOpenClawPluginCliRegistry, l as loadOpenClawPlugins } from "./loader-COn7-q7R.js";
import { i as resolvePluginRuntimeLoadContext, r as createPluginRuntimeLoaderLogger, t as buildPluginRuntimeLoadOptions } from "./load-context-Brio9Jtl.js";
import { i as callGateway } from "./call-BolF1jqz.js";
import { a as registerLazyCommandGroup, n as getCommandGroupNames, o as removeCommandGroupNames, t as findCommandGroupEntry } from "./register-command-groups-Be7B5RBt.js";
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
	const onlyPluginIds = resolvePrimaryCommandPluginIds(context, params?.primaryCommand);
	return buildPluginRuntimeLoadOptions(context, {
		...loaderOptions,
		...onlyPluginIds.length > 0 ? { onlyPluginIds } : {}
	});
}
function resolvePrimaryCommandPluginIds(context, primaryCommand) {
	const normalizedPrimary = primaryCommand?.trim();
	if (!normalizedPrimary) return [];
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
	const onlyPluginIds = resolvePrimaryCommandPluginIds(params.context, params.primaryCommand);
	return {
		...params.context,
		registry: loadOpenClawPlugins(buildPluginRuntimeLoadOptions(params.context, {
			...params.loaderOptions,
			...onlyPluginIds.length > 0 ? { onlyPluginIds } : {},
			activate: false,
			cache: false,
			runtimeOptions: { nodes: createPluginCliGatewayNodesRuntime() }
		}))
	};
}
function buildPluginCliCommandGroupEntries(params) {
	return params.registry.cliRegistrars.map((entry) => ({
		pluginId: entry.pluginId,
		placeholders: entry.descriptors,
		names: entry.commands,
		register: async (program) => {
			await entry.register({
				program,
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
		return collectUniqueCommandDescriptors(registry.cliRegistrars.map((entry) => entry.descriptors));
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
async function loadPluginCliRegistrationEntriesWithDefaults(params) {
	const logger = resolvePluginCliLogger(params.logger);
	return loadPluginCliRegistrationEntries({
		...params,
		logger
	});
}
//#endregion
//#region src/plugins/register-plugin-cli-command-groups.ts
function canRegisterPluginCliLazily(entry) {
	if (entry.placeholders.length === 0) return false;
	const descriptorNames = new Set(entry.placeholders.map((descriptor) => descriptor.name));
	return getCommandGroupNames(entry).every((command) => descriptorNames.has(command));
}
async function registerPluginCliCommandGroups(program, entries, params) {
	for (const entry of entries) {
		const registerEntry = async () => {
			await entry.register(program);
			for (const command of getCommandGroupNames(entry)) params.existingCommands.add(command);
		};
		if (params.primary && findCommandGroupEntry([entry], params.primary)) {
			removeCommandGroupNames(program, entry);
			await registerEntry();
			continue;
		}
		const overlaps = getCommandGroupNames(entry).filter((command) => params.existingCommands.has(command));
		if (overlaps.length > 0) {
			params.logger.debug?.(`plugin CLI register skipped (${entry.pluginId}): command already registered (${overlaps.join(", ")})`);
			continue;
		}
		try {
			if (params.mode === "lazy" && canRegisterPluginCliLazily(entry)) {
				for (const placeholder of entry.placeholders) registerLazyCommandGroup(program, entry, placeholder);
				continue;
			}
			if (params.mode === "lazy" && entry.placeholders.length > 0) params.logger.debug?.(`plugin CLI lazy register fallback to eager (${entry.pluginId}): descriptors do not cover all command roots`);
			await registerEntry();
		} catch (error) {
			params.logger.warn(`plugin CLI register failed (${entry.pluginId}): ${String(error)}`);
		}
	}
}
//#endregion
//#region src/plugins/cli.ts
const PLUGIN_CLI_ENTRIES_CACHE_KEY = Symbol.for("openclaw.plugin-cli-registration-entries-cache");
const logger = createPluginCliLogger();
const loadValidatedConfigForPluginRegistration = async () => {
	if (!(await readConfigFileSnapshot()).valid) return null;
	return getRuntimeConfig();
};
async function getPluginCliCommandDescriptors(cfg, env, loaderOptions) {
	return loadPluginCliDescriptors({
		cfg,
		env,
		loaderOptions
	});
}
async function registerPluginCliCommands(program, cfg, env, loaderOptions, options) {
	const mode = options?.mode ?? "eager";
	const primary = options?.primary ?? void 0;
	const programWithCache = program;
	const cached = programWithCache[PLUGIN_CLI_ENTRIES_CACHE_KEY];
	let entries;
	if (cached && cached.primary === primary) entries = cached.entries;
	else {
		entries = await loadPluginCliRegistrationEntriesWithDefaults({
			cfg,
			env,
			loaderOptions,
			primaryCommand: primary
		});
		programWithCache[PLUGIN_CLI_ENTRIES_CACHE_KEY] = {
			primary,
			entries
		};
	}
	await registerPluginCliCommandGroups(program, entries, {
		mode,
		primary,
		existingCommands: new Set(program.commands.map((cmd) => cmd.name())),
		logger
	});
}
async function registerPluginCliCommandsFromValidatedConfig(program, env, loaderOptions, options) {
	const config = await loadValidatedConfigForPluginRegistration();
	if (!config) return null;
	await registerPluginCliCommands(program, config, env, loaderOptions, options);
	return config;
}
//#endregion
export { registerPluginCliCommandsFromValidatedConfig as i, loadValidatedConfigForPluginRegistration as n, registerPluginCliCommands as r, getPluginCliCommandDescriptors as t };
