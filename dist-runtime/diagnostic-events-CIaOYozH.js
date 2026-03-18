//#region src/infra/diagnostic-events.ts
function getDiagnosticEventsState() {
	const globalStore = globalThis;
	if (!globalStore.__openclawDiagnosticEventsState) globalStore.__openclawDiagnosticEventsState = {
		seq: 0,
		listeners: /* @__PURE__ */ new Set(),
		dispatchDepth: 0
	};
	return globalStore.__openclawDiagnosticEventsState;
}
function isDiagnosticsEnabled(config) {
	return config?.diagnostics?.enabled === true;
}
function emitDiagnosticEvent(event) {
	const state = getDiagnosticEventsState();
	if (state.dispatchDepth > 100) {
		console.error(`[diagnostic-events] recursion guard tripped at depth=${state.dispatchDepth}, dropping type=${event.type}`);
		return;
	}
	const enriched = {
		...event,
		seq: state.seq += 1,
		ts: Date.now()
	};
	state.dispatchDepth += 1;
	for (const listener of state.listeners) try {
		listener(enriched);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.stack ?? err.message : typeof err === "string" ? err : String(err);
		console.error(`[diagnostic-events] listener error type=${enriched.type} seq=${enriched.seq}: ${errorMessage}`);
	}
	state.dispatchDepth -= 1;
}
function onDiagnosticEvent(listener) {
	const state = getDiagnosticEventsState();
	state.listeners.add(listener);
	return () => {
		state.listeners.delete(listener);
	};
}
//#endregion
export { isDiagnosticsEnabled as n, onDiagnosticEvent as r, emitDiagnosticEvent as t };
