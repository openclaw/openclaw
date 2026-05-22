import { n as defaultRuntime } from "./runtime-CFpTi2zA.js";
import { t as danger } from "./globals-Byqe4NlR.js";
import "./core-api-DWVJnb9F.js";
import { n as callBrowserResize } from "./browser-cli-shared-uybdOldn.js";
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
