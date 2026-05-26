import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as danger } from "./globals-YU5FjfZK.js";
import "./core-api-B5Vt3O83.js";
import { n as callBrowserResize } from "./browser-cli-shared-BiWbz8Jo.js";
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
