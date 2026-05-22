import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { t as formatDocsLink } from "./links-dQIIPEtq.js";
import { n as isRich, r as theme } from "./theme-CVJvORNs.js";
import { g as shortenHomePath, h as shortenHomeInString } from "./utils-D5swhEXt.js";
import { n as defaultRuntime } from "./runtime-bzt9CHmD.js";
import { t as sanitizeTerminalText } from "./safe-text-BT4s_OgE.js";
import { t as parseDurationMs } from "./parse-duration-DzllmOLM.js";
import { u as randomIdempotencyKey } from "./call-CNyRnB85.js";
import { a as parseCanvasSnapshotPayload, c as parseCameraSnapPayload, d as writeCameraPayloadToFile, i as canvasSnapshotTempPath, l as writeBase64ToFile, n as screenRecordTempPath, o as cameraTempPath, r as writeScreenRecordToFile, s as parseCameraClipPayload, t as parseScreenRecordPayload, u as writeCameraClipPayloadToFile } from "./nodes-screen-DamtAgtQ.js";
import { i as parsePairingList, r as parseNodeList } from "./node-resolve-C_cNP8ur.js";
import { t as parseTimeoutMs } from "./parse-timeout-DZuA3RH9.js";
import { n as formatTimeAgo } from "./format-relative-C1XMPyRD.js";
import { n as runCommandWithRuntime } from "./cli-utils-c5l36GrW.js";
import { t as formatHelpExamples } from "./help-format-GSSilIei.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-D7195Ysp.js";
import { a as resolveNodeId, i as resolveNode, n as callGatewayCli, o as unauthorizedHintForMessage, r as nodesCallOpts, s as formatPermissions, t as buildNodeInvokeParams } from "./rpc-bzfp3tEr.js";
import fs from "node:fs/promises";
//#region src/cli/nodes-cli/cli-utils.ts
function getNodesTheme() {
	const rich = isRich();
	const color = (fn) => (value) => rich ? fn(value) : value;
	return {
		rich,
		heading: color(theme.heading),
		ok: color(theme.success),
		warn: color(theme.warn),
		muted: color(theme.muted),
		error: color(theme.error)
	};
}
function runNodesCommand(label, action) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		const message = String(err);
		const { error, warn } = getNodesTheme();
		defaultRuntime.error(error(`nodes ${label} failed: ${message}`));
		const hint = unauthorizedHintForMessage(message);
		if (hint) defaultRuntime.error(warn(hint));
		defaultRuntime.exit(1);
	});
}
//#endregion
//#region src/cli/nodes-cli/register.camera.ts
const parseFacing = (value) => {
	const v = normalizeLowercaseStringOrEmpty(normalizeOptionalString(value) ?? "");
	if (v === "front" || v === "back") return v;
	throw new Error(`invalid facing: ${value} (expected front|back)`);
};
function getGatewayInvokePayload(raw) {
	return typeof raw === "object" && raw !== null ? raw.payload : void 0;
}
function registerNodesCameraCommands(nodes) {
	const camera = nodes.command("camera").description("Capture camera media from a paired node");
	nodesCallOpts(camera.command("list").description("List available cameras on a node").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").action(async (opts) => {
		await runNodesCommand("camera list", async () => {
			const raw = await callGatewayCli("node.invoke", opts, buildNodeInvokeParams({
				nodeId: await resolveNodeId(opts, opts.node ?? ""),
				command: "camera.list",
				params: {}
			}));
			const res = typeof raw === "object" && raw !== null ? raw : {};
			const payload = typeof res.payload === "object" && res.payload !== null ? res.payload : {};
			const devices = Array.isArray(payload.devices) ? payload.devices : [];
			if (opts.json) {
				defaultRuntime.writeJson(devices);
				return;
			}
			if (devices.length === 0) {
				const { muted } = getNodesTheme();
				defaultRuntime.log(muted("No cameras reported."));
				return;
			}
			const { heading, muted } = getNodesTheme();
			const tableWidth = getTerminalTableWidth();
			const rows = devices.map((device) => ({
				Name: typeof device.name === "string" ? device.name : "Unknown Camera",
				Position: typeof device.position === "string" ? device.position : muted("unspecified"),
				ID: typeof device.id === "string" ? device.id : ""
			}));
			defaultRuntime.log(heading("Cameras"));
			defaultRuntime.log(renderTable({
				width: tableWidth,
				columns: [
					{
						key: "Name",
						header: "Name",
						minWidth: 14,
						flex: true
					},
					{
						key: "Position",
						header: "Position",
						minWidth: 10
					},
					{
						key: "ID",
						header: "ID",
						minWidth: 10,
						flex: true
					}
				],
				rows
			}).trimEnd());
		});
	}), { timeoutMs: 6e4 });
	nodesCallOpts(camera.command("snap").description("Capture a photo from a node camera (prints MEDIA:<path>)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--facing <front|back|both>", "Camera facing", "both").option("--device-id <id>", "Camera device id (from nodes camera list)").option("--max-width <px>", "Max width in px (optional)").option("--quality <0-1>", "JPEG quality (default 0.9)").option("--delay-ms <ms>", "Delay before capture in ms (macOS default 2000)").option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000").action(async (opts) => {
		await runNodesCommand("camera snap", async () => {
			const node = await resolveNode(opts, normalizeOptionalString(opts.node) ?? "");
			const nodeId = node.nodeId;
			const facingOpt = normalizeLowercaseStringOrEmpty(normalizeOptionalString(opts.facing) ?? "both");
			const facings = facingOpt === "both" ? ["front", "back"] : facingOpt === "front" || facingOpt === "back" ? [facingOpt] : (() => {
				throw new Error(`invalid facing: ${String(opts.facing)} (expected front|back|both)`);
			})();
			const maxWidth = opts.maxWidth ? Number.parseInt(opts.maxWidth, 10) : void 0;
			const quality = opts.quality ? Number.parseFloat(opts.quality) : void 0;
			const delayMs = opts.delayMs ? Number.parseInt(opts.delayMs, 10) : void 0;
			const deviceId = normalizeOptionalString(opts.deviceId);
			if (deviceId && facings.length > 1) throw new Error("facing=both is not allowed when --device-id is set");
			const timeoutMs = opts.invokeTimeout ? Number.parseInt(opts.invokeTimeout, 10) : void 0;
			const results = [];
			for (const facing of facings) {
				const payload = parseCameraSnapPayload(getGatewayInvokePayload(await callGatewayCli("node.invoke", opts, buildNodeInvokeParams({
					nodeId,
					command: "camera.snap",
					params: {
						facing,
						maxWidth: Number.isFinite(maxWidth) ? maxWidth : void 0,
						quality: Number.isFinite(quality) ? quality : void 0,
						format: "jpg",
						delayMs: Number.isFinite(delayMs) ? delayMs : void 0,
						deviceId: deviceId || void 0
					},
					timeoutMs
				}))));
				const filePath = cameraTempPath({
					kind: "snap",
					facing,
					ext: payload.format === "jpeg" ? "jpg" : payload.format
				});
				await writeCameraPayloadToFile({
					filePath,
					payload,
					expectedHost: node.remoteIp,
					invalidPayloadMessage: "invalid camera.snap payload"
				});
				results.push({
					facing,
					path: filePath,
					width: payload.width,
					height: payload.height
				});
			}
			if (opts.json) {
				defaultRuntime.writeJson({ files: results });
				return;
			}
			defaultRuntime.log(results.map((r) => `MEDIA:${shortenHomePath(r.path)}`).join("\n"));
		});
	}), { timeoutMs: 6e4 });
	nodesCallOpts(camera.command("clip").description("Capture a short video clip from a node camera (prints MEDIA:<path>)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--facing <front|back>", "Camera facing", "front").option("--device-id <id>", "Camera device id (from nodes camera list)").option("--duration <ms|10s|1m>", "Duration (default 3000ms; supports ms/s/m, e.g. 10s)", "3000").option("--no-audio", "Disable audio capture").option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 90000)", "90000").action(async (opts) => {
		await runNodesCommand("camera clip", async () => {
			const node = await resolveNode(opts, normalizeOptionalString(opts.node) ?? "");
			const nodeId = node.nodeId;
			const facing = parseFacing(opts.facing ?? "front");
			const durationMs = parseDurationMs(opts.duration ?? "3000");
			const includeAudio = opts.audio !== false;
			const timeoutMs = opts.invokeTimeout ? Number.parseInt(opts.invokeTimeout, 10) : void 0;
			const deviceId = normalizeOptionalString(opts.deviceId);
			const payload = parseCameraClipPayload(getGatewayInvokePayload(await callGatewayCli("node.invoke", opts, buildNodeInvokeParams({
				nodeId,
				command: "camera.clip",
				params: {
					facing,
					durationMs: Number.isFinite(durationMs) ? durationMs : void 0,
					includeAudio,
					format: "mp4",
					deviceId: deviceId || void 0
				},
				timeoutMs
			}))));
			const filePath = await writeCameraClipPayloadToFile({
				payload,
				facing,
				expectedHost: node.remoteIp
			});
			if (opts.json) {
				defaultRuntime.writeJson({ file: {
					facing,
					path: filePath,
					durationMs: payload.durationMs,
					hasAudio: payload.hasAudio
				} });
				return;
			}
			defaultRuntime.log(`MEDIA:${shortenHomePath(filePath)}`);
		});
	}), { timeoutMs: 9e4 });
}
//#endregion
//#region src/cli/nodes-cli/a2ui-jsonl.ts
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
//#region src/cli/nodes-cli/register.canvas.ts
async function invokeCanvas(opts, command, params) {
	const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
	const timeoutMs = parseTimeoutMs(opts.invokeTimeout);
	return await callGatewayCli("node.invoke", opts, buildNodeInvokeParams({
		nodeId,
		command,
		params,
		timeoutMs: typeof timeoutMs === "number" ? timeoutMs : void 0
	}));
}
function registerNodesCanvasCommands(nodes) {
	const canvas = nodes.command("canvas").description("Capture or render canvas content from a paired node");
	nodesCallOpts(canvas.command("snapshot").description("Capture a canvas snapshot (prints MEDIA:<path>)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--format <png|jpg|jpeg>", "Image format", "jpg").option("--max-width <px>", "Max width in px (optional)").option("--quality <0-1>", "JPEG quality (optional)").option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000").action(async (opts) => {
		await runNodesCommand("canvas snapshot", async () => {
			const formatOpt = normalizeLowercaseStringOrEmpty(normalizeOptionalString(opts.format) ?? "jpg");
			const formatForParams = formatOpt === "jpg" ? "jpeg" : formatOpt === "jpeg" ? "jpeg" : "png";
			if (formatForParams !== "png" && formatForParams !== "jpeg") throw new Error(`invalid format: ${String(opts.format)} (expected png|jpg|jpeg)`);
			const maxWidth = opts.maxWidth ? Number.parseInt(opts.maxWidth, 10) : void 0;
			const quality = opts.quality ? Number.parseFloat(opts.quality) : void 0;
			const raw = await invokeCanvas(opts, "canvas.snapshot", {
				format: formatForParams,
				maxWidth: Number.isFinite(maxWidth) ? maxWidth : void 0,
				quality: Number.isFinite(quality) ? quality : void 0
			});
			const payload = parseCanvasSnapshotPayload((typeof raw === "object" && raw !== null ? raw : {}).payload);
			const filePath = canvasSnapshotTempPath({ ext: payload.format === "jpeg" ? "jpg" : payload.format });
			await writeBase64ToFile(filePath, payload.base64);
			if (opts.json) {
				defaultRuntime.writeJson({ file: {
					path: filePath,
					format: payload.format
				} });
				return;
			}
			defaultRuntime.log(`MEDIA:${shortenHomePath(filePath)}`);
		});
	}), { timeoutMs: 6e4 });
	nodesCallOpts(canvas.command("present").description("Show the canvas (optionally with a target URL/path)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--target <urlOrPath>", "Target URL/path (optional)").option("--x <px>", "Placement x coordinate").option("--y <px>", "Placement y coordinate").option("--width <px>", "Placement width").option("--height <px>", "Placement height").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await runNodesCommand("canvas present", async () => {
			const placement = {
				x: opts.x ? Number.parseFloat(opts.x) : void 0,
				y: opts.y ? Number.parseFloat(opts.y) : void 0,
				width: opts.width ? Number.parseFloat(opts.width) : void 0,
				height: opts.height ? Number.parseFloat(opts.height) : void 0
			};
			const params = {};
			if (opts.target) params.url = opts.target;
			if (Number.isFinite(placement.x) || Number.isFinite(placement.y) || Number.isFinite(placement.width) || Number.isFinite(placement.height)) params.placement = placement;
			await invokeCanvas(opts, "canvas.present", params);
			if (!opts.json) {
				const { ok } = getNodesTheme();
				defaultRuntime.log(ok("canvas present ok"));
			}
		});
	}));
	nodesCallOpts(canvas.command("hide").description("Hide the canvas").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await runNodesCommand("canvas hide", async () => {
			await invokeCanvas(opts, "canvas.hide", void 0);
			if (!opts.json) {
				const { ok } = getNodesTheme();
				defaultRuntime.log(ok("canvas hide ok"));
			}
		});
	}));
	nodesCallOpts(canvas.command("navigate").description("Navigate the canvas to a URL").argument("<url>", "Target URL/path").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (url, opts) => {
		await runNodesCommand("canvas navigate", async () => {
			await invokeCanvas(opts, "canvas.navigate", { url });
			if (!opts.json) {
				const { ok } = getNodesTheme();
				defaultRuntime.log(ok("canvas navigate ok"));
			}
		});
	}));
	nodesCallOpts(canvas.command("eval").description("Evaluate JavaScript in the canvas").argument("[js]", "JavaScript to evaluate").option("--js <code>", "JavaScript to evaluate").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (jsArg, opts) => {
		await runNodesCommand("canvas eval", async () => {
			const js = opts.js ?? jsArg;
			if (!js) throw new Error("missing --js or <js>");
			const raw = await invokeCanvas(opts, "canvas.eval", { javaScript: js });
			if (opts.json) {
				defaultRuntime.writeJson(raw);
				return;
			}
			const payload = typeof raw === "object" && raw !== null ? raw.payload : void 0;
			if (payload?.result) defaultRuntime.log(payload.result);
			else {
				const { ok } = getNodesTheme();
				defaultRuntime.log(ok("canvas eval ok"));
			}
		});
	}));
	const a2ui = canvas.command("a2ui").description("Render A2UI content on the canvas");
	nodesCallOpts(a2ui.command("push").description("Push A2UI JSONL to the canvas").option("--jsonl <path>", "Path to JSONL payload").option("--text <text>", "Render a quick A2UI text payload").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await runNodesCommand("canvas a2ui push", async () => {
			const hasJsonl = Boolean(opts.jsonl);
			const hasText = typeof opts.text === "string";
			if (hasJsonl === hasText) throw new Error("provide exactly one of --jsonl or --text");
			const jsonl = hasText ? buildA2UITextJsonl(opts.text ?? "") : await fs.readFile(String(opts.jsonl), "utf8");
			const { version, messageCount } = validateA2UIJsonl(jsonl);
			if (version === "v0.9") throw new Error("Detected A2UI v0.9 JSONL (createSurface). OpenClaw currently supports v0.8 only.");
			await invokeCanvas(opts, "canvas.a2ui.pushJSONL", { jsonl });
			if (!opts.json) {
				const { ok } = getNodesTheme();
				defaultRuntime.log(ok(`canvas a2ui push ok (v0.8, ${messageCount} message${messageCount === 1 ? "" : "s"})`));
			}
		});
	}));
	nodesCallOpts(a2ui.command("reset").description("Reset A2UI renderer state").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await runNodesCommand("canvas a2ui reset", async () => {
			await invokeCanvas(opts, "canvas.a2ui.reset", void 0);
			if (!opts.json) {
				const { ok } = getNodesTheme();
				defaultRuntime.log(ok("canvas a2ui reset ok"));
			}
		});
	}));
}
//#endregion
//#region src/cli/nodes-cli/register.invoke.ts
const BLOCKED_NODE_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);
function registerNodesInvokeCommands(nodes) {
	nodesCallOpts(nodes.command("invoke").description("Invoke a command on a paired node").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").requiredOption("--command <command>", "Command (e.g. canvas.eval)").option("--params <json>", "JSON object string for params", "{}").option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 15000)", "15000").option("--idempotency-key <key>", "Idempotency key (optional)").action(async (opts) => {
		await runNodesCommand("invoke", async () => {
			const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
			const command = normalizeOptionalString(opts.command) ?? "";
			if (!nodeId || !command) {
				const { error } = getNodesTheme();
				defaultRuntime.error(error("--node and --command required"));
				defaultRuntime.exit(1);
				return;
			}
			if (BLOCKED_NODE_INVOKE_COMMANDS.has(normalizeLowercaseStringOrEmpty(command))) throw new Error(`command "${command}" is reserved for shell execution; use the exec tool with host=node instead`);
			const params = JSON.parse(opts.params ?? "{}");
			const timeoutMs = opts.invokeTimeout ? Number.parseInt(opts.invokeTimeout, 10) : void 0;
			const invokeParams = {
				nodeId,
				command,
				params,
				idempotencyKey: opts.idempotencyKey ?? randomIdempotencyKey()
			};
			if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) invokeParams.timeoutMs = timeoutMs;
			const result = await callGatewayCli("node.invoke", opts, invokeParams);
			defaultRuntime.writeJson(result);
		});
	}), { timeoutMs: 3e4 });
}
//#endregion
//#region src/cli/nodes-cli/register.location.ts
function registerNodesLocationCommands(nodes) {
	nodesCallOpts(nodes.command("location").description("Fetch location from a paired node").command("get").description("Fetch the current location from a node").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--max-age <ms>", "Use cached location newer than this (ms)").option("--accuracy <coarse|balanced|precise>", "Desired accuracy (default: balanced/precise depending on node setting)").option("--location-timeout <ms>", "Location fix timeout (ms)", "10000").option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000").action(async (opts) => {
		await runNodesCommand("location get", async () => {
			const nodeId = await resolveNodeId(opts, opts.node ?? "");
			const maxAgeMs = opts.maxAge ? Number.parseInt(opts.maxAge, 10) : void 0;
			const desiredAccuracyRaw = normalizeOptionalLowercaseString(opts.accuracy);
			const desiredAccuracy = desiredAccuracyRaw === "coarse" || desiredAccuracyRaw === "balanced" || desiredAccuracyRaw === "precise" ? desiredAccuracyRaw : void 0;
			const timeoutMs = opts.locationTimeout ? Number.parseInt(opts.locationTimeout, 10) : void 0;
			const invokeTimeoutMs = opts.invokeTimeout ? Number.parseInt(opts.invokeTimeout, 10) : void 0;
			const invokeParams = {
				nodeId,
				command: "location.get",
				params: {
					maxAgeMs: Number.isFinite(maxAgeMs) ? maxAgeMs : void 0,
					desiredAccuracy,
					timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : void 0
				},
				idempotencyKey: randomIdempotencyKey()
			};
			if (typeof invokeTimeoutMs === "number" && Number.isFinite(invokeTimeoutMs)) invokeParams.timeoutMs = invokeTimeoutMs;
			const raw = await callGatewayCli("node.invoke", opts, invokeParams);
			const res = typeof raw === "object" && raw !== null ? raw : {};
			const payload = res.payload && typeof res.payload === "object" ? res.payload : {};
			if (opts.json) {
				defaultRuntime.writeJson(payload);
				return;
			}
			const lat = payload.lat;
			const lon = payload.lon;
			const acc = payload.accuracyMeters;
			if (typeof lat === "number" && typeof lon === "number") {
				const accText = typeof acc === "number" ? ` ±${acc.toFixed(1)}m` : "";
				defaultRuntime.log(`${lat},${lon}${accText}`);
				return;
			}
			defaultRuntime.writeJson(payload, 0);
		});
	}), { timeoutMs: 3e4 });
}
//#endregion
//#region src/cli/nodes-cli/register.notify.ts
function registerNodesNotifyCommand(nodes) {
	nodesCallOpts(nodes.command("notify").description("Send a local notification on a node (mac only)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--title <text>", "Notification title").option("--body <text>", "Notification body").option("--sound <name>", "Notification sound").option("--priority <passive|active|timeSensitive>", "Notification priority").option("--delivery <system|overlay|auto>", "Delivery mode", "system").option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 15000)", "15000").action(async (opts) => {
		await runNodesCommand("notify", async () => {
			const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
			const title = normalizeOptionalString(opts.title) ?? "";
			const body = normalizeOptionalString(opts.body) ?? "";
			if (!title && !body) throw new Error("missing --title or --body");
			const invokeTimeout = opts.invokeTimeout ? Number.parseInt(opts.invokeTimeout, 10) : void 0;
			const invokeParams = {
				nodeId,
				command: "system.notify",
				params: {
					title,
					body,
					sound: opts.sound,
					priority: opts.priority,
					delivery: opts.delivery
				},
				idempotencyKey: opts.idempotencyKey ?? randomIdempotencyKey()
			};
			if (typeof invokeTimeout === "number" && Number.isFinite(invokeTimeout)) invokeParams.timeoutMs = invokeTimeout;
			const result = await callGatewayCli("node.invoke", opts, invokeParams);
			if (opts.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			const { ok } = getNodesTheme();
			defaultRuntime.log(ok("notify ok"));
		});
	}));
}
//#endregion
//#region src/cli/nodes-cli/pairing-render.ts
function renderPendingPairingRequestsTable(params) {
	const { pending, now, tableWidth, theme } = params;
	const rows = pending.map((r) => {
		const nodeLabel = r.displayName?.trim() ? r.displayName.trim() : r.nodeId;
		return {
			Request: sanitizeTerminalText(r.requestId),
			Node: sanitizeTerminalText(nodeLabel),
			IP: sanitizeTerminalText(r.remoteIp ?? ""),
			Requested: typeof r.ts === "number" ? formatTimeAgo(Math.max(0, now - r.ts)) : theme.muted("unknown")
		};
	});
	return {
		heading: theme.heading("Pending"),
		table: renderTable({
			width: tableWidth,
			columns: [
				{
					key: "Request",
					header: "Request",
					minWidth: 8
				},
				{
					key: "Node",
					header: "Node",
					minWidth: 14,
					flex: true
				},
				{
					key: "IP",
					header: "IP",
					minWidth: 10
				},
				{
					key: "Requested",
					header: "Requested",
					minWidth: 12
				}
			],
			rows
		}).trimEnd()
	};
}
//#endregion
//#region src/cli/nodes-cli/register.pairing.ts
function registerNodesPairingCommands(nodes) {
	nodesCallOpts(nodes.command("pending").description("List pending pairing requests").action(async (opts) => {
		await runNodesCommand("pending", async () => {
			const { pending } = parsePairingList(await callGatewayCli("node.pair.list", opts, {}));
			if (opts.json) {
				defaultRuntime.writeJson(pending);
				return;
			}
			if (pending.length === 0) {
				const { muted } = getNodesTheme();
				defaultRuntime.log(muted("No pending pairing requests."));
				return;
			}
			const { heading, warn, muted } = getNodesTheme();
			const tableWidth = getTerminalTableWidth();
			const rendered = renderPendingPairingRequestsTable({
				pending,
				now: Date.now(),
				tableWidth,
				theme: {
					heading,
					warn,
					muted
				}
			});
			defaultRuntime.log(rendered.heading);
			defaultRuntime.log(rendered.table);
		});
	}));
	nodesCallOpts(nodes.command("approve").description("Approve a pending pairing request").argument("<requestId>", "Pending request id").action(async (requestId, opts) => {
		await runNodesCommand("approve", async () => {
			const result = await callGatewayCli("node.pair.approve", opts, { requestId });
			defaultRuntime.writeJson(result);
		});
	}));
	nodesCallOpts(nodes.command("reject").description("Reject a pending pairing request").argument("<requestId>", "Pending request id").action(async (requestId, opts) => {
		await runNodesCommand("reject", async () => {
			const result = await callGatewayCli("node.pair.reject", opts, { requestId });
			defaultRuntime.writeJson(result);
		});
	}));
	nodesCallOpts(nodes.command("remove").description("Remove a paired node entry").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").action(async (opts) => {
		await runNodesCommand("remove", async () => {
			const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
			if (!nodeId) {
				defaultRuntime.error("--node required");
				defaultRuntime.exit(1);
				return;
			}
			const result = await callGatewayCli("node.pair.remove", opts, { nodeId });
			if (opts.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			const { warn } = getNodesTheme();
			defaultRuntime.log(warn(`Removed paired node ${nodeId}`));
		});
	}));
	nodesCallOpts(nodes.command("rename").description("Rename a paired node (display name override)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").requiredOption("--name <displayName>", "New display name").action(async (opts) => {
		await runNodesCommand("rename", async () => {
			const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
			const name = normalizeOptionalString(opts.name) ?? "";
			if (!nodeId || !name) {
				defaultRuntime.error("--node and --name required");
				defaultRuntime.exit(1);
				return;
			}
			const result = await callGatewayCli("node.rename", opts, {
				nodeId,
				displayName: name
			});
			if (opts.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			const { ok } = getNodesTheme();
			defaultRuntime.log(ok(`node rename ok: ${nodeId} -> ${name}`));
		});
	}));
}
//#endregion
//#region src/cli/nodes-cli/register.push.ts
function normalizeEnvironment(value) {
	if (typeof value !== "string") return null;
	const normalized = normalizeOptionalLowercaseString(value);
	if (normalized === "sandbox" || normalized === "production") return normalized;
	return null;
}
function registerNodesPushCommand(nodes) {
	nodesCallOpts(nodes.command("push").description("Send an APNs test push to an iOS node").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--title <text>", "Push title", "OpenClaw").option("--body <text>", "Push body").option("--environment <sandbox|production>", "Override APNs environment").action(async (opts) => {
		await runNodesCommand("push", async () => {
			const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
			const title = normalizeOptionalString(opts.title) || "OpenClaw";
			const body = normalizeOptionalString(opts.body) || `Push test for node ${nodeId}`;
			const environment = normalizeEnvironment(opts.environment);
			if (opts.environment && !environment) throw new Error("invalid --environment (use sandbox|production)");
			const params = {
				nodeId,
				title,
				body
			};
			if (environment) params.environment = environment;
			const result = await callGatewayCli("push.test", opts, params);
			if (opts.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			const parsed = typeof result === "object" && result !== null ? result : {};
			const ok = parsed.ok === true;
			const status = typeof parsed.status === "number" ? parsed.status : 0;
			const reason = typeof parsed.reason === "string" ? normalizeOptionalString(parsed.reason) : void 0;
			const env = typeof parsed.environment === "string" ? normalizeOptionalString(parsed.environment) ?? "unknown" : "unknown";
			const { ok: okLabel, error: errorLabel } = getNodesTheme();
			const label = ok ? okLabel : errorLabel;
			defaultRuntime.log(label(`push.test status=${status} ok=${ok} env=${env}`));
			if (reason) defaultRuntime.log(`reason: ${reason}`);
		});
	}), { timeoutMs: 25e3 });
}
//#endregion
//#region src/cli/nodes-cli/register.screen.ts
function registerNodesScreenCommands(nodes) {
	nodesCallOpts(nodes.command("screen").description("Capture screen recordings from a paired node").command("record").description("Capture a short screen recording from a node (prints MEDIA:<path>)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--screen <index>", "Screen index (0 = primary)", "0").option("--duration <ms|10s>", "Clip duration (ms or 10s)", "10000").option("--fps <fps>", "Frames per second", "10").option("--no-audio", "Disable microphone audio capture").option("--out <path>", "Output path").option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 120000)", "120000").action(async (opts) => {
		await runNodesCommand("screen record", async () => {
			const nodeId = await resolveNodeId(opts, opts.node ?? "");
			const durationMs = parseDurationMs(opts.duration ?? "");
			const screenIndex = Number.parseInt(opts.screen ?? "0", 10);
			const fps = Number.parseFloat(opts.fps ?? "10");
			const timeoutMs = opts.invokeTimeout ? Number.parseInt(opts.invokeTimeout, 10) : void 0;
			const raw = await callGatewayCli("node.invoke", opts, buildNodeInvokeParams({
				nodeId,
				command: "screen.record",
				params: {
					durationMs: Number.isFinite(durationMs) ? durationMs : void 0,
					screenIndex: Number.isFinite(screenIndex) ? screenIndex : void 0,
					fps: Number.isFinite(fps) ? fps : void 0,
					format: "mp4",
					includeAudio: opts.audio !== false
				},
				timeoutMs
			}));
			const parsed = parseScreenRecordPayload((typeof raw === "object" && raw !== null ? raw : {}).payload);
			const written = await writeScreenRecordToFile(opts.out ?? screenRecordTempPath({ ext: parsed.format || "mp4" }), parsed.base64);
			if (opts.json) {
				defaultRuntime.writeJson({ file: {
					path: written.path,
					durationMs: parsed.durationMs,
					fps: parsed.fps,
					screenIndex: parsed.screenIndex,
					hasAudio: parsed.hasAudio
				} });
				return;
			}
			defaultRuntime.log(`MEDIA:${shortenHomePath(written.path)}`);
		});
	}), { timeoutMs: 18e4 });
}
//#endregion
//#region src/cli/nodes-cli/register.status.ts
function formatVersionLabel(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return raw;
	if (normalizeLowercaseStringOrEmpty(trimmed).startsWith("v")) return trimmed;
	return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed;
}
function resolveNodeVersions(node) {
	const core = normalizeOptionalString(node.coreVersion);
	const ui = normalizeOptionalString(node.uiVersion);
	if (core || ui) return {
		core,
		ui
	};
	const legacy = node.version?.trim();
	if (!legacy) return {
		core: void 0,
		ui: void 0
	};
	const platform = normalizeOptionalLowercaseString(node.platform) ?? "";
	return platform === "darwin" || platform === "linux" || platform === "win32" || platform === "windows" ? {
		core: legacy,
		ui: void 0
	} : {
		core: void 0,
		ui: legacy
	};
}
function formatNodeVersions(node) {
	const { core, ui } = resolveNodeVersions(node);
	const parts = [];
	if (core) parts.push(`core ${formatVersionLabel(core)}`);
	if (ui) parts.push(`ui ${formatVersionLabel(ui)}`);
	return parts.length > 0 ? parts.join(" · ") : null;
}
function formatPathEnv(raw) {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const parts = trimmed.split(":").filter(Boolean);
	return shortenHomeInString(parts.length <= 3 ? trimmed : `${parts.slice(0, 2).join(":")}:…:${parts.slice(-1)[0]}`);
}
function formatClientLabel(node) {
	const clientId = node.clientId?.trim();
	const clientMode = node.clientMode?.trim();
	if (clientId && clientMode) return `${clientId}/${clientMode}`;
	return clientId || clientMode || null;
}
function formatNodeTerminalLabel(node) {
	return sanitizeTerminalText(node.displayName?.trim() ? node.displayName.trim() : node.nodeId);
}
function parseSinceMs(raw, label) {
	if (raw === void 0 || raw === null) return;
	const value = normalizeOptionalString(raw) ?? (typeof raw === "number" ? String(raw) : null);
	if (value === null) {
		defaultRuntime.error(`${label}: invalid duration value`);
		defaultRuntime.exit(1);
		return;
	}
	if (!value) return;
	try {
		return parseDurationMs(value);
	} catch (err) {
		const message = formatErrorMessage(err);
		defaultRuntime.error(`${label}: ${message}`);
		defaultRuntime.exit(1);
		return;
	}
}
function mergePairedNodeWithEffectiveNode(paired, effective) {
	return {
		...paired,
		...effective,
		token: paired?.token,
		createdAtMs: paired?.createdAtMs,
		lastConnectedAtMs: paired?.lastConnectedAtMs ?? effective.connectedAtMs,
		displayName: effective.displayName ?? paired?.displayName,
		platform: effective.platform ?? paired?.platform,
		version: effective.version ?? paired?.version,
		coreVersion: effective.coreVersion ?? paired?.coreVersion,
		uiVersion: effective.uiVersion ?? paired?.uiVersion,
		remoteIp: effective.remoteIp ?? paired?.remoteIp,
		permissions: effective.permissions ?? paired?.permissions,
		approvedAtMs: effective.approvedAtMs ?? paired?.approvedAtMs
	};
}
function mergePairedNodesWithEffectiveNodes(paired, effectiveNodes) {
	if (effectiveNodes === null) return paired;
	const pairedById = new Map(paired.map((node) => [node.nodeId, node]));
	const seen = /* @__PURE__ */ new Set();
	const rows = [];
	for (const effective of effectiveNodes) {
		const pairedNode = pairedById.get(effective.nodeId);
		if (!pairedNode && effective.paired !== true) continue;
		seen.add(effective.nodeId);
		rows.push(mergePairedNodeWithEffectiveNode(pairedNode, effective));
	}
	for (const node of paired) if (!seen.has(node.nodeId)) rows.push(node);
	return rows;
}
async function tryReadNodeList(opts) {
	try {
		return parseNodeList(await callGatewayCli("node.list", opts, {}));
	} catch {
		return null;
	}
}
function sanitizePairedNodeForListJson(node) {
	const copy = { ...node };
	delete copy.token;
	return copy;
}
function registerNodesStatusCommands(nodes) {
	nodesCallOpts(nodes.command("status").description("List known nodes with connection status and capabilities").option("--connected", "Only show connected nodes").option("--last-connected <duration>", "Only show nodes connected within duration (e.g. 24h)").action(async (opts) => {
		await runNodesCommand("status", async () => {
			const connectedOnly = Boolean(opts.connected);
			const sinceMs = parseSinceMs(opts.lastConnected, "Invalid --last-connected");
			const result = await callGatewayCli("node.list", opts, {});
			const obj = typeof result === "object" && result !== null ? result : {};
			const { ok, warn, muted } = getNodesTheme();
			const tableWidth = getTerminalTableWidth();
			const now = Date.now();
			const nodes = parseNodeList(result);
			const lastConnectedById = sinceMs !== void 0 ? new Map(parsePairingList(await callGatewayCli("node.pair.list", opts, {})).paired.map((entry) => [entry.nodeId, entry])) : null;
			const filtered = nodes.filter((n) => {
				if (connectedOnly && !n.connected) return false;
				if (sinceMs !== void 0) {
					const paired = lastConnectedById?.get(n.nodeId);
					const lastConnectedAtMs = typeof paired?.lastConnectedAtMs === "number" ? paired.lastConnectedAtMs : typeof n.connectedAtMs === "number" ? n.connectedAtMs : void 0;
					if (typeof lastConnectedAtMs !== "number") return false;
					if (now - lastConnectedAtMs > sinceMs) return false;
				}
				return true;
			});
			if (opts.json) {
				const ts = typeof obj.ts === "number" ? obj.ts : Date.now();
				defaultRuntime.writeJson({
					...obj,
					ts,
					nodes: filtered
				});
				return;
			}
			const pairedCount = filtered.filter((n) => Boolean(n.paired)).length;
			const connectedCount = filtered.filter((n) => Boolean(n.connected)).length;
			const filteredLabel = filtered.length !== nodes.length ? ` (of ${nodes.length})` : "";
			defaultRuntime.log(`Known: ${filtered.length}${filteredLabel} · Paired: ${pairedCount} · Connected: ${connectedCount}`);
			if (filtered.length === 0) return;
			const rows = filtered.map((n) => {
				const perms = formatPermissions(n.permissions);
				const versions = formatNodeVersions(n);
				const pathEnv = formatPathEnv(n.pathEnv);
				const client = formatClientLabel(n);
				const detailParts = [
					client ? `client: ${client}` : null,
					n.deviceFamily ? `device: ${n.deviceFamily}` : null,
					n.modelIdentifier ? `hw: ${n.modelIdentifier}` : null,
					perms ? `perms: ${perms}` : null,
					versions,
					pathEnv ? `path: ${pathEnv}` : null
				].filter(Boolean).map((part) => sanitizeTerminalText(String(part)));
				const caps = Array.isArray(n.caps) ? sanitizeTerminalText(n.caps.map(String).filter(Boolean).toSorted().join(", ")) : "?";
				const paired = n.paired ? ok("paired") : warn("unpaired");
				const connected = n.connected ? ok("connected") : muted("disconnected");
				const since = typeof n.connectedAtMs === "number" ? ` (${formatTimeAgo(Math.max(0, now - n.connectedAtMs))})` : "";
				return {
					Node: formatNodeTerminalLabel(n),
					ID: sanitizeTerminalText(n.nodeId),
					IP: sanitizeTerminalText(n.remoteIp ?? ""),
					Detail: detailParts.join(" · "),
					Status: `${paired} · ${connected}${since}`,
					Caps: caps
				};
			});
			defaultRuntime.log(renderTable({
				width: tableWidth,
				columns: [
					{
						key: "Node",
						header: "Node",
						minWidth: 14,
						flex: true
					},
					{
						key: "ID",
						header: "ID",
						minWidth: 10
					},
					{
						key: "IP",
						header: "IP",
						minWidth: 10
					},
					{
						key: "Detail",
						header: "Detail",
						minWidth: 18,
						flex: true
					},
					{
						key: "Status",
						header: "Status",
						minWidth: 18
					},
					{
						key: "Caps",
						header: "Caps",
						minWidth: 12,
						flex: true
					}
				],
				rows
			}).trimEnd());
		});
	}));
	nodesCallOpts(nodes.command("describe").description("Describe a node (capabilities + supported invoke commands)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").action(async (opts) => {
		await runNodesCommand("describe", async () => {
			const nodeId = await resolveNodeId(opts, opts.node ?? "");
			const result = await callGatewayCli("node.describe", opts, { nodeId });
			if (opts.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			const obj = typeof result === "object" && result !== null ? result : {};
			const displayName = typeof obj.displayName === "string" ? obj.displayName : nodeId;
			const connected = Boolean(obj.connected);
			const paired = Boolean(obj.paired);
			const caps = Array.isArray(obj.caps) ? obj.caps.map(String).filter(Boolean).toSorted() : null;
			const commands = Array.isArray(obj.commands) ? obj.commands.map(String).filter(Boolean).toSorted() : [];
			const perms = formatPermissions(obj.permissions);
			const family = typeof obj.deviceFamily === "string" ? obj.deviceFamily : null;
			const model = typeof obj.modelIdentifier === "string" ? obj.modelIdentifier : null;
			const client = formatClientLabel(obj);
			const ip = typeof obj.remoteIp === "string" ? obj.remoteIp : null;
			const pathEnv = typeof obj.pathEnv === "string" ? obj.pathEnv : null;
			const versions = formatNodeVersions(obj);
			const { heading, ok, warn, muted } = getNodesTheme();
			const status = `${paired ? ok("paired") : warn("unpaired")} · ${connected ? ok("connected") : muted("disconnected")}`;
			const tableWidth = getTerminalTableWidth();
			const rows = [
				{
					Field: "ID",
					Value: sanitizeTerminalText(nodeId)
				},
				displayName ? {
					Field: "Name",
					Value: sanitizeTerminalText(displayName)
				} : null,
				client ? {
					Field: "Client",
					Value: sanitizeTerminalText(client)
				} : null,
				ip ? {
					Field: "IP",
					Value: sanitizeTerminalText(ip)
				} : null,
				family ? {
					Field: "Device",
					Value: sanitizeTerminalText(family)
				} : null,
				model ? {
					Field: "Model",
					Value: sanitizeTerminalText(model)
				} : null,
				perms ? {
					Field: "Perms",
					Value: sanitizeTerminalText(perms)
				} : null,
				versions ? {
					Field: "Version",
					Value: sanitizeTerminalText(versions)
				} : null,
				pathEnv ? {
					Field: "PATH",
					Value: sanitizeTerminalText(pathEnv)
				} : null,
				{
					Field: "Status",
					Value: status
				},
				{
					Field: "Caps",
					Value: caps ? sanitizeTerminalText(caps.join(", ")) : "?"
				}
			].filter(Boolean);
			defaultRuntime.log(heading("Node"));
			defaultRuntime.log(renderTable({
				width: tableWidth,
				columns: [{
					key: "Field",
					header: "Field",
					minWidth: 8
				}, {
					key: "Value",
					header: "Value",
					minWidth: 24,
					flex: true
				}],
				rows
			}).trimEnd());
			defaultRuntime.log("");
			defaultRuntime.log(heading("Commands"));
			if (commands.length === 0) {
				defaultRuntime.log(muted("- (none reported)"));
				return;
			}
			for (const c of commands) defaultRuntime.log(`- ${c}`);
		});
	}));
	nodesCallOpts(nodes.command("list").description("List pending and paired nodes").option("--connected", "Only show connected nodes").option("--last-connected <duration>", "Only show nodes connected within duration (e.g. 24h)").action(async (opts) => {
		await runNodesCommand("list", async () => {
			const connectedOnly = Boolean(opts.connected);
			const sinceMs = parseSinceMs(opts.lastConnected, "Invalid --last-connected");
			const { pending, paired } = parsePairingList(await callGatewayCli("node.pair.list", opts, {}));
			const { heading, muted, warn } = getNodesTheme();
			const tableWidth = getTerminalTableWidth();
			const now = Date.now();
			const hasFilters = connectedOnly || sinceMs !== void 0;
			const pendingRows = hasFilters ? [] : pending;
			const filteredPaired = mergePairedNodesWithEffectiveNodes(paired, hasFilters ? parseNodeList(await callGatewayCli("node.list", opts, {})) : await tryReadNodeList(opts)).filter((node) => {
				if (connectedOnly) {
					if (!node.connected) return false;
				}
				if (sinceMs !== void 0) {
					const lastConnectedAtMs = typeof node.lastConnectedAtMs === "number" ? node.lastConnectedAtMs : typeof node.connectedAtMs === "number" ? node.connectedAtMs : void 0;
					if (typeof lastConnectedAtMs !== "number") return false;
					if (now - lastConnectedAtMs > sinceMs) return false;
				}
				return true;
			});
			const filteredLabel = hasFilters && filteredPaired.length !== paired.length ? ` (of ${paired.length})` : "";
			defaultRuntime.log(`Pending: ${pendingRows.length} · Paired: ${filteredPaired.length}${filteredLabel}`);
			if (opts.json) {
				defaultRuntime.writeJson({
					pending: pendingRows,
					paired: filteredPaired.map(sanitizePairedNodeForListJson)
				});
				return;
			}
			if (pendingRows.length > 0) {
				const rendered = renderPendingPairingRequestsTable({
					pending: pendingRows,
					now,
					tableWidth,
					theme: {
						heading,
						warn,
						muted
					}
				});
				defaultRuntime.log("");
				defaultRuntime.log(rendered.heading);
				defaultRuntime.log(rendered.table);
			}
			if (filteredPaired.length > 0) {
				const pairedTableRows = filteredPaired.map((n) => {
					const lastConnectedAtMs = typeof n.lastConnectedAtMs === "number" ? n.lastConnectedAtMs : typeof n.connectedAtMs === "number" ? n.connectedAtMs : void 0;
					return {
						Node: formatNodeTerminalLabel(n),
						Id: sanitizeTerminalText(n.nodeId),
						IP: sanitizeTerminalText(n.remoteIp ?? ""),
						LastConnect: typeof lastConnectedAtMs === "number" ? formatTimeAgo(Math.max(0, now - lastConnectedAtMs)) : muted("unknown")
					};
				});
				defaultRuntime.log("");
				defaultRuntime.log(heading("Paired"));
				defaultRuntime.log(renderTable({
					width: tableWidth,
					columns: [
						{
							key: "Node",
							header: "Node",
							minWidth: 14,
							flex: true
						},
						{
							key: "Id",
							header: "ID",
							minWidth: 10
						},
						{
							key: "IP",
							header: "IP",
							minWidth: 10
						},
						{
							key: "LastConnect",
							header: "Last Connect",
							minWidth: 14
						}
					],
					rows: pairedTableRows
				}).trimEnd());
			}
		});
	}));
}
//#endregion
//#region src/cli/nodes-cli/register.ts
function registerNodesCli(program) {
	const nodes = program.command("nodes").description("Manage gateway-owned nodes (pairing, status, invoke, and media)").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw nodes status", "List known nodes with live status."],
		["openclaw nodes pairing pending", "Show pending node pairing requests."],
		["openclaw nodes remove --node <id|name|ip>", "Remove a stale paired node entry."],
		["openclaw nodes invoke --node <id> --command system.which --params '{\"name\":\"uname\"}'", "Invoke a node command directly."],
		["openclaw nodes camera snap --node <id>", "Capture a photo from a node camera."]
	])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/nodes", "docs.openclaw.ai/cli/nodes")}\n`);
	registerNodesStatusCommands(nodes);
	registerNodesPairingCommands(nodes);
	registerNodesInvokeCommands(nodes);
	registerNodesNotifyCommand(nodes);
	registerNodesPushCommand(nodes);
	registerNodesCanvasCommands(nodes);
	registerNodesCameraCommands(nodes);
	registerNodesScreenCommands(nodes);
	registerNodesLocationCommands(nodes);
}
//#endregion
export { registerNodesCli };
