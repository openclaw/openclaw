import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTextLineComponents,
  markdownToNaverWorksFlexTemplate,
  type NaverWorksFlexContainer,
  type NaverWorksFlexComponent,
} from "./markdown-to-flex.js";
import { getNaverWorksRuntime } from "./runtime.js";
import type { NaverWorksAccount, NaverWorksStickerRef } from "./types.js";

type OAuthTokenCacheEntry = {
  token: string;
  expiresAtMs: number;
};

export type NaverWorksSendDelivery = {
  contentType: NaverWorksOutboundContent["type"];
  viaAttachmentUpload: boolean;
  mediaKind?: "image" | "audio" | "file";
  uploadedFileId?: string;
  localMediaPath?: string;
  remoteMediaUrl?: string;
};

const oauthTokenCache = new Map<string, OAuthTokenCacheEntry>();

type NaverWorksOutboundContent =
  | { type: "text"; text: string }
  | {
      type: "flex";
      altText: string;
      contents: NaverWorksFlexContainer;
      i18nAltTexts?: Array<{ language: string; altText: string }>;
    }
  | { type: "image"; previewImageUrl?: string; originalContentUrl?: string; fileId?: string }
  | { type: "audio" | "file"; resourceUrl: string }
  | { type: "sticker"; packageId: string; stickerId: string };

type NaverWorksAuthTokenResult =
  | {
      ok: true;
      token: string;
      usesStaticAccessToken: boolean;
    }
  | {
      ok: false;
      status?: number;
      body?: string;
    };

function getOauthTokenCacheKey(account: NaverWorksAccount): string | null {
  const clientId = account.clientId?.trim();
  const serviceAccount = account.serviceAccount?.trim();
  if (!clientId || !serviceAccount) {
    return null;
  }
  const scope = account.scope?.trim() || "bot";
  return [
    account.accountId,
    clientId,
    account.clientSecret?.trim() || "",
    serviceAccount,
    scope,
  ].join("::");
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildSendUrl(account: NaverWorksAccount, userId: string): string {
  const base = trimTrailingSlash(account.apiBaseUrl);
  const encodedBotId = encodeURIComponent(account.botId ?? "");
  const encodedUserId = encodeURIComponent(userId);
  return `${base}/bots/${encodedBotId}/users/${encodedUserId}/messages`;
}

function base64UrlEncode(value: string | Buffer): string {
  const source = typeof value === "string" ? Buffer.from(value, "utf-8") : value;
  return source.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function buildJwtAssertion(params: {
  iss: string;
  sub: string;
  privateKey: string;
  nowSeconds: number;
}): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: params.iss,
    sub: params.sub,
    iat: params.nowSeconds,
    exp: params.nowSeconds + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(params.privateKey);
  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

function isRemoteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function buildAltText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "OpenClaw message";
  }
  return normalized.slice(0, 400);
}

function normalizeMimeType(mime?: string | null): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

async function issueAccessTokenWithJwt(account: NaverWorksAccount): Promise<{
  token?: string;
  status?: number;
  body?: string;
}> {
  const clientId = account.clientId?.trim();
  const clientSecret = account.clientSecret?.trim();
  const serviceAccount = account.serviceAccount?.trim();
  const privateKey = account.privateKey;
  const issuer = account.jwtIssuer?.trim() || clientId;
  if (!clientId || !clientSecret || !serviceAccount || !privateKey || !issuer) {
    return {};
  }

  const scope = account.scope?.trim() || "bot";
  const cacheKey = getOauthTokenCacheKey(account);
  if (!cacheKey) {
    return {};
  }
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now() + 60_000) {
    return { token: cached.token };
  }

  const assertion = buildJwtAssertion({
    iss: issuer,
    sub: serviceAccount,
    privateKey,
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  const body = new URLSearchParams({
    assertion,
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const tokenResponse = await fetch(account.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!tokenResponse.ok) {
    return {
      status: tokenResponse.status,
      body: await tokenResponse.text().catch(() => ""),
    };
  }

  const tokenPayload = (await tokenResponse.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  const accessToken =
    typeof tokenPayload?.access_token === "string" ? tokenPayload.access_token.trim() : "";
  if (!accessToken) {
    return { body: "missing access_token in token response" };
  }

  const expiresInSeconds =
    typeof tokenPayload?.expires_in === "number"
      ? tokenPayload.expires_in
      : Number.parseInt(String(tokenPayload?.expires_in ?? "86400"), 10);
  const safeExpiresIn = Number.isFinite(expiresInSeconds) ? Math.max(60, expiresInSeconds) : 86_400;

  oauthTokenCache.set(cacheKey, {
    token: accessToken,
    expiresAtMs: Date.now() + safeExpiresIn * 1000,
  });

  return { token: accessToken };
}

function clearJwtTokenCache(account: NaverWorksAccount): void {
  const cacheKey = getOauthTokenCacheKey(account);
  if (cacheKey) {
    oauthTokenCache.delete(cacheKey);
  }
}

export async function resolveNaverWorksAccessToken(
  account: NaverWorksAccount,
): Promise<NaverWorksAuthTokenResult> {
  const staticToken = account.accessToken?.trim();
  if (staticToken) {
    return {
      ok: true,
      token: staticToken,
      usesStaticAccessToken: true,
    };
  }

  const issuedToken = await issueAccessTokenWithJwt(account);
  if (!issuedToken.token) {
    return {
      ok: false,
      status: issuedToken.status,
      body: issuedToken.body,
    };
  }

  return {
    ok: true,
    token: issuedToken.token,
    usesStaticAccessToken: false,
  };
}

async function postUserMessage(params: {
  account: NaverWorksAccount;
  toUserId: string;
  content: NaverWorksOutboundContent;
  accessToken: string;
}): Promise<Response> {
  const { account, toUserId, content, accessToken } = params;
  const url = buildSendUrl(account, toUserId);
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
}

function buildAttachmentCreateUrl(account: NaverWorksAccount): string {
  const base = trimTrailingSlash(account.apiBaseUrl);
  const encodedBotId = encodeURIComponent(account.botId ?? "");
  return `${base}/bots/${encodedBotId}/attachments`;
}

function inferMediaKindFromUrl(mediaUrl: string): "image" | "audio" | "file" {
  const path = mediaUrl.split("?")[0]?.toLowerCase() ?? "";
  if (path.match(/\.(png|jpe?g|gif|webp|bmp|heic|svg)$/)) {
    return "image";
  }
  if (path.match(/\.(mp3|m4a|wav|ogg|opus|aac|flac|amr)$/)) {
    return "audio";
  }
  return "file";
}

function createImageComponent(url: string, options?: { margin?: "none" | "sm" | "md" }) {
  return {
    type: "image" as const,
    url,
    size: "full" as const,
    aspectRatio: "4:3",
    aspectMode: "fit" as const,
    margin: options?.margin,
  };
}

function createTextComponents(text: string, theme: NaverWorksAccount["markdownTheme"]) {
  const resolvedTheme = theme ?? "auto";
  const sectionTitleColor = resolvedTheme === "dark" ? "#ffffff" : "#000000";
  const textColor = resolvedTheme === "dark" ? "#f5f5f5" : "#111111";
  const lines = text
    .trim()
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    const fallbackText = text.trim() || "OpenClaw message";
    return createTextLineComponents(fallbackText, { color: textColor, size: "md" });
  }

  const [first, ...rest] = lines;
  const components: NaverWorksFlexComponent[] = [
    ...createTextLineComponents(first, {
      bold: true,
      color: sectionTitleColor,
      size: "md",
    }),
  ];
  for (const line of rest) {
    components.push(
      ...createTextLineComponents(line, { margin: "sm", color: textColor, size: "md" }),
    );
  }
  return components;
}

function toLocalFilePath(mediaUrl: string): string | null {
  if (isRemoteHttpUrl(mediaUrl)) {
    return null;
  }
  if (mediaUrl.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(mediaUrl).pathname);
    } catch {
      return null;
    }
  }
  return mediaUrl;
}

async function createAttachment(params: {
  account: NaverWorksAccount;
  fileName: string;
  fileSize: number;
  accessToken: string;
}): Promise<
  { ok: true; fileId: string; uploadUrl: string } | { ok: false; status?: number; body?: string }
> {
  const response = await fetch(buildAttachmentCreateUrl(params.account), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileName: params.fileName,
      fileSize: params.fileSize,
    }),
  });
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body: `phase=attachment-create fileName=${params.fileName} fileSize=${params.fileSize} ${await response.text().catch(() => "")}`.trim(),
    };
  }
  const payload = (await response.json().catch(() => null)) as {
    fileId?: unknown;
    uploadUrl?: unknown;
  } | null;
  const fileId = typeof payload?.fileId === "string" ? payload.fileId.trim() : "";
  const uploadUrl = typeof payload?.uploadUrl === "string" ? payload.uploadUrl.trim() : "";
  if (!fileId || !uploadUrl) {
    return {
      ok: false,
      body: `phase=attachment-create fileName=${params.fileName} missing fileId or uploadUrl in attachment response`,
    };
  }
  return { ok: true, fileId, uploadUrl };
}

async function uploadAttachmentBinary(params: {
  uploadUrl: string;
  fileName: string;
  accessToken: string;
  fileBuffer: Buffer;
  contentType: string;
}): Promise<{ ok: true; fileId?: string } | { ok: false; status?: number; body?: string }> {
  const form = new FormData();
  form.set("resourceName", params.fileName);
  form.set(
    "FileData",
    new Blob([params.fileBuffer], { type: params.contentType }),
    params.fileName,
  );
  const response = await fetch(params.uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${params.accessToken}` },
    body: form,
  });
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body: `phase=attachment-upload fileName=${params.fileName} uploadUrl=${params.uploadUrl} ${await response.text().catch(() => "")}`.trim(),
    };
  }
  const payload = (await response.json().catch(() => null)) as { fileId?: unknown } | null;
  return {
    ok: true,
    fileId: typeof payload?.fileId === "string" ? payload.fileId.trim() : undefined,
  };
}

async function uploadLocalMediaAsAttachment(params: {
  account: NaverWorksAccount;
  mediaPath: string;
  accessToken: string;
}): Promise<
  | { ok: true; fileId: string; mediaKind: "image" | "audio" | "file" }
  | { ok: false; status?: number; body?: string }
> {
  const fileName = path.basename(params.mediaPath) || "attachment";
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  let fileBuffer: Buffer;
  try {
    stat = await fs.stat(params.mediaPath);
    fileBuffer = await fs.readFile(params.mediaPath);
  } catch (error) {
    return {
      ok: false,
      body: `phase=attachment-read mediaPath=${params.mediaPath} error=${String(error)}`,
    };
  }
  const created = await createAttachment({
    account: params.account,
    fileName,
    fileSize: stat.size,
    accessToken: params.accessToken,
  });
  if (!created.ok) {
    return created;
  }
  const mediaKind = inferMediaKindFromUrl(fileName);
  const runtime = getNaverWorksRuntime();
  const detectedContentType = normalizeMimeType(
    await runtime.media.detectMime({
      buffer: fileBuffer.subarray(0, 512),
      filePath: params.mediaPath,
    }),
  );
  const contentType =
    detectedContentType ??
    (mediaKind === "image"
      ? "image/png"
      : mediaKind === "audio"
        ? "audio/mpeg"
        : "application/octet-stream");
  const uploaded = await uploadAttachmentBinary({
    uploadUrl: created.uploadUrl,
    fileName,
    accessToken: params.accessToken,
    fileBuffer,
    contentType,
  });
  if (!uploaded.ok) {
    return uploaded;
  }
  return {
    ok: true,
    fileId: uploaded.fileId || created.fileId,
    mediaKind,
  };
}

function buildOutboundContent(params: {
  markdownMode: NaverWorksAccount["markdownMode"];
  markdownTheme: NaverWorksAccount["markdownTheme"];
  text?: string;
  mediaUrl?: string;
  uploadedFileId?: string;
  sticker?: NaverWorksStickerRef;
}): NaverWorksOutboundContent | null {
  const text = params.text?.trim();
  const mediaUrl = params.mediaUrl?.trim();
  if (text) {
    if (params.markdownMode === "auto-flex") {
      const flexPayload = markdownToNaverWorksFlexTemplate(text, { theme: params.markdownTheme });
      if (flexPayload) {
        return {
          type: "flex",
          altText: flexPayload.altText,
          contents: flexPayload.contents,
        };
      }
    }
    return { type: "text", text };
  }
  const sticker = params.sticker;
  if (sticker?.packageId && sticker.stickerId) {
    return {
      type: "sticker",
      packageId: sticker.packageId,
      stickerId: sticker.stickerId,
    };
  }
  if (params.uploadedFileId) {
    return {
      type: "image",
      fileId: params.uploadedFileId,
    };
  }
  if (!mediaUrl) {
    return null;
  }
  if (inferMediaKindFromUrl(mediaUrl) === "image") {
    return {
      type: "image",
      previewImageUrl: mediaUrl,
      originalContentUrl: mediaUrl,
    };
  }
  return { type: inferMediaKindFromUrl(mediaUrl), resourceUrl: mediaUrl };
}

export async function sendMessageNaverWorks(params: {
  account: NaverWorksAccount;
  toUserId: string;
  text?: string;
  mediaUrl?: string;
  sticker?: NaverWorksStickerRef;
}): Promise<
  | { ok: true; delivery: NaverWorksSendDelivery }
  | {
      ok: false;
      reason: "not-configured" | "auth-error" | "http-error";
      status?: number;
      body?: string;
    }
> {
  const { account, toUserId } = params;
  const localMediaPath = params.mediaUrl ? toLocalFilePath(params.mediaUrl) : null;
  let uploadedFileId: string | undefined;

  if (!account.botId) {
    return { ok: false, reason: "not-configured" };
  }

  const accessTokenResult = await resolveNaverWorksAccessToken(account);
  if (!accessTokenResult.ok) {
    return {
      ok: false,
      reason: "auth-error",
      status: accessTokenResult.status,
      body: accessTokenResult.body,
    };
  }

  let accessToken = accessTokenResult.token;
  const sendWithResolvedToken = async (token: string) => {
    let resolvedFileId = uploadedFileId;
    let uploadedMediaKind: "image" | "audio" | "file" | undefined;
    if (!resolvedFileId && localMediaPath) {
      const uploaded = await uploadLocalMediaAsAttachment({
        account,
        mediaPath: localMediaPath,
        accessToken: token,
      });
      if (!uploaded.ok) {
        return {
          ok: false as const,
          status: uploaded.status,
          body: uploaded.body,
          response: null,
        };
      }
      resolvedFileId = uploaded.fileId;
      uploadedMediaKind = uploaded.mediaKind;
      uploadedFileId = uploaded.fileId;
    }

    const content = buildOutboundContent({
      markdownMode: account.markdownMode,
      markdownTheme: account.markdownTheme,
      text: params.text,
      mediaUrl: isRemoteHttpUrl(params.mediaUrl?.trim() ?? "") ? params.mediaUrl : undefined,
      uploadedFileId: resolvedFileId,
      sticker: params.sticker,
    });
    if (!content) {
      return { ok: false as const, status: undefined, body: undefined, response: null };
    }

    const delivery: NaverWorksSendDelivery = {
      contentType: content.type,
      viaAttachmentUpload: Boolean(localMediaPath),
      mediaKind:
        uploadedMediaKind ??
        (content.type === "image" || content.type === "audio" || content.type === "file"
          ? content.type
          : undefined),
      uploadedFileId: resolvedFileId,
      localMediaPath: localMediaPath ?? undefined,
      remoteMediaUrl: isRemoteHttpUrl(params.mediaUrl?.trim() ?? "")
        ? params.mediaUrl?.trim()
        : undefined,
    };

    return {
      ok: true as const,
      status: undefined,
      body: undefined,
      response: await postUserMessage({ account, toUserId, content, accessToken: token }),
      delivery,
    };
  };

  let sendAttempt = await sendWithResolvedToken(accessToken);
  if (!sendAttempt.ok) {
    return {
      ok: false,
      reason:
        sendAttempt.status === 401 || sendAttempt.status === 403 ? "auth-error" : "http-error",
      status: sendAttempt.status,
      body: sendAttempt.body,
    };
  }
  let response = sendAttempt.response;

  if (
    !accessTokenResult.usesStaticAccessToken &&
    (response.status === 401 || response.status === 403)
  ) {
    clearJwtTokenCache(account);
    const refreshedTokenResult = await resolveNaverWorksAccessToken(account);
    if (!refreshedTokenResult.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        reason: "auth-error",
        status: refreshedTokenResult.status ?? response.status,
        body: refreshedTokenResult.body ?? body,
      };
    }
    accessToken = refreshedTokenResult.token;
    uploadedFileId = undefined;
    sendAttempt = await sendWithResolvedToken(accessToken);
    if (!sendAttempt.ok) {
      return {
        ok: false,
        reason:
          sendAttempt.status === 401 || sendAttempt.status === 403 ? "auth-error" : "http-error",
        status: sendAttempt.status,
        body: sendAttempt.body,
      };
    }
    response = sendAttempt.response;
  }

  if (response.ok) {
    return { ok: true, delivery: sendAttempt.delivery };
  }

  const body = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "auth-error", status: response.status, body };
  }
  return { ok: false, reason: "http-error", status: response.status, body };
}
