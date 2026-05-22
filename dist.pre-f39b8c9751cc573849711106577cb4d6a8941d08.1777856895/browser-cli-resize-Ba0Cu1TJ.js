import { n as defaultRuntime } from "./runtime-Dv8n03pi.js";
import { t as danger } from "./globals-Dn_zSD2h.js";
import "./core-api-sOv6V2W2.js";
import { n as callBrowserResize } from "./browser-cli-shared-BXHABBYU.js";
//#region extensions/browser/src/cli/browser-cli-resize.ts
async function runBrowserResizeWithOutput(params) {
	const { width, height } = params;
	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		defaultRuntime.error(danger("width and height must be numbers"));
		defaultRuntime.exit(1);
		return;
	}
	const result = await callBrowserResize(params.parent, {
		profile: params.profile,
		width,
		height,
		targetId: params.targetId
	}, { timeoutMs: params.timeoutMs ?? 2e4 });
	if (params.parent?.json) {
		defaultRuntime.writeJson(result);
		return;
	}
	defaultRuntime.log(params.successMessage);
}
//#endregion
export { runBrowserResizeWithOutput as t };
