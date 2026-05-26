import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
//#region src/infra/env.ts
let log = null;
let logPromise = null;
const loggedEnv = /* @__PURE__ */ new Set();
async function getLog() {
	if (!log) {
		logPromise ??= import("./subsystem-W8wAQXn1.js").then(({ createSubsystemLogger }) => createSubsystemLogger("env"));
		log = await logPromise;
	}
	return log;
}
function formatEnvValue(value, redact) {
	if (redact) return "<redacted>";
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= 160) return singleLine;
	return `${singleLine.slice(0, 160)}…`;
}
function logAcceptedEnvOption(option) {
	if (process.env.VITEST || false) return;
	if (loggedEnv.has(option.key)) return;
	const rawValue = option.value ?? process.env[option.key];
	if (!rawValue || !rawValue.trim()) return;
	loggedEnv.add(option.key);
	getLog().then((logger) => {
		logger.info(`env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`);
	}).catch(() => {});
}
function normalizeZaiEnv() {
	if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
}
function isTruthyEnvValue(value) {
	if (typeof value !== "string") return false;
	switch (normalizeLowercaseStringOrEmpty(value)) {
		case "1":
		case "on":
		case "true":
		case "yes": return true;
		default: return false;
	}
}
function isVitestRuntimeEnv(env = process.env) {
	return env.VITEST === "true" || env.VITEST === "1" || env.VITEST_POOL_ID !== void 0 || env.VITEST_WORKER_ID !== void 0 || env.NODE_ENV === "test";
}
function normalizeEnv() {
	normalizeZaiEnv();
}
//#endregion
export { normalizeZaiEnv as a, normalizeEnv as i, isVitestRuntimeEnv as n, logAcceptedEnvOption as r, isTruthyEnvValue as t };
