/**
 * WeCom Agent API Client
 * Manages AccessToken caching and API calls for self-built applications.
 */

import crypto from "node:crypto";
import { logger } from "../logger.js";
import {
  AGENT_API_ENDPOINTS,
  AGENT_API_REQUEST_TIMEOUT_MS,
  TOKEN_REFRESH_BUFFER_MS,
} from "./constants.js";

/**
 * Token cache: Map<corpId:agentId, { token, expiresAt, refreshPromise }>
 */
const tokenCaches = new Map();

/**
 * Get a valid AccessToken, with caching and concurrent-refresh protection.
 * @param {object} agent - { corpId, corpSecret, agentId }
 * @returns {Promise<string>}
 */
export async function getAccessToken(agent) {
  const cacheKey = `${agent.corpId}:${agent.agentId}`;
  let cache = tokenCaches.get(cacheKey);

  if (!cache) {
    cache = { token: "", expiresAt: 0, refreshPromise: null };
    tokenCaches.set(cacheKey, cache);
  }

  const now = Date.now();
  if (cache.token && cache.expiresAt > now + TOKEN_REFRESH_BUFFER_MS) {
    return cache.token;
  }

  // Reuse in-flight refresh to prevent concurrent token requests.
  if (cache.refreshPromise) {
    return cache.refreshPromise;
  }

  cache.refreshPromise = (async () => {
    try {
      const url = `${AGENT_API_ENDPOINTS.GET_TOKEN}?corpid=${encodeURIComponent(agent.corpId)}&corpsecret=${encodeURIComponent(agent.corpSecret)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS) });
      const json = await res.json();

      if (!json?.access_token) {
        throw new Error(`gettoken failed: ${json?.errcode} ${json?.errmsg}`);
      }

      cache.token = json.access_token;
      cache.expiresAt = Date.now() + (json.expires_in ?? 7200) * 1000;
      return cache.token;
    } finally {
      cache.refreshPromise = null;
    }
  })();

  return cache.refreshPromise;
}

/**
 * Send a text message via Agent API.
 *
 * Uses `message/send` for user/party/tag targets, `appchat/send` for group chats.
 *
 * @param {object} params
 * @param {object} params.agent  - { corpId, corpSecret, agentId }
 * @param {string} [params.toUser]
 * @param {string} [params.toParty]
 * @param {string} [params.toTag]
 * @param {string} [params.chatId]
 * @param {string} params.text
 */
export async function agentSendText(params) {
  const { agent, toUser, toParty, toTag, chatId, text } = params;
  const token = await getAccessToken(agent);

  const useChat = Boolean(chatId);
  const url = useChat
    ? `${AGENT_API_ENDPOINTS.SEND_APPCHAT}?access_token=${encodeURIComponent(token)}`
    : `${AGENT_API_ENDPOINTS.SEND_MESSAGE}?access_token=${encodeURIComponent(token)}`;

  const body = useChat
    ? { chatid: chatId, msgtype: "text", text: { content: text } }
    : {
        touser: toUser,
        toparty: toParty,
        totag: toTag,
        msgtype: "text",
        agentid: agent.agentId,
        text: { content: text },
      };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
  });
  const json = await res.json();

  if (json?.errcode !== 0) {
    throw new Error(`agent send text failed: ${json?.errcode} ${json?.errmsg}`);
  }

  if (json?.invaliduser || json?.invalidparty || json?.invalidtag) {
    const details = [
      json.invaliduser ? `invaliduser=${json.invaliduser}` : "",
      json.invalidparty ? `invalidparty=${json.invalidparty}` : "",
      json.invalidtag ? `invalidtag=${json.invalidtag}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(`agent send text partial failure: ${details}`);
  }
}

/**
 * Upload a temporary media file to WeCom.
 *
 * @param {object} params
 * @param {object} params.agent   - { corpId, corpSecret, agentId }
 * @param {"image"|"voice"|"video"|"file"} params.type
 * @param {Buffer} params.buffer
 * @param {string} params.filename
 * @returns {Promise<string>} media_id
 */
export async function agentUploadMedia(params) {
  const { agent, type, buffer, filename } = params;
  const token = await getAccessToken(agent);
  const url = `${AGENT_API_ENDPOINTS.UPLOAD_MEDIA}?access_token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}`;

  // Manually construct multipart/form-data (no extra dependencies).
  const boundary = `----WebKitFormBoundary${crypto.randomBytes(16).toString("hex")}`;

  const contentTypeMap = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    bmp: "image/bmp",
    amr: "voice/amr",
    mp4: "video/mp4",
  };
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const fileContentType = contentTypeMap[ext] || "application/octet-stream";

  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${filename}"; filelength=${buffer.length}\r\n` +
      `Content-Type: ${fileContentType}\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
    signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
  });
  const json = await res.json();

  if (!json?.media_id) {
    throw new Error(`agent upload media failed: ${json?.errcode} ${json?.errmsg}`);
  }
  return json.media_id;
}

/**
 * Send a media message (image/voice/video/file) via Agent API.
 *
 * @param {object} params
 * @param {object} params.agent
 * @param {string} [params.toUser]
 * @param {string} [params.toParty]
 * @param {string} [params.toTag]
 * @param {string} [params.chatId]
 * @param {string} params.mediaId
 * @param {"image"|"voice"|"video"|"file"} params.mediaType
 */
export async function agentSendMedia(params) {
  const { agent, toUser, toParty, toTag, chatId, mediaId, mediaType } = params;
  const token = await getAccessToken(agent);

  const useChat = Boolean(chatId);
  const url = useChat
    ? `${AGENT_API_ENDPOINTS.SEND_APPCHAT}?access_token=${encodeURIComponent(token)}`
    : `${AGENT_API_ENDPOINTS.SEND_MESSAGE}?access_token=${encodeURIComponent(token)}`;

  const mediaPayload = { media_id: mediaId };
  const body = useChat
    ? { chatid: chatId, msgtype: mediaType, [mediaType]: mediaPayload }
    : {
        touser: toUser,
        toparty: toParty,
        totag: toTag,
        msgtype: mediaType,
        agentid: agent.agentId,
        [mediaType]: mediaPayload,
      };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
  });
  const json = await res.json();

  if (json?.errcode !== 0) {
    throw new Error(`agent send ${mediaType} failed: ${json?.errcode} ${json?.errmsg}`);
  }
}

/**
 * Download a temporary media file from WeCom by media_id.
 *
 * @param {object} params
 * @param {object} params.agent
 * @param {string} params.mediaId
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function agentDownloadMedia(params) {
  const { agent, mediaId } = params;
  const token = await getAccessToken(agent);
  const url = `${AGENT_API_ENDPOINTS.DOWNLOAD_MEDIA}?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS) });

  if (!res.ok) {
    throw new Error(`agent download media failed: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "application/octet-stream";

  // WeCom may return an error JSON body instead of binary media.
  if (contentType.includes("application/json")) {
    const json = await res.json();
    throw new Error(`agent download media failed: ${json?.errcode} ${json?.errmsg}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), contentType };
}
