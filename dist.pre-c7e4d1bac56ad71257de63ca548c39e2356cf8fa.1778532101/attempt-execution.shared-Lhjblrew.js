import { n as mergeSessionEntry } from "./types-BKq924Jk.js";
import { o as updateSessionStore } from "./store-L0DKoc8m.js";
import { c as hasInternalRuntimeContext, u as stripInternalRuntimeContext } from "./internal-runtime-context-DXfHdhIG.js";
import { n as formatAgentInternalEventsForPrompt, t as formatAgentInternalEventsForPlainPrompt } from "./internal-events-NIpil9YH.js";
//#region src/agents/command/attempt-execution.shared.ts
async function persistSessionEntry(params) {
	const persisted = await updateSessionStore(params.storePath, (store) => {
		const merged = mergeSessionEntry(store[params.sessionKey], params.entry);
		for (const field of params.clearedFields ?? []) if (!Object.hasOwn(params.entry, field)) Reflect.deleteProperty(merged, field);
		store[params.sessionKey] = merged;
		return merged;
	});
	params.sessionStore[params.sessionKey] = persisted;
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
