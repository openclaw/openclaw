import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { d as withTimeout } from "./fs-safe-DKdSS9ZL.js";
import "./error-runtime-7Da26TEA.js";
import "./text-utility-runtime-Bx8a2TNS.js";
import { t as MessagingApiClient } from "./messagingApiClient-C1IfwnO2.js";
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
