import { n as channelRouteDedupeKey } from "./channel-route-jaZFObQA.js";
//#region src/infra/approval-native-target-key.ts
function buildChannelApprovalNativeTargetKey(target) {
	return channelRouteDedupeKey({
		to: target.to,
		threadId: target.threadId
	});
}
//#endregion
export { buildChannelApprovalNativeTargetKey as t };
