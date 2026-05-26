import { t as compareOpenClawReleaseVersions } from "./npm-registry-spec-BwaWslDm.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { i as parseComparableSemver, t as compareComparableSemver } from "./semver-compare-BoMHoO1q.js";
import { r as fetchWithTimeout } from "./fetch-timeout-CptH2le9.js";
import { r as channelToNpmTag } from "./update-channels-f-ieRme5.js";
import { t as readPackageManagerSpec } from "./package-json-CWP51tfk.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/infra/detect-package-manager.ts
async function detectPackageManager$1(root) {
	const pm = (await readPackageManagerSpec(root))?.split("@")[0]?.trim();
	if (pm === "pnpm" || pm === "bun" || pm === "npm") return pm;
	const files = await fs.readdir(root).catch(() => []);
	if (files.includes("pnpm-lock.yaml")) return "pnpm";
	if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
	if (files.includes("package-lock.json")) return "npm";
	return null;
}
//#endregion
//#region src/infra/update-check.ts
function formatGitInstallLabel(update) {
	if (update.installKind !== "git") return null;
	const shortSha = update.git?.sha ? update.git.sha.slice(0, 8) : null;
	const branch = update.git?.branch && update.git.branch !== "HEAD" ? update.git.branch : null;
	const tag = update.git?.tag ?? null;
	return [
		branch ?? (tag ? "detached" : "git"),
		tag ? `tag ${tag}` : null,
		shortSha ? `@ ${shortSha}` : null
	].filter(Boolean).join(" · ");
}
async function exists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
async function detectPackageManager(root) {
	return await detectPackageManager$1(root) ?? "unknown";
}
async function detectGitRoot(root) {
	const res = await runCommandWithTimeout([
		"git",
		"-C",
		root,
		"rev-parse",
		"--show-toplevel"
	], { timeoutMs: 4e3 }).catch(() => null);
	if (!res || res.code !== 0) return null;
	const top = res.stdout.trim();
	return top ? path.resolve(top) : null;
}
async function checkGitUpdateStatus(params) {
	const timeoutMs = params.timeoutMs ?? 6e3;
	const root = path.resolve(params.root);
	const base = {
		root,
		sha: null,
		tag: null,
		branch: null,
		upstream: null,
		dirty: null,
		ahead: null,
		behind: null,
		fetchOk: null
	};
	const [branchRes, shaRes, tagRes, upstreamRes, dirtyRes] = await Promise.all([
		runCommandWithTimeout([
			"git",
			"-C",
			root,
			"rev-parse",
			"--abbrev-ref",
			"HEAD"
		], { timeoutMs }).catch(() => null),
		runCommandWithTimeout([
			"git",
			"-C",
			root,
			"rev-parse",
			"HEAD"
		], { timeoutMs }).catch(() => null),
		runCommandWithTimeout([
			"git",
			"-C",
			root,
			"describe",
			"--tags",
			"--exact-match"
		], { timeoutMs }).catch(() => null),
		runCommandWithTimeout([
			"git",
			"-C",
			root,
			"rev-parse",
			"--abbrev-ref",
			"@{upstream}"
		], { timeoutMs }).catch(() => null),
		runCommandWithTimeout([
			"git",
			"-C",
			root,
			"status",
			"--porcelain",
			"--",
			":!dist/control-ui/"
		], { timeoutMs }).catch(() => null)
	]);
	if (!branchRes || branchRes.code !== 0) return {
		...base,
		error: branchRes?.stderr?.trim() || "git unavailable"
	};
	const branch = branchRes.stdout.trim() || null;
	const sha = shaRes && shaRes.code === 0 ? shaRes.stdout.trim() : null;
	const tag = tagRes && tagRes.code === 0 ? tagRes.stdout.trim() : null;
	const upstream = upstreamRes && upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null;
	const dirty = dirtyRes && dirtyRes.code === 0 ? dirtyRes.stdout.trim().length > 0 : null;
	const fetchOk = params.fetch ? await runCommandWithTimeout([
		"git",
		"-C",
		root,
		"fetch",
		"--quiet",
		"--prune"
	], { timeoutMs }).then((r) => r.code === 0).catch(() => false) : null;
	const counts = upstream && upstream.length > 0 ? await runCommandWithTimeout([
		"git",
		"-C",
		root,
		"rev-list",
		"--left-right",
		"--count",
		`HEAD...${upstream}`
	], { timeoutMs }).catch(() => null) : null;
	const parseCounts = (raw) => {
		const parts = raw.trim().split(/\s+/);
		if (parts.length < 2) return null;
		const ahead = Number.parseInt(parts[0] ?? "", 10);
		const behind = Number.parseInt(parts[1] ?? "", 10);
		if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
		return {
			ahead,
			behind
		};
	};
	const parsed = counts && counts.code === 0 ? parseCounts(counts.stdout) : null;
	return {
		root,
		sha,
		tag,
		branch,
		upstream,
		dirty,
		ahead: parsed?.ahead ?? null,
		behind: parsed?.behind ?? null,
		fetchOk
	};
}
async function statMtimeMs(p) {
	try {
		return (await fs.stat(p)).mtimeMs;
	} catch {
		return null;
	}
}
function resolveDepsMarker(params) {
	const root = params.root;
	if (params.manager === "pnpm") return {
		lockfilePath: path.join(root, "pnpm-lock.yaml"),
		markerPath: path.join(root, "node_modules", ".modules.yaml")
	};
	if (params.manager === "bun") return {
		lockfilePath: path.join(root, "bun.lockb"),
		markerPath: path.join(root, "node_modules")
	};
	if (params.manager === "npm") return {
		lockfilePath: path.join(root, "package-lock.json"),
		markerPath: path.join(root, "node_modules")
	};
	return {
		lockfilePath: null,
		markerPath: null
	};
}
async function checkDepsStatus(params) {
	const { lockfilePath, markerPath } = resolveDepsMarker({
		root: path.resolve(params.root),
		manager: params.manager
	});
	if (!lockfilePath || !markerPath) return {
		manager: params.manager,
		status: "unknown",
		lockfilePath,
		markerPath,
		reason: "unknown package manager"
	};
	const lockExists = await exists(lockfilePath);
	const markerExists = await exists(markerPath);
	if (!lockExists) return {
		manager: params.manager,
		status: "unknown",
		lockfilePath,
		markerPath,
		reason: "lockfile missing"
	};
	if (!markerExists) return {
		manager: params.manager,
		status: "missing",
		lockfilePath,
		markerPath,
		reason: "node_modules marker missing"
	};
	const lockMtime = await statMtimeMs(lockfilePath);
	const markerMtime = await statMtimeMs(markerPath);
	if (!lockMtime || !markerMtime) return {
		manager: params.manager,
		status: "unknown",
		lockfilePath,
		markerPath
	};
	if (lockMtime > markerMtime + 1e3) return {
		manager: params.manager,
		status: "stale",
		lockfilePath,
		markerPath,
		reason: "lockfile newer than install marker"
	};
	return {
		manager: params.manager,
		status: "ok",
		lockfilePath,
		markerPath
	};
}
async function fetchNpmLatestVersion(params) {
	const res = await fetchNpmTagVersion({
		tag: "latest",
		timeoutMs: params?.timeoutMs
	});
	return {
		latestVersion: res.version,
		error: res.error
	};
}
async function fetchNpmRegistryVersionForChannel(params) {
	const res = await resolveNpmChannelTag({
		channel: params.channel,
		timeoutMs: params.timeoutMs
	});
	return {
		latestVersion: res.version,
		tag: res.tag
	};
}
async function fetchNpmPackageTargetStatus(params) {
	const timeoutMs = params.timeoutMs ?? 3500;
	const target = params.target;
	try {
		const res = await fetchWithTimeout(`https://registry.npmjs.org/openclaw/${encodeURIComponent(target)}`, {}, Math.max(250, timeoutMs));
		if (!res.ok) return {
			target,
			version: null,
			nodeEngine: null,
			error: `HTTP ${res.status}`
		};
		const json = await res.json();
		return {
			target,
			version: typeof json?.version === "string" ? json.version : null,
			nodeEngine: typeof json?.engines?.node === "string" ? json.engines.node : null
		};
	} catch (err) {
		return {
			target,
			version: null,
			nodeEngine: null,
			error: String(err)
		};
	}
}
async function fetchNpmTagVersion(params) {
	const res = await fetchNpmPackageTargetStatus({
		target: params.tag,
		timeoutMs: params.timeoutMs
	});
	return {
		tag: params.tag,
		version: res.version,
		error: res.error
	};
}
async function resolveNpmChannelTag(params) {
	const channelTag = channelToNpmTag(params.channel);
	const channelStatus = await fetchNpmTagVersion({
		tag: channelTag,
		timeoutMs: params.timeoutMs
	});
	if (params.channel !== "beta") return {
		tag: channelTag,
		version: channelStatus.version
	};
	const latestStatus = await fetchNpmTagVersion({
		tag: "latest",
		timeoutMs: params.timeoutMs
	});
	if (!latestStatus.version) return {
		tag: channelTag,
		version: channelStatus.version
	};
	if (!channelStatus.version) return {
		tag: "latest",
		version: latestStatus.version
	};
	const cmp = compareSemverStrings(channelStatus.version, latestStatus.version);
	if (cmp != null && cmp < 0) return {
		tag: "latest",
		version: latestStatus.version
	};
	return {
		tag: channelTag,
		version: channelStatus.version
	};
}
function compareSemverStrings(a, b) {
	if (a && b) {
		const openClawReleaseCmp = compareOpenClawReleaseVersions(a, b);
		if (openClawReleaseCmp != null) return openClawReleaseCmp;
	}
	return compareComparableSemver(parseComparableSemver(a, { normalizeLegacyDotBeta: true }), parseComparableSemver(b, { normalizeLegacyDotBeta: true }));
}
async function checkUpdateStatus(params) {
	const timeoutMs = params.timeoutMs ?? 6e3;
	const fetchRegistry = () => params.registryChannel ? fetchNpmRegistryVersionForChannel({
		channel: params.registryChannel,
		timeoutMs
	}) : fetchNpmLatestVersion({ timeoutMs });
	const root = params.root ? path.resolve(params.root) : null;
	if (!root) return {
		root: null,
		installKind: "unknown",
		packageManager: "unknown",
		registry: params.includeRegistry ? await fetchRegistry() : void 0
	};
	const rootRealpath = await fs.realpath(root).catch(() => root);
	const [pm, gitRoot, registry] = await Promise.all([
		detectPackageManager(root),
		detectGitRoot(root),
		params.includeRegistry ? fetchRegistry() : Promise.resolve(void 0)
	]);
	const isGit = gitRoot && path.resolve(gitRoot) === path.resolve(rootRealpath);
	const installKind = isGit ? "git" : "package";
	const [git, deps] = await Promise.all([isGit ? checkGitUpdateStatus({
		root,
		timeoutMs,
		fetch: Boolean(params.fetchGit)
	}) : Promise.resolve(void 0), checkDepsStatus({
		root,
		manager: pm
	})]);
	return {
		root,
		installKind,
		packageManager: pm,
		git,
		deps,
		registry
	};
}
//#endregion
export { formatGitInstallLabel as a, fetchNpmTagVersion as i, compareSemverStrings as n, resolveNpmChannelTag as o, fetchNpmPackageTargetStatus as r, detectPackageManager$1 as s, checkUpdateStatus as t };
