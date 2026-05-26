import { o as normalizeNullableString } from "./string-coerce-DyL154ka.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { t as KeyedAsyncQueue } from "./keyed-async-queue-CBv-Vhmc.js";
import { i as writeJsonFileAtomically } from "./json-store-ChgPP2Sf.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./record-shared-DQ4sTnau.js";
import { n as formatMatrixErrorReason, r as isMatrixNotFoundError, t as formatMatrixErrorMessage } from "./errors-Cd21tNWv.js";
import { t as claimCurrentTokenStorageState } from "./storage-BVAqboeh.js";
import { n as resolveMatrixRoomKeyBackupReadinessError } from "./backup-health-Dm_YMVFT.js";
import { t as createAsyncLock } from "./async-lock-BcLS4KOc.js";
import { n as LogService, r as noop } from "./logger-CjN9_ytq.js";
import { t as createMatrixJsSdkClientLogger } from "./logging-CcTidUhi.js";
import { a as matrixEventToRaw, n as createMatrixGuardedFetch, o as parseMxc, t as MatrixAuthedHttpClient } from "./http-client-C-kvVjHY.js";
import { n as isRepairableSecretStorageAccessError, r as MATRIX_IDB_PERSIST_INTERVAL_MS, t as MatrixRecoveryKeyStore } from "./recovery-key-store-DLpPEjzu.js";
import { i as throwIfMatrixStartupAborted, n as createMatrixStartupAbortError } from "./startup-abort-B-YL8CNT.js";
import { n as isMatrixReadySyncState, r as isMatrixTerminalSyncState } from "./sync-state-CWbp0QSY.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { EventEmitter } from "node:events";
import { Category, ClientEvent, Filter, MatrixEventEvent, MemoryStore, Preset, SyncAccumulator, createClient } from "matrix-js-sdk/lib/matrix.js";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
//#region extensions/matrix/src/matrix/client/file-sync-store.ts
const STORE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 250;
function normalizeRoomsData(value) {
	if (!isRecord(value)) return null;
	return {
		[Category.Join]: isRecord(value[Category.Join]) ? value[Category.Join] : {},
		[Category.Invite]: isRecord(value[Category.Invite]) ? value[Category.Invite] : {},
		[Category.Leave]: isRecord(value[Category.Leave]) ? value[Category.Leave] : {},
		[Category.Knock]: isRecord(value[Category.Knock]) ? value[Category.Knock] : {}
	};
}
function toPersistedSyncData(value) {
	if (!isRecord(value)) return null;
	if (typeof value.nextBatch === "string" && value.nextBatch.trim()) {
		const roomsData = normalizeRoomsData(value.roomsData);
		if (!Array.isArray(value.accountData) || !roomsData) return null;
		return {
			nextBatch: value.nextBatch,
			accountData: value.accountData,
			roomsData
		};
	}
	if (typeof value.next_batch === "string" && value.next_batch.trim()) {
		const roomsData = normalizeRoomsData(value.rooms);
		if (!roomsData) return null;
		return {
			nextBatch: value.next_batch,
			accountData: isRecord(value.account_data) && Array.isArray(value.account_data.events) ? value.account_data.events : [],
			roomsData
		};
	}
	return null;
}
function readPersistedStore(raw) {
	try {
		const parsed = JSON.parse(raw);
		const savedSync = toPersistedSyncData(parsed.savedSync);
		if (parsed.version === STORE_VERSION) return {
			version: STORE_VERSION,
			savedSync,
			clientOptions: isRecord(parsed.clientOptions) ? parsed.clientOptions : void 0,
			cleanShutdown: parsed.cleanShutdown === true
		};
		return {
			version: STORE_VERSION,
			savedSync: toPersistedSyncData(parsed),
			cleanShutdown: false
		};
	} catch {
		return null;
	}
}
function cloneJson(value) {
	return structuredClone(value);
}
function syncDataToSyncResponse(syncData) {
	return {
		next_batch: syncData.nextBatch,
		rooms: syncData.roomsData,
		account_data: { events: syncData.accountData }
	};
}
var FileBackedMatrixSyncStore = class extends MemoryStore {
	constructor(storagePath) {
		super();
		this.storagePath = storagePath;
		this.persistLock = createAsyncLock();
		this.accumulator = new SyncAccumulator();
		this.savedSync = null;
		this.cleanShutdown = false;
		this.dirty = false;
		this.persistTimer = null;
		this.persistPromise = null;
		let restoredSavedSync = null;
		let restoredClientOptions;
		let restoredCleanShutdown = false;
		try {
			const persisted = readPersistedStore(readFileSync(this.storagePath, "utf8"));
			restoredSavedSync = persisted?.savedSync ?? null;
			restoredClientOptions = persisted?.clientOptions;
			restoredCleanShutdown = persisted?.cleanShutdown === true;
		} catch {}
		this.savedSync = restoredSavedSync;
		this.savedClientOptions = restoredClientOptions;
		this.hadSavedSyncOnLoad = restoredSavedSync !== null;
		this.hadCleanShutdownOnLoad = this.hadSavedSyncOnLoad && restoredCleanShutdown;
		this.cleanShutdown = this.hadCleanShutdownOnLoad;
		if (this.savedSync) {
			this.accumulator.accumulate(syncDataToSyncResponse(this.savedSync), true);
			super.setSyncToken(this.savedSync.nextBatch);
		}
		if (this.savedClientOptions) super.storeClientOptions(this.savedClientOptions);
	}
	hasSavedSync() {
		return this.hadSavedSyncOnLoad;
	}
	hasSavedSyncFromCleanShutdown() {
		return this.hadCleanShutdownOnLoad;
	}
	getSavedSync() {
		return Promise.resolve(this.savedSync ? cloneJson(this.savedSync) : null);
	}
	getSavedSyncToken() {
		return Promise.resolve(this.savedSync?.nextBatch ?? null);
	}
	setSyncData(syncData) {
		this.accumulator.accumulate(syncData);
		this.savedSync = this.accumulator.getJSON();
		this.markDirtyAndSchedulePersist();
		return Promise.resolve();
	}
	getClientOptions() {
		return Promise.resolve(this.savedClientOptions ? cloneJson(this.savedClientOptions) : void 0);
	}
	storeClientOptions(options) {
		this.savedClientOptions = cloneJson(options);
		super.storeClientOptions(options);
		this.markDirtyAndSchedulePersist();
		return Promise.resolve();
	}
	save(force = false) {
		if (force) return this.flush();
		return Promise.resolve();
	}
	wantsSave() {
		return false;
	}
	async deleteAllData() {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		this.dirty = false;
		await this.persistPromise?.catch(() => void 0);
		await super.deleteAllData();
		this.savedSync = null;
		this.savedClientOptions = void 0;
		this.cleanShutdown = false;
		await fs$1.rm(this.storagePath, { force: true }).catch(() => void 0);
	}
	markCleanShutdown() {
		this.cleanShutdown = true;
		this.dirty = true;
	}
	async flush() {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		while (this.dirty || this.persistPromise) {
			if (this.dirty && !this.persistPromise) this.persistPromise = this.persist().finally(() => {
				this.persistPromise = null;
			});
			await this.persistPromise;
		}
	}
	markDirtyAndSchedulePersist() {
		this.cleanShutdown = false;
		this.dirty = true;
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			this.flush().catch((err) => {
				LogService.warn("MatrixFileSyncStore", "Failed to persist Matrix sync store:", err);
			});
		}, PERSIST_DEBOUNCE_MS);
		this.persistTimer.unref?.();
	}
	async persist() {
		this.dirty = false;
		const payload = {
			version: STORE_VERSION,
			savedSync: this.savedSync ? cloneJson(this.savedSync) : null,
			cleanShutdown: this.cleanShutdown,
			...this.savedClientOptions ? { clientOptions: cloneJson(this.savedClientOptions) } : {}
		};
		try {
			await this.persistLock(async () => {
				await writeJsonFileAtomically(this.storagePath, payload);
				claimCurrentTokenStorageState({ rootDir: path.dirname(this.storagePath) });
			});
		} catch (err) {
			this.dirty = true;
			throw err;
		}
	}
};
//#endregion
//#region extensions/matrix/src/matrix/sdk.ts
const MATRIX_STATUS_DIAGNOSTIC_TIMEOUT_MS = 1e4;
function unresolvedMatrixRoomKeyBackupStatus() {
	return {
		serverVersion: null,
		activeVersion: null,
		trusted: null,
		matchesDecryptionKey: null,
		decryptionKeyCached: null,
		keyLoadAttempted: false,
		keyLoadError: null
	};
}
function unresolvedMatrixDeviceVerificationStatus(params) {
	return {
		encryptionEnabled: true,
		userId: params.userId,
		deviceId: params.deviceId,
		verified: false,
		localVerified: false,
		crossSigningVerified: false,
		signedByOwner: false
	};
}
async function resolveMatrixDiagnostic(promise, timeoutMs) {
	return (await resolveMatrixDiagnosticResult(promise, timeoutMs)).value;
}
async function resolveMatrixDiagnosticResult(promise, timeoutMs) {
	let timeoutId;
	try {
		const guarded = promise.then((value) => ({
			error: null,
			timedOut: false,
			value
		})).catch((error) => ({
			error,
			timedOut: false,
			value: null
		}));
		const timeout = new Promise((resolve) => {
			timeoutId = setTimeout(() => resolve({
				error: null,
				timedOut: true,
				value: null
			}), timeoutMs);
			timeoutId.unref?.();
		});
		return await Promise.race([guarded, timeout]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
function isMatrixAccessTokenInvalidatedError(error) {
	if (!error || typeof error !== "object") return false;
	const err = error;
	const errcode = err.body?.errcode ?? err.data?.errcode;
	if (err.statusCode === 401 && errcode === "M_UNKNOWN_TOKEN") return true;
	const reason = formatMatrixErrorReason(error);
	return reason.includes("m_unknown_token") || reason.includes("unknown token") || reason.includes("access token") && (reason.includes("invalid") || reason.includes("unrecognized") || reason.includes("unknown"));
}
const MATRIX_INITIAL_CRYPTO_BOOTSTRAP_OPTIONS = { allowAutomaticCrossSigningReset: false };
const MATRIX_AUTOMATIC_REPAIR_BOOTSTRAP_OPTIONS = {
	forceResetCrossSigning: true,
	allowSecretStorageRecreateWithoutRecoveryKey: true,
	strict: true
};
function createMatrixExplicitBootstrapOptions(params) {
	return {
		forceResetCrossSigning: params?.forceResetCrossSigning === true,
		allowAutomaticCrossSigningReset: params?.allowAutomaticCrossSigningReset !== false,
		allowSecretStorageRecreateWithoutRecoveryKey: true,
		strict: params?.strict !== false
	};
}
let loadedMatrixCryptoRuntime = null;
let matrixCryptoRuntimePromise = null;
async function loadMatrixCryptoRuntime() {
	matrixCryptoRuntimePromise ??= import("./crypto-runtime-DIQNQenW.js").then((runtime) => {
		loadedMatrixCryptoRuntime = runtime;
		return runtime;
	});
	return await matrixCryptoRuntimePromise;
}
const normalizeOptionalString = normalizeNullableString;
function isUnsupportedAuthenticatedMediaEndpointError(err) {
	const statusCode = err?.statusCode;
	if (statusCode === 404 || statusCode === 405 || statusCode === 501) return true;
	const message = formatMatrixErrorReason(err);
	return message.includes("m_unrecognized") || message.includes("unrecognized request") || message.includes("method not allowed") || message.includes("not implemented");
}
var MatrixClient = class {
	constructor(homeserver, accessToken, opts = {}) {
		this.emitter = new EventEmitter();
		this.bridgeRegistered = false;
		this.started = false;
		this.cryptoBootstrapped = false;
		this.dmRoomIds = /* @__PURE__ */ new Set();
		this.cryptoInitialized = false;
		this.sendQueue = new KeyedAsyncQueue();
		this.stopPersistPromise = null;
		this.verificationSummaryListenerBound = false;
		this.currentSyncState = null;
		this.dms = {
			update: async () => {
				return await this.refreshDmCache();
			},
			isDm: (roomId) => this.dmRoomIds.has(roomId)
		};
		this.idbPersistTimer = null;
		this.httpClient = new MatrixAuthedHttpClient({
			homeserver,
			accessToken,
			ssrfPolicy: opts.ssrfPolicy,
			dispatcherPolicy: opts.dispatcherPolicy
		});
		this.localTimeoutMs = Math.max(1, opts.localTimeoutMs ?? 6e4);
		this.initialSyncLimit = opts.initialSyncLimit;
		this.syncFilter = opts.syncFilter;
		this.encryptionEnabled = opts.encryption === true;
		this.password = opts.password;
		this.syncStore = opts.storagePath ? new FileBackedMatrixSyncStore(opts.storagePath) : void 0;
		this.idbSnapshotPath = opts.idbSnapshotPath;
		this.cryptoDatabasePrefix = opts.cryptoDatabasePrefix;
		this.selfUserId = opts.userId?.trim() || null;
		this.autoBootstrapCrypto = opts.autoBootstrapCrypto !== false;
		this.recoveryKeyStore = new MatrixRecoveryKeyStore(opts.recoveryKeyPath);
		const cryptoCallbacks = this.encryptionEnabled ? this.recoveryKeyStore.buildCryptoCallbacks() : void 0;
		this.client = createClient({
			baseUrl: homeserver,
			accessToken,
			userId: opts.userId,
			deviceId: opts.deviceId,
			logger: createMatrixJsSdkClientLogger("MatrixClient"),
			localTimeoutMs: this.localTimeoutMs,
			fetchFn: createMatrixGuardedFetch({
				ssrfPolicy: opts.ssrfPolicy,
				dispatcherPolicy: opts.dispatcherPolicy
			}),
			store: this.syncStore,
			cryptoCallbacks,
			verificationMethods: [
				VerificationMethod.Sas,
				VerificationMethod.ShowQrCode,
				VerificationMethod.ScanQrCode,
				VerificationMethod.Reciprocate
			]
		});
	}
	on(eventName, listener) {
		this.emitter.on(eventName, listener);
		return this;
	}
	off(eventName, listener) {
		this.emitter.off(eventName, listener);
		return this;
	}
	async ensureCryptoSupportInitialized() {
		if (this.decryptBridge && (!this.encryptionEnabled || this.verificationManager && this.cryptoBootstrapper && this.crypto)) return;
		const runtime = await loadMatrixCryptoRuntime();
		this.decryptBridge ??= new runtime.MatrixDecryptBridge({
			client: this.client,
			toRaw: (event) => matrixEventToRaw(event, { contentMode: "original" }),
			emitDecryptedEvent: (roomId, event) => {
				this.emitter.emit("room.decrypted_event", roomId, event);
			},
			emitMessage: (roomId, event) => {
				this.emitter.emit("room.message", roomId, event);
			},
			emitFailedDecryption: (roomId, event, error) => {
				this.emitter.emit("room.failed_decryption", roomId, event, error);
			}
		});
		if (!this.encryptionEnabled) return;
		this.verificationManager ??= new runtime.MatrixVerificationManager({ trustOwnDeviceAfterSas: async (deviceId) => {
			const crypto = this.client.getCrypto();
			if (typeof crypto?.crossSignDevice !== "function") return;
			await crypto.crossSignDevice(deviceId);
		} });
		this.cryptoBootstrapper ??= new runtime.MatrixCryptoBootstrapper({
			getUserId: () => this.getUserId(),
			getPassword: () => this.password,
			getDeviceId: () => this.client.getDeviceId(),
			verificationManager: this.verificationManager,
			recoveryKeyStore: this.recoveryKeyStore,
			decryptBridge: this.decryptBridge
		});
		if (!this.crypto) this.crypto = runtime.createMatrixCryptoFacade({
			client: this.client,
			verificationManager: this.verificationManager,
			recoveryKeyStore: this.recoveryKeyStore,
			getRoomStateEvent: (roomId, eventType, stateKey = "") => this.getRoomStateEvent(roomId, eventType, stateKey),
			downloadContent: (mxcUrl) => this.downloadContent(mxcUrl)
		});
		if (!this.verificationSummaryListenerBound) {
			this.verificationSummaryListenerBound = true;
			this.verificationManager.onSummaryChanged((summary) => {
				this.emitter.emit("verification.summary", summary);
			});
		}
	}
	async start(opts = {}) {
		await this.startSyncSession({
			bootstrapCrypto: true,
			abortSignal: opts.abortSignal,
			readyTimeoutMs: opts.readyTimeoutMs
		});
	}
	async waitForInitialSyncReady(params = {}) {
		const timeoutMs = params.timeoutMs ?? 3e4;
		if (isMatrixReadySyncState(this.currentSyncState)) return;
		if (isMatrixTerminalSyncState(this.currentSyncState)) throw new Error(`Matrix sync entered ${this.currentSyncState} during startup`);
		await new Promise((resolve, reject) => {
			let settled = false;
			let timeoutId;
			const abortSignal = params.abortSignal;
			const cleanup = () => {
				this.off("sync.state", onSyncState);
				this.off("sync.unexpected_error", onUnexpectedError);
				abortSignal?.removeEventListener("abort", onAbort);
				if (timeoutId) {
					clearTimeout(timeoutId);
					timeoutId = void 0;
				}
			};
			const settleResolve = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			const settleReject = (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const onSyncState = (state, _prevState, error) => {
				if (isMatrixReadySyncState(state)) {
					settleResolve();
					return;
				}
				if (isMatrixTerminalSyncState(state)) settleReject(new Error(error instanceof Error && error.message ? error.message : `Matrix sync entered ${state} during startup`));
			};
			const onUnexpectedError = (error) => {
				settleReject(error);
			};
			const onAbort = () => {
				settleReject(createMatrixStartupAbortError());
			};
			this.on("sync.state", onSyncState);
			this.on("sync.unexpected_error", onUnexpectedError);
			if (abortSignal?.aborted) {
				onAbort();
				return;
			}
			abortSignal?.addEventListener("abort", onAbort, { once: true });
			timeoutId = setTimeout(() => {
				settleReject(/* @__PURE__ */ new Error(`Matrix client did not reach a ready sync state within ${timeoutMs}ms`));
			}, timeoutMs);
			timeoutId.unref?.();
		});
	}
	async startSyncSession(opts) {
		if (this.started) return;
		throwIfMatrixStartupAborted(opts.abortSignal);
		await this.ensureCryptoSupportInitialized();
		throwIfMatrixStartupAborted(opts.abortSignal);
		this.registerBridge();
		await this.initializeCryptoIfNeeded(opts.abortSignal);
		await this.client.startClient({
			initialSyncLimit: this.initialSyncLimit,
			...this.syncFilter ? { filter: Filter.fromJson(this.selfUserId, "", this.syncFilter) } : {}
		});
		await this.waitForInitialSyncReady({
			abortSignal: opts.abortSignal,
			timeoutMs: opts.readyTimeoutMs
		});
		throwIfMatrixStartupAborted(opts.abortSignal);
		if (opts.bootstrapCrypto && this.autoBootstrapCrypto) await this.bootstrapCryptoIfNeeded(opts.abortSignal);
		throwIfMatrixStartupAborted(opts.abortSignal);
		this.started = true;
		this.emitOutstandingInviteEvents();
		await this.refreshDmCache().catch(noop);
	}
	async prepareForOneOff() {
		if (!this.encryptionEnabled) return;
		await this.ensureCryptoSupportInitialized();
		await this.initializeCryptoIfNeeded();
		if (!this.crypto) return;
		try {
			const joinedRooms = await this.getJoinedRooms();
			await this.crypto.prepare(joinedRooms);
		} catch {}
	}
	hasPersistedSyncState() {
		return this.syncStore?.hasSavedSyncFromCleanShutdown() === true;
	}
	async ensureStartedForCryptoControlPlane() {
		if (this.started) return;
		await this.startSyncSession({ bootstrapCrypto: false });
	}
	stopSyncWithoutPersist() {
		if (this.idbPersistTimer) {
			clearInterval(this.idbPersistTimer);
			this.idbPersistTimer = null;
		}
		this.currentSyncState = null;
		this.client.stopClient();
		this.started = false;
	}
	async drainPendingDecryptions(reason = "matrix client shutdown") {
		await this.decryptBridge?.drainPendingDecryptions(reason);
	}
	stop() {
		this.stopSyncWithoutPersist();
		this.decryptBridge?.stop();
		this.syncStore?.markCleanShutdown();
		if (loadedMatrixCryptoRuntime) {
			const { persistIdbToDisk } = loadedMatrixCryptoRuntime;
			this.stopPersistPromise = Promise.all([persistIdbToDisk({
				snapshotPath: this.idbSnapshotPath,
				databasePrefix: this.cryptoDatabasePrefix
			}).catch(noop), this.syncStore?.flush().catch(noop)]).then(() => void 0);
			return;
		}
		this.stopPersistPromise = loadMatrixCryptoRuntime().then(async ({ persistIdbToDisk }) => {
			await Promise.all([persistIdbToDisk({
				snapshotPath: this.idbSnapshotPath,
				databasePrefix: this.cryptoDatabasePrefix
			}).catch(noop), this.syncStore?.flush().catch(noop)]);
		}).catch(noop).then(() => void 0);
	}
	async stopAndPersist() {
		this.stop();
		await this.stopPersistPromise;
	}
	stopWithoutPersist() {
		this.stopSyncWithoutPersist();
		this.decryptBridge?.stop();
		this.stopPersistPromise = Promise.resolve();
	}
	async bootstrapCryptoIfNeeded(abortSignal) {
		if (!this.encryptionEnabled || !this.cryptoInitialized || this.cryptoBootstrapped) return;
		throwIfMatrixStartupAborted(abortSignal);
		await this.ensureCryptoSupportInitialized();
		const crypto = this.client.getCrypto();
		if (!crypto) return;
		const cryptoBootstrapper = this.cryptoBootstrapper;
		if (!cryptoBootstrapper) return;
		const initial = await cryptoBootstrapper.bootstrap(crypto, MATRIX_INITIAL_CRYPTO_BOOTSTRAP_OPTIONS);
		throwIfMatrixStartupAborted(abortSignal);
		if (!initial.crossSigningPublished || initial.ownDeviceVerified === false) if ((await this.getOwnDeviceVerificationStatus()).signedByOwner) LogService.warn("MatrixClientLite", "Cross-signing/bootstrap is incomplete for an already owner-signed device; skipping automatic reset and preserving the current identity. Restore the recovery key or run an explicit verification bootstrap if repair is needed.");
		else try {
			const repaired = await cryptoBootstrapper.bootstrap(crypto, MATRIX_AUTOMATIC_REPAIR_BOOTSTRAP_OPTIONS);
			throwIfMatrixStartupAborted(abortSignal);
			if (repaired.crossSigningPublished && repaired.ownDeviceVerified !== false) LogService.info("MatrixClientLite", "Cross-signing/bootstrap recovered after forced reset");
		} catch (err) {
			LogService.warn("MatrixClientLite", "Failed to recover cross-signing/bootstrap with forced reset:", err);
		}
		this.cryptoBootstrapped = true;
	}
	async initializeCryptoIfNeeded(abortSignal) {
		if (!this.encryptionEnabled || this.cryptoInitialized) return;
		throwIfMatrixStartupAborted(abortSignal);
		const { persistIdbToDisk, restoreIdbFromDisk } = await loadMatrixCryptoRuntime();
		await restoreIdbFromDisk(this.idbSnapshotPath);
		throwIfMatrixStartupAborted(abortSignal);
		try {
			await this.client.initRustCrypto({ cryptoDatabasePrefix: this.cryptoDatabasePrefix });
			this.cryptoInitialized = true;
			throwIfMatrixStartupAborted(abortSignal);
			await persistIdbToDisk({
				snapshotPath: this.idbSnapshotPath,
				databasePrefix: this.cryptoDatabasePrefix
			});
			throwIfMatrixStartupAborted(abortSignal);
			this.idbPersistTimer = setInterval(() => {
				persistIdbToDisk({
					snapshotPath: this.idbSnapshotPath,
					databasePrefix: this.cryptoDatabasePrefix
				}).catch(noop);
			}, MATRIX_IDB_PERSIST_INTERVAL_MS);
			this.idbPersistTimer.unref?.();
		} catch (err) {
			LogService.warn("MatrixClientLite", "Failed to initialize rust crypto:", err);
		}
	}
	async getUserId() {
		const fromClient = this.client.getUserId();
		if (fromClient) {
			this.selfUserId = fromClient;
			return fromClient;
		}
		if (this.selfUserId) return this.selfUserId;
		const resolved = (await this.doRequest("GET", "/_matrix/client/v3/account/whoami")).user_id?.trim();
		if (!resolved) throw new Error("Matrix whoami did not return user_id");
		this.selfUserId = resolved;
		return resolved;
	}
	async getJoinedRooms() {
		const joined = await this.doRequest("GET", "/_matrix/client/v3/joined_rooms");
		return Array.isArray(joined.joined_rooms) ? joined.joined_rooms : [];
	}
	async getJoinedRoomMembers(roomId) {
		const joined = (await this.client.getJoinedRoomMembers(roomId))?.joined;
		if (!joined || typeof joined !== "object") return [];
		return Object.keys(joined);
	}
	hasSyncedJoinedRoomMember(roomId, userId) {
		return (this.client.getRoom?.(roomId))?.currentState?.getMember?.(userId)?.membership === "join";
	}
	async getRoomStateEvent(roomId, eventType, stateKey = "") {
		return await this.client.getStateEvent(roomId, eventType, stateKey) ?? {};
	}
	async getAccountData(eventType) {
		return this.client.getAccountData(eventType)?.getContent() ?? void 0;
	}
	async setAccountData(eventType, content) {
		await this.client.setAccountData(eventType, content);
		await this.refreshDmCache().catch(noop);
	}
	async resolveRoom(aliasOrRoomId) {
		if (aliasOrRoomId.startsWith("!")) return aliasOrRoomId;
		if (!aliasOrRoomId.startsWith("#")) return aliasOrRoomId;
		try {
			return (await this.client.getRoomIdForAlias(aliasOrRoomId)).room_id ?? null;
		} catch {
			return null;
		}
	}
	async createDirectRoom(remoteUserId, opts = {}) {
		const initialState = opts.encrypted ? [{
			type: "m.room.encryption",
			state_key: "",
			content: { algorithm: "m.megolm.v1.aes-sha2" }
		}] : void 0;
		return (await this.client.createRoom({
			invite: [remoteUserId],
			is_direct: true,
			preset: Preset.TrustedPrivateChat,
			initial_state: initialState
		})).room_id;
	}
	async sendMessage(roomId, content) {
		return await this.runSerializedRoomSend(roomId, async () => {
			return (await this.client.sendMessage(roomId, content)).event_id;
		});
	}
	async sendEvent(roomId, eventType, content) {
		return await this.runSerializedRoomSend(roomId, async () => {
			return (await this.client.sendEvent(roomId, eventType, content)).event_id;
		});
	}
	async runSerializedRoomSend(roomId, task) {
		return await this.sendQueue.enqueue(roomId, task);
	}
	async sendStateEvent(roomId, eventType, stateKey, content) {
		return (await this.client.sendStateEvent(roomId, eventType, content, stateKey)).event_id;
	}
	async redactEvent(roomId, eventId, reason) {
		return (await this.client.redactEvent(roomId, eventId, void 0, reason?.trim() ? { reason } : void 0)).event_id;
	}
	async doRequest(method, endpoint, qs, body, opts) {
		return await this.httpClient.requestJson({
			method,
			endpoint,
			qs,
			body,
			timeoutMs: this.localTimeoutMs,
			allowAbsoluteEndpoint: opts?.allowAbsoluteEndpoint
		});
	}
	async getUserProfile(userId) {
		return await this.client.getProfileInfo(userId);
	}
	async setDisplayName(displayName) {
		await this.client.setDisplayName(displayName);
	}
	async setAvatarUrl(avatarUrl) {
		await this.client.setAvatarUrl(avatarUrl);
	}
	async joinRoom(roomId) {
		await this.client.joinRoom(roomId);
	}
	mxcToHttp(mxcUrl) {
		return this.client.mxcUrlToHttp(mxcUrl, void 0, void 0, void 0, true, false, true);
	}
	async downloadContent(mxcUrl, opts = {}) {
		const parsed = parseMxc(mxcUrl);
		if (!parsed) throw new Error(`Invalid Matrix content URI: ${mxcUrl}`);
		const encodedServer = encodeURIComponent(parsed.server);
		const encodedMediaId = encodeURIComponent(parsed.mediaId);
		const request = async (endpoint) => await this.httpClient.requestRaw({
			method: "GET",
			endpoint,
			qs: { allow_remote: opts.allowRemote ?? true },
			timeoutMs: this.localTimeoutMs,
			maxBytes: opts.maxBytes,
			readIdleTimeoutMs: opts.readIdleTimeoutMs
		});
		const authenticatedEndpoint = `/_matrix/client/v1/media/download/${encodedServer}/${encodedMediaId}`;
		try {
			return await request(authenticatedEndpoint);
		} catch (err) {
			if (!isUnsupportedAuthenticatedMediaEndpointError(err)) throw err;
		}
		return await request(`/_matrix/media/v3/download/${encodedServer}/${encodedMediaId}`);
	}
	async uploadContent(file, contentType, filename) {
		return (await this.client.uploadContent(new Uint8Array(file), {
			type: contentType || "application/octet-stream",
			name: filename,
			includeFilename: Boolean(filename)
		})).content_uri;
	}
	async getEvent(roomId, eventId) {
		const rawEvent = await this.client.fetchRoomEvent(roomId, eventId);
		if (rawEvent.type !== "m.room.encrypted") return rawEvent;
		const event = this.client.getEventMapper()(rawEvent);
		let decryptedEvent;
		const onDecrypted = (candidate) => {
			decryptedEvent = candidate;
		};
		event.once(MatrixEventEvent.Decrypted, onDecrypted);
		try {
			await this.client.decryptEventIfNeeded(event);
		} finally {
			event.off(MatrixEventEvent.Decrypted, onDecrypted);
		}
		return matrixEventToRaw(decryptedEvent ?? event);
	}
	async getRelations(roomId, eventId, relationType, eventType, opts = {}) {
		const result = await this.client.relations(roomId, eventId, relationType, eventType, opts);
		return {
			originalEvent: result.originalEvent ? matrixEventToRaw(result.originalEvent) : null,
			events: result.events.map((event) => matrixEventToRaw(event)),
			nextBatch: result.nextBatch ?? null,
			prevBatch: result.prevBatch ?? null
		};
	}
	async hydrateEvents(roomId, events) {
		if (events.length === 0) return [];
		const mapper = this.client.getEventMapper();
		const mappedEvents = events.map((event) => mapper({
			room_id: roomId,
			...event
		}));
		await Promise.all(mappedEvents.map((event) => this.client.decryptEventIfNeeded(event)));
		return mappedEvents.map((event) => matrixEventToRaw(event));
	}
	async setTyping(roomId, typing, timeoutMs) {
		await this.client.sendTyping(roomId, typing, timeoutMs);
	}
	async sendReadReceipt(roomId, eventId) {
		await this.httpClient.requestJson({
			method: "POST",
			endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
			body: {},
			timeoutMs: this.localTimeoutMs
		});
	}
	async getRoomKeyBackupStatus() {
		if (!this.encryptionEnabled) return {
			serverVersion: null,
			activeVersion: null,
			trusted: null,
			matchesDecryptionKey: null,
			decryptionKeyCached: null,
			keyLoadAttempted: false,
			keyLoadError: null
		};
		const crypto = this.client.getCrypto();
		const serverVersionFallback = await this.resolveRoomKeyBackupVersion();
		if (!crypto) return {
			serverVersion: serverVersionFallback,
			activeVersion: null,
			trusted: null,
			matchesDecryptionKey: null,
			decryptionKeyCached: null,
			keyLoadAttempted: false,
			keyLoadError: null
		};
		let { activeVersion, decryptionKeyCached } = await this.resolveRoomKeyBackupLocalState(crypto);
		let { serverVersion, trusted, matchesDecryptionKey } = await this.resolveRoomKeyBackupTrustState(crypto, serverVersionFallback);
		const shouldLoadBackupKey = Boolean(serverVersion) && (decryptionKeyCached === false || matchesDecryptionKey === false);
		const shouldActivateBackup = Boolean(serverVersion) && !activeVersion;
		let keyLoadAttempted = false;
		let keyLoadError = null;
		if (serverVersion && (shouldLoadBackupKey || shouldActivateBackup)) {
			if (shouldLoadBackupKey) if (typeof crypto.loadSessionBackupPrivateKeyFromSecretStorage === "function") {
				keyLoadAttempted = true;
				try {
					await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
				} catch (err) {
					keyLoadError = formatMatrixErrorMessage(err);
				}
			} else keyLoadError = "Matrix crypto backend does not support loading backup keys from secret storage";
			if (!keyLoadError) await this.enableTrustedRoomKeyBackupIfPossible(crypto);
			({activeVersion, decryptionKeyCached} = await this.resolveRoomKeyBackupLocalState(crypto));
			({serverVersion, trusted, matchesDecryptionKey} = await this.resolveRoomKeyBackupTrustState(crypto, serverVersion));
		}
		return {
			serverVersion,
			activeVersion,
			trusted,
			matchesDecryptionKey,
			decryptionKeyCached,
			keyLoadAttempted,
			keyLoadError
		};
	}
	async getDeviceVerificationStatus(userId, deviceId) {
		const normalizedUserId = userId?.trim() || null;
		const normalizedDeviceId = deviceId?.trim() || null;
		if (!this.encryptionEnabled) return {
			encryptionEnabled: false,
			userId: normalizedUserId,
			deviceId: normalizedDeviceId,
			verified: false,
			localVerified: false,
			crossSigningVerified: false,
			signedByOwner: false
		};
		const crypto = this.client.getCrypto();
		let deviceStatus = null;
		if (crypto && normalizedUserId && normalizedDeviceId && typeof crypto.getDeviceVerificationStatus === "function") deviceStatus = await crypto.getDeviceVerificationStatus(normalizedUserId, normalizedDeviceId).catch(() => null);
		const { isMatrixDeviceVerifiedInCurrentClient } = await loadMatrixCryptoRuntime();
		return {
			encryptionEnabled: true,
			userId: normalizedUserId,
			deviceId: normalizedDeviceId,
			verified: isMatrixDeviceVerifiedInCurrentClient(deviceStatus),
			localVerified: deviceStatus?.localVerified === true,
			crossSigningVerified: deviceStatus?.crossSigningVerified === true,
			signedByOwner: deviceStatus?.signedByOwner === true
		};
	}
	async getOwnDeviceVerificationStatus() {
		const recoveryKey = this.recoveryKeyStore.getRecoveryKeySummary();
		const userId = this.client.getUserId() ?? this.selfUserId ?? null;
		const deviceId = this.client.getDeviceId()?.trim() || null;
		const diagnosticTimeoutMs = Math.min(this.localTimeoutMs, MATRIX_STATUS_DIAGNOSTIC_TIMEOUT_MS);
		const [backup, deviceVerification, ownDevices] = await Promise.all([
			resolveMatrixDiagnostic(this.getRoomKeyBackupStatus(), diagnosticTimeoutMs),
			resolveMatrixDiagnostic(this.getDeviceVerificationStatus(userId, deviceId), diagnosticTimeoutMs),
			resolveMatrixDiagnosticResult(this.listOwnDevices(), diagnosticTimeoutMs)
		]);
		const resolvedBackup = backup ?? unresolvedMatrixRoomKeyBackupStatus();
		const resolvedDeviceVerification = deviceVerification ?? unresolvedMatrixDeviceVerificationStatus({
			userId,
			deviceId
		});
		const serverDeviceKnown = deviceId ? ownDevices.value ? ownDevices.value.some((device) => device.deviceId === deviceId) : isMatrixAccessTokenInvalidatedError(ownDevices.error) ? false : null : null;
		return {
			...resolvedDeviceVerification,
			verified: resolvedDeviceVerification.crossSigningVerified,
			recoveryKeyStored: Boolean(recoveryKey),
			recoveryKeyCreatedAt: recoveryKey?.createdAt ?? null,
			recoveryKeyId: recoveryKey?.keyId ?? null,
			backupVersion: resolvedBackup.serverVersion,
			backup: resolvedBackup,
			serverDeviceKnown
		};
	}
	async getOwnDeviceIdentityVerificationStatus() {
		const userId = this.client.getUserId() ?? this.selfUserId ?? null;
		const deviceId = this.client.getDeviceId()?.trim() || null;
		const deviceVerification = await this.getDeviceVerificationStatus(userId, deviceId);
		return {
			...deviceVerification,
			verified: deviceVerification.crossSigningVerified
		};
	}
	async trustOwnIdentityAfterSelfVerification() {
		if (!this.encryptionEnabled) return;
		await this.ensureStartedForCryptoControlPlane();
		await this.ensureCryptoSupportInitialized();
		const crypto = this.client.getCrypto();
		const ownIdentity = crypto && typeof crypto.getOwnIdentity === "function" ? await crypto.getOwnIdentity().catch(() => void 0) : void 0;
		if (!ownIdentity) return;
		try {
			if (typeof ownIdentity.isVerified === "function" && ownIdentity.isVerified()) return;
			if (typeof ownIdentity.verify !== "function") return;
			await ownIdentity.verify();
		} finally {
			ownIdentity.free?.();
		}
	}
	async verifyWithRecoveryKey(rawRecoveryKey) {
		const fail = async (error, fields = {}) => {
			const status = await this.getOwnDeviceVerificationStatus();
			return {
				success: false,
				recoveryKeyAccepted: fields.recoveryKeyAccepted ?? false,
				backupUsable: fields.backupUsable ?? false,
				deviceOwnerVerified: fields.deviceOwnerVerified ?? status.verified,
				error,
				...status
			};
		};
		if (!this.encryptionEnabled) return await fail("Matrix encryption is disabled for this client");
		await this.ensureStartedForCryptoControlPlane();
		await this.ensureCryptoSupportInitialized();
		const crypto = this.client.getCrypto();
		if (!crypto) return await fail("Matrix crypto is not available (start client with encryption enabled)");
		const backupUsableBeforeStagedRecovery = resolveMatrixRoomKeyBackupReadinessError(await this.getRoomKeyBackupStatus(), { requireServerBackup: true }) === null;
		const trimmedRecoveryKey = rawRecoveryKey.trim();
		if (!trimmedRecoveryKey) return await fail("Matrix recovery key is required");
		let stagedKeyId = null;
		try {
			stagedKeyId = await this.resolveDefaultSecretStorageKeyId(crypto) ?? null;
			this.recoveryKeyStore.stageEncodedRecoveryKey({
				encodedPrivateKey: trimmedRecoveryKey,
				keyId: stagedKeyId
			});
		} catch (err) {
			return await fail(formatMatrixErrorMessage(err));
		}
		const storedRecoveryKeyMatches = this.recoveryKeyStore.getRecoveryKeySummary()?.encodedPrivateKey?.trim() === trimmedRecoveryKey;
		if (backupUsableBeforeStagedRecovery && storedRecoveryKeyMatches) {
			const status = await this.getOwnDeviceVerificationStatus();
			const backupUsable = resolveMatrixRoomKeyBackupReadinessError(status.backup, { requireServerBackup: true }) === null;
			const backupError = resolveMatrixRoomKeyBackupReadinessError(status.backup, { requireServerBackup: false });
			const recoveryKeyAccepted = backupUsable;
			if (!status.verified) {
				if (recoveryKeyAccepted) this.recoveryKeyStore.commitStagedRecoveryKey({ keyId: stagedKeyId });
				else this.recoveryKeyStore.discardStagedRecoveryKey();
				return {
					success: false,
					recoveryKeyAccepted,
					backupUsable,
					deviceOwnerVerified: false,
					error: "Matrix recovery key was applied, but this device still lacks full Matrix identity trust. The recovery key can unlock usable backup material only when 'Backup usable' is yes; full identity trust still requires Matrix cross-signing verification.",
					...status
				};
			}
			if (backupError) {
				this.recoveryKeyStore.discardStagedRecoveryKey();
				return {
					success: false,
					recoveryKeyAccepted,
					backupUsable,
					deviceOwnerVerified: true,
					error: backupError,
					...status
				};
			}
			this.recoveryKeyStore.commitStagedRecoveryKey({ keyId: stagedKeyId });
			return {
				success: true,
				recoveryKeyAccepted: true,
				backupUsable,
				deviceOwnerVerified: true,
				verifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
				...status
			};
		}
		try {
			const cryptoBootstrapper = this.cryptoBootstrapper;
			if (!cryptoBootstrapper) return await fail("Matrix crypto bootstrapper is not available");
			await cryptoBootstrapper.bootstrap(crypto, { allowAutomaticCrossSigningReset: false });
			await this.enableTrustedRoomKeyBackupIfPossible(crypto);
			const status = await this.getOwnDeviceVerificationStatus();
			const backupError = resolveMatrixRoomKeyBackupReadinessError(status.backup, { requireServerBackup: false });
			const backupUsable = resolveMatrixRoomKeyBackupReadinessError(status.backup, { requireServerBackup: true }) === null;
			const stagedRecoveryKeyUsed = this.recoveryKeyStore.hasStagedRecoveryKeyBeenUsed();
			const secretStorageStatus = typeof crypto.getSecretStorageStatus === "function" ? await crypto.getSecretStorageStatus().catch(() => null) : null;
			const stagedRecoveryKeyConfirmedBySecretStorage = Boolean(stagedKeyId) && secretStorageStatus?.secretStorageKeyValidityMap?.[stagedKeyId ?? ""] === true;
			const stagedRecoveryKeyRejectedBySecretStorage = Boolean(stagedKeyId) && secretStorageStatus?.secretStorageKeyValidityMap?.[stagedKeyId ?? ""] === false;
			const stagedRecoveryKeyValidated = stagedRecoveryKeyUsed && (stagedRecoveryKeyConfirmedBySecretStorage || stagedRecoveryKeyUsed && !stagedRecoveryKeyRejectedBySecretStorage && !stagedRecoveryKeyConfirmedBySecretStorage && !backupUsableBeforeStagedRecovery && backupUsable) || storedRecoveryKeyMatches && backupUsable;
			const recoveryKeyAccepted = stagedRecoveryKeyValidated && (status.verified || backupUsable);
			if (!status.verified) {
				if (backupUsable && stagedRecoveryKeyValidated) this.recoveryKeyStore.commitStagedRecoveryKey({ keyId: stagedKeyId });
				else this.recoveryKeyStore.discardStagedRecoveryKey();
				return {
					success: false,
					recoveryKeyAccepted,
					backupUsable,
					deviceOwnerVerified: false,
					error: "Matrix recovery key was applied, but this device still lacks full Matrix identity trust. The recovery key can unlock usable backup material only when 'Backup usable' is yes; full identity trust still requires Matrix cross-signing verification.",
					...recoveryKeyAccepted ? await this.getOwnDeviceVerificationStatus() : status
				};
			}
			if (backupError) {
				this.recoveryKeyStore.discardStagedRecoveryKey();
				return {
					success: false,
					recoveryKeyAccepted,
					backupUsable,
					deviceOwnerVerified: true,
					error: backupError,
					...status
				};
			}
			if (!stagedRecoveryKeyValidated) {
				this.recoveryKeyStore.discardStagedRecoveryKey();
				return {
					success: false,
					recoveryKeyAccepted: false,
					backupUsable,
					deviceOwnerVerified: true,
					error: "Matrix recovery key could not be verified against active Matrix backup material; existing backup may be usable from previously loaded recovery material.",
					...status
				};
			}
			this.recoveryKeyStore.commitStagedRecoveryKey({ keyId: stagedKeyId });
			const committedStatus = await this.getOwnDeviceVerificationStatus();
			return {
				success: true,
				recoveryKeyAccepted: true,
				backupUsable,
				deviceOwnerVerified: true,
				verifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
				...committedStatus
			};
		} catch (err) {
			this.recoveryKeyStore.discardStagedRecoveryKey();
			return await fail(formatMatrixErrorMessage(err));
		}
	}
	async restoreRoomKeyBackup(params = {}) {
		let loadedFromSecretStorage = false;
		const fail = async (error) => {
			const backup = await this.getRoomKeyBackupStatus();
			return {
				success: false,
				error,
				backupVersion: backup.serverVersion,
				imported: 0,
				total: 0,
				loadedFromSecretStorage,
				backup
			};
		};
		if (!this.encryptionEnabled) return await fail("Matrix encryption is disabled for this client");
		await this.ensureStartedForCryptoControlPlane();
		const crypto = this.client.getCrypto();
		if (!crypto) return await fail("Matrix crypto is not available (start client with encryption enabled)");
		try {
			const rawRecoveryKey = params.recoveryKey?.trim();
			if (rawRecoveryKey) this.recoveryKeyStore.stageEncodedRecoveryKey({
				encodedPrivateKey: rawRecoveryKey,
				keyId: await this.resolveDefaultSecretStorageKeyId(crypto)
			});
			const backup = await this.getRoomKeyBackupStatus();
			loadedFromSecretStorage = backup.keyLoadAttempted && !backup.keyLoadError;
			const backupError = resolveMatrixRoomKeyBackupReadinessError(backup, {
				allowUntrustedMatchingKey: true,
				requireServerBackup: true
			});
			if (backupError) {
				this.recoveryKeyStore.discardStagedRecoveryKey();
				return await fail(backupError);
			}
			if (typeof crypto.restoreKeyBackup !== "function") {
				this.recoveryKeyStore.discardStagedRecoveryKey();
				return await fail("Matrix crypto backend does not support full key backup restore");
			}
			const restore = await crypto.restoreKeyBackup();
			if (rawRecoveryKey) this.recoveryKeyStore.commitStagedRecoveryKey({ keyId: await this.resolveDefaultSecretStorageKeyId(crypto) });
			const finalBackup = await this.getRoomKeyBackupStatus();
			return {
				success: true,
				backupVersion: backup.serverVersion,
				imported: typeof restore.imported === "number" ? restore.imported : 0,
				total: typeof restore.total === "number" ? restore.total : 0,
				loadedFromSecretStorage,
				restoredAt: (/* @__PURE__ */ new Date()).toISOString(),
				backup: finalBackup
			};
		} catch (err) {
			this.recoveryKeyStore.discardStagedRecoveryKey();
			return await fail(formatMatrixErrorMessage(err));
		}
	}
	async resetRoomKeyBackup(options = {}) {
		let previousVersion = null;
		let deletedVersion = null;
		const fail = async (error) => {
			const backup = await this.getRoomKeyBackupStatus();
			return {
				success: false,
				error,
				previousVersion,
				deletedVersion,
				createdVersion: backup.serverVersion,
				backup
			};
		};
		if (!this.encryptionEnabled) return await fail("Matrix encryption is disabled for this client");
		await this.ensureStartedForCryptoControlPlane();
		const crypto = this.client.getCrypto();
		if (!crypto) return await fail("Matrix crypto is not available (start client with encryption enabled)");
		previousVersion = await this.resolveRoomKeyBackupVersion();
		const forceNewSecretStorage = options.rotateRecoveryKey === true || await this.shouldForceSecretStorageRecreationForBackupReset(crypto);
		try {
			if (previousVersion) {
				try {
					await this.doRequest("DELETE", `/_matrix/client/v3/room_keys/version/${encodeURIComponent(previousVersion)}`);
				} catch (err) {
					if (!isMatrixNotFoundError(err)) throw err;
				}
				deletedVersion = previousVersion;
			}
			await this.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
				setupNewKeyBackup: true,
				forceNewSecretStorage,
				forceNewRecoveryKey: options.rotateRecoveryKey === true,
				allowSecretStorageRecreateWithoutRecoveryKey: true
			});
			await this.enableTrustedRoomKeyBackupIfPossible(crypto);
			const backup = await this.getRoomKeyBackupStatus();
			const createdVersion = backup.serverVersion;
			if (!createdVersion) return await fail("Matrix room key backup is still missing after reset.");
			if (backup.activeVersion !== createdVersion) return await fail("Matrix room key backup was recreated on the server but is not active on this device.");
			if (backup.decryptionKeyCached === false) return await fail("Matrix room key backup was recreated but its decryption key is not cached on this device.");
			if (backup.matchesDecryptionKey === false) return await fail("Matrix room key backup was recreated but this device does not have the matching backup decryption key.");
			if (backup.trusted === false) return await fail("Matrix room key backup was recreated but is not trusted on this device.");
			return {
				success: true,
				previousVersion,
				deletedVersion,
				createdVersion,
				resetAt: (/* @__PURE__ */ new Date()).toISOString(),
				backup
			};
		} catch (err) {
			return await fail(formatMatrixErrorMessage(err));
		}
	}
	async getOwnCrossSigningPublicationStatus() {
		const userId = this.client.getUserId() ?? this.selfUserId ?? null;
		if (!userId) return {
			userId: null,
			masterKeyPublished: false,
			selfSigningKeyPublished: false,
			userSigningKeyPublished: false,
			published: false
		};
		try {
			const response = await this.doRequest("POST", "/_matrix/client/v3/keys/query", void 0, { device_keys: { [userId]: [] } });
			const masterKeyPublished = Boolean(response.master_keys?.[userId]);
			const selfSigningKeyPublished = Boolean(response.self_signing_keys?.[userId]);
			const userSigningKeyPublished = Boolean(response.user_signing_keys?.[userId]);
			return {
				userId,
				masterKeyPublished,
				selfSigningKeyPublished,
				userSigningKeyPublished,
				published: masterKeyPublished && selfSigningKeyPublished && userSigningKeyPublished
			};
		} catch {
			return {
				userId,
				masterKeyPublished: false,
				selfSigningKeyPublished: false,
				userSigningKeyPublished: false,
				published: false
			};
		}
	}
	async bootstrapOwnDeviceVerification(params) {
		const pendingVerifications = async () => this.crypto ? (await this.crypto.listVerifications()).length : 0;
		if (!this.encryptionEnabled) return {
			success: false,
			error: "Matrix encryption is disabled for this client",
			verification: await this.getOwnDeviceVerificationStatus(),
			crossSigning: await this.getOwnCrossSigningPublicationStatus(),
			pendingVerifications: await pendingVerifications(),
			cryptoBootstrap: null
		};
		let bootstrapError;
		let bootstrapSummary = null;
		let rawRecoveryKey;
		try {
			await this.ensureStartedForCryptoControlPlane();
			await this.ensureCryptoSupportInitialized();
			const crypto = this.client.getCrypto();
			if (!crypto) throw new Error("Matrix crypto is not available (start client with encryption enabled)");
			rawRecoveryKey = params?.recoveryKey?.trim();
			if (rawRecoveryKey) this.recoveryKeyStore.stageEncodedRecoveryKey({
				encodedPrivateKey: rawRecoveryKey,
				keyId: await this.resolveDefaultSecretStorageKeyId(crypto)
			});
			const cryptoBootstrapper = this.cryptoBootstrapper;
			if (!cryptoBootstrapper) throw new Error("Matrix crypto bootstrapper is not available");
			bootstrapSummary = await cryptoBootstrapper.bootstrap(crypto, createMatrixExplicitBootstrapOptions({
				...params,
				allowAutomaticCrossSigningReset: rawRecoveryKey ? false : params?.allowAutomaticCrossSigningReset
			}));
			await this.ensureRoomKeyBackupEnabled(crypto);
		} catch (err) {
			this.recoveryKeyStore.discardStagedRecoveryKey();
			bootstrapError = formatMatrixErrorMessage(err);
		}
		const verification = await this.getOwnDeviceVerificationStatus();
		const crossSigning = await this.getOwnCrossSigningPublicationStatus();
		const verificationError = verification.verified && crossSigning.published ? null : bootstrapError ?? "Matrix verification bootstrap did not produce a device verified by its owner with published cross-signing keys";
		const backupError = verificationError === null ? resolveMatrixRoomKeyBackupReadinessError(verification.backup, {
			allowUntrustedMatchingKey: Boolean(rawRecoveryKey),
			requireServerBackup: true
		}) : null;
		const success = verificationError === null && backupError === null;
		if (success) this.recoveryKeyStore.commitStagedRecoveryKey({ keyId: await this.resolveDefaultSecretStorageKeyId(this.client.getCrypto()) });
		else this.recoveryKeyStore.discardStagedRecoveryKey();
		return {
			success,
			error: success ? void 0 : backupError ?? verificationError ?? void 0,
			verification: success ? await this.getOwnDeviceVerificationStatus() : verification,
			crossSigning,
			pendingVerifications: await pendingVerifications(),
			cryptoBootstrap: bootstrapSummary
		};
	}
	async listOwnDevices() {
		const currentDeviceId = this.client.getDeviceId()?.trim() || null;
		const devices = await this.client.getDevices();
		return (Array.isArray(devices?.devices) ? devices.devices : []).map((device) => ({
			deviceId: device.device_id,
			displayName: device.display_name?.trim() || null,
			lastSeenIp: device.last_seen_ip?.trim() || null,
			lastSeenTs: typeof device.last_seen_ts === "number" && Number.isFinite(device.last_seen_ts) ? device.last_seen_ts : null,
			current: currentDeviceId !== null && device.device_id === currentDeviceId
		}));
	}
	async deleteOwnDevices(deviceIds) {
		const uniqueDeviceIds = [...new Set(deviceIds.map((value) => value.trim()).filter(Boolean))];
		const currentDeviceId = this.client.getDeviceId()?.trim() || null;
		const protectedDeviceIds = uniqueDeviceIds.filter((deviceId) => deviceId === currentDeviceId);
		if (protectedDeviceIds.length > 0) throw new Error(`Refusing to delete the current Matrix device: ${protectedDeviceIds[0]}`);
		const deleteWithAuth = async (authData) => {
			await this.client.deleteMultipleDevices(uniqueDeviceIds, authData);
		};
		if (uniqueDeviceIds.length > 0) try {
			await deleteWithAuth();
		} catch (err) {
			const session = err && typeof err === "object" && "data" in err && err.data && typeof err.data === "object" && "session" in err.data && typeof err.data.session === "string" ? err.data.session : null;
			const userId = await this.getUserId().catch(() => this.selfUserId);
			if (!session || !userId || !this.password?.trim()) throw err;
			await deleteWithAuth({
				type: "m.login.password",
				session,
				identifier: {
					type: "m.id.user",
					user: userId
				},
				password: this.password
			});
		}
		return {
			currentDeviceId,
			deletedDeviceIds: uniqueDeviceIds,
			remainingDevices: await this.listOwnDevices()
		};
	}
	async resolveActiveRoomKeyBackupVersion(crypto) {
		if (typeof crypto.getActiveSessionBackupVersion !== "function") return null;
		return normalizeOptionalString(await crypto.getActiveSessionBackupVersion().catch(() => null));
	}
	async resolveCachedRoomKeyBackupDecryptionKey(crypto) {
		const getSessionBackupPrivateKey = crypto.getSessionBackupPrivateKey;
		if (typeof getSessionBackupPrivateKey !== "function") return null;
		const key = await getSessionBackupPrivateKey.call(crypto).catch(() => null);
		return key ? key.length > 0 : false;
	}
	async resolveRoomKeyBackupLocalState(crypto) {
		const [activeVersion, decryptionKeyCached] = await Promise.all([this.resolveActiveRoomKeyBackupVersion(crypto), this.resolveCachedRoomKeyBackupDecryptionKey(crypto)]);
		return {
			activeVersion,
			decryptionKeyCached
		};
	}
	async shouldForceSecretStorageRecreationForBackupReset(crypto) {
		if (await this.resolveCachedRoomKeyBackupDecryptionKey(crypto) !== false) return false;
		const loadSessionBackupPrivateKeyFromSecretStorage = crypto.loadSessionBackupPrivateKeyFromSecretStorage;
		if (typeof loadSessionBackupPrivateKeyFromSecretStorage !== "function") return false;
		try {
			await loadSessionBackupPrivateKeyFromSecretStorage.call(crypto);
			return false;
		} catch (err) {
			return isRepairableSecretStorageAccessError(err);
		}
	}
	async resolveRoomKeyBackupTrustState(crypto, fallbackVersion) {
		let serverVersion = fallbackVersion;
		let trusted = null;
		let matchesDecryptionKey = null;
		if (typeof crypto.getKeyBackupInfo === "function") {
			const info = await crypto.getKeyBackupInfo().catch(() => null);
			serverVersion = normalizeOptionalString(info?.version) ?? serverVersion;
			if (info && typeof crypto.isKeyBackupTrusted === "function") {
				const trustInfo = await crypto.isKeyBackupTrusted(info).catch(() => null);
				trusted = typeof trustInfo?.trusted === "boolean" ? trustInfo.trusted : null;
				matchesDecryptionKey = typeof trustInfo?.matchesDecryptionKey === "boolean" ? trustInfo.matchesDecryptionKey : null;
			}
		}
		return {
			serverVersion,
			trusted,
			matchesDecryptionKey
		};
	}
	async resolveDefaultSecretStorageKeyId(crypto) {
		const getSecretStorageStatus = crypto?.getSecretStorageStatus;
		if (typeof getSecretStorageStatus !== "function") return;
		return (await getSecretStorageStatus.call(crypto).catch(() => null))?.defaultKeyId;
	}
	async resolveRoomKeyBackupVersion() {
		try {
			return normalizeOptionalString((await this.doRequest("GET", "/_matrix/client/v3/room_keys/version")).version);
		} catch {
			return null;
		}
	}
	async enableTrustedRoomKeyBackupIfPossible(crypto) {
		if (typeof crypto.checkKeyBackupAndEnable !== "function") return;
		await crypto.checkKeyBackupAndEnable();
	}
	async ensureRoomKeyBackupEnabled(crypto) {
		if (await this.resolveRoomKeyBackupVersion()) return;
		LogService.info("MatrixClientLite", "No room key backup version found on server, creating one via secret storage bootstrap");
		await this.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, { setupNewKeyBackup: true });
		const createdVersion = await this.resolveRoomKeyBackupVersion();
		if (!createdVersion) throw new Error("Matrix room key backup is still missing after bootstrap");
		LogService.info("MatrixClientLite", `Room key backup enabled (version ${createdVersion})`);
	}
	registerBridge() {
		if (this.bridgeRegistered || !this.decryptBridge) return;
		this.bridgeRegistered = true;
		const decryptBridge = this.decryptBridge;
		this.client.on(ClientEvent.Event, (event) => {
			const roomId = event.getRoomId();
			if (!roomId) return;
			const raw = matrixEventToRaw(event, { contentMode: "original" });
			const isEncryptedEvent = raw.type === "m.room.encrypted";
			this.emitter.emit("room.event", roomId, raw);
			if (isEncryptedEvent) this.emitter.emit("room.encrypted_event", roomId, raw);
			else if (decryptBridge.shouldEmitUnencryptedMessage(roomId, raw.event_id)) this.emitter.emit("room.message", roomId, raw);
			const stateKey = raw.state_key ?? "";
			const selfUserId = this.client.getUserId() ?? this.selfUserId ?? "";
			const membership = raw.type === "m.room.member" ? raw.content.membership : void 0;
			if (stateKey && selfUserId && stateKey === selfUserId) {
				if (membership === "invite") this.emitter.emit("room.invite", roomId, raw);
				else if (membership === "join") this.emitter.emit("room.join", roomId, raw);
			}
			if (isEncryptedEvent) decryptBridge.attachEncryptedEvent(event, roomId);
		});
		this.client.on(ClientEvent.Room, (room) => {
			this.emitMembershipForRoom(room);
		});
		this.client.on(ClientEvent.Sync, (state, prevState, data) => {
			this.currentSyncState = state;
			const error = data && typeof data === "object" && "error" in data ? data.error : void 0;
			this.emitter.emit("sync.state", state, prevState, error);
		});
		this.client.on(ClientEvent.SyncUnexpectedError, (error) => {
			this.emitter.emit("sync.unexpected_error", error);
		});
	}
	emitMembershipForRoom(room) {
		const roomObj = room;
		const roomId = roomObj.roomId?.trim();
		if (!roomId) return;
		const membership = roomObj.getMyMembership?.() ?? roomObj.selfMembership ?? void 0;
		const selfUserId = this.client.getUserId() ?? this.selfUserId ?? "";
		if (!selfUserId) return;
		const raw = {
			event_id: `$membership-${roomId}-${Date.now()}`,
			type: "m.room.member",
			sender: selfUserId,
			state_key: selfUserId,
			content: { membership },
			origin_server_ts: Date.now(),
			unsigned: { age: 0 }
		};
		if (membership === "invite") {
			this.emitter.emit("room.invite", roomId, raw);
			return;
		}
		if (membership === "join") this.emitter.emit("room.join", roomId, raw);
	}
	emitOutstandingInviteEvents() {
		const listRooms = this.client.getRooms;
		if (typeof listRooms !== "function") return;
		const rooms = listRooms.call(this.client);
		if (!Array.isArray(rooms)) return;
		for (const room of rooms) this.emitMembershipForRoom(room);
	}
	async refreshDmCache() {
		const direct = await this.getAccountData("m.direct");
		this.dmRoomIds.clear();
		if (!direct || typeof direct !== "object") return false;
		for (const value of Object.values(direct)) {
			if (!Array.isArray(value)) continue;
			for (const roomId of value) if (typeof roomId === "string" && roomId.trim()) this.dmRoomIds.add(roomId);
		}
		return true;
	}
};
//#endregion
export { MatrixClient as t };
