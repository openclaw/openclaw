import type { CryptoApi, DeviceVerificationStatus } from "matrix-js-sdk/lib/crypto-api/index.js";
import type * as MatrixSdkTypes from "matrix-js-sdk/lib/types.js";
import type { MatrixSyncState } from "../sync-state.js";
import type {
  MatrixVerificationCryptoApi,
  MatrixVerificationSummary,
} from "./verification-manager.js";

export type MatrixRawEvent = {
  event_id: string;
  room_id?: string;
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
  /** Bridge-owned membership evidence; snapshots never establish a new join. */
  membershipProvenance?: "snapshot" | "transition" | "update";
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

export type EncryptedFile = MatrixSdkTypes.EncryptedFile;
export type FileWithThumbnailInfo = MatrixSdkTypes.FileInfo;
export type DimensionalFileInfo = MatrixSdkTypes.ImageInfo;
export type TimedFileInfo = MatrixSdkTypes.FileInfo & MatrixSdkTypes.AudioInfo;
export type VideoFileInfo = MatrixSdkTypes.VideoInfo;

export type MessageEventContent = {
  msgtype?: string;
  body?: string;
  format?: string;
  formatted_body?: string;
  filename?: string;
  url?: string;
  file?: EncryptedFile;
  info?: MatrixSdkTypes.MediaEventInfo | Record<string, unknown>;
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

export type MatrixDeviceVerificationStatusLike = Pick<
  DeviceVerificationStatus,
  "isVerified" | "localVerified" | "crossSigningVerified" | "signedByOwner"
>;

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

export type MatrixCryptoBootstrapApi = MatrixVerificationCryptoApi &
  Pick<
    CryptoApi,
    | "getSessionBackupPrivateKey"
    | "loadSessionBackupPrivateKeyFromSecretStorage"
    | "getActiveSessionBackupVersion"
    | "getKeyBackupInfo"
    | "isKeyBackupTrusted"
    | "checkKeyBackupAndEnable"
    | "restoreKeyBackup"
    | "setDeviceVerified"
    | "crossSignDevice"
    | "isCrossSigningReady"
    | "userHasCrossSigningKeys"
  > & {
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
    createRecoveryKeyFromPassphrase: (
      password?: string,
    ) => Promise<MatrixGeneratedSecretStorageKey>;
    getSecretStorageStatus: () => Promise<MatrixSecretStorageStatus>;
    getDeviceVerificationStatus: (
      userId: string,
      deviceId: string,
    ) => Promise<MatrixDeviceVerificationStatusLike | null>;
    getOwnIdentity?: () => Promise<
      | {
          free?: () => void;
          isVerified?: () => boolean;
          verify?: () => Promise<unknown>;
        }
      | undefined
    >;
  };
