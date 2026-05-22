//#region extensions/whatsapp/src/session-errors.ts
function safeStringify(value, limit = 800) {
	try {
		const seen = /* @__PURE__ */ new WeakSet();
		const raw = JSON.stringify(value, (_key, v) => {
			if (typeof v === "bigint") return v.toString();
			if (typeof v === "function") {
				const maybeName = v.name;
				return `[Function ${typeof maybeName === "string" && maybeName.length > 0 ? maybeName : "anonymous"}]`;
			}
			if (typeof v === "object" && v) {
				if (seen.has(v)) return "[Circular]";
				seen.add(v);
			}
			return v;
		}, 2);
		if (!raw) return String(value);
		return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
	} catch {
		return String(value);
	}
}
function extractBoomDetails(err) {
	if (!err || typeof err !== "object") return null;
	const output = err?.output;
	if (!output || typeof output !== "object") return null;
	const payload = output.payload;
	const statusCode = typeof output.statusCode === "number" ? output.statusCode : typeof payload?.statusCode === "number" ? payload.statusCode : void 0;
	const error = typeof payload?.error === "string" ? payload.error : void 0;
	const message = typeof payload?.message === "string" ? payload.message : void 0;
	if (!statusCode && !error && !message) return null;
	return {
		statusCode,
		error,
		message
	};
}
function getStatusCode(err) {
	return err?.output?.statusCode ?? err?.status ?? err?.error?.output?.statusCode;
}
function formatError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (!err || typeof err !== "object") return String(err);
	const boom = extractBoomDetails(err) ?? extractBoomDetails(err?.error) ?? extractBoomDetails(err?.lastDisconnect?.error);
	const status = boom?.statusCode ?? getStatusCode(err);
	const code = err?.code;
	const codeText = typeof code === "string" || typeof code === "number" ? String(code) : void 0;
	const message = [
		boom?.message,
		typeof err?.message === "string" ? err.message : void 0,
		typeof err?.error?.message === "string" ? err.error?.message : void 0
	].find((value) => Boolean(value && value.trim().length > 0));
	const pieces = [];
	if (typeof status === "number") pieces.push(`status=${status}`);
	if (boom?.error) pieces.push(boom.error);
	if (message) pieces.push(message);
	if (codeText) pieces.push(`code=${codeText}`);
	if (pieces.length > 0) return pieces.join(" ");
	return safeStringify(err);
}
//#endregion
export { getStatusCode as n, formatError as t };
