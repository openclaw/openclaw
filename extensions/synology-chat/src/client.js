import * as http from "node:http";
import * as https from "node:https";
const MIN_SEND_INTERVAL_MS = 500;
let lastSendTime = 0;
const chatUserCache = /* @__PURE__ */ new Map();
const CACHE_TTL_MS = 5 * 60 * 1e3;
async function sendMessage(incomingUrl, text, userId, allowInsecureSsl = true) {
  const body = buildWebhookBody({ text }, userId);
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < MIN_SEND_INTERVAL_MS) {
    await sleep(MIN_SEND_INTERVAL_MS - elapsed);
  }
  const maxRetries = 3;
  const baseDelay = 300;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const ok = await doPost(incomingUrl, body, allowInsecureSsl);
      lastSendTime = Date.now();
      if (ok) return true;
    } catch {
    }
    if (attempt < maxRetries - 1) {
      await sleep(baseDelay * Math.pow(2, attempt));
    }
  }
  return false;
}
async function sendFileUrl(incomingUrl, fileUrl, userId, allowInsecureSsl = true) {
  const body = buildWebhookBody({ file_url: fileUrl }, userId);
  try {
    const ok = await doPost(incomingUrl, body, allowInsecureSsl);
    lastSendTime = Date.now();
    return ok;
  } catch {
    return false;
  }
}
async function fetchChatUsers(incomingUrl, allowInsecureSsl = true, log) {
  const now = Date.now();
  const listUrl = incomingUrl.replace(/method=\w+/, "method=user_list");
  const cached = chatUserCache.get(listUrl);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.users;
  }
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(listUrl);
    } catch {
      log?.warn("fetchChatUsers: invalid user_list URL, using cached data");
      resolve(cached?.users ?? []);
      return;
    }
    const transport = parsedUrl.protocol === "https:" ? https : http;
    transport.get(listUrl, { rejectUnauthorized: !allowInsecureSsl }, (res) => {
      let data = "";
      res.on("data", (c) => {
        data += c.toString();
      });
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (result.success && result.data?.users) {
            const users = result.data.users.map((u) => ({
              user_id: u.user_id,
              username: u.username || "",
              nickname: u.nickname || ""
            }));
            chatUserCache.set(listUrl, {
              users,
              cachedAt: now
            });
            resolve(users);
          } else {
            log?.warn(
              `fetchChatUsers: API returned success=${result.success}, using cached data`
            );
            resolve(cached?.users ?? []);
          }
        } catch {
          log?.warn("fetchChatUsers: failed to parse user_list response");
          resolve(cached?.users ?? []);
        }
      });
    }).on("error", (err) => {
      log?.warn(`fetchChatUsers: HTTP error \u2014 ${err instanceof Error ? err.message : err}`);
      resolve(cached?.users ?? []);
    });
  });
}
async function resolveChatUserId(incomingUrl, webhookUsername, allowInsecureSsl = true, log) {
  const users = await fetchChatUsers(incomingUrl, allowInsecureSsl, log);
  const lower = webhookUsername.toLowerCase();
  const byNickname = users.find((u) => u.nickname.toLowerCase() === lower);
  if (byNickname) return byNickname.user_id;
  const byUsername = users.find((u) => u.username.toLowerCase() === lower);
  if (byUsername) return byUsername.user_id;
  return void 0;
}
function buildWebhookBody(payload, userId) {
  const numericId = parseNumericUserId(userId);
  if (numericId !== void 0) {
    payload.user_ids = [numericId];
  }
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}
function parseNumericUserId(userId) {
  if (userId === void 0) {
    return void 0;
  }
  const numericId = typeof userId === "number" ? userId : parseInt(userId, 10);
  return Number.isNaN(numericId) ? void 0 : numericId;
}
function doPost(url, body, allowInsecureSsl = true) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body)
        },
        timeout: 3e4,
        // Synology NAS may use self-signed certs on local network.
        // Set allowInsecureSsl: true in channel config to skip verification.
        rejectUnauthorized: !allowInsecureSsl
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve(res.statusCode === 200);
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.write(body);
    req.end();
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export {
  fetchChatUsers,
  resolveChatUserId,
  sendFileUrl,
  sendMessage
};
