import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl } from "./types.js";
function resolveAccount(params) {
  return resolveBlueBubblesServerAccount(params);
}
const MAX_HISTORY_FETCH_LIMIT = 100;
const HISTORY_SCAN_MULTIPLIER = 8;
const MAX_HISTORY_SCAN_MESSAGES = 500;
const MAX_HISTORY_BODY_CHARS = 2e3;
function clampHistoryLimit(limit) {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  const normalized = Math.floor(limit);
  if (normalized <= 0) {
    return 0;
  }
  return Math.min(normalized, MAX_HISTORY_FETCH_LIMIT);
}
function truncateHistoryBody(text) {
  if (text.length <= MAX_HISTORY_BODY_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_HISTORY_BODY_CHARS).trimEnd()}...`;
}
async function fetchBlueBubblesHistory(chatIdentifier, limit, opts = {}) {
  const effectiveLimit = clampHistoryLimit(limit);
  if (!chatIdentifier.trim() || effectiveLimit <= 0) {
    return { entries: [], resolved: true };
  }
  let baseUrl;
  let password;
  try {
    ({ baseUrl, password } = resolveAccount(opts));
  } catch {
    return { entries: [], resolved: false };
  }
  const possiblePaths = [
    `/api/v1/chat/${encodeURIComponent(chatIdentifier)}/messages?limit=${effectiveLimit}&sort=DESC`,
    `/api/v1/messages?chatGuid=${encodeURIComponent(chatIdentifier)}&limit=${effectiveLimit}`,
    `/api/v1/chat/${encodeURIComponent(chatIdentifier)}/message?limit=${effectiveLimit}`
  ];
  for (const path of possiblePaths) {
    try {
      const url = buildBlueBubblesApiUrl({ baseUrl, path, password });
      const res = await blueBubblesFetchWithTimeout(
        url,
        { method: "GET" },
        opts.timeoutMs ?? 1e4
      );
      if (!res.ok) {
        continue;
      }
      const data = await res.json().catch(() => null);
      if (!data) {
        continue;
      }
      let messages = [];
      if (Array.isArray(data)) {
        messages = data;
      } else if (data.data && Array.isArray(data.data)) {
        messages = data.data;
      } else if (data.messages && Array.isArray(data.messages)) {
        messages = data.messages;
      } else {
        continue;
      }
      const historyEntries = [];
      const maxScannedMessages = Math.min(
        Math.max(effectiveLimit * HISTORY_SCAN_MULTIPLIER, effectiveLimit),
        MAX_HISTORY_SCAN_MESSAGES
      );
      for (let i = 0; i < messages.length && i < maxScannedMessages; i++) {
        const item = messages[i];
        const msg = item;
        const text = msg.text?.trim();
        if (!text) {
          continue;
        }
        const sender = msg.is_from_me ? "me" : msg.sender?.display_name || msg.sender?.address || msg.handle_id || "Unknown";
        const timestamp = msg.date_created || msg.date_delivered;
        historyEntries.push({
          sender,
          body: truncateHistoryBody(text),
          timestamp,
          messageId: msg.guid
        });
      }
      historyEntries.sort((a, b) => {
        const aTime = a.timestamp || 0;
        const bTime = b.timestamp || 0;
        return aTime - bTime;
      });
      return {
        entries: historyEntries.slice(0, effectiveLimit),
        // Ensure we don't exceed the requested limit
        resolved: true
      };
    } catch (error) {
      continue;
    }
  }
  return { entries: [], resolved: false };
}
export {
  fetchBlueBubblesHistory
};
