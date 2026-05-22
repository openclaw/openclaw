import { i as formatErrorMessage } from "./errors-C5Jbj3g5.js";
import { d as withTimeout } from "./fs-safe-D4r8mUJk.js";
import "./error-runtime-Dls4_bTA.js";
import "./text-utility-runtime-CTB88BtI.js";
import { t as MessagingApiClient } from "./messagingApiClient-BZzKd3hC.js";
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
