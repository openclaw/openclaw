import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import { r as withStartedActionClient, t as withResolvedActionClient } from "./client-CWBVxcE6.js";
import { n as formatMatrixEncryptionUnavailableError } from "./encryption-guidance-DjXqRHQg.js";
import { setTimeout } from "node:timers/promises";
//#region extensions/matrix/src/matrix/actions/verification.ts
const DEFAULT_MATRIX_SELF_VERIFICATION_TIMEOUT_MS = 18e4;
function requireCrypto(client, opts) {
	if (!client.crypto) {
		if (!opts.cfg) throw new Error("Matrix verification actions requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
		const cfg = requireRuntimeConfig(opts.cfg, "Matrix verification actions");
		throw new Error(formatMatrixEncryptionUnavailableError(cfg, opts.accountId));
	}
	return client.crypto;
}
function resolveVerificationId(input) {
	const normalized = input.trim();
	if (!normalized) throw new Error("Matrix verification request id is required");
	return normalized;
}
async function ensureMatrixVerificationDmTracked(crypto, opts) {
	const roomId = normalizeOptionalString(opts.verificationDmRoomId);
	const userId = normalizeOptionalString(opts.verificationDmUserId);
	if (Boolean(roomId) !== Boolean(userId)) throw new Error("--user-id and --room-id must be provided together for Matrix DM verification");
	if (!roomId || !userId) return;
	if (!await crypto.ensureVerificationDmTracked({
		roomId,
		userId
	})) throw new Error(`Matrix DM verification request not found for room ${roomId} and user ${userId}`);
}
function isSameMatrixVerification(left, right) {
	return left.id === right.id || Boolean(left.transactionId && left.transactionId === right.transactionId);
}
function isMatrixVerificationReadyForSas(summary) {
	return summary.completed || summary.hasSas || summary.phaseName === "ready" || summary.phaseName === "started";
}
function shouldStartMatrixSasVerification(summary) {
	return !summary.hasSas && summary.phaseName !== "started" && !summary.completed;
}
function isMatrixVerificationCancelled(summary) {
	return summary.phaseName === "cancelled";
}
function isMatrixSasMethod(method) {
	return method === "m.sas.v1" || method === "sas";
}
function getMatrixVerificationSasWaitFailure(summary, label) {
	if (summary.hasSas || summary.phaseName === "cancelled") return null;
	const method = summary.chosenMethod ? ` (method: ${summary.chosenMethod})` : "";
	if (summary.completed) return `Matrix self-verification completed without SAS while waiting to ${label}${method}`;
	if (summary.phaseName === "started" && summary.chosenMethod && !isMatrixSasMethod(summary.chosenMethod)) return `Matrix self-verification started without SAS while waiting to ${label}${method}`;
	return null;
}
async function waitForMatrixVerificationSummary(params) {
	const startedAt = Date.now();
	let last;
	while (Date.now() - startedAt < params.timeoutMs) {
		const found = (await params.crypto.listVerifications()).find((summary) => isSameMatrixVerification(summary, params.request));
		if (found) {
			last = found;
			if (params.predicate(found)) return found;
			if (isMatrixVerificationCancelled(found)) throw new Error(`Matrix self-verification was cancelled${found.error ? `: ${found.error}` : ` while waiting to ${params.label}`}`);
			const rejection = params.reject?.(found);
			if (rejection) throw new Error(rejection);
		}
		await setTimeout(Math.min(250, Math.max(25, params.timeoutMs - (Date.now() - startedAt))));
	}
	throw new Error(`Timed out waiting for Matrix self-verification to ${params.label}${last ? ` (last phase: ${last.phaseName})` : ""}`);
}
function formatMatrixOwnerVerificationDiagnostics(status) {
	if (!status) return "Matrix identity trust status was unavailable";
	return `cross-signing verified: ${status.crossSigningVerified ? "yes" : "no"}, signed by owner: ${status.signedByOwner ? "yes" : "no"}, locally trusted: ${status.localVerified ? "yes" : "no"}`;
}
async function waitForMatrixSelfVerificationTrustStatus(params) {
	const startedAt = Date.now();
	let last;
	let crossSigningPublished = false;
	while (Date.now() - startedAt < params.timeoutMs) {
		const [status, crossSigning] = await Promise.all([params.client.getOwnDeviceVerificationStatus(), params.client.getOwnCrossSigningPublicationStatus()]);
		last = status;
		crossSigningPublished = crossSigning.published;
		if (status.verified && crossSigningPublished) return status;
		await setTimeout(Math.min(250, Math.max(25, params.timeoutMs - (Date.now() - startedAt))));
	}
	throw new Error(`Timed out waiting for Matrix self-verification to establish full Matrix identity trust for this device (${formatMatrixOwnerVerificationDiagnostics(last)}, cross-signing keys published: ${crossSigningPublished ? "yes" : "no"}). Complete self-verification from another Matrix client, then check Matrix verification status for details.`);
}
async function cancelMatrixSelfVerificationOnFailure(params) {
	if (!params.request || typeof params.crypto.cancelVerification !== "function") return;
	await params.crypto.cancelVerification(params.request.id, {
		reason: "OpenClaw self-verification did not complete",
		code: "m.user"
	}).catch(() => void 0);
}
async function completeMatrixSelfVerification(params) {
	const initial = await Promise.all([params.client.getOwnDeviceVerificationStatus(), params.client.getOwnCrossSigningPublicationStatus()]);
	let ownerVerification = initial[0];
	if (!ownerVerification.verified || !initial[1].published) {
		if (!ownerVerification.verified) await params.client.trustOwnIdentityAfterSelfVerification?.();
		ownerVerification = await waitForMatrixSelfVerificationTrustStatus({
			client: params.client,
			timeoutMs: params.timeoutMs
		});
	}
	return {
		...params.completed,
		deviceOwnerVerified: ownerVerification.verified,
		ownerVerification
	};
}
async function listMatrixVerifications(opts = {}) {
	return await withStartedActionClient(opts, async (client) => {
		return await requireCrypto(client, opts).listVerifications();
	});
}
async function requestMatrixVerification(params = {}) {
	return await withStartedActionClient(params, async (client) => {
		const crypto = requireCrypto(client, params);
		const ownUser = params.ownUser ?? (!params.userId && !params.deviceId && !params.roomId);
		return await crypto.requestVerification({
			ownUser,
			userId: normalizeOptionalString(params.userId),
			deviceId: normalizeOptionalString(params.deviceId),
			roomId: normalizeOptionalString(params.roomId)
		});
	});
}
async function runMatrixSelfVerification(params) {
	return await withStartedActionClient(params, async (client) => {
		const crypto = requireCrypto(client, params);
		const timeoutMs = params.timeoutMs ?? DEFAULT_MATRIX_SELF_VERIFICATION_TIMEOUT_MS;
		let requested;
		let requestCompleted = false;
		let handledByMismatch = false;
		try {
			requested = await crypto.requestVerification({ ownUser: true });
			await params.onRequested?.(requested);
			const ready = isMatrixVerificationReadyForSas(requested) ? requested : await waitForMatrixVerificationSummary({
				crypto,
				label: "be accepted in another Matrix client",
				request: requested,
				timeoutMs,
				predicate: isMatrixVerificationReadyForSas
			});
			await params.onReady?.(ready);
			if (ready.completed) {
				requestCompleted = true;
				return await completeMatrixSelfVerification({
					client,
					completed: ready,
					timeoutMs
				});
			}
			const started = shouldStartMatrixSasVerification(ready) ? await crypto.startVerification(ready.id, "sas") : ready;
			let sasSummary = started;
			if (!sasSummary.hasSas) {
				const sasFailure = getMatrixVerificationSasWaitFailure(sasSummary, "show SAS emoji or decimals");
				if (sasFailure) throw new Error(sasFailure);
				sasSummary = await waitForMatrixVerificationSummary({
					crypto,
					label: "show SAS emoji or decimals",
					request: started,
					timeoutMs,
					predicate: (summary) => summary.hasSas,
					reject: (summary) => getMatrixVerificationSasWaitFailure(summary, "show SAS emoji or decimals")
				});
			}
			if (!sasSummary.sas) throw new Error("Matrix SAS data is not available for this verification request");
			await params.onSas?.(sasSummary);
			if (!await params.confirmSas(sasSummary.sas, sasSummary)) {
				await crypto.mismatchVerificationSas(sasSummary.id);
				handledByMismatch = true;
				throw new Error("Matrix SAS verification was not confirmed.");
			}
			const confirmed = await crypto.confirmVerificationSas(sasSummary.id);
			const completed = confirmed.completed ? confirmed : await waitForMatrixVerificationSummary({
				crypto,
				label: "complete",
				request: confirmed,
				timeoutMs,
				predicate: (summary) => summary.completed
			});
			requestCompleted = true;
			return await completeMatrixSelfVerification({
				client,
				completed,
				timeoutMs
			});
		} catch (error) {
			if (!requestCompleted && !handledByMismatch) await cancelMatrixSelfVerificationOnFailure({
				crypto,
				request: requested
			});
			throw error;
		}
	});
}
async function acceptMatrixVerification(requestId, opts = {}) {
	return await withStartedActionClient(opts, async (client) => {
		const crypto = requireCrypto(client, opts);
		await ensureMatrixVerificationDmTracked(crypto, opts);
		return await crypto.acceptVerification(resolveVerificationId(requestId));
	});
}
async function cancelMatrixVerification(requestId, opts = {}) {
	return await withStartedActionClient(opts, async (client) => {
		const crypto = requireCrypto(client, opts);
		await ensureMatrixVerificationDmTracked(crypto, opts);
		return await crypto.cancelVerification(resolveVerificationId(requestId), {
			reason: normalizeOptionalString(opts.reason),
			code: normalizeOptionalString(opts.code)
		});
	});
}
async function startMatrixVerification(requestId, opts = {}) {
	return await withStartedActionClient(opts, async (client) => {
		const crypto = requireCrypto(client, opts);
		await ensureMatrixVerificationDmTracked(crypto, opts);
		return await crypto.startVerification(resolveVerificationId(requestId), opts.method ?? "sas");
	});
}
async function generateMatrixVerificationQr(requestId, opts = {}) {
	return await withStartedActionClient(opts, async (client) => {
		const crypto = requireCrypto(client, opts);
		await ensureMatrixVerificationDmTracked(crypto, opts);
		return await crypto.generateVerificationQr(resolveVerificationId(requestId));
	});
}
async function scanMatrixVerificationQr(requestId, qrDataBase64, opts = {}) {
	return await withStartedActionClient(opts, async (client) => {
		const crypto = requireCrypto(client, opts);
		await ensureMatrixVerificationDmTracked(crypto, opts);
		const payload = qrDataBase64.trim();
		if (!payload) throw new Error("Matrix QR data is required");
		return await crypto.scanVerificationQr(resolveVerificationId(requestId), payload);
	});
}
async function getMatrixVerificationSas(requestId, opts = {}) {
	return await withStartedActionClient(opts, async (client) => {
		const crypto = requireCrypto(client, opts);
		await ensureMatrixVerificationDmTracked(crypto, opts);
		return await crypto.getVerificationSas(resolveVerificationId(requestId));
	});
}
async function confirmMatrixVerificationSas(requestId, opts = {}) {
	return await withStartedActionClient(opts, async (client) => {
		const crypto = requireCrypto(client, opts);
		await ensureMatrixVerificationDmTracked(crypto, opts);
		const summary = await crypto.confirmVerificationSas(resolveVerificationId(requestId));
		if (summary.isSelfVerification && summary.completed && !summary.error) await client.trustOwnIdentityAfterSelfVerification?.();
		return summary;
	});
}
async function mismatchMatrixVerificationSas(requestId, opts = {}) {
	return await withStartedActionClient(opts, async (client) => {
		const crypto = requireCrypto(client, opts);
		await ensureMatrixVerificationDmTracked(crypto, opts);
		return await crypto.mismatchVerificationSas(resolveVerificationId(requestId));
	});
}
async function confirmMatrixVerificationReciprocateQr(requestId, opts = {}) {
	return await withStartedActionClient(opts, async (client) => {
		const crypto = requireCrypto(client, opts);
		await ensureMatrixVerificationDmTracked(crypto, opts);
		return await crypto.confirmVerificationReciprocateQr(resolveVerificationId(requestId));
	});
}
async function getMatrixEncryptionStatus(opts = {}) {
	return await withResolvedActionClient(opts, async (client) => {
		const crypto = requireCrypto(client, opts);
		const recoveryKey = await crypto.getRecoveryKey();
		return {
			encryptionEnabled: true,
			recoveryKeyStored: Boolean(recoveryKey),
			recoveryKeyCreatedAt: recoveryKey?.createdAt ?? null,
			...opts.includeRecoveryKey ? { recoveryKey: recoveryKey?.encodedPrivateKey ?? null } : {},
			pendingVerifications: (await crypto.listVerifications()).length
		};
	});
}
async function getMatrixVerificationStatus(opts = {}) {
	const readiness = opts.readiness ?? "prepared";
	return await withResolvedActionClient({
		...opts,
		readiness: "none"
	}, async (client) => {
		const preflight = await readMatrixVerificationStatus(client, opts);
		if (readiness === "none" || preflight.serverDeviceKnown === false) return preflight;
		if (readiness === "started") await client.start();
		else await client.prepareForOneOff();
		return await readMatrixVerificationStatus(client, opts);
	}, "discard");
}
async function readMatrixVerificationStatus(client, opts) {
	const payload = {
		...await client.getOwnDeviceVerificationStatus(),
		pendingVerifications: client.crypto ? (await client.crypto.listVerifications()).length : 0
	};
	if (!opts.includeRecoveryKey) return payload;
	const recoveryKey = client.crypto ? await client.crypto.getRecoveryKey() : null;
	return {
		...payload,
		recoveryKey: recoveryKey?.encodedPrivateKey ?? null
	};
}
async function getMatrixRoomKeyBackupStatus(opts = {}) {
	return await withResolvedActionClient(opts, async (client) => await client.getRoomKeyBackupStatus());
}
async function verifyMatrixRecoveryKey(recoveryKey, opts = {}) {
	return await withStartedActionClient(opts, async (client) => await client.verifyWithRecoveryKey(recoveryKey));
}
async function restoreMatrixRoomKeyBackup(opts = {}) {
	return await withResolvedActionClient(opts, async (client) => await client.restoreRoomKeyBackup({ recoveryKey: normalizeOptionalString(opts.recoveryKey) }));
}
async function resetMatrixRoomKeyBackup(opts = {}) {
	return await withStartedActionClient(opts, async (client) => await client.resetRoomKeyBackup({ rotateRecoveryKey: opts.rotateRecoveryKey }));
}
async function bootstrapMatrixVerification(opts = {}) {
	return await withStartedActionClient(opts, async (client) => await client.bootstrapOwnDeviceVerification({
		recoveryKey: normalizeOptionalString(opts.recoveryKey),
		forceResetCrossSigning: opts.forceResetCrossSigning === true
	}));
}
//#endregion
export { scanMatrixVerificationQr as _, confirmMatrixVerificationSas as a, getMatrixRoomKeyBackupStatus as c, listMatrixVerifications as d, mismatchMatrixVerificationSas as f, runMatrixSelfVerification as g, restoreMatrixRoomKeyBackup as h, confirmMatrixVerificationReciprocateQr as i, getMatrixVerificationSas as l, resetMatrixRoomKeyBackup as m, bootstrapMatrixVerification as n, generateMatrixVerificationQr as o, requestMatrixVerification as p, cancelMatrixVerification as r, getMatrixEncryptionStatus as s, acceptMatrixVerification as t, getMatrixVerificationStatus as u, startMatrixVerification as v, verifyMatrixRecoveryKey as y };
