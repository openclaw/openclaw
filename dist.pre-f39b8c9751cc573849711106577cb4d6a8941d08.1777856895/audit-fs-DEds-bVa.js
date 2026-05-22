import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { t as createSubsystemLogger } from "./subsystem-CgTF-J8V.js";
import { i as runExec } from "./exec-uw0kHiSj.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region src/security/windows-acl.ts
const log = createSubsystemLogger("security/windows-acl");
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
	"nt authority\\authenticated users"
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
const TRUSTED_SUFFIXES = [
	"\\administrators",
	"\\system",
	"\\système"
];
const SID_RE = /^\*?s-\d+-\d+(-\d+)+$/i;
const TRUSTED_SIDS = new Set([
	"s-1-5-18",
	"s-1-5-32-544",
	"s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
]);
const WORLD_SIDS = new Set([
	"s-1-1-0",
	"s-1-5-11",
	"s-1-5-32-545"
]);
const STATUS_PREFIXES = [
	"successfully processed",
	"processed",
	"failed processing",
	"no mapping between account names"
];
const normalize = (value) => normalizeLowercaseStringOrEmpty(value);
const defaultWindowsUserInfo = () => os.userInfo();
function normalizeSid(value) {
	const normalized = normalize(value);
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
		trusted.add(normalize(principal));
		const userOnly = principal.split("\\").at(-1);
		if (userOnly) trusted.add(normalize(userOnly));
	}
	const userSid = normalizeSid(env?.USERSID ?? "");
	if (userSid && SID_RE.test(userSid) && !WORLD_SIDS.has(userSid)) trusted.add(userSid);
	return trusted;
}
function resolveWindowsSystemCommand(command, env) {
	const root = env?.SystemRoot?.trim() || env?.SYSTEMROOT?.trim() || env?.windir?.trim() || env?.WINDIR?.trim();
	return root ? path.win32.join(root, "System32", command) : command;
}
function classifyPrincipal(principal, trustedPrincipals) {
	const normalized = normalize(principal);
	if (SID_RE.test(normalized)) {
		const sid = normalizeSid(normalized);
		if (WORLD_SIDS.has(sid)) return "world";
		if (TRUSTED_SIDS.has(sid) || trustedPrincipals.has(sid)) return "trusted";
		return "group";
	}
	if (trustedPrincipals.has(normalized) || TRUSTED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return "trusted";
	if (WORLD_PRINCIPALS.has(normalized) || WORLD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return "world";
	const stripped = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	if (stripped !== normalized && (TRUSTED_BASE.has(stripped) || TRUSTED_SUFFIXES.some((suffix) => {
		const strippedSuffix = suffix.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
		return stripped.endsWith(strippedSuffix);
	}))) return "trusted";
	return "group";
}
function rightsFromTokens(tokens) {
	const upper = tokens.join("").toUpperCase();
	const canWrite = upper.includes("F") || upper.includes("M") || upper.includes("W") || upper.includes("D");
	return {
		canRead: upper.includes("F") || upper.includes("M") || upper.includes("R"),
		canWrite
	};
}
function isStatusLine(lowerLine) {
	return STATUS_PREFIXES.some((prefix) => lowerLine.startsWith(prefix));
}
function stripTargetPrefix(params) {
	if (params.lowerLine.startsWith(params.lowerTarget)) return params.trimmedLine.slice(params.normalizedTarget.length).trim();
	if (params.lowerLine.startsWith(params.quotedLower)) return params.trimmedLine.slice(params.quotedTarget.length).trim();
	return params.trimmedLine;
}
function parseAceEntry(entry) {
	if (!entry || !entry.includes("(")) return null;
	const idx = entry.indexOf(":");
	if (idx === -1) return null;
	const principal = entry.slice(0, idx).trim();
	const rawRights = entry.slice(idx + 1).trim();
	const tokens = rawRights.match(/\(([^)]+)\)/g)?.map((token) => token.slice(1, -1).trim()).filter(Boolean) ?? [];
	if (tokens.some((token) => token.toUpperCase() === "DENY")) return null;
	const rights = tokens.filter((token) => !INHERIT_FLAGS.has(token.toUpperCase()));
	if (rights.length === 0) return null;
	const { canRead, canWrite } = rightsFromTokens(rights);
	return {
		principal,
		rights,
		rawRights,
		canRead,
		canWrite
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
		if (isStatusLine(lower)) continue;
		const parsed = parseAceEntry(stripTargetPrefix({
			trimmedLine: trimmed,
			lowerLine: lower,
			normalizedTarget,
			lowerTarget,
			quotedTarget,
			quotedLower
		}));
		if (!parsed) continue;
		entries.push(parsed);
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
	} catch (err) {
		log.warn("resolveCurrentUserSid failed", { error: String(err) });
		return null;
	}
}
async function inspectWindowsAcl(targetPath, opts) {
	const exec = opts?.exec ?? runExec;
	try {
		const { stdout, stderr } = await exec(resolveWindowsSystemCommand("icacls.exe", opts?.env), [targetPath, "/sid"]);
		const entries = parseIcaclsOutput(`${stdout}\n${stderr}`.trim(), targetPath);
		let effectiveEnv = opts?.env;
		let { trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, effectiveEnv);
		if (!effectiveEnv?.USERSID && untrustedGroup.some((entry) => SID_RE.test(normalize(entry.principal)))) {
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
	if (untrusted.length === 0) return "trusted-only";
	return untrusted.map((entry) => `${entry.principal}:${entry.rawRights}`).join(", ");
}
function formatIcaclsResetCommand(targetPath, opts) {
	const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo) ?? "%USERNAME%";
	const grant = opts.isDir ? "(OI)(CI)F" : "F";
	return `icacls "${targetPath}" /inheritance:r /grant:r "${user}:${grant}" /grant:r "*S-1-5-18:${grant}"`;
}
function createIcaclsResetCommand(targetPath, opts) {
	const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo);
	if (!user) return null;
	const grant = opts.isDir ? "(OI)(CI)F" : "F";
	return {
		command: "icacls",
		args: [
			targetPath,
			"/inheritance:r",
			"/grant:r",
			`${user}:${grant}`,
			"/grant:r",
			`*S-1-5-18:${grant}`
		],
		display: formatIcaclsResetCommand(targetPath, opts)
	};
}
//#endregion
//#region src/security/audit-fs.ts
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
	if (mode == null) return null;
	return mode & 511;
}
function formatOctal(bits) {
	if (bits == null) return "unknown";
	return bits.toString(8).padStart(3, "0");
}
function isWorldWritable(bits) {
	if (bits == null) return false;
	return (bits & 2) !== 0;
}
function isGroupWritable(bits) {
	if (bits == null) return false;
	return (bits & 16) !== 0;
}
function isWorldReadable(bits) {
	if (bits == null) return false;
	return (bits & 4) !== 0;
}
function isGroupReadable(bits) {
	if (bits == null) return false;
	return (bits & 32) !== 0;
}
//#endregion
export { isGroupReadable as a, isWorldWritable as c, createIcaclsResetCommand as d, formatIcaclsResetCommand as f, inspectPathPermissions as i, modeBits as l, formatPermissionDetail as n, isGroupWritable as o, formatPermissionRemediation as r, isWorldReadable as s, formatOctal as t, safeStat as u };
