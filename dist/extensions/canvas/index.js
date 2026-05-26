import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { n as isCanvasHostEnabled, t as canvasConfigSchema } from "../../config-8ESl39g-.js";
import { n as CANVAS_HOST_PATH, r as CANVAS_WS_PATH, t as A2UI_PATH } from "../../a2ui-shared-ChIGfmtH.js";
import { t as CanvasToolSchema } from "../../tool-schema-BypT50EN.js";
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
function createLazyCanvasTool(params) {
	let toolPromise;
	const loadTool = async () => {
		toolPromise ??= import("../../tool-P9jDUTj2.js").then(({ createCanvasTool }) => createCanvasTool({
			config: params.config,
			workspaceDir: params.workspaceDir
		}));
		return await toolPromise;
	};
	return {
		label: "Canvas",
		name: "canvas",
		description: "Control node canvases (present/hide/navigate/eval/snapshot/A2UI). Use snapshot to capture the rendered UI.",
		parameters: CanvasToolSchema,
		execute: async (...args) => await (await loadTool()).execute(...args)
	};
}
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
			let httpRouteHandlerPromise;
			const loadHttpRouteHandler = async () => {
				httpRouteHandlerPromise ??= import("../../http-route-CArTMKa1.js").then(({ createCanvasHttpRouteHandler }) => createCanvasHttpRouteHandler({
					config: api.config,
					pluginConfig: api.pluginConfig,
					runtime: {
						log: (...args) => api.logger.info(args.map(String).join(" ")),
						error: (...args) => api.logger.error(args.map(String).join(" ")),
						exit: (code) => {
							throw new Error(`canvas host requested process exit ${code}`);
						}
					}
				}));
				return await httpRouteHandlerPromise;
			};
			const handleHttpRequest = async (req, res) => await (await loadHttpRouteHandler()).handleHttpRequest(req, res);
			const handleUpgrade = async (req, socket, head) => await (await loadHttpRouteHandler()).handleUpgrade(req, socket, head);
			const nodeCapability = { surface: "canvas" };
			api.registerHttpRoute({
				path: A2UI_PATH,
				auth: "plugin",
				match: "prefix",
				nodeCapability,
				handler: handleHttpRequest
			});
			api.registerHttpRoute({
				path: CANVAS_HOST_PATH,
				auth: "plugin",
				match: "prefix",
				nodeCapability,
				handler: handleHttpRequest
			});
			api.registerHttpRoute({
				path: CANVAS_WS_PATH,
				auth: "plugin",
				match: "exact",
				nodeCapability,
				handler: handleHttpRequest,
				handleUpgrade
			});
			api.registerService({
				id: "canvas-host",
				start: () => {},
				stop: async () => {
					await (httpRouteHandlerPromise ? await httpRouteHandlerPromise : null)?.close();
				}
			});
			let resolveCanvasHttpPathToLocalPathPromise;
			api.registerHostedMediaResolver(async (mediaUrl) => {
				resolveCanvasHttpPathToLocalPathPromise ??= import("../../documents-Cbldugpk.js").then(({ resolveCanvasHttpPathToLocalPath }) => resolveCanvasHttpPathToLocalPath);
				return (await resolveCanvasHttpPathToLocalPathPromise)(mediaUrl);
			});
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
		api.registerTool((ctx) => createLazyCanvasTool({
			config: ctx.runtimeConfig ?? ctx.config,
			workspaceDir: ctx.workspaceDir
		}));
		api.registerNodeCliFeature(async ({ program }) => {
			const { createDefaultCanvasCliDependencies, registerNodesCanvasCommands } = await import("../../cli-DbEafIse.js");
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
