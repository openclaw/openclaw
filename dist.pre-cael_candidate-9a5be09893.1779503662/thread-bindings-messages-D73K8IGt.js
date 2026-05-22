import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as prefixSystemMessage } from "./system-message-DcYqWFJX.js";
//#region src/channels/thread-bindings-messages.ts
const DEFAULT_THREAD_BINDING_FAREWELL_TEXT = "Session ended. Messages here will no longer be routed.";
function normalizeThreadBindingDurationMs(raw) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
	const durationMs = Math.floor(raw);
	if (durationMs < 0) return 0;
	return durationMs;
}
function formatThreadBindingDurationLabel(durationMs) {
	if (durationMs <= 0) return "disabled";
	if (durationMs < 6e4) return "<1m";
	const totalMinutes = Math.floor(durationMs / 6e4);
	if (totalMinutes % 60 === 0) return `${Math.floor(totalMinutes / 60)}h`;
	return `${totalMinutes}m`;
}
function resolveThreadBindingThreadName(params) {
	return `🤖 ${normalizeOptionalString(params.label) || normalizeOptionalString(params.agentId) || "agent"}`.replace(/\s+/g, " ").trim().slice(0, 100);
}
function resolveThreadBindingIntroText(params) {
	const normalized = (normalizeOptionalString(params.label) || normalizeOptionalString(params.agentId) || "agent").replace(/\s+/g, " ").trim().slice(0, 100) || "agent";
	const idleTimeoutMs = normalizeThreadBindingDurationMs(params.idleTimeoutMs);
	const maxAgeMs = normalizeThreadBindingDurationMs(params.maxAgeMs);
	const cwd = normalizeOptionalString(params.sessionCwd);
	const details = (params.sessionDetails ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	if (cwd) details.unshift(`cwd: ${cwd}`);
	const lifecycle = [];
	if (idleTimeoutMs > 0) lifecycle.push(`idle auto-unfocus after ${formatThreadBindingDurationLabel(idleTimeoutMs)} inactivity`);
	if (maxAgeMs > 0) lifecycle.push(`max age ${formatThreadBindingDurationLabel(maxAgeMs)}`);
	const intro = lifecycle.length > 0 ? `${normalized} session active (${lifecycle.join("; ")}). Messages here go directly to this session.` : `${normalized} session active. Messages here go directly to this session.`;
	if (details.length === 0) return prefixSystemMessage(intro);
	return prefixSystemMessage(`${intro}\n${details.join("\n")}`);
}
function resolveThreadBindingFarewellText(params) {
	const custom = normalizeOptionalString(params.farewellText);
	if (custom) return prefixSystemMessage(custom);
	if (params.reason === "idle-expired") return prefixSystemMessage(`Session ended automatically after ${formatThreadBindingDurationLabel(normalizeThreadBindingDurationMs(params.idleTimeoutMs))} of inactivity. Messages here will no longer be routed.`);
	if (params.reason === "max-age-expired") return prefixSystemMessage(`Session ended automatically at max age of ${formatThreadBindingDurationLabel(normalizeThreadBindingDurationMs(params.maxAgeMs))}. Messages here will no longer be routed.`);
	return prefixSystemMessage(DEFAULT_THREAD_BINDING_FAREWELL_TEXT);
}
//#endregion
export { resolveThreadBindingThreadName as i, resolveThreadBindingFarewellText as n, resolveThreadBindingIntroText as r, formatThreadBindingDurationLabel as t };
