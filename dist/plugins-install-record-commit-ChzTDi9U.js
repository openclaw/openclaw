import { t as loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader-BieSpyRG.js";
import { o as withoutPluginInstallRecords, s as writePersistedInstalledPluginIndexInstallRecords, t as PLUGIN_INSTALLS_CONFIG_PATH } from "./installed-plugin-index-records-CXoaBLTL.js";
import { r as replaceConfigFile } from "./mutate-FhI2HIyp.js";
import "./config-CzeRK-GW.js";
import { isDeepStrictEqual } from "node:util";
//#region src/cli/plugins-install-record-commit.ts
function mergeUnsetPaths(left, right) {
	const merged = [...left ?? [], ...right ?? []];
	return merged.length > 0 ? merged : void 0;
}
const PLUGIN_SOURCE_CHANGED_RESTART_REASON = "plugin source changed";
async function commitPluginInstallRecordsWithWriter(params) {
	const previousInstallRecords = params.previousInstallRecords ?? await loadInstalledPluginIndexInstallRecords();
	await writePersistedInstalledPluginIndexInstallRecords(params.nextInstallRecords);
	try {
		const installRecordsChanged = !isDeepStrictEqual(previousInstallRecords, params.nextInstallRecords);
		await params.commit(params.nextConfig, {
			...params.writeOptions,
			...installRecordsChanged && params.writeOptions?.afterWrite === void 0 ? { afterWrite: {
				mode: "restart",
				reason: PLUGIN_SOURCE_CHANGED_RESTART_REASON
			} } : {},
			unsetPaths: mergeUnsetPaths(params.writeOptions?.unsetPaths, [Array.from(PLUGIN_INSTALLS_CONFIG_PATH)])
		});
	} catch (error) {
		try {
			await writePersistedInstalledPluginIndexInstallRecords(previousInstallRecords);
		} catch (rollbackError) {
			throw new Error("Failed to commit plugin install records and could not restore the previous plugin index", { cause: rollbackError });
		}
		throw error;
	}
}
async function commitPluginInstallRecordsWithConfig(params) {
	await commitPluginInstallRecordsWithWriter({
		...params,
		commit: async (nextConfig, writeOptions) => {
			await replaceConfigFile({
				nextConfig,
				...params.baseHash !== void 0 ? { baseHash: params.baseHash } : {},
				...writeOptions ? { writeOptions } : {}
			});
		}
	});
}
async function commitConfigWriteWithPendingPluginInstalls(params) {
	const pendingInstallRecords = params.nextConfig.plugins?.installs ?? {};
	if (Object.keys(pendingInstallRecords).length === 0) {
		if (params.writeOptions) await params.commit(params.nextConfig, params.writeOptions);
		else await params.commit(params.nextConfig);
		return {
			config: params.nextConfig,
			installRecords: {},
			movedInstallRecords: false
		};
	}
	const previousInstallRecords = await loadInstalledPluginIndexInstallRecords();
	const nextInstallRecords = {
		...previousInstallRecords,
		...pendingInstallRecords
	};
	const strippedConfig = withoutPluginInstallRecords(params.nextConfig);
	await commitPluginInstallRecordsWithWriter({
		previousInstallRecords,
		nextInstallRecords,
		nextConfig: strippedConfig,
		...params.writeOptions ? { writeOptions: params.writeOptions } : {},
		commit: params.commit
	});
	return {
		config: strippedConfig,
		installRecords: nextInstallRecords,
		movedInstallRecords: true
	};
}
async function commitConfigWithPendingPluginInstalls(params) {
	return await commitConfigWriteWithPendingPluginInstalls({
		nextConfig: params.nextConfig,
		...params.writeOptions ? { writeOptions: params.writeOptions } : {},
		commit: async (nextConfig, writeOptions) => {
			await replaceConfigFile({
				nextConfig,
				...params.baseHash !== void 0 ? { baseHash: params.baseHash } : {},
				...writeOptions ? { writeOptions } : {}
			});
		}
	});
}
//#endregion
export { commitConfigWriteWithPendingPluginInstalls as n, commitPluginInstallRecordsWithConfig as r, commitConfigWithPendingPluginInstalls as t };
