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
  | { kind: "block"; text: string }
  | { kind: "reasoning"; text: string };

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

  const maxOverlap = Math.min(prev.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (prev.slice(-overlap) === next.slice(0, overlap)) {
      return prev + next.slice(overlap);
    }
  }
  return prev + next;
}

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

function stripLeadingByNonWsPrefix(text: string, nonWsPrefix: string): string {
  if (!text || !nonWsPrefix) {
    return text;
  }
  let consumed = 0;
  let cutIndex = 0;
  while (cutIndex < text.length && consumed < nonWsPrefix.length) {
    if (!/\s/.test(text[cutIndex] ?? "")) {
      consumed += 1;
    }
    cutIndex += 1;
  }
  if (consumed < nonWsPrefix.length) {
    return text;
  }
  return text.slice(cutIndex).replace(/^\s+/, "");
}

function stripProcessPrefixFromFinal(finalText: string, processText: string): string {
  const finalWs = stripWhitespace(finalText);
  const processWs = stripWhitespace(processText);
  if (!finalWs || !processWs) {
    return finalText;
  }
  if (!finalWs.startsWith(processWs)) {
    return finalText;
  }
  return stripLeadingByNonWsPrefix(finalText, processWs);
}

function extractSystemTraceLines(text: string): { cleanedText: string; traceLines: string[] } {
  if (!text) {
    return { cleanedText: text, traceLines: [] };
  }
  const traceLines: string[] = [];
  const keptLines: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^🧭\s+New session:\s+/i.test(trimmed)) {
      traceLines.push(trimmed);
      continue;
    }
    keptLines.push(line);
  }

  return { cleanedText: keptLines.join("\n"), traceLines };
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
  const header = `调用\`${entry.name}\`工具`;
  if (!entry.detail) {
    return header;
  }
  return `${header}: ${entry.detail}`;
}

function formatTimelineLine(entry: TimelineEntry): string {
  if (entry.kind === "tool") {
    return formatToolLine(entry.tool);
  }
  if (entry.kind === "reasoning") {
    return `思考: ${entry.text}`;
  }
  return entry.text;
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimFinalDupBlocks(timeline: TimelineEntry[], answer: string): TimelineEntry[] {
  const answerNorm = normalizeForCompare(answer);
  if (!answerNorm) {
    return timeline;
  }

  const out = [...timeline];
  const tailBlocks: string[] = [];

  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.kind !== "block") {
      break;
    }
    tailBlocks.unshift(last.text);
    const candidate = normalizeForCompare(tailBlocks.join("\n"));
    if (!candidate) {
      out.pop();
      continue;
    }
    if (answerNorm.endsWith(candidate)) {
      out.pop();
      continue;
    }
    break;
  }

  return out;
}

function appendTimelineBlockChunk(params: {
  text: string;
  timeline: TimelineEntry[];
  carryLine: string;
  flushIncompleteLine: boolean;
}): { timeline: TimelineEntry[]; carryLine: string; processText: string } {
  const { text, timeline, carryLine, flushIncompleteLine } = params;
  const nextText = text ?? "";
  if (!nextText) {
    return { timeline, carryLine, processText: "" };
  }

  const combined = `${carryLine}${nextText}`;
  const lines = combined.split(/\r?\n/);
  const endsWithNewline = /\r?\n$/.test(combined);
  let nextCarryLine = endsWithNewline ? "" : (lines.pop() ?? "");
  if (flushIncompleteLine && nextCarryLine.trim()) {
    lines.push(nextCarryLine);
    nextCarryLine = "";
  }

  const out = [...timeline];
  const processParts: string[] = [];
  let inReasoning = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (/^Reasoning:\s*$/i.test(trimmed)) {
      inReasoning = true;
      continue;
    }

    if (inReasoning) {
      const reasoningLine = /^_+[\s\S]*_+$/.test(trimmed);
      if (reasoningLine) {
        const cleaned = trimmed.replace(/^_+|_+$/g, "").trim();
        if (cleaned) {
          const last = out[out.length - 1];
          if (last?.kind === "reasoning" && last.text === cleaned) {
            continue;
          }
          out.push({ kind: "reasoning", text: cleaned });
          processParts.push(cleaned);
        }
        continue;
      }
      inReasoning = false;
    }

    const last = out[out.length - 1];
    if (last?.kind === "block" && last.text === trimmed) {
      continue;
    }
    out.push({ kind: "block", text: trimmed });
    processParts.push(trimmed);
  }

  return { timeline: out, carryLine: nextCarryLine, processText: processParts.join("\n") };
}

function buildCard(params: {
  status: "thinking" | "tool" | "completed" | "error";
  timeline: TimelineEntry[];
  answer: string;
  collapseTimeline: boolean;
  mentionTargets?: MentionTarget[];
  includeMentions: boolean;
}): Record<string, unknown> {
  const hasAnswer = Boolean(params.answer.trim());
  const shouldCollapseTimeline = params.collapseTimeline && hasAnswer;
  const filteredTimeline =
    shouldCollapseTimeline
      ? trimFinalDupBlocks(params.timeline, params.answer)
      : params.timeline;

  const timelineMarkdown = filteredTimeline
    .map((entry) => formatTimelineLine(entry))
    .filter(Boolean)
    .join("\n");

  const answer = params.answer.trim();
  const timelineContent = answer ? `${timelineMarkdown}\n\n` : timelineMarkdown;
  const bodyElements: Array<Record<string, unknown>> = [];

  if (filteredTimeline.length > 0) {
    if (shouldCollapseTimeline) {
      bodyElements.push({
        tag: "collapsible_panel",
        expanded: false,
        header: {
          title: { tag: "plain_text", content: "执行过程" },
        },
        elements: [{ tag: "markdown", content: timelineContent, margin: "2px 0px 4px 0px" }],
      });
    } else {
      // During running states, show timeline directly without the collapsible title.
      bodyElements.push({ tag: "markdown", content: timelineContent, margin: "2px 0px 6px 0px" });
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
  let progressText = "";
  let finalText = "";
  let answer = "";
  let messageId: string | null = null;
  let updater: ReturnType<typeof createCardUpdateQueue> | null = null;
  let createMessagePromise: Promise<void> | null = null;
  let opQueue: Promise<void> = Promise.resolve();
  let timelineCarryLine = "";
  let finalStreamStarted = false;
  let finalHasBegun = false;

  const recomputeAnswer = () => {
    if (!finalHasBegun || !finalText.trim()) {
      answer = progressText;
      return;
    }
    const left = progressText.trimEnd();
    const right = finalText.trimStart();
    if (!left) {
      answer = right;
      return;
    }
    if (!right) {
      answer = left;
      return;
    }
    answer = `${left}\n\n${right}`;
  };

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
        const textRawOriginal = payload.text ?? "";
        const { cleanedText: textRaw, traceLines } = extractSystemTraceLines(textRawOriginal);

        if (traceLines.length > 0) {
          for (const line of traceLines) {
            timeline = [...timeline, { kind: "block", text: line }];
          }
        }

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

        if (info.kind === "block") {
          const appended = appendTimelineBlockChunk({
            text: textRaw,
            timeline,
            carryLine: timelineCarryLine,
            flushIncompleteLine: false,
          });
          timeline = appended.timeline;
          timelineCarryLine = appended.carryLine;
          await sendOrUpdate(false);
          return;
        }
        if (info.kind === "final") {
          const flushed = appendTimelineBlockChunk({
            text: "",
            timeline,
            carryLine: timelineCarryLine,
            flushIncompleteLine: true,
          });
          timeline = flushed.timeline;
          timelineCarryLine = flushed.carryLine;
        }

        const text = stripReasoningSection(textRaw);

        if (!finalStreamStarted && info.kind === "final") {
          finalStreamStarted = true;
        }

        if (info.kind === "final") {
          finalHasBegun = true;
          // The final payload often includes the entire assistant message (including the
          // earlier "progress" text). Keep progress as-is and append only the delta.
          finalText = stripProcessPrefixFromFinal(text, progressText);
          recomputeAnswer();
        }
        status = info.kind === "final" ? "completed" : status === "error" ? "error" : "thinking";
        await sendOrUpdate(info.kind === "final" || finalStreamStarted);
      });
    },
    async onPartialReply(payload: ReplyPayload) {
      await enqueueOp(async () => {
        const { cleanedText } = extractSystemTraceLines(payload.text ?? "");
        const text = stripReasoningSection(cleanedText);
        if (!text) {
          return;
        }
        // Keep streaming assistant text in the body (progress), not the timeline.
        // Text may be either delta chunks or cumulative; mergeStreamText handles both.
        if (!finalHasBegun) {
          progressText = mergeStreamText(progressText, text);
        } else {
          finalText = mergeStreamText(finalText, text);
        }
        recomputeAnswer();
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
        await sendOrUpdate(Boolean(answer.trim()));
        await updater?.flush();
      });
    },
    async onError() {
      await enqueueOp(async () => {
        status = "error";
        await sendOrUpdate(Boolean(answer.trim()));
        await updater?.flush();
      });
    },
  };
}
