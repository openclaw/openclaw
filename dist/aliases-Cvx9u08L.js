import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { r as logConfigUpdated } from "./logging-t-RUPR6R.js";
import { t as normalizeAlias } from "./alias-name-dY2or4SK.js";
import { l as resolveModelTarget, n as ensureFlagCompatibility, u as updateConfig } from "./shared-CXerptPG.js";
import { t as loadModelsConfig } from "./load-config-B1XseUf7.js";
//#region src/commands/models/aliases.ts
async function modelsAliasesListCommand(opts, runtime) {
	ensureFlagCompatibility(opts);
	const models = (await loadModelsConfig({
		commandName: "models aliases list",
		runtime
	})).agents?.defaults?.models ?? {};
	const aliases = Object.entries(models).reduce((acc, [modelKey, entry]) => {
		const alias = entry?.alias?.trim();
		if (alias) acc[alias] = modelKey;
		return acc;
	}, {});
	if (opts.json) {
		writeRuntimeJson(runtime, { aliases });
		return;
	}
	if (opts.plain) {
		for (const [alias, target] of Object.entries(aliases)) runtime.log(`${alias} ${target}`);
		return;
	}
	runtime.log(`Aliases (${Object.keys(aliases).length}):`);
	if (Object.keys(aliases).length === 0) {
		runtime.log("- none");
		return;
	}
	for (const [alias, target] of Object.entries(aliases)) runtime.log(`- ${alias} -> ${target}`);
}
async function modelsAliasesAddCommand(aliasRaw, modelRaw, runtime) {
	const alias = normalizeAlias(aliasRaw);
	const resolved = resolveModelTarget({
		raw: modelRaw,
		cfg: await loadModelsConfig({
			commandName: "models aliases add",
			runtime
		})
	});
	await updateConfig((cfg) => {
		const modelKey = `${resolved.provider}/${resolved.model}`;
		const nextModels = { ...cfg.agents?.defaults?.models };
		for (const [key, entry] of Object.entries(nextModels)) {
			const existing = entry?.alias?.trim();
			if (existing && existing === alias && key !== modelKey) throw new Error(`Alias ${alias} already points to ${key}.`);
		}
		nextModels[modelKey] = {
			...nextModels[modelKey] ?? {},
			alias
		};
		return {
			...cfg,
			agents: {
				...cfg.agents,
				defaults: {
					...cfg.agents?.defaults,
					models: nextModels
				}
			}
		};
	});
	logConfigUpdated(runtime);
	runtime.log(`Alias ${alias} -> ${resolved.provider}/${resolved.model}`);
}
async function modelsAliasesRemoveCommand(aliasRaw, runtime) {
	const alias = normalizeAlias(aliasRaw);
	const updated = await updateConfig((cfg) => {
		const nextModels = { ...cfg.agents?.defaults?.models };
		let found = false;
		for (const [key, entry] of Object.entries(nextModels)) if (entry?.alias?.trim() === alias) {
			nextModels[key] = {
				...entry,
				alias: void 0
			};
			found = true;
			break;
		}
		if (!found) throw new Error(`Alias not found: ${alias}. Run ${formatCliCommand("openclaw models aliases list")} to see configured aliases.`);
		return {
			...cfg,
			agents: {
				...cfg.agents,
				defaults: {
					...cfg.agents?.defaults,
					models: nextModels
				}
			}
		};
	});
	logConfigUpdated(runtime);
	if (!updated.agents?.defaults?.models || Object.values(updated.agents.defaults.models).every((entry) => !entry?.alias?.trim())) runtime.log("No aliases configured.");
}
//#endregion
export { modelsAliasesAddCommand, modelsAliasesListCommand, modelsAliasesRemoveCommand };
