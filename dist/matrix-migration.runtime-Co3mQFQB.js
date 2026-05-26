import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { i as writeJsonFileAtomically, t as loadJsonFile } from "./json-store-ChgPP2Sf.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./state-paths-iYyQ0JoC.js";
import { a as resolveMatrixDefaultOrOnlyAccountId, i as resolveMatrixChannelConfig, n as requiresExplicitMatrixDefaultAccount, o as resolveMatrixAccountStringValues, r as resolveConfiguredMatrixAccountIds, t as findMatrixAccountEntry } from "./account-selection-CfoMW0gI.js";
import { i as resolveScopedMatrixEnvConfig, n as resolveGlobalMatrixEnvConfig } from "./env-auth-RoZX59IM.js";
import { a as resolveMatrixCredentialsPath, n as resolveMatrixAccountStorageRoot, s as resolveMatrixLegacyFlatStoragePaths } from "./storage-paths--aIiLx_E.js";
import { t as formatMatrixErrorMessage } from "./errors-Cd21tNWv.js";
import "./migration-snapshot-backup-B4vOJHYh.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region extensions/matrix/src/migration-config.ts
function clean(value) {
	return normalizeOptionalString(value) ?? "";
}
function resolveMatrixAccountConfigEntry(cfg, accountId) {
	return findMatrixAccountEntry(cfg, accountId);
}
function resolveMatrixFlatStoreSelectionNote(cfg, accountId) {
	if (resolveConfiguredMatrixAccountIds(cfg).length <= 1) return;
	return `Legacy Matrix flat store uses one shared on-disk state, so it will be migrated into account "${accountId}".`;
}
function resolveMatrixMigrationConfigFields(params) {
	const channel = resolveMatrixChannelConfig(params.cfg);
	const account = resolveMatrixAccountConfigEntry(params.cfg, params.accountId);
	const scopedEnv = resolveScopedMatrixEnvConfig(params.accountId, params.env);
	const globalEnv = resolveGlobalMatrixEnvConfig(params.env);
	const resolvedStrings = resolveMatrixAccountStringValues({
		accountId: normalizeAccountId(params.accountId),
		account: {
			homeserver: clean(account?.homeserver),
			userId: clean(account?.userId),
			accessToken: clean(account?.accessToken)
		},
		scopedEnv,
		channel: {
			homeserver: clean(channel?.homeserver),
			userId: clean(channel?.userId),
			accessToken: clean(channel?.accessToken)
		},
		globalEnv
	});
	return {
		homeserver: resolvedStrings.homeserver,
		userId: resolvedStrings.userId,
		accessToken: resolvedStrings.accessToken
	};
}
function loadStoredMatrixCredentials(env, accountId) {
	const credentialsPath = resolveMatrixCredentialsPath({
		stateDir: resolveStateDir(env, os.homedir),
		accountId: normalizeAccountId(accountId)
	});
	try {
		if (!fs.existsSync(credentialsPath)) return null;
		const parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
		if (typeof parsed.homeserver !== "string" || typeof parsed.userId !== "string" || typeof parsed.accessToken !== "string") return null;
		return {
			homeserver: parsed.homeserver,
			userId: parsed.userId,
			accessToken: parsed.accessToken,
			deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : void 0
		};
	} catch {
		return null;
	}
}
function credentialsMatchResolvedIdentity(stored, identity) {
	if (!stored || !identity.homeserver) return false;
	if (!identity.userId) {
		if (!identity.accessToken) return false;
		return stored.homeserver === identity.homeserver && stored.accessToken === identity.accessToken;
	}
	return stored.homeserver === identity.homeserver && stored.userId === identity.userId;
}
function resolveMatrixMigrationAccountTarget(params) {
	const stored = loadStoredMatrixCredentials(params.env, params.accountId);
	const resolved = resolveMatrixMigrationConfigFields(params);
	const matchingStored = credentialsMatchResolvedIdentity(stored, {
		homeserver: resolved.homeserver,
		userId: resolved.userId,
		accessToken: resolved.accessToken
	}) ? stored : null;
	const homeserver = resolved.homeserver;
	const userId = resolved.userId || matchingStored?.userId || "";
	const accessToken = resolved.accessToken || matchingStored?.accessToken || "";
	if (!homeserver || !userId || !accessToken) return null;
	const { rootDir } = resolveMatrixAccountStorageRoot({
		stateDir: resolveStateDir(params.env, os.homedir),
		homeserver,
		userId,
		accessToken,
		accountId: params.accountId
	});
	return {
		accountId: params.accountId,
		homeserver,
		userId,
		accessToken,
		rootDir,
		storedDeviceId: matchingStored?.deviceId ?? null
	};
}
function resolveLegacyMatrixFlatStoreTarget(params) {
	if (!resolveMatrixChannelConfig(params.cfg)) return { warning: `Legacy Matrix ${params.detectedKind} detected at ${params.detectedPath}, but channels.matrix is not configured yet. Configure Matrix, then rerun "openclaw doctor --fix" or restart the gateway.` };
	if (requiresExplicitMatrixDefaultAccount(params.cfg)) return { warning: `Legacy Matrix ${params.detectedKind} detected at ${params.detectedPath}, but multiple Matrix accounts are configured and channels.matrix.defaultAccount is not set. Set "channels.matrix.defaultAccount" to the intended target account before rerunning "openclaw doctor --fix" or restarting the gateway.` };
	const accountId = resolveMatrixDefaultOrOnlyAccountId(params.cfg);
	const target = resolveMatrixMigrationAccountTarget({
		cfg: params.cfg,
		env: params.env,
		accountId
	});
	if (!target) {
		const targetDescription = params.detectedKind === "state" ? "the new account-scoped target" : "the account-scoped target";
		return { warning: `Legacy Matrix ${params.detectedKind} detected at ${params.detectedPath}, but ${targetDescription} could not be resolved yet (need homeserver, userId, and access token for channels.matrix${accountId === "default" ? "" : `.accounts.${accountId}`}). Start the gateway once with a working Matrix login, or rerun "openclaw doctor --fix" after cached credentials are available.` };
	}
	return {
		...target,
		selectionNote: resolveMatrixFlatStoreSelectionNote(params.cfg, accountId)
	};
}
//#endregion
//#region extensions/matrix/src/legacy-state.ts
function resolveLegacyMatrixPaths(env) {
	return resolveMatrixLegacyFlatStoragePaths(resolveStateDir(env, os.homedir));
}
function resolveMatrixMigrationPlan(params) {
	const legacy = resolveLegacyMatrixPaths(params.env);
	if (!fs.existsSync(legacy.storagePath) && !fs.existsSync(legacy.cryptoPath)) return null;
	const target = resolveLegacyMatrixFlatStoreTarget({
		cfg: params.cfg,
		env: params.env,
		detectedPath: legacy.rootDir,
		detectedKind: "state"
	});
	if ("warning" in target) return target;
	return {
		accountId: target.accountId,
		legacyStoragePath: legacy.storagePath,
		legacyCryptoPath: legacy.cryptoPath,
		targetRootDir: target.rootDir,
		targetStoragePath: path.join(target.rootDir, "bot-storage.json"),
		targetCryptoPath: path.join(target.rootDir, "crypto"),
		selectionNote: target.selectionNote
	};
}
function detectLegacyMatrixState(params) {
	return resolveMatrixMigrationPlan({
		cfg: params.cfg,
		env: params.env ?? process.env
	});
}
function moveLegacyPath(params) {
	if (!fs.existsSync(params.sourcePath)) return;
	if (fs.existsSync(params.targetPath)) {
		params.warnings.push(`Matrix legacy ${params.label} not migrated because the target already exists (${params.targetPath}).`);
		return;
	}
	try {
		fs.mkdirSync(path.dirname(params.targetPath), { recursive: true });
		fs.renameSync(params.sourcePath, params.targetPath);
		params.changes.push(`Migrated Matrix legacy ${params.label}: ${params.sourcePath} -> ${params.targetPath}`);
	} catch (err) {
		params.warnings.push(`Failed migrating Matrix legacy ${params.label} (${params.sourcePath} -> ${params.targetPath}): ${String(err)}`);
	}
}
async function autoMigrateLegacyMatrixState(params) {
	const env = params.env ?? process.env;
	const detection = detectLegacyMatrixState({
		cfg: params.cfg,
		env
	});
	if (!detection) return {
		migrated: false,
		changes: [],
		warnings: []
	};
	if ("warning" in detection) {
		params.log?.warn?.(`matrix: ${detection.warning}`);
		return {
			migrated: false,
			changes: [],
			warnings: [detection.warning]
		};
	}
	const changes = [];
	const warnings = [];
	moveLegacyPath({
		sourcePath: detection.legacyStoragePath,
		targetPath: detection.targetStoragePath,
		label: "sync store",
		changes,
		warnings
	});
	moveLegacyPath({
		sourcePath: detection.legacyCryptoPath,
		targetPath: detection.targetCryptoPath,
		label: "crypto store",
		changes,
		warnings
	});
	if (changes.length > 0) {
		const details = [
			...changes.map((entry) => `- ${entry}`),
			...detection.selectionNote ? [`- ${detection.selectionNote}`] : [],
			"- No user action required."
		];
		params.log?.info?.(`matrix: plugin upgraded in place for account "${detection.accountId}".\n${details.join("\n")}`);
	}
	if (warnings.length > 0) params.log?.warn?.(`matrix: legacy state migration warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`);
	return {
		migrated: changes.length > 0,
		changes,
		warnings
	};
}
//#endregion
//#region extensions/matrix/src/legacy-crypto-inspector-availability.ts
const LEGACY_CRYPTO_INSPECTOR_FILE = "legacy-crypto-inspector.js";
const LEGACY_CRYPTO_INSPECTOR_CHUNK_PREFIX = "legacy-crypto-inspector-";
const LEGACY_CRYPTO_INSPECTOR_HELPER_CHUNK_PREFIX = "availability-";
const JAVASCRIPT_MODULE_SUFFIX = ".js";
function isLegacyCryptoInspectorArtifactName(name) {
	if (name === LEGACY_CRYPTO_INSPECTOR_FILE) return true;
	if (!name.startsWith(LEGACY_CRYPTO_INSPECTOR_CHUNK_PREFIX) || !name.endsWith(JAVASCRIPT_MODULE_SUFFIX)) return false;
	const chunkSuffix = name.slice(24, -3);
	return chunkSuffix.length > 0 && chunkSuffix !== "availability" && !chunkSuffix.startsWith(LEGACY_CRYPTO_INSPECTOR_HELPER_CHUNK_PREFIX);
}
function hasSourceInspectorArtifact(currentDir) {
	return [path.resolve(currentDir, "matrix", "legacy-crypto-inspector.ts"), path.resolve(currentDir, "matrix", "legacy-crypto-inspector.js")].some((candidate) => fs.existsSync(candidate));
}
function hasBuiltInspectorArtifact(currentDir) {
	if (fs.existsSync(path.join(currentDir, "legacy-crypto-inspector.js"))) return true;
	if (fs.existsSync(path.join(currentDir, "extensions", "matrix", "legacy-crypto-inspector.js"))) return true;
	return fs.readdirSync(currentDir, { withFileTypes: true }).some((entry) => entry.isFile() && isLegacyCryptoInspectorArtifactName(entry.name));
}
function isMatrixLegacyCryptoInspectorAvailable() {
	const currentDir = path.dirname(fileURLToPath(import.meta.url));
	if (hasSourceInspectorArtifact(currentDir)) return true;
	try {
		return hasBuiltInspectorArtifact(currentDir);
	} catch {
		return false;
	}
}
//#endregion
//#region extensions/matrix/src/legacy-crypto.ts
const MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE = "Legacy Matrix encrypted state was detected, but the Matrix crypto inspector is unavailable.";
async function loadMatrixLegacyCryptoInspector() {
	return (await import("./legacy-crypto-inspector-CJmWM775.js")).inspectLegacyMatrixCryptoStore;
}
function detectLegacyBotSdkCryptoStore(cryptoRootDir) {
	try {
		if (!fs.statSync(cryptoRootDir).isDirectory()) return {
			detected: false,
			warning: `Legacy Matrix encrypted state path exists but is not a directory: ${cryptoRootDir}. OpenClaw skipped automatic crypto migration for that path.`
		};
	} catch (err) {
		return {
			detected: false,
			warning: `Failed reading legacy Matrix encrypted state path (${cryptoRootDir}): ${String(err)}. OpenClaw skipped automatic crypto migration for that path.`
		};
	}
	try {
		return { detected: fs.existsSync(path.join(cryptoRootDir, "bot-sdk.json")) || fs.existsSync(path.join(cryptoRootDir, "matrix-sdk-crypto.sqlite3")) || fs.readdirSync(cryptoRootDir, { withFileTypes: true }).some((entry) => entry.isDirectory() && fs.existsSync(path.join(cryptoRootDir, entry.name, "matrix-sdk-crypto.sqlite3"))) };
	} catch (err) {
		return {
			detected: false,
			warning: `Failed scanning legacy Matrix encrypted state path (${cryptoRootDir}): ${String(err)}. OpenClaw skipped automatic crypto migration for that path.`
		};
	}
}
function resolveMatrixAccountIds(cfg) {
	return resolveConfiguredMatrixAccountIds(cfg);
}
function resolveLegacyMatrixFlatStorePlan(params) {
	const legacy = resolveMatrixLegacyFlatStoragePaths(resolveStateDir(params.env, os.homedir));
	if (!fs.existsSync(legacy.cryptoPath)) return null;
	const legacyStore = detectLegacyBotSdkCryptoStore(legacy.cryptoPath);
	if (legacyStore.warning) return { warning: legacyStore.warning };
	if (!legacyStore.detected) return null;
	const target = resolveLegacyMatrixFlatStoreTarget({
		cfg: params.cfg,
		env: params.env,
		detectedPath: legacy.cryptoPath,
		detectedKind: "encrypted state"
	});
	if ("warning" in target) return target;
	const metadata = loadLegacyBotSdkMetadata(legacy.cryptoPath);
	return {
		accountId: target.accountId,
		rootDir: target.rootDir,
		recoveryKeyPath: path.join(target.rootDir, "recovery-key.json"),
		statePath: path.join(target.rootDir, "legacy-crypto-migration.json"),
		legacyCryptoPath: legacy.cryptoPath,
		homeserver: target.homeserver,
		userId: target.userId,
		accessToken: target.accessToken,
		deviceId: metadata.deviceId ?? target.storedDeviceId
	};
}
function loadLegacyBotSdkMetadata(cryptoRootDir) {
	const metadataPath = path.join(cryptoRootDir, "bot-sdk.json");
	const fallback = { deviceId: null };
	const parsed = loadJsonFile(metadataPath);
	return { deviceId: typeof parsed?.deviceId === "string" && parsed.deviceId.trim() ? parsed.deviceId : fallback.deviceId };
}
function resolveMatrixLegacyCryptoPlans(params) {
	const warnings = [];
	const plans = [];
	const flatPlan = resolveLegacyMatrixFlatStorePlan(params);
	if (flatPlan) if ("warning" in flatPlan) warnings.push(flatPlan.warning);
	else plans.push(flatPlan);
	for (const accountId of resolveMatrixAccountIds(params.cfg)) {
		const target = resolveMatrixMigrationAccountTarget({
			cfg: params.cfg,
			env: params.env,
			accountId
		});
		if (!target) continue;
		const legacyCryptoPath = path.join(target.rootDir, "crypto");
		if (!fs.existsSync(legacyCryptoPath)) continue;
		const detectedStore = detectLegacyBotSdkCryptoStore(legacyCryptoPath);
		if (detectedStore.warning) {
			warnings.push(detectedStore.warning);
			continue;
		}
		if (!detectedStore.detected) continue;
		if (plans.some((plan) => plan.accountId === accountId && path.resolve(plan.legacyCryptoPath) === path.resolve(legacyCryptoPath))) continue;
		const metadata = loadLegacyBotSdkMetadata(legacyCryptoPath);
		plans.push({
			accountId: target.accountId,
			rootDir: target.rootDir,
			recoveryKeyPath: path.join(target.rootDir, "recovery-key.json"),
			statePath: path.join(target.rootDir, "legacy-crypto-migration.json"),
			legacyCryptoPath,
			homeserver: target.homeserver,
			userId: target.userId,
			accessToken: target.accessToken,
			deviceId: metadata.deviceId ?? target.storedDeviceId
		});
	}
	return {
		plans,
		warnings
	};
}
function loadStoredRecoveryKey(filePath) {
	return loadJsonFile(filePath) ?? null;
}
function loadLegacyCryptoMigrationState(filePath) {
	return loadJsonFile(filePath) ?? null;
}
async function persistLegacyMigrationState(params) {
	await params.writeJsonFileAtomically(params.filePath, params.state);
}
function detectLegacyMatrixCrypto(params) {
	const detection = resolveMatrixLegacyCryptoPlans({
		cfg: params.cfg,
		env: params.env ?? process.env
	});
	const inspectorAvailable = detection.plans.length === 0 || isMatrixLegacyCryptoInspectorAvailable();
	if (!inspectorAvailable && detection.plans.length > 0) return {
		inspectorAvailable,
		plans: detection.plans,
		warnings: [...detection.warnings, MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE]
	};
	return {
		inspectorAvailable,
		plans: detection.plans,
		warnings: detection.warnings
	};
}
async function autoPrepareLegacyMatrixCrypto(params) {
	const env = params.env ?? process.env;
	const detection = params.deps?.inspectLegacyStore ? resolveMatrixLegacyCryptoPlans({
		cfg: params.cfg,
		env
	}) : detectLegacyMatrixCrypto({
		cfg: params.cfg,
		env
	});
	const inspectorAvailable = "inspectorAvailable" in detection ? detection.inspectorAvailable : true;
	const warnings = [...detection.warnings];
	const changes = [];
	const writeJsonFileAtomically$1 = params.deps?.writeJsonFileAtomically ?? writeJsonFileAtomically;
	if (detection.plans.length === 0) {
		if (warnings.length > 0) params.log?.warn?.(`matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`);
		return {
			migrated: false,
			changes,
			warnings
		};
	}
	if (!params.deps?.inspectLegacyStore && !inspectorAvailable) {
		if (warnings.length > 0) params.log?.warn?.(`matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`);
		return {
			migrated: false,
			changes,
			warnings
		};
	}
	let inspectLegacyStore = params.deps?.inspectLegacyStore;
	if (!inspectLegacyStore) try {
		inspectLegacyStore = await loadMatrixLegacyCryptoInspector();
	} catch (err) {
		const message = formatMatrixErrorMessage(err);
		if (!warnings.includes(message)) warnings.push(message);
		if (warnings.length > 0) params.log?.warn?.(`matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`);
		return {
			migrated: false,
			changes,
			warnings
		};
	}
	if (!inspectLegacyStore) return {
		migrated: false,
		changes,
		warnings
	};
	for (const plan of detection.plans) {
		if (loadLegacyCryptoMigrationState(plan.statePath)?.version === 1) continue;
		if (!plan.deviceId) {
			warnings.push(`Legacy Matrix encrypted state detected at ${plan.legacyCryptoPath}, but no device ID was found for account "${plan.accountId}". OpenClaw will continue, but old encrypted history cannot be recovered automatically.`);
			continue;
		}
		let summary;
		try {
			summary = await inspectLegacyStore({
				cryptoRootDir: plan.legacyCryptoPath,
				userId: plan.userId,
				deviceId: plan.deviceId,
				log: params.log?.info
			});
		} catch (err) {
			warnings.push(`Failed inspecting legacy Matrix encrypted state for account "${plan.accountId}" (${plan.legacyCryptoPath}): ${String(err)}`);
			continue;
		}
		let decryptionKeyImported = false;
		if (summary.decryptionKeyBase64) {
			const existingRecoveryKey = loadStoredRecoveryKey(plan.recoveryKeyPath);
			if (existingRecoveryKey?.privateKeyBase64 && existingRecoveryKey.privateKeyBase64 !== summary.decryptionKeyBase64) warnings.push(`Legacy Matrix backup key was found for account "${plan.accountId}", but ${plan.recoveryKeyPath} already contains a different recovery key. Leaving the existing file unchanged.`);
			else if (!existingRecoveryKey?.privateKeyBase64) {
				const payload = {
					version: 1,
					createdAt: (/* @__PURE__ */ new Date()).toISOString(),
					keyId: null,
					privateKeyBase64: summary.decryptionKeyBase64
				};
				try {
					await writeJsonFileAtomically$1(plan.recoveryKeyPath, payload);
					changes.push(`Imported Matrix legacy backup key for account "${plan.accountId}": ${plan.recoveryKeyPath}`);
					decryptionKeyImported = true;
				} catch (err) {
					warnings.push(`Failed writing Matrix recovery key for account "${plan.accountId}" (${plan.recoveryKeyPath}): ${String(err)}`);
				}
			} else decryptionKeyImported = true;
		}
		const localOnlyKeys = summary.roomKeyCounts && summary.roomKeyCounts.total > summary.roomKeyCounts.backedUp ? summary.roomKeyCounts.total - summary.roomKeyCounts.backedUp : 0;
		if (localOnlyKeys > 0) warnings.push(`Legacy Matrix encrypted state for account "${plan.accountId}" contains ${localOnlyKeys} room key(s) that were never backed up. Backed-up keys can be restored automatically, but local-only encrypted history may remain unavailable after upgrade.`);
		if (!summary.decryptionKeyBase64 && (summary.roomKeyCounts?.backedUp ?? 0) > 0) warnings.push(`Legacy Matrix encrypted state for account "${plan.accountId}" has backed-up room keys, but no local backup decryption key was found. Ask the operator to run "openclaw matrix verify backup restore --recovery-key <key>" after upgrade if they have the recovery key.`);
		if (!summary.decryptionKeyBase64 && (summary.roomKeyCounts?.total ?? 0) > 0) warnings.push(`Legacy Matrix encrypted state for account "${plan.accountId}" cannot be fully converted automatically because the old rust crypto store does not expose all local room keys for export.`);
		if (summary.decryptionKeyBase64 && !decryptionKeyImported && !loadStoredRecoveryKey(plan.recoveryKeyPath)) continue;
		const state = {
			version: 1,
			source: "matrix-bot-sdk-rust",
			accountId: plan.accountId,
			deviceId: summary.deviceId,
			roomKeyCounts: summary.roomKeyCounts,
			backupVersion: summary.backupVersion,
			decryptionKeyImported,
			restoreStatus: decryptionKeyImported ? "pending" : "manual-action-required",
			detectedAt: (/* @__PURE__ */ new Date()).toISOString(),
			lastError: null
		};
		try {
			await persistLegacyMigrationState({
				filePath: plan.statePath,
				state,
				writeJsonFileAtomically: writeJsonFileAtomically$1
			});
			changes.push(`Prepared Matrix legacy encrypted-state migration for account "${plan.accountId}": ${plan.statePath}`);
		} catch (err) {
			warnings.push(`Failed writing Matrix legacy encrypted-state migration record for account "${plan.accountId}" (${plan.statePath}): ${String(err)}`);
		}
	}
	if (changes.length > 0) params.log?.info?.(`matrix: prepared encrypted-state upgrade.\n${changes.map((entry) => `- ${entry}`).join("\n")}`);
	if (warnings.length > 0) params.log?.warn?.(`matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`);
	return {
		migrated: changes.length > 0,
		changes,
		warnings
	};
}
//#endregion
//#region extensions/matrix/src/migration-snapshot.ts
function resolveMatrixMigrationStatus(params) {
	const env = params.env ?? process.env;
	const legacyState = detectLegacyMatrixState({
		cfg: params.cfg,
		env
	});
	const legacyCrypto = detectLegacyMatrixCrypto({
		cfg: params.cfg,
		env
	});
	const actionableLegacyState = legacyState !== null && !("warning" in legacyState);
	const actionableLegacyCrypto = legacyCrypto.plans.length > 0 && legacyCrypto.inspectorAvailable;
	return {
		legacyState,
		legacyCrypto,
		pending: legacyState !== null || legacyCrypto.plans.length > 0 || legacyCrypto.warnings.length > 0,
		actionable: actionableLegacyState || actionableLegacyCrypto
	};
}
function hasPendingMatrixMigration(params) {
	return resolveMatrixMigrationStatus(params).pending;
}
function hasActionableMatrixMigration(params) {
	return resolveMatrixMigrationStatus(params).actionable;
}
//#endregion
export { detectLegacyMatrixCrypto as a, autoPrepareLegacyMatrixCrypto as i, hasPendingMatrixMigration as n, autoMigrateLegacyMatrixState as o, resolveMatrixMigrationStatus as r, detectLegacyMatrixState as s, hasActionableMatrixMigration as t };
