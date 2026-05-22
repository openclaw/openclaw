import { dt as sendChannelTyping } from "./discord-DBmLXTjd.js";
import { o as raceWithTimeout } from "./timeouts-LgbAojY8.js";
//#region extensions/discord/src/monitor/typing.ts
const DISCORD_TYPING_START_TIMEOUT_MS = 5e3;
async function sendTyping(params) {
	if ((await raceWithTimeout({
		promise: sendChannelTyping(params.rest, params.channelId).then(() => ({ kind: "sent" })),
		timeoutMs: DISCORD_TYPING_START_TIMEOUT_MS,
		onTimeout: () => ({ kind: "timeout" })
	})).kind === "timeout") throw new Error(`discord typing start timed out after ${DISCORD_TYPING_START_TIMEOUT_MS}ms`);
}
//#endregion
export { sendTyping as t };
