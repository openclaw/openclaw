import { i as formatErrorMessage } from "./errors-D0hgXIu9.js";
import { d as withTimeout } from "./fs-safe-Cew-WMeL.js";
import "./text-runtime-CEUy8PW0.js";
import "./error-runtime-RR9SPa4x.js";
import { t as MessagingApiClient } from "./messagingApiClient-Cev6ubp4.js";
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
