import { x as inspectReadOnlyChannelAccount } from "./plugins-DC9n978g.js";
import { i as projectSafeChannelAccountSnapshotFields } from "./account-snapshot-fields-B_ffWpeH.js";
//#region src/channels/plugins/status.ts
async function buildSnapshotFromAccount(params) {
	if (params.plugin.status?.buildAccountSnapshot) return await params.plugin.status.buildAccountSnapshot({
		account: params.account,
		cfg: params.cfg,
		runtime: params.runtime,
		probe: params.probe,
		audit: params.audit
	});
	const enabled = params.plugin.config.isEnabled ? params.plugin.config.isEnabled(params.account, params.cfg) : params.account && typeof params.account === "object" ? params.account.enabled : void 0;
	const configured = params.account && typeof params.account === "object" && "configured" in params.account ? params.account.configured : params.plugin.config.isConfigured ? await params.plugin.config.isConfigured(params.account, params.cfg) : void 0;
	return {
		accountId: params.accountId,
		enabled,
		configured,
		...projectSafeChannelAccountSnapshotFields(params.account)
	};
}
async function inspectChannelAccount(params) {
	return params.plugin.config.inspectAccount?.(params.cfg, params.accountId) ?? await inspectReadOnlyChannelAccount({
		channelId: params.plugin.id,
		cfg: params.cfg,
		accountId: params.accountId
	});
}
async function buildReadOnlySourceChannelAccountSnapshot(params) {
	const inspectedAccount = await inspectChannelAccount(params);
	if (!inspectedAccount) return null;
	return await buildSnapshotFromAccount({
		...params,
		account: inspectedAccount
	});
}
async function buildChannelAccountSnapshot(params) {
	const account = await inspectChannelAccount(params) ?? params.plugin.config.resolveAccount(params.cfg, params.accountId);
	return await buildSnapshotFromAccount({
		...params,
		account
	});
}
//#endregion
export { buildReadOnlySourceChannelAccountSnapshot as n, buildChannelAccountSnapshot as t };
