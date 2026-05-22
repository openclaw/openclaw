//#region src/plugins/host-hook-json.ts
const PLUGIN_JSON_VALUE_LIMITS = {
	maxDepth: 32,
	maxNodes: 4096,
	maxObjectKeys: 512,
	maxStringLength: 64 * 1024,
	maxSerializedBytes: 256 * 1024
};
function isPluginJsonValueWithinLimits(value, limits, state) {
	state.nodes += 1;
	if (state.nodes > limits.maxNodes || state.depth > limits.maxDepth) return false;
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "string") return value.length <= limits.maxStringLength;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		state.depth += 1;
		const ok = value.every((entry) => isPluginJsonValueWithinLimits(entry, limits, state));
		state.depth -= 1;
		return ok;
	}
	if (typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const entries = Object.entries(value);
	if (entries.length > limits.maxObjectKeys) return false;
	state.depth += 1;
	const ok = entries.every(([key, entry]) => key.length <= limits.maxStringLength && isPluginJsonValueWithinLimits(entry, limits, state));
	state.depth -= 1;
	return ok;
}
function isPluginJsonValue(value) {
	if (!isPluginJsonValueWithinLimits(value, PLUGIN_JSON_VALUE_LIMITS, {
		depth: 0,
		nodes: 0
	})) return false;
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8") <= PLUGIN_JSON_VALUE_LIMITS.maxSerializedBytes;
	} catch {
		return false;
	}
}
//#endregion
export { isPluginJsonValue as t };
