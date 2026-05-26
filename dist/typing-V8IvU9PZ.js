import { ft as sendChannelTyping } from "./discord-Cn5UmvYW.js";
import { o as raceWithTimeout } from "./timeouts-l_PsHQvX.js";
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
