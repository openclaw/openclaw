import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as projectSafeChannelAccountSnapshotFields } from "./account-snapshot-fields-YzCGlwrq.js";
import { t as inspectChannelAccount } from "./account-inspection-VwCoDQfw.js";
//#region src/channels/plugins/status.ts
async function buildChannelAccountSnapshotFromAccount(params) {
	let snapshot;
	if (params.plugin.status?.buildAccountSnapshot) snapshot = await params.plugin.status.buildAccountSnapshot({
		account: params.account,
		cfg: params.cfg,
		runtime: params.runtime,
		probe: params.probe,
		audit: params.audit
	});
	else {
		const enabled = params.plugin.config.isEnabled ? params.plugin.config.isEnabled(params.account, params.cfg) : params.account && typeof params.account === "object" ? params.account.enabled : void 0;
		const configured = params.account && typeof params.account === "object" && "configured" in params.account ? params.account.configured : params.plugin.config.isConfigured ? await params.plugin.config.isConfigured(params.account, params.cfg) : void 0;
		snapshot = {
			accountId: params.accountId,
			enabled,
			configured,
			...projectSafeChannelAccountSnapshotFields(params.account),
			...projectSafeChannelAccountSnapshotFields(params.runtime)
		};
	}
	return {
		...snapshot,
		accountId: normalizeOptionalString(snapshot.accountId) ? snapshot.accountId : params.accountId,
		enabled: snapshot.enabled ?? params.enabledFallback,
		configured: snapshot.configured ?? params.configuredFallback,
		...params.probe !== void 0 && snapshot.probe === void 0 ? { probe: params.probe } : {}
	};
}
async function buildReadOnlySourceChannelAccountSnapshot(params) {
	const inspectedAccount = await inspectChannelAccount(params);
	if (!inspectedAccount) return null;
	return await buildChannelAccountSnapshotFromAccount({
		...params,
		account: inspectedAccount
	});
}
async function buildChannelAccountSnapshot(params) {
	const account = await inspectChannelAccount(params) ?? params.plugin.config.resolveAccount(params.cfg, params.accountId);
	return await buildChannelAccountSnapshotFromAccount({
		...params,
		account
	});
}
//#endregion
export { buildChannelAccountSnapshotFromAccount as n, buildReadOnlySourceChannelAccountSnapshot as r, buildChannelAccountSnapshot as t };
