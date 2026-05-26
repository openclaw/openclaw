import { n as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-C5ctwRKD.js";
import { _ as readStringParam, c as imageResultFromFile, l as jsonResult } from "../../common-V7-zd73S.js";
import { t as callGatewayTool } from "../../gateway-CdR1r1Su.js";
import { i as stringEnum, r as optionalStringEnum } from "../../typebox-B_Peztf1.js";
import "../../temp-path-C0pVd7ka.js";
import { i as resolveNodeIdFromList, t as listNodes } from "../../nodes-utils-DT1n7Zjn.js";
import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import "../../agent-harness-runtime-Cs9KBB7L.js";
import "../../channel-actions-BDOLVWJN.js";
import { c as canvasConfigSchema, f as resolveCanvasHostConfig, l as isCanvasHostEnabled, m as registerNodesCanvasCommands, p as createDefaultCanvasCliDependencies, s as resolveCanvasHttpPathToLocalPath, t as createCanvasHostHandler } from "../../server-DXKfnO2y.js";
import { a as CANVAS_HOST_PATH, i as A2UI_PATH, o as CANVAS_WS_PATH, t as handleA2uiHttpRequest } from "../../a2ui-CObIXAm6.js";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
//#region extensions/canvas/src/http-route.ts
function createCanvasHttpRouteHandler(params) {
	let hostHandlerPromise = null;
	const loadHostHandler = async () => {
		if (!isCanvasHostEnabled(params.config)) return null;
		hostHandlerPromise ??= (async () => {
			const hostConfig = resolveCanvasHostConfig({
				config: params.config,
				pluginConfig: params.pluginConfig
			});
			const handler = await createCanvasHostHandler({
				runtime: params.runtime,
				rootDir: hostConfig.root,
				basePath: CANVAS_HOST_PATH,
				allowInTests: params.allowInTests,
				liveReload: hostConfig.liveReload
			});
			return handler.rootDir ? handler : null;
		})();
		return hostHandlerPromise;
	};
	return {
		async handleHttpRequest(req, res) {
			const handler = await loadHostHandler();
			if (!handler) return false;
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname === "/__openclaw__/a2ui" || url.pathname.startsWith(`/__openclaw__/a2ui/`)) return handleA2uiHttpRequest(req, res);
			return handler.handleHttpRequest(req, res);
		},
		async handleUpgrade(req, socket, head) {
			const handler = await loadHostHandler();
			if (!handler) return false;
			if (new URL(req.url ?? "/", "http://localhost").pathname !== "/__openclaw__/ws") return false;
			return handler.handleUpgrade(req, socket, head);
		},
		async close() {
			await (hostHandlerPromise ? await hostHandlerPromise : null)?.close();
			hostHandlerPromise = null;
		}
	};
}
//#endregion
//#region extensions/canvas/src/tool.ts
const CANVAS_ACTIONS = [
	"present",
	"hide",
	"navigate",
	"eval",
	"snapshot",
	"a2ui_push",
	"a2ui_reset"
];
const CANVAS_SNAPSHOT_FORMATS = [
	"png",
	"jpg",
	"jpeg"
];
function readGatewayCallOptions(params) {
	return {
		gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
		gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
		timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0
	};
}
async function resolveNodeId(opts, query, allowDefault = false) {
	return resolveNodeIdFromList(await listNodes(opts), query, allowDefault);
}
function parseCanvasSnapshotPayload(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid canvas.snapshot payload");
	const record = value;
	const format = typeof record.format === "string" ? record.format : "";
	const base64 = typeof record.base64 === "string" ? record.base64 : "";
	if (!format || !base64) throw new Error("invalid canvas.snapshot payload");
	return {
		format,
		base64
	};
}
async function writeBase64ToTempFile(params) {
	const dir = resolvePreferredOpenClawTmpDir();
	await fs.mkdir(dir, {
		recursive: true,
		mode: 448
	});
	const ext = params.ext.startsWith(".") ? params.ext : `.${params.ext}`;
	const filePath = path.join(dir, `openclaw-canvas-snapshot-${randomUUID()}${ext}`);
	await fs.writeFile(filePath, Buffer.from(params.base64, "base64"));
	return filePath;
}
function isPathInsideRoot(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === "" || !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function readJsonlFromPath(jsonlPath, workspaceDir) {
	const trimmed = jsonlPath.trim();
	if (!trimmed) return "";
	const workspaceRoot = path.resolve(workspaceDir ?? process.cwd());
	const resolved = path.resolve(workspaceRoot, trimmed);
	const [workspaceReal, resolvedReal] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(resolved)]);
	if (!isPathInsideRoot(workspaceReal, resolvedReal)) throw new Error("jsonlPath outside workspace");
	return await fs.readFile(resolvedReal, "utf8");
}
function resolveCanvasImageSanitizationLimits(config) {
	const configured = config?.agents?.defaults?.imageMaxDimensionPx;
	if (typeof configured !== "number" || !Number.isFinite(configured)) return {};
	return { maxDimensionPx: Math.max(1, Math.floor(configured)) };
}
const CanvasToolSchema = Type.Object({
	action: stringEnum(CANVAS_ACTIONS),
	gatewayUrl: Type.Optional(Type.String()),
	gatewayToken: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number()),
	node: Type.Optional(Type.String()),
	target: Type.Optional(Type.String()),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
	width: Type.Optional(Type.Number()),
	height: Type.Optional(Type.Number()),
	url: Type.Optional(Type.String()),
	javaScript: Type.Optional(Type.String()),
	outputFormat: optionalStringEnum(CANVAS_SNAPSHOT_FORMATS),
	maxWidth: Type.Optional(Type.Number()),
	quality: Type.Optional(Type.Number()),
	delayMs: Type.Optional(Type.Number()),
	jsonl: Type.Optional(Type.String()),
	jsonlPath: Type.Optional(Type.String())
});
function createCanvasTool(options) {
	const imageSanitization = resolveCanvasImageSanitizationLimits(options?.config);
	return {
		label: "Canvas",
		name: "canvas",
		description: "Control node canvases (present/hide/navigate/eval/snapshot/A2UI). Use snapshot to capture the rendered UI.",
		parameters: CanvasToolSchema,
		execute: async (_toolCallId, args) => {
			const params = args;
			const action = readStringParam(params, "action", { required: true });
			const gatewayOpts = readGatewayCallOptions(params);
			const nodeId = await resolveNodeId(gatewayOpts, readStringParam(params, "node", { trim: true }), true);
			const invoke = async (command, invokeParams) => await callGatewayTool("node.invoke", gatewayOpts, {
				nodeId,
				command,
				params: invokeParams,
				idempotencyKey: randomUUID()
			});
			switch (action) {
				case "present": {
					const placement = {
						x: typeof params.x === "number" ? params.x : void 0,
						y: typeof params.y === "number" ? params.y : void 0,
						width: typeof params.width === "number" ? params.width : void 0,
						height: typeof params.height === "number" ? params.height : void 0
					};
					const invokeParams = {};
					const presentTarget = readStringParam(params, "target", { trim: true }) ?? readStringParam(params, "url", { trim: true });
					if (presentTarget) invokeParams.url = presentTarget;
					if (Number.isFinite(placement.x) || Number.isFinite(placement.y) || Number.isFinite(placement.width) || Number.isFinite(placement.height)) invokeParams.placement = placement;
					await invoke("canvas.present", invokeParams);
					return jsonResult({ ok: true });
				}
				case "hide":
					await invoke("canvas.hide", void 0);
					return jsonResult({ ok: true });
				case "navigate":
					await invoke("canvas.navigate", { url: readStringParam(params, "url", { trim: true }) ?? readStringParam(params, "target", {
						required: true,
						trim: true,
						label: "url"
					}) });
					return jsonResult({ ok: true });
				case "eval": {
					const result = (await invoke("canvas.eval", { javaScript: readStringParam(params, "javaScript", { required: true }) }))?.payload?.result;
					if (result) return {
						content: [{
							type: "text",
							text: result
						}],
						details: { result }
					};
					return jsonResult({ ok: true });
				}
				case "snapshot": {
					const formatRaw = typeof params.outputFormat === "string" && params.outputFormat.trim() ? params.outputFormat.trim().toLowerCase() : "png";
					const payload = parseCanvasSnapshotPayload((await invoke("canvas.snapshot", {
						format: formatRaw === "jpg" || formatRaw === "jpeg" ? "jpeg" : "png",
						maxWidth: typeof params.maxWidth === "number" && Number.isFinite(params.maxWidth) ? params.maxWidth : void 0,
						quality: typeof params.quality === "number" && Number.isFinite(params.quality) ? params.quality : void 0
					}))?.payload);
					return await imageResultFromFile({
						label: "canvas:snapshot",
						path: await writeBase64ToTempFile({
							base64: payload.base64,
							ext: payload.format === "jpeg" ? "jpg" : payload.format
						}),
						details: { format: payload.format },
						imageSanitization
					});
				}
				case "a2ui_push": {
					const jsonl = typeof params.jsonl === "string" && params.jsonl.trim() ? params.jsonl : typeof params.jsonlPath === "string" && params.jsonlPath.trim() ? await readJsonlFromPath(params.jsonlPath, options?.workspaceDir) : "";
					if (!jsonl.trim()) throw new Error("jsonl or jsonlPath required");
					await invoke("canvas.a2ui.pushJSONL", { jsonl });
					return jsonResult({ ok: true });
				}
				case "a2ui_reset":
					await invoke("canvas.a2ui.reset", void 0);
					return jsonResult({ ok: true });
				default: throw new Error(`Unknown action: ${action}`);
			}
		}
	};
}
//#endregion
//#region extensions/canvas/index.ts
const CANVAS_NODE_COMMANDS = [
	"canvas.present",
	"canvas.hide",
	"canvas.navigate",
	"canvas.eval",
	"canvas.snapshot",
	"canvas.a2ui.push",
	"canvas.a2ui.pushJSONL",
	"canvas.a2ui.reset"
];
var canvas_default = definePluginEntry({
	id: "canvas",
	name: "Canvas",
	description: "Experimental Canvas control and A2UI rendering surfaces for paired nodes.",
	configSchema: canvasConfigSchema,
	reload: { restartPrefixes: [
		"plugins.enabled",
		"plugins.allow",
		"plugins.deny",
		"plugins.entries.canvas"
	] },
	register(api) {
		if (isCanvasHostEnabled(api.config)) {
			const httpRouteHandler = createCanvasHttpRouteHandler({
				config: api.config,
				pluginConfig: api.pluginConfig,
				runtime: {
					log: (...args) => api.logger.info(args.map(String).join(" ")),
					error: (...args) => api.logger.error(args.map(String).join(" ")),
					exit: (code) => {
						throw new Error(`canvas host requested process exit ${code}`);
					}
				}
			});
			const nodeCapability = { surface: "canvas" };
			api.registerHttpRoute({
				path: A2UI_PATH,
				auth: "plugin",
				match: "prefix",
				nodeCapability,
				handler: httpRouteHandler.handleHttpRequest
			});
			api.registerHttpRoute({
				path: CANVAS_HOST_PATH,
				auth: "plugin",
				match: "prefix",
				nodeCapability,
				handler: httpRouteHandler.handleHttpRequest
			});
			api.registerHttpRoute({
				path: CANVAS_WS_PATH,
				auth: "plugin",
				match: "exact",
				nodeCapability,
				handler: httpRouteHandler.handleHttpRequest,
				handleUpgrade: httpRouteHandler.handleUpgrade
			});
			api.registerService({
				id: "canvas-host",
				start: () => {},
				stop: () => httpRouteHandler.close()
			});
			api.registerHostedMediaResolver((mediaUrl) => resolveCanvasHttpPathToLocalPath(mediaUrl));
		}
		api.registerNodeInvokePolicy({
			commands: CANVAS_NODE_COMMANDS,
			defaultPlatforms: [
				"ios",
				"android",
				"macos",
				"windows",
				"unknown"
			],
			foregroundRestrictedOnIos: true,
			handle: (ctx) => ctx.invokeNode()
		});
		api.registerTool((ctx) => createCanvasTool({
			config: ctx.runtimeConfig ?? ctx.config,
			workspaceDir: ctx.workspaceDir
		}));
		api.registerNodeCliFeature(({ program }) => {
			registerNodesCanvasCommands(program, createDefaultCanvasCliDependencies());
		}, { descriptors: [{
			name: "canvas",
			description: "Capture or render canvas content from a paired node",
			hasSubcommands: true
		}] });
	}
});
//#endregion
export { canvas_default as default };
