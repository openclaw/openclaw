import { n as detectMime } from "./mime-DXu61ldU.js";
//#region src/media/sniff-mime-from-base64.ts
async function sniffMimeFromBase64(base64) {
	const trimmed = base64.trim();
	if (!trimmed) return;
	const take = Math.min(256, trimmed.length);
	const sliceLen = take - take % 4;
	if (sliceLen < 8) return;
	try {
		return await detectMime({ buffer: Buffer.from(trimmed.slice(0, sliceLen), "base64") });
	} catch {
		return;
	}
}
//#endregion
export { sniffMimeFromBase64 as t };
