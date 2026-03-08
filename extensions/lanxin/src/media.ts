import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/lanxin";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/lanxin";
import { resolveLanxinAccount } from "./accounts.js";
import { lanxinApiPost } from "./client.js";
import { logLanxinDebug } from "./debug.js";
import { getLanxinValidToken } from "./token.js";

export type UploadLanxinMediaParams = {
  cfg: ClawdbotConfig;
  accountId?: string;
  data: Buffer;
  fileName: string;
  contentType?: string;
  fileType?: number;
};

export type UploadLanxinMediaResult = {
  mediaId: string;
  fileType: number;
  messageType: "image" | "file" | "video";
};

type UploadLanxinMediaApiData = {
  mediaId?: string;
};

function resolveLanxinMediaType(contentType: string | undefined): number {
  if (!contentType) return 0;
  const normalized = contentType.toLowerCase();
  if (normalized.startsWith("image/")) return 2;
  if (normalized.startsWith("video/")) return 3;
  return 0;
}

function resolveLanxinMessageType(contentType: string | undefined): "image" | "file" | "video" {
  if (!contentType) return "file";
  const normalized = contentType.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  return "file";
}

export async function uploadLanxinMedia(
  params: UploadLanxinMediaParams,
): Promise<UploadLanxinMediaResult> {
  const fileType = params.fileType ?? resolveLanxinMediaType(params.contentType);
  logLanxinDebug(params.cfg, "upload media start", {
    fileName: params.fileName,
    fileType,
    contentType: params.contentType,
    size: params.data.length,
  });
  const form = new FormData();
  const blob = new Blob([Uint8Array.from(params.data)], {
    type: params.contentType || "application/octet-stream",
  });
  form.set("media", blob, params.fileName || "upload.bin");

  const response = await lanxinApiPost<UploadLanxinMediaApiData>({
    cfg: params.cfg,
    accountId: params.accountId,
    path: `medias/create?type=${fileType}`,
    body: form,
  });
  const mediaId = response.data?.mediaId?.trim();
  if (!mediaId) {
    throw new Error("Lanxin media upload did not return mediaId");
  }
  logLanxinDebug(params.cfg, "upload media success", {
    mediaId,
    fileType,
    messageType: resolveLanxinMessageType(params.contentType),
  });
  return {
    mediaId,
    fileType,
    messageType: resolveLanxinMessageType(params.contentType),
  };
}

export async function uploadLanxinMediaFromUrl(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
}): Promise<UploadLanxinMediaResult> {
  const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
    mediaLocalRoots: params.mediaLocalRoots,
  });
  logLanxinDebug(params.cfg, "resolved outbound media", {
    mediaUrl: params.mediaUrl,
    fileName: media.fileName,
    contentType: media.contentType,
    size: media.buffer.length,
  });
  return uploadLanxinMedia({
    cfg: params.cfg,
    accountId: params.accountId,
    data: media.buffer,
    fileName: media.fileName || "upload.bin",
    contentType: media.contentType,
  });
}

export type DownloadLanxinMediaResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

function parseFileNameFromContentDisposition(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const utf8Match = disposition.match(/filename\*\s*=\s*utf-8''([^;\n]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = disposition.match(/filename="?([^";\n]+)"?/i);
  if (!plainMatch?.[1]) return undefined;
  return plainMatch[1];
}

export async function downloadLanxinMedia(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  mediaId: string;
}): Promise<DownloadLanxinMediaResult> {
  const account = resolveLanxinAccount({ cfg: params.cfg, accountId: params.accountId });
  const tokenUrl = new URL(`medias/${params.mediaId}/fetch`, account.apiBaseUrl);
  const token = await getLanxinValidToken(account);
  tokenUrl.searchParams.set("app_token", token);

  const response = await fetch(tokenUrl, {
    method: "GET",
    headers: { Accept: "*/*" },
  });
  if (!response.ok) {
    throw new Error(`Lanxin media download failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? undefined;
  const fileName = parseFileNameFromContentDisposition(response.headers.get("content-disposition"));
  return { buffer: bytes, contentType, fileName };
}
