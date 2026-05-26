import { f as parseConfiguredModelVisibilityEntries } from "./model-selection-shared-ClxdEp4X.js";
async function loadModelCatalogForBrowse(params) {
	if ((params.view ?? "default") === "all") return await params.loadCatalog({ readOnly: false });
	if (parseConfiguredModelVisibilityEntries({ cfg: params.cfg }).providerWildcards.size > 0) return await params.loadCatalog({ readOnly: false });
	let timeout;
	const timeoutMs = params.timeoutMs ?? 750;
	const timedOut = Symbol("model-catalog-browse-timeout");
	const catalogPromise = params.loadCatalog({ readOnly: true });
	const timeoutPromise = new Promise((resolve) => {
		timeout = setTimeout(() => resolve(timedOut), timeoutMs);
		timeout.unref?.();
	});
	try {
		const result = await Promise.race([catalogPromise, timeoutPromise]);
		if (result === timedOut) {
			catalogPromise.catch(() => void 0);
			params.onTimeout?.(timeoutMs);
			return [];
		}
		return result;
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
//#endregion
export { loadModelCatalogForBrowse as t };
