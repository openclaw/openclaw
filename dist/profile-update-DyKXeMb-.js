import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { t as getMatrixRuntime } from "./runtime-Bzh7h5rJ.js";
import { n as updateMatrixAccountConfig, t as resolveMatrixConfigPath } from "./config-update-yy_QFIrd.js";
import { a as syncMatrixOwnProfile } from "./profile-BO10xyfU.js";
import { t as withResolvedActionClient } from "./client-CWBVxcE6.js";
//#region extensions/matrix/src/matrix/actions/profile.ts
async function updateMatrixOwnProfile(opts = {}) {
	const displayName = opts.displayName?.trim();
	const avatarUrl = opts.avatarUrl?.trim();
	const avatarPath = opts.avatarPath?.trim();
	const runtime = getMatrixRuntime();
	return await withResolvedActionClient(opts, async (client) => {
		return await syncMatrixOwnProfile({
			client,
			userId: await client.getUserId(),
			displayName: displayName || void 0,
			avatarUrl: avatarUrl || void 0,
			avatarPath: avatarPath || void 0,
			loadAvatarFromUrl: async (url, maxBytes) => await runtime.media.loadWebMedia(url, maxBytes),
			loadAvatarFromPath: async (path, maxBytes) => await runtime.media.loadWebMedia(path, {
				maxBytes,
				localRoots: opts.mediaLocalRoots
			})
		});
	}, "persist");
}
//#endregion
//#region extensions/matrix/src/profile-update.ts
async function applyMatrixProfileUpdate(params) {
	const runtime = getMatrixRuntime();
	const persistedCfg = runtime.config.current();
	const accountId = normalizeAccountId(params.account);
	const displayName = params.displayName?.trim() || null;
	const avatarUrl = params.avatarUrl?.trim() || null;
	const avatarPath = params.avatarPath?.trim() || null;
	if (!displayName && !avatarUrl && !avatarPath) throw new Error("Provide name/displayName and/or avatarUrl/avatarPath.");
	const synced = await updateMatrixOwnProfile({
		cfg: params.cfg,
		accountId,
		displayName: displayName ?? void 0,
		avatarUrl: avatarUrl ?? void 0,
		avatarPath: avatarPath ?? void 0,
		mediaLocalRoots: params.mediaLocalRoots
	});
	const persistedAvatarUrl = synced.uploadedAvatarSource && synced.resolvedAvatarUrl ? synced.resolvedAvatarUrl : avatarUrl;
	const updated = updateMatrixAccountConfig(persistedCfg, accountId, {
		name: displayName ?? void 0,
		avatarUrl: persistedAvatarUrl ?? void 0
	});
	await runtime.config.replaceConfigFile({
		nextConfig: updated,
		afterWrite: { mode: "auto" }
	});
	return {
		accountId,
		displayName,
		avatarUrl: persistedAvatarUrl ?? null,
		profile: {
			displayNameUpdated: synced.displayNameUpdated,
			avatarUpdated: synced.avatarUpdated,
			resolvedAvatarUrl: synced.resolvedAvatarUrl,
			uploadedAvatarSource: synced.uploadedAvatarSource,
			convertedAvatarFromHttp: synced.convertedAvatarFromHttp
		},
		configPath: resolveMatrixConfigPath(updated, accountId)
	};
}
//#endregion
export { updateMatrixOwnProfile as n, applyMatrixProfileUpdate as t };
