import { updateSessionStore } from "../../config/sessions/store.js";
import { mergeSessionEntry } from "../../config/sessions/types.js";
import { formatAgentInternalEventsForPrompt } from "../internal-events.js";
import { hasInternalRuntimeContext } from "../internal-runtime-context.js";
export async function persistSessionEntry(params) {
    const persisted = await updateSessionStore(params.storePath, (store) => {
        const merged = mergeSessionEntry(store[params.sessionKey], params.entry);
        for (const field of params.clearedFields ?? []) {
            if (!Object.hasOwn(params.entry, field)) {
                Reflect.deleteProperty(merged, field);
            }
        }
        store[params.sessionKey] = merged;
        return merged;
    });
    params.sessionStore[params.sessionKey] = persisted;
}
export function prependInternalEventContext(body, events) {
    if (hasInternalRuntimeContext(body)) {
        return body;
    }
    const renderedEvents = formatAgentInternalEventsForPrompt(events);
    if (!renderedEvents) {
        return body;
    }
    return [renderedEvents, body].filter(Boolean).join("\n\n");
}
