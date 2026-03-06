import { t as createSubsystemLogger } from "./subsystem-B9UBebHR.js";

//#region src/utils/boolean.ts
const DEFAULT_TRUTHY = [
	"true",
	"1",
	"yes",
	"on"
];
const DEFAULT_FALSY = [
	"false",
	"0",
	"no",
	"off"
];
const DEFAULT_TRUTHY_SET = new Set(DEFAULT_TRUTHY);
const DEFAULT_FALSY_SET = new Set(DEFAULT_FALSY);
function parseBooleanValue(value, options = {}) {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return;
	const truthy = options.truthy ?? DEFAULT_TRUTHY;
	const falsy = options.falsy ?? DEFAULT_FALSY;
	const truthySet = truthy === DEFAULT_TRUTHY ? DEFAULT_TRUTHY_SET : new Set(truthy);
	const falsySet = falsy === DEFAULT_FALSY ? DEFAULT_FALSY_SET : new Set(falsy);
	if (truthySet.has(normalized)) return true;
	if (falsySet.has(normalized)) return false;
}

//#endregion
//#region src/hooks/internal-hooks.ts
/**
* Registry of hook handlers by event key.
*
* Uses a globalThis singleton so that registerInternalHook and
* triggerInternalHook always share the same Map even when the bundler
* emits multiple copies of this module into separate chunks (bundle
* splitting). Without the singleton, handlers registered in one chunk
* are invisible to triggerInternalHook in another chunk, causing hooks
* to silently fire with zero handlers.
*/
const _g = globalThis;
const handlers = _g.__openclaw_internal_hook_handlers__ ??= /* @__PURE__ */ new Map();
const log = createSubsystemLogger("internal-hooks");
/**
* Register a hook handler for a specific event type or event:action combination
*
* @param eventKey - Event type (e.g., 'command') or specific action (e.g., 'command:new')
* @param handler - Function to call when the event is triggered
*
* @example
* ```ts
* // Listen to all command events
* registerInternalHook('command', async (event) => {
*   console.log('Command:', event.action);
* });
*
* // Listen only to /new commands
* registerInternalHook('command:new', async (event) => {
*   await saveSessionToMemory(event);
* });
* ```
*/
function registerInternalHook(eventKey, handler) {
	if (!handlers.has(eventKey)) handlers.set(eventKey, []);
	handlers.get(eventKey).push(handler);
}
/**
* Trigger a hook event
*
* Calls all handlers registered for:
* 1. The general event type (e.g., 'command')
* 2. The specific event:action combination (e.g., 'command:new')
*
* Handlers are called in registration order. Errors are caught and logged
* but don't prevent other handlers from running.
*
* @param event - The event to trigger
*/
async function triggerInternalHook(event) {
	const typeHandlers = handlers.get(event.type) ?? [];
	const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
	const allHandlers = [...typeHandlers, ...specificHandlers];
	if (allHandlers.length === 0) return;
	for (const handler of allHandlers) try {
		await handler(event);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error(`Hook error [${event.type}:${event.action}]: ${message}`);
	}
}
/**
* Create a hook event with common fields filled in
*
* @param type - The event type
* @param action - The action within that type
* @param sessionKey - The session key
* @param context - Additional context
*/
function createInternalHookEvent(type, action, sessionKey, context = {}) {
	return {
		type,
		action,
		sessionKey,
		context,
		timestamp: /* @__PURE__ */ new Date(),
		messages: []
	};
}
function isHookEventTypeAndAction(event, type, action) {
	return event.type === type && event.action === action;
}
function getHookContext(event) {
	const context = event.context;
	if (!context || typeof context !== "object") return null;
	return context;
}
function hasStringContextField(context, key) {
	return typeof context[key] === "string";
}
function isAgentBootstrapEvent(event) {
	if (!isHookEventTypeAndAction(event, "agent", "bootstrap")) return false;
	const context = getHookContext(event);
	if (!context) return false;
	if (!hasStringContextField(context, "workspaceDir")) return false;
	return Array.isArray(context.bootstrapFiles);
}
function isGatewayStartupEvent(event) {
	if (!isHookEventTypeAndAction(event, "gateway", "startup")) return false;
	return Boolean(getHookContext(event));
}

//#endregion
//#region src/compat/legacy-names.ts
const PROJECT_NAME = "openclaw";
const LEGACY_PROJECT_NAMES = [];
const MANIFEST_KEY = PROJECT_NAME;
const LEGACY_MANIFEST_KEYS = LEGACY_PROJECT_NAMES;

//#endregion
export { isGatewayStartupEvent as a, parseBooleanValue as c, isAgentBootstrapEvent as i, MANIFEST_KEY as n, registerInternalHook as o, createInternalHookEvent as r, triggerInternalHook as s, LEGACY_MANIFEST_KEYS as t };