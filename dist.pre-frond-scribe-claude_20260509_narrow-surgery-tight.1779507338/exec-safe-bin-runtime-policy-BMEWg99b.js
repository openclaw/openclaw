import { A as resolveSafeBinProfiles, i as normalizeTrustedSafeBinDirs, k as normalizeSafeBinProfileFixtures, r as listWritableExplicitTrustedSafeBinDirs, s as normalizeSafeBinName, t as getTrustedSafeBinDirs } from "./exec-safe-bin-trust-DTg2jg2F.js";
import { s as resolveSafeBins } from "./exec-approvals-allowlist-BjAFmd5_.js";
//#region src/infra/exec-safe-bin-runtime-policy.ts
const INTERPRETER_LIKE_SAFE_BINS = new Set([
	"ash",
	"awk",
	"bash",
	"busybox",
	"bun",
	"cmd",
	"cmd.exe",
	"cscript",
	"dash",
	"deno",
	"fish",
	"gawk",
	"gsed",
	"ksh",
	"lua",
	"mawk",
	"nawk",
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
	"sed",
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
	const trustedSafeBinDirs = getTrustedSafeBinDirs({
		extraDirs: explicitTrustedSafeBinDirs,
		safeBins: Array.from(safeBins)
	});
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
export { resolveMergedSafeBinProfileFixtures as i, listInterpreterLikeSafeBins as n, resolveExecSafeBinRuntimePolicy as r, isInterpreterLikeSafeBin as t };
