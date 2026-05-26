import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { n as mergeSessionEntry } from "./types-BgvyBC-3.js";
import { c as hasInternalRuntimeContext, u as stripInternalRuntimeContext } from "./internal-runtime-context-DWxvZFcB.js";
import { n as formatAgentInternalEventsForPrompt, t as formatAgentInternalEventsForPlainPrompt } from "./internal-events-yCBm9zLb.js";
//#region src/agents/command/attempt-execution.shared.ts
async function persistSessionEntry(params) {
	const persisted = await updateSessionStore(params.storePath, (store) => {
		const current = store[params.sessionKey];
		if (params.shouldPersist && !params.shouldPersist(current)) return current;
		const merged = mergeSessionEntry(store[params.sessionKey], params.entry);
		for (const field of params.clearedFields ?? []) if (!Object.hasOwn(params.entry, field)) Reflect.deleteProperty(merged, field);
		store[params.sessionKey] = merged;
		return merged;
	});
	if (persisted) params.sessionStore[params.sessionKey] = persisted;
	else delete params.sessionStore[params.sessionKey];
	return persisted;
}
function prependInternalEventContext(body, events) {
	if (hasInternalRuntimeContext(body)) return body;
	const renderedEvents = formatAgentInternalEventsForPrompt(events);
	if (!renderedEvents) return body;
	return [renderedEvents, body].filter(Boolean).join("\n\n");
}
function resolvePlainInternalEventBody(body, events) {
	const renderedEvents = formatAgentInternalEventsForPlainPrompt(events);
	if (!renderedEvents) return body;
	return [renderedEvents, stripInternalRuntimeContext(body).trim()].filter(Boolean).join("\n\n") || body;
}
function resolveAcpPromptBody(body, events) {
	return events?.length ? resolvePlainInternalEventBody(body, events) : body;
}
function resolveInternalEventTranscriptBody(body, events) {
	if (!hasInternalRuntimeContext(body)) return body;
	return resolvePlainInternalEventBody(body, events);
}
//#endregion
export { resolveInternalEventTranscriptBody as i, prependInternalEventContext as n, resolveAcpPromptBody as r, persistSessionEntry as t };
