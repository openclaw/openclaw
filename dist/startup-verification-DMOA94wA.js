import { i as writeJsonFileAtomically, n as readJsonFileWithFallback } from "./json-store-ChgPP2Sf.js";
import { t as formatMatrixErrorMessage } from "./errors-Cd21tNWv.js";
import { a as resolveMatrixStoragePaths } from "./storage-BVAqboeh.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region extensions/matrix/src/matrix/monitor/startup-verification.ts
const STARTUP_VERIFICATION_STATE_FILENAME = "startup-verification.json";
const DEFAULT_STARTUP_VERIFICATION_MODE = "if-unverified";
const DEFAULT_STARTUP_VERIFICATION_COOLDOWN_HOURS = 24;
const DEFAULT_STARTUP_VERIFICATION_FAILURE_COOLDOWN_MS = 3600 * 1e3;
function normalizeCooldownHours(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_STARTUP_VERIFICATION_COOLDOWN_HOURS;
	return Math.max(0, value);
}
function resolveStartupVerificationStatePath(params) {
	const storagePaths = resolveMatrixStoragePaths({
		homeserver: params.auth.homeserver,
		userId: params.auth.userId,
		accessToken: params.auth.accessToken,
		accountId: params.auth.accountId,
		deviceId: params.auth.deviceId,
		env: params.env
	});
	return path.join(storagePaths.rootDir, STARTUP_VERIFICATION_STATE_FILENAME);
}
async function readStartupVerificationState(filePath) {
	const { value } = await readJsonFileWithFallback(filePath, null);
	return value && typeof value === "object" ? value : null;
}
async function clearStartupVerificationState(filePath) {
	await fs.rm(filePath, { force: true }).catch(() => {});
}
function resolveStateCooldownMs(state, cooldownMs) {
	if (state?.outcome === "failed") return Math.min(cooldownMs, DEFAULT_STARTUP_VERIFICATION_FAILURE_COOLDOWN_MS);
	return cooldownMs;
}
function resolveRetryAfterMs(params) {
	const attemptedAtMs = Date.parse(params.attemptedAt ?? "");
	if (!Number.isFinite(attemptedAtMs)) return;
	const remaining = attemptedAtMs + params.cooldownMs - params.nowMs;
	return remaining > 0 ? remaining : void 0;
}
function shouldHonorCooldown(params) {
	if (!params.state || params.stateCooldownMs <= 0) return false;
	if (params.state.userId && params.verification.userId && params.state.userId !== params.verification.userId) return false;
	if (params.state.deviceId && params.verification.deviceId && params.state.deviceId !== params.verification.deviceId) return false;
	return resolveRetryAfterMs({
		attemptedAt: params.state.attemptedAt,
		cooldownMs: params.stateCooldownMs,
		nowMs: params.nowMs
	}) !== void 0;
}
function hasPendingSelfVerification(verifications) {
	return verifications.some((entry) => entry.isSelfVerification && !entry.completed && entry.pending);
}
async function ensureMatrixStartupVerification(params) {
	if (params.auth.encryption !== true || !params.client.crypto) return { kind: "unsupported" };
	const verification = await params.client.getOwnDeviceVerificationStatus();
	const statePath = params.stateFilePath ?? resolveStartupVerificationStatePath({
		auth: params.auth,
		env: params.env
	});
	if (verification.verified) {
		await clearStartupVerificationState(statePath);
		return {
			kind: "verified",
			verification
		};
	}
	if ((params.accountConfig.startupVerification ?? DEFAULT_STARTUP_VERIFICATION_MODE) === "off") {
		await clearStartupVerificationState(statePath);
		return {
			kind: "disabled",
			verification
		};
	}
	if (hasPendingSelfVerification(await params.client.crypto.listVerifications().catch(() => []))) return {
		kind: "pending",
		verification
	};
	const cooldownMs = normalizeCooldownHours(params.accountConfig.startupVerificationCooldownHours) * 60 * 60 * 1e3;
	const nowMs = params.nowMs ?? Date.now();
	const state = await readStartupVerificationState(statePath);
	const stateCooldownMs = resolveStateCooldownMs(state, cooldownMs);
	if (shouldHonorCooldown({
		state,
		verification,
		stateCooldownMs,
		nowMs
	})) return {
		kind: "cooldown",
		verification,
		retryAfterMs: resolveRetryAfterMs({
			attemptedAt: state?.attemptedAt,
			cooldownMs: stateCooldownMs,
			nowMs
		})
	};
	try {
		const request = await params.client.crypto.requestVerification({ ownUser: true });
		await writeJsonFileAtomically(statePath, {
			userId: verification.userId,
			deviceId: verification.deviceId,
			attemptedAt: new Date(nowMs).toISOString(),
			outcome: "requested",
			requestId: request.id,
			transactionId: request.transactionId
		});
		return {
			kind: "requested",
			verification,
			requestId: request.id,
			transactionId: request.transactionId ?? void 0
		};
	} catch (err) {
		const error = formatMatrixErrorMessage(err);
		await writeJsonFileAtomically(statePath, {
			userId: verification.userId,
			deviceId: verification.deviceId,
			attemptedAt: new Date(nowMs).toISOString(),
			outcome: "failed",
			error
		}).catch(() => {});
		return {
			kind: "request-failed",
			verification,
			error
		};
	}
}
//#endregion
export { ensureMatrixStartupVerification };
