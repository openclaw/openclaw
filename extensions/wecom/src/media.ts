import fs from "fs";
import os from "os";
import path from "path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import { resolveWeComAccount } from "./accounts.js";
import { getWeComAccessToken } from "./client.js";

export type DownloadImageResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

const WECOM_API_POLICY = { allowedHostnames: ["qyapi.weixin.qq.com"] };

/**
 * Download an image from WeCom using media_id.
 * WeCom image API: GET https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=ACCESS_TOKEN&media_id=MEDIA_ID
 */
export async function downloadImageWeCom(params: {
  cfg: ClawdbotConfig;
  mediaId: string;
  accountId?: string;
}): Promise<DownloadImageResult> {
  const { cfg, mediaId, accountId } = params;
  const account = resolveWeComAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`WeCom account "${account.accountId}" not configured`);
  }

  const accessToken = await getWeComAccessToken({ cfg, accountId });
  const url = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${accessToken}&media_id=${mediaId}`;

  const { response, release } = await fetchWithSsrFGuard({
    url,
    policy: WECOM_API_POLICY,
    auditContext: "wecom-download-image",
  });
  try {
    if (!response.ok) {
      throw new Error(`WeCom image download failed: ${response.status} ${response.statusText}`);
    }

    // Check if response is JSON error
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const errorData = await response.json();
      throw new Error(`WeCom image download error ${errorData.errcode}: ${errorData.errmsg}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Try to determine file extension from content-type
    let fileName = `image_${mediaId}`;
    if (contentType) {
      const ext = contentTypeToExtension(contentType);
      if (ext) {
        fileName = `image_${mediaId}${ext}`;
      }
    }

    return { buffer, contentType: contentType ?? undefined, fileName };
  } finally {
    await release();
  }
}

/**
 * Map content-type to file extension
 */
function contentTypeToExtension(contentType: string): string | null {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
  };
  return map[contentType] || null;
}

/**
 * Save image to inbound media directory
 */
export async function saveInboundImage(params: {
  buffer: Buffer;
  fileName: string;
  accountId: string;
}): Promise<string> {
  const { buffer, fileName, accountId } = params;

  // Ensure media directory exists
  const mediaDir = path.join(os.homedir(), ".openclaw", "media", "inbound");
  await fs.promises.mkdir(mediaDir, { recursive: true });

  // Generate unique filename
  const uniqueName = `${accountId}_${Date.now()}_${fileName}`;
  const filePath = path.join(mediaDir, uniqueName);

  await fs.promises.writeFile(filePath, buffer);

  return filePath;
}
