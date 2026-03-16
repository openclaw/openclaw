import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { buildSlackInteractiveBlocks } from "./blocks-render.js";

type SlackActionInvoke = (
  action: Record<string, unknown>,
  cfg: ChannelMessageActionContext["cfg"],
  toolContext?: ChannelMessageActionContext["toolContext"],
) => Promise<AgentToolResult<unknown>>;

type InteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";

type InteractiveReplyButton = {
  label: string;
  value: string;
  style?: InteractiveButtonStyle;
};

type InteractiveReplyOption = {
  label: string;
  value: string;
};

type InteractiveReplyBlock =
  | { type: "text"; text: string }
  | { type: "buttons"; buttons: InteractiveReplyButton[] }
  | { type: "select"; placeholder?: string; options: InteractiveReplyOption[] };

type InteractiveReply = {
  blocks: InteractiveReplyBlock[];
};

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeButtonStyle(value: unknown): InteractiveButtonStyle | undefined {
  const style = readTrimmedString(value)?.toLowerCase();
  return style === "primary" || style === "secondary" || style === "success" || style === "danger"
    ? style
    : undefined;
}

function normalizeInteractiveButton(raw: unknown): InteractiveReplyButton | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const label = readTrimmedString(record.label) ?? readTrimmedString(record.text);
  const value =
    readTrimmedString(record.value) ??
    readTrimmedString(record.callbackData) ??
    readTrimmedString(record.callback_data);
  if (!label || !value) {
    return undefined;
  }
  return { label, value, style: normalizeButtonStyle(record.style) };
}

function normalizeInteractiveOption(raw: unknown): InteractiveReplyOption | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const label = readTrimmedString(record.label) ?? readTrimmedString(record.text);
  const value = readTrimmedString(record.value);
  return label && value ? { label, value } : undefined;
}

function normalizeInteractiveReply(raw: unknown): InteractiveReply | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const blocks = Array.isArray(record.blocks)
    ? record.blocks
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return undefined;
          }
          const block = entry as Record<string, unknown>;
          const type = readTrimmedString(block.type)?.toLowerCase();
          if (type === "text") {
            const text = readTrimmedString(block.text);
            return text ? ({ type: "text", text } as const) : undefined;
          }
          if (type === "buttons") {
            const buttons = Array.isArray(block.buttons)
              ? block.buttons
                  .map((button) => normalizeInteractiveButton(button))
                  .filter((button): button is InteractiveReplyButton => Boolean(button))
              : [];
            return buttons.length > 0 ? ({ type: "buttons", buttons } as const) : undefined;
          }
          if (type === "select") {
            const options = Array.isArray(block.options)
              ? block.options
                  .map((option) => normalizeInteractiveOption(option))
                  .filter((option): option is InteractiveReplyOption => Boolean(option))
              : [];
            return options.length > 0
              ? ({
                  type: "select",
                  placeholder: readTrimmedString(block.placeholder),
                  options,
                } as const)
              : undefined;
          }
          return undefined;
        })
        .filter((entry): entry is InteractiveReplyBlock => Boolean(entry))
    : [];
  return blocks.length > 0 ? { blocks } : undefined;
}

function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; trim?: boolean; label?: string; allowEmpty?: boolean } = {},
): string | undefined {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = params[key];
  if (typeof raw !== "string") {
    if (required) {
      throw new Error(`${label} required`);
    }
    return undefined;
  }
  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) {
      throw new Error(`${label} required`);
    }
    return undefined;
  }
  return value;
}

function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string; integer?: boolean; strict?: boolean } = {},
): number | undefined {
  const { required = false, label = key, integer = false, strict = false } = options;
  const raw = params[key];
  let value: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      const parsed = strict ? Number(trimmed) : Number.parseFloat(trimmed);
      if (Number.isFinite(parsed)) {
        value = parsed;
      }
    }
  }
  if (value === undefined) {
    if (required) {
      throw new Error(`${label} required`);
    }
    return undefined;
  }
  return integer ? Math.trunc(value) : value;
}

function readSlackBlocksParam(actionParams: Record<string, unknown>) {
  return parseSlackBlocksInput(actionParams.blocks) as Record<string, unknown>[] | undefined;
}

export async function handleSlackMessageAction(params: {
  providerId: string;
  ctx: ChannelMessageActionContext;
  invoke: SlackActionInvoke;
  normalizeChannelId?: (channelId: string) => string;
  includeReadThreadId?: boolean;
}): Promise<AgentToolResult<unknown>> {
  const { providerId, ctx, invoke, normalizeChannelId, includeReadThreadId = false } = params;
  const { action, cfg, params: actionParams } = ctx;
  const accountId = ctx.accountId ?? undefined;
  const resolveChannelId = () => {
    const channelId =
      readStringParam(actionParams, "channelId") ??
      readStringParam(actionParams, "to", { required: true });
    return normalizeChannelId ? normalizeChannelId(channelId) : channelId;
  };

  if (action === "send") {
    const to = readStringParam(actionParams, "to", { required: true });
    const content = readStringParam(actionParams, "message", { allowEmpty: true });
    const mediaUrl = readStringParam(actionParams, "media", { trim: false });
    const interactive = normalizeInteractiveReply(actionParams.interactive);
    const interactiveBlocks = interactive ? buildSlackInteractiveBlocks(interactive) : undefined;
    const blocks = readSlackBlocksParam(actionParams) ?? interactiveBlocks;
    if (!content && !mediaUrl && !blocks) {
      throw new Error("Slack send requires message, blocks, or media.");
    }
    if (mediaUrl && blocks) {
      throw new Error("Slack send does not support blocks with media.");
    }
    const threadId = readStringParam(actionParams, "threadId");
    const replyTo = readStringParam(actionParams, "replyTo");
    return await invoke(
      {
        action: "sendMessage",
        to,
        content: content ?? "",
        mediaUrl: mediaUrl ?? undefined,
        accountId,
        threadTs: threadId ?? replyTo ?? undefined,
        ...(blocks ? { blocks } : {}),
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "react") {
    const messageId = readStringParam(actionParams, "messageId", { required: true });
    const emoji = readStringParam(actionParams, "emoji", { allowEmpty: true });
    const remove = typeof actionParams.remove === "boolean" ? actionParams.remove : undefined;
    return await invoke(
      { action: "react", channelId: resolveChannelId(), messageId, emoji, remove, accountId },
      cfg,
    );
  }

  if (action === "reactions") {
    const messageId = readStringParam(actionParams, "messageId", { required: true });
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    return await invoke(
      { action: "reactions", channelId: resolveChannelId(), messageId, limit, accountId },
      cfg,
    );
  }

  if (action === "read") {
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    const readAction: Record<string, unknown> = {
      action: "readMessages",
      channelId: resolveChannelId(),
      limit,
      before: readStringParam(actionParams, "before"),
      after: readStringParam(actionParams, "after"),
      accountId,
    };
    if (includeReadThreadId) {
      readAction.threadId = readStringParam(actionParams, "threadId");
    }
    return await invoke(readAction, cfg);
  }

  if (action === "edit") {
    const messageId = readStringParam(actionParams, "messageId", { required: true });
    const content = readStringParam(actionParams, "message", { allowEmpty: true });
    const blocks = readSlackBlocksParam(actionParams);
    if (!content && !blocks) {
      throw new Error("Slack edit requires message or blocks.");
    }
    return await invoke(
      {
        action: "editMessage",
        channelId: resolveChannelId(),
        messageId,
        content: content ?? "",
        blocks,
        accountId,
      },
      cfg,
    );
  }

  if (action === "delete") {
    const messageId = readStringParam(actionParams, "messageId", { required: true });
    return await invoke(
      { action: "deleteMessage", channelId: resolveChannelId(), messageId, accountId },
      cfg,
    );
  }

  if (action === "pin" || action === "unpin" || action === "list-pins") {
    const messageId =
      action === "list-pins"
        ? undefined
        : readStringParam(actionParams, "messageId", { required: true });
    return await invoke(
      {
        action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
        channelId: resolveChannelId(),
        messageId,
        accountId,
      },
      cfg,
    );
  }

  if (action === "member-info") {
    const userId = readStringParam(actionParams, "userId", { required: true });
    return await invoke({ action: "memberInfo", userId, accountId }, cfg);
  }

  if (action === "emoji-list") {
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    return await invoke({ action: "emojiList", limit, accountId }, cfg);
  }

  if (action === "download-file") {
    const fileId = readStringParam(actionParams, "fileId", { required: true });
    const channelId =
      readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to");
    const threadId =
      readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo");
    return await invoke(
      {
        action: "downloadFile",
        fileId,
        channelId: channelId ?? undefined,
        threadId: threadId ?? undefined,
        accountId,
      },
      cfg,
    );
  }

  throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
