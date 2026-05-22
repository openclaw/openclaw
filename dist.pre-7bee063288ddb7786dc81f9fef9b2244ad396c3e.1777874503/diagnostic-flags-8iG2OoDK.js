import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/infra/diagnostic-flags.ts
const DIAGNOSTICS_ENV = "OPENCLAW_DIAGNOSTICS";
function parseEnvFlags(raw) {
	if (!raw) return {
		flags: [],
		disablesAll: false
	};
	const trimmed = raw.trim();
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	if (!lowered) return {
		flags: [],
		disablesAll: false
	};
	if ([
		"0",
		"false",
		"off",
		"none"
	].includes(lowered)) return {
		flags: [],
		disablesAll: true
	};
	if ([
		"1",
		"true",
		"all",
		"*"
	].includes(lowered)) return {
		flags: ["*"],
		disablesAll: false
	};
	return {
		flags: trimmed.split(/[,\s]+/).map((value) => normalizeLowercaseStringOrEmpty(value)).filter(Boolean),
		disablesAll: false
	};
}
function uniqueFlags(flags) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const flag of flags) {
		const normalized = normalizeLowercaseStringOrEmpty(flag);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}
function resolveDiagnosticFlags(cfg, env = process.env) {
	const configFlags = Array.isArray(cfg?.diagnostics?.flags) ? cfg?.diagnostics?.flags : [];
	const envFlags = parseEnvFlags(env[DIAGNOSTICS_ENV]);
	if (envFlags.disablesAll) return [];
	return uniqueFlags([...configFlags, ...envFlags.flags]);
}
function matchesDiagnosticFlag(flag, enabledFlags) {
	const target = normalizeLowercaseStringOrEmpty(flag);
	if (!target) return false;
	for (const raw of enabledFlags) {
		const enabled = normalizeLowercaseStringOrEmpty(raw);
		if (!enabled) continue;
		if (enabled === "*" || enabled === "all") return true;
		if (enabled.endsWith(".*")) {
			const prefix = enabled.slice(0, -2);
			if (target === prefix || target.startsWith(`${prefix}.`)) return true;
		}
		if (enabled.endsWith("*")) {
			const prefix = enabled.slice(0, -1);
			if (target.startsWith(prefix)) return true;
		}
		if (enabled === target) return true;
	}
	return false;
}
function isDiagnosticFlagEnabled(flag, cfg, env = process.env) {
	return matchesDiagnosticFlag(flag, resolveDiagnosticFlags(cfg, env));
}
//#endregion
export { matchesDiagnosticFlag as n, resolveDiagnosticFlags as r, isDiagnosticFlagEnabled as t };
