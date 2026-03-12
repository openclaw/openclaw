import { Nn as listWritableExplicitTrustedSafeBinDirs, Pn as normalizeTrustedSafeBinDirs, jn as getTrustedSafeBinDirs, nr as normalizeSafeBinProfileFixtures, rr as resolveSafeBinProfiles } from "./model-selection-DILdVnl8.js";
import { i as resolveSafeBins } from "./exec-approvals-allowlist-B_EvDB3X.js";

//#region src/infra/exec-safe-bin-runtime-policy.ts
const INTERPRETER_LIKE_SAFE_BINS = new Set([
	"ash",
	"bash",
	"busybox",
	"bun",
	"cmd",
	"cmd.exe",
	"cscript",
	"dash",
	"deno",
	"fish",
	"ksh",
	"lua",
	"node",
	"nodejs",
	"perl",
	"php",
	"powershell",
	"powershell.exe",
	"pypy",
	"pwsh",
	"pwsh.exe",
	"python",
	"python2",
	"python3",
	"ruby",
	"sh",
	"toybox",
	"wscript",
	"zsh"
]);
const INTERPRETER_LIKE_PATTERNS = [
	/^python\d+(?:\.\d+)?$/,
	/^ruby\d+(?:\.\d+)?$/,
	/^perl\d+(?:\.\d+)?$/,
	/^php\d+(?:\.\d+)?$/,
	/^node\d+(?:\.\d+)?$/
];
function normalizeSafeBinName(raw) {
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) return "";
	return trimmed.split(/[\\/]/).at(-1) ?? trimmed;
}
function isInterpreterLikeSafeBin(raw) {
	const normalized = normalizeSafeBinName(raw);
	if (!normalized) return false;
	if (INTERPRETER_LIKE_SAFE_BINS.has(normalized)) return true;
	return INTERPRETER_LIKE_PATTERNS.some((pattern) => pattern.test(normalized));
}
function listInterpreterLikeSafeBins(entries) {
	return Array.from(entries).map((entry) => normalizeSafeBinName(entry)).filter((entry) => entry.length > 0 && isInterpreterLikeSafeBin(entry)).toSorted();
}
function resolveMergedSafeBinProfileFixtures(params) {
	const global = normalizeSafeBinProfileFixtures(params.global?.safeBinProfiles);
	const local = normalizeSafeBinProfileFixtures(params.local?.safeBinProfiles);
	if (Object.keys(global).length === 0 && Object.keys(local).length === 0) return;
	return {
		...global,
		...local
	};
}
function resolveExecSafeBinRuntimePolicy(params) {
	const safeBins = resolveSafeBins(params.local?.safeBins ?? params.global?.safeBins);
	const safeBinProfiles = resolveSafeBinProfiles(resolveMergedSafeBinProfileFixtures({
		global: params.global,
		local: params.local
	}));
	const unprofiledSafeBins = Array.from(safeBins).filter((entry) => !safeBinProfiles[entry]).toSorted();
	const explicitTrustedSafeBinDirs = [...normalizeTrustedSafeBinDirs(params.global?.safeBinTrustedDirs), ...normalizeTrustedSafeBinDirs(params.local?.safeBinTrustedDirs)];
	const trustedSafeBinDirs = getTrustedSafeBinDirs({ extraDirs: explicitTrustedSafeBinDirs });
	const writableTrustedSafeBinDirs = listWritableExplicitTrustedSafeBinDirs(explicitTrustedSafeBinDirs);
	if (params.onWarning) for (const hit of writableTrustedSafeBinDirs) {
		const scope = hit.worldWritable || hit.groupWritable ? hit.worldWritable ? "world-writable" : "group-writable" : "writable";
		params.onWarning(`exec: safeBinTrustedDirs includes ${scope} directory '${hit.dir}'; remove trust or tighten permissions (for example chmod 755).`);
	}
	return {
		safeBins,
		safeBinProfiles,
		trustedSafeBinDirs,
		unprofiledSafeBins,
		unprofiledInterpreterSafeBins: listInterpreterLikeSafeBins(unprofiledSafeBins),
		writableTrustedSafeBinDirs
	};
}

//#endregion
export { resolveExecSafeBinRuntimePolicy as n, resolveMergedSafeBinProfileFixtures as r, listInterpreterLikeSafeBins as t };