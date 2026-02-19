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
  if (!rawText || !rawText.trim()) {
    return null;
  }

  const lines = rawText.split(/\r?\n/);
  const firstLine = lines[0] ?? "";
  const firstLineTrimmed = firstLine.trim();
  const rest = lines.slice(1).join("\n");

  const match = firstLineTrimmed.match(
    /^(?<warn>⚠️\s+)?(?<emoji>[\p{Extended_Pictographic}\uFE0F\u200D]+(?:\s+[\p{Extended_Pictographic}\uFE0F\u200D]+)*)\s+(?<name>[^:\n]+?)(?::\s*(?<meta>.*))?$/u,
  );
  if (!match?.groups) {
    return null;
  }

  const name = (match.groups.name ?? "").trim();
  if (!name) {
    return null;
  }

  let detail = "";
  const colonIndex = firstLineTrimmed.indexOf(":");
  if (colonIndex >= 0) {
    detail = firstLineTrimmed.slice(colonIndex + 1);
  }
  if (rest) {
    detail = detail ? `${detail}\n${rest}` : rest;
  }
  const isError = Boolean(match.groups.warn) || /\bfailed\b/i.test(firstLineTrimmed);

  return {
    name,
    detail: detail.length > 0 ? detail : undefined,
    isError,
  };
}

function formatToolLine(entry: ToolEntry): string {
  const header = `调用\`${entry.name}\`工具:`;
  if (!entry.detail) {
    return header;
  }
  return `${header}${entry.detail}`;
}

function formatBlockLine(text: string): string {
  return text;
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
        .filter(Boolean)
        .join("\n\n")
    : "暂无过程记录";

  const answer = params.answer.trim();
  const bodyElements: Array<Record<string, unknown>> = [];

  if (params.timeline.length > 0) {
    if (params.collapseTimeline) {
      bodyElements.push({
        tag: "collapsible_panel",
        expanded: false,
        header: {
          title: { tag: "plain_text", content: "执行过程" },
        },
        elements: [{ tag: "markdown", content: timelineMarkdown, margin: "2px 0px 4px 0px" }],
      });
    } else {
      // During running states, show timeline directly without the collapsible title.
      bodyElements.push({ tag: "markdown", content: timelineMarkdown, margin: "2px 0px 6px 0px" });
    }
  }

  if (answer) {
    let answerContent = answer;
    if (params.includeMentions && params.mentionTargets?.length) {
      answerContent = buildMentionedCardContent(params.mentionTargets, answerContent);
    }
    bodyElements.push({ tag: "markdown", content: answerContent, margin: "2px 0px 0px 0px" });
  }

  const title =
    params.status === "completed"
      ? "全部完成"
      : params.status === "error"
        ? "执行异常"
        : params.status === "tool"
          ? "调用工具中"
          : "思考中";

  const template =
    params.status === "completed"
      ? "green"
      : params.status === "error"
        ? "red"
        : params.status === "tool"
          ? "wathet"
          : "blue";

  const iconToken =
    params.status === "completed"
      ? "succeed_filled"
      : params.status === "error"
        ? "error_filled"
        : params.status === "tool"
          ? "setting-inter_filled"
          : "premium-gleam_filled";

  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      template,
      title: { tag: "plain_text", content: title, text_size: "normal" },
      padding: "5px 12px 5px 12px",
      icon: { tag: "standard_icon", token: iconToken, color: template },
    },
    body: {
      direction: "vertical",
      padding: "8px 12px 12px 12px",
      vertical_spacing: "8px",
      horizontal_spacing: "0px",
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
  let createMessagePromise: Promise<void> | null = null;
  let opQueue: Promise<void> = Promise.resolve();

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
      if (!createMessagePromise) {
        createMessagePromise = (async () => {
          const sent = await sendCardFeishu({
            cfg,
            to: chatId,
            card,
            replyToMessageId,
            accountId,
          });
          messageId = sent.messageId;
          updater = createCardUpdateQueue({ cfg, messageId, accountId });
        })().finally(() => {
          createMessagePromise = null;
        });
      }
      await createMessagePromise;
      return;
    }
    updater?.schedule(card);
  };

  const enqueueOp = (op: () => Promise<void>) => {
    opQueue = opQueue.then(op).catch(() => {});
    return opQueue;
  };

  return {
    async deliver(payload: ReplyPayload, info: ReplyDeliverInfo) {
      await enqueueOp(async () => {
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
      });
    },
    async onPartialReply(payload: ReplyPayload) {
      await enqueueOp(async () => {
        const text = stripReasoningSection(payload.text ?? "");
        if (!text) {
          return;
        }
        answer = mergeStreamText(answer, text);
        if (status !== "error" && status !== "tool") {
          status = "thinking";
        }
        await sendOrUpdate(false);
      });
    },
    async finalize() {
      await enqueueOp(async () => {
        if (!messageId && !answer.trim() && timeline.length === 0) {
          return;
        }
        if (status !== "error") {
          status = "completed";
        }
        await sendOrUpdate(true);
        await updater?.flush();
      });
    },
    async onError() {
      await enqueueOp(async () => {
        status = "error";
        await sendOrUpdate(true);
        await updater?.flush();
      });
    },
  };
}
