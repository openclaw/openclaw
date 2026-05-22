import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { d as withTimeout } from "./fs-safe-DKdSS9ZL.js";
import "./error-runtime-x4GvQhLZ.js";
import "./text-utility-runtime-BBxqlf_T.js";
import { t as MessagingApiClient } from "./messagingApiClient-BlnRYyO-.js";
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
