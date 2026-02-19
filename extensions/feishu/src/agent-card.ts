import type { ClawdbotConfig, ReplyPayload } from "openclaw/plugin-sdk";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { sendCardFeishu, updateCardFeishu } from "./send.js";

export type ReplyDeliverInfo = { kind: "tool" | "block" | "final" };

type ToolEntry = {
  name: string;
  detail?: string;
  isError?: boolean;
};

type TimelineEntry =
  | { kind: "tool"; tool: ToolEntry }
  | { kind: "block"; text: string };

type CreateFeishuAgentCardRendererParams = {
  cfg: ClawdbotConfig;
  chatId: string;
  replyToMessageId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
};

function mergeStreamText(prev: string, next: string): string {
  if (!prev) {
    return next;
  }
  if (!next) {
    return prev;
  }
  if (next.startsWith(prev)) {
    return next;
  }
  if (prev.startsWith(next)) {
    return prev;
  }
  return prev + next;
}

function stripReasoningSection(text: string): string {
  if (!text) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skippingReasoning = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Reasoning:\s*$/i.test(trimmed)) {
      skippingReasoning = true;
      continue;
    }
    if (skippingReasoning) {
      if (!trimmed || /^_[\s\S]*_$/.test(trimmed)) {
        continue;
      }
      skippingReasoning = false;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

function parseToolSummary(rawText: string): ToolEntry | null {
  const text = rawText.trim();
  if (!text) {
    return null;
  }

  const lines = text.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  const rest = lines.slice(1).join("\n").trim();

  const match = firstLine.match(
    /^(?<warn>⚠️\s+)?(?<emoji>[\p{Extended_Pictographic}\uFE0F\u200D]+(?:\s+[\p{Extended_Pictographic}\uFE0F\u200D]+)*)\s+(?<name>[^:\n]+?)(?::\s*(?<meta>.*))?$/u,
  );
  if (!match?.groups) {
    return null;
  }

  const name = (match.groups.name ?? "").trim();
  if (!name) {
    return null;
  }

  const detailHead = (match.groups.meta ?? "").trim();
  const detail = [detailHead, rest].filter(Boolean).join("\n").trim();
  const isError = Boolean(match.groups.warn) || /\bfailed\b/i.test(firstLine);

  return {
    name,
    detail: detail || undefined,
    isError,
  };
}

function formatToolLine(entry: ToolEntry): string {
  const prefix = entry.isError ? "x" : "-";
  if (!entry.detail) {
    return `${prefix} \`${entry.name}\``;
  }
  return `${prefix} \`${entry.name}\`: ${entry.detail}`;
}

function formatBlockLine(text: string): string {
  return `- ${text}`;
}

function buildCard(params: {
  status: "thinking" | "tool" | "completed" | "error";
  timeline: TimelineEntry[];
  answer: string;
  collapseTimeline: boolean;
  mentionTargets?: MentionTarget[];
  includeMentions: boolean;
}): Record<string, unknown> {
  const timelineMarkdown = params.timeline.length
    ? params.timeline
        .map((entry) =>
          entry.kind === "tool" ? formatToolLine(entry.tool) : formatBlockLine(entry.text),
        )
        .join("\n")
    : "No tool activity yet.";
  const answer = params.answer.trim() || "Generating...";

  const bodyElements: Array<Record<string, unknown>> = [];
  if (params.timeline.length > 0) {
    bodyElements.push({
      tag: "collapsible_panel",
      expanded: !params.collapseTimeline,
      header: {
        title: { tag: "plain_text", content: "Tool Activity" },
      },
      elements: [{ tag: "markdown", content: timelineMarkdown }],
    });
  }

  let answerContent = answer;
  if (params.includeMentions && params.mentionTargets?.length) {
    answerContent = buildMentionedCardContent(params.mentionTargets, answerContent);
  }
  bodyElements.push({ tag: "markdown", content: answerContent });

  const title =
    params.status === "completed"
      ? "Completed"
      : params.status === "error"
        ? "Error"
        : params.status === "tool"
          ? "Running Tools"
          : "Thinking";
  const template =
    params.status === "completed"
      ? "green"
      : params.status === "error"
        ? "red"
        : params.status === "tool"
          ? "wathet"
          : "blue";

  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      template,
      title: { tag: "plain_text", content: title, text_size: "normal" },
      padding: "5px 12px 5px 12px",
    },
    body: {
      direction: "vertical",
      elements: bodyElements,
    },
  };
}

function createCardUpdateQueue(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}) {
  const { cfg, messageId, accountId } = params;
  let pending: Record<string, unknown> | null = null;
  let inFlight: Promise<void> | null = null;
  let lastSentAt = 0;
  const minIntervalMs = 300;

  const flushOnce = async () => {
    if (!pending) {
      return;
    }
    const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastSentAt));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const card = pending;
    pending = null;
    lastSentAt = Date.now();
    await updateCardFeishu({ cfg, messageId, card, accountId });
  };

  const kick = () => {
    if (inFlight) {
      return;
    }
    inFlight = (async () => {
      try {
        while (pending) {
          await flushOnce();
        }
      } finally {
        inFlight = null;
        if (pending) {
          kick();
        }
      }
    })();
  };

  return {
    schedule(card: Record<string, unknown>) {
      pending = card;
      kick();
    },
    async flush() {
      if (inFlight) {
        await inFlight;
      }
      if (pending) {
        await flushOnce();
      }
    },
  };
}

export function createFeishuAgentCardRenderer(params: CreateFeishuAgentCardRendererParams) {
  const { cfg, chatId, replyToMessageId, mentionTargets, accountId } = params;
  let status: "thinking" | "tool" | "completed" | "error" = "thinking";
  let timeline: TimelineEntry[] = [];
  let lastBlockNormalized = "";
  let answer = "";
  let messageId: string | null = null;
  let updater: ReturnType<typeof createCardUpdateQueue> | null = null;

  const render = (collapseTimeline: boolean) =>
    buildCard({
      status,
      timeline,
      answer,
      collapseTimeline,
      mentionTargets,
      includeMentions: !messageId,
    });

  const sendOrUpdate = async (collapseTimeline: boolean) => {
    const card = render(collapseTimeline);
    if (!messageId) {
      const sent = await sendCardFeishu({
        cfg,
        to: chatId,
        card,
        replyToMessageId,
        accountId,
      });
      messageId = sent.messageId;
      updater = createCardUpdateQueue({ cfg, messageId, accountId });
      return;
    }
    updater?.schedule(card);
  };

  return {
    async deliver(payload: ReplyPayload, info: ReplyDeliverInfo) {
      const textRaw = payload.text ?? "";

      if (info.kind === "tool") {
        const parsed = parseToolSummary(textRaw);
        if (parsed) {
          timeline = [...timeline, { kind: "tool", tool: parsed }];
          status = parsed.isError ? "error" : "tool";
        } else if (textRaw.trim()) {
          timeline = [...timeline, { kind: "block", text: textRaw.trim() }];
        }
        await sendOrUpdate(false);
        return;
      }

      const text = stripReasoningSection(textRaw);
      if (info.kind === "block" && text) {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (normalized && normalized !== lastBlockNormalized) {
          timeline = [...timeline, { kind: "block", text: text.trim() }];
          lastBlockNormalized = normalized;
        }
      }
      if (text) {
        answer = mergeStreamText(answer, text);
      }
      status = info.kind === "final" ? "completed" : status === "error" ? "error" : "thinking";
      await sendOrUpdate(info.kind === "final");
    },
    async onPartialReply(payload: ReplyPayload) {
      const text = stripReasoningSection(payload.text ?? "");
      if (!text) {
        return;
      }
      answer = mergeStreamText(answer, text);
      if (status !== "error" && status !== "tool") {
        status = "thinking";
      }
      await sendOrUpdate(false);
    },
    async finalize() {
      if (!messageId && !answer.trim() && timeline.length === 0) {
        return;
      }
      if (status !== "error") {
        status = "completed";
      }
      await sendOrUpdate(true);
      await updater?.flush();
    },
    async onError() {
      status = "error";
      await sendOrUpdate(true);
      await updater?.flush();
    },
  };
}
