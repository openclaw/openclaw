import { t as loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { o as withoutPluginInstallRecords, s as writePersistedInstalledPluginIndexInstallRecords, t as PLUGIN_INSTALLS_CONFIG_PATH } from "./installed-plugin-index-records-BrXfmg6n.js";
import { p as resolveConfigWriteAfterWrite } from "./runtime-snapshot-DgdkBEdP.js";
import { i as replaceConfigFile, o as transformConfigFileWithRetry } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { isDeepStrictEqual } from "node:util";
//#region src/cli/plugins-install-record-commit.ts
function mergeUnsetPaths(left, right) {
	const merged = [...left ?? [], ...right ?? []];
	return merged.length > 0 ? merged : void 0;
}
const PLUGIN_SOURCE_CHANGED_RESTART_REASON = "plugin source changed";
function mergeAfterWrite(writeOptions, afterWrite) {
	if (afterWrite === void 0) return writeOptions;
	return {
		...writeOptions,
		afterWrite
	};
}
async function commitPluginInstallRecordsWithWriter(params) {
	const previousInstallRecords = params.previousInstallRecords ?? await loadInstalledPluginIndexInstallRecords();
	await writePersistedInstalledPluginIndexInstallRecords(params.nextInstallRecords);
	try {
		const installRecordsChanged = !isDeepStrictEqual(previousInstallRecords, params.nextInstallRecords);
		return await params.commit(params.nextConfig, {
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
			return await replaceConfigFile({
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
		const committed = params.writeOptions ? await params.commit(params.nextConfig, params.writeOptions) : await params.commit(params.nextConfig);
		return {
			config: params.nextConfig,
			installRecords: {},
			movedInstallRecords: false,
			persistedHash: committed?.persistedHash ?? null
		};
	}
	const previousInstallRecords = await loadInstalledPluginIndexInstallRecords();
	const nextInstallRecords = {
		...previousInstallRecords,
		...pendingInstallRecords
	};
	const strippedConfig = withoutPluginInstallRecords(params.nextConfig);
	return {
		config: strippedConfig,
		installRecords: nextInstallRecords,
		movedInstallRecords: true,
		persistedHash: (await commitPluginInstallRecordsWithWriter({
			previousInstallRecords,
			nextInstallRecords,
			nextConfig: strippedConfig,
			...params.writeOptions ? { writeOptions: params.writeOptions } : {},
			commit: params.commit
		}))?.persistedHash ?? null
	};
}
async function commitConfigWithPendingPluginInstalls(params) {
	return await commitConfigWriteWithPendingPluginInstalls({
		nextConfig: params.nextConfig,
		...params.writeOptions ? { writeOptions: params.writeOptions } : {},
		commit: async (nextConfig, writeOptions) => {
			return await replaceConfigFile({
				nextConfig,
				...params.baseHash !== void 0 ? { baseHash: params.baseHash } : {},
				...writeOptions ? { writeOptions } : {}
			});
		}
	});
}
async function transformConfigWithPendingPluginInstalls(params) {
	const commit = async ({ nextConfig, snapshot, baseHash, writeOptions }) => {
		const requestedAfterWrite = params.afterWrite ?? params.writeOptions?.afterWrite;
		const committed = await commitConfigWriteWithPendingPluginInstalls({
			nextConfig,
			...writeOptions ? { writeOptions: mergeAfterWrite(writeOptions, params.afterWrite) } : {},
			commit: async (config, commitWriteOptions) => {
				return await replaceConfigFile({
					nextConfig: config,
					snapshot,
					writeOptions: commitWriteOptions ?? {},
					...baseHash !== void 0 ? { baseHash } : {}
				});
			}
		});
		const afterWrite = resolveConfigWriteAfterWrite(requestedAfterWrite ?? (committed.movedInstallRecords ? {
			mode: "restart",
			reason: PLUGIN_SOURCE_CHANGED_RESTART_REASON
		} : void 0));
		return {
			config: committed.config,
			persistedHash: committed.persistedHash,
			afterWrite
		};
	};
	return await transformConfigFileWithRetry({
		...params,
		commit
	});
}
//#endregion
export { transformConfigWithPendingPluginInstalls as i, commitConfigWriteWithPendingPluginInstalls as n, commitPluginInstallRecordsWithConfig as r, commitConfigWithPendingPluginInstalls as t };
