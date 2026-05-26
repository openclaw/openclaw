//#region src/sessions/session-lifecycle-events.ts
const SESSION_LIFECYCLE_LISTENERS = /* @__PURE__ */ new Set();
function onSessionLifecycleEvent(listener) {
	SESSION_LIFECYCLE_LISTENERS.add(listener);
	return () => {
		SESSION_LIFECYCLE_LISTENERS.delete(listener);
	};
}
function emitSessionLifecycleEvent(event) {
	for (const listener of SESSION_LIFECYCLE_LISTENERS) try {
		listener(event);
	} catch {}
}
//#endregion
export { onSessionLifecycleEvent as n, emitSessionLifecycleEvent as t };
