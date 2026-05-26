import { t as normalizeLowercaseStringOrEmpty } from "./string-coerce-6TL5VVOL.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region node_modules/@openclaw/fs-safe/dist/permissions.js
const execFileAsync = promisify(execFile);
const INHERIT_FLAGS = new Set([
	"I",
	"OI",
	"CI",
	"IO",
	"NP"
]);
const WORLD_PRINCIPALS = new Set([
	"everyone",
	"users",
	"builtin\\users",
	"authenticated users",
	"nt authority\\authenticated users",
	"anonymous logon",
	"nt authority\\anonymous logon",
	"guests",
	"builtin\\guests",
	"interactive",
	"nt authority\\interactive",
	"network",
	"nt authority\\network",
	"local"
]);
const TRUSTED_BASE = new Set([
	"nt authority\\system",
	"system",
	"builtin\\administrators",
	"creator owner",
	"autorite nt\\système",
	"nt-autorität\\system",
	"autoridad nt\\system",
	"autoridade nt\\system"
]);
const WORLD_SUFFIXES = ["\\users", "\\authenticated users"];
const SID_RE = /^\*?s-\d+-\d+(-\d+)+$/i;
const TRUSTED_SIDS = new Set([
	"s-1-5-18",
	"s-1-5-32-544",
	"s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
]);
const WORLD_SIDS = new Set([
	"s-1-1-0",
	"s-1-5-11",
	"s-1-5-32-545",
	"s-1-5-7",
	"s-1-5-32-546",
	"s-1-5-4",
	"s-1-2-0",
	"s-1-5-2"
]);
const STATUS_PREFIXES = [
	"successfully processed",
	"processed",
	"failed processing",
	"no mapping between account names"
];
function stripDiacritics(value) {
	return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
const TRUSTED_BASE_ASCII = new Set([...TRUSTED_BASE].map(stripDiacritics));
const normalize$1 = (value) => normalizeLowercaseStringOrEmpty(value);
const defaultWindowsUserInfo = () => os.userInfo();
function defaultPermissionExec(command, args) {
	return execFileAsync(command, args, {
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 1024 * 1024
	});
}
async function safeStat(targetPath) {
	try {
		const lst = await fs.lstat(targetPath);
		return {
			ok: true,
			isSymlink: lst.isSymbolicLink(),
			isDir: lst.isDirectory(),
			mode: typeof lst.mode === "number" ? lst.mode : null,
			uid: typeof lst.uid === "number" ? lst.uid : null,
			gid: typeof lst.gid === "number" ? lst.gid : null
		};
	} catch (err) {
		return {
			ok: false,
			isSymlink: false,
			isDir: false,
			mode: null,
			uid: null,
			gid: null,
			error: String(err)
		};
	}
}
async function inspectPathPermissions(targetPath, opts) {
	const st = await safeStat(targetPath);
	if (!st.ok) return {
		ok: false,
		isSymlink: false,
		isDir: false,
		mode: null,
		bits: null,
		source: "unknown",
		worldWritable: false,
		groupWritable: false,
		worldReadable: false,
		groupReadable: false,
		error: st.error
	};
	let effectiveMode = st.mode;
	let effectiveIsDir = st.isDir;
	if (st.isSymlink) try {
		const target = await fs.stat(targetPath);
		effectiveMode = typeof target.mode === "number" ? target.mode : st.mode;
		effectiveIsDir = target.isDirectory();
	} catch {}
	const bits = modeBits(effectiveMode);
	if ((opts?.platform ?? process.platform) === "win32") {
		const acl = await inspectWindowsAcl(targetPath, {
			env: opts?.env,
			exec: opts?.exec
		});
		if (!acl.ok) return {
			ok: true,
			isSymlink: st.isSymlink,
			isDir: effectiveIsDir,
			mode: effectiveMode,
			bits,
			source: "unknown",
			worldWritable: false,
			groupWritable: false,
			worldReadable: false,
			groupReadable: false,
			error: acl.error
		};
		return {
			ok: true,
			isSymlink: st.isSymlink,
			isDir: effectiveIsDir,
			mode: effectiveMode,
			bits,
			source: "windows-acl",
			worldWritable: acl.untrustedWorld.some((entry) => entry.canWrite),
			groupWritable: acl.untrustedGroup.some((entry) => entry.canWrite),
			worldReadable: acl.untrustedWorld.some((entry) => entry.canRead),
			groupReadable: acl.untrustedGroup.some((entry) => entry.canRead),
			aclSummary: formatWindowsAclSummary(acl)
		};
	}
	return {
		ok: true,
		isSymlink: st.isSymlink,
		isDir: effectiveIsDir,
		mode: effectiveMode,
		bits,
		source: "posix",
		worldWritable: isWorldWritable(bits),
		groupWritable: isGroupWritable(bits),
		worldReadable: isWorldReadable(bits),
		groupReadable: isGroupReadable(bits)
	};
}
function formatPermissionDetail(targetPath, perms) {
	if (perms.source === "windows-acl") return `${targetPath} acl=${perms.aclSummary ?? "unknown"}`;
	return `${targetPath} mode=${formatOctal(perms.bits)}`;
}
function formatPermissionRemediation(params) {
	if (params.perms.source === "windows-acl") return formatIcaclsResetCommand(params.targetPath, {
		isDir: params.isDir,
		env: params.env
	});
	return `chmod ${params.posixMode.toString(8).padStart(3, "0")} ${params.targetPath}`;
}
function modeBits(mode) {
	return mode == null ? null : mode & 511;
}
function formatOctal(bits) {
	return bits == null ? "unknown" : bits.toString(8).padStart(3, "0");
}
function isWorldWritable(bits) {
	return bits != null && (bits & 2) !== 0;
}
function isGroupWritable(bits) {
	return bits != null && (bits & 16) !== 0;
}
function isWorldReadable(bits) {
	return bits != null && (bits & 4) !== 0;
}
function isGroupReadable(bits) {
	return bits != null && (bits & 32) !== 0;
}
function normalizeSid(value) {
	const normalized = normalize$1(value);
	return normalized.startsWith("*") ? normalized.slice(1) : normalized;
}
function resolveWindowsUserPrincipal(env, userInfo = defaultWindowsUserInfo) {
	const username = env?.USERNAME?.trim() || userInfo().username?.trim();
	if (!username) return null;
	const domain = env?.USERDOMAIN?.trim();
	return domain ? `${domain}\\${username}` : username;
}
function buildTrustedPrincipals(env) {
	const trusted = new Set(TRUSTED_BASE);
	const principal = resolveWindowsUserPrincipal(env);
	if (principal) {
		trusted.add(normalize$1(principal));
		const userOnly = principal.split("\\").at(-1);
		if (userOnly) trusted.add(normalize$1(userOnly));
	}
	const userSid = normalizeSid(env?.USERSID ?? "");
	if (userSid && SID_RE.test(userSid) && !WORLD_SIDS.has(userSid)) trusted.add(userSid);
	return trusted;
}
function getEnvValueCaseInsensitive(env, name) {
	const direct = env[name];
	if (direct !== void 0) return direct;
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === lower) return value;
}
function normalizeWindowsInstallRoot(value) {
	const trimmed = value?.trim();
	if (!trimmed || !path.win32.isAbsolute(trimmed)) return null;
	return trimmed.replace(/[\\/]+$/, "");
}
function resolveWindowsSystemRoot(env) {
	const source = env ?? process.env;
	return normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(source, "SystemRoot")) ?? normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(source, "WINDIR")) ?? "C:\\Windows";
}
function resolveWindowsSystemCommand(command, env) {
	const root = resolveWindowsSystemRoot(env);
	return path.win32.join(root, "System32", command);
}
function classifyPrincipal(principal, trustedPrincipals) {
	const normalized = normalize$1(principal);
	if (SID_RE.test(normalized)) {
		const sid = normalizeSid(normalized);
		if (WORLD_SIDS.has(sid)) return "world";
		if (TRUSTED_SIDS.has(sid) || trustedPrincipals.has(sid)) return "trusted";
		return "group";
	}
	if (trustedPrincipals.has(normalized) || TRUSTED_BASE.has(normalized)) return "trusted";
	if (WORLD_PRINCIPALS.has(normalized) || WORLD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return "world";
	const stripped = stripDiacritics(normalized);
	if (stripped !== normalized && TRUSTED_BASE_ASCII.has(stripped)) return "trusted";
	return "group";
}
function rightsFromTokens(tokens) {
	const upper = tokens.join("").toUpperCase();
	return {
		canWrite: upper.includes("F") || upper.includes("M") || upper.includes("W") || upper.includes("D"),
		canRead: upper.includes("F") || upper.includes("M") || upper.includes("R")
	};
}
function stripTargetPrefix(params) {
	if (params.lowerLine.startsWith(params.lowerTarget)) return params.trimmedLine.slice(params.normalizedTarget.length).trim();
	if (params.lowerLine.startsWith(params.quotedLower)) return params.trimmedLine.slice(params.quotedTarget.length).trim();
	return params.trimmedLine;
}
function parseAceEntry(entry) {
	if (!entry.includes("(")) return null;
	const idx = entry.indexOf(":");
	if (idx === -1) return null;
	const principal = entry.slice(0, idx).trim();
	const rawRights = entry.slice(idx + 1).trim();
	const tokens = rawRights.match(/\(([^)]+)\)/g)?.map((token) => token.slice(1, -1).trim()).filter(Boolean) ?? [];
	if (tokens.some((token) => token.toUpperCase() === "DENY")) return null;
	const rights = tokens.filter((token) => !INHERIT_FLAGS.has(token.toUpperCase()));
	if (rights.length === 0) return null;
	return {
		principal,
		rights,
		rawRights,
		...rightsFromTokens(rights)
	};
}
function parseIcaclsOutput(output, targetPath) {
	const entries = [];
	const normalizedTarget = targetPath.trim();
	const lowerTarget = normalizedTarget.toLowerCase();
	const quotedTarget = `"${normalizedTarget}"`;
	const quotedLower = quotedTarget.toLowerCase();
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line.trim()) continue;
		const trimmed = line.trim();
		const lower = trimmed.toLowerCase();
		if (STATUS_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
		const parsed = parseAceEntry(stripTargetPrefix({
			trimmedLine: trimmed,
			lowerLine: lower,
			normalizedTarget,
			lowerTarget,
			quotedTarget,
			quotedLower
		}));
		if (parsed) entries.push(parsed);
	}
	return entries;
}
function summarizeWindowsAcl(entries, env) {
	const trustedPrincipals = buildTrustedPrincipals(env);
	const trusted = [];
	const untrustedWorld = [];
	const untrustedGroup = [];
	for (const entry of entries) {
		const classification = classifyPrincipal(entry.principal, trustedPrincipals);
		if (classification === "trusted") trusted.push(entry);
		else if (classification === "world") untrustedWorld.push(entry);
		else untrustedGroup.push(entry);
	}
	return {
		trusted,
		untrustedWorld,
		untrustedGroup
	};
}
async function resolveCurrentUserSid(exec, env) {
	try {
		const { stdout, stderr } = await exec(resolveWindowsSystemCommand("whoami.exe", env), [
			"/user",
			"/fo",
			"csv",
			"/nh"
		]);
		const match = `${stdout}\n${stderr}`.match(/\*?S-\d+-\d+(?:-\d+)+/i);
		return match ? normalizeSid(match[0]) : null;
	} catch {
		return null;
	}
}
async function inspectWindowsAcl(targetPath, opts) {
	const exec = opts?.exec ?? defaultPermissionExec;
	try {
		const { stdout, stderr } = await exec(resolveWindowsSystemCommand("icacls.exe", opts?.env), [targetPath, "/sid"]);
		const entries = parseIcaclsOutput(`${stdout}\n${stderr}`.trim(), targetPath);
		let effectiveEnv = opts?.env;
		let { trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, effectiveEnv);
		if (!effectiveEnv?.USERSID && untrustedGroup.some((entry) => SID_RE.test(normalize$1(entry.principal)))) {
			const currentUserSid = await resolveCurrentUserSid(exec, effectiveEnv);
			if (currentUserSid) {
				effectiveEnv = {
					...effectiveEnv,
					USERSID: currentUserSid
				};
				({trusted, untrustedWorld, untrustedGroup} = summarizeWindowsAcl(entries, effectiveEnv));
			}
		}
		return {
			ok: true,
			entries,
			trusted,
			untrustedWorld,
			untrustedGroup
		};
	} catch (err) {
		return {
			ok: false,
			entries: [],
			trusted: [],
			untrustedWorld: [],
			untrustedGroup: [],
			error: String(err)
		};
	}
}
function formatWindowsAclSummary(summary) {
	if (!summary.ok) return "unknown";
	const untrusted = [...summary.untrustedWorld, ...summary.untrustedGroup];
	return untrusted.length === 0 ? "trusted-only" : untrusted.map((entry) => `${entry.principal}:${entry.rawRights}`).join(", ");
}
function formatIcaclsResetCommand(targetPath, opts) {
	const command = resolveWindowsSystemCommand("icacls.exe", opts.env);
	const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo) ?? "%USERNAME%";
	const grant = opts.isDir ? "(OI)(CI)F" : "F";
	return [
		command,
		`"${targetPath}"`,
		"/inheritance:r",
		"/grant:r",
		`"${user}:${grant}"`,
		"/grant:r",
		`"*S-1-5-18:${grant}"`
	].join(" ");
}
function createIcaclsResetCommand(targetPath, opts) {
	const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo);
	if (!user) return null;
	const grant = opts.isDir ? "(OI)(CI)F" : "F";
	const args = [
		targetPath,
		"/inheritance:r",
		"/grant:r",
		`${user}:${grant}`,
		"/grant:r",
		`*S-1-5-18:${grant}`
	];
	return {
		command: resolveWindowsSystemCommand("icacls.exe", opts.env),
		args,
		display: formatIcaclsResetCommand(targetPath, opts)
	};
}
//#endregion
export { inspectPathPermissions as a, isWorldReadable as c, safeStat as d, formatPermissionRemediation as i, isWorldWritable as l, formatIcaclsResetCommand as n, isGroupReadable as o, formatPermissionDetail as r, isGroupWritable as s, createIcaclsResetCommand as t, modeBits as u };
