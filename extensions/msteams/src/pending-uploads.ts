/**
 * In-memory storage for files awaiting user consent in the FileConsentCard flow.
 *
 * When sending large files (>=4MB) in personal chats, Teams requires user consent
 * before upload. This module stores the file data temporarily until the user
 * accepts or declines, or until the TTL expires.
 */

import crypto from "node:crypto";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";

export interface PendingUpload {
  id: string;
  buffer: Buffer;
  filename: string;
  contentType?: string;
  conversationId: string;
  /** Activity ID of the original FileConsentCard, used to replace it after upload */
  consentCardActivityId?: string;
  createdAt: number;
}

const pendingUploads = resolveGlobalSingleton(
  Symbol.for("openclaw.msteams.pendingUploadState"),
  () =>
    new Map<
      string,
      {
        upload: PendingUpload;
        timer: ReturnType<typeof setTimeout>;
        // In-process expiry deadline on the monotonic clock; createdAt stays the public epoch.
        expiresAtMonotonic: number;
      }
    >(),
  (state) => {
    for (const { timer } of state.values()) {
      clearTimeout(timer);
    }
    state.clear();
  },
);

const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1000;

/**
 * Store a file pending user consent.
 * Returns the upload ID to include in the FileConsentCard context.
 */
export function storePendingUpload(upload: Omit<PendingUpload, "id" | "createdAt">): string {
  const id = crypto.randomUUID();
  const entry: PendingUpload = {
    ...upload,
    id,
    createdAt: Date.now(),
  };
  const timer = setTimeout(() => {
    pendingUploads.delete(id);
  }, PENDING_UPLOAD_TTL_MS);
  pendingUploads.set(id, {
    upload: entry,
    timer,
    expiresAtMonotonic: performance.now() + PENDING_UPLOAD_TTL_MS,
  });

  return id;
}

export function getPendingUpload(id?: string): PendingUpload | undefined {
  if (!id) {
    return undefined;
  }
  const slot = pendingUploads.get(id);
  if (!slot) {
    return undefined;
  }

  // Check if expired (in case timeout hasn't fired yet); the wall clock may step, so the
  // deadline rides the monotonic clock.
  if (performance.now() > slot.expiresAtMonotonic) {
    removePendingUpload(id);
    return undefined;
  }

  return slot.upload;
}

/**
 * Remove a pending upload (after successful upload or user decline).
 * Also clears the TTL timer to prevent ghost Map deletions.
 */
export function removePendingUpload(id?: string): void {
  if (id) {
    clearTimeout(pendingUploads.get(id)?.timer);
    pendingUploads.delete(id);
  }
}

export function setPendingUploadActivityId(uploadId: string, activityId: string): void {
  const entry = pendingUploads.get(uploadId)?.upload;
  if (entry) {
    entry.consentCardActivityId = activityId;
  }
}
