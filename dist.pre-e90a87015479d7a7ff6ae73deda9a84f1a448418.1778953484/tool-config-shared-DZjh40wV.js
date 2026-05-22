import { c as isRecord } from "./utils-CpmNtyoq.js";
import "./string-coerce-runtime-BOK5X0KD.js";
import { t as normalizeXaiModelId } from "./model-id-Cb21PUjI.js";
//#region extensions/xai/src/tool-config-shared.ts
function coerceXaiToolConfig(config) {
	return isRecord(config) ? config : {};
}
function resolveNormalizedXaiToolModel(params) {
	const value = coerceXaiToolConfig(params.config).model;
	return typeof value === "string" && value.trim() ? normalizeXaiModelId(value.trim()) : params.defaultModel;
}
function resolvePositiveIntegerToolConfig(config, key) {
	const raw = coerceXaiToolConfig(config)[key];
	if (typeof raw !== "number" || !Number.isFinite(raw)) return;
	const normalized = Math.trunc(raw);
	return normalized > 0 ? normalized : void 0;
}
//#endregion
export { resolveNormalizedXaiToolModel as n, resolvePositiveIntegerToolConfig as r, coerceXaiToolConfig as t };
