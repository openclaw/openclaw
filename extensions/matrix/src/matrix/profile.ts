import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixClient } from "./sdk.js";

const MATRIX_PROFILE_AVATAR_MAX_BYTES = 10 * 1024 * 1024;

type MatrixProfileClient = Pick<
  MatrixClient,
  "getUserProfile" | "setDisplayName" | "setAvatarUrl" | "uploadContent"
>;

type MatrixProfileLoadResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

export type MatrixProfileSyncResult = {
  skipped: boolean;
  displayNameUpdated: boolean;
  avatarUpdated: boolean;
  resolvedAvatarUrl: string | null;
  uploadedAvatarSource: "http" | "path" | null;
  convertedAvatarFromHttp: boolean;
};

function isMatrixMxcUri(value: string): boolean {
  return normalizeLowercaseStringOrEmpty(value).startsWith("mxc://");
}

function isMatrixHttpAvatarUri(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized.startsWith("https://") || normalized.startsWith("http://");
}

export function isSupportedMatrixAvatarSource(value: string): boolean {
  return isMatrixMxcUri(value) || isMatrixHttpAvatarUri(value);
}

export async function syncMatrixOwnProfile(params: {
  client: MatrixProfileClient;
  userId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  avatarPath?: string | null;
  avatarMaxBytes?: number;
  loadAvatarFromUrl?: (url: string, maxBytes: number) => Promise<MatrixProfileLoadResult>;
  loadAvatarFromPath?: (path: string, maxBytes: number) => Promise<MatrixProfileLoadResult>;
}): Promise<MatrixProfileSyncResult> {
  const desiredDisplayName = normalizeOptionalString(params.displayName) ?? null;
  const avatarPath = normalizeOptionalString(params.avatarPath) ?? null;
  const avatarSource = avatarPath ?? normalizeOptionalString(params.avatarUrl) ?? null;
  let desiredAvatarUrl = avatarSource;
  let uploadedAvatarSource: MatrixProfileSyncResult["uploadedAvatarSource"] = null;
  if (avatarSource && (avatarPath || !isMatrixMxcUri(avatarSource))) {
    if (!avatarPath && !isMatrixHttpAvatarUri(avatarSource)) {
      throw new Error("Matrix avatar URL must be an mxc:// URI or an http(s) URL.");
    }
    const loadAvatar = avatarPath ? params.loadAvatarFromPath : params.loadAvatarFromUrl;
    if (!loadAvatar) {
      throw new Error(
        avatarPath
          ? "Matrix avatar path upload requires a media loader."
          : "Matrix avatar URL conversion requires a media loader.",
      );
    }
    const media = await loadAvatar(
      avatarSource,
      params.avatarMaxBytes ?? MATRIX_PROFILE_AVATAR_MAX_BYTES,
    );
    desiredAvatarUrl = await params.client.uploadContent(
      media.buffer,
      media.contentType,
      media.fileName || "avatar",
    );
    uploadedAvatarSource = avatarPath ? "path" : "http";
  }
  const avatar = {
    resolvedAvatarUrl: desiredAvatarUrl,
    uploadedAvatarSource,
    convertedAvatarFromHttp: uploadedAvatarSource === "http",
  };

  if (!desiredDisplayName && !desiredAvatarUrl) {
    return {
      skipped: true,
      displayNameUpdated: false,
      avatarUpdated: false,
      ...avatar,
      resolvedAvatarUrl: null,
    };
  }

  let currentDisplayName: string | undefined;
  let currentAvatarUrl: string | undefined;
  try {
    const currentProfile = await params.client.getUserProfile(params.userId);
    currentDisplayName = normalizeOptionalString(currentProfile.displayname);
    currentAvatarUrl = normalizeOptionalString(currentProfile.avatar_url);
  } catch {
    // If profile fetch fails, attempt writes directly.
  }

  let displayNameUpdated = false;
  let avatarUpdated = false;

  if (desiredDisplayName && currentDisplayName !== desiredDisplayName) {
    await params.client.setDisplayName(desiredDisplayName);
    displayNameUpdated = true;
  }
  if (desiredAvatarUrl && currentAvatarUrl !== desiredAvatarUrl) {
    await params.client.setAvatarUrl(desiredAvatarUrl);
    avatarUpdated = true;
  }

  return {
    skipped: false,
    displayNameUpdated,
    avatarUpdated,
    ...avatar,
  };
}
