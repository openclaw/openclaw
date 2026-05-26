import "../../gateway-runtime-6bU-ohwh.js";
import { t as resolveHostedPluginSurfaceUrl } from "../../hosted-plugin-surface-url-CwC2jrHk.js";
import { n as PLUGIN_NODE_CAPABILITY_PATH_PREFIX, o as mintPluginNodeCapabilityToken, r as buildPluginNodeCapabilityScopedHostUrl, s as normalizePluginNodeCapabilityScopedUrl, t as DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS } from "../../plugin-node-capability-DP56WFmQ.js";
import { a as resolveCanvasDocumentAssets, c as canvasConfigSchema, d as parseCanvasPluginConfig, f as resolveCanvasHostConfig, g as parseCanvasSnapshotPayload, h as canvasSnapshotTempPath, i as createCanvasDocument, l as isCanvasHostEnabled, m as registerNodesCanvasCommands, n as startCanvasHost, o as resolveCanvasDocumentDir, r as buildCanvasDocumentEntryUrl, s as resolveCanvasHttpPathToLocalPath, t as createCanvasHostHandler, u as isCanvasPluginEnabled } from "../../server-DXKfnO2y.js";
import { a as CANVAS_HOST_PATH, i as A2UI_PATH, o as CANVAS_WS_PATH, t as handleA2uiHttpRequest } from "../../a2ui-CObIXAm6.js";
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
