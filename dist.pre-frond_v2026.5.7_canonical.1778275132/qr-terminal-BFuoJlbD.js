import { t as createLazyImportLoader } from "./lazy-promise-AiZRy56y.js";
//#region src/media/qr-runtime.ts
const qrCodeRuntimeLoader = createLazyImportLoader(() => import("qrcode").then((mod) => mod.default ?? mod));
async function loadQrCodeRuntime() {
	return await qrCodeRuntimeLoader.load();
}
function normalizeQrText(text) {
	if (typeof text !== "string") throw new TypeError("QR text must be a string.");
	if (text.length === 0) throw new Error("QR text must not be empty.");
	return text;
}
//#endregion
//#region src/media/qr-terminal.ts
async function renderQrTerminal(input, opts = {}) {
	return await (await loadQrCodeRuntime()).toString(normalizeQrText(input), {
		small: opts.small ?? true,
		type: "terminal"
	});
}
//#endregion
export { loadQrCodeRuntime as n, normalizeQrText as r, renderQrTerminal as t };
