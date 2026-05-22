//#region src/infra/heartbeat-visibility.ts
const DEFAULT_VISIBILITY = {
	showOk: false,
	showAlerts: true,
	useIndicator: true
};
/**
* Resolve heartbeat visibility settings for a channel.
* Supports both deliverable channels and webchat.
* For webchat, uses channels.defaults.heartbeat since webchat doesn't have per-channel config.
*/
function resolveHeartbeatVisibility(params) {
	const { cfg, channel, accountId } = params;
	if (channel === "webchat") {
		const channelDefaults = cfg.channels?.defaults?.heartbeat;
		return {
			showOk: channelDefaults?.showOk ?? DEFAULT_VISIBILITY.showOk,
			showAlerts: channelDefaults?.showAlerts ?? DEFAULT_VISIBILITY.showAlerts,
			useIndicator: channelDefaults?.useIndicator ?? DEFAULT_VISIBILITY.useIndicator
		};
	}
	const channelDefaults = cfg.channels?.defaults?.heartbeat;
	const channelCfg = cfg.channels?.[channel];
	const perChannel = channelCfg?.heartbeat;
	const perAccount = (accountId ? channelCfg?.accounts?.[accountId] : void 0)?.heartbeat;
	return {
		showOk: perAccount?.showOk ?? perChannel?.showOk ?? channelDefaults?.showOk ?? DEFAULT_VISIBILITY.showOk,
		showAlerts: perAccount?.showAlerts ?? perChannel?.showAlerts ?? channelDefaults?.showAlerts ?? DEFAULT_VISIBILITY.showAlerts,
		useIndicator: perAccount?.useIndicator ?? perChannel?.useIndicator ?? channelDefaults?.useIndicator ?? DEFAULT_VISIBILITY.useIndicator
	};
}
//#endregion
export { resolveHeartbeatVisibility as t };
