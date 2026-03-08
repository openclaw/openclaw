/**
 * WeCom Webhook Bot Client
 *
 * Sends messages to WeCom group chats via Webhook Bot URLs.
 * No token management required — the key is embedded in the URL.
 *
 * Supported message types: text, markdown, image (base64), file (media_id).
 */

import crypto from "node:crypto";
import { logger } from "../logger.js";
import { AGENT_API_REQUEST_TIMEOUT_MS } from "./constants.js";

/**
 * Send a text message via Webhook Bot.
 *
 * @param {object} params
 * @param {string} params.url              - Full webhook URL (with key)
 * @param {string} params.content          - Text content
 * @param {string[]} [params.mentionedList]       - User IDs to @mention ("@all" for everyone)
 * @param {string[]} [params.mentionedMobileList] - Mobile numbers to @mention
 */
export async function webhookSendText({ url, content, mentionedList, mentionedMobileList }) {
  const body = {
    msgtype: "text",
    text: {
      content,
      ...(mentionedList && { mentioned_list: mentionedList }),
      ...(mentionedMobileList && { mentioned_mobile_list: mentionedMobileList }),
    },
  };
  await postWebhook(url, body);
}

/**
 * Send a markdown message via Webhook Bot.
 *
 * @param {object} params
 * @param {string} params.url     - Full webhook URL (with key)
 * @param {string} params.content - Markdown content
 */
export async function webhookSendMarkdown({ url, content }) {
  const body = {
    msgtype: "markdown",
    markdown: { content },
  };
  await postWebhook(url, body);
}

/**
 * Send an image via Webhook Bot (base64-encoded).
 *
 * @param {object} params
 * @param {string} params.url    - Full webhook URL (with key)
 * @param {string} params.base64 - Base64-encoded image data
 * @param {string} params.md5    - MD5 hash of the image
 */
export async function webhookSendImage({ url, base64, md5 }) {
  const body = {
    msgtype: "image",
    image: { base64, md5 },
  };
  await postWebhook(url, body);
}

/**
 * Upload a file via Webhook Bot and return its media_id.
 *
 * @param {object} params
 * @param {string} params.url      - Full webhook URL (with key). The key is extracted
 *                                   and used with the upload endpoint.
 * @param {Buffer} params.buffer   - File content
 * @param {string} params.filename - File name
 * @returns {Promise<string>} media_id
 */
export async function webhookUploadFile({ url, buffer, filename }) {
  const key = extractKey(url);
  const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=${encodeURIComponent(key)}&type=file`;

  const boundary = `----WebKitFormBoundary${crypto.randomBytes(16).toString("hex")}`;
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${filename}"; filelength=${buffer.length}\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const multipartBody = Buffer.concat([header, buffer, footer]);

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(multipartBody.length),
    },
    body: multipartBody,
    signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
  });
  const json = await res.json();

  if (!json?.media_id) {
    throw new Error(`webhook upload file failed: ${json?.errcode} ${json?.errmsg}`);
  }
  return json.media_id;
}

/**
 * Send a file message via Webhook Bot (requires a pre-uploaded media_id).
 *
 * @param {object} params
 * @param {string} params.url     - Full webhook URL (with key)
 * @param {string} params.mediaId - media_id from webhookUploadFile
 */
export async function webhookSendFile({ url, mediaId }) {
  const body = {
    msgtype: "file",
    file: { media_id: mediaId },
  };
  await postWebhook(url, body);
}

// ── Internals ──────────────────────────────────────────────────────────

/**
 * Extract the `key` query parameter from a webhook URL.
 */
function extractKey(url) {
  try {
    const parsed = new URL(url);
    const key = parsed.searchParams.get("key");
    if (!key) throw new Error("missing key in webhook URL");
    return key;
  } catch (err) {
    throw new Error(`invalid webhook URL: ${err.message}`);
  }
}

/**
 * POST a JSON payload to the webhook endpoint and validate the response.
 */
async function postWebhook(url, body) {
  logger.debug("Webhook bot POST", { url: url.substring(0, 60), msgtype: body.msgtype });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
  });
  const json = await res.json();

  if (json?.errcode !== 0) {
    throw new Error(`webhook bot send failed: ${json?.errcode} ${json?.errmsg}`);
  }
  return json;
}
