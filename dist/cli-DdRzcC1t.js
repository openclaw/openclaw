import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as resolveNodeFromNodeList } from "./node-resolve-WWdIs9XF.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./runtime-DA0ehWyx.js";
import "./gateway-runtime-HxuTzDuS.js";
import { n as callGatewayFromCli } from "./gateway-rpc-COT1oBPJ.js";
import { n as runCommandWithRuntime } from "./cli-utils-CdDa8OYO.js";
import "./cli-runtime-hT2uaCvo.js";
import "./text-utility-runtime-CaGXarh9.js";
import { r as parseCanvasSnapshotPayload, t as canvasSnapshotTempPath } from "./cli-helpers-DmHGccAa.js";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
//#region extensions/canvas/src/a2ui-jsonl.ts
const A2UI_ACTION_KEYS = [
	"beginRendering",
	"surfaceUpdate",
	"dataModelUpdate",
	"deleteSurface",
	"createSurface"
];
function buildA2UITextJsonl(text) {
	const surfaceId = "main";
	const rootId = "root";
	const textId = "text";
	return [{ surfaceUpdate: {
		surfaceId,
		components: [{
			id: rootId,
			component: { Column: { children: { explicitList: [textId] } } }
		}, {
			id: textId,
			component: { Text: {
				text: { literalString: text },
				usageHint: "body"
			} }
		}]
	} }, { beginRendering: {
		surfaceId,
		root: rootId
	} }].map((payload) => JSON.stringify(payload)).join("\n");
}
function validateA2UIJsonl(jsonl) {
	const lines = jsonl.split(/\r?\n/);
	const errors = [];
	let sawV08 = false;
	let sawV09 = false;
	let messageCount = 0;
	lines.forEach((line, idx) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		messageCount += 1;
		let obj;
		try {
			obj = JSON.parse(trimmed);
		} catch (err) {
			errors.push(`line ${idx + 1}: ${String(err)}`);
			return;
		}
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
			errors.push(`line ${idx + 1}: expected JSON object`);
			return;
		}
		const record = obj;
		const actionKeys = A2UI_ACTION_KEYS.filter((key) => key in record);
		if (actionKeys.length !== 1) {
			errors.push(`line ${idx + 1}: expected exactly one action key (${A2UI_ACTION_KEYS.join(", ")})`);
			return;
		}
		if (actionKeys[0] === "createSurface") sawV09 = true;
		else sawV08 = true;
	});
	if (messageCount === 0) errors.push("no JSONL messages found");
	if (sawV08 && sawV09) errors.push("mixed A2UI v0.8 and v0.9 messages in one file");
	if (errors.length > 0) throw new Error(`Invalid A2UI JSONL:\n- ${errors.join("\n- ")}`);
	return {
		version: sawV09 ? "v0.9" : "v0.8",
		messageCount
	};
}
//#endregion
//#region extensions/canvas/src/cli.ts
function parseTimeoutMs(raw) {
	if (raw === void 0 || raw === null) return;
	const value = typeof raw === "number" || typeof raw === "bigint" ? Number(raw) : typeof raw === "string" && raw.trim() ? Number.parseInt(raw.trim(), 10) : NaN;
	return Number.isFinite(value) ? value : void 0;
}
function parseNodeCandidates(raw) {
	const payload = raw && typeof raw === "object" ? raw : {};
	return (Array.isArray(payload.nodes) ? payload.nodes : Array.isArray(payload.paired) ? payload.paired : []).map((entry) => {
		if (!entry || typeof entry !== "object") return null;
		const node = entry;
		if (typeof node.nodeId !== "string") return null;
		const candidate = { nodeId: node.nodeId };
		if (typeof node.displayName === "string") candidate.displayName = node.displayName;
		if (typeof node.remoteIp === "string") candidate.remoteIp = node.remoteIp;
		if (typeof node.connected === "boolean") candidate.connected = node.connected;
		if (typeof node.clientId === "string") candidate.clientId = node.clientId;
		return candidate;
	}).filter((entry) => entry !== null);
}
function unauthorizedHintForMessage(message) {
	const haystack = normalizeLowercaseStringOrEmpty(message);
	if (haystack.includes("unauthorizedclient") || haystack.includes("bridge client is not authorized") || haystack.includes("unsigned bridge clients are not allowed")) return [
		"peekaboo bridge rejected the client.",
		"sign the peekaboo CLI (TeamID Y5PE65HELJ) or launch the host with",
		"PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1 for local dev."
	].join(" ");
	return null;
}
function createDefaultCanvasCliDependencies() {
	const nodesCallOpts = (cmd, defaults) => cmd.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 1e4)).option("--json", "Output JSON", false);
	const callGatewayCli = async (method, opts, params, callOpts) => {
		const timeout = String(callOpts?.transportTimeoutMs ?? opts.timeout ?? 1e4);
		return await callGatewayFromCli(method, {
			...opts,
			timeout
		}, params, { progress: opts.json !== true });
	};
	return {
		defaultRuntime,
		nodesCallOpts,
		runNodesCommand: (label, action) => runCommandWithRuntime(defaultRuntime, action, (err) => {
			const message = formatErrorMessage(err);
			defaultRuntime.error(theme.error(`nodes ${label} failed: ${message}`));
			const hint = unauthorizedHintForMessage(message);
			if (hint) defaultRuntime.error(theme.warn(hint));
			defaultRuntime.exit(1);
		}),
		getNodesTheme: () => ({ ok: theme.success }),
		parseTimeoutMs,
		resolveNodeId: async (opts, query) => {
			let raw;
			try {
				raw = await callGatewayCli("node.list", opts, {});
			} catch {
				raw = await callGatewayCli("node.pair.list", opts, {});
			}
			return resolveNodeFromNodeList(parseNodeCandidates(raw), query).nodeId;
		},
		buildNodeInvokeParams: ({ nodeId, command, params, timeoutMs }) => ({
			nodeId,
			command,
			params,
			idempotencyKey: randomUUID(),
			...typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? { timeoutMs } : {}
		}),
		callGatewayCli,
		writeBase64ToFile: async (filePath, base64) => await fs.writeFile(filePath, Buffer.from(base64, "base64")),
		shortenHomePath
	};
}
async function invokeCanvas(deps, opts, command, params) {
	const nodeId = await deps.resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
	const timeoutMs = deps.parseTimeoutMs(opts.invokeTimeout);
	return await deps.callGatewayCli("node.invoke", opts, deps.buildNodeInvokeParams({
		nodeId,
		command,
		params,
		timeoutMs: typeof timeoutMs === "number" ? timeoutMs : void 0
	}));
}
function registerNodesCanvasCommands(nodes, deps) {
	const canvas = nodes.command("canvas").description("Capture or render canvas content from a paired node");
	deps.nodesCallOpts(canvas.command("snapshot").description("Capture a canvas snapshot (prints MEDIA:<path>)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--format <png|jpg|jpeg>", "Image format", "jpg").option("--max-width <px>", "Max width in px (optional)").option("--quality <0-1>", "JPEG quality (optional)").option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000").action(async (opts) => {
		await deps.runNodesCommand("canvas snapshot", async () => {
			const formatOpt = normalizeLowercaseStringOrEmpty(normalizeOptionalString(opts.format) ?? "jpg");
			const formatForParams = formatOpt === "jpg" ? "jpeg" : formatOpt === "jpeg" ? "jpeg" : "png";
			if (formatForParams !== "png" && formatForParams !== "jpeg") throw new Error(`invalid format: ${String(opts.format)} (expected png|jpg|jpeg)`);
			const maxWidth = opts.maxWidth ? Number.parseInt(opts.maxWidth, 10) : void 0;
			const quality = opts.quality ? Number.parseFloat(opts.quality) : void 0;
			const raw = await invokeCanvas(deps, opts, "canvas.snapshot", {
				format: formatForParams,
				maxWidth: Number.isFinite(maxWidth) ? maxWidth : void 0,
				quality: Number.isFinite(quality) ? quality : void 0
			});
			const payload = parseCanvasSnapshotPayload((typeof raw === "object" && raw !== null ? raw : {}).payload);
			const filePath = canvasSnapshotTempPath({ ext: payload.format === "jpeg" ? "jpg" : payload.format });
			await deps.writeBase64ToFile(filePath, payload.base64);
			if (opts.json) {
				deps.defaultRuntime.writeJson({ file: {
					path: filePath,
					format: payload.format
				} });
				return;
			}
			deps.defaultRuntime.log(`MEDIA:${deps.shortenHomePath(filePath)}`);
		});
	}), { timeoutMs: 6e4 });
	deps.nodesCallOpts(canvas.command("present").description("Show the canvas (optionally with a target URL/path)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--target <urlOrPath>", "Target URL/path (optional)").option("--x <px>", "Placement x coordinate").option("--y <px>", "Placement y coordinate").option("--width <px>", "Placement width").option("--height <px>", "Placement height").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await deps.runNodesCommand("canvas present", async () => {
			const placement = {
				x: opts.x ? Number.parseFloat(opts.x) : void 0,
				y: opts.y ? Number.parseFloat(opts.y) : void 0,
				width: opts.width ? Number.parseFloat(opts.width) : void 0,
				height: opts.height ? Number.parseFloat(opts.height) : void 0
			};
			const params = {};
			if (opts.target) params.url = opts.target;
			if (Number.isFinite(placement.x) || Number.isFinite(placement.y) || Number.isFinite(placement.width) || Number.isFinite(placement.height)) params.placement = placement;
			await invokeCanvas(deps, opts, "canvas.present", params);
			if (!opts.json) {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok("canvas present ok"));
			}
		});
	}));
	deps.nodesCallOpts(canvas.command("hide").description("Hide the canvas").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await deps.runNodesCommand("canvas hide", async () => {
			await invokeCanvas(deps, opts, "canvas.hide", void 0);
			if (!opts.json) {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok("canvas hide ok"));
			}
		});
	}));
	deps.nodesCallOpts(canvas.command("navigate").description("Navigate the canvas to a URL").argument("<url>", "Target URL/path").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (url, opts) => {
		await deps.runNodesCommand("canvas navigate", async () => {
			await invokeCanvas(deps, opts, "canvas.navigate", { url });
			if (!opts.json) {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok("canvas navigate ok"));
			}
		});
	}));
	deps.nodesCallOpts(canvas.command("eval").description("Evaluate JavaScript in the canvas").argument("[js]", "JavaScript to evaluate").option("--js <code>", "JavaScript to evaluate").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (jsArg, opts) => {
		await deps.runNodesCommand("canvas eval", async () => {
			const js = opts.js ?? jsArg;
			if (!js) throw new Error("missing --js or <js>");
			const raw = await invokeCanvas(deps, opts, "canvas.eval", { javaScript: js });
			if (opts.json) {
				deps.defaultRuntime.writeJson(raw);
				return;
			}
			const payload = typeof raw === "object" && raw !== null ? raw.payload : void 0;
			if (payload?.result) deps.defaultRuntime.log(payload.result);
			else {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok("canvas eval ok"));
			}
		});
	}));
	const a2ui = canvas.command("a2ui").description("Render A2UI content on the canvas");
	deps.nodesCallOpts(a2ui.command("push").description("Push A2UI JSONL to the canvas").option("--jsonl <path>", "Path to JSONL payload").option("--text <text>", "Render a quick A2UI text payload").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await deps.runNodesCommand("canvas a2ui push", async () => {
			const hasJsonl = Boolean(opts.jsonl);
			const hasText = typeof opts.text === "string";
			if (hasJsonl === hasText) throw new Error("provide exactly one of --jsonl or --text");
			const jsonl = hasText ? buildA2UITextJsonl(opts.text ?? "") : await fs.readFile(String(opts.jsonl), "utf8");
			const { version, messageCount } = validateA2UIJsonl(jsonl);
			if (version === "v0.9") throw new Error("Detected A2UI v0.9 JSONL (createSurface). OpenClaw currently supports v0.8 only.");
			await invokeCanvas(deps, opts, "canvas.a2ui.pushJSONL", { jsonl });
			if (!opts.json) {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok(`canvas a2ui push ok (v0.8, ${messageCount} message${messageCount === 1 ? "" : "s"})`));
			}
		});
	}));
	deps.nodesCallOpts(a2ui.command("reset").description("Reset A2UI renderer state").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await deps.runNodesCommand("canvas a2ui reset", async () => {
			await invokeCanvas(deps, opts, "canvas.a2ui.reset", void 0);
			if (!opts.json) {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok("canvas a2ui reset ok"));
			}
		});
	}));
}
//#endregion
export { registerNodesCanvasCommands as n, createDefaultCanvasCliDependencies as t };
