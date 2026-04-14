import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveRoamAccount } from "./accounts.js";
import { resolveApiBase } from "./api-base.js";
import { stripRoamTargetPrefix } from "./normalize.js";
import { getRoamRuntime } from "./runtime.js";
import type { CoreConfig, RoamSendResult } from "./types.js";

type RoamSendOpts = {
  apiKey?: string;
  accountId?: string;
  threadKey?: string;
  cfg?: CoreConfig;
};

function resolveCredentials(
  explicit: { apiKey?: string },
  account: { apiKey: string; accountId: string },
): { apiKey: string } {
  const apiKey = explicit.apiKey?.trim() ?? account.apiKey;
  if (!apiKey) {
    throw new Error(
      `Roam API key missing for account "${account.accountId}" (set channels.roam.apiKey or ROAM_API_KEY for default).`,
    );
  }
  return { apiKey };
}

function normalizeChatId(to: string): string {
  const normalized = stripRoamTargetPrefix(to);
  if (!normalized) {
    throw new Error("Chat ID is required for Roam sends");
  }
  return normalized;
}

function resolveRoamSendContext(opts: RoamSendOpts): {
  cfg: CoreConfig;
  account: ReturnType<typeof resolveRoamAccount>;
  apiKey: string;
} {
  const cfg = (opts.cfg ?? getRoamRuntime().config.loadConfig()) as CoreConfig;
  const account = resolveRoamAccount({ cfg, accountId: opts.accountId });
  const { apiKey } = resolveCredentials({ apiKey: opts.apiKey }, account);
  return { cfg, account, apiKey };
}

export async function sendMessageRoam(
  to: string,
  text: string,
  opts: RoamSendOpts = {},
): Promise<RoamSendResult> {
  const { cfg, account, apiKey } = resolveRoamSendContext(opts);
  const chatId = normalizeChatId(to);

  if (!text?.trim()) {
    throw new Error("Message must be non-empty for Roam sends");
  }

  const tableMode = getRoamRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "roam",
    accountId: account.accountId,
  });
  const message = getRoamRuntime().channel.text.convertMarkdownTables(text.trim(), tableMode);

  const body: Record<string, unknown> = {
    chatId,
    text: message,
    markdown: true,
    sync: true,
  };
  if (opts.threadKey) {
    // Roam threadKey max 64 chars; truncate if needed
    body.threadKey = opts.threadKey.slice(0, 64);
  }

  const apiBase = resolveApiBase(cfg, account.config.apiBaseUrl);

  const { response, release } = await fetchWithSsrFGuard({
    url: `${apiBase}/chat.post`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    auditContext: "roam-chat-post",
  });

  let timestamp: number | undefined;
  let responseChatId = chatId;
  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const status = response.status;
      let errorMsg = `Roam send failed (${status})`;

      if (status === 400) {
        errorMsg = `Roam: bad request - ${errorBody || "invalid message format"}`;
      } else if (status === 401) {
        errorMsg = "Roam: authentication failed - check API key";
      } else if (status === 403) {
        errorMsg = "Roam: forbidden - bot may not have access to this chat";
      } else if (status === 404) {
        errorMsg = `Roam: chat not found (id=${chatId})`;
      } else if (status === 413) {
        errorMsg = "Roam: message too large (8000 byte limit for blocks)";
      } else if (errorBody) {
        errorMsg = `Roam send failed: ${errorBody}`;
      }

      throw new Error(errorMsg);
    }

    try {
      const data = (await response.json()) as {
        chat?: string;
        timestamp?: number;
      };
      if (data.chat) {
        responseChatId = data.chat;
      }
      if (typeof data.timestamp === "number") {
        timestamp = data.timestamp;
      }
    } catch {
      // Response parsing failed, but message was sent.
    }
  } finally {
    await release();
  }

  getRoamRuntime().channel.activity.record({
    channel: "roam",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { chatId: responseChatId, timestamp };
}

/** Send a typing indicator to a Roam chat. */
export async function sendTypingRoam(
  chatId: string,
  opts: Omit<RoamSendOpts, "threadKey"> = {},
): Promise<void> {
  const { cfg, account, apiKey } = resolveRoamSendContext(opts);
  const normalizedChatId = normalizeChatId(chatId);
  const apiBase = resolveApiBase(cfg, account.config.apiBaseUrl);

  await fetchWithSsrFGuard({
    url: `${apiBase}/chat.typing`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ chatId: normalizedChatId }),
    },
    auditContext: "roam-chat-typing",
  })
    .then(({ release }) => release())
    .catch(() => {
      // Typing indicator failure is non-critical
    });
}
