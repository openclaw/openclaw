import { h as pathExists } from "./utils-Do8MzKyM.js";
import { Eo as normalizeLegacyDeliveryInput, To as parseAbsoluteTimeMs, _o as resolveDefaultCronStaggerMs, ho as normalizeCronStaggerMs, ms as applyPathPrepend, uo as trimLogTail, vo as inferLegacyName, wo as migrateLegacyCronPayload, xo as normalizeOptionalText } from "./auth-profiles-DqxBs6Au.js";
import { t as runCommandWithTimeout } from "./exec-Fh3CK0qE.js";
import { s as resolveStableNodePath } from "./runtime-paths-cQOj5Aup.js";
import { i as resolveControlUiDistIndexPathForRoot, r as resolveControlUiDistIndexHealth } from "./control-ui-assets-AIHB76qG.js";
import { c as DEV_BRANCH, d as isBetaTag, f as isStableTag, l as channelToNpmTag, n as compareSemverStrings, o as detectPackageManager$1 } from "./update-check-CC-MBAhO.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { Cron } from "croner";
//#region src/cron/schedule.ts
const CRON_EVAL_CACHE_MAX = 512;
const cronEvalCache = /* @__PURE__ */ new Map();
function resolveCronTimezone(tz) {
	const trimmed = typeof tz === "string" ? tz.trim() : "";
	if (trimmed) {return trimmed;}
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function resolveCachedCron(expr, timezone) {
	const key = `${timezone}\u0000${expr}`;
	const cached = cronEvalCache.get(key);
	if (cached) {return cached;}
	if (cronEvalCache.size >= CRON_EVAL_CACHE_MAX) {
		const oldest = cronEvalCache.keys().next().value;
		if (oldest) {cronEvalCache.delete(oldest);}
	}
	const next = new Cron(expr, {
		timezone,
		catch: false
	});
	cronEvalCache.set(key, next);
	return next;
}
function resolveCronFromSchedule(schedule) {
	const exprSource = typeof schedule.expr === "string" ? schedule.expr : schedule.cron;
	if (typeof exprSource !== "string") {throw new Error("invalid cron schedule: expr is required");}
	const expr = exprSource.trim();
	if (!expr) {return;}
	return resolveCachedCron(expr, resolveCronTimezone(schedule.tz));
}
function coerceFiniteScheduleNumber(value) {
	if (typeof value === "number") {return Number.isFinite(value) ? value : void 0;}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) {return;}
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function computeNextRunAtMs(schedule, nowMs) {
	if (schedule.kind === "at") {
		const sched = schedule;
		const atMs = typeof sched.atMs === "number" && Number.isFinite(sched.atMs) && sched.atMs > 0 ? sched.atMs : typeof sched.atMs === "string" ? parseAbsoluteTimeMs(sched.atMs) : typeof sched.at === "string" ? parseAbsoluteTimeMs(sched.at) : null;
		if (atMs === null) {return;}
		return atMs > nowMs ? atMs : void 0;
	}
	if (schedule.kind === "every") {
		const everyMsRaw = coerceFiniteScheduleNumber(schedule.everyMs);
		if (everyMsRaw === void 0) {return;}
		const everyMs = Math.max(1, Math.floor(everyMsRaw));
		const anchorRaw = coerceFiniteScheduleNumber(schedule.anchorMs);
		const anchor = Math.max(0, Math.floor(anchorRaw ?? nowMs));
		if (nowMs < anchor) {return anchor;}
		const elapsed = nowMs - anchor;
		return anchor + Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs)) * everyMs;
	}
	const cron = resolveCronFromSchedule(schedule);
	if (!cron) {return;}
	let next = cron.nextRun(new Date(nowMs));
	if (!next) {return;}
	let nextMs = next.getTime();
	if (!Number.isFinite(nextMs)) {return;}
	if (nextMs <= nowMs) {
		const nextSecondMs = Math.floor(nowMs / 1e3) * 1e3 + 1e3;
		const retry = cron.nextRun(new Date(nextSecondMs));
		if (retry) {
			const retryMs = retry.getTime();
			if (Number.isFinite(retryMs) && retryMs > nowMs) {return retryMs;}
		}
		const tomorrowMs = new Date(nowMs).setUTCHours(24, 0, 0, 0);
		const retry2 = cron.nextRun(new Date(tomorrowMs));
		if (retry2) {
			const retry2Ms = retry2.getTime();
			if (Number.isFinite(retry2Ms) && retry2Ms > nowMs) {return retry2Ms;}
		}
		return;
	}
	return nextMs;
}
function computePreviousRunAtMs(schedule, nowMs) {
	if (schedule.kind !== "cron") {return;}
	const cron = resolveCronFromSchedule(schedule);
	if (!cron) {return;}
	const previous = cron.previousRuns(1, new Date(nowMs))[0];
	if (!previous) {return;}
	const previousMs = previous.getTime();
	if (!Number.isFinite(previousMs)) {return;}
	if (previousMs >= nowMs) {return;}
	return previousMs;
}
//#endregion
//#region src/cron/store-migration.ts
function incrementIssue(issues, key) {
	issues[key] = (issues[key] ?? 0) + 1;
}
function normalizePayloadKind(payload) {
	const raw = typeof payload.kind === "string" ? payload.kind.trim().toLowerCase() : "";
	if (raw === "agentturn") {
		if (payload.kind !== "agentTurn") {
			payload.kind = "agentTurn";
			return true;
		}
		return false;
	}
	if (raw === "systemevent") {
		if (payload.kind !== "systemEvent") {
			payload.kind = "systemEvent";
			return true;
		}
		return false;
	}
	return false;
}
function inferPayloadIfMissing(raw) {
	const message = typeof raw.message === "string" ? raw.message.trim() : "";
	const text = typeof raw.text === "string" ? raw.text.trim() : "";
	const command = typeof raw.command === "string" ? raw.command.trim() : "";
	if (message) {
		raw.payload = {
			kind: "agentTurn",
			message
		};
		return true;
	}
	if (text) {
		raw.payload = {
			kind: "systemEvent",
			text
		};
		return true;
	}
	if (command) {
		raw.payload = {
			kind: "systemEvent",
			text: command
		};
		return true;
	}
	return false;
}
function copyTopLevelAgentTurnFields(raw, payload) {
	let mutated = false;
	const copyTrimmedString = (field) => {
		const existing = payload[field];
		if (typeof existing === "string" && existing.trim()) {return;}
		const value = raw[field];
		if (typeof value === "string" && value.trim()) {
			payload[field] = value.trim();
			mutated = true;
		}
	};
	copyTrimmedString("model");
	copyTrimmedString("thinking");
	if (typeof payload.timeoutSeconds !== "number" && typeof raw.timeoutSeconds === "number" && Number.isFinite(raw.timeoutSeconds)) {
		payload.timeoutSeconds = Math.max(0, Math.floor(raw.timeoutSeconds));
		mutated = true;
	}
	if (typeof payload.allowUnsafeExternalContent !== "boolean" && typeof raw.allowUnsafeExternalContent === "boolean") {
		payload.allowUnsafeExternalContent = raw.allowUnsafeExternalContent;
		mutated = true;
	}
	if (typeof payload.deliver !== "boolean" && typeof raw.deliver === "boolean") {
		payload.deliver = raw.deliver;
		mutated = true;
	}
	if (typeof payload.channel !== "string" && typeof raw.channel === "string" && raw.channel.trim()) {
		payload.channel = raw.channel.trim();
		mutated = true;
	}
	if (typeof payload.to !== "string" && typeof raw.to === "string" && raw.to.trim()) {
		payload.to = raw.to.trim();
		mutated = true;
	}
	if (typeof payload.bestEffortDeliver !== "boolean" && typeof raw.bestEffortDeliver === "boolean") {
		payload.bestEffortDeliver = raw.bestEffortDeliver;
		mutated = true;
	}
	if (typeof payload.provider !== "string" && typeof raw.provider === "string" && raw.provider.trim()) {
		payload.provider = raw.provider.trim();
		mutated = true;
	}
	return mutated;
}
function stripLegacyTopLevelFields(raw) {
	if ("model" in raw) {delete raw.model;}
	if ("thinking" in raw) {delete raw.thinking;}
	if ("timeoutSeconds" in raw) {delete raw.timeoutSeconds;}
	if ("allowUnsafeExternalContent" in raw) {delete raw.allowUnsafeExternalContent;}
	if ("message" in raw) {delete raw.message;}
	if ("text" in raw) {delete raw.text;}
	if ("deliver" in raw) {delete raw.deliver;}
	if ("channel" in raw) {delete raw.channel;}
	if ("to" in raw) {delete raw.to;}
	if ("bestEffortDeliver" in raw) {delete raw.bestEffortDeliver;}
	if ("provider" in raw) {delete raw.provider;}
	if ("command" in raw) {delete raw.command;}
	if ("timeout" in raw) {delete raw.timeout;}
}
function normalizeStoredCronJobs(jobs) {
	const issues = {};
	let mutated = false;
	for (const raw of jobs) {
		const jobIssues = /* @__PURE__ */ new Set();
		const trackIssue = (key) => {
			if (jobIssues.has(key)) {return;}
			jobIssues.add(key);
			incrementIssue(issues, key);
		};
		const state = raw.state;
		if (!state || typeof state !== "object" || Array.isArray(state)) {
			raw.state = {};
			mutated = true;
		}
		const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
		const legacyJobId = typeof raw.jobId === "string" ? raw.jobId.trim() : "";
		if (!rawId && legacyJobId) {
			raw.id = legacyJobId;
			mutated = true;
			trackIssue("jobId");
		} else if (rawId && raw.id !== rawId) {
			raw.id = rawId;
			mutated = true;
		}
		if ("jobId" in raw) {
			delete raw.jobId;
			mutated = true;
			trackIssue("jobId");
		}
		if (typeof raw.schedule === "string") {
			raw.schedule = {
				kind: "cron",
				expr: raw.schedule.trim()
			};
			mutated = true;
			trackIssue("legacyScheduleString");
		}
		const nameRaw = raw.name;
		if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
			raw.name = inferLegacyName({
				schedule: raw.schedule,
				payload: raw.payload
			});
			mutated = true;
		} else {raw.name = nameRaw.trim();}
		const desc = normalizeOptionalText(raw.description);
		if (raw.description !== desc) {
			raw.description = desc;
			mutated = true;
		}
		if ("sessionKey" in raw) {
			const sessionKey = typeof raw.sessionKey === "string" ? normalizeOptionalText(raw.sessionKey) : void 0;
			if (raw.sessionKey !== sessionKey) {
				raw.sessionKey = sessionKey;
				mutated = true;
			}
		}
		if (typeof raw.enabled !== "boolean") {
			raw.enabled = true;
			mutated = true;
		}
		const wakeModeRaw = typeof raw.wakeMode === "string" ? raw.wakeMode.trim().toLowerCase() : "";
		if (wakeModeRaw === "next-heartbeat") {
			if (raw.wakeMode !== "next-heartbeat") {
				raw.wakeMode = "next-heartbeat";
				mutated = true;
			}
		} else if (wakeModeRaw === "now") {
			if (raw.wakeMode !== "now") {
				raw.wakeMode = "now";
				mutated = true;
			}
		} else {
			raw.wakeMode = "now";
			mutated = true;
		}
		const payload = raw.payload;
		if ((!payload || typeof payload !== "object" || Array.isArray(payload)) && inferPayloadIfMissing(raw)) {
			mutated = true;
			trackIssue("legacyTopLevelPayloadFields");
		}
		const payloadRecord = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : null;
		if (payloadRecord) {
			if (normalizePayloadKind(payloadRecord)) {
				mutated = true;
				trackIssue("legacyPayloadKind");
			}
			if (!payloadRecord.kind) {
				if (typeof payloadRecord.message === "string" && payloadRecord.message.trim()) {
					payloadRecord.kind = "agentTurn";
					mutated = true;
					trackIssue("legacyPayloadKind");
				} else if (typeof payloadRecord.text === "string" && payloadRecord.text.trim()) {
					payloadRecord.kind = "systemEvent";
					mutated = true;
					trackIssue("legacyPayloadKind");
				}
			}
			if (payloadRecord.kind === "agentTurn" && copyTopLevelAgentTurnFields(raw, payloadRecord)) {mutated = true;}
		}
		const hadLegacyTopLevelPayloadFields = "model" in raw || "thinking" in raw || "timeoutSeconds" in raw || "allowUnsafeExternalContent" in raw || "message" in raw || "text" in raw || "command" in raw || "timeout" in raw;
		const hadLegacyTopLevelDeliveryFields = "deliver" in raw || "channel" in raw || "to" in raw || "bestEffortDeliver" in raw || "provider" in raw;
		if (hadLegacyTopLevelPayloadFields || hadLegacyTopLevelDeliveryFields) {
			stripLegacyTopLevelFields(raw);
			mutated = true;
			if (hadLegacyTopLevelPayloadFields) {trackIssue("legacyTopLevelPayloadFields");}
			if (hadLegacyTopLevelDeliveryFields) {trackIssue("legacyTopLevelDeliveryFields");}
		}
		if (payloadRecord) {
			const hadLegacyPayloadProvider = typeof payloadRecord.provider === "string" && payloadRecord.provider.trim().length > 0;
			if (migrateLegacyCronPayload(payloadRecord)) {
				mutated = true;
				if (hadLegacyPayloadProvider) {trackIssue("legacyPayloadProvider");}
			}
		}
		const schedule = raw.schedule;
		if (schedule && typeof schedule === "object" && !Array.isArray(schedule)) {
			const sched = schedule;
			const kind = typeof sched.kind === "string" ? sched.kind.trim().toLowerCase() : "";
			if (!kind && ("at" in sched || "atMs" in sched)) {
				sched.kind = "at";
				mutated = true;
			}
			const atRaw = typeof sched.at === "string" ? sched.at.trim() : "";
			const atMsRaw = sched.atMs;
			const parsedAtMs = typeof atMsRaw === "number" ? atMsRaw : typeof atMsRaw === "string" ? parseAbsoluteTimeMs(atMsRaw) : atRaw ? parseAbsoluteTimeMs(atRaw) : null;
			if (parsedAtMs !== null) {
				sched.at = new Date(parsedAtMs).toISOString();
				if ("atMs" in sched) {delete sched.atMs;}
				mutated = true;
			}
			const everyMsRaw = sched.everyMs;
			const everyMsCoerced = coerceFiniteScheduleNumber(everyMsRaw);
			const everyMs = everyMsCoerced !== void 0 ? Math.floor(everyMsCoerced) : null;
			if (everyMs !== null && everyMsRaw !== everyMs) {
				sched.everyMs = everyMs;
				mutated = true;
			}
			if ((kind === "every" || sched.kind === "every") && everyMs !== null) {
				const anchorRaw = sched.anchorMs;
				const anchorCoerced = coerceFiniteScheduleNumber(anchorRaw);
				const normalizedAnchor = anchorCoerced !== void 0 ? Math.max(0, Math.floor(anchorCoerced)) : typeof raw.createdAtMs === "number" && Number.isFinite(raw.createdAtMs) ? Math.max(0, Math.floor(raw.createdAtMs)) : typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs) ? Math.max(0, Math.floor(raw.updatedAtMs)) : null;
				if (normalizedAnchor !== null && anchorRaw !== normalizedAnchor) {
					sched.anchorMs = normalizedAnchor;
					mutated = true;
				}
			}
			const exprRaw = typeof sched.expr === "string" ? sched.expr.trim() : "";
			const legacyCronRaw = typeof sched.cron === "string" ? sched.cron.trim() : "";
			let normalizedExpr = exprRaw;
			if (!normalizedExpr && legacyCronRaw) {
				normalizedExpr = legacyCronRaw;
				sched.expr = normalizedExpr;
				mutated = true;
				trackIssue("legacyScheduleCron");
			}
			if (typeof sched.expr === "string" && sched.expr !== normalizedExpr) {
				sched.expr = normalizedExpr;
				mutated = true;
			}
			if ("cron" in sched) {
				delete sched.cron;
				mutated = true;
				trackIssue("legacyScheduleCron");
			}
			if ((kind === "cron" || sched.kind === "cron") && normalizedExpr) {
				const explicitStaggerMs = normalizeCronStaggerMs(sched.staggerMs);
				const defaultStaggerMs = resolveDefaultCronStaggerMs(normalizedExpr);
				const targetStaggerMs = explicitStaggerMs ?? defaultStaggerMs;
				if (targetStaggerMs === void 0) {
					if ("staggerMs" in sched) {
						delete sched.staggerMs;
						mutated = true;
					}
				} else if (sched.staggerMs !== targetStaggerMs) {
					sched.staggerMs = targetStaggerMs;
					mutated = true;
				}
			}
		}
		const delivery = raw.delivery;
		if (delivery && typeof delivery === "object" && !Array.isArray(delivery)) {
			const modeRaw = delivery.mode;
			if (typeof modeRaw === "string") {
				if (modeRaw.trim().toLowerCase() === "deliver") {
					delivery.mode = "announce";
					mutated = true;
					trackIssue("legacyDeliveryMode");
				}
			} else if (modeRaw === void 0 || modeRaw === null) {
				delivery.mode = "announce";
				mutated = true;
			}
		}
		const isolation = raw.isolation;
		if (isolation && typeof isolation === "object" && !Array.isArray(isolation)) {
			delete raw.isolation;
			mutated = true;
		}
		const payloadKind = payloadRecord && typeof payloadRecord.kind === "string" ? payloadRecord.kind : "";
		const rawSessionTarget = typeof raw.sessionTarget === "string" ? raw.sessionTarget.trim() : "";
		const loweredSessionTarget = rawSessionTarget.toLowerCase();
		if (loweredSessionTarget === "main" || loweredSessionTarget === "isolated") {
			if (raw.sessionTarget !== loweredSessionTarget) {
				raw.sessionTarget = loweredSessionTarget;
				mutated = true;
			}
		} else if (loweredSessionTarget.startsWith("session:")) {
			const customSessionId = rawSessionTarget.slice(8).trim();
			if (customSessionId) {
				const normalizedSessionTarget = `session:${customSessionId}`;
				if (raw.sessionTarget !== normalizedSessionTarget) {
					raw.sessionTarget = normalizedSessionTarget;
					mutated = true;
				}
			}
		} else if (loweredSessionTarget === "current") {
			if (raw.sessionTarget !== "isolated") {
				raw.sessionTarget = "isolated";
				mutated = true;
			}
		} else {
			const inferredSessionTarget = payloadKind === "agentTurn" ? "isolated" : "main";
			if (raw.sessionTarget !== inferredSessionTarget) {
				raw.sessionTarget = inferredSessionTarget;
				mutated = true;
			}
		}
		const sessionTarget = typeof raw.sessionTarget === "string" ? raw.sessionTarget.trim().toLowerCase() : "";
		const isIsolatedAgentTurn = sessionTarget === "isolated" || sessionTarget === "current" || sessionTarget.startsWith("session:") || sessionTarget === "" && payloadKind === "agentTurn";
		const hasDelivery = delivery && typeof delivery === "object" && !Array.isArray(delivery);
		const normalizedLegacy = normalizeLegacyDeliveryInput({
			delivery: hasDelivery ? delivery : null,
			payload: payloadRecord
		});
		if (isIsolatedAgentTurn && payloadKind === "agentTurn") {
			if (!hasDelivery && normalizedLegacy.delivery) {
				raw.delivery = normalizedLegacy.delivery;
				mutated = true;
			} else if (!hasDelivery) {
				raw.delivery = { mode: "announce" };
				mutated = true;
			} else if (normalizedLegacy.mutated && normalizedLegacy.delivery) {
				raw.delivery = normalizedLegacy.delivery;
				mutated = true;
			}
		} else if (normalizedLegacy.mutated && normalizedLegacy.delivery) {
			raw.delivery = normalizedLegacy.delivery;
			mutated = true;
		}
	}
	return {
		issues,
		jobs,
		mutated
	};
}
//#endregion
//#region src/infra/package-json.ts
async function readPackageVersion(root) {
	try {
		const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
		const version = JSON.parse(raw)?.version?.trim();
		return version ? version : null;
	} catch {
		return null;
	}
}
async function readPackageName(root) {
	try {
		const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
		const name = JSON.parse(raw)?.name?.trim();
		return name ? name : null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/infra/package-tag.ts
function normalizePackageTagInput(value, packageNames) {
	const trimmed = value?.trim();
	if (!trimmed) {return null;}
	for (const packageName of packageNames) {
		if (trimmed === packageName) {return null;}
		const prefix = `${packageName}@`;
		if (trimmed.startsWith(prefix)) {
			const tag = trimmed.slice(prefix.length).trim();
			return tag ? tag : null;
		}
	}
	return trimmed;
}
//#endregion
//#region src/infra/update-global.ts
const PRIMARY_PACKAGE_NAME = "openclaw";
const ALL_PACKAGE_NAMES = [PRIMARY_PACKAGE_NAME];
const GLOBAL_RENAME_PREFIX = ".";
const OPENCLAW_MAIN_PACKAGE_SPEC = "github:openclaw/openclaw#main";
const NPM_GLOBAL_INSTALL_QUIET_FLAGS = [
	"--no-fund",
	"--no-audit",
	"--loglevel=error"
];
const NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS = ["--omit=optional", ...NPM_GLOBAL_INSTALL_QUIET_FLAGS];
function normalizePackageTarget(value) {
	return value.trim();
}
function isMainPackageTarget(value) {
	return normalizePackageTarget(value).toLowerCase() === "main";
}
function isExplicitPackageInstallSpec(value) {
	const trimmed = normalizePackageTarget(value);
	if (!trimmed) {return false;}
	return trimmed.includes("://") || trimmed.includes("#") || /^(?:file|github|git\+ssh|git\+https|git\+http|git\+file|npm):/i.test(trimmed);
}
function canResolveRegistryVersionForPackageTarget(value) {
	const trimmed = normalizePackageTarget(value);
	if (!trimmed) {return true;}
	return !isMainPackageTarget(trimmed) && !isExplicitPackageInstallSpec(trimmed);
}
async function resolvePortableGitPathPrepend(env) {
	if (process.platform !== "win32") {return [];}
	const localAppData = env?.LOCALAPPDATA?.trim() || process.env.LOCALAPPDATA?.trim();
	if (!localAppData) {return [];}
	const portableGitRoot = path.join(localAppData, "OpenClaw", "deps", "portable-git");
	const candidates = [
		path.join(portableGitRoot, "mingw64", "bin"),
		path.join(portableGitRoot, "usr", "bin"),
		path.join(portableGitRoot, "cmd"),
		path.join(portableGitRoot, "bin")
	];
	const existing = [];
	for (const candidate of candidates) {if (await pathExists(candidate)) existing.push(candidate);}
	return existing;
}
function applyWindowsPackageInstallEnv(env) {
	if (process.platform !== "win32") {return;}
	env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
	env.NPM_CONFIG_FUND = "false";
	env.NPM_CONFIG_AUDIT = "false";
	env.NPM_CONFIG_SCRIPT_SHELL = "cmd.exe";
	env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1";
}
function resolveGlobalInstallSpec(params) {
	const override = params.env?.OPENCLAW_UPDATE_PACKAGE_SPEC?.trim() || process.env.OPENCLAW_UPDATE_PACKAGE_SPEC?.trim();
	if (override) {return override;}
	const target = normalizePackageTarget(params.tag);
	if (isMainPackageTarget(target)) {return OPENCLAW_MAIN_PACKAGE_SPEC;}
	if (isExplicitPackageInstallSpec(target)) {return target;}
	return `${params.packageName}@${target}`;
}
async function createGlobalInstallEnv(env) {
	const pathPrepend = await resolvePortableGitPathPrepend(env);
	if (pathPrepend.length === 0 && process.platform !== "win32") {return env;}
	const merged = Object.fromEntries(Object.entries(env ?? process.env).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
	applyPathPrepend(merged, pathPrepend);
	applyWindowsPackageInstallEnv(merged);
	return merged;
}
async function tryRealpath(targetPath) {
	try {
		return await fs.realpath(targetPath);
	} catch {
		return path.resolve(targetPath);
	}
}
function resolveBunGlobalRoot() {
	const bunInstall = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
	return path.join(bunInstall, "install", "global", "node_modules");
}
async function resolveGlobalRoot(manager, runCommand, timeoutMs) {
	if (manager === "bun") {return resolveBunGlobalRoot();}
	const res = await runCommand(manager === "pnpm" ? [
		"pnpm",
		"root",
		"-g"
	] : [
		"npm",
		"root",
		"-g"
	], { timeoutMs }).catch(() => null);
	if (!res || res.code !== 0) {return null;}
	return res.stdout.trim() || null;
}
async function resolveGlobalPackageRoot(manager, runCommand, timeoutMs) {
	const root = await resolveGlobalRoot(manager, runCommand, timeoutMs);
	if (!root) {return null;}
	return path.join(root, PRIMARY_PACKAGE_NAME);
}
async function detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs) {
	const pkgReal = await tryRealpath(pkgRoot);
	for (const { manager, argv } of [{
		manager: "npm",
		argv: [
			"npm",
			"root",
			"-g"
		]
	}, {
		manager: "pnpm",
		argv: [
			"pnpm",
			"root",
			"-g"
		]
	}]) {
		const res = await runCommand(argv, { timeoutMs }).catch(() => null);
		if (!res || res.code !== 0) {continue;}
		const globalRoot = res.stdout.trim();
		if (!globalRoot) {continue;}
		const globalReal = await tryRealpath(globalRoot);
		for (const name of ALL_PACKAGE_NAMES) {
			const expectedReal = await tryRealpath(path.join(globalReal, name));
			if (path.resolve(expectedReal) === path.resolve(pkgReal)) {return manager;}
		}
	}
	const bunGlobalReal = await tryRealpath(resolveBunGlobalRoot());
	for (const name of ALL_PACKAGE_NAMES) {
		const bunExpectedReal = await tryRealpath(path.join(bunGlobalReal, name));
		if (path.resolve(bunExpectedReal) === path.resolve(pkgReal)) {return "bun";}
	}
	return null;
}
async function detectGlobalInstallManagerByPresence(runCommand, timeoutMs) {
	for (const manager of ["npm", "pnpm"]) {
		const root = await resolveGlobalRoot(manager, runCommand, timeoutMs);
		if (!root) {continue;}
		for (const name of ALL_PACKAGE_NAMES) {if (await pathExists(path.join(root, name))) return manager;}
	}
	const bunRoot = resolveBunGlobalRoot();
	for (const name of ALL_PACKAGE_NAMES) {if (await pathExists(path.join(bunRoot, name))) return "bun";}
	return null;
}
function globalInstallArgs(manager, spec) {
	if (manager === "pnpm") {return [
		"pnpm",
		"add",
		"-g",
		spec
	];}
	if (manager === "bun") {return [
		"bun",
		"add",
		"-g",
		spec
	];}
	return [
		"npm",
		"i",
		"-g",
		spec,
		...NPM_GLOBAL_INSTALL_QUIET_FLAGS
	];
}
function globalInstallFallbackArgs(manager, spec) {
	if (manager !== "npm") {return null;}
	return [
		"npm",
		"i",
		"-g",
		spec,
		...NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS
	];
}
async function cleanupGlobalRenameDirs(params) {
	const removed = [];
	const root = params.globalRoot.trim();
	const name = params.packageName.trim();
	if (!root || !name) {return { removed };}
	const prefix = `${GLOBAL_RENAME_PREFIX}${name}-`;
	let entries = [];
	try {
		entries = await fs.readdir(root);
	} catch {
		return { removed };
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) {continue;}
		const target = path.join(root, entry);
		try {
			if (!(await fs.lstat(target)).isDirectory()) {continue;}
			await fs.rm(target, {
				recursive: true,
				force: true
			});
			removed.push(entry);
		} catch {}
	}
	return { removed };
}
//#endregion
//#region src/infra/update-runner.ts
const DEFAULT_TIMEOUT_MS = 20 * 6e4;
const MAX_LOG_CHARS = 8e3;
const PREFLIGHT_MAX_COMMITS = 10;
const START_DIRS = [
	"cwd",
	"argv1",
	"process"
];
const DEFAULT_PACKAGE_NAME = "openclaw";
const CORE_PACKAGE_NAMES = new Set([DEFAULT_PACKAGE_NAME]);
function normalizeDir(value) {
	if (!value) {return null;}
	const trimmed = value.trim();
	if (!trimmed) {return null;}
	return path.resolve(trimmed);
}
function resolveNodeModulesBinPackageRoot(argv1) {
	const normalized = path.resolve(argv1);
	const parts = normalized.split(path.sep);
	const binIndex = parts.lastIndexOf(".bin");
	if (binIndex <= 0) {return null;}
	if (parts[binIndex - 1] !== "node_modules") {return null;}
	const binName = path.basename(normalized);
	const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
	return path.join(nodeModulesDir, binName);
}
function buildStartDirs(opts) {
	const dirs = [];
	const cwd = normalizeDir(opts.cwd);
	if (cwd) {dirs.push(cwd);}
	const argv1 = normalizeDir(opts.argv1);
	if (argv1) {
		dirs.push(path.dirname(argv1));
		const packageRoot = resolveNodeModulesBinPackageRoot(argv1);
		if (packageRoot) {dirs.push(packageRoot);}
	}
	const proc = normalizeDir(process.cwd());
	if (proc) {dirs.push(proc);}
	return Array.from(new Set(dirs));
}
async function readBranchName(runCommand, root, timeoutMs) {
	const res = await runCommand([
		"git",
		"-C",
		root,
		"rev-parse",
		"--abbrev-ref",
		"HEAD"
	], { timeoutMs }).catch(() => null);
	if (!res || res.code !== 0) {return null;}
	return res.stdout.trim() || null;
}
async function listGitTags(runCommand, root, timeoutMs, pattern = "v*") {
	const res = await runCommand([
		"git",
		"-C",
		root,
		"tag",
		"--list",
		pattern,
		"--sort=-v:refname"
	], { timeoutMs }).catch(() => null);
	if (!res || res.code !== 0) {return [];}
	return res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}
async function resolveChannelTag(runCommand, root, timeoutMs, channel) {
	const tags = await listGitTags(runCommand, root, timeoutMs);
	if (channel === "beta") {
		const betaTag = tags.find((tag) => isBetaTag(tag)) ?? null;
		const stableTag = tags.find((tag) => isStableTag(tag)) ?? null;
		if (!betaTag) {return stableTag;}
		if (!stableTag) {return betaTag;}
		const cmp = compareSemverStrings(betaTag, stableTag);
		if (cmp != null && cmp < 0) {return stableTag;}
		return betaTag;
	}
	return tags.find((tag) => isStableTag(tag)) ?? null;
}
async function resolveGitRoot(runCommand, candidates, timeoutMs) {
	for (const dir of candidates) {
		const res = await runCommand([
			"git",
			"-C",
			dir,
			"rev-parse",
			"--show-toplevel"
		], { timeoutMs }).catch(() => null);
		if (!res) {continue;}
		if (res.code === 0) {
			const root = res.stdout.trim();
			if (root) {return root;}
		}
	}
	return null;
}
async function findPackageRoot(candidates) {
	for (const dir of candidates) {
		let current = dir;
		for (let i = 0; i < 12; i += 1) {
			const pkgPath = path.join(current, "package.json");
			try {
				const raw = await fs.readFile(pkgPath, "utf-8");
				const name = JSON.parse(raw)?.name?.trim();
				if (name && CORE_PACKAGE_NAMES.has(name)) {return current;}
			} catch {}
			const parent = path.dirname(current);
			if (parent === current) {break;}
			current = parent;
		}
	}
	return null;
}
async function detectPackageManager(root) {
	return await detectPackageManager$1(root) ?? "npm";
}
async function runStep(opts) {
	const { runCommand, name, argv, cwd, timeoutMs, env, progress, stepIndex, totalSteps } = opts;
	const command = argv.join(" ");
	const stepInfo = {
		name,
		command,
		index: stepIndex,
		total: totalSteps
	};
	progress?.onStepStart?.(stepInfo);
	const started = Date.now();
	const result = await runCommand(argv, {
		cwd,
		timeoutMs,
		env
	});
	const durationMs = Date.now() - started;
	const stderrTail = trimLogTail(result.stderr, MAX_LOG_CHARS);
	progress?.onStepComplete?.({
		...stepInfo,
		durationMs,
		exitCode: result.code,
		stderrTail
	});
	return {
		name,
		command,
		cwd,
		durationMs,
		exitCode: result.code,
		stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
		stderrTail: trimLogTail(result.stderr, MAX_LOG_CHARS)
	};
}
function managerScriptArgs(manager, script, args = []) {
	if (manager === "pnpm") {return [
		"pnpm",
		script,
		...args
	];}
	if (manager === "bun") {return [
		"bun",
		"run",
		script,
		...args
	];}
	if (args.length > 0) {return [
		"npm",
		"run",
		script,
		"--",
		...args
	];}
	return [
		"npm",
		"run",
		script
	];
}
function managerInstallArgs(manager) {
	if (manager === "pnpm") {return ["pnpm", "install"];}
	if (manager === "bun") {return ["bun", "install"];}
	return ["npm", "install"];
}
function normalizeTag(tag) {
	return normalizePackageTagInput(tag, ["openclaw", DEFAULT_PACKAGE_NAME]) ?? "latest";
}
async function runGatewayUpdate(opts = {}) {
	const startedAt = Date.now();
	const runCommand = opts.runCommand ?? (async (argv, options) => {
		const res = await runCommandWithTimeout(argv, options);
		return {
			stdout: res.stdout,
			stderr: res.stderr,
			code: res.code
		};
	});
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const progress = opts.progress;
	const steps = [];
	const candidates = buildStartDirs(opts);
	let stepIndex = 0;
	let gitTotalSteps = 0;
	const step = (name, argv, cwd, env) => {
		const currentIndex = stepIndex;
		stepIndex += 1;
		return {
			runCommand,
			name,
			argv,
			cwd,
			timeoutMs,
			env,
			progress,
			stepIndex: currentIndex,
			totalSteps: gitTotalSteps
		};
	};
	const pkgRoot = await findPackageRoot(candidates);
	let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs);
	if (gitRoot && pkgRoot && path.resolve(gitRoot) !== path.resolve(pkgRoot)) {gitRoot = null;}
	if (gitRoot && !pkgRoot) {return {
		status: "error",
		mode: "unknown",
		root: gitRoot,
		reason: "not-openclaw-root",
		steps: [],
		durationMs: Date.now() - startedAt
	};}
	if (gitRoot && pkgRoot && path.resolve(gitRoot) === path.resolve(pkgRoot)) {
		const beforeSha = (await runCommand([
			"git",
			"-C",
			gitRoot,
			"rev-parse",
			"HEAD"
		], {
			cwd: gitRoot,
			timeoutMs
		})).stdout.trim() || null;
		const beforeVersion = await readPackageVersion(gitRoot);
		const channel = opts.channel ?? "dev";
		const branch = channel === "dev" ? await readBranchName(runCommand, gitRoot, timeoutMs) : null;
		const needsCheckoutMain = channel === "dev" && branch !== "main";
		gitTotalSteps = channel === "dev" ? needsCheckoutMain ? 11 : 10 : 9;
		const buildGitErrorResult = (reason) => ({
			status: "error",
			mode: "git",
			root: gitRoot,
			reason,
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		});
		const runGitCheckoutOrFail = async (name, argv) => {
			const checkoutStep = await runStep(step(name, argv, gitRoot));
			steps.push(checkoutStep);
			if (checkoutStep.exitCode !== 0) {return buildGitErrorResult("checkout-failed");}
			return null;
		};
		const statusCheck = await runStep(step("clean check", [
			"git",
			"-C",
			gitRoot,
			"status",
			"--porcelain",
			"--",
			":!dist/control-ui/"
		], gitRoot));
		steps.push(statusCheck);
		if (statusCheck.stdoutTail && statusCheck.stdoutTail.trim().length > 0) {return {
			status: "skipped",
			mode: "git",
			root: gitRoot,
			reason: "dirty",
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		};}
		if (channel === "dev") {
			if (needsCheckoutMain) {
				const failure = await runGitCheckoutOrFail(`git checkout ${DEV_BRANCH}`, [
					"git",
					"-C",
					gitRoot,
					"checkout",
					DEV_BRANCH
				]);
				if (failure) {return failure;}
			}
			const upstreamStep = await runStep(step("upstream check", [
				"git",
				"-C",
				gitRoot,
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{upstream}"
			], gitRoot));
			steps.push(upstreamStep);
			if (upstreamStep.exitCode !== 0) {return {
				status: "skipped",
				mode: "git",
				root: gitRoot,
				reason: "no-upstream",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};}
			const fetchStep = await runStep(step("git fetch", [
				"git",
				"-C",
				gitRoot,
				"fetch",
				"--all",
				"--prune",
				"--tags"
			], gitRoot));
			steps.push(fetchStep);
			const upstreamShaStep = await runStep(step("git rev-parse @{upstream}", [
				"git",
				"-C",
				gitRoot,
				"rev-parse",
				"@{upstream}"
			], gitRoot));
			steps.push(upstreamShaStep);
			const upstreamSha = upstreamShaStep.stdoutTail?.trim();
			if (!upstreamShaStep.stdoutTail || !upstreamSha) {return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "no-upstream-sha",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};}
			const revListStep = await runStep(step("git rev-list", [
				"git",
				"-C",
				gitRoot,
				"rev-list",
				`--max-count=${PREFLIGHT_MAX_COMMITS}`,
				upstreamSha
			], gitRoot));
			steps.push(revListStep);
			if (revListStep.exitCode !== 0) {return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "preflight-revlist-failed",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};}
			const candidates = (revListStep.stdoutTail ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
			if (candidates.length === 0) {return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "preflight-no-candidates",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};}
			const manager = await detectPackageManager(gitRoot);
			const preflightRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-preflight-"));
			const worktreeDir = path.join(preflightRoot, "worktree");
			const worktreeStep = await runStep(step("preflight worktree", [
				"git",
				"-C",
				gitRoot,
				"worktree",
				"add",
				"--detach",
				worktreeDir,
				upstreamSha
			], gitRoot));
			steps.push(worktreeStep);
			if (worktreeStep.exitCode !== 0) {
				await fs.rm(preflightRoot, {
					recursive: true,
					force: true
				}).catch(() => {});
				return {
					status: "error",
					mode: "git",
					root: gitRoot,
					reason: "preflight-worktree-failed",
					before: {
						sha: beforeSha,
						version: beforeVersion
					},
					steps,
					durationMs: Date.now() - startedAt
				};
			}
			let selectedSha = null;
			try {
				for (const sha of candidates) {
					const shortSha = sha.slice(0, 8);
					const checkoutStep = await runStep(step(`preflight checkout (${shortSha})`, [
						"git",
						"-C",
						worktreeDir,
						"checkout",
						"--detach",
						sha
					], worktreeDir));
					steps.push(checkoutStep);
					if (checkoutStep.exitCode !== 0) {continue;}
					const depsStep = await runStep(step(`preflight deps install (${shortSha})`, managerInstallArgs(manager), worktreeDir));
					steps.push(depsStep);
					if (depsStep.exitCode !== 0) {continue;}
					const buildStep = await runStep(step(`preflight build (${shortSha})`, managerScriptArgs(manager, "build"), worktreeDir));
					steps.push(buildStep);
					if (buildStep.exitCode !== 0) {continue;}
					const lintStep = await runStep(step(`preflight lint (${shortSha})`, managerScriptArgs(manager, "lint"), worktreeDir));
					steps.push(lintStep);
					if (lintStep.exitCode !== 0) {continue;}
					selectedSha = sha;
					break;
				}
			} finally {
				const removeStep = await runStep(step("preflight cleanup", [
					"git",
					"-C",
					gitRoot,
					"worktree",
					"remove",
					"--force",
					worktreeDir
				], gitRoot));
				steps.push(removeStep);
				await runCommand([
					"git",
					"-C",
					gitRoot,
					"worktree",
					"prune"
				], {
					cwd: gitRoot,
					timeoutMs
				}).catch(() => null);
				await fs.rm(preflightRoot, {
					recursive: true,
					force: true
				}).catch(() => {});
			}
			if (!selectedSha) {return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "preflight-no-good-commit",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};}
			const rebaseStep = await runStep(step("git rebase", [
				"git",
				"-C",
				gitRoot,
				"rebase",
				selectedSha
			], gitRoot));
			steps.push(rebaseStep);
			if (rebaseStep.exitCode !== 0) {
				const abortResult = await runCommand([
					"git",
					"-C",
					gitRoot,
					"rebase",
					"--abort"
				], {
					cwd: gitRoot,
					timeoutMs
				});
				steps.push({
					name: "git rebase --abort",
					command: "git rebase --abort",
					cwd: gitRoot,
					durationMs: 0,
					exitCode: abortResult.code,
					stdoutTail: trimLogTail(abortResult.stdout, MAX_LOG_CHARS),
					stderrTail: trimLogTail(abortResult.stderr, MAX_LOG_CHARS)
				});
				return {
					status: "error",
					mode: "git",
					root: gitRoot,
					reason: "rebase-failed",
					before: {
						sha: beforeSha,
						version: beforeVersion
					},
					steps,
					durationMs: Date.now() - startedAt
				};
			}
		} else {
			const fetchStep = await runStep(step("git fetch", [
				"git",
				"-C",
				gitRoot,
				"fetch",
				"--all",
				"--prune",
				"--tags"
			], gitRoot));
			steps.push(fetchStep);
			if (fetchStep.exitCode !== 0) {return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "fetch-failed",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};}
			const tag = await resolveChannelTag(runCommand, gitRoot, timeoutMs, channel);
			if (!tag) {return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "no-release-tag",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};}
			const failure = await runGitCheckoutOrFail(`git checkout ${tag}`, [
				"git",
				"-C",
				gitRoot,
				"checkout",
				"--detach",
				tag
			]);
			if (failure) {return failure;}
		}
		const manager = await detectPackageManager(gitRoot);
		const depsStep = await runStep(step("deps install", managerInstallArgs(manager), gitRoot));
		steps.push(depsStep);
		if (depsStep.exitCode !== 0) {return {
			status: "error",
			mode: "git",
			root: gitRoot,
			reason: "deps-install-failed",
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		};}
		const buildStep = await runStep(step("build", managerScriptArgs(manager, "build"), gitRoot));
		steps.push(buildStep);
		if (buildStep.exitCode !== 0) {return {
			status: "error",
			mode: "git",
			root: gitRoot,
			reason: "build-failed",
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		};}
		const uiBuildStep = await runStep(step("ui:build", managerScriptArgs(manager, "ui:build"), gitRoot));
		steps.push(uiBuildStep);
		if (uiBuildStep.exitCode !== 0) {return {
			status: "error",
			mode: "git",
			root: gitRoot,
			reason: "ui-build-failed",
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		};}
		const doctorEntry = path.join(gitRoot, "openclaw.mjs");
		if (!await fs.stat(doctorEntry).then(() => true).catch(() => false)) {
			steps.push({
				name: "openclaw doctor entry",
				command: `verify ${doctorEntry}`,
				cwd: gitRoot,
				durationMs: 0,
				exitCode: 1,
				stderrTail: `missing ${doctorEntry}`
			});
			return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: "doctor-entry-missing",
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};
		}
		const doctorStep = await runStep(step("openclaw doctor", [
			await resolveStableNodePath(process.execPath),
			doctorEntry,
			"doctor",
			"--non-interactive",
			"--fix"
		], gitRoot, { OPENCLAW_UPDATE_IN_PROGRESS: "1" }));
		steps.push(doctorStep);
		if (!(await resolveControlUiDistIndexHealth({ root: gitRoot })).exists) {
			const repairArgv = managerScriptArgs(manager, "ui:build");
			const started = Date.now();
			const repairResult = await runCommand(repairArgv, {
				cwd: gitRoot,
				timeoutMs
			});
			const repairStep = {
				name: "ui:build (post-doctor repair)",
				command: repairArgv.join(" "),
				cwd: gitRoot,
				durationMs: Date.now() - started,
				exitCode: repairResult.code,
				stdoutTail: trimLogTail(repairResult.stdout, MAX_LOG_CHARS),
				stderrTail: trimLogTail(repairResult.stderr, MAX_LOG_CHARS)
			};
			steps.push(repairStep);
			if (repairResult.code !== 0) {return {
				status: "error",
				mode: "git",
				root: gitRoot,
				reason: repairStep.name,
				before: {
					sha: beforeSha,
					version: beforeVersion
				},
				steps,
				durationMs: Date.now() - startedAt
			};}
			const repairedUiIndexHealth = await resolveControlUiDistIndexHealth({ root: gitRoot });
			if (!repairedUiIndexHealth.exists) {
				const uiIndexPath = repairedUiIndexHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(gitRoot);
				steps.push({
					name: "ui assets verify",
					command: `verify ${uiIndexPath}`,
					cwd: gitRoot,
					durationMs: 0,
					exitCode: 1,
					stderrTail: `missing ${uiIndexPath}`
				});
				return {
					status: "error",
					mode: "git",
					root: gitRoot,
					reason: "ui-assets-missing",
					before: {
						sha: beforeSha,
						version: beforeVersion
					},
					steps,
					durationMs: Date.now() - startedAt
				};
			}
		}
		const failedStep = steps.find((s) => s.exitCode !== 0);
		const afterShaStep = await runStep(step("git rev-parse HEAD (after)", [
			"git",
			"-C",
			gitRoot,
			"rev-parse",
			"HEAD"
		], gitRoot));
		steps.push(afterShaStep);
		const afterVersion = await readPackageVersion(gitRoot);
		return {
			status: failedStep ? "error" : "ok",
			mode: "git",
			root: gitRoot,
			reason: failedStep ? failedStep.name : void 0,
			before: {
				sha: beforeSha,
				version: beforeVersion
			},
			after: {
				sha: afterShaStep.stdoutTail?.trim() ?? null,
				version: afterVersion
			},
			steps,
			durationMs: Date.now() - startedAt
		};
	}
	if (!pkgRoot) {return {
		status: "error",
		mode: "unknown",
		reason: `no root (${START_DIRS.join(",")})`,
		steps: [],
		durationMs: Date.now() - startedAt
	};}
	const beforeVersion = await readPackageVersion(pkgRoot);
	const globalManager = await detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs);
	if (globalManager) {
		const packageName = await readPackageName(pkgRoot) ?? DEFAULT_PACKAGE_NAME;
		await cleanupGlobalRenameDirs({
			globalRoot: path.dirname(pkgRoot),
			packageName
		});
		const channel = opts.channel ?? "stable";
		const tag = normalizeTag(opts.tag ?? channelToNpmTag(channel));
		const steps = [];
		const globalInstallEnv = await createGlobalInstallEnv();
		const spec = resolveGlobalInstallSpec({
			packageName,
			tag,
			env: globalInstallEnv
		});
		const updateStep = await runStep({
			runCommand,
			name: "global update",
			argv: globalInstallArgs(globalManager, spec),
			cwd: pkgRoot,
			timeoutMs,
			env: globalInstallEnv,
			progress,
			stepIndex: 0,
			totalSteps: 1
		});
		steps.push(updateStep);
		let finalStep = updateStep;
		if (updateStep.exitCode !== 0) {
			const fallbackArgv = globalInstallFallbackArgs(globalManager, spec);
			if (fallbackArgv) {
				const fallbackStep = await runStep({
					runCommand,
					name: "global update (omit optional)",
					argv: fallbackArgv,
					cwd: pkgRoot,
					timeoutMs,
					env: globalInstallEnv,
					progress,
					stepIndex: 0,
					totalSteps: 1
				});
				steps.push(fallbackStep);
				finalStep = fallbackStep;
			}
		}
		const afterVersion = await readPackageVersion(pkgRoot);
		return {
			status: finalStep.exitCode === 0 ? "ok" : "error",
			mode: globalManager,
			root: pkgRoot,
			reason: finalStep.exitCode === 0 ? void 0 : finalStep.name,
			before: { version: beforeVersion },
			after: { version: afterVersion },
			steps,
			durationMs: Date.now() - startedAt
		};
	}
	return {
		status: "skipped",
		mode: "unknown",
		root: pkgRoot,
		reason: "not-git-install",
		before: { version: beforeVersion },
		steps: [],
		durationMs: Date.now() - startedAt
	};
}
//#endregion
export { detectGlobalInstallManagerByPresence as a, resolveGlobalInstallSpec as c, readPackageName as d, readPackageVersion as f, computePreviousRunAtMs as g, computeNextRunAtMs as h, createGlobalInstallEnv as i, resolveGlobalPackageRoot as l, coerceFiniteScheduleNumber as m, canResolveRegistryVersionForPackageTarget as n, detectGlobalInstallManagerForRoot as o, normalizeStoredCronJobs as p, cleanupGlobalRenameDirs as r, globalInstallArgs as s, runGatewayUpdate as t, normalizePackageTagInput as u };
