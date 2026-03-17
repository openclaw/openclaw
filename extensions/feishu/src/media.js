import fs from "fs";
import path from "path";
import { withTempDownloadPath } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { getFeishuRuntime } from "./runtime.js";
import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";
import { resolveFeishuSendTarget } from "./send-target.js";
const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 12e4;
function createConfiguredFeishuMediaClient(params) {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  return {
    account,
    client: createFeishuClient({
      ...account,
      httpTimeoutMs: FEISHU_MEDIA_HTTP_TIMEOUT_MS
    })
  };
}
function extractFeishuUploadKey(response, params) {
  const responseAny = response;
  if (responseAny.code !== void 0 && responseAny.code !== 0) {
    throw new Error(`${params.errorPrefix}: ${responseAny.msg || `code ${responseAny.code}`}`);
  }
  const key = responseAny[params.key] ?? responseAny.data?.[params.key];
  if (!key) {
    throw new Error(`${params.errorPrefix}: no ${params.key} returned`);
  }
  return key;
}
async function readFeishuResponseBuffer(params) {
  const { response } = params;
  const responseAny = response;
  if (responseAny.code !== void 0 && responseAny.code !== 0) {
    throw new Error(`${params.errorPrefix}: ${responseAny.msg || `code ${responseAny.code}`}`);
  }
  if (Buffer.isBuffer(response)) {
    return response;
  }
  if (response instanceof ArrayBuffer) {
    return Buffer.from(response);
  }
  if (responseAny.data && Buffer.isBuffer(responseAny.data)) {
    return responseAny.data;
  }
  if (responseAny.data instanceof ArrayBuffer) {
    return Buffer.from(responseAny.data);
  }
  if (typeof responseAny.getReadableStream === "function") {
    const stream = responseAny.getReadableStream();
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof responseAny.writeFile === "function") {
    return await withTempDownloadPath({ prefix: params.tmpDirPrefix }, async (tmpPath) => {
      await responseAny.writeFile(tmpPath);
      return await fs.promises.readFile(tmpPath);
    });
  }
  if (typeof responseAny[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of responseAny) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof responseAny.read === "function") {
    const chunks = [];
    for await (const chunk of responseAny) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  const keys = Object.keys(responseAny);
  const types = keys.map((k) => `${k}: ${typeof responseAny[k]}`).join(", ");
  throw new Error(`${params.errorPrefix}: unexpected response format. Keys: [${types}]`);
}
async function downloadImageFeishu(params) {
  const { cfg, imageKey, accountId } = params;
  const normalizedImageKey = normalizeFeishuExternalKey(imageKey);
  if (!normalizedImageKey) {
    throw new Error("Feishu image download failed: invalid image_key");
  }
  const { client } = createConfiguredFeishuMediaClient({ cfg, accountId });
  const response = await client.im.image.get({
    path: { image_key: normalizedImageKey }
  });
  const buffer = await readFeishuResponseBuffer({
    response,
    tmpDirPrefix: "openclaw-feishu-img-",
    errorPrefix: "Feishu image download failed"
  });
  return { buffer };
}
async function downloadMessageResourceFeishu(params) {
  const { cfg, messageId, fileKey, type, accountId } = params;
  const normalizedFileKey = normalizeFeishuExternalKey(fileKey);
  if (!normalizedFileKey) {
    throw new Error("Feishu message resource download failed: invalid file_key");
  }
  const { client } = createConfiguredFeishuMediaClient({ cfg, accountId });
  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: normalizedFileKey },
    params: { type }
  });
  const buffer = await readFeishuResponseBuffer({
    response,
    tmpDirPrefix: "openclaw-feishu-resource-",
    errorPrefix: "Feishu message resource download failed"
  });
  return { buffer };
}
async function uploadImageFeishu(params) {
  const { cfg, image, imageType = "message", accountId } = params;
  const { client } = createConfiguredFeishuMediaClient({ cfg, accountId });
  const imageData = typeof image === "string" ? fs.createReadStream(image) : image;
  const response = await client.im.image.create({
    data: {
      image_type: imageType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK accepts Buffer or ReadStream
      image: imageData
    }
  });
  return {
    imageKey: extractFeishuUploadKey(response, {
      key: "image_key",
      errorPrefix: "Feishu image upload failed"
    })
  };
}
function sanitizeFileNameForUpload(fileName) {
  return fileName.replace(/[\x00-\x1F\x7F\r\n"\\]/g, "_");
}
async function uploadFileFeishu(params) {
  const { cfg, file, fileName, fileType, duration, accountId } = params;
  const { client } = createConfiguredFeishuMediaClient({ cfg, accountId });
  const fileData = typeof file === "string" ? fs.createReadStream(file) : file;
  const safeFileName = sanitizeFileNameForUpload(fileName);
  const response = await client.im.file.create({
    data: {
      file_type: fileType,
      file_name: safeFileName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK accepts Buffer or ReadStream
      file: fileData,
      ...duration !== void 0 && { duration }
    }
  });
  return {
    fileKey: extractFeishuUploadKey(response, {
      key: "file_key",
      errorPrefix: "Feishu file upload failed"
    })
  };
}
async function sendImageFeishu(params) {
  const { cfg, to, imageKey, replyToMessageId, replyInThread, accountId } = params;
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
    cfg,
    to,
    accountId
  });
  const content = JSON.stringify({ image_key: imageKey });
  if (replyToMessageId) {
    const response2 = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: "image",
        ...replyInThread ? { reply_in_thread: true } : {}
      }
    });
    assertFeishuMessageApiSuccess(response2, "Feishu image reply failed");
    return toFeishuSendResult(response2, receiveId);
  }
  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "image"
    }
  });
  assertFeishuMessageApiSuccess(response, "Feishu image send failed");
  return toFeishuSendResult(response, receiveId);
}
async function sendFileFeishu(params) {
  const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
  const msgType = params.msgType ?? "file";
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
    cfg,
    to,
    accountId
  });
  const content = JSON.stringify({ file_key: fileKey });
  if (replyToMessageId) {
    const response2 = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: msgType,
        ...replyInThread ? { reply_in_thread: true } : {}
      }
    });
    assertFeishuMessageApiSuccess(response2, "Feishu file reply failed");
    return toFeishuSendResult(response2, receiveId);
  }
  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: msgType
    }
  });
  assertFeishuMessageApiSuccess(response, "Feishu file send failed");
  return toFeishuSendResult(response, receiveId);
}
function detectFileType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".opus":
    case ".ogg":
      return "opus";
    case ".mp4":
    case ".mov":
    case ".avi":
      return "mp4";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}
async function sendMediaFeishu(params) {
  const {
    cfg,
    to,
    mediaUrl,
    mediaBuffer,
    fileName,
    replyToMessageId,
    replyInThread,
    accountId,
    mediaLocalRoots
  } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  const mediaMaxBytes = (account.config?.mediaMaxMb ?? 30) * 1024 * 1024;
  let buffer;
  let name;
  if (mediaBuffer) {
    buffer = mediaBuffer;
    name = fileName ?? "file";
  } else if (mediaUrl) {
    const loaded = await getFeishuRuntime().media.loadWebMedia(mediaUrl, {
      maxBytes: mediaMaxBytes,
      optimizeImages: false,
      localRoots: mediaLocalRoots?.length ? mediaLocalRoots : void 0
    });
    buffer = loaded.buffer;
    name = fileName ?? loaded.fileName ?? "file";
  } else {
    throw new Error("Either mediaUrl or mediaBuffer must be provided");
  }
  const ext = path.extname(name).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(ext);
  if (isImage) {
    const { imageKey } = await uploadImageFeishu({ cfg, image: buffer, accountId });
    return sendImageFeishu({ cfg, to, imageKey, replyToMessageId, replyInThread, accountId });
  } else {
    const fileType = detectFileType(name);
    const { fileKey } = await uploadFileFeishu({
      cfg,
      file: buffer,
      fileName: name,
      fileType,
      accountId
    });
    const msgType = fileType === "opus" ? "audio" : fileType === "mp4" ? "media" : "file";
    return sendFileFeishu({
      cfg,
      to,
      fileKey,
      msgType,
      replyToMessageId,
      replyInThread,
      accountId
    });
  }
}
export {
  detectFileType,
  downloadImageFeishu,
  downloadMessageResourceFeishu,
  sanitizeFileNameForUpload,
  sendFileFeishu,
  sendImageFeishu,
  sendMediaFeishu,
  uploadFileFeishu,
  uploadImageFeishu
};
