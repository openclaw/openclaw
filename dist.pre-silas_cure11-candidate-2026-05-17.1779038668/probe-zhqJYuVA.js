import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { d as withTimeout } from "./fs-safe-D4r8mUJk.js";
import "./error-runtime-C2O_0klE.js";
import "./text-utility-runtime-Bq-DXGZB.js";
import { t as MessagingApiClient } from "./messagingApiClient-B5ZzbSMb.js";
//#region extensions/line/src/probe.ts
async function probeLineBot(channelAccessToken, timeoutMs = 5e3) {
	if (!channelAccessToken?.trim()) return {
		ok: false,
		error: "Channel access token not configured"
	};
	const client = new MessagingApiClient({ channelAccessToken: channelAccessToken.trim() });
	try {
		const profile = await withTimeout(client.getBotInfo(), timeoutMs);
		return {
			ok: true,
			bot: {
				displayName: profile.displayName,
				userId: profile.userId,
				basicId: profile.basicId,
				pictureUrl: profile.pictureUrl
			}
		};
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
		};
	}
}
//#endregion
export { probeLineBot as t };
