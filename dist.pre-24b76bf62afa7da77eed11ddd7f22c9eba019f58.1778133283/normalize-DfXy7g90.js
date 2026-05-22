import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { y as truncateUtf16Safe } from "./utils-D5swhEXt.js";
import { c as normalizeAgentId } from "./session-key-C0K0uhmG.js";
//#region src/cron/service/normalize.ts
function normalizeRequiredName(raw) {
	if (typeof raw !== "string") throw new Error("cron job name is required");
	const name = raw.trim();
	if (!name) throw new Error("cron job name is required");
	return name;
}
function truncateText(input, maxLen) {
	if (input.length <= maxLen) return input;
	return `${truncateUtf16Safe(input, Math.max(0, maxLen - 1)).trimEnd()}…`;
}
function normalizeOptionalAgentId(raw) {
	const trimmed = normalizeOptionalString(raw);
	if (!trimmed) return;
	return normalizeAgentId(trimmed);
}
function inferLegacyName(job) {
	const firstLine = (job?.payload?.kind === "systemEvent" && typeof job.payload.text === "string" ? job.payload.text : job?.payload?.kind === "agentTurn" && typeof job.payload.message === "string" ? job.payload.message : "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	if (firstLine) return truncateText(firstLine, 60);
	const kind = typeof job?.schedule?.kind === "string" ? job.schedule.kind : "";
	if (kind === "cron" && typeof job?.schedule?.expr === "string") return `Cron: ${truncateText(job.schedule.expr, 52)}`;
	if (kind === "every" && typeof job?.schedule?.everyMs === "number") return `Every: ${job.schedule.everyMs}ms`;
	if (kind === "at") return "One-shot";
	return "Cron job";
}
function normalizePayloadToSystemText(payload) {
	if (payload.kind === "systemEvent") {
		const text = payload.text;
		if (typeof text === "string") return text.trim();
		const legacyMessage = payload.message;
		return typeof legacyMessage === "string" ? legacyMessage.trim() : "";
	}
	return typeof payload.message === "string" ? payload.message.trim() : "";
}
//#endregion
export { normalizeRequiredName as i, normalizeOptionalAgentId as n, normalizePayloadToSystemText as r, inferLegacyName as t };
