//#region src/shared/listeners.ts
function notifyListeners(listeners, event, onError) {
	for (const listener of listeners) try {
		listener(event);
	} catch (error) {
		onError?.(error);
	}
}
function registerListener(listeners, listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
//#endregion
export { registerListener as n, notifyListeners as t };
