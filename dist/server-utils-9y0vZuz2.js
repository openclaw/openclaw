import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { t as createAsyncLock } from "./async-lock-CaiUOILd.js";
import { m as writeJson, o as tryReadJson } from "./json-files-C2hqjU--.js";
import path from "node:path";
//#region src/infra/voicewake.ts
const DEFAULT_TRIGGERS = [
	"openclaw",
	"claude",
	"computer"
];
function resolvePath(baseDir) {
	const root = baseDir ?? resolveStateDir();
	return path.join(root, "settings", "voicewake.json");
}
function sanitizeTriggers(triggers) {
	const cleaned = (triggers ?? []).map((w) => normalizeOptionalString(w) ?? "").filter((w) => w.length > 0);
	return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}
const withLock = createAsyncLock();
function defaultVoiceWakeTriggers() {
	return [...DEFAULT_TRIGGERS];
}
async function loadVoiceWakeConfig(baseDir) {
	const existing = await tryReadJson(resolvePath(baseDir));
	if (!existing) return {
		triggers: defaultVoiceWakeTriggers(),
		updatedAtMs: 0
	};
	return {
		triggers: sanitizeTriggers(existing.triggers),
		updatedAtMs: typeof existing.updatedAtMs === "number" && existing.updatedAtMs > 0 ? existing.updatedAtMs : 0
	};
}
async function setVoiceWakeTriggers(triggers, baseDir) {
	const sanitized = sanitizeTriggers(triggers);
	const filePath = resolvePath(baseDir);
	return await withLock(async () => {
		const next = {
			triggers: sanitized,
			updatedAtMs: Date.now()
		};
		await writeJson(filePath, next);
		return next;
	});
}
//#endregion
//#region src/gateway/server-utils.ts
function normalizeVoiceWakeTriggers(input) {
	const cleaned = (Array.isArray(input) ? input : []).map((v) => normalizeOptionalString(v)).filter((v) => v !== void 0).slice(0, 32).map((v) => v.slice(0, 64));
	return cleaned.length > 0 ? cleaned : defaultVoiceWakeTriggers();
}
function formatError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	const statusValue = err?.status;
	const codeValue = err?.code;
	if (statusValue !== void 0 || codeValue !== void 0) return `status=${typeof statusValue === "string" || typeof statusValue === "number" ? String(statusValue) : "unknown"} code=${typeof codeValue === "string" || typeof codeValue === "number" ? String(codeValue) : "unknown"}`;
	try {
		return JSON.stringify(err, null, 2);
	} catch {
		return String(err);
	}
}
//#endregion
export { setVoiceWakeTriggers as i, normalizeVoiceWakeTriggers as n, loadVoiceWakeConfig as r, formatError as t };
