import type { MatrixSyncState } from "../sync-state.js";
import type {
  MatrixVerificationRequestLike,
  MatrixVerificationSummary,
} from "./verification-manager.js";

export type MatrixRawEvent = {
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

export type MatrixRelationsPage = {
  originalEvent?: MatrixRawEvent | null;
  events: MatrixRawEvent[];
  nextBatch?: string | null;
  prevBatch?: string | null;
};

export type MatrixClientEventMap = {
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

export type EncryptedFile = {
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

export type FileWithThumbnailInfo = {
  size?: number;
  mimetype?: string;
  thumbnail_url?: string;
  thumbnail_file?: EncryptedFile;
  thumbnail_info?: {
    w?: number;
    h?: number;
    mimetype?: string;
    size?: number;
  };
};

export type DimensionalFileInfo = FileWithThumbnailInfo & {
  w?: number;
  h?: number;
};

export type TimedFileInfo = FileWithThumbnailInfo & {
  duration?: number;
};

export type VideoFileInfo = DimensionalFileInfo &
  TimedFileInfo & {
    duration?: number;
  };

export type MessageEventContent = {
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

export type TextualMessageEventContent = MessageEventContent & {
  msgtype: string;
  body: string;
};

export type LocationMessageEventContent = MessageEventContent & {
  msgtype?: string;
  geo_uri?: string;
};

export type MatrixSecretStorageStatus = {
  ready: boolean;
  defaultKeyId: string | null;
  secretStorageKeyValidityMap?: Record<string, boolean>;
};

export type MatrixGeneratedSecretStorageKey = {
  keyId?: string | null;
  keyInfo?: {
    passphrase?: unknown;
    name?: string;
  };
  privateKey: Uint8Array;
  encodedPrivateKey?: string;
};

export type MatrixDeviceVerificationStatusLike = {
  isVerified?: () => boolean;
  localVerified?: boolean;
  crossSigningVerified?: boolean;
  signedByOwner?: boolean;
};

export type MatrixKeyBackupInfo = {
  algorithm: string;
  auth_data: Record<string, unknown>;
  count?: number;
  etag?: string;
  version?: string;
};

export type MatrixKeyBackupTrustInfo = {
  trusted: boolean;
  matchesDecryptionKey: boolean;
};

export type MatrixRoomKeyBackupRestoreResult = {
  total: number;
  imported: number;
};

export type MatrixImportRoomKeyProgress = {
  stage: string;
  successes?: number;
  failures?: number;
  total?: number;
};

export type MatrixSecretStorageKeyDescription = {
  passphrase?: unknown;
  name?: string;
  [key: string]: unknown;
};

export type MatrixCryptoCallbacks = {
  getSecretStorageKey?: (
    params: { keys: Record<string, MatrixSecretStorageKeyDescription> },
    name: string,
  ) => Promise<[string, Uint8Array] | null>;
  cacheSecretStorageKey?: (
    keyId: string,
    keyInfo: MatrixSecretStorageKeyDescription,
    key: Uint8Array,
  ) => void;
};

export type MatrixStoredRecoveryKey = {
  version: 1;
  createdAt: string;
  keyId?: string | null;
  encodedPrivateKey?: string;
  privateKeyBase64: string;
  keyInfo?: {
    passphrase?: unknown;
    name?: string;
  };
};

export type MatrixAuthDict = Record<string, unknown>;

export type MatrixUiAuthCallback = <T>(
  makeRequest: (authData: MatrixAuthDict | null) => Promise<T>,
) => Promise<T>;

export type MatrixHomeserverCapabilities = {
  msAuthService?: boolean;
  // MSC2965 account management URI advertised by MAS in /_matrix/client/v1/auth_metadata.
  // Clients construct action URLs as `${accountManagementUri}?action=<action>` per
  // account_management_actions_supported (see Matrix spec 1.13 §6.4.4).
  accountManagementUri?: string;
};

export type MatrixUiaResponseBody = {
  flows?: Array<{ stages?: string[] }>;
  session?: string;
  params?: Record<string, Record<string, unknown> | undefined>;
  completed?: string[];
};

// Thrown when the homeserver requires interactive cross-signing reset that
// only a human in a browser can satisfy (Matrix Authentication Service).
// Surfaces the operator-facing reset URL when the server advertises one.
export class MatrixCrossSigningResetRequiredError extends Error {
  readonly stages: string[];
  readonly resetUrl?: string;
  readonly session?: string;

  constructor(opts: { stages: string[]; resetUrl?: string; session?: string }) {
    const url = opts.resetUrl?.trim() || undefined;
    const message = url
      ? `Matrix cross-signing key upload requires interactive reset via Matrix Authentication Service. Open this URL in a browser as the bot's owner to approve, then re-run the bootstrap within the MAS approval window: ${url}`
      : "Matrix cross-signing key upload requires interactive reset, but the homeserver did not advertise a reset URL. Clear server-side cross-signing for this user via Matrix admin tooling (e.g. Synapse's POST /_synapse/admin/v1/users/{user}/_reset_cross_signing_keys) and re-run the bootstrap.";
    super(message);
    this.name = "MatrixCrossSigningResetRequiredError";
    this.stages = opts.stages;
    this.resetUrl = url;
    this.session = opts.session;
  }
}

// Thrown when /keys/device_signing/upload is gated behind UIA stages that this
// client cannot satisfy non-interactively (e.g. m.login.password without a
// configured password, or unknown custom stages on a non-MAS homeserver).
export class MatrixUiaUnsupportedStagesError extends Error {
  readonly stages: string[];
  readonly hasPassword: boolean;

  constructor(opts: { stages: string[]; hasPassword: boolean }) {
    const stagesList = opts.stages.length > 0 ? opts.stages.join(", ") : "(none advertised)";
    super(
      `Matrix cross-signing key upload requires UIA stages this client cannot satisfy: ${stagesList}. Configure matrix.password (for m.login.password) or sign in with a session that does not require UIA for cross-signing uploads.`,
    );
    this.name = "MatrixUiaUnsupportedStagesError";
    this.stages = opts.stages;
    this.hasPassword = opts.hasPassword;
  }
}

export type MatrixCryptoBootstrapApi = {
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
  bootstrapCrossSigning: (opts: {
    setupNewCrossSigning?: boolean;
    authUploadDeviceSigningKeys?: MatrixUiAuthCallback;
  }) => Promise<void>;
  bootstrapSecretStorage: (opts?: {
    createSecretStorageKey?: () => Promise<MatrixGeneratedSecretStorageKey>;
    setupNewSecretStorage?: boolean;
    setupNewKeyBackup?: boolean;
  }) => Promise<void>;
  createRecoveryKeyFromPassphrase?: (password?: string) => Promise<MatrixGeneratedSecretStorageKey>;
  getSecretStorageStatus?: () => Promise<MatrixSecretStorageStatus>;
  requestOwnUserVerification: () => Promise<MatrixVerificationRequestLike | null>;
  findVerificationRequestDMInProgress?: (
    roomId: string,
    userId: string,
  ) => MatrixVerificationRequestLike | undefined;
  requestDeviceVerification?: (
    userId: string,
    deviceId: string,
  ) => Promise<MatrixVerificationRequestLike>;
  requestVerificationDM?: (
    userId: string,
    roomId: string,
  ) => Promise<MatrixVerificationRequestLike>;
  getDeviceVerificationStatus?: (
    userId: string,
    deviceId: string,
  ) => Promise<MatrixDeviceVerificationStatusLike | null>;
  getSessionBackupPrivateKey?: () => Promise<Uint8Array | null>;
  loadSessionBackupPrivateKeyFromSecretStorage?: () => Promise<void>;
  getActiveSessionBackupVersion?: () => Promise<string | null>;
  getKeyBackupInfo?: () => Promise<MatrixKeyBackupInfo | null>;
  isKeyBackupTrusted?: (info: MatrixKeyBackupInfo) => Promise<MatrixKeyBackupTrustInfo>;
  checkKeyBackupAndEnable?: () => Promise<unknown>;
  restoreKeyBackup?: (opts?: {
    progressCallback?: (progress: MatrixImportRoomKeyProgress) => void;
  }) => Promise<MatrixRoomKeyBackupRestoreResult>;
  setDeviceVerified?: (userId: string, deviceId: string, verified?: boolean) => Promise<void>;
  crossSignDevice?: (deviceId: string) => Promise<void>;
  getOwnIdentity?: () => Promise<
    | {
        free?: () => void;
        isVerified?: () => boolean;
        verify?: () => Promise<unknown>;
      }
    | undefined
  >;
  isCrossSigningReady?: () => Promise<boolean>;
  userHasCrossSigningKeys?: (userId?: string, downloadUncached?: boolean) => Promise<boolean>;
};
