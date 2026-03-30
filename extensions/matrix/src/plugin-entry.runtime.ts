import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/core";
import {
	bootstrapMatrixVerification,
	getMatrixVerificationStatus,
	verifyMatrixRecoveryKey,
} from "./matrix/actions/verification.js";
import { ensureMatrixCryptoRuntime } from "./matrix/deps.js";

function sendError(
	respond: (ok: boolean, payload?: unknown) => void,
	err: unknown,
) {
	respond(false, { error: err instanceof Error ? err.message : String(err) });
}

export { ensureMatrixCryptoRuntime };

export async function handleVerifyRecoveryKey({
	params,
	respond,
}: GatewayRequestHandlerOptions): Promise<void> {
	try {
		const key = typeof params?.key === "string" ? params.key : "";
		if (!key.trim()) {
			respond(false, { error: "key required" });
			return;
		}
		const accountId =
			typeof params?.accountId === "string"
				? params.accountId.trim() || undefined
				: undefined;
		const result = await verifyMatrixRecoveryKey(key, { accountId });
		respond(result.success, result);
	} catch (err) {
		sendError(respond, err);
	}
}

export async function handleVerificationBootstrap({
	params,
	respond,
}: GatewayRequestHandlerOptions): Promise<void> {
	try {
		const accountId =
			typeof params?.accountId === "string"
				? params.accountId.trim() || undefined
				: undefined;
		const recoveryKey =
			typeof params?.recoveryKey === "string" ? params.recoveryKey : undefined;
		const forceResetCrossSigning = params?.forceResetCrossSigning === true;
		const result = await bootstrapMatrixVerification({
			accountId,
			recoveryKey,
			forceResetCrossSigning,
		});
		respond(result.success, result);
	} catch (err) {
		sendError(respond, err);
	}
}

export async function handleVerificationStatus({
	params,
	respond,
}: GatewayRequestHandlerOptions): Promise<void> {
	try {
		const accountId =
			typeof params?.accountId === "string"
				? params.accountId.trim() || undefined
				: undefined;
		const includeRecoveryKey = params?.includeRecoveryKey === true;
		const status = await getMatrixVerificationStatus({
			accountId,
			includeRecoveryKey,
		});
		respond(true, status);
	} catch (err) {
		sendError(respond, err);
	}
}
