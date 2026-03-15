import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import crypto from "node:crypto";
import { logger } from "../logger.js";
import { createUploadTicket } from "./upload-ticket.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_BASE_DIR = join(
  process.env.HOME || "/tmp",
  ".openclaw",
  "media",
  "wecom-upload",
);

// ---------------------------------------------------------------------------
// Per-IP rate limiter (applies to both GET and POST endpoints)
// Allows max UPLOAD_RATE_MAX requests per UPLOAD_RATE_WINDOW_MS per IP.
// Uses a Map<ip, { count, resetAt }> so callers can check resetAt easily.
// Expired entries are pruned every 5 minutes to prevent unbounded growth.
// ---------------------------------------------------------------------------
const UPLOAD_RATE_WINDOW_MS = 60_000; // 1 minute
const UPLOAD_RATE_MAX = 10; // max requests per window per IP
const uploadRateBuckets = new Map();

// Periodic cleanup: remove buckets whose window has already expired.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of uploadRateBuckets) {
    if (now >= bucket.resetAt) {
      uploadRateBuckets.delete(ip);
    }
  }
}, 5 * 60_000).unref(); // .unref() so this timer won't keep the process alive

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function isUploadRateLimited(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  let bucket = uploadRateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    // Start a fresh window for this IP
    bucket = { count: 0, resetAt: now + UPLOAD_RATE_WINDOW_MS };
    uploadRateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count > UPLOAD_RATE_MAX;
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeFileName(name) {
  const safe = basename(String(name || "upload.bin")).replace(
    /[^a-zA-Z0-9._-\u4e00-\u9fa5]/g,
    "_",
  );
  return safe || "upload.bin";
}

function parseBoundary(contentType) {
  const match = String(contentType || "").match(/boundary=([^;]+)/i);
  return match ? match[1].trim().replace(/^"|"$/g, "") : "";
}

function parseMultipartBody(buffer, boundary) {
  const raw = buffer.toString("latin1");
  const token = `--${boundary}`;
  const segments = raw.split(token).slice(1, -1);
  const fields = {};
  const files = [];

  for (let segment of segments) {
    segment = segment.replace(/^\r\n/, "");
    segment = segment.replace(/\r\n$/, "");
    if (!segment) continue;

    const sep = segment.indexOf("\r\n\r\n");
    if (sep < 0) continue;

    const headerText = segment.slice(0, sep);
    let bodyText = segment.slice(sep + 4);
    if (bodyText.endsWith("\r\n")) bodyText = bodyText.slice(0, -2);

    const headerLines = headerText.split("\r\n");
    const disposition = headerLines.find((line) =>
      /^content-disposition:/i.test(line),
    );
    if (!disposition) continue;

    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    const fieldName = nameMatch?.[1] || "";
    if (!fieldName) continue;

    const contentTypeLine = headerLines.find((line) =>
      /^content-type:/i.test(line),
    );
    const partContentType =
      contentTypeLine?.split(":")[1]?.trim() || "application/octet-stream";

    if (filenameMatch) {
      files.push({
        fieldName,
        originalName: filenameMatch[1] || "upload.bin",
        contentType: partContentType,
        buffer: Buffer.from(bodyText, "latin1"),
      });
    } else {
      fields[fieldName] = Buffer.from(bodyText, "latin1").toString("utf8");
    }
  }

  return { fields, files };
}

async function readBodyBuffer(req, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("payload_too_large");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function renderFormPage({
  userId = "",
  note = "",
  message = "",
  error = "",
  command = "",
  code = "",
}) {
  const msgBlock = error
    ? `<div class="alert error">${escapeHtml(error)}</div>`
    : message
      ? `<div class="alert success">${escapeHtml(message)}</div>`
      : "";

  const resultBlock = code
    ? `<div class="result">
         <h3>上传成功</h3>
         <p>取件码：<code>${escapeHtml(code)}</code></p>
         <p>在企业微信里给莱财发送：</p>
         <pre>${escapeHtml(command)}</pre>
         <p class="tip">提示：取件码 2 小时内有效，仅可使用一次。</p>
       </div>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>莱财文件上传</title>
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; background:#f5f7fb; margin:0; }
    .wrap { max-width: 760px; margin: 32px auto; background:#fff; border-radius: 14px; box-shadow: 0 8px 24px rgba(0,0,0,.08); padding: 28px; }
    h1 { margin:0 0 8px; font-size:26px; }
    p.desc { margin:0 0 22px; color:#555; }
    label { display:block; margin:14px 0 6px; font-weight:600; }
    input[type=text], textarea, input[type=file] { width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid #d0d7e2; border-radius:8px; font-size:15px; }
    textarea { min-height: 90px; resize: vertical; }
    button { margin-top:18px; background:#1677ff; color:#fff; border:none; border-radius:8px; padding:10px 18px; font-size:15px; cursor:pointer; }
    button:hover { background:#0f66db; }
    .tip { color:#6b7280; font-size:13px; }
    .alert { margin: 12px 0; padding: 10px 12px; border-radius: 8px; }
    .alert.success { background:#e8f8ee; color:#137333; border:1px solid #b7e1c0; }
    .alert.error { background:#fdecec; color:#a61b1b; border:1px solid #f4c7c7; }
    .result { margin-top:18px; border:1px dashed #b3c5e7; background:#f8fbff; border-radius:10px; padding:14px; }
    code, pre { background:#eef3ff; padding:2px 6px; border-radius:6px; }
    pre { white-space:pre-wrap; padding:10px; }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>莱财文件上传</h1>
    <p class="desc">企业微信聊天暂不支持把文件直接回调给 AI。请在这里上传，再把取件码发给莱财。</p>
    ${msgBlock}
    ${resultBlock}
    <form method="post" enctype="multipart/form-data">
      <label>企业微信 UserID（可选）</label>
      <input type="text" name="userId" value="${escapeHtml(userId)}" placeholder="例如 JuMinHan；留空表示任何人都能用取件码" />

      <label>备注（可选）</label>
      <textarea name="note" placeholder="例如：这是 2 月对账单模板">${escapeHtml(note)}</textarea>

      <label>选择文件（最大 25MB）</label>
      <input type="file" name="file" required />

      <button type="submit">上传并生成取件码</button>
      <p class="tip">上传完成后，把页面里的「取件 xxx」发送给莱财即可。</p>
    </form>
  </main>
</body>
</html>`;
}

async function saveUploadedFile(file) {
  const now = new Date();
  const dateFolder = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dayDir = join(UPLOAD_BASE_DIR, dateFolder);
  await fs.mkdir(dayDir, { recursive: true });

  const safeName = sanitizeFileName(file.originalName || "upload.bin");
  const ext = extname(safeName);
  const stem = safeName.slice(0, Math.max(1, safeName.length - ext.length));
  const random = crypto.randomBytes(4).toString("hex");
  const finalName = `${stem}_${Date.now()}_${random}${ext}`;
  const fullPath = join(dayDir, finalName);

  await fs.writeFile(fullPath, file.buffer);
  return { fullPath, safeName };
}

export async function wecomUploadHttpHandler(req, res) {
  const url = new URL(req.url || "", "http://localhost");
  if (!url.pathname.startsWith("/wecom/upload")) {
    return false;
  }

  if (req.method === "GET") {
    if (isUploadRateLimited(req)) {
      const html = renderFormPage({ error: "请求过于频繁，请稍后再试。" });
      res.writeHead(429, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return true;
    }
    const userId = url.searchParams.get("u") || "";
    const note = url.searchParams.get("note") || "";
    const html = renderFormPage({ userId, note });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return true;
  }

  // Authentication note: this endpoint intentionally does not require a
  // pre-upload auth token.  The upload-ticket system (upload-ticket.js) works
  // in the *opposite* direction — a pickup code (ticket) is *generated* by
  // this handler after a successful upload and is then redeemed inside the
  // WeCom bot chat via consumeUploadTicket().  The upload form is meant to be
  // accessible without login so that internal staff can send files to the bot
  // without needing a separate account.  The rate limiter below (10 req/min
  // per IP) and the 25 MB file-size cap are the primary DoS mitigations.

  if (isUploadRateLimited(req)) {
    const html = renderFormPage({ error: "上传过于频繁，请稍后再试。" });
    res.writeHead(429, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }

  try {
    const contentType = req.headers["content-type"] || "";
    const boundary = parseBoundary(contentType);
    if (!boundary) {
      const html = renderFormPage({
        error: "请求格式错误：未检测到 multipart boundary。",
      });
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return true;
    }

    const body = await readBodyBuffer(req, MAX_UPLOAD_BYTES + 1024 * 256);
    const { fields, files } = parseMultipartBody(body, boundary);
    const file = files.find((item) => item.fieldName === "file") || files[0];

    if (!file || !file.buffer || file.buffer.length === 0) {
      const html = renderFormPage({
        userId: fields.userId || "",
        note: fields.note || "",
        error: "请选择要上传的文件。",
      });
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return true;
    }

    if (file.buffer.length > MAX_UPLOAD_BYTES) {
      const html = renderFormPage({
        userId: fields.userId || "",
        note: fields.note || "",
        error: "文件太大，单文件上限为 25MB。",
      });
      res.writeHead(413, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return true;
    }

    const saved = await saveUploadedFile(file);
    const ownerUserId = String(fields.userId || "").trim();
    const note = String(fields.note || "").trim();
    const accountId = String(fields.accountId || "default").trim() || "default";

    const ticket = createUploadTicket({
      filePath: saved.fullPath,
      fileName: saved.safeName,
      mimeType: file.contentType,
      size: file.buffer.length,
      ownerUserId,
      accountId,
      note,
    });

    const command = note
      ? `取件 ${ticket.code} ${note}`
      : `取件 ${ticket.code}`;

    logger.info("[upload-route] upload accepted", {
      fileName: saved.safeName,
      bytes: file.buffer.length,
      ownerUserId: ownerUserId || "any",
      accountId,
      code: ticket.code,
    });

    const html = renderFormPage({
      userId: ownerUserId,
      note,
      message: "文件已上传，已生成取件码。",
      code: ticket.code,
      command,
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  } catch (err) {
    logger.error("[upload-route] upload failed", { error: err.message });

    let errorText = "上传失败，请稍后重试。";
    if (err.message === "payload_too_large") {
      errorText = "请求体过大，单文件上限为 25MB。";
    }

    const html = renderFormPage({ error: errorText });
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }
}
