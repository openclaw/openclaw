import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig } from "../types.js";
import { resolveDefaultMatrixAccountId } from "./accounts.js";
import { resolveMatrixConfigFieldPath } from "./config-update.js";

export function resolveMatrixEncryptionConfigPath(
	cfg: CoreConfig,
	accountId?: string | null,
): string {
	const effectiveAccountId =
		normalizeOptionalAccountId(accountId) ?? resolveDefaultMatrixAccountId(cfg);
	return resolveMatrixConfigFieldPath(cfg, effectiveAccountId, "encryption");
}

export function formatMatrixEncryptionUnavailableError(
	cfg: CoreConfig,
	accountId?: string | null,
): string {
	return `Matrix encryption is not available (enable ${resolveMatrixEncryptionConfigPath(cfg, accountId)}=true)`;
}

export function formatMatrixEncryptedEventDisabledWarning(
	cfg: CoreConfig,
	accountId?: string | null,
): string {
	return `matrix: encrypted event received without encryption enabled; set ${resolveMatrixEncryptionConfigPath(cfg, accountId)}=true and verify the device to decrypt`;
}
