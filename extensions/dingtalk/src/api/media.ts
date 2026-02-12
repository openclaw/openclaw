/**
 * DingTalk Media API for file upload and download.
 */

import type { ResolvedDingTalkAccount } from "../accounts.js";
import type { StreamLogger } from "../stream/types.js";
import { createTokenManagerFromAccount, type TokenManager } from "./token-manager.js";

/**
 * Result of uploading media.
 */
export interface UploadMediaResult {
  ok: boolean;
  mediaId?: string;
  error?: Error;
}

/**
 * Result of downloading media.
 */
export interface DownloadMediaResult {
  ok: boolean;
  url?: string;
  error?: Error;
}

/**
 * Upload a file to DingTalk and get a mediaId.
 * Uses the robot file upload API.
 * API: POST /v1.0/robot/messageFiles/upload
 */
export async function uploadMedia(opts: {
  account: ResolvedDingTalkAccount;
  file: Buffer;
  fileName: string;
  tokenManager?: TokenManager;
  logger?: StreamLogger;
}): Promise<UploadMediaResult> {
  const { account, file, fileName, tokenManager: providedTokenManager, logger } = opts;

  const tokenManager = providedTokenManager ?? createTokenManagerFromAccount(account, logger);

  let accessToken: string;
  try {
    accessToken = await tokenManager.getToken();
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message } },
      "Failed to get access token for media upload",
    );
    return { ok: false, error: err as Error };
  }

  const url = `${account.apiBase}/v1.0/robot/messageFiles/upload`;

  try {
    // Create FormData for file upload
    const formData = new FormData();
    formData.append("robotCode", account.clientId);
    formData.append("file", new Blob([Uint8Array.from(file)]), fileName);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: formData,
      signal: AbortSignal.timeout(60_000), // Longer timeout for file upload
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      logger?.error?.(
        { status: resp.status, error: errorText.slice(0, 200), fileName },
        "Media upload failed",
      );
      return {
        ok: false,
        error: new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`),
      };
    }

    const data = (await resp.json()) as { mediaId?: string };

    logger?.debug?.({ mediaId: data.mediaId, fileName }, "Media uploaded");

    return {
      ok: true,
      mediaId: data.mediaId,
    };
  } catch (err) {
    logger?.error?.({ err: { message: (err as Error)?.message }, fileName }, "Media upload error");
    return { ok: false, error: err as Error };
  }
}

/**
 * Download a file from DingTalk using downloadCode.
 * Returns a temporary download URL.
 * API: POST /v1.0/robot/messageFiles/download
 */
export async function downloadMedia(opts: {
  account: ResolvedDingTalkAccount;
  downloadCode: string;
  tokenManager?: TokenManager;
  logger?: StreamLogger;
}): Promise<DownloadMediaResult> {
  const { account, downloadCode, tokenManager: providedTokenManager, logger } = opts;

  const tokenManager = providedTokenManager ?? createTokenManagerFromAccount(account, logger);

  let accessToken: string;
  try {
    accessToken = await tokenManager.getToken();
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message } },
      "Failed to get access token for media download",
    );
    return { ok: false, error: err as Error };
  }

  const url = `${account.apiBase}/v1.0/robot/messageFiles/download`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        robotCode: account.clientId,
        downloadCode,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      logger?.error?.(
        {
          status: resp.status,
          error: errorText.slice(0, 200),
          downloadCode: downloadCode.slice(0, 20),
        },
        "Media download failed",
      );
      return {
        ok: false,
        error: new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`),
      };
    }

    const data = (await resp.json()) as { downloadUrl?: string };

    logger?.debug?.(
      { hasUrl: !!data.downloadUrl, downloadCode: downloadCode.slice(0, 20) },
      "Media download URL obtained",
    );

    return {
      ok: true,
      url: data.downloadUrl,
    };
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message }, downloadCode: downloadCode.slice(0, 20) },
      "Media download error",
    );
    return { ok: false, error: err as Error };
  }
}
