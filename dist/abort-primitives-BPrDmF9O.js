import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as normalizeCommandBody } from "./commands-registry-normalize-CnHNsvCE.js";
//#region src/auto-reply/reply/abort-primitives.ts
const ABORT_TRIGGERS = new Set([
	"stop",
	"esc",
	"abort",
	"wait",
	"exit",
	"interrupt",
	"detente",
	"deten",
	"detén",
	"arrete",
	"arrête",
	"停止",
	"停下来",
	"暂停",
	"やめて",
	"止めて",
	"रुको",
	"توقف",
	"стоп",
	"остановись",
	"останови",
	"остановить",
	"прекрати",
	"halt",
	"anhalten",
	"aufhören",
	"hoer auf",
	"stopp",
	"pare",
	"stop openclaw",
	"openclaw stop",
	"stop action",
	"stop current action",
	"stop run",
	"stop current run",
	"stop agent",
	"stop the agent",
	"stop don't do anything",
	"stop dont do anything",
	"stop do not do anything",
	"stop doing anything",
	"do not do that",
	"please stop",
	"stop please"
]);
const ABORT_MEMORY = /* @__PURE__ */ new Map();
const ABORT_MEMORY_MAX = 2e3;
const TRAILING_ABORT_PUNCTUATION_RE = /[.!?！？…,，。;；:：'"’”)\]}]+$/u;
function normalizeAbortTriggerText(text) {
	return normalizeLowercaseStringOrEmpty(text).replace(/[’`]/g, "'").replace(/\s+/g, " ").replace(TRAILING_ABORT_PUNCTUATION_RE, "").trim();
}
function isAbortTrigger(text) {
	if (!text) return false;
	const normalized = normalizeAbortTriggerText(text);
	return ABORT_TRIGGERS.has(normalized);
}
function isAbortRequestText(text, options) {
	if (!text) return false;
	const normalized = normalizeCommandBody(text, options).trim();
	if (!normalized) return false;
	const normalizedLower = normalizeLowercaseStringOrEmpty(normalized);
	return normalizedLower === "/stop" || normalizeAbortTriggerText(normalizedLower) === "/stop" || isAbortTrigger(normalizedLower);
}
function getAbortMemory(key) {
	const normalized = key.trim();
	if (!normalized) return;
	return ABORT_MEMORY.get(normalized);
}
function pruneAbortMemory() {
	if (ABORT_MEMORY.size <= ABORT_MEMORY_MAX) return;
	const excess = ABORT_MEMORY.size - ABORT_MEMORY_MAX;
	let removed = 0;
	for (const entryKey of ABORT_MEMORY.keys()) {
		ABORT_MEMORY.delete(entryKey);
		removed += 1;
		if (removed >= excess) break;
	}
}
function setAbortMemory(key, value) {
	const normalized = key.trim();
	if (!normalized) return;
	if (!value) {
		ABORT_MEMORY.delete(normalized);
		return;
	}
	if (ABORT_MEMORY.has(normalized)) ABORT_MEMORY.delete(normalized);
	ABORT_MEMORY.set(normalized, true);
	pruneAbortMemory();
}
//#endregion
export { setAbortMemory as i, isAbortRequestText as n, isAbortTrigger as r, getAbortMemory as t };
