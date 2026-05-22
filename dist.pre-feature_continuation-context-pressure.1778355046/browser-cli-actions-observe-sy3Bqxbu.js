import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { g as shortenHomePath } from "./utils-D5swhEXt.js";
import { n as defaultRuntime } from "./runtime-bzt9CHmD.js";
import { t as danger } from "./globals-BHVmraBM.js";
import "./text-runtime-FOsx_CPC.js";
import { n as runCommandWithRuntime } from "./cli-utils-Bm4scV9c.js";
import "./core-api-bsk7Qxf_.js";
import "./core-api-DN0y7N7J.js";
import { t as callBrowserRequest } from "./browser-cli-shared-Cd6xRS3_.js";
//#region extensions/browser/src/cli/browser-cli-actions-observe.ts
function runBrowserObserve(action) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		defaultRuntime.error(danger(String(err)));
		defaultRuntime.exit(1);
	});
}
function registerBrowserActionObserveCommands(browser, parentOpts) {
	browser.command("console").description("Get recent console messages").option("--level <level>", "Filter by level (error, warn, info)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserObserve(async () => {
			const result = await callBrowserRequest(parent, {
				method: "GET",
				path: "/console",
				query: {
					level: normalizeOptionalString(opts.level),
					targetId: normalizeOptionalString(opts.targetId),
					profile
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			defaultRuntime.writeJson(result.messages);
		});
	});
	browser.command("pdf").description("Save page as PDF").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserObserve(async () => {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/pdf",
				query: profile ? { profile } : void 0,
				body: { targetId: normalizeOptionalString(opts.targetId) }
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			defaultRuntime.log(`PDF: ${shortenHomePath(result.path)}`);
		});
	});
	browser.command("responsebody").description("Wait for a network response and return its body").argument("<url>", "URL (exact, substring, or glob like **/api)").option("--target-id <id>", "CDP target id (or unique prefix)").option("--timeout-ms <ms>", "How long to wait for the response (default: 20000)", (v) => Number(v)).option("--max-chars <n>", "Max body chars to return (default: 200000)", (v) => Number(v)).action(async (url, opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserObserve(async () => {
			const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : void 0;
			const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : void 0;
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/response/body",
				query: profile ? { profile } : void 0,
				body: {
					url,
					targetId: normalizeOptionalString(opts.targetId),
					timeoutMs,
					maxChars
				}
			}, { timeoutMs: timeoutMs ?? 2e4 });
			if (parent?.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			defaultRuntime.log(result.response.body);
		});
	});
}
//#endregion
export { registerBrowserActionObserveCommands };
