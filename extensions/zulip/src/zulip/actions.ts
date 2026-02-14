import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk";
import type { ZulipAuth } from "./client.js";
import { resolveZulipAccount } from "./accounts.js";
import { zulipRequest, zulipRequestWithRetry } from "./client.js";
import { normalizeStreamName } from "./normalize.js";
import { normalizeTopic } from "./normalize.js";
import { addZulipReaction, removeZulipReaction } from "./reactions.js";
import { sendZulipStreamMessage } from "./send.js";
import { parseZulipTarget } from "./targets.js";
import { uploadZulipFile, resolveOutboundMedia } from "./uploads.js";

type ActionParams = Record<string, unknown>;

function resolveAuth(
  cfg: unknown,
  accountId?: string | null,
): {
  auth: ZulipAuth;
  account: ReturnType<typeof resolveZulipAccount>;
} {
  const account = resolveZulipAccount({
    cfg: cfg as Parameters<typeof resolveZulipAccount>[0]["cfg"],
    accountId: accountId ?? undefined,
  });
  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error("Missing Zulip credentials");
  }
  return {
    auth: { baseUrl: account.baseUrl, email: account.email, apiKey: account.apiKey },
    account,
  };
}

function requireString(params: ActionParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required parameter: ${key}`);
  }
  return value.trim();
}

function optionalString(params: ActionParams, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return String(value);
  return value.trim() || undefined;
}

// -- Edit --

async function handleEdit(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const messageId = requireString(params, "messageId");
  const message = requireString(params, "message");
  await zulipRequestWithRetry({
    auth,
    method: "PATCH",
    path: `/api/v1/messages/${encodeURIComponent(messageId)}`,
    form: { content: message },
    retry: { maxRetries: 3 },
  });
  return { ok: true, action: "edit", messageId };
}

// -- Delete --

async function handleDelete(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const messageId = requireString(params, "messageId");
  await zulipRequest({
    auth,
    method: "DELETE",
    path: `/api/v1/messages/${encodeURIComponent(messageId)}`,
  });
  return { ok: true, action: "delete", messageId };
}

// -- React --

async function handleReact(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const messageId = requireString(params, "messageId");
  const emoji = requireString(params, "emoji");
  const remove = params.remove === true;
  if (remove) {
    await removeZulipReaction({ auth, messageId: Number(messageId), emojiName: emoji });
  } else {
    await addZulipReaction({ auth, messageId: Number(messageId), emojiName: emoji });
  }
  return { ok: true, action: "react", messageId, emoji, remove };
}

// -- Send --

async function handleSend(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth, account } = resolveAuth(cfg, accountId);
  const target = requireString(params, "target");
  const message = optionalString(params, "message");
  const mediaUrl = optionalString(params, "media") ?? optionalString(params, "mediaUrl");

  const parsed = parseZulipTarget(target);
  if (!parsed) {
    throw new Error(`Invalid Zulip target: ${target}. Use stream:<name>#<topic>`);
  }
  const stream = normalizeStreamName(parsed.stream);
  const topic = normalizeTopic(parsed.topic) || account.defaultTopic;
  if (!stream) throw new Error("Missing stream name");

  let uploadedUrl: string | undefined;
  if (mediaUrl) {
    const resolved = await resolveOutboundMedia({
      cfg: cfg as Parameters<typeof resolveOutboundMedia>[0]["cfg"],
      accountId: account.accountId,
      mediaUrl,
    });
    uploadedUrl = await uploadZulipFile({
      auth,
      buffer: resolved.buffer,
      contentType: resolved.contentType,
      filename: resolved.filename ?? "attachment",
    });
  }

  const content = [message, uploadedUrl].filter(Boolean).join("\n\n");
  if (!content) throw new Error("Nothing to send (no message or media)");

  const result = await sendZulipStreamMessage({ auth, stream, topic, content });
  return { ok: true, action: "send", messageId: String(result.id ?? "unknown") };
}

// -- Adapter --

const SUPPORTED_ACTIONS = ["send", "edit", "delete", "react"] as const;

export const zulipMessageActions: ChannelMessageActionAdapter = {
  listActions: () => [...SUPPORTED_ACTIONS],
  supportsAction: ({ action }) => (SUPPORTED_ACTIONS as readonly string[]).includes(action),
  extractToolSend: ({ args }) => {
    const target = args.target ?? args.to;
    if (typeof target !== "string" || !target.trim()) return null;
    return { to: target.trim(), accountId: (args.accountId as string) ?? undefined };
  },
  handleAction: async (ctx): Promise<AgentToolResult<unknown>> => {
    const { action, params, cfg, accountId } = ctx;
    let result: unknown;
    switch (action) {
      case "send":
        result = await handleSend(params, cfg, accountId);
        break;
      case "edit":
        result = await handleEdit(params, cfg, accountId);
        break;
      case "delete":
        result = await handleDelete(params, cfg, accountId);
        break;
      case "react":
        result = await handleReact(params, cfg, accountId);
        break;
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      details: result,
    };
  },
};
