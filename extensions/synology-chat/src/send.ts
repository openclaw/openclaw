import { resolveSynologyChatAccount } from "./accounts.js";
import { getSynologyChatRuntime } from "./runtime.js";
import type { CoreConfig, SynologyChatSendResult } from "./types.js";

type SynologyChatSendOpts = {
  baseUrl?: string;
  token?: string;
  accountId?: string;
  verbose?: boolean;
};

export async function sendMessageSynologyChat(
  text: string,
  opts: SynologyChatSendOpts = {},
): Promise<SynologyChatSendResult> {
  const cfg = getSynologyChatRuntime().config.loadConfig() as CoreConfig;
  const account = resolveSynologyChatAccount({
    cfg,
    accountId: opts.accountId,
  });

  // Use incomingUrl if configured, otherwise construct from baseUrl and token
  let url: string;
  const token = opts.token?.trim() ?? account.token;

  if (account.incomingUrl) {
    // Use the full incoming URL directly
    url = account.incomingUrl;
  } else {
    const baseUrl = opts.baseUrl?.trim() ?? account.baseUrl;
    if (!baseUrl) {
      throw new Error(
        `Synology Chat baseUrl missing for account "${account.accountId}" (set channels.synology-chat.baseUrl or incomingUrl).`,
      );
    }
    if (!token) {
      throw new Error(
        `Synology Chat token missing for account "${account.accountId}" (set channels.synology-chat.token or SYNOLOGY_CHAT_TOKEN).`,
      );
    }
    // Construct URL from baseUrl and token
    const encodedToken = encodeURIComponent(`"${token}"`);
    url = `${baseUrl}/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=${encodedToken}`;
  }

  if (!text?.trim()) {
    throw new Error("Message must be non-empty for Synology Chat sends");
  }

  const tableMode = getSynologyChatRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "synology-chat",
    accountId: account.accountId,
  });
  const message = getSynologyChatRuntime().channel.text.convertMarkdownTables(
    text.trim(),
    tableMode,
  );

  // Synology expects the payload as form-urlencoded with a "payload" field containing JSON
  const payload = JSON.stringify({ text: message });
  const formBody = `payload=${encodeURIComponent(payload)}`;

  // Build fetch options
  const fetchOptions: RequestInit & { agent?: unknown } = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody,
  };

  // Handle insecure SSL (for self-signed certificates)
  if (account.allowInsecureSsl && url.startsWith("https:")) {
    // Use undici's Agent for Node.js 18+ to disable TLS verification
    try {
      const { Agent } = await import("undici");
      fetchOptions.agent = new Agent({
        connect: {
          rejectUnauthorized: false,
        },
      });
    } catch {
      // undici not available, try Node.js https agent
      // Note: Node.js native fetch doesn't support agent option directly
      console.warn("[synology-chat] Cannot disable SSL verification - undici not available");
    }
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const status = response.status;
    let errorMsg = `Synology Chat send failed (${status})`;

    if (status === 400) {
      errorMsg = `Synology Chat: bad request - ${errorBody || "invalid message format"}`;
    } else if (status === 401 || status === 403) {
      errorMsg = "Synology Chat: authentication failed - check webhook token";
    } else if (status === 404) {
      errorMsg = `Synology Chat: webhook not found - check incomingUrl`;
    } else if (errorBody) {
      errorMsg = `Synology Chat send failed: ${errorBody}`;
    }

    throw new Error(errorMsg);
  }

  // Parse response
  let success = false;
  let messageId: string | undefined;
  let timestamp: number | undefined;

  try {
    const data = (await response.json()) as {
      success?: boolean;
      data?: {
        message_id?: string | number;
        timestamp?: number;
      };
    };
    success = data.success ?? true;
    if (data.data?.message_id != null) {
      messageId = String(data.data.message_id);
    }
    if (typeof data.data?.timestamp === "number") {
      timestamp = data.data.timestamp;
    }
  } catch {
    // Response parsing failed, but message might have been sent
    success = true;
  }

  if (opts.verbose) {
    console.log(`[synology-chat] Sent message ${messageId ?? "unknown"}`);
  }

  getSynologyChatRuntime().channel.activity.record({
    channel: "synology-chat",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { success, messageId, timestamp };
}
