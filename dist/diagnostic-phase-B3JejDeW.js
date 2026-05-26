import { n as emitDiagnosticEvent, t as areDiagnosticsEnabledForProcess } from "./diagnostic-events-BLgzARSp.js";
import { performance } from "node:perf_hooks";
//#region src/logging/diagnostic-phase.ts
const RECENT_PHASE_CAPACITY = 40;
let activePhaseStack = [];
let recentPhases = [];
function roundMetric(value, digits = 1) {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
function pushRecentPhase(snapshot) {
	recentPhases.push(snapshot);
	if (recentPhases.length > RECENT_PHASE_CAPACITY) recentPhases = recentPhases.slice(-40);
}
function getCurrentDiagnosticPhase() {
	return activePhaseStack.at(-1)?.name;
}
function resolveRecentPhaseLimit(limit) {
	if (!Number.isFinite(limit) || limit <= 0) return null;
	return Math.floor(limit);
}
function getRecentDiagnosticPhases(limit = 8) {
	const resolved = resolveRecentPhaseLimit(limit);
	if (resolved === null) return [];
	return recentPhases.slice(-resolved).map((phase) => Object.assign({}, phase));
}
function recordDiagnosticPhase(snapshot) {
	pushRecentPhase(snapshot);
	if (!areDiagnosticsEnabledForProcess()) return;
	emitDiagnosticEvent({
		type: "diagnostic.phase.completed",
		...snapshot
	});
}
async function withDiagnosticPhase(name, run, details) {
	const active = {
		name,
		startedAt: Date.now(),
		startedWallMs: performance.now(),
		cpuStarted: process.cpuUsage(),
		details
	};
	activePhaseStack.push(active);
	try {
		return await run();
	} finally {
		const endedAt = Date.now();
		const durationMs = roundMetric(performance.now() - active.startedWallMs, 1);
		const cpu = process.cpuUsage(active.cpuStarted);
		const cpuUserMs = roundMetric(cpu.user / 1e3, 1);
		const cpuSystemMs = roundMetric(cpu.system / 1e3, 1);
		const cpuTotalMs = roundMetric(cpuUserMs + cpuSystemMs, 1);
		activePhaseStack = activePhaseStack.filter((entry) => entry !== active);
		recordDiagnosticPhase({
			name,
			startedAt: active.startedAt,
			endedAt,
			durationMs,
			cpuUserMs,
			cpuSystemMs,
			cpuTotalMs,
			cpuCoreRatio: roundMetric(cpuTotalMs / Math.max(1, durationMs), 3),
			details: active.details
		});
	}
}
function resetDiagnosticPhasesForTest() {
	activePhaseStack = [];
	recentPhases = [];
}
//#endregion
export { withDiagnosticPhase as i, getRecentDiagnosticPhases as n, resetDiagnosticPhasesForTest as r, getCurrentDiagnosticPhase as t };
