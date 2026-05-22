import { i as loadUndiciRuntimeDeps } from "./undici-runtime-BUhAamgr.js";
//#region src/infra/net/runtime-fetch.ts
function isFormDataLike(value) {
	return typeof value === "object" && value !== null && typeof value.entries === "function" && value[Symbol.toStringTag] === "FormData";
}
function normalizeRuntimeFormData(body, RuntimeFormData) {
	if (!isFormDataLike(body) || typeof RuntimeFormData !== "function") return body;
	if (body instanceof RuntimeFormData) return body;
	const next = new RuntimeFormData();
	for (const [key, value] of body.entries()) {
		const namedValue = value;
		const fileName = typeof namedValue.name === "string" && namedValue.name.trim() ? namedValue.name : void 0;
		if (fileName) next.append(key, value, fileName);
		else next.append(key, value);
	}
	return next;
}
function normalizeRuntimeRequestInit(init, RuntimeFormData) {
	if (!init?.body) return init;
	const body = normalizeRuntimeFormData(init.body, RuntimeFormData);
	if (body === init.body) return init;
	const headers = new Headers(init.headers);
	headers.delete("content-length");
	headers.delete("content-type");
	return {
		...init,
		headers,
		body
	};
}
function isMockedFetch(fetchImpl) {
	if (typeof fetchImpl !== "function") return false;
	return typeof fetchImpl.mock === "object";
}
async function fetchWithRuntimeDispatcher(input, init) {
	const runtimeDeps = loadUndiciRuntimeDeps();
	const runtimeFetch = runtimeDeps.fetch;
	return await runtimeFetch(input, normalizeRuntimeRequestInit(init, runtimeDeps.FormData));
}
async function fetchWithRuntimeDispatcherOrMockedGlobal(input, init) {
	if (isMockedFetch(globalThis.fetch)) return await globalThis.fetch(input, init);
	return await fetchWithRuntimeDispatcher(input, init);
}
//#endregion
export { fetchWithRuntimeDispatcherOrMockedGlobal as n, isMockedFetch as r, fetchWithRuntimeDispatcher as t };
