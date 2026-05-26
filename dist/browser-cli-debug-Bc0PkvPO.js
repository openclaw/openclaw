import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as danger } from "./globals-YU5FjfZK.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as runCommandWithRuntime } from "./cli-utils-CdDa8OYO.js";
import "./core-api-CznnLkt_.js";
import "./core-api-B5Vt3O83.js";
import { t as callBrowserRequest } from "./browser-cli-shared-BiWbz8Jo.js";
//#region extensions/browser/src/cli/browser-cli-debug.ts
const BROWSER_DEBUG_TIMEOUT_MS = 2e4;
function runBrowserDebug(action) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		defaultRuntime.error(danger(String(err)));
		defaultRuntime.exit(1);
	});
}
async function withDebugContext(cmd, parentOpts, action) {
	const parent = parentOpts(cmd);
	await runBrowserDebug(() => action({
		parent,
		profile: parent.browserProfile
	}));
}
function printJsonResult(parent, result) {
	if (!parent.json) return false;
	defaultRuntime.writeJson(result);
	return true;
}
async function callDebugRequest(parent, params) {
	return callBrowserRequest(parent, params, { timeoutMs: BROWSER_DEBUG_TIMEOUT_MS });
}
function resolveProfileQuery(profile) {
	return profile ? { profile } : void 0;
}
function resolveDebugQuery(params) {
	return {
		targetId: normalizeOptionalString(params.targetId),
		filter: normalizeOptionalString(params.filter),
		clear: Boolean(params.clear),
		profile: params.profile
	};
}
function registerBrowserDebugCommands(browser, parentOpts) {
	browser.command("highlight").description("Highlight an element by ref").argument("<ref>", "Ref id from snapshot").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (ref, opts, cmd) => {
		await withDebugContext(cmd, parentOpts, async ({ parent, profile }) => {
			if (printJsonResult(parent, await callDebugRequest(parent, {
				method: "POST",
				path: "/highlight",
				query: resolveProfileQuery(profile),
				body: {
					ref: ref.trim(),
					targetId: normalizeOptionalString(opts.targetId)
				}
			}))) return;
			defaultRuntime.log(`highlighted ${ref.trim()}`);
		});
	});
	browser.command("errors").description("Get recent page errors").option("--clear", "Clear stored errors after reading", false).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		await withDebugContext(cmd, parentOpts, async ({ parent, profile }) => {
			const result = await callDebugRequest(parent, {
				method: "GET",
				path: "/errors",
				query: resolveDebugQuery({
					targetId: opts.targetId,
					clear: opts.clear,
					profile
				})
			});
			if (printJsonResult(parent, result)) return;
			if (!result.errors.length) {
				defaultRuntime.log("No page errors.");
				return;
			}
			defaultRuntime.log(result.errors.map((e) => `${e.timestamp} ${e.name ? `${e.name}: ` : ""}${e.message}`).join("\n"));
		});
	});
	browser.command("requests").description("Get recent network requests (best-effort)").option("--filter <text>", "Only show URLs that contain this substring").option("--clear", "Clear stored requests after reading", false).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		await withDebugContext(cmd, parentOpts, async ({ parent, profile }) => {
			const result = await callDebugRequest(parent, {
				method: "GET",
				path: "/requests",
				query: resolveDebugQuery({
					targetId: opts.targetId,
					filter: opts.filter,
					clear: opts.clear,
					profile
				})
			});
			if (printJsonResult(parent, result)) return;
			if (!result.requests.length) {
				defaultRuntime.log("No requests recorded.");
				return;
			}
			defaultRuntime.log(result.requests.map((r) => {
				const status = typeof r.status === "number" ? ` ${r.status}` : "";
				const ok = r.ok === true ? " ok" : r.ok === false ? " fail" : "";
				const fail = r.failureText ? ` (${r.failureText})` : "";
				return `${r.timestamp} ${r.method}${status}${ok} ${r.url}${fail}`;
			}).join("\n"));
		});
	});
	const trace = browser.command("trace").description("Record a Playwright trace");
	trace.command("start").description("Start trace recording").option("--target-id <id>", "CDP target id (or unique prefix)").option("--no-screenshots", "Disable screenshots").option("--no-snapshots", "Disable snapshots").option("--sources", "Include sources (bigger traces)", false).action(async (opts, cmd) => {
		await withDebugContext(cmd, parentOpts, async ({ parent, profile }) => {
			if (printJsonResult(parent, await callDebugRequest(parent, {
				method: "POST",
				path: "/trace/start",
				query: resolveProfileQuery(profile),
				body: {
					targetId: normalizeOptionalString(opts.targetId),
					screenshots: Boolean(opts.screenshots),
					snapshots: Boolean(opts.snapshots),
					sources: Boolean(opts.sources)
				}
			}))) return;
			defaultRuntime.log("trace started");
		});
	});
	trace.command("stop").description("Stop trace recording and write a .zip").option("--out <path>", "Output path within openclaw temp dir (e.g. trace.zip or /tmp/openclaw/trace.zip)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		await withDebugContext(cmd, parentOpts, async ({ parent, profile }) => {
			const result = await callDebugRequest(parent, {
				method: "POST",
				path: "/trace/stop",
				query: resolveProfileQuery(profile),
				body: {
					targetId: normalizeOptionalString(opts.targetId),
					path: normalizeOptionalString(opts.out)
				}
			});
			if (printJsonResult(parent, result)) return;
			defaultRuntime.log(`TRACE:${shortenHomePath(result.path)}`);
		});
	});
}
//#endregion
export { registerBrowserDebugCommands };
