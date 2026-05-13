import { createPluginBlobStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { toPluginJsonValue, withMSTeamsSqliteStateEnv } from "./sqlite-state.js";

/** TTL for persisted pending uploads (matches in-memory store). */
const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1000;

/** Cap to avoid unbounded growth if a process crashes mid-flow. */
const MAX_PENDING_UPLOADS = 100;

const PENDING_UPLOAD_STORE = createPluginBlobStore<PendingUploadMetadata>("msteams", {
  namespace: "pending-uploads",
  maxEntries: MAX_PENDING_UPLOADS,
  defaultTtlMs: PENDING_UPLOAD_TTL_MS,
});

type PendingUploadMetadata = {
  id: string;
  filename: string;
  contentType?: string;
  conversationId: string;
  /** Activity ID of the original FileConsentCard, used to replace it after upload */
  consentCardActivityId?: string;
  createdAt: number;
};

type PendingUploadState = {
  id: string;
  buffer: Buffer;
  filename: string;
  contentType?: string;
  conversationId: string;
  consentCardActivityId?: string;
  createdAt: number;
};

type PendingUploadsStateOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  ttlMs?: number;
};

function metadataToUpload(metadata: PendingUploadMetadata, buffer: Buffer): PendingUploadState {
  return {
    id: metadata.id,
    buffer,
    filename: metadata.filename,
    contentType: metadata.contentType,
    conversationId: metadata.conversationId,
    consentCardActivityId: metadata.consentCardActivityId,
    createdAt: metadata.createdAt,
  };
}

/**
 * Persist a pending upload record so another process can read it back.
 * Pass in the pre-generated id (same as the one placed in the consent card
 * context) so the in-memory and FS stores share the same key.
 */
export async function storePendingUploadState(
  upload: {
    id: string;
    buffer: Buffer;
    filename: string;
    contentType?: string;
    conversationId: string;
    consentCardActivityId?: string;
  },
  options?: PendingUploadsStateOptions,
): Promise<void> {
  const ttlMs = options?.ttlMs ?? PENDING_UPLOAD_TTL_MS;
  await withMSTeamsSqliteStateEnv(options, async () => {
    await PENDING_UPLOAD_STORE.register(
      upload.id,
      toPluginJsonValue({
        id: upload.id,
        filename: upload.filename,
        contentType: upload.contentType,
        conversationId: upload.conversationId,
        consentCardActivityId: upload.consentCardActivityId,
        createdAt: Date.now(),
      }),
      upload.buffer,
      { ttlMs },
    );
  });
}

/**
 * Retrieve a persisted pending upload. Expired entries are treated as absent.
 */
export async function getPendingUploadState(
  id: string | undefined,
  options?: PendingUploadsStateOptions,
): Promise<PendingUploadState | undefined> {
  if (!id) {
    return undefined;
  }
  const ttlMs = options?.ttlMs ?? PENDING_UPLOAD_TTL_MS;
  return await withMSTeamsSqliteStateEnv(options, async () => {
    const entry = await PENDING_UPLOAD_STORE.lookup(id);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.metadata.createdAt > ttlMs) {
      await PENDING_UPLOAD_STORE.delete(id);
      return undefined;
    }
    return metadataToUpload(entry.metadata, entry.blob);
  });
}

/**
 * Remove a persisted pending upload (after successful upload or decline).
 * No-op if the entry is already gone.
 */
export async function removePendingUploadState(
  id: string | undefined,
  options?: PendingUploadsStateOptions,
): Promise<void> {
  if (!id) {
    return;
  }
  await withMSTeamsSqliteStateEnv(options, async () => {
    await PENDING_UPLOAD_STORE.delete(id);
  });
}

/**
 * Set the consent card activity ID on a persisted entry. Called after the
 * FileConsentCard activity is sent and we know its message id.
 */
export async function setPendingUploadActivityIdState(
  id: string,
  activityId: string,
  options?: PendingUploadsStateOptions,
): Promise<void> {
  const ttlMs = options?.ttlMs ?? PENDING_UPLOAD_TTL_MS;
  await withMSTeamsSqliteStateEnv(options, async () => {
    const entry = await PENDING_UPLOAD_STORE.lookup(id);
    if (!entry) {
      return;
    }
    entry.metadata.consentCardActivityId = activityId;
    await PENDING_UPLOAD_STORE.register(id, toPluginJsonValue(entry.metadata), entry.blob, {
      ttlMs,
    });
  });
}
