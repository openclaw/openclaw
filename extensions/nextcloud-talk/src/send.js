import { resolveNextcloudTalkAccount } from "./accounts.js";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { generateNextcloudTalkSignature } from "./signature.js";
function resolveCredentials(explicit, account) {
  const baseUrl = explicit.baseUrl?.trim() ?? account.baseUrl;
  const secret = explicit.secret?.trim() ?? account.secret;
  if (!baseUrl) {
    throw new Error(
      `Nextcloud Talk baseUrl missing for account "${account.accountId}" (set channels.nextcloud-talk.baseUrl).`
    );
  }
  if (!secret) {
    throw new Error(
      `Nextcloud Talk bot secret missing for account "${account.accountId}" (set channels.nextcloud-talk.botSecret/botSecretFile or NEXTCLOUD_TALK_BOT_SECRET for default).`
    );
  }
  return { baseUrl, secret };
}
function normalizeRoomToken(to) {
  const normalized = stripNextcloudTalkTargetPrefix(to);
  if (!normalized) {
    throw new Error("Room token is required for Nextcloud Talk sends");
  }
  return normalized;
}
function resolveNextcloudTalkSendContext(opts) {
  const cfg = opts.cfg ?? getNextcloudTalkRuntime().config.loadConfig();
  const account = resolveNextcloudTalkAccount({
    cfg,
    accountId: opts.accountId
  });
  const { baseUrl, secret } = resolveCredentials(
    { baseUrl: opts.baseUrl, secret: opts.secret },
    account
  );
  return { cfg, account, baseUrl, secret };
}
async function sendMessageNextcloudTalk(to, text, opts = {}) {
  const { cfg, account, baseUrl, secret } = resolveNextcloudTalkSendContext(opts);
  const roomToken = normalizeRoomToken(to);
  if (!text?.trim()) {
    throw new Error("Message must be non-empty for Nextcloud Talk sends");
  }
  const tableMode = getNextcloudTalkRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "nextcloud-talk",
    accountId: account.accountId
  });
  const message = getNextcloudTalkRuntime().channel.text.convertMarkdownTables(
    text.trim(),
    tableMode
  );
  const body = {
    message
  };
  if (opts.replyTo) {
    body.replyTo = opts.replyTo;
  }
  const bodyStr = JSON.stringify(body);
  const { random, signature } = generateNextcloudTalkSignature({
    body: message,
    secret
  });
  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${roomToken}/message`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OCS-APIRequest": "true",
      "X-Nextcloud-Talk-Bot-Random": random,
      "X-Nextcloud-Talk-Bot-Signature": signature
    },
    body: bodyStr
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const status = response.status;
    let errorMsg = `Nextcloud Talk send failed (${status})`;
    if (status === 400) {
      errorMsg = `Nextcloud Talk: bad request - ${errorBody || "invalid message format"}`;
    } else if (status === 401) {
      errorMsg = "Nextcloud Talk: authentication failed - check bot secret";
    } else if (status === 403) {
      errorMsg = "Nextcloud Talk: forbidden - bot may not have permission in this room";
    } else if (status === 404) {
      errorMsg = `Nextcloud Talk: room not found (token=${roomToken})`;
    } else if (errorBody) {
      errorMsg = `Nextcloud Talk send failed: ${errorBody}`;
    }
    throw new Error(errorMsg);
  }
  let messageId = "unknown";
  let timestamp;
  try {
    const data = await response.json();
    if (data.ocs?.data?.id != null) {
      messageId = String(data.ocs.data.id);
    }
    if (typeof data.ocs?.data?.timestamp === "number") {
      timestamp = data.ocs.data.timestamp;
    }
  } catch {
  }
  if (opts.verbose) {
    console.log(`[nextcloud-talk] Sent message ${messageId} to room ${roomToken}`);
  }
  getNextcloudTalkRuntime().channel.activity.record({
    channel: "nextcloud-talk",
    accountId: account.accountId,
    direction: "outbound"
  });
  return { messageId, roomToken, timestamp };
}
async function sendReactionNextcloudTalk(roomToken, messageId, reaction, opts = {}) {
  const { account, baseUrl, secret } = resolveNextcloudTalkSendContext(opts);
  const normalizedToken = normalizeRoomToken(roomToken);
  const body = JSON.stringify({ reaction });
  const { random, signature } = generateNextcloudTalkSignature({
    body: reaction,
    secret
  });
  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${normalizedToken}/reaction/${messageId}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OCS-APIRequest": "true",
      "X-Nextcloud-Talk-Bot-Random": random,
      "X-Nextcloud-Talk-Bot-Signature": signature
    },
    body
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Nextcloud Talk reaction failed: ${response.status} ${errorBody}`.trim());
  }
  return { ok: true };
}
export {
  sendMessageNextcloudTalk,
  sendReactionNextcloudTalk
};
