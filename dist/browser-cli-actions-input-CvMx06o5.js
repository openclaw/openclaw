import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { f as resolveExistingPathsWithinRoot } from "./fs-safe-DpJlqO1z.js";
import { g as shortenHomePath } from "./utils-CKsuXgDI.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { t as danger } from "./globals-CouSpJO4.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { s as DEFAULT_UPLOAD_DIR } from "./config-CHem-I24.js";
import { o as normalizeBrowserFormField, s as normalizeBrowserFormFieldValue } from "./pw-role-snapshot-Dsa6eud2.js";
import "./core-api-Dyca-PBA.js";
import { t as callBrowserRequest } from "./browser-cli-shared-BHaKhGhB.js";
import { t as runBrowserResizeWithOutput } from "./browser-cli-resize-DaqcvPNd.js";
import fs from "node:fs/promises";
//#region extensions/browser/src/cli/browser-cli-actions-input/shared.ts
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
function logBrowserActionResult(parent, result, successMessage) {
	if (parent?.json) {
		defaultRuntime.writeJson(result);
		return;
	}
	defaultRuntime.log(successMessage);
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
async function readFile$1(path) {
	return await fs.readFile(path, "utf8");
}
async function readFields(opts) {
	const payload = opts.fieldsFile ? await readFile$1(opts.fieldsFile) : opts.fields ?? "";
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
//#region extensions/browser/src/cli/browser-cli-actions-input/register.element.ts
function registerBrowserElementCommands(browser, parentOpts) {
	const runElementAction = async (params) => {
		const { parent, profile } = resolveBrowserActionContext(params.cmd, parentOpts);
		try {
			const result = await callBrowserAct({
				parent,
				profile,
				body: params.body,
				timeoutMs: params.timeoutMs
			});
			logBrowserActionResult(parent, result, typeof params.successMessage === "function" ? params.successMessage(result) : params.successMessage);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	};
	browser.command("click").description("Click an element by ref from snapshot").argument("<ref>", "Ref id from snapshot").option("--target-id <id>", "CDP target id (or unique prefix)").option("--double", "Double click", false).option("--button <left|right|middle>", "Mouse button to use").option("--modifiers <list>", "Comma-separated modifiers (Shift,Alt,Meta)").action(async (ref, opts, cmd) => {
		const refValue = requireRef(ref);
		if (!refValue) return;
		const modifiers = opts.modifiers ? String(opts.modifiers).split(",").map((v) => v.trim()).filter(Boolean) : void 0;
		await runElementAction({
			cmd,
			body: {
				kind: "click",
				ref: refValue,
				targetId: normalizeOptionalString(opts.targetId),
				doubleClick: Boolean(opts.double),
				button: normalizeOptionalString(opts.button),
				modifiers
			},
			successMessage: (result) => {
				const url = result.url;
				return `clicked ref ${refValue}${typeof url === "string" && url ? ` on ${url}` : ""}`;
			}
		});
	});
	browser.command("click-coords").description("Click viewport coordinates").argument("<x>", "Viewport x coordinate").argument("<y>", "Viewport y coordinate").option("--target-id <id>", "CDP target id (or unique prefix)").option("--double", "Double click", false).option("--button <left|right|middle>", "Mouse button to use").option("--delay-ms <ms>", "Delay between mouse down/up", (v) => Number(v)).action(async (xRaw, yRaw, opts, cmd) => {
		const x = Number(xRaw);
		const y = Number(yRaw);
		await runElementAction({
			cmd,
			body: {
				kind: "clickCoords",
				x,
				y,
				targetId: normalizeOptionalString(opts.targetId),
				doubleClick: Boolean(opts.double),
				button: normalizeOptionalString(opts.button),
				delayMs: Number.isFinite(opts.delayMs) ? opts.delayMs : void 0
			},
			successMessage: (result) => {
				const url = result.url;
				return `clicked ${x},${y}${typeof url === "string" && url ? ` on ${url}` : ""}`;
			}
		});
	});
	browser.command("type").description("Type into an element by ref from snapshot").argument("<ref>", "Ref id from snapshot").argument("<text>", "Text to type").option("--submit", "Press Enter after typing", false).option("--slowly", "Type slowly (human-like)", false).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (ref, text, opts, cmd) => {
		const refValue = requireRef(ref);
		if (!refValue) return;
		await runElementAction({
			cmd,
			body: {
				kind: "type",
				ref: refValue,
				text,
				submit: Boolean(opts.submit),
				slowly: Boolean(opts.slowly),
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: `typed into ref ${refValue}`
		});
	});
	browser.command("press").description("Press a key").argument("<key>", "Key to press (e.g. Enter)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (key, opts, cmd) => {
		await runElementAction({
			cmd,
			body: {
				kind: "press",
				key,
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: `pressed ${key}`
		});
	});
	browser.command("hover").description("Hover an element by ai ref").argument("<ref>", "Ref id from snapshot").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (ref, opts, cmd) => {
		await runElementAction({
			cmd,
			body: {
				kind: "hover",
				ref,
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: `hovered ref ${ref}`
		});
	});
	browser.command("scrollintoview").description("Scroll an element into view by ref from snapshot").argument("<ref>", "Ref id from snapshot").option("--target-id <id>", "CDP target id (or unique prefix)").option("--timeout-ms <ms>", "How long to wait for scroll (default: 20000)", (v) => Number(v)).action(async (ref, opts, cmd) => {
		const refValue = requireRef(ref);
		if (!refValue) return;
		const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : void 0;
		await runElementAction({
			cmd,
			body: {
				kind: "scrollIntoView",
				ref: refValue,
				targetId: normalizeOptionalString(opts.targetId),
				timeoutMs
			},
			timeoutMs,
			successMessage: `scrolled into view: ${refValue}`
		});
	});
	browser.command("drag").description("Drag from one ref to another").argument("<startRef>", "Start ref id").argument("<endRef>", "End ref id").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (startRef, endRef, opts, cmd) => {
		await runElementAction({
			cmd,
			body: {
				kind: "drag",
				startRef,
				endRef,
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: `dragged ${startRef} → ${endRef}`
		});
	});
	browser.command("select").description("Select option(s) in a select element").argument("<ref>", "Ref id from snapshot").argument("<values...>", "Option values to select").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (ref, values, opts, cmd) => {
		await runElementAction({
			cmd,
			body: {
				kind: "select",
				ref,
				values,
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: `selected ${values.join(", ")}`
		});
	});
}
//#endregion
//#region extensions/browser/src/cli/browser-cli-actions-input/register.files-downloads.ts
async function normalizeUploadPaths(paths) {
	const result = await resolveExistingPathsWithinRoot({
		rootDir: DEFAULT_UPLOAD_DIR,
		requestedPaths: paths,
		scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`
	});
	if (!result.ok) throw new Error(result.error);
	return result.paths;
}
async function runBrowserPostAction(params) {
	try {
		const result = await callBrowserRequest(params.parent, {
			method: "POST",
			path: params.path,
			query: params.profile ? { profile: params.profile } : void 0,
			body: params.body
		}, { timeoutMs: params.timeoutMs });
		if (params.parent?.json) {
			defaultRuntime.writeJson(result);
			return;
		}
		defaultRuntime.log(params.describeSuccess(result));
	} catch (err) {
		defaultRuntime.error(danger(String(err)));
		defaultRuntime.exit(1);
	}
}
function registerBrowserFilesAndDownloadsCommands(browser, parentOpts) {
	const resolveTimeoutAndTarget = (opts) => {
		return {
			timeoutMs: Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : void 0,
			targetId: normalizeOptionalString(opts.targetId)
		};
	};
	const runDownloadCommand = async (cmd, opts, request) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		const { timeoutMs, targetId } = resolveTimeoutAndTarget(opts);
		await runBrowserPostAction({
			parent,
			profile,
			path: request.path,
			body: {
				...request.body,
				targetId,
				timeoutMs
			},
			timeoutMs: timeoutMs ?? 2e4,
			describeSuccess: (result) => `downloaded: ${shortenHomePath(result.download.path)}`
		});
	};
	browser.command("upload").description("Arm file upload for the next file chooser").argument("<paths...>", "File paths to upload (must be within OpenClaw temp uploads dir, e.g. /tmp/openclaw/uploads/file.pdf)").option("--ref <ref>", "Ref id from snapshot to click after arming").option("--input-ref <ref>", "Ref id for <input type=file> to set directly").option("--element <selector>", "CSS selector for <input type=file>").option("--target-id <id>", "CDP target id (or unique prefix)").option("--timeout-ms <ms>", "How long to wait for the next file chooser (default: 120000)", (v) => Number(v)).action(async (paths, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		const normalizedPaths = await normalizeUploadPaths(paths);
		const { timeoutMs, targetId } = resolveTimeoutAndTarget(opts);
		await runBrowserPostAction({
			parent,
			profile,
			path: "/hooks/file-chooser",
			body: {
				paths: normalizedPaths,
				ref: normalizeOptionalString(opts.ref),
				inputRef: normalizeOptionalString(opts.inputRef),
				element: normalizeOptionalString(opts.element),
				targetId,
				timeoutMs
			},
			timeoutMs: timeoutMs ?? 2e4,
			describeSuccess: () => `upload armed for ${paths.length} file(s)`
		});
	});
	browser.command("waitfordownload").description("Wait for the next download (and save it)").argument("[path]", "Save path within openclaw temp downloads dir (default: /tmp/openclaw/downloads/...; fallback: os.tmpdir()/openclaw/downloads/...)").option("--target-id <id>", "CDP target id (or unique prefix)").option("--timeout-ms <ms>", "How long to wait for the next download (default: 120000)", (v) => Number(v)).action(async (outPath, opts, cmd) => {
		await runDownloadCommand(cmd, opts, {
			path: "/wait/download",
			body: { path: normalizeOptionalString(outPath) }
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
		const { timeoutMs, targetId } = resolveTimeoutAndTarget(opts);
		await runBrowserPostAction({
			parent,
			profile,
			path: "/hooks/dialog",
			body: {
				accept,
				promptText: normalizeOptionalString(opts.prompt),
				targetId,
				timeoutMs
			},
			timeoutMs: timeoutMs ?? 2e4,
			describeSuccess: () => "dialog armed"
		});
	});
}
//#endregion
//#region extensions/browser/src/cli/browser-cli-actions-input/register.form-wait-eval.ts
function registerBrowserFormWaitEvalCommands(browser, parentOpts) {
	browser.command("fill").description("Fill a form with JSON field descriptors").option("--fields <json>", "JSON array of field objects").option("--fields-file <path>", "Read JSON array from a file").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const fields = await readFields({
				fields: opts.fields,
				fieldsFile: opts.fieldsFile
			});
			logBrowserActionResult(parent, await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "fill",
					fields,
					targetId: normalizeOptionalString(opts.targetId)
				}
			}), `filled ${fields.length} field(s)`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("wait").description("Wait for time, selector, URL, load state, or JS conditions").argument("[selector]", "CSS selector to wait for (visible)").option("--time <ms>", "Wait for N milliseconds", (v) => Number(v)).option("--text <value>", "Wait for text to appear").option("--text-gone <value>", "Wait for text to disappear").option("--url <pattern>", "Wait for URL (supports globs like **/dash)").option("--load <load|domcontentloaded|networkidle>", "Wait for load state").option("--fn <js>", "Wait for JS condition (passed to waitForFunction)").option("--timeout-ms <ms>", "How long to wait for each condition (default: 20000)", (v) => Number(v)).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (selector, opts, cmd) => {
		const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
		try {
			const sel = normalizeOptionalString(selector);
			const load = opts.load === "load" || opts.load === "domcontentloaded" || opts.load === "networkidle" ? opts.load : void 0;
			const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : void 0;
			logBrowserActionResult(parent, await callBrowserAct({
				parent,
				profile,
				body: {
					kind: "wait",
					timeMs: Number.isFinite(opts.time) ? opts.time : void 0,
					text: normalizeOptionalString(opts.text),
					textGone: normalizeOptionalString(opts.textGone),
					selector: sel,
					url: normalizeOptionalString(opts.url),
					loadState: load,
					fn: normalizeOptionalString(opts.fn),
					targetId: normalizeOptionalString(opts.targetId),
					timeoutMs
				},
				timeoutMs
			}), "wait complete");
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
					ref: normalizeOptionalString(opts.ref),
					targetId: normalizeOptionalString(opts.targetId)
				}
			});
			if (parent?.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			defaultRuntime.writeJson(result.result ?? null);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}
//#endregion
//#region extensions/browser/src/cli/browser-cli-actions-input/register.navigation.ts
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
					targetId: normalizeOptionalString(opts.targetId)
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.writeJson(result);
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
//#region extensions/browser/src/cli/browser-cli-actions-input/register.ts
function registerBrowserActionInputCommands(browser, parentOpts) {
	registerBrowserNavigationCommands(browser, parentOpts);
	registerBrowserElementCommands(browser, parentOpts);
	registerBrowserFilesAndDownloadsCommands(browser, parentOpts);
	registerBrowserFormWaitEvalCommands(browser, parentOpts);
}
//#endregion
export { registerBrowserActionInputCommands };
