import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { r as listAvailableManifestContractPlugins, t as hasManifestContractValue } from "./manifest-contract-eligibility-LkT7g78Y.js";
//#region src/plugins/manifest-contract-runtime.ts
const DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS = { preferPersisted: false };
function resolveManifestContractRuntimePluginResolution(params) {
	const snapshot = loadPluginMetadataSnapshot({
		config: params.cfg ?? {},
		env: process.env,
		...DEMAND_ONLY_CONTRACT_LOOKUP_OPTIONS
	});
	const allContractPlugins = snapshot.plugins.filter((plugin) => hasManifestContractValue({
		plugin,
		contract: params.contract,
		value: params.value
	}));
	const bundledCompatPluginIds = allContractPlugins.filter((plugin) => plugin.origin === "bundled").map((plugin) => plugin.id);
	const pluginIds = listAvailableManifestContractPlugins({
		snapshot: {
			index: snapshot.index,
			plugins: allContractPlugins
		},
		contract: params.contract,
		value: params.value,
		config: params.cfg
	}).map((plugin) => plugin.id);
	return {
		pluginIds: [...new Set(pluginIds)].toSorted((left, right) => left.localeCompare(right)),
		bundledCompatPluginIds: [...new Set(bundledCompatPluginIds)].toSorted((left, right) => left.localeCompare(right))
	};
}
//#endregion
export { resolveManifestContractRuntimePluginResolution as t };
