import { n as PinnedDispatcherPolicy, o as SsrFPolicy } from "./ssrf-skjEI_i5.js";
import { IFilterDefinition } from "matrix-js-sdk/lib/matrix.js";

//#region extensions/matrix/src/matrix/sync-state.d.ts
type MatrixSyncState = "PREPARED" | "SYNCING" | "CATCHUP" | "RECONNECTING" | "ERROR" | "STOPPED" | (string & {});
//#endregion
//#region extensions/matrix/src/matrix/sdk/verification-manager.d.ts
type MatrixVerificationMethod = "sas" | "show-qr" | "scan-qr";
type MatrixVerificationSummary = {
  id: string;
  transactionId?: string;
  roomId?: string;
  otherUserId: string;
  otherDeviceId?: string;
  isSelfVerification: boolean;
  initiatedByMe: boolean;
  phase: number;
  phaseName: string;
  pending: boolean;
  methods: string[];
  chosenMethod?: string | null;
  canAccept: boolean;
  hasSas: boolean;
  sas?: {
    decimal?: [number, number, number];
    emoji?: Array<[string, string]>;
  };
  hasReciprocateQr: boolean;
  completed: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
//#endregion
//#region extensions/matrix/src/matrix/sdk/types.d.ts
type MatrixRawEvent = {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: {
    age?: number;
    "m.relations"?: Record<string, unknown>;
    redacted_because?: unknown;
  };
  state_key?: string;
};
type MatrixRelationsPage = {
  originalEvent?: MatrixRawEvent | null;
  events: MatrixRawEvent[];
  nextBatch?: string | null;
  prevBatch?: string | null;
};
type MatrixClientEventMap = {
  "room.event": [roomId: string, event: MatrixRawEvent];
  "room.message": [roomId: string, event: MatrixRawEvent];
  "room.encrypted_event": [roomId: string, event: MatrixRawEvent];
  "room.decrypted_event": [roomId: string, event: MatrixRawEvent];
  "room.failed_decryption": [roomId: string, event: MatrixRawEvent, error: Error];
  "room.invite": [roomId: string, event: MatrixRawEvent];
  "room.join": [roomId: string, event: MatrixRawEvent];
  "sync.state": [state: MatrixSyncState, prevState: string | null, error?: unknown];
  "sync.unexpected_error": [error: Error];
  "verification.summary": [summary: MatrixVerificationSummary];
};
type EncryptedFile = {
  url: string;
  key: {
    kty: string;
    key_ops: string[];
    alg: string;
    k: string;
    ext: boolean;
  };
  iv: string;
  hashes: Record<string, string>;
  v: string;
};
type MessageEventContent = {
  msgtype?: string;
  body?: string;
  format?: string;
  formatted_body?: string;
  filename?: string;
  url?: string;
  file?: EncryptedFile;
  info?: Record<string, unknown>;
  "m.relates_to"?: Record<string, unknown>;
  "m.new_content"?: unknown;
  "m.mentions"?: {
    user_ids?: string[];
    room?: boolean;
  };
  [key: string]: unknown;
};
//#endregion
//#region extensions/matrix/src/matrix/sdk/crypto-bootstrap.d.ts
type MatrixCryptoBootstrapResult = {
  crossSigningReady: boolean;
  crossSigningPublished: boolean;
  ownDeviceVerified: boolean | null;
};
//#endregion
//#region extensions/matrix/src/matrix/sdk/crypto-facade.d.ts
type MatrixCryptoFacade = {
  prepare: (joinedRooms: string[]) => Promise<void>;
  updateSyncData: (toDeviceMessages: unknown, otkCounts: unknown, unusedFallbackKeyAlgs: unknown, changedDeviceLists: unknown, leftDeviceLists: unknown) => Promise<void>;
  isRoomEncrypted: (roomId: string) => Promise<boolean>;
  requestOwnUserVerification: () => Promise<MatrixVerificationSummary | null>;
  encryptMedia: (buffer: Buffer) => Promise<{
    buffer: Buffer;
    file: Omit<EncryptedFile, "url">;
  }>;
  decryptMedia: (file: EncryptedFile, opts?: {
    maxBytes?: number;
    readIdleTimeoutMs?: number;
  }) => Promise<Buffer>;
  getRecoveryKey: () => Promise<{
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } | null>;
  listVerifications: () => Promise<MatrixVerificationSummary[]>;
  ensureVerificationDmTracked: (params: {
    roomId: string;
    userId: string;
  }) => Promise<MatrixVerificationSummary | null>;
  requestVerification: (params: {
    ownUser?: boolean;
    userId?: string;
    deviceId?: string;
    roomId?: string;
  }) => Promise<MatrixVerificationSummary>;
  acceptVerification: (id: string) => Promise<MatrixVerificationSummary>;
  cancelVerification: (id: string, params?: {
    reason?: string;
    code?: string;
  }) => Promise<MatrixVerificationSummary>;
  startVerification: (id: string, method?: MatrixVerificationMethod) => Promise<MatrixVerificationSummary>;
  generateVerificationQr: (id: string) => Promise<{
    qrDataBase64: string;
  }>;
  scanVerificationQr: (id: string, qrDataBase64: string) => Promise<MatrixVerificationSummary>;
  confirmVerificationSas: (id: string) => Promise<MatrixVerificationSummary>;
  mismatchVerificationSas: (id: string) => Promise<MatrixVerificationSummary>;
  confirmVerificationReciprocateQr: (id: string) => Promise<MatrixVerificationSummary>;
  getVerificationSas: (id: string) => Promise<{
    decimal?: [number, number, number];
    emoji?: Array<[string, string]>;
  }>;
};
//#endregion
//#region extensions/matrix/src/matrix/sdk/transport.d.ts
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean | null | undefined>;
type QueryParams = Record<string, QueryValue> | null | undefined;
//#endregion
//#region extensions/matrix/src/matrix/sdk.d.ts
type MatrixOwnDeviceVerificationStatus = {
  encryptionEnabled: boolean;
  userId: string | null;
  deviceId: string | null;
  verified: boolean;
  localVerified: boolean;
  crossSigningVerified: boolean;
  signedByOwner: boolean;
  recoveryKeyStored: boolean;
  recoveryKeyCreatedAt: string | null;
  recoveryKeyId: string | null;
  backupVersion: string | null;
  backup: MatrixRoomKeyBackupStatus;
  serverDeviceKnown: boolean | null;
};
type MatrixDeviceVerificationStatus = {
  encryptionEnabled: boolean;
  userId: string | null;
  deviceId: string | null;
  verified: boolean;
  localVerified: boolean;
  crossSigningVerified: boolean;
  signedByOwner: boolean;
};
type MatrixRoomKeyBackupStatus = {
  serverVersion: string | null;
  activeVersion: string | null;
  trusted: boolean | null;
  matchesDecryptionKey: boolean | null;
  decryptionKeyCached: boolean | null;
  keyLoadAttempted: boolean;
  keyLoadError: string | null;
};
type MatrixRoomKeyBackupRestoreResult = {
  success: boolean;
  error?: string;
  backupVersion: string | null;
  imported: number;
  total: number;
  loadedFromSecretStorage: boolean;
  restoredAt?: string;
  backup: MatrixRoomKeyBackupStatus;
};
type MatrixRoomKeyBackupResetResult = {
  success: boolean;
  error?: string;
  previousVersion: string | null;
  deletedVersion: string | null;
  createdVersion: string | null;
  resetAt?: string;
  backup: MatrixRoomKeyBackupStatus;
};
type MatrixRecoveryKeyVerificationResult = MatrixOwnDeviceVerificationStatus & {
  success: boolean;
  recoveryKeyAccepted: boolean;
  backupUsable: boolean;
  deviceOwnerVerified: boolean;
  verifiedAt?: string;
  error?: string;
};
type MatrixOwnCrossSigningPublicationStatus = {
  userId: string | null;
  masterKeyPublished: boolean;
  selfSigningKeyPublished: boolean;
  userSigningKeyPublished: boolean;
  published: boolean;
};
type MatrixVerificationBootstrapResult = {
  success: boolean;
  error?: string;
  verification: MatrixOwnDeviceVerificationStatus;
  crossSigning: MatrixOwnCrossSigningPublicationStatus;
  pendingVerifications: number;
  cryptoBootstrap: MatrixCryptoBootstrapResult | null;
};
type MatrixOwnDeviceInfo = {
  deviceId: string;
  displayName: string | null;
  lastSeenIp: string | null;
  lastSeenTs: number | null;
  current: boolean;
};
type MatrixRoomKeyBackupResetOptions = {
  rotateRecoveryKey?: boolean;
};
type MatrixOwnDeviceDeleteResult = {
  currentDeviceId: string | null;
  deletedDeviceIds: string[];
  remainingDevices: MatrixOwnDeviceInfo[];
};
declare class MatrixClient {
  private readonly client;
  private readonly emitter;
  private readonly httpClient;
  private readonly localTimeoutMs;
  private readonly initialSyncLimit?;
  private readonly syncFilter?;
  private readonly encryptionEnabled;
  private readonly password?;
  private readonly syncStore?;
  private readonly idbSnapshotPath?;
  private readonly cryptoDatabasePrefix?;
  private bridgeRegistered;
  private started;
  private cryptoBootstrapped;
  private selfUserId;
  private readonly dmRoomIds;
  private cryptoInitialized;
  private decryptBridge?;
  private verificationManager?;
  private readonly sendQueue;
  private readonly recoveryKeyStore;
  private cryptoBootstrapper?;
  private readonly autoBootstrapCrypto;
  private stopPersistPromise;
  private verificationSummaryListenerBound;
  private currentSyncState;
  readonly dms: {
    update: () => Promise<boolean>;
    isDm: (roomId: string) => boolean;
  };
  crypto?: MatrixCryptoFacade;
  constructor(homeserver: string, accessToken: string, opts?: {
    userId?: string;
    password?: string;
    deviceId?: string;
    localTimeoutMs?: number;
    encryption?: boolean;
    initialSyncLimit?: number;
    syncFilter?: IFilterDefinition;
    storagePath?: string;
    recoveryKeyPath?: string;
    idbSnapshotPath?: string;
    cryptoDatabasePrefix?: string;
    autoBootstrapCrypto?: boolean;
    ssrfPolicy?: SsrFPolicy;
    dispatcherPolicy?: PinnedDispatcherPolicy;
  });
  on<TEvent extends keyof MatrixClientEventMap>(eventName: TEvent, listener: (...args: MatrixClientEventMap[TEvent]) => void): this;
  on(eventName: string, listener: (...args: unknown[]) => void): this;
  off<TEvent extends keyof MatrixClientEventMap>(eventName: TEvent, listener: (...args: MatrixClientEventMap[TEvent]) => void): this;
  off(eventName: string, listener: (...args: unknown[]) => void): this;
  private idbPersistTimer;
  private ensureCryptoSupportInitialized;
  start(opts?: {
    abortSignal?: AbortSignal;
    readyTimeoutMs?: number;
  }): Promise<void>;
  private waitForInitialSyncReady;
  private startSyncSession;
  prepareForOneOff(): Promise<void>;
  hasPersistedSyncState(): boolean;
  private ensureStartedForCryptoControlPlane;
  stopSyncWithoutPersist(): void;
  drainPendingDecryptions(reason?: string): Promise<void>;
  stop(): void;
  stopAndPersist(): Promise<void>;
  stopWithoutPersist(): void;
  private bootstrapCryptoIfNeeded;
  private initializeCryptoIfNeeded;
  getUserId(): Promise<string>;
  getJoinedRooms(): Promise<string[]>;
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
  hasSyncedJoinedRoomMember(roomId: string, userId: string): boolean;
  getRoomStateEvent(roomId: string, eventType: string, stateKey?: string): Promise<Record<string, unknown>>;
  getAccountData(eventType: string): Promise<Record<string, unknown> | undefined>;
  setAccountData(eventType: string, content: Record<string, unknown>): Promise<void>;
  resolveRoom(aliasOrRoomId: string): Promise<string | null>;
  createDirectRoom(remoteUserId: string, opts?: {
    encrypted?: boolean;
  }): Promise<string>;
  sendMessage(roomId: string, content: MessageEventContent): Promise<string>;
  sendEvent(roomId: string, eventType: string, content: Record<string, unknown>): Promise<string>;
  private runSerializedRoomSend;
  sendStateEvent(roomId: string, eventType: string, stateKey: string, content: Record<string, unknown>): Promise<string>;
  redactEvent(roomId: string, eventId: string, reason?: string): Promise<string>;
  doRequest(method: HttpMethod, endpoint: string, qs?: QueryParams, body?: unknown, opts?: {
    allowAbsoluteEndpoint?: boolean;
  }): Promise<unknown>;
  getUserProfile(userId: string): Promise<{
    displayname?: string;
    avatar_url?: string;
  }>;
  setDisplayName(displayName: string): Promise<void>;
  setAvatarUrl(avatarUrl: string): Promise<void>;
  joinRoom(roomId: string): Promise<void>;
  mxcToHttp(mxcUrl: string): string | null;
  downloadContent(mxcUrl: string, opts?: {
    allowRemote?: boolean;
    maxBytes?: number;
    readIdleTimeoutMs?: number;
  }): Promise<Buffer>;
  uploadContent(file: Buffer, contentType?: string, filename?: string): Promise<string>;
  getEvent(roomId: string, eventId: string): Promise<Record<string, unknown>>;
  getRelations(roomId: string, eventId: string, relationType: string | null, eventType?: string | null, opts?: {
    from?: string;
  }): Promise<MatrixRelationsPage>;
  hydrateEvents(roomId: string, events: Array<Record<string, unknown>>): Promise<MatrixRawEvent[]>;
  setTyping(roomId: string, typing: boolean, timeoutMs: number): Promise<void>;
  sendReadReceipt(roomId: string, eventId: string): Promise<void>;
  getRoomKeyBackupStatus(): Promise<MatrixRoomKeyBackupStatus>;
  getDeviceVerificationStatus(userId: string | null | undefined, deviceId: string | null | undefined): Promise<MatrixDeviceVerificationStatus>;
  getOwnDeviceVerificationStatus(): Promise<MatrixOwnDeviceVerificationStatus>;
  getOwnDeviceIdentityVerificationStatus(): Promise<MatrixDeviceVerificationStatus>;
  trustOwnIdentityAfterSelfVerification(): Promise<void>;
  verifyWithRecoveryKey(rawRecoveryKey: string): Promise<MatrixRecoveryKeyVerificationResult>;
  restoreRoomKeyBackup(params?: {
    recoveryKey?: string;
  }): Promise<MatrixRoomKeyBackupRestoreResult>;
  resetRoomKeyBackup(options?: MatrixRoomKeyBackupResetOptions): Promise<MatrixRoomKeyBackupResetResult>;
  getOwnCrossSigningPublicationStatus(): Promise<MatrixOwnCrossSigningPublicationStatus>;
  bootstrapOwnDeviceVerification(params?: {
    allowAutomaticCrossSigningReset?: boolean;
    recoveryKey?: string;
    forceResetCrossSigning?: boolean;
    strict?: boolean;
  }): Promise<MatrixVerificationBootstrapResult>;
  listOwnDevices(): Promise<MatrixOwnDeviceInfo[]>;
  deleteOwnDevices(deviceIds: string[]): Promise<MatrixOwnDeviceDeleteResult>;
  private resolveActiveRoomKeyBackupVersion;
  private resolveCachedRoomKeyBackupDecryptionKey;
  private resolveRoomKeyBackupLocalState;
  private shouldForceSecretStorageRecreationForBackupReset;
  private resolveRoomKeyBackupTrustState;
  private resolveDefaultSecretStorageKeyId;
  private resolveRoomKeyBackupVersion;
  private enableTrustedRoomKeyBackupIfPossible;
  private ensureRoomKeyBackupEnabled;
  private registerBridge;
  private emitMembershipForRoom;
  private emitOutstandingInviteEvents;
  private refreshDmCache;
}
//#endregion
export { MatrixOwnDeviceVerificationStatus as a, MatrixRoomKeyBackupRestoreResult as c, EncryptedFile as d, MatrixRawEvent as f, MatrixVerificationSummary as h, MatrixOwnDeviceInfo as i, MatrixRoomKeyBackupStatus as l, MatrixVerificationMethod as m, MatrixDeviceVerificationStatus as n, MatrixRecoveryKeyVerificationResult as o, MessageEventContent as p, MatrixOwnDeviceDeleteResult as r, MatrixRoomKeyBackupResetResult as s, MatrixClient as t, MatrixVerificationBootstrapResult as u };