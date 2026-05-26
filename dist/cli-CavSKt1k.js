import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { n as formatZonedTimestamp } from "./format-datetime-DO2rqkXr.js";
import { a as resolveMatrixAccountConfig } from "./account-config-C6EZ3oG4.js";
import { t as getMatrixRuntime } from "./runtime-Bzh7h5rJ.js";
import { i as resolveMatrixAccount } from "./accounts-CAjG_HwT.js";
import { t as formatMatrixErrorMessage } from "./errors-Cd21tNWv.js";
import { n as updateMatrixAccountConfig, t as resolveMatrixConfigPath } from "./config-update-yy_QFIrd.js";
import { n as matrixSetupAdapter } from "./setup-core-BB3oYbaE.js";
import { t as resolveMatrixRoomKeyBackupIssue } from "./backup-health-Dm_YMVFT.js";
import { i as setMatrixSdkLogMode, r as setMatrixSdkConsoleLogging } from "./logging-CcTidUhi.js";
import { t as withResolvedActionClient } from "./client-CWBVxcE6.js";
import { r as resolveMatrixAuthContext } from "./config-zGJE8Xzj.js";
import "./client-DDhjrzng.js";
import "./runtime-api-DYOyZ9O3.js";
import { n as summarizeMatrixDeviceHealth, t as isOpenClawManagedMatrixDevice } from "./device-health-Dtq8SwPm.js";
import { n as updateMatrixOwnProfile, t as applyMatrixProfileUpdate } from "./profile-update-DyKXeMb-.js";
import { a as confirmMatrixVerificationSas, c as getMatrixRoomKeyBackupStatus, d as listMatrixVerifications, f as mismatchMatrixVerificationSas, g as runMatrixSelfVerification, h as restoreMatrixRoomKeyBackup, l as getMatrixVerificationSas, m as resetMatrixRoomKeyBackup, n as bootstrapMatrixVerification, p as requestMatrixVerification, r as cancelMatrixVerification, t as acceptMatrixVerification, u as getMatrixVerificationStatus, v as startMatrixVerification, y as verifyMatrixRecoveryKey } from "./verification-BHCyRbYY.js";
//#region extensions/matrix/src/matrix/actions/devices.ts
async function listMatrixOwnDevices(opts = {}) {
	return await withResolvedActionClient(opts, async (client) => await client.listOwnDevices());
}
async function pruneMatrixStaleGatewayDevices(opts = {}) {
	return await withResolvedActionClient(opts, async (client) => {
		const devices = await client.listOwnDevices();
		const staleGatewayDeviceIds = summarizeMatrixDeviceHealth(devices).staleOpenClawDevices.map((device) => device.deviceId);
		return {
			before: devices,
			staleGatewayDeviceIds,
			...staleGatewayDeviceIds.length > 0 ? await client.deleteOwnDevices(staleGatewayDeviceIds) : {
				currentDeviceId: devices.find((device) => device.current)?.deviceId ?? null,
				deletedDeviceIds: [],
				remainingDevices: devices
			}
		};
	});
}
//#endregion
//#region extensions/matrix/src/cli.ts
let matrixCliExitScheduled = false;
let matrixActionClientModulePromise;
let matrixDirectManagementModulePromise;
function loadMatrixActionClientModule() {
	matrixActionClientModulePromise ??= import("./client-C6QYMAHh.js");
	return matrixActionClientModulePromise;
}
function loadMatrixDirectManagementModule() {
	matrixDirectManagementModulePromise ??= import("./direct-management-50QogdfI.js");
	return matrixDirectManagementModulePromise;
}
function scheduleMatrixCliExit() {
	if (matrixCliExitScheduled || process.env.VITEST) return;
	matrixCliExitScheduled = true;
	setTimeout(() => {
		process.stdout.write("", () => {
			process.stderr.write("", () => {
				process.exit(process.exitCode ?? 0);
			});
		});
	}, 0);
}
function markCliFailure() {
	process.exitCode = 1;
}
async function readMatrixCliRecoveryKeyFromStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	const recoveryKey = Buffer.concat(chunks).toString("utf8").trim();
	if (!recoveryKey) throw new Error("Matrix recovery key was requested from stdin, but stdin was empty.");
	return recoveryKey;
}
async function resolveMatrixCliRecoveryKeyInput(options) {
	if (options.recoveryKey && options.recoveryKeyStdin === true) throw new Error("Use either --recovery-key or --recovery-key-stdin, not both.");
	if (options.recoveryKeyStdin === true) return await readMatrixCliRecoveryKeyFromStdin();
	return options.recoveryKey;
}
async function requireMatrixCliRecoveryKeyInput(options) {
	const recoveryKey = await resolveMatrixCliRecoveryKeyInput(options);
	if (!recoveryKey) throw new Error("Matrix recovery key is required. Pass --recovery-key-stdin to read it from stdin.");
	return recoveryKey;
}
function toErrorMessage(err) {
	return formatMatrixErrorMessage(err);
}
function printJson(payload) {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
function formatLocalTimestamp(value) {
	if (!value) return null;
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) return value;
	return formatZonedTimestamp(parsed, { displaySeconds: true }) ?? value;
}
function printTimestamp(label, value) {
	const formatted = formatLocalTimestamp(value);
	if (formatted) console.log(`${label}: ${formatMatrixCliText(formatted)}`);
}
function printAccountLabel(accountId) {
	console.log(`Account: ${formatMatrixCliText(normalizeAccountId(accountId))}`);
}
function resolveMatrixCliAccountId(accountId) {
	return resolveMatrixCliAccountContext(accountId).accountId;
}
function resolveMatrixCliAccountContext(accountId) {
	const cfg = getMatrixRuntime().config.current();
	return {
		accountId: resolveMatrixAuthContext({
			cfg,
			accountId
		}).accountId,
		cfg
	};
}
function formatMatrixCliCommand(command, accountId) {
	return formatMatrixCliCommandParts(command.split(" "), accountId);
}
function formatMatrixCliRecoveryKeyStdinCommand(command, accountId) {
	const normalizedAccountId = normalizeAccountId(accountId);
	return `printf '%s\\n' "$${normalizedAccountId === "default" ? "MATRIX_RECOVERY_KEY" : `MATRIX_RECOVERY_KEY_${normalizedAccountId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`}" | ${formatMatrixCliCommand(command, accountId)}`;
}
function formatMatrixCliCommandParts(parts, accountId) {
	const normalizedAccountId = normalizeAccountId(accountId);
	const command = [
		"openclaw",
		"matrix",
		...parts
	];
	if (normalizedAccountId !== "default") {
		const optionTerminatorIndex = command.indexOf("--");
		if (optionTerminatorIndex >= 0) command.splice(optionTerminatorIndex, 0, "--account", normalizedAccountId);
		else command.push("--account", normalizedAccountId);
	}
	return command.map(formatMatrixCliShellArg).join(" ");
}
function formatMatrixCliShellArg(value) {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function formatMatrixCliText(value, fallback = "unknown") {
	return sanitizeMatrixCliText(value ?? fallback);
}
function printMatrixOwnDevices(devices) {
	if (devices.length === 0) {
		console.log("Devices: none");
		return;
	}
	for (const device of devices) {
		const labels = [device.current ? "current" : null, device.displayName].filter((label) => Boolean(label)).map((label) => formatMatrixCliText(label));
		console.log(`- ${formatMatrixCliText(device.deviceId)}${labels.length ? ` (${labels.join(", ")})` : ""}`);
		if (device.lastSeenTs) printTimestamp("  Last seen", new Date(device.lastSeenTs).toISOString());
		if (device.lastSeenIp) console.log(`  Last IP: ${formatMatrixCliText(device.lastSeenIp)}`);
	}
}
function configureCliLogMode(verbose) {
	setMatrixSdkLogMode(verbose ? "default" : "quiet");
	setMatrixSdkConsoleLogging(verbose);
}
function parseOptionalInt(value, fieldName) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed)) throw new Error(`${fieldName} must be an integer`);
	return parsed;
}
async function addMatrixAccount(params) {
	const runtime = getMatrixRuntime();
	const cfg = runtime.config.current();
	if (!matrixSetupAdapter.applyAccountConfig) throw new Error("Matrix account setup is unavailable.");
	const input = {
		name: params.name,
		avatarUrl: params.avatarUrl,
		homeserver: params.homeserver,
		dangerouslyAllowPrivateNetwork: params.allowPrivateNetwork,
		proxy: params.proxy,
		userId: params.userId,
		accessToken: params.accessToken,
		password: params.password,
		deviceName: params.deviceName,
		initialSyncLimit: parseOptionalInt(params.initialSyncLimit, "--initial-sync-limit"),
		useEnv: params.useEnv === true
	};
	const accountId = matrixSetupAdapter.resolveAccountId?.({
		cfg,
		accountId: params.account,
		input
	}) ?? normalizeAccountId(params.account?.trim() || params.name?.trim());
	const validationError = matrixSetupAdapter.validateInput?.({
		cfg,
		accountId,
		input
	});
	if (validationError) throw new Error(validationError);
	let updated = matrixSetupAdapter.applyAccountConfig({
		cfg,
		accountId,
		input
	});
	if (params.enableEncryption === true) updated = updateMatrixAccountConfig(updated, accountId, { encryption: true });
	await runtime.config.replaceConfigFile({
		nextConfig: updated,
		afterWrite: { mode: "auto" }
	});
	const accountConfig = resolveMatrixAccountConfig({
		cfg: updated,
		accountId
	});
	let verificationBootstrap = {
		attempted: false,
		success: false,
		recoveryKeyCreatedAt: null,
		backupVersion: null
	};
	if (accountConfig.encryption === true) {
		const { maybeBootstrapNewEncryptedMatrixAccount } = await import("./setup-bootstrap-Mm_izHsm.js");
		verificationBootstrap = await maybeBootstrapNewEncryptedMatrixAccount({
			previousCfg: cfg,
			cfg: updated,
			accountId
		});
	}
	const desiredDisplayName = input.name?.trim();
	const desiredAvatarUrl = input.avatarUrl?.trim();
	let profile = {
		attempted: false,
		displayNameUpdated: false,
		avatarUpdated: false,
		resolvedAvatarUrl: null,
		convertedAvatarFromHttp: false
	};
	if (desiredDisplayName || desiredAvatarUrl) try {
		const synced = await updateMatrixOwnProfile({
			cfg: updated,
			accountId,
			displayName: desiredDisplayName,
			avatarUrl: desiredAvatarUrl
		});
		let resolvedAvatarUrl = synced.resolvedAvatarUrl;
		if (synced.convertedAvatarFromHttp && synced.resolvedAvatarUrl) {
			const withAvatar = updateMatrixAccountConfig(runtime.config.current(), accountId, { avatarUrl: synced.resolvedAvatarUrl });
			await runtime.config.replaceConfigFile({
				nextConfig: withAvatar,
				afterWrite: { mode: "auto" }
			});
			resolvedAvatarUrl = synced.resolvedAvatarUrl;
		}
		profile = {
			attempted: true,
			displayNameUpdated: synced.displayNameUpdated,
			avatarUpdated: synced.avatarUpdated,
			resolvedAvatarUrl,
			convertedAvatarFromHttp: synced.convertedAvatarFromHttp
		};
	} catch (err) {
		profile = {
			attempted: true,
			displayNameUpdated: false,
			avatarUpdated: false,
			resolvedAvatarUrl: null,
			convertedAvatarFromHttp: false,
			error: toErrorMessage(err)
		};
	}
	let deviceHealth = {
		currentDeviceId: null,
		staleOpenClawDeviceIds: []
	};
	try {
		const addedDevices = await listMatrixOwnDevices({
			accountId,
			cfg: updated
		});
		deviceHealth = {
			currentDeviceId: addedDevices.find((device) => device.current)?.deviceId ?? null,
			staleOpenClawDeviceIds: addedDevices.filter((device) => !device.current && isOpenClawManagedMatrixDevice(device.displayName)).map((device) => device.deviceId)
		};
	} catch (err) {
		deviceHealth = {
			currentDeviceId: null,
			staleOpenClawDeviceIds: [],
			error: toErrorMessage(err)
		};
	}
	return {
		accountId,
		configPath: resolveMatrixConfigPath(updated, accountId),
		useEnv: input.useEnv === true,
		encryptionEnabled: accountConfig.encryption === true,
		deviceHealth,
		verificationBootstrap,
		profile
	};
}
function printDirectRoomCandidate(room) {
	const members = room.joinedMembers === null ? "unavailable" : room.joinedMembers.map((member) => formatMatrixCliText(member)).join(", ") || "none";
	console.log(`- ${formatMatrixCliText(room.roomId)} [${room.source}] strict=${room.strict ? "yes" : "no"} joined=${members}`);
}
function printDirectRoomInspection(result) {
	printAccountLabel(result.accountId);
	console.log(`Peer: ${formatMatrixCliText(result.remoteUserId)}`);
	console.log(`Self: ${formatMatrixCliText(result.selfUserId)}`);
	console.log(`Active direct room: ${formatMatrixCliText(result.activeRoomId, "none")}`);
	console.log(`Mapped rooms: ${result.mappedRoomIds.length ? result.mappedRoomIds.map((roomId) => formatMatrixCliText(roomId)).join(", ") : "none"}`);
	console.log(`Discovered strict rooms: ${result.discoveredStrictRoomIds.length ? result.discoveredStrictRoomIds.map((roomId) => formatMatrixCliText(roomId)).join(", ") : "none"}`);
	if (result.mappedRooms.length > 0) {
		console.log("Mapped room details:");
		for (const room of result.mappedRooms) printDirectRoomCandidate(room);
	}
}
async function inspectMatrixDirectRoom(params) {
	const cfg = getMatrixRuntime().config.current();
	const [{ withResolvedActionClient }, { inspectMatrixDirectRooms }] = await Promise.all([loadMatrixActionClientModule(), loadMatrixDirectManagementModule()]);
	return await withResolvedActionClient({
		accountId: params.accountId,
		cfg
	}, async (client) => {
		const inspection = await inspectMatrixDirectRooms({
			client,
			remoteUserId: params.userId
		});
		return {
			accountId: params.accountId,
			remoteUserId: inspection.remoteUserId,
			selfUserId: inspection.selfUserId,
			mappedRoomIds: inspection.mappedRoomIds,
			mappedRooms: inspection.mappedRooms.map(toCliDirectRoomCandidate),
			discoveredStrictRoomIds: inspection.discoveredStrictRoomIds,
			activeRoomId: inspection.activeRoomId
		};
	}, "persist");
}
async function repairMatrixDirectRoom(params) {
	const cfg = getMatrixRuntime().config.current();
	const account = resolveMatrixAccount({
		cfg,
		accountId: params.accountId
	});
	const [{ withStartedActionClient }, { repairMatrixDirectRooms }] = await Promise.all([loadMatrixActionClientModule(), loadMatrixDirectManagementModule()]);
	return await withStartedActionClient({
		accountId: params.accountId,
		cfg
	}, async (client) => {
		const repaired = await repairMatrixDirectRooms({
			client,
			remoteUserId: params.userId,
			encrypted: account.config.encryption === true
		});
		return {
			accountId: params.accountId,
			remoteUserId: repaired.remoteUserId,
			selfUserId: repaired.selfUserId,
			mappedRoomIds: repaired.mappedRoomIds,
			mappedRooms: repaired.mappedRooms.map(toCliDirectRoomCandidate),
			discoveredStrictRoomIds: repaired.discoveredStrictRoomIds,
			activeRoomId: repaired.activeRoomId,
			encrypted: account.config.encryption === true,
			createdRoomId: repaired.createdRoomId,
			changed: repaired.changed,
			directContentBefore: repaired.directContentBefore,
			directContentAfter: repaired.directContentAfter
		};
	});
}
async function setMatrixProfile(params) {
	return await applyMatrixProfileUpdate({
		account: params.account,
		displayName: params.name,
		avatarUrl: params.avatarUrl
	});
}
async function runMatrixCliCommand(config) {
	configureCliLogMode(config.verbose);
	try {
		const result = await config.run();
		if (config.json) printJson(config.onJson ? config.onJson(result) : result);
		else config.onText(result, config.verbose);
		if (config.shouldFail?.(result)) markCliFailure();
	} catch (err) {
		const message = toErrorMessage(err);
		if (config.json) printJson(config.onJsonError ? config.onJsonError(message) : { error: message });
		else {
			console.error(`${config.errorPrefix}: ${formatMatrixCliText(message)}`);
			config.onTextError?.(message);
		}
		markCliFailure();
	} finally {
		scheduleMatrixCliExit();
	}
}
function isMatrixVerificationSetupComplete(status) {
	return status.encryptionEnabled && status.verified && status.crossSigningVerified && status.signedByOwner && status.serverDeviceKnown === true && resolveMatrixRoomKeyBackupIssue(resolveBackupStatus(status)).code === "ok";
}
function buildNoopMatrixVerificationBootstrap(status) {
	return {
		success: true,
		verification: {
			...status,
			backup: resolveBackupStatus(status),
			serverDeviceKnown: status.serverDeviceKnown ?? null
		},
		crossSigning: {
			userId: status.userId,
			masterKeyPublished: status.crossSigningVerified,
			selfSigningKeyPublished: status.signedByOwner,
			userSigningKeyPublished: status.signedByOwner,
			published: status.crossSigningVerified && status.signedByOwner
		},
		pendingVerifications: status.pendingVerifications,
		cryptoBootstrap: null
	};
}
async function setupMatrixEncryption(params) {
	const runtime = getMatrixRuntime();
	const { accountId, cfg } = resolveMatrixCliAccountContext(params.account);
	if (!resolveMatrixAccount({
		cfg,
		accountId
	}).configured) throw new Error(`Matrix account "${accountId}" is not configured; run ${formatMatrixCliCommand("account add", accountId)} first.`);
	const encryptionChanged = resolveMatrixAccountConfig({
		cfg,
		accountId
	}).encryption !== true;
	const updated = encryptionChanged ? updateMatrixAccountConfig(cfg, accountId, { encryption: true }) : cfg;
	if (encryptionChanged) await runtime.config.replaceConfigFile({
		nextConfig: updated,
		afterWrite: { mode: "auto" }
	});
	const existingStatus = !encryptionChanged && !params.recoveryKey && params.forceResetCrossSigning !== true ? await getMatrixVerificationStatus({
		accountId,
		cfg: updated,
		readiness: "none"
	}) : null;
	if (existingStatus && isMatrixVerificationSetupComplete(existingStatus)) return {
		accountId,
		configPath: resolveMatrixConfigPath(updated, accountId),
		encryptionChanged,
		bootstrap: buildNoopMatrixVerificationBootstrap(existingStatus),
		status: existingStatus
	};
	const bootstrap = await bootstrapMatrixVerification({
		accountId,
		cfg: updated,
		recoveryKey: params.recoveryKey,
		forceResetCrossSigning: params.forceResetCrossSigning === true
	});
	const status = await getMatrixVerificationStatus({
		accountId,
		cfg: updated
	});
	return {
		accountId,
		configPath: resolveMatrixConfigPath(updated, accountId),
		encryptionChanged,
		bootstrap,
		status
	};
}
function toCliDirectRoomCandidate(room) {
	return {
		roomId: room.roomId,
		source: room.source,
		strict: room.strict,
		joinedMembers: room.joinedMembers
	};
}
function resolveBackupStatus(status) {
	return {
		serverVersion: status.backup?.serverVersion ?? status.backupVersion ?? null,
		activeVersion: status.backup?.activeVersion ?? null,
		trusted: status.backup?.trusted ?? null,
		matchesDecryptionKey: status.backup?.matchesDecryptionKey ?? null,
		decryptionKeyCached: status.backup?.decryptionKeyCached ?? null,
		keyLoadAttempted: status.backup?.keyLoadAttempted ?? false,
		keyLoadError: status.backup?.keyLoadError ?? null
	};
}
function yesNoUnknown(value) {
	if (value === true) return "yes";
	if (value === false) return "no";
	return "unknown";
}
function printBackupStatus(backup) {
	console.log(`Backup server version: ${formatMatrixCliText(backup.serverVersion, "none")}`);
	console.log(`Backup active on this device: ${formatMatrixCliText(backup.activeVersion, "no")}`);
	console.log(`Backup trusted by this device: ${yesNoUnknown(backup.trusted)}`);
	console.log(`Backup matches local decryption key: ${yesNoUnknown(backup.matchesDecryptionKey)}`);
	console.log(`Backup key cached locally: ${yesNoUnknown(backup.decryptionKeyCached)}`);
	console.log(`Backup key load attempted: ${yesNoUnknown(backup.keyLoadAttempted)}`);
	if (backup.keyLoadError) console.log(`Backup key load error: ${formatMatrixCliText(backup.keyLoadError)}`);
}
function printVerificationIdentity(status) {
	console.log(`User: ${formatMatrixCliText(status.userId)}`);
	console.log(`Device: ${formatMatrixCliText(status.deviceId)}`);
}
function printVerificationBackupSummary(status) {
	printBackupSummary(resolveBackupStatus(status));
}
function printVerificationBackupStatus(status) {
	printBackupStatus(resolveBackupStatus(status));
}
function printVerificationTrustDiagnostics(status) {
	console.log(`Locally trusted: ${status.localVerified ? "yes" : "no"}`);
	console.log(`Cross-signing verified: ${status.crossSigningVerified ? "yes" : "no"}`);
	console.log(`Signed by owner: ${status.signedByOwner ? "yes" : "no"}`);
}
function sanitizeMatrixCliText(value) {
	let withoutAnsi = "";
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 155) {
			index++;
			while (index < value.length && !isAnsiFinalByte(value.charCodeAt(index))) index++;
			continue;
		}
		if (code === 157) {
			index++;
			while (index < value.length) {
				const current = value.charCodeAt(index);
				if (current === 7 || current === 156) break;
				if (current === 27 && value[index + 1] === "\\") {
					index++;
					break;
				}
				index++;
			}
			continue;
		}
		if (code === 144 || code === 158 || code === 159) {
			index++;
			while (index < value.length) {
				const current = value.charCodeAt(index);
				if (current === 7 || current === 156) break;
				if (current === 27 && value[index + 1] === "\\") {
					index++;
					break;
				}
				index++;
			}
			continue;
		}
		if (code !== 27) {
			withoutAnsi += value[index];
			continue;
		}
		const marker = value[index + 1];
		if (marker === "[") {
			index += 2;
			while (index < value.length && !isAnsiFinalByte(value.charCodeAt(index))) index++;
			continue;
		}
		if (marker === "]") {
			index += 2;
			while (index < value.length) {
				const current = value.charCodeAt(index);
				if (current === 7) break;
				if (current === 27 && value[index + 1] === "\\") {
					index++;
					break;
				}
				index++;
			}
			continue;
		}
		index++;
	}
	let sanitized = "";
	for (const character of withoutAnsi) if (!isUnsafeMatrixCliTerminalCode(character.charCodeAt(0))) sanitized += character;
	return sanitized;
}
function isUnsafeMatrixCliTerminalCode(code) {
	return code < 32 || code === 127 || code >= 128 && code <= 159 || code >= 8234 && code <= 8238 || code >= 8294 && code <= 8297;
}
function isAnsiFinalByte(code) {
	return code >= 64 && code <= 126;
}
function formatMatrixCliSasEmoji(emoji) {
	return emoji.map(([emojiValue, label]) => `${sanitizeMatrixCliText(emojiValue)} ${sanitizeMatrixCliText(label)}`).join(" | ");
}
function printMatrixVerificationSummary(summary) {
	console.log(`Verification id: ${sanitizeMatrixCliText(summary.id)}`);
	if (summary.transactionId) console.log(`Transaction id: ${sanitizeMatrixCliText(summary.transactionId)}`);
	if (summary.roomId) console.log(`Room id: ${sanitizeMatrixCliText(summary.roomId)}`);
	console.log(`Other user: ${sanitizeMatrixCliText(summary.otherUserId)}`);
	console.log(`Other device: ${sanitizeMatrixCliText(summary.otherDeviceId ?? "unknown")}`);
	console.log(`Self-verification: ${summary.isSelfVerification ? "yes" : "no"}`);
	console.log(`Initiated by OpenClaw: ${summary.initiatedByMe ? "yes" : "no"}`);
	console.log(`Phase: ${sanitizeMatrixCliText(summary.phaseName)}`);
	console.log(`Pending: ${summary.pending ? "yes" : "no"}`);
	console.log(`Completed: ${summary.completed ? "yes" : "no"}`);
	console.log(`Methods: ${summary.methods.length ? summary.methods.map(sanitizeMatrixCliText).join(", ") : "none"}`);
	if (summary.chosenMethod) console.log(`Chosen method: ${sanitizeMatrixCliText(summary.chosenMethod)}`);
	if (summary.hasSas && summary.sas?.emoji?.length) console.log(`SAS emoji: ${formatMatrixCliSasEmoji(summary.sas.emoji)}`);
	else if (summary.hasSas && summary.sas?.decimal) console.log(`SAS decimals: ${summary.sas.decimal.join(" ")}`);
	if (summary.error) console.log(`Verification error: ${sanitizeMatrixCliText(summary.error)}`);
}
function printMatrixVerificationSummaries(summaries) {
	if (summaries.length === 0) {
		console.log("Verifications: none");
		return;
	}
	summaries.forEach((summary, index) => {
		if (index > 0) console.log("");
		printMatrixVerificationSummary(summary);
	});
}
function printMatrixVerificationSas(sas) {
	if (sas.emoji?.length) console.log(`SAS emoji: ${formatMatrixCliSasEmoji(sas.emoji)}`);
	else if (sas.decimal) console.log(`SAS decimals: ${sas.decimal.join(" ")}`);
	else console.log("SAS: unavailable");
}
function matrixCliVerificationDmLookupOptions(options) {
	const lookup = {};
	if (options.roomId !== void 0) lookup.verificationDmRoomId = options.roomId;
	if (options.userId !== void 0) lookup.verificationDmUserId = options.userId;
	return lookup;
}
function formatMatrixVerificationDmFollowupParts(params) {
	if (!params.roomId || !params.userId) return [];
	return [
		"--user-id",
		sanitizeMatrixCliText(params.userId),
		"--room-id",
		sanitizeMatrixCliText(params.roomId)
	];
}
function formatMatrixVerificationSummaryDmFollowupParts(summary) {
	return formatMatrixVerificationDmFollowupParts({
		roomId: summary.roomId,
		userId: summary.otherUserId
	});
}
function formatMatrixVerificationOptionsDmFollowupParts(options) {
	return formatMatrixVerificationDmFollowupParts({
		roomId: options.roomId,
		userId: options.userId
	});
}
function formatMatrixVerificationPreferredDmFollowupParts(summary, options) {
	const summaryParts = formatMatrixVerificationSummaryDmFollowupParts(summary);
	return summaryParts.length ? summaryParts : formatMatrixVerificationOptionsDmFollowupParts(options);
}
function formatMatrixVerificationFollowupCommand(params) {
	return formatMatrixCliCommandParts([
		"verify",
		params.action,
		...params.dmParts ?? [],
		"--",
		params.requestId
	], params.accountId);
}
function printMatrixVerificationSasGuidance(requestId, accountId, dmParts = []) {
	printGuidance([
		`Compare the emoji or decimals with the other Matrix client.`,
		`If they match, run ${formatMatrixVerificationFollowupCommand({
			action: "confirm-sas",
			requestId,
			accountId,
			dmParts
		})}.`,
		`If they do not match, run ${formatMatrixVerificationFollowupCommand({
			action: "mismatch-sas",
			requestId,
			accountId,
			dmParts
		})}.`
	]);
}
function formatMatrixVerificationCommandId(summary) {
	return sanitizeMatrixCliText(summary.transactionId ?? summary.id);
}
async function promptMatrixVerificationSasMatch() {
	const { createInterface } = await import("node:readline/promises");
	const prompt = createInterface({
		input: process.stdin,
		output: process.stdout
	});
	try {
		const answer = await prompt.question("Do the emoji or decimals match? Type yes to confirm: ");
		return /^(?:y|yes)$/i.test(answer.trim());
	} finally {
		prompt.close();
	}
}
function printMatrixVerificationRequestGuidance(summary, accountId) {
	const requestId = formatMatrixVerificationCommandId(summary);
	const dmParts = formatMatrixVerificationSummaryDmFollowupParts(summary);
	printGuidance([
		`Accept the verification request in another Matrix client for this account.`,
		`Then run ${formatMatrixVerificationFollowupCommand({
			action: "start",
			requestId,
			accountId,
			dmParts
		})} to start SAS verification.`,
		`Run ${formatMatrixVerificationFollowupCommand({
			action: "sas",
			requestId,
			accountId,
			dmParts
		})} to display the SAS emoji or decimals.`,
		`When the SAS matches, run ${formatMatrixVerificationFollowupCommand({
			action: "confirm-sas",
			requestId,
			accountId,
			dmParts
		})}.`
	]);
}
async function runMatrixCliVerificationSummaryCommand(params) {
	const { accountId, cfg } = resolveMatrixCliAccountContext(params.options.account);
	await runMatrixCliCommand({
		verbose: params.options.verbose === true,
		json: params.options.json === true,
		run: async () => await params.run(accountId, cfg),
		onText: (summary) => {
			printAccountLabel(accountId);
			printMatrixVerificationSummary(summary);
			params.afterText?.(summary, accountId);
		},
		errorPrefix: params.errorPrefix
	});
}
async function runMatrixCliSelfVerificationCommand(options) {
	const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
	await runMatrixCliCommand({
		verbose: options.verbose === true,
		json: false,
		run: async () => await runMatrixSelfVerification({
			accountId,
			cfg,
			timeoutMs: parseOptionalInt(options.timeoutMs, "--timeout-ms"),
			onRequested: (summary) => {
				printAccountLabel(accountId);
				printMatrixVerificationSummary(summary);
				console.log("Accept this verification request in another Matrix client.");
			},
			onReady: (summary) => {
				console.log("Verification request accepted.");
				if (!summary.hasSas) console.log("Starting SAS verification...");
			},
			onSas: (summary) => {
				printMatrixVerificationSas(summary.sas ?? {});
				console.log("Compare this SAS with the other Matrix client.");
			},
			confirmSas: async () => await promptMatrixVerificationSasMatch()
		}),
		onText: (summary, verbose) => {
			printMatrixVerificationSummary(summary);
			console.log(`Device verified by owner: ${summary.deviceOwnerVerified ? "yes" : "no"}`);
			printVerificationTrustDiagnostics(summary.ownerVerification);
			printVerificationBackupSummary(summary.ownerVerification);
			if (verbose) printVerificationBackupStatus(summary.ownerVerification);
			console.log("Self-verification complete.");
		},
		onTextError: () => {
			printGuidance([`Run ${formatMatrixCliCommand("verify self", accountId)} again and accept the request in another verified Matrix client for this account.`, `Then run ${formatMatrixCliCommand("verify status --verbose", accountId)} to confirm Cross-signing verified: yes and Signed by owner: yes.`]);
		},
		errorPrefix: "Self-verification failed"
	});
}
function printVerificationGuidance(status, accountId) {
	printGuidance(buildVerificationGuidance(status, accountId));
}
function printBackupGuidance(backup, accountId, options = {}) {
	printGuidance(buildBackupGuidance(backup, accountId, options));
}
function printBackupSummary(backup) {
	const issue = resolveMatrixRoomKeyBackupIssue(backup);
	console.log(`Backup: ${issue.summary}`);
	if (backup.serverVersion) console.log(`Backup version: ${formatMatrixCliText(backup.serverVersion)}`);
}
function buildVerificationGuidance(status, accountId) {
	const backup = resolveBackupStatus(status);
	const nextSteps = /* @__PURE__ */ new Set();
	if (!status.verified) if (status.recoveryKeyAccepted === true && status.backupUsable === true) {
		nextSteps.add(`Recovery key can unlock the room-key backup, but full Matrix identity trust is still incomplete. Run ${formatMatrixCliCommand("verify self", accountId)}, accept the request in another verified Matrix client, and confirm the SAS only if it matches.`);
		nextSteps.add(`If you intend to replace the current cross-signing identity, run the shown printf pipeline with the Matrix recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify bootstrap --recovery-key-stdin --force-reset-cross-signing", accountId)}.`);
	} else nextSteps.add(`Run the shown printf pipeline with the Matrix recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify device --recovery-key-stdin", accountId)}. If you do not have the recovery key but still have another verified Matrix client, run ${formatMatrixCliCommand("verify self", accountId)} instead.`);
	if (status.serverDeviceKnown === false) nextSteps.add(`This Matrix device is no longer listed on the homeserver. Create a new OpenClaw Matrix device with ${formatMatrixCliCommand("account add --homeserver <url> --user-id <@user:server> --password <password> --device-name OpenClaw-Gateway", accountId)}. If you use token auth, create a fresh Matrix access token in your Matrix client or admin UI, then run ${formatMatrixCliCommand("account add --homeserver <url> --access-token <token>", accountId)}.`);
	for (const step of buildBackupGuidance(backup, accountId, { recoveryKeyStored: status.recoveryKeyStored })) nextSteps.add(step);
	if (status.pendingVerifications > 0) nextSteps.add(`Review pending verification requests with ${formatMatrixCliCommand("verify list", accountId)}. Complete each active request with ${formatMatrixCliCommand("verify sas <id>", accountId)} and ${formatMatrixCliCommand("verify confirm-sas <id>", accountId)}, or cancel stale requests with ${formatMatrixCliCommand("verify cancel <id>", accountId)}.`);
	return Array.from(nextSteps);
}
function buildBackupGuidance(backup, accountId, options = {}) {
	const backupIssue = resolveMatrixRoomKeyBackupIssue(backup);
	const nextSteps = /* @__PURE__ */ new Set();
	if (backupIssue.code === "missing-server-backup") nextSteps.add(`Run ${formatMatrixCliCommand("verify bootstrap", accountId)} to create a room key backup.`);
	else if (backupIssue.code === "key-load-failed" || backupIssue.code === "key-not-loaded" || backupIssue.code === "inactive") if (options.recoveryKeyStored) nextSteps.add(`Backup key is not loaded on this device. Run ${formatMatrixCliCommand("verify backup restore", accountId)} to load it and restore old room keys. If restore still cannot load the key, run the shown printf pipeline with the Matrix recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify backup restore --recovery-key-stdin", accountId)}.`);
	else nextSteps.add(`Run the shown printf pipeline with the Matrix recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify backup restore --recovery-key-stdin", accountId)} to load the server backup and store the key for future restores.`);
	else if (backupIssue.code === "key-mismatch") {
		nextSteps.add(`Backup key mismatch on this device. Run the shown printf pipeline with the active server backup recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify backup restore --recovery-key-stdin", accountId)}.`);
		nextSteps.add(`If you want a fresh backup baseline and accept losing unrecoverable history, run ${formatMatrixCliCommand("verify backup reset --yes", accountId)}. Add --rotate-recovery-key only when the old recovery key should stop unlocking the fresh backup.`);
	} else if (backupIssue.code === "untrusted-signature") {
		nextSteps.add(`Backup trust chain is not verified on this device. Run the shown printf pipeline with the correct recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify device --recovery-key-stdin", accountId)}.`);
		nextSteps.add(`If device identity trust remains incomplete after that, run ${formatMatrixCliCommand("verify self", accountId)} from another verified Matrix client.`);
		nextSteps.add(`If you want a fresh backup baseline and accept losing unrecoverable history, run ${formatMatrixCliCommand("verify backup reset --yes", accountId)}. Add --rotate-recovery-key only when the old recovery key should stop unlocking the fresh backup.`);
	} else if (backupIssue.code === "indeterminate") nextSteps.add(`Run ${formatMatrixCliCommand("verify status --verbose", accountId)} to inspect backup trust diagnostics.`);
	return Array.from(nextSteps);
}
function printGuidance(lines) {
	if (lines.length === 0) return;
	console.log("Next steps:");
	for (const line of lines) console.log(`- ${line}`);
}
function printVerificationStatus(status, verbose = false, accountId) {
	console.log(`Verified by owner: ${status.verified ? "yes" : "no"}`);
	if (status.serverDeviceKnown === false) console.log("Device issue: current Matrix device is missing from the homeserver device list");
	const backupIssue = resolveMatrixRoomKeyBackupIssue(resolveBackupStatus(status));
	printVerificationBackupSummary(status);
	if (backupIssue.message) console.log(`Backup issue: ${backupIssue.message}`);
	if (verbose) {
		console.log("Diagnostics:");
		printVerificationIdentity(status);
		if (status.serverDeviceKnown !== void 0) console.log(`Device present on server: ${yesNoUnknown(status.serverDeviceKnown ?? null)}`);
		printVerificationTrustDiagnostics(status);
		printVerificationBackupStatus(status);
		console.log(`Recovery key stored: ${status.recoveryKeyStored ? "yes" : "no"}`);
		printTimestamp("Recovery key created at", status.recoveryKeyCreatedAt);
		console.log(`Pending verifications: ${status.pendingVerifications}`);
	} else console.log(`Recovery key stored: ${status.recoveryKeyStored ? "yes" : "no"}`);
	printVerificationGuidance(status, accountId);
}
function printMatrixEncryptionSetupResult(result, verbose = false) {
	printAccountLabel(result.accountId);
	console.log(`Encryption config: ${result.encryptionChanged ? "enabled" : "already enabled"} at ${formatMatrixCliText(result.configPath)}`);
	console.log(`Bootstrap success: ${result.bootstrap.success ? "yes" : "no"}`);
	if (result.bootstrap.error) console.log(`Bootstrap error: ${formatMatrixCliText(result.bootstrap.error)}`);
	console.log(`Verified by owner: ${result.status.verified ? "yes" : "no"}`);
	printVerificationBackupSummary(result.status);
	if (verbose) {
		printVerificationIdentity(result.status);
		printVerificationTrustDiagnostics(result.status);
		printVerificationBackupStatus(result.status);
		console.log(`Recovery key stored: ${result.status.recoveryKeyStored ? "yes" : "no"}`);
		printTimestamp("Recovery key created at", result.status.recoveryKeyCreatedAt);
		console.log(`Pending verifications: ${result.status.pendingVerifications}`);
	}
	printVerificationGuidance(result.status, result.accountId);
}
function registerMatrixCli(params) {
	const root = params.program.command("matrix").description("Matrix channel utilities").addHelpText("after", () => "\nDocs: https://docs.openclaw.ai/channels/matrix\n");
	root.command("account").description("Manage matrix channel accounts").command("add").description("Add or update a matrix account (wrapper around channel setup)").option("--account <id>", "Account ID (default: normalized --name, else default)").option("--name <name>", "Optional display name for this account").option("--avatar-url <url>", "Optional Matrix avatar URL (mxc:// or http(s) URL)").option("--homeserver <url>", "Matrix homeserver URL").option("--proxy <url>", "Optional HTTP(S) proxy URL for Matrix requests").option("--allow-private-network", "Allow Matrix homeserver traffic to private/internal hosts for this account").option("--user-id <id>", "Matrix user ID").option("--access-token <token>", "Matrix access token").option("--password <password>", "Matrix password").option("--device-name <name>", "Matrix device display name").option("--initial-sync-limit <n>", "Matrix initial sync limit").option("--enable-e2ee", "Enable Matrix end-to-end encryption and bootstrap verification").option("--encryption", "Alias for --enable-e2ee").option("--use-env", "Use MATRIX_* env vars (or MATRIX_<ACCOUNT_ID>_* for non-default accounts)").option("--verbose", "Show setup details").option("--json", "Output as JSON").action(async (options) => {
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await addMatrixAccount({
				account: options.account,
				name: options.name,
				avatarUrl: options.avatarUrl,
				homeserver: options.homeserver,
				proxy: options.proxy,
				allowPrivateNetwork: options.allowPrivateNetwork === true,
				userId: options.userId,
				accessToken: options.accessToken,
				password: options.password,
				deviceName: options.deviceName,
				initialSyncLimit: options.initialSyncLimit,
				enableEncryption: options.enableE2ee === true || options.encryption === true,
				useEnv: options.useEnv === true
			}),
			onText: (result) => {
				console.log(`Saved matrix account: ${formatMatrixCliText(result.accountId)}`);
				console.log(`Config path: ${formatMatrixCliText(result.configPath)}`);
				console.log(`Credentials source: ${result.useEnv ? "MATRIX_* / MATRIX_<ACCOUNT_ID>_* env vars" : "inline config"}`);
				console.log(`Encryption: ${result.encryptionEnabled ? "enabled" : "disabled"}`);
				if (result.verificationBootstrap.attempted) if (result.verificationBootstrap.success) {
					console.log("Matrix verification bootstrap: complete");
					printTimestamp("Recovery key created at", result.verificationBootstrap.recoveryKeyCreatedAt);
					if (result.verificationBootstrap.backupVersion) console.log(`Backup version: ${formatMatrixCliText(result.verificationBootstrap.backupVersion)}`);
				} else console.error(`Matrix verification bootstrap warning: ${formatMatrixCliText(result.verificationBootstrap.error)}`);
				if (result.deviceHealth.error) console.error(`Matrix device health warning: ${formatMatrixCliText(result.deviceHealth.error)}`);
				else if (result.deviceHealth.staleOpenClawDeviceIds.length > 0) {
					const staleDeviceIds = result.deviceHealth.staleOpenClawDeviceIds.map((deviceId) => formatMatrixCliText(deviceId)).join(", ");
					console.log(`Matrix device hygiene warning: stale OpenClaw devices detected (${staleDeviceIds}). Run ${formatMatrixCliCommand("devices prune-stale", result.accountId)}.`);
				}
				if (result.profile.attempted) if (result.profile.error) console.error(`Profile sync warning: ${formatMatrixCliText(result.profile.error)}`);
				else {
					console.log(`Profile sync: name ${result.profile.displayNameUpdated ? "updated" : "unchanged"}, avatar ${result.profile.avatarUpdated ? "updated" : "unchanged"}`);
					if (result.profile.convertedAvatarFromHttp && result.profile.resolvedAvatarUrl) console.log(`Avatar converted and saved as: ${formatMatrixCliText(result.profile.resolvedAvatarUrl)}`);
				}
				const bindHint = `openclaw agents bind --agent <id> --bind matrix:${result.accountId}`;
				console.log(`Bind this account to an agent: ${bindHint}`);
			},
			errorPrefix: "Account setup failed"
		});
	});
	root.command("profile").description("Manage Matrix bot profile").command("set").description("Update Matrix profile display name and/or avatar").option("--account <id>", "Account ID (for multi-account setups)").option("--name <name>", "Profile display name").option("--avatar-url <url>", "Profile avatar URL (mxc:// or http(s) URL)").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await setMatrixProfile({
				account: options.account,
				name: options.name,
				avatarUrl: options.avatarUrl
			}),
			onText: (result) => {
				printAccountLabel(result.accountId);
				console.log(`Config path: ${result.configPath}`);
				console.log(`Profile update: name ${result.profile.displayNameUpdated ? "updated" : "unchanged"}, avatar ${result.profile.avatarUpdated ? "updated" : "unchanged"}`);
				if (result.profile.convertedAvatarFromHttp && result.avatarUrl) console.log(`Avatar converted and saved as: ${formatMatrixCliText(result.avatarUrl)}`);
			},
			errorPrefix: "Profile update failed"
		});
	});
	const direct = root.command("direct").description("Inspect and repair Matrix direct-room state");
	direct.command("inspect").description("Inspect direct-room mappings for a Matrix user").requiredOption("--user-id <id>", "Peer Matrix user ID").option("--account <id>", "Account ID (for multi-account setups)").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		const accountId = resolveMatrixCliAccountId(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await inspectMatrixDirectRoom({
				accountId,
				userId: options.userId
			}),
			onText: (result) => {
				printDirectRoomInspection(result);
			},
			errorPrefix: "Direct room inspection failed"
		});
	});
	direct.command("repair").description("Repair Matrix direct-room mappings for a Matrix user").requiredOption("--user-id <id>", "Peer Matrix user ID").option("--account <id>", "Account ID (for multi-account setups)").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		const accountId = resolveMatrixCliAccountId(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await repairMatrixDirectRoom({
				accountId,
				userId: options.userId
			}),
			onText: (result, verbose) => {
				printDirectRoomInspection(result);
				console.log(`Encrypted room creation: ${result.encrypted ? "enabled" : "disabled"}`);
				console.log(`Created room: ${formatMatrixCliText(result.createdRoomId, "none")}`);
				console.log(`m.direct updated: ${result.changed ? "yes" : "no"}`);
				if (verbose) {
					console.log(`m.direct before: ${formatMatrixCliText(JSON.stringify(result.directContentBefore[result.remoteUserId] ?? []))}`);
					console.log(`m.direct after: ${formatMatrixCliText(JSON.stringify(result.directContentAfter[result.remoteUserId] ?? []))}`);
				}
			},
			errorPrefix: "Direct room repair failed"
		});
	});
	root.command("encryption").description("Set up Matrix end-to-end encryption").command("setup").description("Enable Matrix E2EE, bootstrap verification, and print next steps").option("--account <id>", "Account ID (for multi-account setups)").option("--recovery-key <key>", "Recovery key to apply before bootstrap").option("--force-reset-cross-signing", "Force reset cross-signing identity before bootstrap").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await setupMatrixEncryption({
				account: options.account,
				recoveryKey: options.recoveryKey,
				forceResetCrossSigning: options.forceResetCrossSigning === true
			}),
			onText: (result, verbose) => {
				printMatrixEncryptionSetupResult(result, verbose);
			},
			onJson: (result) => ({
				success: result.bootstrap.success,
				...result
			}),
			shouldFail: (result) => !result.bootstrap.success,
			errorPrefix: "Encryption setup failed",
			onJsonError: (message) => ({
				success: false,
				error: message
			})
		});
	});
	const verify = root.command("verify").description("Device verification for Matrix E2EE");
	verify.command("list").description("List pending Matrix verification requests").option("--account <id>", "Account ID (for multi-account setups)").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await listMatrixVerifications({
				accountId,
				cfg
			}),
			onText: (summaries) => {
				printAccountLabel(accountId);
				printMatrixVerificationSummaries(summaries);
			},
			errorPrefix: "Verification listing failed"
		});
	});
	verify.command("self").description("Interactively self-verify this Matrix device").option("--account <id>", "Account ID (for multi-account setups)").option("--timeout-ms <ms>", "How long to wait for the other Matrix client").option("--verbose", "Show detailed diagnostics").action(async (options) => {
		await runMatrixCliSelfVerificationCommand(options);
	});
	verify.command("request").description("Request Matrix device verification from another Matrix client").option("--account <id>", "Account ID (for multi-account setups)").option("--own-user", "Request self-verification for this Matrix account").option("--user-id <id>", "Matrix user ID to verify").option("--device-id <id>", "Matrix device ID to verify").option("--room-id <id>", "Matrix direct-message room ID for verification").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => {
				if (options.ownUser === true && (options.userId || options.deviceId || options.roomId)) throw new Error("--own-user cannot be combined with --user-id, --device-id, or --room-id");
				return await requestMatrixVerification({
					accountId,
					cfg,
					ownUser: options.ownUser === true ? true : void 0,
					userId: options.userId,
					deviceId: options.deviceId,
					roomId: options.roomId
				});
			},
			onText: (summary) => {
				printAccountLabel(accountId);
				printMatrixVerificationSummary(summary);
				printMatrixVerificationRequestGuidance(summary, accountId);
			},
			errorPrefix: "Verification request failed"
		});
	});
	verify.command("accept <id>").description("Accept an inbound Matrix verification request").option("--account <id>", "Account ID (for multi-account setups)").option("--user-id <id>", "Matrix user ID for DM verification follow-up").option("--room-id <id>", "Matrix direct-message room ID for verification follow-up").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (id, options) => {
		await runMatrixCliVerificationSummaryCommand({
			options,
			run: async (accountId, cfg) => await acceptMatrixVerification(id, {
				accountId,
				cfg,
				...matrixCliVerificationDmLookupOptions(options)
			}),
			afterText: (summary, accountId) => {
				printGuidance([`Run ${formatMatrixVerificationFollowupCommand({
					action: "start",
					requestId: formatMatrixVerificationCommandId(summary),
					accountId,
					dmParts: formatMatrixVerificationPreferredDmFollowupParts(summary, options)
				})} to start SAS verification.`]);
			},
			errorPrefix: "Verification accept failed"
		});
	});
	verify.command("start <id>").description("Start SAS verification for a Matrix verification request").option("--account <id>", "Account ID (for multi-account setups)").option("--user-id <id>", "Matrix user ID for DM verification follow-up").option("--room-id <id>", "Matrix direct-message room ID for verification follow-up").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (id, options) => {
		await runMatrixCliVerificationSummaryCommand({
			options,
			run: async (accountId, cfg) => await startMatrixVerification(id, {
				accountId,
				cfg,
				method: "sas",
				...matrixCliVerificationDmLookupOptions(options)
			}),
			afterText: (summary, accountId) => printMatrixVerificationSasGuidance(formatMatrixVerificationCommandId(summary), accountId, formatMatrixVerificationPreferredDmFollowupParts(summary, options)),
			errorPrefix: "Verification start failed"
		});
	});
	verify.command("sas <id>").description("Show SAS emoji or decimals for a Matrix verification request").option("--account <id>", "Account ID (for multi-account setups)").option("--user-id <id>", "Matrix user ID for DM verification follow-up").option("--room-id <id>", "Matrix direct-message room ID for verification follow-up").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (id, options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await getMatrixVerificationSas(id, {
				accountId,
				cfg,
				...matrixCliVerificationDmLookupOptions(options)
			}),
			onText: (sas) => {
				const requestId = formatMatrixCliText(id);
				printAccountLabel(accountId);
				console.log(`Verification id: ${requestId}`);
				printMatrixVerificationSas(sas);
				printMatrixVerificationSasGuidance(requestId, accountId, formatMatrixVerificationOptionsDmFollowupParts(options));
			},
			errorPrefix: "Verification SAS lookup failed"
		});
	});
	verify.command("confirm-sas <id>").description("Confirm matching SAS emoji or decimals for a Matrix verification request").option("--account <id>", "Account ID (for multi-account setups)").option("--user-id <id>", "Matrix user ID for DM verification follow-up").option("--room-id <id>", "Matrix direct-message room ID for verification follow-up").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (id, options) => {
		await runMatrixCliVerificationSummaryCommand({
			options,
			run: async (accountId, cfg) => await confirmMatrixVerificationSas(id, {
				accountId,
				cfg,
				...matrixCliVerificationDmLookupOptions(options)
			}),
			errorPrefix: "Verification SAS confirm failed"
		});
	});
	verify.command("mismatch-sas <id>").description("Reject a Matrix SAS verification when the emoji or decimals do not match").option("--account <id>", "Account ID (for multi-account setups)").option("--user-id <id>", "Matrix user ID for DM verification follow-up").option("--room-id <id>", "Matrix direct-message room ID for verification follow-up").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (id, options) => {
		await runMatrixCliVerificationSummaryCommand({
			options,
			run: async (accountId, cfg) => await mismatchMatrixVerificationSas(id, {
				accountId,
				cfg,
				...matrixCliVerificationDmLookupOptions(options)
			}),
			errorPrefix: "Verification SAS mismatch failed"
		});
	});
	verify.command("cancel <id>").description("Cancel a Matrix verification request").option("--account <id>", "Account ID (for multi-account setups)").option("--user-id <id>", "Matrix user ID for DM verification follow-up").option("--room-id <id>", "Matrix direct-message room ID for verification follow-up").option("--reason <text>", "Cancellation reason").option("--code <code>", "Matrix cancellation code").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (id, options) => {
		await runMatrixCliVerificationSummaryCommand({
			options,
			run: async (accountId, cfg) => await cancelMatrixVerification(id, {
				accountId,
				cfg,
				reason: options.reason,
				code: options.code,
				...matrixCliVerificationDmLookupOptions(options)
			}),
			errorPrefix: "Verification cancel failed"
		});
	});
	verify.command("status").description("Check Matrix device verification status").option("--account <id>", "Account ID (for multi-account setups)").option("--verbose", "Show detailed diagnostics").option("--include-recovery-key", "Include stored recovery key in output").option("--allow-degraded-local-state", "Return best-effort diagnostics without preparing the Matrix account").option("--json", "Output as JSON").action(async (options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await getMatrixVerificationStatus({
				accountId,
				cfg,
				includeRecoveryKey: options.includeRecoveryKey === true,
				...options.allowDegradedLocalState === true ? { readiness: "none" } : {}
			}),
			onText: (status, verbose) => {
				printAccountLabel(accountId);
				printVerificationStatus(status, verbose, accountId);
			},
			shouldFail: (status) => status.serverDeviceKnown === false,
			errorPrefix: "Error"
		});
	});
	const backup = verify.command("backup").description("Matrix room-key backup health and restore");
	backup.command("status").description("Show Matrix room-key backup status for this device").option("--account <id>", "Account ID (for multi-account setups)").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await getMatrixRoomKeyBackupStatus({
				accountId,
				cfg
			}),
			onText: (status, verbose) => {
				printAccountLabel(accountId);
				printBackupSummary(status);
				if (verbose) printBackupStatus(status);
				printBackupGuidance(status, accountId);
			},
			errorPrefix: "Backup status failed"
		});
	});
	backup.command("reset").description("Delete the current server backup and create a fresh room-key backup baseline, repairing secret storage if needed for a durable reset").option("--account <id>", "Account ID (for multi-account setups)").option("--yes", "Confirm destructive backup reset", false).option("--rotate-recovery-key", "Create a new Matrix recovery key for the fresh backup").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => {
				if (options.yes !== true) throw new Error(`Refusing to reset Matrix room-key backup without --yes. If you accept losing unrecoverable history, re-run ${formatMatrixCliCommand("verify backup reset --yes", accountId)}.`);
				return await resetMatrixRoomKeyBackup({
					accountId,
					cfg,
					rotateRecoveryKey: options.rotateRecoveryKey === true
				});
			},
			onText: (result, verbose) => {
				printAccountLabel(accountId);
				console.log(`Reset success: ${result.success ? "yes" : "no"}`);
				if (result.error) console.log(`Error: ${formatMatrixCliText(result.error)}`);
				console.log(`Previous backup version: ${formatMatrixCliText(result.previousVersion, "none")}`);
				console.log(`Deleted backup version: ${formatMatrixCliText(result.deletedVersion, "none")}`);
				console.log(`Current backup version: ${formatMatrixCliText(result.createdVersion, "none")}`);
				printBackupSummary(result.backup);
				if (verbose) {
					printTimestamp("Reset at", result.resetAt);
					printBackupStatus(result.backup);
				}
				printBackupGuidance(result.backup, accountId);
			},
			shouldFail: (result) => !result.success,
			errorPrefix: "Backup reset failed",
			onJsonError: (message) => ({
				success: false,
				error: message
			})
		});
	});
	backup.command("restore").description("Restore encrypted room keys from server backup").option("--account <id>", "Account ID (for multi-account setups)").option("--recovery-key <key>", "Optional recovery key to load before restoring (prefer --recovery-key-stdin)").option("--recovery-key-stdin", "Read the Matrix recovery key from stdin").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await restoreMatrixRoomKeyBackup({
				accountId,
				cfg,
				recoveryKey: await resolveMatrixCliRecoveryKeyInput(options)
			}),
			onText: (result, verbose) => {
				printAccountLabel(accountId);
				console.log(`Restore success: ${result.success ? "yes" : "no"}`);
				if (result.error) console.log(`Error: ${formatMatrixCliText(result.error)}`);
				console.log(`Backup version: ${formatMatrixCliText(result.backupVersion, "none")}`);
				console.log(`Imported keys: ${result.imported}/${result.total}`);
				printBackupSummary(result.backup);
				if (verbose) {
					console.log(`Loaded key from secret storage: ${result.loadedFromSecretStorage ? "yes" : "no"}`);
					printTimestamp("Restored at", result.restoredAt);
					printBackupStatus(result.backup);
				}
				printBackupGuidance(result.backup, accountId, { recoveryKeyStored: result.loadedFromSecretStorage });
			},
			shouldFail: (result) => !result.success,
			errorPrefix: "Backup restore failed",
			onJsonError: (message) => ({
				success: false,
				error: message
			})
		});
	});
	verify.command("bootstrap").description("Bootstrap Matrix cross-signing and device verification state").option("--account <id>", "Account ID (for multi-account setups)").option("--recovery-key <key>", "Recovery key to apply before bootstrap (prefer --recovery-key-stdin)").option("--recovery-key-stdin", "Read the Matrix recovery key from stdin").option("--force-reset-cross-signing", "Force reset cross-signing identity before bootstrap").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await bootstrapMatrixVerification({
				accountId,
				cfg,
				recoveryKey: await resolveMatrixCliRecoveryKeyInput(options),
				forceResetCrossSigning: options.forceResetCrossSigning === true
			}),
			onText: (result, verbose) => {
				printAccountLabel(accountId);
				console.log(`Bootstrap success: ${result.success ? "yes" : "no"}`);
				if (result.error) console.log(`Error: ${formatMatrixCliText(result.error)}`);
				console.log(`Verified by owner: ${result.verification.verified ? "yes" : "no"}`);
				printVerificationIdentity(result.verification);
				if (verbose) {
					printVerificationTrustDiagnostics(result.verification);
					console.log(`Cross-signing published: ${result.crossSigning.published ? "yes" : "no"} (master=${result.crossSigning.masterKeyPublished ? "yes" : "no"}, self=${result.crossSigning.selfSigningKeyPublished ? "yes" : "no"}, user=${result.crossSigning.userSigningKeyPublished ? "yes" : "no"})`);
					printVerificationBackupStatus(result.verification);
					printTimestamp("Recovery key created at", result.verification.recoveryKeyCreatedAt);
					console.log(`Pending verifications: ${result.pendingVerifications}`);
				} else {
					console.log(`Cross-signing published: ${result.crossSigning.published ? "yes" : "no"}`);
					printVerificationBackupSummary(result.verification);
				}
				printVerificationGuidance({
					...result.verification,
					pendingVerifications: result.pendingVerifications
				}, accountId);
			},
			shouldFail: (result) => !result.success,
			errorPrefix: "Verification bootstrap failed",
			onJsonError: (message) => ({
				success: false,
				error: message
			})
		});
	});
	verify.command("device [key]").description("Verify device using a Matrix recovery key").option("--account <id>", "Account ID (for multi-account setups)").option("--recovery-key-stdin", "Read the Matrix recovery key from stdin").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (key, options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await verifyMatrixRecoveryKey(await requireMatrixCliRecoveryKeyInput({
				recoveryKey: key,
				recoveryKeyStdin: options.recoveryKeyStdin
			}), {
				accountId,
				cfg
			}),
			onText: (result, verbose) => {
				printAccountLabel(accountId);
				if (!result.success) {
					console.error(`Verification failed: ${formatMatrixCliText(result.error)}`);
					printVerificationIdentity(result);
					console.log(`Recovery key accepted: ${result.recoveryKeyAccepted ? "yes" : "no"}`);
					console.log(`Backup usable: ${result.backupUsable ? "yes" : "no"}`);
					console.log(`Device verified by owner: ${result.deviceOwnerVerified ? "yes" : "no"}`);
					printVerificationBackupSummary(result);
					if (verbose) {
						printVerificationTrustDiagnostics(result);
						printVerificationBackupStatus(result);
						printTimestamp("Recovery key created at", result.recoveryKeyCreatedAt);
					}
					printVerificationGuidance({
						...result,
						pendingVerifications: 0
					}, accountId);
					return;
				}
				console.log("Device verification completed successfully.");
				printVerificationIdentity(result);
				console.log(`Recovery key accepted: ${result.recoveryKeyAccepted ? "yes" : "no"}`);
				console.log(`Backup usable: ${result.backupUsable ? "yes" : "no"}`);
				console.log(`Device verified by owner: ${result.deviceOwnerVerified ? "yes" : "no"}`);
				printVerificationBackupSummary(result);
				if (verbose) {
					printVerificationTrustDiagnostics(result);
					printVerificationBackupStatus(result);
					printTimestamp("Recovery key created at", result.recoveryKeyCreatedAt);
					printTimestamp("Verified at", result.verifiedAt);
				}
				printVerificationGuidance({
					...result,
					pendingVerifications: 0
				}, accountId);
			},
			shouldFail: (result) => !result.success,
			errorPrefix: "Verification failed",
			onJsonError: (message) => ({
				success: false,
				error: message
			})
		});
	});
	const devices = root.command("devices").description("Inspect and clean up Matrix devices");
	devices.command("list").description("List server-side Matrix devices for this account").option("--account <id>", "Account ID (for multi-account setups)").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await listMatrixOwnDevices({
				accountId,
				cfg
			}),
			onText: (result) => {
				printAccountLabel(accountId);
				printMatrixOwnDevices(result);
			},
			errorPrefix: "Device listing failed"
		});
	});
	devices.command("prune-stale").description("Delete stale OpenClaw-managed devices for this account").option("--account <id>", "Account ID (for multi-account setups)").option("--verbose", "Show detailed diagnostics").option("--json", "Output as JSON").action(async (options) => {
		const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
		await runMatrixCliCommand({
			verbose: options.verbose === true,
			json: options.json === true,
			run: async () => await pruneMatrixStaleGatewayDevices({
				accountId,
				cfg
			}),
			onText: (result, verbose) => {
				printAccountLabel(accountId);
				console.log(`Deleted stale OpenClaw devices: ${result.deletedDeviceIds.length ? result.deletedDeviceIds.map((deviceId) => formatMatrixCliText(deviceId)).join(", ") : "none"}`);
				console.log(`Current device: ${formatMatrixCliText(result.currentDeviceId)}`);
				console.log(`Remaining devices: ${result.remainingDevices.length}`);
				if (verbose) {
					console.log("Devices before cleanup:");
					printMatrixOwnDevices(result.before);
					console.log("Devices after cleanup:");
					printMatrixOwnDevices(result.remainingDevices);
				}
			},
			errorPrefix: "Device cleanup failed"
		});
	});
}
//#endregion
export { registerMatrixCli };
