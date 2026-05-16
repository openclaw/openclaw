import { transcribeFirstAudio as transcribeFirstAudio$1 } from "openclaw/plugin-sdk/media-runtime";
//#region extensions/discord/src/monitor/preflight-audio.runtime.ts
async function transcribeFirstAudio(...args) {
	return await transcribeFirstAudio$1(...args);
}
//#endregion
export { transcribeFirstAudio };
