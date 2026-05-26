import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { o as resolveRequiredHomeDir, s as resolveRequiredOsHomeDir } from "./home-dir-BOPFpGo8.js";
import { a as isSandboxHostPathAbsolute, c as splitSandboxBindSpec, i as getSandboxHostPathPolicyKey, o as normalizeSandboxHostPath, s as resolveSandboxHostPathViaExistingAncestor, t as getBlockedNetworkModeReason } from "./network-mode-BsO8g-R7.js";
import { _ as SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants-By80hBjs.js";
import path from "node:path";
import os from "node:os";
//#region src/agents/sandbox/validate-sandbox-security.ts
/**
* Sandbox security validation — blocks dangerous Docker configurations.
*
* Threat model: local-trusted config, but protect against foot-guns and config injection.
* Enforced at runtime when creating sandbox containers.
*/
const BLOCKED_HOST_PATHS = [
	"/etc",
	"/private/etc",
	"/proc",
	"/sys",
	"/dev",
	"/root",
	"/boot",
	"/run",
	"/var/run",
	"/private/var/run",
	"/var/run/docker.sock",
	"/private/var/run/docker.sock",
	"/run/docker.sock"
];
const BLOCKED_HOME_SUBPATHS = [
	".aws",
	".cargo",
	".config",
	".docker",
	".gnupg",
	".netrc",
	".npm",
	".ssh"
];
const BLOCKED_SECCOMP_PROFILES = new Set(["unconfined"]);
const BLOCKED_APPARMOR_PROFILES = new Set(["unconfined"]);
const RESERVED_CONTAINER_TARGET_PATHS = ["/workspace", SANDBOX_AGENT_WORKSPACE_MOUNT];
let blockedHostPathsCache;
function parseBindSpec(bind) {
	const trimmed = bind.trim();
	const parsed = splitSandboxBindSpec(trimmed);
	if (!parsed) return {
		source: trimmed,
		target: ""
	};
	return {
		source: parsed.host,
		target: parsed.container
	};
}
/**
* Parse the host/source path from a Docker bind mount string.
* Format: `source:target[:mode]`
*/
function parseBindSourcePath(bind) {
	return parseBindSpec(bind).source.trim();
}
function parseBindTargetPath(bind) {
	return parseBindSpec(bind).target.trim();
}
/**
* Normalize a POSIX path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
* If it starts with the drive letter, convert it to the upper case.
*/
function normalizeHostPath(raw) {
	return normalizeSandboxHostPath(raw);
}
/**
* String-only blocked-path check (no filesystem I/O).
* Blocks:
* - binds that target blocked paths (equal or under)
* - binds that cover the system root (mounting "/" is never safe)
* - non-absolute source paths (relative / volume names) because they are hard to validate safely
*/
function getBlockedBindReason(bind) {
	const sourceRaw = parseBindSourcePath(bind);
	if (!isSandboxHostPathAbsolute(sourceRaw)) return {
		kind: "non_absolute",
		sourcePath: sourceRaw
	};
	const normalized = normalizeHostPath(sourceRaw);
	const blockedHostPaths = getBlockedHostPaths();
	const directReason = getBlockedReasonForSourcePath(normalized, blockedHostPaths);
	if (directReason) return directReason;
	const canonical = resolveSandboxHostPathViaExistingAncestor(normalized);
	if (canonical !== normalized) return getBlockedReasonForSourcePath(canonical, blockedHostPaths);
	return null;
}
function getBlockedReasonForSourcePath(sourceNormalized, blockedHostPaths) {
	if (sourceNormalized === "/") return {
		kind: "covers",
		blockedPath: "/"
	};
	const sourceKey = getSandboxHostPathPolicyKey(sourceNormalized);
	for (const blocked of blockedHostPaths) {
		const blockedKey = getSandboxHostPathPolicyKey(blocked);
		if (sourceKey === blockedKey || sourceKey.startsWith(`${blockedKey}/`)) return {
			kind: "targets",
			blockedPath: blocked
		};
	}
	return null;
}
function getBlockedHostPaths() {
	const cacheKey = JSON.stringify({
		home: process.env.HOME,
		openclawHome: process.env.OPENCLAW_HOME,
		osHome: os.homedir(),
		userProfile: process.env.USERPROFILE
	});
	if (blockedHostPathsCache?.key === cacheKey) return blockedHostPathsCache.paths;
	const blocked = new Set(BLOCKED_HOST_PATHS.map(normalizeHostPath));
	for (const home of getBlockedHomeRoots()) for (const suffix of BLOCKED_HOME_SUBPATHS) blocked.add(normalizeHostPath(path.posix.join(home, suffix)));
	blockedHostPathsCache = {
		key: cacheKey,
		paths: [...blocked]
	};
	return blockedHostPathsCache.paths;
}
function getBlockedHomeRoots() {
	const roots = /* @__PURE__ */ new Set();
	for (const candidate of [
		process.env.OPENCLAW_HOME,
		process.env.HOME,
		process.env.USERPROFILE,
		resolveRequiredHomeDir(process.env, os.homedir),
		resolveRequiredOsHomeDir(process.env, os.homedir)
	]) {
		if (!candidate) continue;
		const normalized = normalizeHostPath(candidate);
		if (normalized !== "/") roots.add(normalized);
		const canonical = resolveSandboxHostPathViaExistingAncestor(normalized);
		if (canonical !== "/") roots.add(canonical);
	}
	return [...roots];
}
function normalizeAllowedRoots(roots) {
	if (!roots?.length) return [];
	const normalized = roots.map((entry) => entry.trim()).filter(isSandboxHostPathAbsolute).map(normalizeHostPath);
	const expanded = /* @__PURE__ */ new Set();
	for (const root of normalized) {
		expanded.add(root);
		const real = resolveSandboxHostPathViaExistingAncestor(root);
		if (real !== root) expanded.add(real);
	}
	return [...expanded];
}
function isPathInsidePosix(root, target) {
	if (root === "/") return true;
	const rootKey = getSandboxHostPathPolicyKey(root);
	const targetKey = getSandboxHostPathPolicyKey(target);
	return targetKey === rootKey || targetKey.startsWith(`${rootKey}/`);
}
function getOutsideAllowedRootsReason(sourceNormalized, allowedRoots) {
	if (allowedRoots.length === 0) return null;
	for (const root of allowedRoots) if (isPathInsidePosix(root, sourceNormalized)) return null;
	return {
		kind: "outside_allowed_roots",
		sourcePath: sourceNormalized,
		allowedRoots
	};
}
function getReservedTargetReason(bind) {
	const targetRaw = parseBindTargetPath(bind);
	if (!targetRaw || !targetRaw.startsWith("/")) return null;
	const target = normalizeHostPath(targetRaw);
	for (const reserved of RESERVED_CONTAINER_TARGET_PATHS) if (isPathInsidePosix(reserved, target)) return {
		kind: "reserved_target",
		targetPath: target,
		reservedPath: reserved
	};
	return null;
}
function enforceSourcePathPolicy(params) {
	const blockedReason = getBlockedReasonForSourcePath(params.sourcePath, params.blockedHostPaths);
	if (blockedReason) throw formatBindBlockedError({
		bind: params.bind,
		reason: blockedReason
	});
	if (params.allowSourcesOutsideAllowedRoots) return;
	const allowedReason = getOutsideAllowedRootsReason(params.sourcePath, params.allowedRoots);
	if (allowedReason) throw formatBindBlockedError({
		bind: params.bind,
		reason: allowedReason
	});
}
function formatBindBlockedError(params) {
	if (params.reason.kind === "non_absolute") return /* @__PURE__ */ new Error(`Sandbox security: bind mount "${params.bind}" uses a non-absolute source path "${params.reason.sourcePath}". Only absolute POSIX or Windows drive-letter paths are supported for sandbox binds.`);
	if (params.reason.kind === "outside_allowed_roots") return /* @__PURE__ */ new Error(`Sandbox security: bind mount "${params.bind}" source "${params.reason.sourcePath}" is outside allowed roots (${params.reason.allowedRoots.join(", ")}). Use a dangerous override only when you fully trust this runtime.`);
	if (params.reason.kind === "reserved_target") return /* @__PURE__ */ new Error(`Sandbox security: bind mount "${params.bind}" targets reserved container path "${params.reason.reservedPath}" (resolved target: "${params.reason.targetPath}"). This can shadow OpenClaw sandbox mounts. Use a dangerous override only when you fully trust this runtime.`);
	const verb = params.reason.kind === "covers" ? "covers" : "targets";
	return /* @__PURE__ */ new Error(`Sandbox security: bind mount "${params.bind}" ${verb} blocked path "${params.reason.blockedPath}". Mounting system directories, credential paths, or Docker socket paths into sandbox containers is not allowed. Use project-specific paths instead (e.g. /home/user/myproject).`);
}
/**
* Validate bind mounts — throws if any source path is dangerous.
* Includes a symlink/realpath pass via existing ancestors so non-existent leaf
* paths cannot bypass source-root and blocked-path checks.
*/
function validateBindMounts(binds, options) {
	if (!binds?.length) return;
	const allowedRoots = normalizeAllowedRoots(options?.allowedSourceRoots);
	const blockedHostPaths = getBlockedHostPaths();
	for (const rawBind of binds) {
		const bind = rawBind.trim();
		if (!bind) continue;
		const blocked = getBlockedBindReason(bind);
		if (blocked) throw formatBindBlockedError({
			bind,
			reason: blocked
		});
		if (!options?.allowReservedContainerTargets) {
			const reservedTarget = getReservedTargetReason(bind);
			if (reservedTarget) throw formatBindBlockedError({
				bind,
				reason: reservedTarget
			});
		}
		const sourceNormalized = normalizeHostPath(parseBindSourcePath(bind));
		enforceSourcePathPolicy({
			bind,
			sourcePath: sourceNormalized,
			allowedRoots,
			blockedHostPaths,
			allowSourcesOutsideAllowedRoots: options?.allowSourcesOutsideAllowedRoots === true
		});
		enforceSourcePathPolicy({
			bind,
			sourcePath: resolveSandboxHostPathViaExistingAncestor(sourceNormalized),
			allowedRoots,
			blockedHostPaths,
			allowSourcesOutsideAllowedRoots: options?.allowSourcesOutsideAllowedRoots === true
		});
	}
}
function validateNetworkMode(network, options) {
	const blockedReason = getBlockedNetworkModeReason({
		network,
		allowContainerNamespaceJoin: options?.allowContainerNamespaceJoin
	});
	if (blockedReason === "host") throw new Error(`Sandbox security: network mode "${network}" is blocked. Network "host" mode bypasses container network isolation. Use "bridge" or "none" instead.`);
	if (blockedReason === "container_namespace_join") throw new Error(`Sandbox security: network mode "${network}" is blocked by default. Network "container:*" joins another container namespace and bypasses sandbox network isolation. Use a custom bridge network, or set dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime.`);
}
function validateSeccompProfile(profile) {
	if (profile && BLOCKED_SECCOMP_PROFILES.has(normalizeOptionalLowercaseString(profile) ?? "")) throw new Error(`Sandbox security: seccomp profile "${profile}" is blocked. Disabling seccomp removes syscall filtering and weakens sandbox isolation. Use a custom seccomp profile file or omit this setting.`);
}
function validateApparmorProfile(profile) {
	if (profile && BLOCKED_APPARMOR_PROFILES.has(normalizeOptionalLowercaseString(profile) ?? "")) throw new Error(`Sandbox security: apparmor profile "${profile}" is blocked. Disabling AppArmor removes mandatory access controls and weakens sandbox isolation. Use a named AppArmor profile or omit this setting.`);
}
function validateSandboxSecurity(cfg) {
	validateBindMounts(cfg.binds, cfg);
	validateNetworkMode(cfg.network, { allowContainerNamespaceJoin: cfg.dangerouslyAllowContainerNamespaceJoin === true });
	validateSeccompProfile(cfg.seccompProfile);
	validateApparmorProfile(cfg.apparmorProfile);
}
//#endregion
export { validateNetworkMode as n, validateSandboxSecurity as r, getBlockedBindReason as t };
