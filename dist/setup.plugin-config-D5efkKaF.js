import { n as getPath, r as setPathCreateStrict } from "./path-utils-BCEW_1WB.js";
import { n as t } from "./i18n-CWNhN747.js";
//#region src/wizard/setup.plugin-config.ts
let pluginMetadataSnapshotModulePromise;
function loadPluginMetadataSnapshotModule() {
	pluginMetadataSnapshotModulePromise ??= import("./plugin-metadata-snapshot-BnR8tT26.js");
	return pluginMetadataSnapshotModulePromise;
}
function resolveJsonSchemaProperty(jsonSchema, fieldKey) {
	if (!jsonSchema) return;
	let cursor = jsonSchema;
	for (const segment of fieldKey.split(".")) {
		if (!cursor || typeof cursor !== "object") return;
		const properties = cursor.properties;
		if (!properties || typeof properties !== "object") return;
		cursor = properties[segment];
	}
	return cursor && typeof cursor === "object" ? cursor : void 0;
}
function getExistingPluginConfig(config, pluginId) {
	return config.plugins?.entries?.[pluginId]?.config ?? {};
}
function toPathSegments(fieldKey) {
	return fieldKey.split(".").filter(Boolean);
}
function formatCurrentValue(value) {
	if (value === void 0 || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (Array.isArray(value)) return value.join(", ");
	return JSON.stringify(value);
}
/**
* Discover plugins that have non-advanced uiHints fields.
* Returns only plugins that have at least one promptable field.
*/
function discoverConfigurablePlugins(params) {
	const result = [];
	for (const plugin of params.manifestPlugins) {
		if (!plugin.configUiHints) continue;
		const promptableHints = {};
		for (const [key, hint] of Object.entries(plugin.configUiHints)) if (!hint.advanced) promptableHints[key] = hint;
		if (Object.keys(promptableHints).length === 0) continue;
		result.push({
			id: plugin.id,
			name: plugin.name ?? plugin.id,
			uiHints: promptableHints,
			jsonSchema: plugin.configSchema
		});
	}
	return result.toSorted((a, b) => a.name.localeCompare(b.name));
}
/**
* Discover plugins with unconfigured non-advanced fields (for onboard flow).
* Returns only plugins where at least one promptable field has no value yet.
*/
function discoverUnconfiguredPlugins(params) {
	return discoverConfigurablePlugins(params).filter((plugin) => {
		const existing = getExistingPluginConfig(params.config, plugin.id);
		return Object.keys(plugin.uiHints).some((key) => {
			const val = getPath(existing, toPathSegments(key));
			return val === void 0 || val === null || val === "";
		});
	});
}
async function listEnabledConfigurableManifestPlugins(params) {
	const { loadPluginMetadataSnapshot } = await loadPluginMetadataSnapshotModule();
	return loadPluginMetadataSnapshot({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: process.env
	}).plugins.filter((plugin) => {
		const entry = params.config.plugins?.entries?.[plugin.id];
		return plugin.enabledByDefault || entry?.enabled === true;
	});
}
/**
* Prompt the user to configure a single plugin's fields via uiHints.
* Returns the updated config with plugin values applied.
*/
async function promptPluginFields(params) {
	const { plugin, config, prompter } = params;
	const existing = getExistingPluginConfig(config, plugin.id);
	const updatedConfig = structuredClone(existing);
	let changed = false;
	for (const [key, hint] of Object.entries(plugin.uiHints)) {
		const pathSegments = toPathSegments(key);
		const currentValue = getPath(existing, pathSegments);
		const hasValue = currentValue !== void 0 && currentValue !== null && currentValue !== "";
		if (hasValue && !params.showConfigured) continue;
		const schemaProp = resolveJsonSchemaProperty(plugin.jsonSchema, key);
		const label = hint.label ?? key;
		const helpSuffix = hint.help ? ` — ${hint.help}` : "";
		if (hint.sensitive) {
			await prompter.note(t("wizard.plugins.sensitiveField", {
				label,
				plugin: plugin.id,
				field: key
			}), t("wizard.plugins.sensitiveTitle"));
			continue;
		}
		if (schemaProp?.enum && Array.isArray(schemaProp.enum)) {
			const options = schemaProp.enum.map((v) => ({
				value: String(v),
				label: String(v)
			}));
			if (hasValue) options.unshift({
				value: "__keep__",
				label: t("wizard.plugins.currentValue", { value: formatCurrentValue(currentValue) })
			});
			const selected = await prompter.select({
				message: `${label}${helpSuffix}`,
				options,
				initialValue: hasValue ? "__keep__" : void 0
			});
			if (selected !== "__keep__") {
				setPathCreateStrict(updatedConfig, pathSegments, selected);
				changed = true;
			}
			continue;
		}
		if (schemaProp?.type === "boolean") {
			const confirmed = await prompter.confirm({
				message: `${label}${helpSuffix}`,
				initialValue: typeof currentValue === "boolean" ? currentValue : false
			});
			if (confirmed !== currentValue) {
				setPathCreateStrict(updatedConfig, pathSegments, confirmed);
				changed = true;
			}
			continue;
		}
		if (schemaProp?.type === "array") {
			const currentStr = Array.isArray(currentValue) ? currentValue.join(", ") : "";
			const trimmed = (await prompter.text({
				message: `${label}${t("wizard.plugins.arrayPromptSuffix")}${helpSuffix}`,
				initialValue: currentStr,
				placeholder: hint.placeholder ?? t("wizard.plugins.arrayPlaceholder")
			})).trim();
			if (trimmed !== currentStr) {
				if (trimmed) setPathCreateStrict(updatedConfig, pathSegments, trimmed.split(",").map((v) => v.trim()).filter(Boolean));
				else setPathCreateStrict(updatedConfig, pathSegments, void 0);
				changed = true;
			}
			continue;
		}
		const currentStr = formatCurrentValue(currentValue);
		const trimmed = (await prompter.text({
			message: `${label}${helpSuffix}`,
			initialValue: currentStr,
			placeholder: hint.placeholder
		})).trim();
		if (trimmed !== currentStr) if (schemaProp?.type === "number" || schemaProp?.type === "integer") if (trimmed === "") {
			setPathCreateStrict(updatedConfig, pathSegments, void 0);
			changed = true;
		} else {
			const parsed = Number(trimmed);
			if (Number.isFinite(parsed)) {
				setPathCreateStrict(updatedConfig, pathSegments, parsed);
				changed = true;
			}
		}
		else {
			setPathCreateStrict(updatedConfig, pathSegments, trimmed || void 0);
			changed = true;
		}
	}
	if (!changed) return config;
	return {
		...config,
		plugins: {
			...config.plugins,
			entries: {
				...config.plugins?.entries,
				[plugin.id]: {
					...config.plugins?.entries?.[plugin.id],
					config: updatedConfig
				}
			}
		}
	};
}
/**
* Run the plugin configuration step for the onboard wizard.
* Shows unconfigured plugin fields and prompts the user.
*/
async function setupPluginConfig(params) {
	const unconfigured = discoverUnconfiguredPlugins({
		manifestPlugins: await listEnabledConfigurableManifestPlugins({
			config: params.config,
			workspaceDir: params.workspaceDir
		}),
		config: params.config
	});
	if (unconfigured.length === 0) return params.config;
	const selected = await params.prompter.multiselect({
		message: t("wizard.plugins.configureSelectOnboard"),
		options: [{
			value: "__skip__",
			label: t("common.skipForNow"),
			hint: t("wizard.plugins.skipConfigHint")
		}, ...unconfigured.map((p) => ({
			value: p.id,
			label: p.name,
			hint: t("wizard.plugins.fieldsCount", {
				count: Object.keys(p.uiHints).length,
				plural: Object.keys(p.uiHints).length === 1 ? "" : "s"
			})
		}))]
	});
	let config = params.config;
	for (const pluginId of selected.filter((value) => value !== "__skip__")) {
		const plugin = unconfigured.find((p) => p.id === pluginId);
		if (!plugin) continue;
		await params.prompter.note(t("wizard.plugins.configurePlugin", { plugin: plugin.name }), t("wizard.plugins.configureFieldsTitle"));
		config = await promptPluginFields({
			plugin,
			config,
			prompter: params.prompter
		});
	}
	return config;
}
/**
* Run the plugin configuration step for the configure wizard.
* Shows all configurable plugins and all their non-advanced fields.
*/
async function configurePluginConfig(params) {
	const configurable = discoverConfigurablePlugins({ manifestPlugins: await listEnabledConfigurableManifestPlugins({
		config: params.config,
		workspaceDir: params.workspaceDir
	}) });
	if (configurable.length === 0) {
		await params.prompter.note(t("wizard.plugins.configureEmpty"), t("wizard.plugins.configureEmptyTitle"));
		return params.config;
	}
	const selected = await params.prompter.select({
		message: t("wizard.plugins.configureSelect"),
		options: [...configurable.map((p) => {
			const existing = getExistingPluginConfig(params.config, p.id);
			const configuredCount = Object.keys(p.uiHints).filter((k) => {
				const val = getPath(existing, toPathSegments(k));
				return val !== void 0 && val !== null && val !== "";
			}).length;
			const totalCount = Object.keys(p.uiHints).length;
			return {
				value: p.id,
				label: p.name,
				hint: t("wizard.plugins.configuredCount", {
					configured: configuredCount,
					total: totalCount
				})
			};
		}), {
			value: "__skip__",
			label: t("common.back"),
			hint: t("wizard.plugins.configureBackHint")
		}],
		searchable: true
	});
	if (selected === "__skip__") return params.config;
	const plugin = configurable.find((p) => p.id === selected);
	if (!plugin) return params.config;
	return promptPluginFields({
		plugin,
		config: params.config,
		prompter: params.prompter,
		showConfigured: true
	});
}
//#endregion
export { configurePluginConfig, discoverConfigurablePlugins, discoverUnconfiguredPlugins, setupPluginConfig };
