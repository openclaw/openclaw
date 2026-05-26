import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { t as resolveOpenClawPackageRoot } from "./openclaw-root-CNp1Ofdk.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { m as writeJson } from "./json-files-C2hqjU--.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { s as normalizeUpdateChannel } from "./update-channels-f-ieRme5.js";
import { n as compareSemverStrings, o as resolveNpmChannelTag, t as checkUpdateStatus } from "./update-check-Bp4i15ma.js";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
//#region src/infra/update-startup.ts
let updateAvailableCache = null;
function getUpdateAvailable() {
	return updateAvailableCache;
}
const UPDATE_CHECK_FILENAME = "update-check.json";
const UPDATE_CHECK_INTERVAL_MS = 1440 * 60 * 1e3;
const ONE_HOUR_MS = 3600 * 1e3;
const AUTO_UPDATE_COMMAND_TIMEOUT_MS = 2700 * 1e3;
const AUTO_STABLE_DELAY_HOURS_DEFAULT = 6;
const AUTO_STABLE_JITTER_HOURS_DEFAULT = 12;
const AUTO_BETA_CHECK_INTERVAL_HOURS_DEFAULT = 1;
function shouldSkipCheck(allowInTests) {
	if (allowInTests) return false;
	if (process.env.VITEST || false) return true;
	return false;
}
function resolveAutoUpdatePolicy(cfg) {
	const auto = cfg.update?.auto;
	const stableDelayHours = typeof auto?.stableDelayHours === "number" && Number.isFinite(auto.stableDelayHours) ? Math.max(0, auto.stableDelayHours) : AUTO_STABLE_DELAY_HOURS_DEFAULT;
	const stableJitterHours = typeof auto?.stableJitterHours === "number" && Number.isFinite(auto.stableJitterHours) ? Math.max(0, auto.stableJitterHours) : AUTO_STABLE_JITTER_HOURS_DEFAULT;
	const betaCheckIntervalHours = typeof auto?.betaCheckIntervalHours === "number" && Number.isFinite(auto.betaCheckIntervalHours) ? Math.max(.25, auto.betaCheckIntervalHours) : AUTO_BETA_CHECK_INTERVAL_HOURS_DEFAULT;
	return {
		enabled: Boolean(auto?.enabled),
		stableDelayHours,
		stableJitterHours,
		betaCheckIntervalHours
	};
}
function resolveCheckIntervalMs(cfg) {
	const channel = normalizeUpdateChannel(cfg.update?.channel) ?? "stable";
	const auto = resolveAutoUpdatePolicy(cfg);
	if (!auto.enabled) return UPDATE_CHECK_INTERVAL_MS;
	if (channel === "beta") return Math.max(ONE_HOUR_MS / 4, Math.floor(auto.betaCheckIntervalHours * ONE_HOUR_MS));
	if (channel === "stable") return ONE_HOUR_MS;
	return UPDATE_CHECK_INTERVAL_MS;
}
async function readState(statePath) {
	try {
		const raw = await fs.readFile(statePath, "utf-8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
async function writeState(statePath, state) {
	await writeJson(statePath, state);
}
function sameUpdateAvailable(a, b) {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.currentVersion === b.currentVersion && a.latestVersion === b.latestVersion && a.channel === b.channel;
}
function setUpdateAvailableCache(params) {
	if (sameUpdateAvailable(updateAvailableCache, params.next)) return;
	updateAvailableCache = params.next;
	params.onUpdateAvailableChange?.(params.next);
}
function resolvePersistedUpdateAvailable(state) {
	const latestVersion = state.lastAvailableVersion?.trim();
	if (!latestVersion) return null;
	const cmp = compareSemverStrings(VERSION, latestVersion);
	if (cmp == null || cmp >= 0) return null;
	return {
		currentVersion: VERSION,
		latestVersion,
		channel: state.lastAvailableTag?.trim() || "stable"
	};
}
function resolveStableJitterMs(params) {
	if (params.jitterWindowMs <= 0) return 0;
	return createHash("sha256").update(`${params.installId}:${params.version}:${params.tag}`).digest().readUInt32BE(0) % (Math.floor(params.jitterWindowMs) + 1);
}
function resolveStableAutoApplyAtMs(params) {
	if (!params.nextState.autoInstallId) params.nextState.autoInstallId = params.state.autoInstallId?.trim() || randomUUID();
	const installId = params.nextState.autoInstallId;
	if (!(params.state.autoFirstSeenVersion === params.version && params.state.autoFirstSeenTag === params.tag)) {
		params.nextState.autoFirstSeenVersion = params.version;
		params.nextState.autoFirstSeenTag = params.tag;
		params.nextState.autoFirstSeenAt = new Date(params.nowMs).toISOString();
	} else {
		params.nextState.autoFirstSeenVersion = params.state.autoFirstSeenVersion;
		params.nextState.autoFirstSeenTag = params.state.autoFirstSeenTag;
		params.nextState.autoFirstSeenAt = params.state.autoFirstSeenAt;
	}
	const firstSeenMs = params.nextState.autoFirstSeenAt ? Date.parse(params.nextState.autoFirstSeenAt) : params.nowMs;
	const baseDelayMs = Math.max(0, params.stableDelayHours) * ONE_HOUR_MS;
	const jitterWindowMs = Math.max(0, params.stableJitterHours) * ONE_HOUR_MS;
	const jitterMs = resolveStableJitterMs({
		installId,
		version: params.version,
		tag: params.tag,
		jitterWindowMs
	});
	return firstSeenMs + baseDelayMs + jitterMs;
}
async function runAutoUpdateCommand(params) {
	const baseArgs = [
		"update",
		"--yes",
		"--channel",
		params.channel,
		"--json"
	];
	const execPath = process.execPath?.trim();
	const argv1 = process.argv[1]?.trim();
	const lowerExecBase = execPath ? normalizeLowercaseStringOrEmpty(path.basename(execPath)) : "";
	const runtimeIsNodeOrBun = lowerExecBase === "node" || lowerExecBase === "node.exe" || lowerExecBase === "bun" || lowerExecBase === "bun.exe";
	const argv = [];
	if (execPath && argv1) argv.push(execPath, argv1, ...baseArgs);
	else if (execPath && !runtimeIsNodeOrBun) argv.push(execPath, ...baseArgs);
	else if (execPath && params.root) {
		const candidates = [
			path.join(params.root, "dist", "entry.js"),
			path.join(params.root, "dist", "entry.mjs"),
			path.join(params.root, "dist", "index.js"),
			path.join(params.root, "dist", "index.mjs")
		];
		for (const candidate of candidates) try {
			await fs.access(candidate);
			argv.push(execPath, candidate, ...baseArgs);
			break;
		} catch {}
	}
	if (argv.length === 0) argv.push("openclaw", ...baseArgs);
	try {
		const res = await runCommandWithTimeout(argv, {
			timeoutMs: params.timeoutMs,
			env: { OPENCLAW_AUTO_UPDATE: "1" }
		});
		return {
			ok: res.code === 0,
			code: res.code,
			stdout: res.stdout,
			stderr: res.stderr,
			reason: res.code === 0 ? void 0 : "non-zero-exit"
		};
	} catch (err) {
		return {
			ok: false,
			code: null,
			reason: String(err)
		};
	}
}
function clearAutoState(nextState) {
	delete nextState.autoFirstSeenVersion;
	delete nextState.autoFirstSeenTag;
	delete nextState.autoFirstSeenAt;
}
async function runGatewayUpdateCheck(params) {
	if (shouldSkipCheck(Boolean(params.allowInTests))) return;
	if (params.isNixMode) return;
	const auto = resolveAutoUpdatePolicy(params.cfg);
	const autoDisabledByEnv = isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE);
	const shouldRunAutoUpdate = auto.enabled && !autoDisabledByEnv;
	const shouldRunUpdateHints = params.cfg.update?.checkOnStart !== false;
	if (!shouldRunUpdateHints && !shouldRunAutoUpdate) return;
	const statePath = path.join(resolveStateDir(), UPDATE_CHECK_FILENAME);
	const state = await readState(statePath);
	const now = Date.now();
	const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
	if (shouldRunUpdateHints) setUpdateAvailableCache({
		next: resolvePersistedUpdateAvailable(state),
		onUpdateAvailableChange: params.onUpdateAvailableChange
	});
	else setUpdateAvailableCache({
		next: null,
		onUpdateAvailableChange: params.onUpdateAvailableChange
	});
	const checkIntervalMs = shouldRunAutoUpdate ? resolveCheckIntervalMs(params.cfg) : UPDATE_CHECK_INTERVAL_MS;
	if (lastCheckedAt && Number.isFinite(lastCheckedAt)) {
		if (now - lastCheckedAt < checkIntervalMs) return;
	}
	const root = await resolveOpenClawPackageRoot({
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	});
	const status = await checkUpdateStatus({
		root,
		timeoutMs: 2500,
		fetchGit: false,
		includeRegistry: false
	});
	const nextState = {
		...state,
		lastCheckedAt: new Date(now).toISOString()
	};
	if (status.installKind !== "package") {
		delete nextState.lastAvailableVersion;
		delete nextState.lastAvailableTag;
		clearAutoState(nextState);
		setUpdateAvailableCache({
			next: null,
			onUpdateAvailableChange: params.onUpdateAvailableChange
		});
		await writeState(statePath, nextState);
		return;
	}
	const channel = normalizeUpdateChannel(params.cfg.update?.channel) ?? "stable";
	const resolved = await resolveNpmChannelTag({
		channel,
		timeoutMs: 2500
	});
	const tag = resolved.tag;
	if (!resolved.version) {
		await writeState(statePath, nextState);
		return;
	}
	const cmp = compareSemverStrings(VERSION, resolved.version);
	if (cmp != null && cmp < 0) {
		const nextAvailable = {
			currentVersion: VERSION,
			latestVersion: resolved.version,
			channel: tag
		};
		if (shouldRunUpdateHints) setUpdateAvailableCache({
			next: nextAvailable,
			onUpdateAvailableChange: params.onUpdateAvailableChange
		});
		nextState.lastAvailableVersion = resolved.version;
		nextState.lastAvailableTag = tag;
		const shouldNotify = state.lastNotifiedVersion !== resolved.version || state.lastNotifiedTag !== tag;
		if (shouldRunUpdateHints && shouldNotify) {
			params.log.info(`update available (${tag}): v${resolved.version} (current v${VERSION}). Run: ${formatCliCommand("openclaw update")}`);
			nextState.lastNotifiedVersion = resolved.version;
			nextState.lastNotifiedTag = tag;
		}
		if (auto.enabled && autoDisabledByEnv) params.log.info("auto-update disabled by OPENCLAW_NO_AUTO_UPDATE", {
			version: resolved.version,
			tag
		});
		if (shouldRunAutoUpdate && (channel === "stable" || channel === "beta")) {
			const runAuto = params.runAutoUpdate ?? runAutoUpdateCommand;
			const attemptIntervalMs = channel === "beta" ? Math.max(ONE_HOUR_MS / 4, Math.floor(auto.betaCheckIntervalHours * ONE_HOUR_MS)) : ONE_HOUR_MS;
			const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
			const recentAttemptForSameVersion = state.autoLastAttemptVersion === resolved.version && lastAttemptAt != null && Number.isFinite(lastAttemptAt) && now - lastAttemptAt < attemptIntervalMs;
			let dueNow = channel === "beta";
			let applyAfterMs = null;
			if (channel === "stable") {
				applyAfterMs = resolveStableAutoApplyAtMs({
					state,
					nextState,
					nowMs: now,
					version: resolved.version,
					tag,
					stableDelayHours: auto.stableDelayHours,
					stableJitterHours: auto.stableJitterHours
				});
				dueNow = now >= applyAfterMs;
			}
			if (!dueNow) params.log.info("auto-update deferred (stable rollout window active)", {
				version: resolved.version,
				tag,
				applyAfter: applyAfterMs ? new Date(applyAfterMs).toISOString() : void 0
			});
			else if (recentAttemptForSameVersion) params.log.info("auto-update deferred (recent attempt exists)", {
				version: resolved.version,
				tag
			});
			else {
				nextState.autoLastAttemptVersion = resolved.version;
				nextState.autoLastAttemptAt = new Date(now).toISOString();
				const outcome = await runAuto({
					channel,
					timeoutMs: AUTO_UPDATE_COMMAND_TIMEOUT_MS,
					root: root ?? void 0
				});
				if (outcome.ok) {
					nextState.autoLastSuccessVersion = resolved.version;
					nextState.autoLastSuccessAt = new Date(now).toISOString();
					params.log.info("auto-update applied", {
						channel,
						version: resolved.version,
						tag
					});
				} else params.log.info("auto-update attempt failed", {
					channel,
					version: resolved.version,
					tag,
					reason: outcome.reason ?? `exit:${outcome.code}`
				});
			}
		}
	} else {
		delete nextState.lastAvailableVersion;
		delete nextState.lastAvailableTag;
		clearAutoState(nextState);
		setUpdateAvailableCache({
			next: null,
			onUpdateAvailableChange: params.onUpdateAvailableChange
		});
	}
	await writeState(statePath, nextState);
}
function scheduleGatewayUpdateCheck(params) {
	let stopped = false;
	let timer = null;
	let running = false;
	const tick = async () => {
		if (stopped || running) return;
		running = true;
		try {
			await runGatewayUpdateCheck(params);
		} catch {} finally {
			running = false;
		}
		if (stopped) return;
		const intervalMs = resolveCheckIntervalMs(params.cfg);
		timer = setTimeout(() => {
			tick();
		}, intervalMs);
	};
	tick();
	return () => {
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
}
//#endregion
export { runGatewayUpdateCheck as n, scheduleGatewayUpdateCheck as r, getUpdateAvailable as t };
