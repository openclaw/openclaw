import fs from "fs";
import path from "path";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";

// Central hook for presenting user-facing text in Feishu.
// This keeps agent/tool behavior channel-agnostic while allowing the Feishu
// adapter to shape errors for IM users (human summary + technical details).
// Other channels (e.g. WeCom/Discord) can adopt the same pattern by adding
// their own format<UserFacingText> helper at their outbound boundary.
function formatFeishuUserFacingText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;

  // 1) Agent-level failures before reply (e.g. session file lock)
  const agentLineMatch = trimmed.match(/^⚠️ Agent failed before reply:.*$/m);
  if (agentLineMatch) {
    const agentLine = agentLineMatch[0];
    const isSessionLock = /session file locked/i.test(agentLine);
    const userLine = isSessionLock
      ? "**Session file lock error. This is usually temporary; please wait a few minutes and resend your last message. If it keeps happening, ask the operator to check the OpenClaw logs.**"
      : "**The agent failed before replying. This is often a transient issue; please retry your last message shortly. If the problem persists, contact the operator or check the OpenClaw troubleshooting docs.**";
    const technicalLine = `\`\`\`Technical details: ${agentLine}\`\`\``;
    return `${userLine}\n${technicalLine}`;
  }

  // 2) Tool/exec failures (🛠️ Exec ...)
  const execLineMatch = trimmed.match(/^⚠️ 🛠️ Exec(?: failed)?:.*$/m);
  if (execLineMatch) {
    const execLine = execLineMatch[0];
    const userLine =
      "**Command execution failed. This usually means the host command or environment is misconfigured; please verify the command locally or ask the operator to review the OpenClaw gateway configuration.**";
    const technicalLine = `\`\`\`Technical details: ${execLine}\`\`\``;
    return `${userLine}\n${technicalLine}`;
  }

  // 3) Generic warning-style fallback for other ⚠️ messages
  if (trimmed.includes("⚠️")) {
    const firstLine = trimmed.split(/\r?\n/, 1)[0];
    const userLine =
      "**Something went wrong while handling your request. This is often temporary; please try again in a few minutes, and contact the operator or check the OpenClaw docs if it keeps happening.**";
    const technicalLine = `\`\`\`Technical details: ${firstLine}\`\`\``;
    return `${userLine}\n${technicalLine}`;
  }

  return text;
}

function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) return null;

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) return null;

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;

  const ext = path.extname(raw).toLowerCase();
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (!isImageExt) return null;

  if (!path.isAbsolute(raw)) return null;
  if (!fs.existsSync(raw)) return null;

  // Fix race condition: wrap statSync in try-catch to handle file deletion
  // between existsSync and statSync
  try {
    if (!fs.statSync(raw).isFile()) return null;
  } catch {
    // File may have been deleted or became inaccessible between checks
    return null;
  }

  return raw;
}

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

async function sendOutboundText(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string;
}) {
  const { cfg, to, text, accountId } = params;
  const formattedText = formatFeishuUserFacingText(text);
  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(formattedText))) {
    return sendMarkdownCardFeishu({ cfg, to, text: formattedText, accountId });
  }

  return sendMessageFeishu({ cfg, to, text: formattedText, accountId });
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    // Scheme A compatibility shim:
    // when upstream accidentally returns a local image path as plain text,
    // auto-upload and send as Feishu image message instead of leaking path text.
    const localImagePath = normalizePossibleLocalImagePath(text);
    if (localImagePath) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localImagePath,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        console.error(`[feishu] local image path auto-send failed:`, err);
        // fall through to plain text as last resort
      }
    }

    const result = await sendOutboundText({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, mediaLocalRoots }) => {
    // Send text first if provided
    if (text?.trim()) {
      await sendOutboundText({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
      });
    }

    // Upload and send media if URL or local path provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
          mediaLocalRoots,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendOutboundText({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendOutboundText({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
