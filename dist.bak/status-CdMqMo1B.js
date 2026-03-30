//#region src/channels/plugins/status.ts
async function buildChannelAccountSnapshot(params) {
	const account = params.plugin.config.resolveAccount(params.cfg, params.accountId);
	if (params.plugin.status?.buildAccountSnapshot) return await params.plugin.status.buildAccountSnapshot({
		account,
		cfg: params.cfg,
		runtime: params.runtime,
		probe: params.probe,
		audit: params.audit
	});
	const enabled = params.plugin.config.isEnabled ? params.plugin.config.isEnabled(account, params.cfg) : account && typeof account === "object" ? account.enabled : void 0;
	const configured = params.plugin.config.isConfigured ? await params.plugin.config.isConfigured(account, params.cfg) : void 0;
	return {
		accountId: params.accountId,
		enabled,
		configured
	};
}

//#endregion
export { buildChannelAccountSnapshot as t };