import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
	listConfiguredAccountIds,
	resolveNormalizedAccountEntry,
} from "openclaw/plugin-sdk/account-resolution";
import {
	DEFAULT_ACCOUNT_ID,
	hasConfiguredSecretInput,
} from "../runtime-api.js";
import type {
	CoreConfig,
	MatrixAccountConfig,
	MatrixConfig,
} from "../types.js";

export function resolveMatrixBaseConfig(cfg: CoreConfig): MatrixConfig {
	return cfg.channels?.matrix ?? {};
}

function resolveMatrixAccountsMap(
	cfg: CoreConfig,
): Readonly<Record<string, MatrixAccountConfig>> {
	const accounts = resolveMatrixBaseConfig(cfg).accounts;
	if (!accounts || typeof accounts !== "object") {
		return {};
	}
	return accounts;
}

export function listNormalizedMatrixAccountIds(cfg: CoreConfig): string[] {
	return listConfiguredAccountIds({
		accounts: resolveMatrixAccountsMap(cfg),
		normalizeAccountId,
	});
}

export function findMatrixAccountConfig(
	cfg: CoreConfig,
	accountId: string,
): MatrixAccountConfig | undefined {
	return resolveNormalizedAccountEntry(
		resolveMatrixAccountsMap(cfg),
		accountId,
		normalizeAccountId,
	);
}

export function hasExplicitMatrixAccountConfig(
	cfg: CoreConfig,
	accountId: string,
): boolean {
	const normalized = normalizeAccountId(accountId);
	if (findMatrixAccountConfig(cfg, normalized)) {
		return true;
	}
	if (normalized !== DEFAULT_ACCOUNT_ID) {
		return false;
	}
	const matrix = resolveMatrixBaseConfig(cfg);
	return (
		typeof matrix.enabled === "boolean" ||
		typeof matrix.name === "string" ||
		typeof matrix.homeserver === "string" ||
		typeof matrix.userId === "string" ||
		hasConfiguredSecretInput(matrix.accessToken) ||
		hasConfiguredSecretInput(matrix.password) ||
		typeof matrix.deviceId === "string" ||
		typeof matrix.deviceName === "string" ||
		typeof matrix.avatarUrl === "string"
	);
}
