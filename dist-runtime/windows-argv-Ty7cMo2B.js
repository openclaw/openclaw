import { x as resolveRequiredHomeDir } from "./paths-1qR_mW4i.js";
import { t as isValidProfileName } from "./profile-utils-DxxxMjB_.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/cli/profile.ts
function takeValue(raw, next) {
	if (raw.includes("=")) {
		const [, value] = raw.split("=", 2);
		return {
			value: (value ?? "").trim() || null,
			consumedNext: false
		};
	}
	return {
		value: (next ?? "").trim() || null,
		consumedNext: Boolean(next)
	};
}
function parseCliProfileArgs(argv) {
	if (argv.length < 2) {return {
		ok: true,
		profile: null,
		argv
	};}
	const out = argv.slice(0, 2);
	let profile = null;
	let sawDev = false;
	let sawCommand = false;
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === void 0) {continue;}
		if (sawCommand) {
			out.push(arg);
			continue;
		}
		if (arg === "--dev") {
			if (profile && profile !== "dev") {return {
				ok: false,
				error: "Cannot combine --dev with --profile"
			};}
			sawDev = true;
			profile = "dev";
			continue;
		}
		if (arg === "--profile" || arg.startsWith("--profile=")) {
			if (sawDev) {return {
				ok: false,
				error: "Cannot combine --dev with --profile"
			};}
			const next = args[i + 1];
			const { value, consumedNext } = takeValue(arg, next);
			if (consumedNext) {i += 1;}
			if (!value) {return {
				ok: false,
				error: "--profile requires a value"
			};}
			if (!isValidProfileName(value)) {return {
				ok: false,
				error: "Invalid --profile (use letters, numbers, \"_\", \"-\" only)"
			};}
			profile = value;
			continue;
		}
		if (!arg.startsWith("-")) {
			sawCommand = true;
			out.push(arg);
			continue;
		}
		out.push(arg);
	}
	return {
		ok: true,
		profile,
		argv: out
	};
}
function resolveProfileStateDir(profile, env, homedir) {
	const suffix = profile.toLowerCase() === "default" ? "" : `-${profile}`;
	return path.join(resolveRequiredHomeDir(env, homedir), `.openclaw${suffix}`);
}
function applyCliProfileEnv(params) {
	const env = params.env ?? process.env;
	const homedir = params.homedir ?? os.homedir;
	const profile = params.profile.trim();
	if (!profile) {return;}
	env.OPENCLAW_PROFILE = profile;
	const stateDir = env.OPENCLAW_STATE_DIR?.trim() || resolveProfileStateDir(profile, env, homedir);
	if (!env.OPENCLAW_STATE_DIR?.trim()) {env.OPENCLAW_STATE_DIR = stateDir;}
	if (!env.OPENCLAW_CONFIG_PATH?.trim()) {env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");}
	if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {env.OPENCLAW_GATEWAY_PORT = "19001";}
}
//#endregion
//#region src/cli/windows-argv.ts
function normalizeWindowsArgv(argv) {
	if (process.platform !== "win32") {return argv;}
	if (argv.length < 2) {return argv;}
	const stripControlChars = (value) => {
		let out = "";
		for (let i = 0; i < value.length; i += 1) {
			const code = value.charCodeAt(i);
			if (code >= 32 && code !== 127) {out += value[i];}
		}
		return out;
	};
	const normalizeArg = (value) => stripControlChars(value).replace(/^['"]+|['"]+$/g, "").trim();
	const normalizeCandidate = (value) => normalizeArg(value).replace(/^\\\\\\?\\/, "");
	const execPath = normalizeCandidate(process.execPath);
	const execPathLower = execPath.toLowerCase();
	const execBase = path.basename(execPath).toLowerCase();
	const isExecPath = (value) => {
		if (!value) {return false;}
		const normalized = normalizeCandidate(value);
		if (!normalized) {return false;}
		const lower = normalized.toLowerCase();
		return lower === execPathLower || path.basename(lower) === execBase || lower.endsWith("\\node.exe") || lower.endsWith("/node.exe") || lower.includes("node.exe") || path.basename(lower) === "node.exe" && fs.existsSync(normalized);
	};
	const next = [...argv];
	for (let i = 1; i <= 3 && i < next.length;) {
		if (isExecPath(next[i])) {
			next.splice(i, 1);
			continue;
		}
		i += 1;
	}
	const filtered = next.filter((arg, index) => index === 0 || !isExecPath(arg));
	if (filtered.length < 3) {return filtered;}
	const cleaned = [...filtered];
	for (let i = 2; i < cleaned.length;) {
		const arg = cleaned[i];
		if (!arg || arg.startsWith("-")) {
			i += 1;
			continue;
		}
		if (isExecPath(arg)) {
			cleaned.splice(i, 1);
			continue;
		}
		break;
	}
	return cleaned;
}
//#endregion
export { applyCliProfileEnv as n, parseCliProfileArgs as r, normalizeWindowsArgv as t };
