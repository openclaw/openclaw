import { t as definePluginEntry } from "./plugin-entry-Dgh5bRuw.js";
import { t as createProviderApiKeyAuthMethod } from "./provider-api-key-auth-E_5Yag4W.js";
import { c as buildSingleProviderApiKeyCatalog } from "./provider-catalog-shared-BLp5nwNN.js";
//#region src/plugin-sdk/provider-entry.ts
function resolveWizardSetup(params) {
	if (params.auth.wizard === false) return;
	const wizard = params.auth.wizard ?? {};
	const methodId = params.auth.methodId.trim();
	return {
		choiceId: wizard.choiceId ?? `${params.providerId}-${methodId}`,
		choiceLabel: wizard.choiceLabel ?? params.auth.label,
		...wizard.choiceHint ? { choiceHint: wizard.choiceHint } : {},
		groupId: wizard.groupId ?? params.providerId,
		groupLabel: wizard.groupLabel ?? params.providerLabel,
		...wizard.groupHint ?? params.auth.hint ? { groupHint: wizard.groupHint ?? params.auth.hint } : {},
		methodId,
		...wizard.onboardingScopes ? { onboardingScopes: wizard.onboardingScopes } : {},
		...wizard.modelAllowlist ? { modelAllowlist: wizard.modelAllowlist } : {}
	};
}
function resolveEnvVars(params) {
	const combined = [...params.envVars ?? [], ...(params.auth ?? []).map((entry) => entry.envVar).filter(Boolean)].map((value) => value.trim()).filter(Boolean);
	return combined.length > 0 ? [...new Set(combined)] : void 0;
}
function projectProviderCatalogResultToUnifiedTextRows(params) {
	if (!params.result) return [];
	const providers = "provider" in params.result ? { [params.providerId]: params.result.provider } : params.result.providers;
	const rows = [];
	for (const [providerId, providerConfig] of Object.entries(providers)) for (const model of providerConfig.models ?? []) rows.push({
		kind: "text",
		provider: providerId,
		model: model.id,
		...model.name ? { label: model.name } : {},
		source: params.source
	});
	return rows;
}
async function runUnifiedTextCatalog(params) {
	const result = await params.catalog.run(params.ctx);
	return projectProviderCatalogResultToUnifiedTextRows({
		providerId: params.providerId,
		result,
		source: params.source
	});
}
function defineSingleProviderPluginEntry(options) {
	return definePluginEntry({
		id: options.id,
		name: options.name,
		description: options.description,
		...options.kind ? { kind: options.kind } : {},
		...options.configSchema ? { configSchema: options.configSchema } : {},
		register(api) {
			const provider = options.provider;
			if (provider) {
				const providerId = provider.id ?? options.id;
				const envVars = resolveEnvVars({
					envVars: provider.envVars,
					auth: provider.auth
				});
				const auth = (provider.auth ?? []).map((entry) => {
					const { wizard: _wizard, ...authParams } = entry;
					const wizard = resolveWizardSetup({
						providerId,
						providerLabel: provider.label,
						auth: entry
					});
					return createProviderApiKeyAuthMethod({
						...authParams,
						providerId,
						expectedProviders: entry.expectedProviders ?? [providerId],
						...wizard ? { wizard } : {}
					});
				});
				auth.push(...provider.extraAuth ?? []);
				let catalog;
				if ("run" in provider.catalog) {
					const catalogRun = provider.catalog.run;
					catalog = {
						order: provider.catalog.order ?? "simple",
						run: catalogRun
					};
				} else {
					const buildProvider = provider.catalog.buildProvider;
					catalog = {
						order: "simple",
						run: (ctx) => buildSingleProviderApiKeyCatalog({
							ctx,
							providerId,
							buildProvider,
							...provider.catalog.allowExplicitBaseUrl ? { allowExplicitBaseUrl: true } : {}
						})
					};
				}
				const staticCatalog = "run" in provider.catalog ? provider.catalog.staticRun ? {
					order: provider.catalog.order ?? "simple",
					run: provider.catalog.staticRun
				} : void 0 : provider.catalog.buildStaticProvider ? {
					order: "simple",
					run: async () => ({ provider: await provider.catalog.buildStaticProvider() })
				} : void 0;
				api.registerProvider({
					id: providerId,
					label: provider.label,
					docsPath: provider.docsPath,
					...provider.aliases ? { aliases: provider.aliases } : {},
					...envVars ? { envVars } : {},
					auth,
					catalog,
					...staticCatalog ? { staticCatalog } : {},
					...Object.fromEntries(Object.entries(provider).filter(([key]) => ![
						"id",
						"label",
						"docsPath",
						"aliases",
						"envVars",
						"auth",
						"extraAuth",
						"catalog",
						"staticCatalog"
					].includes(key)))
				});
				api.registerModelCatalogProvider({
					provider: providerId,
					kinds: ["text"],
					...staticCatalog ? { staticCatalog: (ctx) => runUnifiedTextCatalog({
						providerId,
						catalog: staticCatalog,
						ctx,
						source: "static"
					}) } : {},
					liveCatalog: (ctx) => runUnifiedTextCatalog({
						providerId,
						catalog,
						ctx,
						source: "live"
					})
				});
			}
			options.register?.(api);
		}
	});
}
//#endregion
export { defineSingleProviderPluginEntry as t };
