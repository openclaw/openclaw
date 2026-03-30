import { g as resolveStateDir } from "./paths-B4BZAPZh.js";
import { B as theme, O as danger, S as shortenHomePath, k as info } from "./utils-BKDT474X.js";
import "./agent-scope-D8K2SjR7.js";
import { f as defaultRuntime } from "./subsystem-LTWJBEIv.js";
import "./openclaw-root-PhSD0wUu.js";
import "./exec-NrPPwdAe.js";
import { zt as loadConfig } from "./model-selection-DILdVnl8.js";
import "./github-copilot-token-nncItI8D.js";
import { t as formatCliCommand } from "./command-format-ChfKqObn.js";
import { t as parseBooleanValue } from "./boolean-Wzu0-e0P.js";
import "./env-BqIeOdP-.js";
import "./host-env-security-lcjXF83D.js";
import "./env-vars-Duxu9t5m.js";
import "./manifest-registry-BvFf4Q1K.js";
import "./message-channel-C0KMGsnJ.js";
import "./ip-DK-vcRii.js";
import "./tailnet-kbXXH7kK.js";
import "./ws-zZ6eXqMi.js";
import "./path-alias-guards-DkmbVRdv.js";
import { c as normalizeBrowserFormField, i as resolveExistingPathsWithinRoot, l as normalizeBrowserFormFieldValue, r as DEFAULT_UPLOAD_DIR } from "./paths-s0KCOZny.js";
import "./redact-B76y7XVG.js";
import "./errors-8IxbaLwV.js";
import "./fs-safe-BlxN6w_j.js";
import { t as movePathToTrash } from "./trash-B8xEzWgw.js";
import "./client-xAUDLDK2.js";
import "./call-BP56BqJF.js";
import "./pairing-token-BdLe8Jtz.js";
import { t as formatDocsLink } from "./links-_OmPhBsv.js";
import { n as runCommandWithRuntime } from "./cli-utils-CzIyxbam.js";
import { t as formatHelpExamples } from "./help-format-CWJQePOA.js";
import "./progress-_rXhKU7V.js";
import { n as inheritOptionFromParent } from "./command-options-Duxj7LwL.js";
import { n as callGatewayFromCli, t as addGatewayClientOptions } from "./gateway-rpc-BzwyTRcj.js";
import { t as copyToClipboard } from "./clipboard-CtzJYalR.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

//#region src/cli/browser-cli-shared.ts
function normalizeQuery(query) {
	if (!query) return;
	const out = {};
	for (const [key, value] of Object.entries(query)) {
		if (value === void 0) continue;
		out[key] = String(value);
	}
	return Object.keys(out).length ? out : void 0;
}
async function callBrowserRequest(opts, params, extra) {
	const resolvedTimeoutMs = typeof extra?.timeoutMs === "number" && Number.isFinite(extra.timeoutMs) ? Math.max(1, Math.floor(extra.timeoutMs)) : typeof opts.timeout === "string" ? Number.parseInt(opts.timeout, 10) : void 0;
	const resolvedTimeout = typeof resolvedTimeoutMs === "number" && Number.isFinite(resolvedTimeoutMs) ? resolvedTimeoutMs : void 0;
	const timeout = typeof resolvedTimeout === "number" ? String(resolvedTimeout) : opts.timeout;
	const payload = await callGatewayFromCli("browser.request", {
		...opts,
		timeout
	}, {
		method: params.method,
		path: params.path,
		query: normalizeQuery(params.query),
		body: params.body,
		timeoutMs: resolvedTimeout
	}, { progress: extra?.progress });
	if (payload === void 0) throw new Error("Unexpected browser.request response");
	return payload;
}
async function callBrowserResize(opts, params, extra) {
	return callBrowserRequest(opts, {
		method: "POST",
		path: "/act",
		query: params.profile ? { profile: params.profile } : void 0,
		body: {
			kind: "resize",
			width: params.width,
			height: params.height,
			targetId: params.targetId?.trim() || void 0
		}
	}, extra);
}

//#endregion
//#region src/cli/browser-cli-actions-input/shared.ts
function resolveBrowserActionContext(cmd, parentOpts) {
	const parent = parentOpts(cmd);
	return {
		parent,
		profile: parent?.browserProfile
	};
}
async function callBrowserAct(params) {
	return await callBrowserRequest(params.parent, {
		method: "POST",
		path: "/act",
		query: params.profile ? { profile: params.profile } : void 0,
		body: params.body
	}, { timeoutMs: params.timeoutMs ?? 2e4 });
}
function requireRef(ref) {
	const refValue = typeof ref === "string" ? ref.trim() : "";
	if (!refValue) {
		defaultRuntime.error(danger("ref is required"));
		defaultRuntime.exit(1);
		return null;
	}
	return refValue;
}
async function readFile(path) {
	return await (await import("node:fs/promises")).readFile(path, "utf8");
}
async function readFields(opts) {
	const payload = opts.fieldsFile ? await readFile(opts.fieldsFile) : opts.fields ?? "";
	if (!payload.trim()) throw new Error("fields are required");
	const parsed = JSON.parse(payload);
	if (!Array.isArray(parsed)) throw new Error("fields must be an array");
	return parsed.map((entry, index) => {
		if (!entry || typeof entry !== "object") throw new Error(`fields[${index}] must be an object`);
		const rec = entry;
		const parsedField = normalizeBrowserFormField(rec);
		if (!parsedField) throw new Error(`fields[${index}] must include ref`);
		if (rec.value === void 0 || rec.value === null || normalizeBrowserFormFieldValue(rec.value) !== void 0) return parsedField;
		throw new Error(`fields[${index}].value must be string, number, boolean, or null`);
	});
}

//#endregion
//#region src/cli/browser-cli-actions-input/register.element.ts
function registerBrowserElementCommands(browser, parentOpts) {
	browser.command("click").description("Click an element by ref from snapshot").argument("<ref>", "Ref id from snapshot").option("--target-id <id>", "CDP target id (or unique prefix)").option("--double", "Double click", false).option("--button <left|right|middle>", "Mouse button to use").option("--modifiers <list>", "Comma-separated modifiers (Shift,Alt,Meta)").action(async (ref, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		const refValue = requireRef(ref);
		if (!refValue) return;
		const modifiers = opts.modifiers ? String(opts.modifiers).split(",").map((v) => v.trim()).filter(Boolean) : void 0;
		try {
			const result = await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "click",
					ref: refValue,
					targetId: opts.targetId?.trim() || void 0,
					doubleClick: Boolean(opts.double),
					button: opts.button?.trim() || void 0,
					modifiers
				}
			});
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			const suffix = result.url ? ` on ${result.url}` : "";
			defaultRuntime.log(`clicked ref ${refValue}${suffix}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("type").description("Type into an element by ref from snapshot").argument("<ref>", "Ref id from snapshot").argument("<text>", "Text to type").option("--submit", "Press Enter after typing", false).option("--slowly", "Type slowly (human-like)", false).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (ref, text, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		const refValue = requireRef(ref);
		if (!refValue) return;
		try {
			const result = await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "type",
					ref: refValue,
					text,
					submit: Boolean(opts.submit),
					slowly: Boolean(opts.slowly),
					targetId: opts.targetId?.trim() || void 0
				}
			});
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`typed into ref ${refValue}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("press").description("Press a key").argument("<key>", "Key to press (e.g. Enter)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (key, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const result = await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "press",
					key,
					targetId: opts.targetId?.trim() || void 0
				}
			});
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`pressed ${key}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("hover").description("Hover an element by ai ref").argument("<ref>", "Ref id from snapshot").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (ref, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const result = await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "hover",
					ref,
					targetId: opts.targetId?.trim() || void 0
				}
			});
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`hovered ref ${ref}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("scrollintoview").description("Scroll an element into view by ref from snapshot").argument("<ref>", "Ref id from snapshot").option("--target-id <id>", "CDP target id (or unique prefix)").option("--timeout-ms <ms>", "How long to wait for scroll (default: 20000)", (v) => Number(v)).action(async (ref, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		const refValue = requireRef(ref);
		if (!refValue) return;
		try {
			const result = await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "scrollIntoView",
					ref: refValue,
					targetId: opts.targetId?.trim() || void 0,
					timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : void 0
				},
				timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : void 0
			});
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`scrolled into view: ${refValue}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("drag").description("Drag from one ref to another").argument("<startRef>", "Start ref id").argument("<endRef>", "End ref id").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (startRef, endRef, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const result = await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "drag",
					startRef,
					endRef,
					targetId: opts.targetId?.trim() || void 0
				}
			});
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`dragged ${startRef} → ${endRef}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("select").description("Select option(s) in a select element").argument("<ref>", "Ref id from snapshot").argument("<values...>", "Option values to select").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (ref, values, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const result = await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "select",
					ref,
					values,
					targetId: opts.targetId?.trim() || void 0
				}
			});
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`selected ${values.join(", ")}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}

//#endregion
//#region src/cli/browser-cli-actions-input/register.files-downloads.ts
async function normalizeUploadPaths(paths) {
	const result = await resolveExistingPathsWithinRoot({
		rootDir: DEFAULT_UPLOAD_DIR,
		requestedPaths: paths,
		scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`
	});
	if (!result.ok) throw new Error(result.error);
	return result.paths;
}
function registerBrowserFilesAndDownloadsCommands(browser, parentOpts) {
	const resolveTimeoutAndTarget = (opts) => {
		return {
			timeoutMs: Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : void 0,
			targetId: typeof opts.targetId === "string" ? opts.targetId.trim() || void 0 : void 0
		};
	};
	const runDownloadCommand = async (cmd, opts, request) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const { timeoutMs, targetId } = resolveTimeoutAndTarget(opts);
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: request.path,
				query: profile ? { profile } : void 0,
				body: {
					...request.body,
					targetId,
					timeoutMs
				}
			}, { timeoutMs: timeoutMs ?? 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`downloaded: ${shortenHomePath(result.download.path)}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	};
	browser.command("upload").description("Arm file upload for the next file chooser").argument("<paths...>", "File paths to upload (must be within OpenClaw temp uploads dir, e.g. /tmp/openclaw/uploads/file.pdf)").option("--ref <ref>", "Ref id from snapshot to click after arming").option("--input-ref <ref>", "Ref id for <input type=file> to set directly").option("--element <selector>", "CSS selector for <input type=file>").option("--target-id <id>", "CDP target id (or unique prefix)").option("--timeout-ms <ms>", "How long to wait for the next file chooser (default: 120000)", (v) => Number(v)).action(async (paths, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const normalizedPaths = await normalizeUploadPaths(paths);
			const { timeoutMs, targetId } = resolveTimeoutAndTarget(opts);
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/hooks/file-chooser",
				query: profile ? { profile } : void 0,
				body: {
					paths: normalizedPaths,
					ref: opts.ref?.trim() || void 0,
					inputRef: opts.inputRef?.trim() || void 0,
					element: opts.element?.trim() || void 0,
					targetId,
					timeoutMs
				}
			}, { timeoutMs: timeoutMs ?? 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`upload armed for ${paths.length} file(s)`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("waitfordownload").description("Wait for the next download (and save it)").argument("[path]", "Save path within openclaw temp downloads dir (default: /tmp/openclaw/downloads/...; fallback: os.tmpdir()/openclaw/downloads/...)").option("--target-id <id>", "CDP target id (or unique prefix)").option("--timeout-ms <ms>", "How long to wait for the next download (default: 120000)", (v) => Number(v)).action(async (outPath, opts, cmd) => {
		await runDownloadCommand(cmd, opts, {
			path: "/wait/download",
			body: { path: outPath?.trim() || void 0 }
		});
	});
	browser.command("download").description("Click a ref and save the resulting download").argument("<ref>", "Ref id from snapshot to click").argument("<path>", "Save path within openclaw temp downloads dir (e.g. report.pdf or /tmp/openclaw/downloads/report.pdf)").option("--target-id <id>", "CDP target id (or unique prefix)").option("--timeout-ms <ms>", "How long to wait for the download to start (default: 120000)", (v) => Number(v)).action(async (ref, outPath, opts, cmd) => {
		await runDownloadCommand(cmd, opts, {
			path: "/download",
			body: {
				ref,
				path: outPath
			}
		});
	});
	browser.command("dialog").description("Arm the next modal dialog (alert/confirm/prompt)").option("--accept", "Accept the dialog", false).option("--dismiss", "Dismiss the dialog", false).option("--prompt <text>", "Prompt response text").option("--target-id <id>", "CDP target id (or unique prefix)").option("--timeout-ms <ms>", "How long to wait for the next dialog (default: 120000)", (v) => Number(v)).action(async (opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		const accept = opts.accept ? true : opts.dismiss ? false : void 0;
		if (accept === void 0) {
			defaultRuntime.error(danger("Specify --accept or --dismiss"));
			defaultRuntime.exit(1);
			return;
		}
		try {
			const { timeoutMs, targetId } = resolveTimeoutAndTarget(opts);
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/hooks/dialog",
				query: profile ? { profile } : void 0,
				body: {
					accept,
					promptText: opts.prompt?.trim() || void 0,
					targetId,
					timeoutMs
				}
			}, { timeoutMs: timeoutMs ?? 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log("dialog armed");
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}

//#endregion
//#region src/cli/browser-cli-actions-input/register.form-wait-eval.ts
function registerBrowserFormWaitEvalCommands(browser, parentOpts) {
	browser.command("fill").description("Fill a form with JSON field descriptors").option("--fields <json>", "JSON array of field objects").option("--fields-file <path>", "Read JSON array from a file").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const fields = await readFields({
				fields: opts.fields,
				fieldsFile: opts.fieldsFile
			});
			const result = await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "fill",
					fields,
					targetId: opts.targetId?.trim() || void 0
				}
			});
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`filled ${fields.length} field(s)`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("wait").description("Wait for time, selector, URL, load state, or JS conditions").argument("[selector]", "CSS selector to wait for (visible)").option("--time <ms>", "Wait for N milliseconds", (v) => Number(v)).option("--text <value>", "Wait for text to appear").option("--text-gone <value>", "Wait for text to disappear").option("--url <pattern>", "Wait for URL (supports globs like **/dash)").option("--load <load|domcontentloaded|networkidle>", "Wait for load state").option("--fn <js>", "Wait for JS condition (passed to waitForFunction)").option("--timeout-ms <ms>", "How long to wait for each condition (default: 20000)", (v) => Number(v)).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (selector, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const sel = selector?.trim() || void 0;
			const load = opts.load === "load" || opts.load === "domcontentloaded" || opts.load === "networkidle" ? opts.load : void 0;
			const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : void 0;
			const result = await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "wait",
					timeMs: Number.isFinite(opts.time) ? opts.time : void 0,
					text: opts.text?.trim() || void 0,
					textGone: opts.textGone?.trim() || void 0,
					selector: sel,
					url: opts.url?.trim() || void 0,
					loadState: load,
					fn: opts.fn?.trim() || void 0,
					targetId: opts.targetId?.trim() || void 0,
					timeoutMs
				},
				timeoutMs
			});
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log("wait complete");
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("evaluate").description("Evaluate a function against the page or a ref").option("--fn <code>", "Function source, e.g. (el) => el.textContent").option("--ref <id>", "Ref from snapshot").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		if (!opts.fn) {
			defaultRuntime.error(danger("Missing --fn"));
			defaultRuntime.exit(1);
			return;
		}
		try {
			const result = await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "evaluate",
					fn: opts.fn,
					ref: opts.ref?.trim() || void 0,
					targetId: opts.targetId?.trim() || void 0
				}
			});
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(JSON.stringify(result.result ?? null, null, 2));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}

//#endregion
//#region src/cli/browser-cli-resize.ts
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
		defaultRuntime.log(JSON.stringify(result, null, 2));
		return;
	}
	defaultRuntime.log(params.successMessage);
}

//#endregion
//#region src/cli/browser-cli-actions-input/register.navigation.ts
function registerBrowserNavigationCommands(browser, parentOpts) {
	browser.command("navigate").description("Navigate the current tab to a URL").argument("<url>", "URL to navigate to").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (url, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/navigate",
				query: profile ? { profile } : void 0,
				body: {
					url,
					targetId: opts.targetId?.trim() || void 0
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`navigated to ${result.url ?? url}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("resize").description("Resize the viewport").argument("<width>", "Viewport width", (v) => Number(v)).argument("<height>", "Viewport height", (v) => Number(v)).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (width, height, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			await runBrowserResizeWithOutput({
				parent,
				profile,
				width,
				height,
				targetId: opts.targetId,
				timeoutMs: 2e4,
				successMessage: `resized to ${width}x${height}`
			});
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}

//#endregion
//#region src/cli/browser-cli-actions-input/register.ts
function registerBrowserActionInputCommands(browser, parentOpts) {
	registerBrowserNavigationCommands(browser, parentOpts);
	registerBrowserElementCommands(browser, parentOpts);
	registerBrowserFilesAndDownloadsCommands(browser, parentOpts);
	registerBrowserFormWaitEvalCommands(browser, parentOpts);
}

//#endregion
//#region src/cli/browser-cli-actions-observe.ts
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
					level: opts.level?.trim() || void 0,
					targetId: opts.targetId?.trim() || void 0,
					profile
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(JSON.stringify(result.messages, null, 2));
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
				body: { targetId: opts.targetId?.trim() || void 0 }
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
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
					targetId: opts.targetId?.trim() || void 0,
					timeoutMs,
					maxChars
				}
			}, { timeoutMs: timeoutMs ?? 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(result.response.body);
		});
	});
}

//#endregion
//#region src/cli/browser-cli-debug.ts
function runBrowserDebug(action) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		defaultRuntime.error(danger(String(err)));
		defaultRuntime.exit(1);
	});
}
function resolveDebugQuery(params) {
	return {
		targetId: typeof params.targetId === "string" ? params.targetId.trim() || void 0 : void 0,
		filter: typeof params.filter === "string" ? params.filter.trim() || void 0 : void 0,
		clear: Boolean(params.clear),
		profile: params.profile
	};
}
function registerBrowserDebugCommands(browser, parentOpts) {
	browser.command("highlight").description("Highlight an element by ref").argument("<ref>", "Ref id from snapshot").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (ref, opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserDebug(async () => {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/highlight",
				query: profile ? { profile } : void 0,
				body: {
					ref: ref.trim(),
					targetId: opts.targetId?.trim() || void 0
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`highlighted ${ref.trim()}`);
		});
	});
	browser.command("errors").description("Get recent page errors").option("--clear", "Clear stored errors after reading", false).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserDebug(async () => {
			const result = await callBrowserRequest(parent, {
				method: "GET",
				path: "/errors",
				query: resolveDebugQuery({
					targetId: opts.targetId,
					clear: opts.clear,
					profile
				})
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			if (!result.errors.length) {
				defaultRuntime.log("No page errors.");
				return;
			}
			defaultRuntime.log(result.errors.map((e) => `${e.timestamp} ${e.name ? `${e.name}: ` : ""}${e.message}`).join("\n"));
		});
	});
	browser.command("requests").description("Get recent network requests (best-effort)").option("--filter <text>", "Only show URLs that contain this substring").option("--clear", "Clear stored requests after reading", false).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserDebug(async () => {
			const result = await callBrowserRequest(parent, {
				method: "GET",
				path: "/requests",
				query: resolveDebugQuery({
					targetId: opts.targetId,
					filter: opts.filter,
					clear: opts.clear,
					profile
				})
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
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
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserDebug(async () => {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/trace/start",
				query: profile ? { profile } : void 0,
				body: {
					targetId: opts.targetId?.trim() || void 0,
					screenshots: Boolean(opts.screenshots),
					snapshots: Boolean(opts.snapshots),
					sources: Boolean(opts.sources)
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log("trace started");
		});
	});
	trace.command("stop").description("Stop trace recording and write a .zip").option("--out <path>", "Output path within openclaw temp dir (e.g. trace.zip or /tmp/openclaw/trace.zip)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserDebug(async () => {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/trace/stop",
				query: profile ? { profile } : void 0,
				body: {
					targetId: opts.targetId?.trim() || void 0,
					path: opts.out?.trim() || void 0
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`TRACE:${shortenHomePath(result.path)}`);
		});
	});
}

//#endregion
//#region src/cli/browser-cli-examples.ts
const browserCoreExamples = [
	"openclaw browser status",
	"openclaw browser start",
	"openclaw browser stop",
	"openclaw browser tabs",
	"openclaw browser open https://example.com",
	"openclaw browser focus abcd1234",
	"openclaw browser close abcd1234",
	"openclaw browser screenshot",
	"openclaw browser screenshot --full-page",
	"openclaw browser screenshot --ref 12",
	"openclaw browser snapshot",
	"openclaw browser snapshot --format aria --limit 200",
	"openclaw browser snapshot --efficient",
	"openclaw browser snapshot --labels"
];
const browserActionExamples = [
	"openclaw browser navigate https://example.com",
	"openclaw browser resize 1280 720",
	"openclaw browser click 12 --double",
	"openclaw browser type 23 \"hello\" --submit",
	"openclaw browser press Enter",
	"openclaw browser hover 44",
	"openclaw browser drag 10 11",
	"openclaw browser select 9 OptionA OptionB",
	"openclaw browser upload /tmp/openclaw/uploads/file.pdf",
	"openclaw browser fill --fields '[{\"ref\":\"1\",\"value\":\"Ada\"}]'",
	"openclaw browser dialog --accept",
	"openclaw browser wait --text \"Done\"",
	"openclaw browser evaluate --fn '(el) => el.textContent' --ref 7",
	"openclaw browser console --level error",
	"openclaw browser pdf"
];

//#endregion
//#region src/cli/browser-cli-extension.ts
function resolveBundledExtensionRootDir(here = path.dirname(fileURLToPath(import.meta.url))) {
	let current = here;
	while (true) {
		const candidate = path.join(current, "assets", "chrome-extension");
		if (hasManifest(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return path.resolve(here, "../../assets/chrome-extension");
}
function installedExtensionRootDir() {
	return path.join(resolveStateDir(), "browser", "chrome-extension");
}
function hasManifest(dir) {
	return fs.existsSync(path.join(dir, "manifest.json"));
}
async function installChromeExtension(opts) {
	const src = opts?.sourceDir ?? resolveBundledExtensionRootDir();
	if (!hasManifest(src)) throw new Error("Bundled Chrome extension is missing. Reinstall OpenClaw and try again.");
	const stateDir = opts?.stateDir ?? resolveStateDir();
	const dest = path.join(stateDir, "browser", "chrome-extension");
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	if (fs.existsSync(dest)) await movePathToTrash(dest).catch(() => {
		const backup = `${dest}.old-${Date.now()}`;
		fs.renameSync(dest, backup);
	});
	await fs.promises.cp(src, dest, { recursive: true });
	if (!hasManifest(dest)) throw new Error("Chrome extension install failed (manifest.json missing). Try again.");
	return { path: dest };
}
function registerBrowserExtensionCommands(browser, parentOpts) {
	const ext = browser.command("extension").description("Chrome extension helpers");
	ext.command("install").description("Install the Chrome extension to a stable local path").action(async (_opts, cmd) => {
		const parent = parentOpts(cmd);
		let installed;
		try {
			installed = await installChromeExtension();
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
			return;
		}
		if (parent?.json) {
			defaultRuntime.log(JSON.stringify({
				ok: true,
				path: installed.path
			}, null, 2));
			return;
		}
		const displayPath = shortenHomePath(installed.path);
		defaultRuntime.log(displayPath);
		const copied = await copyToClipboard(installed.path).catch(() => false);
		defaultRuntime.error(info([
			copied ? "Copied to clipboard." : "Copy to clipboard unavailable.",
			"Next:",
			`- Chrome → chrome://extensions → enable “Developer mode”`,
			`- “Load unpacked” → select: ${displayPath}`,
			`- Pin “OpenClaw Browser Relay”, then click it on the tab (badge shows ON)`,
			"",
			`${theme.muted("Docs:")} ${formatDocsLink("/tools/chrome-extension", "docs.openclaw.ai/tools/chrome-extension")}`
		].join("\n")));
	});
	ext.command("path").description("Print the path to the installed Chrome extension (load unpacked)").action(async (_opts, cmd) => {
		const parent = parentOpts(cmd);
		const dir = installedExtensionRootDir();
		if (!hasManifest(dir)) {
			defaultRuntime.error(danger([`Chrome extension is not installed. Run: "${formatCliCommand("openclaw browser extension install")}"`, `Docs: ${formatDocsLink("/tools/chrome-extension", "docs.openclaw.ai/tools/chrome-extension")}`].join("\n")));
			defaultRuntime.exit(1);
		}
		if (parent?.json) {
			defaultRuntime.log(JSON.stringify({ path: dir }, null, 2));
			return;
		}
		const displayPath = shortenHomePath(dir);
		defaultRuntime.log(displayPath);
		if (await copyToClipboard(dir).catch(() => false)) defaultRuntime.error(info("Copied to clipboard."));
	});
}

//#endregion
//#region src/cli/browser-cli-inspect.ts
function registerBrowserInspectCommands(browser, parentOpts) {
	browser.command("screenshot").description("Capture a screenshot (MEDIA:<path>)").argument("[targetId]", "CDP target id (or unique prefix)").option("--full-page", "Capture full scrollable page", false).option("--ref <ref>", "ARIA ref from ai snapshot").option("--element <selector>", "CSS selector for element screenshot").option("--type <png|jpeg>", "Output type (default: png)", "png").action(async (targetId, opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		try {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/screenshot",
				query: profile ? { profile } : void 0,
				body: {
					targetId: targetId?.trim() || void 0,
					fullPage: Boolean(opts.fullPage),
					ref: opts.ref?.trim() || void 0,
					element: opts.element?.trim() || void 0,
					type: opts.type === "jpeg" ? "jpeg" : "png"
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`MEDIA:${shortenHomePath(result.path)}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("snapshot").description("Capture a snapshot (default: ai; aria is the accessibility tree)").option("--format <aria|ai>", "Snapshot format (default: ai)", "ai").option("--target-id <id>", "CDP target id (or unique prefix)").option("--limit <n>", "Max nodes (default: 500/800)", (v) => Number(v)).option("--mode <efficient>", "Snapshot preset (efficient)").option("--efficient", "Use the efficient snapshot preset", false).option("--interactive", "Role snapshot: interactive elements only", false).option("--compact", "Role snapshot: compact output", false).option("--depth <n>", "Role snapshot: max depth", (v) => Number(v)).option("--selector <sel>", "Role snapshot: scope to CSS selector").option("--frame <sel>", "Role snapshot: scope to an iframe selector").option("--labels", "Include viewport label overlay screenshot", false).option("--out <path>", "Write snapshot to a file").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		const format = opts.format === "aria" ? "aria" : "ai";
		const configMode = format === "ai" && loadConfig().browser?.snapshotDefaults?.mode === "efficient" ? "efficient" : void 0;
		const mode = opts.efficient === true || opts.mode === "efficient" ? "efficient" : configMode;
		try {
			const result = await callBrowserRequest(parent, {
				method: "GET",
				path: "/snapshot",
				query: {
					format,
					targetId: opts.targetId?.trim() || void 0,
					limit: Number.isFinite(opts.limit) ? opts.limit : void 0,
					interactive: opts.interactive ? true : void 0,
					compact: opts.compact ? true : void 0,
					depth: Number.isFinite(opts.depth) ? opts.depth : void 0,
					selector: opts.selector?.trim() || void 0,
					frame: opts.frame?.trim() || void 0,
					labels: opts.labels ? true : void 0,
					mode,
					profile
				}
			}, { timeoutMs: 2e4 });
			if (opts.out) {
				const fs = await import("node:fs/promises");
				if (result.format === "ai") await fs.writeFile(opts.out, result.snapshot, "utf8");
				else {
					const payload = JSON.stringify(result, null, 2);
					await fs.writeFile(opts.out, payload, "utf8");
				}
				if (parent?.json) defaultRuntime.log(JSON.stringify({
					ok: true,
					out: opts.out,
					...result.format === "ai" && result.imagePath ? { imagePath: result.imagePath } : {}
				}, null, 2));
				else {
					defaultRuntime.log(shortenHomePath(opts.out));
					if (result.format === "ai" && result.imagePath) defaultRuntime.log(`MEDIA:${shortenHomePath(result.imagePath)}`);
				}
				return;
			}
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			if (result.format === "ai") {
				defaultRuntime.log(result.snapshot);
				if (result.imagePath) defaultRuntime.log(`MEDIA:${shortenHomePath(result.imagePath)}`);
				return;
			}
			const nodes = "nodes" in result ? result.nodes : [];
			defaultRuntime.log(nodes.map((n) => {
				const indent = "  ".repeat(Math.min(20, n.depth));
				const name = n.name ? ` "${n.name}"` : "";
				const value = n.value ? ` = "${n.value}"` : "";
				return `${indent}- ${n.role}${name}${value}`;
			}).join("\n"));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}

//#endregion
//#region src/cli/browser-cli-manage.ts
async function fetchBrowserStatus(parent, profile) {
	return await callBrowserRequest(parent, {
		method: "GET",
		path: "/",
		query: profile ? { profile } : void 0
	}, { timeoutMs: 1500 });
}
async function runBrowserToggle(parent, params) {
	await callBrowserRequest(parent, {
		method: "POST",
		path: params.path,
		query: params.profile ? { profile: params.profile } : void 0
	}, { timeoutMs: 15e3 });
	const status = await fetchBrowserStatus(parent, params.profile);
	if (parent?.json) {
		defaultRuntime.log(JSON.stringify(status, null, 2));
		return;
	}
	const name = status.profile ?? "openclaw";
	defaultRuntime.log(info(`🦞 browser [${name}] running: ${status.running}`));
}
function runBrowserCommand$1(action) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		defaultRuntime.error(danger(String(err)));
		defaultRuntime.exit(1);
	});
}
function logBrowserTabs(tabs, json) {
	if (json) {
		defaultRuntime.log(JSON.stringify({ tabs }, null, 2));
		return;
	}
	if (tabs.length === 0) {
		defaultRuntime.log("No tabs (browser closed or no targets).");
		return;
	}
	defaultRuntime.log(tabs.map((t, i) => `${i + 1}. ${t.title || "(untitled)"}\n   ${t.url}\n   id: ${t.targetId}`).join("\n"));
}
function registerBrowserManageCommands(browser, parentOpts) {
	browser.command("status").description("Show browser status").action(async (_opts, cmd) => {
		const parent = parentOpts(cmd);
		await runBrowserCommand$1(async () => {
			const status = await fetchBrowserStatus(parent, parent?.browserProfile);
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(status, null, 2));
				return;
			}
			const detectedPath = status.detectedExecutablePath ?? status.executablePath;
			const detectedDisplay = detectedPath ? shortenHomePath(detectedPath) : "auto";
			defaultRuntime.log([
				`profile: ${status.profile ?? "openclaw"}`,
				`enabled: ${status.enabled}`,
				`running: ${status.running}`,
				`cdpPort: ${status.cdpPort}`,
				`cdpUrl: ${status.cdpUrl ?? `http://127.0.0.1:${status.cdpPort}`}`,
				`browser: ${status.chosenBrowser ?? "unknown"}`,
				`detectedBrowser: ${status.detectedBrowser ?? "unknown"}`,
				`detectedPath: ${detectedDisplay}`,
				`profileColor: ${status.color}`,
				...status.detectError ? [`detectError: ${status.detectError}`] : []
			].join("\n"));
		});
	});
	browser.command("start").description("Start the browser (no-op if already running)").action(async (_opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand$1(async () => {
			await runBrowserToggle(parent, {
				profile,
				path: "/start"
			});
		});
	});
	browser.command("stop").description("Stop the browser (best-effort)").action(async (_opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand$1(async () => {
			await runBrowserToggle(parent, {
				profile,
				path: "/stop"
			});
		});
	});
	browser.command("reset-profile").description("Reset browser profile (moves it to Trash)").action(async (_opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand$1(async () => {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/reset-profile",
				query: profile ? { profile } : void 0
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			if (!result.moved) {
				defaultRuntime.log(info(`🦞 browser profile already missing.`));
				return;
			}
			const dest = result.to ?? result.from;
			defaultRuntime.log(info(`🦞 browser profile moved to Trash (${dest})`));
		});
	});
	browser.command("tabs").description("List open tabs").action(async (_opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand$1(async () => {
			logBrowserTabs((await callBrowserRequest(parent, {
				method: "GET",
				path: "/tabs",
				query: profile ? { profile } : void 0
			}, { timeoutMs: 3e3 })).tabs ?? [], parent?.json);
		});
	});
	const tab = browser.command("tab").description("Tab shortcuts (index-based)").action(async (_opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand$1(async () => {
			logBrowserTabs((await callBrowserRequest(parent, {
				method: "POST",
				path: "/tabs/action",
				query: profile ? { profile } : void 0,
				body: { action: "list" }
			}, { timeoutMs: 1e4 })).tabs ?? [], parent?.json);
		});
	});
	tab.command("new").description("Open a new tab (about:blank)").action(async (_opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand$1(async () => {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/tabs/action",
				query: profile ? { profile } : void 0,
				body: { action: "new" }
			}, { timeoutMs: 1e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log("opened new tab");
		});
	});
	tab.command("select").description("Focus tab by index (1-based)").argument("<index>", "Tab index (1-based)", (v) => Number(v)).action(async (index, _opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		if (!Number.isFinite(index) || index < 1) {
			defaultRuntime.error(danger("index must be a positive number"));
			defaultRuntime.exit(1);
			return;
		}
		await runBrowserCommand$1(async () => {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/tabs/action",
				query: profile ? { profile } : void 0,
				body: {
					action: "select",
					index: Math.floor(index) - 1
				}
			}, { timeoutMs: 1e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`selected tab ${Math.floor(index)}`);
		});
	});
	tab.command("close").description("Close tab by index (1-based); default: first tab").argument("[index]", "Tab index (1-based)", (v) => Number(v)).action(async (index, _opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		const idx = typeof index === "number" && Number.isFinite(index) ? Math.floor(index) - 1 : void 0;
		if (typeof idx === "number" && idx < 0) {
			defaultRuntime.error(danger("index must be >= 1"));
			defaultRuntime.exit(1);
			return;
		}
		await runBrowserCommand$1(async () => {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/tabs/action",
				query: profile ? { profile } : void 0,
				body: {
					action: "close",
					index: idx
				}
			}, { timeoutMs: 1e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log("closed tab");
		});
	});
	browser.command("open").description("Open a URL in a new tab").argument("<url>", "URL to open").action(async (url, _opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand$1(async () => {
			const tab = await callBrowserRequest(parent, {
				method: "POST",
				path: "/tabs/open",
				query: profile ? { profile } : void 0,
				body: { url }
			}, { timeoutMs: 15e3 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(tab, null, 2));
				return;
			}
			defaultRuntime.log(`opened: ${tab.url}\nid: ${tab.targetId}`);
		});
	});
	browser.command("focus").description("Focus a tab by target id (or unique prefix)").argument("<targetId>", "Target id or unique prefix").action(async (targetId, _opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand$1(async () => {
			await callBrowserRequest(parent, {
				method: "POST",
				path: "/tabs/focus",
				query: profile ? { profile } : void 0,
				body: { targetId }
			}, { timeoutMs: 5e3 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify({ ok: true }, null, 2));
				return;
			}
			defaultRuntime.log(`focused tab ${targetId}`);
		});
	});
	browser.command("close").description("Close a tab (target id optional)").argument("[targetId]", "Target id or unique prefix (optional)").action(async (targetId, _opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand$1(async () => {
			if (targetId?.trim()) await callBrowserRequest(parent, {
				method: "DELETE",
				path: `/tabs/${encodeURIComponent(targetId.trim())}`,
				query: profile ? { profile } : void 0
			}, { timeoutMs: 5e3 });
			else await callBrowserRequest(parent, {
				method: "POST",
				path: "/act",
				query: profile ? { profile } : void 0,
				body: { kind: "close" }
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify({ ok: true }, null, 2));
				return;
			}
			defaultRuntime.log("closed tab");
		});
	});
	browser.command("profiles").description("List all browser profiles").action(async (_opts, cmd) => {
		const parent = parentOpts(cmd);
		await runBrowserCommand$1(async () => {
			const profiles = (await callBrowserRequest(parent, {
				method: "GET",
				path: "/profiles"
			}, { timeoutMs: 3e3 })).profiles ?? [];
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify({ profiles }, null, 2));
				return;
			}
			if (profiles.length === 0) {
				defaultRuntime.log("No profiles configured.");
				return;
			}
			defaultRuntime.log(profiles.map((p) => {
				const status = p.running ? "running" : "stopped";
				const tabs = p.running ? ` (${p.tabCount} tabs)` : "";
				const def = p.isDefault ? " [default]" : "";
				const loc = p.isRemote ? `cdpUrl: ${p.cdpUrl}` : `port: ${p.cdpPort}`;
				const remote = p.isRemote ? " [remote]" : "";
				return `${p.name}: ${status}${tabs}${def}${remote}\n  ${loc}, color: ${p.color}`;
			}).join("\n"));
		});
	});
	browser.command("create-profile").description("Create a new browser profile").requiredOption("--name <name>", "Profile name (lowercase, numbers, hyphens)").option("--color <hex>", "Profile color (hex format, e.g. #0066CC)").option("--cdp-url <url>", "CDP URL for remote Chrome (http/https)").option("--driver <driver>", "Profile driver (openclaw|extension). Default: openclaw").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		await runBrowserCommand$1(async () => {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/profiles/create",
				body: {
					name: opts.name,
					color: opts.color,
					cdpUrl: opts.cdpUrl,
					driver: opts.driver === "extension" ? "extension" : void 0
				}
			}, { timeoutMs: 1e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			const loc = result.isRemote ? `  cdpUrl: ${result.cdpUrl}` : `  port: ${result.cdpPort}`;
			defaultRuntime.log(info(`🦞 Created profile "${result.profile}"\n${loc}\n  color: ${result.color}${opts.driver === "extension" ? "\n  driver: extension" : ""}`));
		});
	});
	browser.command("delete-profile").description("Delete a browser profile").requiredOption("--name <name>", "Profile name to delete").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		await runBrowserCommand$1(async () => {
			const result = await callBrowserRequest(parent, {
				method: "DELETE",
				path: `/profiles/${encodeURIComponent(opts.name)}`
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			const msg = result.deleted ? `🦞 Deleted profile "${result.profile}" (user data removed)` : `🦞 Deleted profile "${result.profile}" (no user data found)`;
			defaultRuntime.log(info(msg));
		});
	});
}

//#endregion
//#region src/cli/browser-cli-state.cookies-storage.ts
function resolveUrl(opts, command) {
	if (typeof opts.url === "string" && opts.url.trim()) return opts.url.trim();
	const inherited = inheritOptionFromParent(command, "url");
	if (typeof inherited === "string" && inherited.trim()) return inherited.trim();
}
function resolveTargetId(rawTargetId, command) {
	const local = typeof rawTargetId === "string" ? rawTargetId.trim() : "";
	if (local) return local;
	const inherited = inheritOptionFromParent(command, "targetId");
	if (typeof inherited !== "string") return;
	const trimmed = inherited.trim();
	return trimmed ? trimmed : void 0;
}
function registerBrowserCookiesAndStorageCommands(browser, parentOpts) {
	const cookies = browser.command("cookies").description("Read/write cookies");
	cookies.option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		const targetId = resolveTargetId(opts.targetId, cmd);
		try {
			const result = await callBrowserRequest(parent, {
				method: "GET",
				path: "/cookies",
				query: {
					targetId,
					profile
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(JSON.stringify(result.cookies ?? [], null, 2));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	cookies.command("set").description("Set a cookie (requires --url or domain+path)").argument("<name>", "Cookie name").argument("<value>", "Cookie value").option("--url <url>", "Cookie URL scope (recommended)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (name, value, opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		const targetId = resolveTargetId(opts.targetId, cmd);
		const url = resolveUrl(opts, cmd);
		if (!url) {
			defaultRuntime.error(danger("Missing required --url option for cookies set"));
			defaultRuntime.exit(1);
			return;
		}
		try {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/cookies/set",
				query: profile ? { profile } : void 0,
				body: {
					targetId,
					cookie: {
						name,
						value,
						url
					}
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log(`cookie set: ${name}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	cookies.command("clear").description("Clear all cookies").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		const targetId = resolveTargetId(opts.targetId, cmd);
		try {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/cookies/clear",
				query: profile ? { profile } : void 0,
				body: { targetId }
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log("cookies cleared");
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	const storage = browser.command("storage").description("Read/write localStorage/sessionStorage");
	function registerStorageKind(kind) {
		const cmd = storage.command(kind).description(`${kind}Storage commands`);
		cmd.command("get").description(`Get ${kind}Storage (all keys or one key)`).argument("[key]", "Key (optional)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (key, opts, cmd2) => {
			const parent = parentOpts(cmd2);
			const profile = parent?.browserProfile;
			const targetId = resolveTargetId(opts.targetId, cmd2);
			try {
				const result = await callBrowserRequest(parent, {
					method: "GET",
					path: `/storage/${kind}`,
					query: {
						key: key?.trim() || void 0,
						targetId,
						profile
					}
				}, { timeoutMs: 2e4 });
				if (parent?.json) {
					defaultRuntime.log(JSON.stringify(result, null, 2));
					return;
				}
				defaultRuntime.log(JSON.stringify(result.values ?? {}, null, 2));
			} catch (err) {
				defaultRuntime.error(danger(String(err)));
				defaultRuntime.exit(1);
			}
		});
		cmd.command("set").description(`Set a ${kind}Storage key`).argument("<key>", "Key").argument("<value>", "Value").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (key, value, opts, cmd2) => {
			const parent = parentOpts(cmd2);
			const profile = parent?.browserProfile;
			const targetId = resolveTargetId(opts.targetId, cmd2);
			try {
				const result = await callBrowserRequest(parent, {
					method: "POST",
					path: `/storage/${kind}/set`,
					query: profile ? { profile } : void 0,
					body: {
						key,
						value,
						targetId
					}
				}, { timeoutMs: 2e4 });
				if (parent?.json) {
					defaultRuntime.log(JSON.stringify(result, null, 2));
					return;
				}
				defaultRuntime.log(`${kind}Storage set: ${key}`);
			} catch (err) {
				defaultRuntime.error(danger(String(err)));
				defaultRuntime.exit(1);
			}
		});
		cmd.command("clear").description(`Clear all ${kind}Storage keys`).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd2) => {
			const parent = parentOpts(cmd2);
			const profile = parent?.browserProfile;
			const targetId = resolveTargetId(opts.targetId, cmd2);
			try {
				const result = await callBrowserRequest(parent, {
					method: "POST",
					path: `/storage/${kind}/clear`,
					query: profile ? { profile } : void 0,
					body: { targetId }
				}, { timeoutMs: 2e4 });
				if (parent?.json) {
					defaultRuntime.log(JSON.stringify(result, null, 2));
					return;
				}
				defaultRuntime.log(`${kind}Storage cleared`);
			} catch (err) {
				defaultRuntime.error(danger(String(err)));
				defaultRuntime.exit(1);
			}
		});
	}
	registerStorageKind("local");
	registerStorageKind("session");
}

//#endregion
//#region src/cli/browser-cli-state.ts
function parseOnOff(raw) {
	const parsed = parseBooleanValue(raw);
	return parsed === void 0 ? null : parsed;
}
function runBrowserCommand(action) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		defaultRuntime.error(danger(String(err)));
		defaultRuntime.exit(1);
	});
}
async function runBrowserSetRequest(params) {
	await runBrowserCommand(async () => {
		const profile = params.parent?.browserProfile;
		const result = await callBrowserRequest(params.parent, {
			method: "POST",
			path: params.path,
			query: profile ? { profile } : void 0,
			body: params.body
		}, { timeoutMs: 2e4 });
		if (params.parent?.json) {
			defaultRuntime.log(JSON.stringify(result, null, 2));
			return;
		}
		defaultRuntime.log(params.successMessage);
	});
}
function registerBrowserStateCommands(browser, parentOpts) {
	registerBrowserCookiesAndStorageCommands(browser, parentOpts);
	const set = browser.command("set").description("Browser environment settings");
	set.command("viewport").description("Set viewport size (alias for resize)").argument("<width>", "Viewport width", (v) => Number(v)).argument("<height>", "Viewport height", (v) => Number(v)).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (width, height, opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand(async () => {
			await runBrowserResizeWithOutput({
				parent,
				profile,
				width,
				height,
				targetId: opts.targetId,
				timeoutMs: 2e4,
				successMessage: `viewport set: ${width}x${height}`
			});
		});
	});
	set.command("offline").description("Toggle offline mode").argument("<on|off>", "on/off").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (value, opts, cmd) => {
		const parent = parentOpts(cmd);
		const offline = parseOnOff(value);
		if (offline === null) {
			defaultRuntime.error(danger("Expected on|off"));
			defaultRuntime.exit(1);
			return;
		}
		await runBrowserSetRequest({
			parent,
			path: "/set/offline",
			body: {
				offline,
				targetId: opts.targetId?.trim() || void 0
			},
			successMessage: `offline: ${offline}`
		});
	});
	set.command("headers").description("Set extra HTTP headers (JSON object)").argument("[headersJson]", "JSON object of headers (alternative to --headers-json)").option("--headers-json <json>", "JSON object of headers").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (headersJson, opts, cmd) => {
		const parent = parentOpts(cmd);
		await runBrowserCommand(async () => {
			const headersJsonValue = typeof opts.headersJson === "string" && opts.headersJson.trim() || (headersJson?.trim() ? headersJson.trim() : void 0);
			if (!headersJsonValue) throw new Error("Missing headers JSON (pass --headers-json or positional JSON argument)");
			const parsed = JSON.parse(String(headersJsonValue));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Headers JSON must be a JSON object");
			const headers = {};
			for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") headers[k] = v;
			const profile = parent?.browserProfile;
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/set/headers",
				query: profile ? { profile } : void 0,
				body: {
					headers,
					targetId: opts.targetId?.trim() || void 0
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.log(JSON.stringify(result, null, 2));
				return;
			}
			defaultRuntime.log("headers set");
		});
	});
	set.command("credentials").description("Set HTTP basic auth credentials").option("--clear", "Clear credentials", false).argument("[username]", "Username").argument("[password]", "Password").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (username, password, opts, cmd) => {
		await runBrowserSetRequest({
			parent: parentOpts(cmd),
			path: "/set/credentials",
			body: {
				username: username?.trim() || void 0,
				password,
				clear: Boolean(opts.clear),
				targetId: opts.targetId?.trim() || void 0
			},
			successMessage: opts.clear ? "credentials cleared" : "credentials set"
		});
	});
	set.command("geo").description("Set geolocation (and grant permission)").option("--clear", "Clear geolocation + permissions", false).argument("[latitude]", "Latitude", (v) => Number(v)).argument("[longitude]", "Longitude", (v) => Number(v)).option("--accuracy <m>", "Accuracy in meters", (v) => Number(v)).option("--origin <origin>", "Origin to grant permissions for").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (latitude, longitude, opts, cmd) => {
		await runBrowserSetRequest({
			parent: parentOpts(cmd),
			path: "/set/geolocation",
			body: {
				latitude: Number.isFinite(latitude) ? latitude : void 0,
				longitude: Number.isFinite(longitude) ? longitude : void 0,
				accuracy: Number.isFinite(opts.accuracy) ? opts.accuracy : void 0,
				origin: opts.origin?.trim() || void 0,
				clear: Boolean(opts.clear),
				targetId: opts.targetId?.trim() || void 0
			},
			successMessage: opts.clear ? "geolocation cleared" : "geolocation set"
		});
	});
	set.command("media").description("Emulate prefers-color-scheme").argument("<dark|light|none>", "dark/light/none").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (value, opts, cmd) => {
		const parent = parentOpts(cmd);
		const v = value.trim().toLowerCase();
		const colorScheme = v === "dark" ? "dark" : v === "light" ? "light" : v === "none" ? "none" : null;
		if (!colorScheme) {
			defaultRuntime.error(danger("Expected dark|light|none"));
			defaultRuntime.exit(1);
			return;
		}
		await runBrowserSetRequest({
			parent,
			path: "/set/media",
			body: {
				colorScheme,
				targetId: opts.targetId?.trim() || void 0
			},
			successMessage: `media colorScheme: ${colorScheme}`
		});
	});
	set.command("timezone").description("Override timezone (CDP)").argument("<timezoneId>", "Timezone ID (e.g. America/New_York)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (timezoneId, opts, cmd) => {
		await runBrowserSetRequest({
			parent: parentOpts(cmd),
			path: "/set/timezone",
			body: {
				timezoneId,
				targetId: opts.targetId?.trim() || void 0
			},
			successMessage: `timezone: ${timezoneId}`
		});
	});
	set.command("locale").description("Override locale (CDP)").argument("<locale>", "Locale (e.g. en-US)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (locale, opts, cmd) => {
		await runBrowserSetRequest({
			parent: parentOpts(cmd),
			path: "/set/locale",
			body: {
				locale,
				targetId: opts.targetId?.trim() || void 0
			},
			successMessage: `locale: ${locale}`
		});
	});
	set.command("device").description("Apply a Playwright device descriptor (e.g. \"iPhone 14\")").argument("<name>", "Device name (Playwright devices)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (name, opts, cmd) => {
		await runBrowserSetRequest({
			parent: parentOpts(cmd),
			path: "/set/device",
			body: {
				name,
				targetId: opts.targetId?.trim() || void 0
			},
			successMessage: `device: ${name}`
		});
	});
}

//#endregion
//#region src/cli/browser-cli.ts
function registerBrowserCli(program) {
	const browser = program.command("browser").description("Manage OpenClaw's dedicated browser (Chrome/Chromium)").option("--browser-profile <name>", "Browser profile name (default from config)").option("--json", "Output machine-readable JSON", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([...browserCoreExamples, ...browserActionExamples].map((cmd) => [cmd, ""]), true)}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/browser", "docs.openclaw.ai/cli/browser")}\n`).action(() => {
		browser.outputHelp();
		defaultRuntime.error(danger(`Missing subcommand. Try: "${formatCliCommand("openclaw browser status")}"`));
		defaultRuntime.exit(1);
	});
	addGatewayClientOptions(browser);
	const parentOpts = (cmd) => cmd.parent?.opts?.();
	registerBrowserManageCommands(browser, parentOpts);
	registerBrowserExtensionCommands(browser, parentOpts);
	registerBrowserInspectCommands(browser, parentOpts);
	registerBrowserActionInputCommands(browser, parentOpts);
	registerBrowserActionObserveCommands(browser, parentOpts);
	registerBrowserDebugCommands(browser, parentOpts);
	registerBrowserStateCommands(browser, parentOpts);
}

//#endregion
export { registerBrowserCli };