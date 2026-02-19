/**
 * exec-passthrough — send exec output directly to the user
 *
 * CLI scripts can wrap output in __PASSTHROUGH__...__END_PASSTHROUGH__
 * markers.  This plugin intercepts the tool result, sends the marked
 * content directly to the user's channel, and replaces it with a slim
 * placeholder so the LLM doesn't re-summarize it.
 *
 * Currently supports Telegram via the runtime channel API.
 * Other channels can be added by extending the ChannelSender interface.
 */

import type { OpenClawPluginApi, PluginLogger } from "../../../src/plugins/types.js";

const MARKER_START = "__PASSTHROUGH__";
const MARKER_END = "__END_PASSTHROUGH__";

// ── Marker parsing (channel-agnostic) ──────────────────────────────

type ExtractResult = {
  /** Content to send directly to the user. */
  passthrough: string;
  /** Slim replacement for the LLM. */
  slim: string;
};

function extractPassthrough(text: string): ExtractResult | null {
  const startIdx = text.indexOf(MARKER_START);
  if (startIdx === -1) return null;

  const afterStart = startIdx + MARKER_START.length;
  const endIdx = text.indexOf(MARKER_END, afterStart);

  let passthrough: string;
  let remaining: string;
  if (endIdx !== -1) {
    passthrough = text.slice(afterStart, endIdx).trim();
    remaining = (text.slice(0, startIdx) + text.slice(endIdx + MARKER_END.length)).trim();
  } else {
    passthrough = text.slice(afterStart).trim();
    remaining = text.slice(0, startIdx).trim();
  }

  if (!passthrough) return null;

  let slim = "[output sent directly to user — no reply needed]";
  if (remaining) {
    slim = `${remaining}\n${slim}`;
  }

  return { passthrough, slim };
}

// ── Channel sender ─────────────────────────────────────────────────

interface ChannelSender {
  send(text: string): Promise<void>;
}

const TG_MSG_LIMIT = 4000; // Telegram limit is 4096, leave margin

function createTelegramSender(api: OpenClawPluginApi): ChannelSender | null {
  const config = api.config as Record<string, unknown>;
  const channels = config?.channels as Record<string, unknown> | undefined;
  const tg = channels?.telegram as Record<string, unknown> | undefined;

  const botToken = tg?.botToken as string | undefined;
  const allowFrom = tg?.allowFrom as string[] | undefined;

  let chatId: string | undefined;
  if (Array.isArray(allowFrom) && allowFrom.length > 0) {
    chatId = allowFrom.find((id: string) => /^\d+$/.test(id));
    if (!chatId) {
      const prefixed = allowFrom.find((id: string) => id.startsWith("tg:"));
      if (prefixed) chatId = prefixed.replace(/^tg:/, "");
    }
  }

  if (!botToken || !chatId) {
    api.logger.info("exec-passthrough: telegram config incomplete, direct send disabled");
    return null;
  }

  api.logger.info(`exec-passthrough: telegram sender ready (chatId=${chatId})`);

  return {
    async send(text: string) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += TG_MSG_LIMIT) {
        chunks.push(text.slice(i, i + TG_MSG_LIMIT));
      }
      for (const chunk of chunks) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: chunk }),
          });
        } catch (err) {
          api.logger.error(
            `exec-passthrough: telegram send failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}

// ── Plugin registration ────────────────────────────────────────────

export function registerExecPassthrough(api: OpenClawPluginApi) {
  const pluginCfg = (api.pluginConfig ?? {}) as { channel?: string };
  const channelName = pluginCfg.channel ?? "telegram";

  let sender: ChannelSender | null = null;
  if (channelName === "telegram") {
    sender = createTelegramSender(api);
  } else {
    api.logger.warn(`exec-passthrough: unsupported channel "${channelName}"`);
  }

  api.on(
    "tool_result_persist",
    (event) => {
      const msg = event.message;
      if (!msg || msg.role !== "toolResult") return;
      if (event.toolName !== "exec") return;

      const contents = (msg as any).content;
      if (!Array.isArray(contents)) return;

      let found = false;
      const newContents = contents.map((c: any) => {
        if (c.type !== "text" || !c.text) return c;
        const result = extractPassthrough(c.text);
        if (!result) return c;

        found = true;

        if (sender) {
          sender.send(result.passthrough).catch((err) => {
            api.logger.error(
              `exec-passthrough: send failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          api.logger.info(
            `exec-passthrough: sent ${result.passthrough.length} chars directly, slim for LLM`,
          );
        } else {
          api.logger.info("exec-passthrough: no sender configured, passthrough content dropped");
        }

        return { ...c, text: result.slim };
      });

      if (found) {
        return { message: { ...msg, content: newContents } };
      }
    },
    { priority: 100 },
  );

  api.logger.info(
    `exec-passthrough: plugin loaded (channel=${channelName}, sender=${sender ? "active" : "none"})`,
  );
}
