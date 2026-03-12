import { t as createSubsystemLogger } from "./subsystem-LTWJBEIv.js";
import { t as parseBooleanValue } from "./boolean-Wzu0-e0P.js";

//#region src/infra/env.ts
const log = createSubsystemLogger("env");
const loggedEnv = /* @__PURE__ */ new Set();
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
	log.info(`env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`);
}
function normalizeZaiEnv() {
	if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
}
function isTruthyEnvValue(value) {
	return parseBooleanValue(value) === true;
}
function normalizeEnv() {
	normalizeZaiEnv();
}

//#endregion
export { logAcceptedEnvOption as n, normalizeEnv as r, isTruthyEnvValue as t };