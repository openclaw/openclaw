//#region src/commands/models/list.source-plan.ts
function createSourcePlan(params) {
	return {
		kind: params.kind,
		manifestCatalogRows: params.manifestCatalogRows ?? [],
		providerIndexCatalogRows: params.providerIndexCatalogRows ?? [],
		requiresInitialRegistry: params.requiresInitialRegistry ?? false,
		skipRuntimeModelSuppression: params.skipRuntimeModelSuppression ?? false,
		fallbackToRegistryWhenEmpty: params.fallbackToRegistryWhenEmpty ?? false
	};
}
function createRegistryModelListSourcePlan() {
	return createSourcePlan({
		kind: "registry",
		requiresInitialRegistry: true
	});
}
async function planAllModelListSources(params) {
	if (!(params.enableCascade ?? params.all)) return createRegistryModelListSourcePlan();
	const { loadStaticManifestCatalogRowsForList, loadSupplementalManifestCatalogRowsForList } = await import("./list.manifest-catalog-DUj60TEw.js");
	if (!params.providerFilter) {
		const { loadProviderIndexCatalogRowsForList } = await import("./list.provider-index-catalog-BBk1_WQP.js");
		return createSourcePlan({
			kind: "registry",
			manifestCatalogRows: loadSupplementalManifestCatalogRowsForList({ cfg: params.cfg }),
			providerIndexCatalogRows: loadProviderIndexCatalogRowsForList({ cfg: params.cfg }),
			requiresInitialRegistry: true
		});
	}
	const staticManifestCatalogRows = loadStaticManifestCatalogRowsForList({
		cfg: params.cfg,
		providerFilter: params.providerFilter
	});
	const manifestCatalogRows = staticManifestCatalogRows.length === 0 ? loadSupplementalManifestCatalogRowsForList({
		cfg: params.cfg,
		providerFilter: params.providerFilter
	}) : staticManifestCatalogRows;
	if (manifestCatalogRows.length > 0) {
		if (staticManifestCatalogRows.length === 0) return createSourcePlan({
			kind: "registry",
			manifestCatalogRows,
			requiresInitialRegistry: true
		});
		return createSourcePlan({
			kind: "manifest",
			manifestCatalogRows,
			skipRuntimeModelSuppression: true
		});
	}
	const { loadProviderIndexCatalogRowsForList } = await import("./list.provider-index-catalog-BBk1_WQP.js");
	const providerIndexCatalogRows = loadProviderIndexCatalogRowsForList({
		cfg: params.cfg,
		providerFilter: params.providerFilter
	});
	if (providerIndexCatalogRows.length > 0) return createSourcePlan({
		kind: "provider-index",
		providerIndexCatalogRows,
		skipRuntimeModelSuppression: true
	});
	const { hasProviderStaticCatalogForFilter } = await import("./list.provider-catalog-C8NPIi_p.js");
	if (await hasProviderStaticCatalogForFilter({
		cfg: params.cfg,
		providerFilter: params.providerFilter
	})) return createSourcePlan({
		kind: "provider-runtime-static",
		skipRuntimeModelSuppression: true,
		fallbackToRegistryWhenEmpty: true
	});
	return createSourcePlan({
		kind: "provider-runtime-scoped",
		fallbackToRegistryWhenEmpty: true
	});
}
//#endregion
export { createRegistryModelListSourcePlan, planAllModelListSources };
