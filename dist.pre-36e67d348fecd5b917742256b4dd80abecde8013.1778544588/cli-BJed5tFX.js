import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-C04VWQdx.js";
import "./config-Dk0DnRek.js";
import { a as registerLazyCommandGroup, n as getCommandGroupNames, o as removeCommandGroupNames, t as findCommandGroupEntry } from "./register-command-groups-DoI3sWUF.js";
import { o as loadPluginCliRegistrationEntriesWithDefaults, r as loadPluginCliDescriptors, t as createPluginCliLogger } from "./cli-registry-loader-BivsyjSq.js";
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
