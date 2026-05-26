import { Buffer } from "node:buffer";
//#region src/agents/stable-stringify.ts
function stableStringify(value) {
	return stringifyStableValue(value, /* @__PURE__ */ new WeakSet());
}
function stringifyStableValue(value, stack) {
	if (value === null || value === void 0) return String(value);
	if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(String(value));
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	if (typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (stack.has(value)) return JSON.stringify("[Circular]");
	stack.add(value);
	try {
		return stringifyObjectValue(value, stack);
	} finally {
		stack.delete(value);
	}
}
function stringifyObjectValue(value, stack) {
	if (value instanceof Error) return stringifyStableValue({
		name: value.name,
		message: value.message,
		stack: value.stack
	}, stack);
	if (value instanceof Uint8Array) return stringifyStableValue({
		type: "Uint8Array",
		data: Buffer.from(value).toString("base64")
	}, stack);
	if (Array.isArray(value)) {
		const serializedEntries = [];
		for (const entry of value) serializedEntries.push(stringifyStableValue(entry, stack));
		return `[${serializedEntries.join(",")}]`;
	}
	const record = value;
	const serializedFields = [];
	for (const key of Object.keys(record).toSorted()) serializedFields.push(`${JSON.stringify(key)}:${stringifyStableValue(record[key], stack)}`);
	return `{${serializedFields.join(",")}}`;
}
//#endregion
export { stableStringify as t };
