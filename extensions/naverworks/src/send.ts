import crypto from "node:crypto";
import {
  markdownToNaverWorksFlexTemplate,
  type NaverWorksFlexContainer,
} from "./markdown-to-flex.js";
import type { NaverWorksAccount, NaverWorksStickerRef } from "./types.js";

type OAuthTokenCacheEntry = {
  token: string;
  expiresAtMs: number;
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
  | { type: "image" | "audio" | "file"; resourceUrl: string }
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

function buildOutboundContent(params: {
  markdownMode: NaverWorksAccount["markdownMode"];
  markdownTheme: NaverWorksAccount["markdownTheme"];
  text?: string;
  mediaUrl?: string;
  sticker?: NaverWorksStickerRef;
}): NaverWorksOutboundContent | null {
  const text = params.text?.trim();
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
  const mediaUrl = params.mediaUrl?.trim();
  if (!mediaUrl) {
    return null;
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
  | { ok: true }
  | {
      ok: false;
      reason: "not-configured" | "auth-error" | "http-error";
      status?: number;
      body?: string;
    }
> {
  const { account, toUserId } = params;
  const content = buildOutboundContent({
    markdownMode: account.markdownMode,
    markdownTheme: account.markdownTheme,
    text: params.text,
    mediaUrl: params.mediaUrl,
    sticker: params.sticker,
  });
  if (!account.botId || !content) {
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
  let response = await postUserMessage({ account, toUserId, content, accessToken });

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
    response = await postUserMessage({ account, toUserId, content, accessToken });
  }

  if (response.ok) {
    return { ok: true };
  }

  const body = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "auth-error", status: response.status, body };
  }
  return { ok: false, reason: "http-error", status: response.status, body };
}
