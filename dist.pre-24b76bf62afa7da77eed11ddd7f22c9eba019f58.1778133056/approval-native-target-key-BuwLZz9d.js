import { n as channelRouteDedupeKey } from "./channel-route-DT81F24Z.js";
//#region src/infra/approval-native-target-key.ts
function buildChannelApprovalNativeTargetKey(target) {
	return channelRouteDedupeKey({
		to: target.to,
		threadId: target.threadId
	});
}
//#endregion
export { buildChannelApprovalNativeTargetKey as t };
