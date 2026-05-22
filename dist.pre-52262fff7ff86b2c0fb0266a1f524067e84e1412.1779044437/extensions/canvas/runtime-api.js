import "../../gateway-runtime-sx77PHpn.js";
import { t as resolveHostedPluginSurfaceUrl } from "../../hosted-plugin-surface-url-DUxGREzM.js";
import { n as PLUGIN_NODE_CAPABILITY_PATH_PREFIX, o as mintPluginNodeCapabilityToken, r as buildPluginNodeCapabilityScopedHostUrl, s as normalizePluginNodeCapabilityScopedUrl, t as DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS } from "../../plugin-node-capability-DYeQWwzX.js";
import { a as resolveCanvasHostConfig, i as parseCanvasPluginConfig, n as isCanvasHostEnabled, r as isCanvasPluginEnabled, t as canvasConfigSchema } from "../../config-DhzZbUMj.js";
import { n as CANVAS_HOST_PATH, r as CANVAS_WS_PATH, t as A2UI_PATH } from "../../a2ui-shared-BF7zIVWD.js";
import { t as handleA2uiHttpRequest } from "../../a2ui-8OFnxuXP.js";
import { n as startCanvasHost, t as createCanvasHostHandler } from "../../server-C_Fr8JDg.js";
import { a as resolveCanvasHttpPathToLocalPath, i as resolveCanvasDocumentDir, n as createCanvasDocument, r as resolveCanvasDocumentAssets, t as buildCanvasDocumentEntryUrl } from "../../documents-qkgUjRz0.js";
import { n as registerNodesCanvasCommands } from "../../cli-CT5GMLmI.js";
import { r as parseCanvasSnapshotPayload, t as canvasSnapshotTempPath } from "../../cli-helpers-B9536JCH.js";
//#region extensions/canvas/src/capability.ts
const CANVAS_CAPABILITY_PATH_PREFIX = PLUGIN_NODE_CAPABILITY_PATH_PREFIX;
const CANVAS_CAPABILITY_TTL_MS = DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS;
function mintCanvasCapabilityToken() {
	return mintPluginNodeCapabilityToken();
}
function buildCanvasScopedHostUrl(baseUrl, capability) {
	return buildPluginNodeCapabilityScopedHostUrl(baseUrl, capability);
}
function normalizeCanvasScopedUrl(rawUrl) {
	return normalizePluginNodeCapabilityScopedUrl(rawUrl);
}
//#endregion
//#region extensions/canvas/src/host-url.ts
function resolveCanvasHostUrl(params) {
	return resolveHostedPluginSurfaceUrl({
		...params,
		port: params.canvasPort
	});
}
//#endregion
export { A2UI_PATH, CANVAS_CAPABILITY_PATH_PREFIX, CANVAS_CAPABILITY_TTL_MS, CANVAS_HOST_PATH, CANVAS_WS_PATH, buildCanvasDocumentEntryUrl, buildCanvasScopedHostUrl, canvasConfigSchema, canvasSnapshotTempPath, createCanvasDocument, createCanvasHostHandler, handleA2uiHttpRequest, isCanvasHostEnabled, isCanvasPluginEnabled, mintCanvasCapabilityToken, normalizeCanvasScopedUrl, parseCanvasPluginConfig, parseCanvasSnapshotPayload, registerNodesCanvasCommands, resolveCanvasDocumentAssets, resolveCanvasDocumentDir, resolveCanvasHostConfig, resolveCanvasHostUrl, resolveCanvasHttpPathToLocalPath, startCanvasHost };
