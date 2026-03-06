import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  sendMessageFeishu,
  sendMarkdownCardFeishu,
  sendCardFeishu,
  updateCardFeishu,
  buildMarkdownCard,
} from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/** Detect if text contains a markdown table (header + separator row). */
function hasMarkdownTable(text: string): boolean {
  return /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/**
 * Collapse \n\n between markdown table rows back to \n.
 * The SDK block coalescer inserts \n\n as joiner, which breaks tables.
 */
function repairMarkdownTables(text: string): string {
  return text.replace(/(\|[^\n]*\|)\n\n(?=\|)/g, "$1\n");
}

// --- Tool arg extractors ---

const TOOL_ARG_EXTRACTORS: Record<string, string[]> = {
  read: ["path"],
  write: ["path"],
  edit: ["file_path"],
  exec: ["command"],
  bash: ["command"],
  search: ["pattern", "query"],
  grep: ["pattern"],
  glob: ["pattern"],
  web_search: ["query"],
  web_fetch: ["url"],
  list_directory: ["path"],
};

function extractToolArgs(
  name: string,
  args: Record<string, unknown> | undefined,
  maxLen: number,
): string {
  if (!args) return "";
  let raw = "";
  const keys = TOOL_ARG_EXTRACTORS[name.toLowerCase()];
  if (keys) {
    for (const key of keys) {
      const val = args[key];
      if (typeof val === "string" && val.trim()) {
        raw = val.trim();
        break;
      }
    }
  }
  if (!raw) {
    for (const val of Object.values(args)) {
      if (typeof val === "string" && val.trim()) {
        raw = val.trim();
        break;
      }
    }
  }
  if (!raw) return "";
  const trimmed = raw.length > maxLen ? raw.slice(0, maxLen) + "…" : raw;
  return trimmed.replace(/`/g, "'");
}

// --- Thinking/Tool types ---

type ToolEntry = { name: string; args?: Record<string, unknown>; startedAt: number };
type CompletedToolEntry = ToolEntry & { failed: boolean };

function buildThinkingSection(
  thinkingText: string | undefined,
  activeTools: Map<string, ToolEntry>,
  completedTools: CompletedToolEntry[],
  maxLen: number,
): string {
  const parts: string[] = [];

  if (thinkingText) {
    const trimmed = thinkingText.length > maxLen ? "…" + thinkingText.slice(-maxLen) : thinkingText;
    parts.push("✨ **Thinking**");
    parts.push(`> ${trimmed.replace(/\n/g, "\n> ")}`);
  }

  if (completedTools.length > 0 || activeTools.size > 0) {
    if (parts.length > 0) parts.push("");
    for (const t of completedTools.slice(-10)) {
      const icon = t.failed ? "❌" : "✅";
      const argStr = extractToolArgs(t.name, t.args, 150);
      parts.push(argStr ? `${icon} \`${t.name}\` \`${argStr}\`` : `${icon} \`${t.name}\``);
    }
    for (const [, t] of activeTools) {
      const argStr = extractToolArgs(t.name, t.args, 150);
      parts.push(argStr ? `⏳ \`${t.name}\` \`${argStr}\`` : `⏳ \`${t.name}\``);
    }
  }

  return parts.join("\n");
}

function buildThinkingCollapseSummary(
  completedTools: CompletedToolEntry[],
  startedAt?: number,
): string {
  const n = completedTools.length;
  const failed = completedTools.filter((t) => t.failed).length;
  const ok = n - failed;
  const parts: string[] = ["✨ Thinking complete"];
  if (startedAt) {
    const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
    parts.push(`${sec}s`);
  }
  if (n > 0) {
    const toolStr = failed > 0 ? `${ok}✅ ${failed}❌` : `${n} tool${n !== 1 ? "s" : ""}`;
    parts.push(toolStr);
  }
  return parts.join(" · ");
}

/**
 * Build a unified card with optional collapsible thinking panel + reply markdown.
 */
function buildUnifiedCard(opts: {
  thinkingMarkdown?: string;
  thinkingExpanded: boolean;
  thinkingTitle: string;
  replyMarkdown?: string;
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  if (opts.thinkingMarkdown) {
    elements.push({
      tag: "collapsible_panel",
      expanded: opts.thinkingExpanded,
      header: {
        title: {
          tag: "plain_text",
          content: opts.thinkingTitle,
        },
      },
      elements: [
        {
          tag: "markdown",
          content: opts.thinkingMarkdown,
        },
      ],
    });
  }

  if (opts.replyMarkdown) {
    elements.push({
      tag: "markdown",
      content: opts.replyMarkdown,
    });
  }

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

// --- Constants ---

/** Maximum age (ms) for a message to receive a typing indicator reaction. */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;
/** Minimum interval between card patch API calls to avoid Feishu rate limiting (230020). */
const PATCH_MIN_INTERVAL_MS = 2000;
/** Thinking timer interval: periodic card updates while thinking. */
const THINKING_TIMER_INTERVAL_MS = 3000;

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  /** Epoch ms when the inbound message was created. */
  messageCreateTimeMs?: number;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    replyToMessageId,
    skipReplyToInMessages,
    replyInThread,
    threadReply,
    rootId,
    mentionTargets,
    accountId,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  // --- Typing indicator ---
  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!(account.config.typingIndicator ?? true)) {
        return;
      }
      if (!replyToMessageId) {
        return;
      }
      const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
      if (
        messageCreateTimeMs !== undefined &&
        Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
      ) {
        return;
      }
      if (typingState?.reactionId) {
        return;
      }
      typingState = await addTypingIndicator({
        cfg,
        messageId: replyToMessageId,
        accountId,
        runtime: params.runtime,
      });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId, runtime: params.runtime });
      typingState = null;
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  const streamingEnabled =
    !threadReplyMode && account.config?.streaming !== false && renderMode !== "raw";

  // --- Streaming card state (for non-thinking scenarios) ---
  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  const deliveredFinalTexts = new Set<string>();
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;

  // --- Thinking card state (message-patch approach with collapsible panel) ---
  let thinkingCardMessageId: string | null = null;
  let thinkingCardCreationPromise: Promise<void> | null = null;
  let thinkingCardFailed = false;
  let thinkingText: string | undefined;
  const activeTools = new Map<string, ToolEntry>();
  const completedTools: CompletedToolEntry[] = [];
  let thinkingStopped = false;
  let hasThinkingContent = false;
  let thinkingStartedAt: number | undefined;
  let thinkingTimer: ReturnType<typeof setInterval> | null = null;
  let lastThinkingPatchTime = 0;
  let pendingPatchTimer: ReturnType<typeof setTimeout> | null = null;
  let accumulatedReplyText = "";

  // --- Thinking card helpers ---

  function startThinkingTimer() {
    if (thinkingTimer) return;
    thinkingTimer = setInterval(() => {
      if (thinkingStopped || thinkingCardFailed) return;
      void patchThinkingCard(false);
    }, THINKING_TIMER_INTERVAL_MS);
  }

  function stopThinkingTimer() {
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
  }

  function clearPendingPatch() {
    if (pendingPatchTimer) {
      clearTimeout(pendingPatchTimer);
      pendingPatchTimer = null;
    }
  }

  function schedulePatch() {
    if (pendingPatchTimer) return;
    const elapsed = Date.now() - lastThinkingPatchTime;
    const delay = Math.max(0, PATCH_MIN_INTERVAL_MS - elapsed);
    pendingPatchTimer = setTimeout(() => {
      pendingPatchTimer = null;
      if (!thinkingStopped && !thinkingCardFailed) {
        void patchThinkingCard(false);
      }
    }, delay);
  }

  function buildCurrentThinkingCard(isFinal: boolean): Record<string, unknown> {
    const replyMd = accumulatedReplyText ? repairMarkdownTables(accumulatedReplyText) : undefined;

    const thinkingMd = buildThinkingSection(thinkingText, activeTools, completedTools, 3000);
    const hasThinking = hasThinkingContent || !!thinkingMd;

    const collapseSummary = buildThinkingCollapseSummary(completedTools, thinkingStartedAt);

    const thinkingElapsed =
      thinkingStartedAt && !thinkingStopped
        ? `✨ Thinking… ${((Date.now() - thinkingStartedAt) / 1000).toFixed(0)}s`
        : "✨ Thinking…";

    return buildUnifiedCard({
      thinkingMarkdown: hasThinking ? thinkingMd || "✨ Thinking…" : undefined,
      thinkingExpanded: !thinkingStopped,
      thinkingTitle: thinkingStopped ? collapseSummary : thinkingElapsed,
      replyMarkdown: replyMd || (!hasThinking ? "✨ **Thinking…**" : undefined),
    });
  }

  async function patchThinkingCard(isFinal: boolean) {
    if (thinkingCardFailed) return;
    // Rate limit intermediate patches to avoid Feishu 230020
    if (!isFinal && Date.now() - lastThinkingPatchTime < PATCH_MIN_INTERVAL_MS) {
      schedulePatch();
      return;
    }
    // Skip intermediate patches when reply contains markdown tables
    if (!isFinal && accumulatedReplyText && hasMarkdownTable(accumulatedReplyText)) {
      return;
    }
    // Optimistically claim the time slot so concurrent callers see "just patched"
    lastThinkingPatchTime = Date.now();
    // Wait for any in-flight card creation
    if (thinkingCardCreationPromise) {
      await thinkingCardCreationPromise;
    }
    const card = buildCurrentThinkingCard(isFinal);
    try {
      if (!thinkingCardMessageId) {
        const p = sendCardFeishu({
          cfg,
          to: chatId,
          card,
          replyToMessageId: sendReplyToMessageId,
          replyInThread: effectiveReplyInThread,
          accountId,
        }).then((result) => {
          thinkingCardMessageId = result.messageId;
          lastThinkingPatchTime = Date.now();
          thinkingCardCreationPromise = null;
        });
        thinkingCardCreationPromise = p;
        await p;
      } else {
        await updateCardFeishu({ cfg, messageId: thinkingCardMessageId, card, accountId });
        lastThinkingPatchTime = Date.now();
      }
    } catch (err) {
      params.runtime.log?.(`feishu: thinking card patch failed: ${String(err)}`);
      thinkingCardCreationPromise = null;
      if (!thinkingCardMessageId) thinkingCardFailed = true;
    }
  }

  function triggerThinkingUpdate() {
    if (thinkingStopped || thinkingCardFailed) return;
    hasThinkingContent = true;
    if (!thinkingStartedAt) thinkingStartedAt = Date.now();
    startThinkingTimer();
    // Rate-limited: only patch if enough time has passed, otherwise schedule
    if (Date.now() - lastThinkingPatchTime >= PATCH_MIN_INTERVAL_MS) {
      void patchThinkingCard(false);
    } else {
      schedulePatch();
    }
  }

  /** Deliver standalone message when thinking card can't be used */
  async function deliverStandalone(text: string) {
    const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));
    let first = true;
    if (useCard) {
      for (const chunk of core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode)) {
        await sendMarkdownCardFeishu({
          cfg,
          to: chatId,
          text: chunk,
          replyToMessageId: sendReplyToMessageId,
          replyInThread: effectiveReplyInThread,
          mentions: first ? mentionTargets : undefined,
          accountId,
        });
        first = false;
      }
    } else {
      const converted = core.channel.text.convertMarkdownTables(text, tableMode);
      for (const chunk of core.channel.text.chunkTextWithMode(
        converted,
        textChunkLimit,
        chunkMode,
      )) {
        await sendMessageFeishu({
          cfg,
          to: chatId,
          text: chunk,
          replyToMessageId: sendReplyToMessageId,
          replyInThread: effectiveReplyInThread,
          mentions: first ? mentionTargets : undefined,
          accountId,
        });
        first = false;
      }
    }
  }

  /** Final delivery: patch thinking card with reply, or send standalone */
  let standaloneDelivered = false;

  async function doDeliverFinalReply() {
    const fullText = accumulatedReplyText;
    if (!fullText.trim()) return;

    // If thinking card has a markdown table in reply, send table as standalone
    if (thinkingCardMessageId && hasMarkdownTable(fullText)) {
      thinkingStopped = true;
      // Collapse thinking on existing card (without reply text)
      try {
        const thinkingOnly = buildUnifiedCard({
          thinkingMarkdown: hasThinkingContent
            ? buildThinkingSection(thinkingText, activeTools, completedTools, 3000) ||
              "✨ Thinking…"
            : undefined,
          thinkingExpanded: false,
          thinkingTitle: buildThinkingCollapseSummary(completedTools, thinkingStartedAt),
          replyMarkdown: undefined,
        });
        await updateCardFeishu({
          cfg,
          messageId: thinkingCardMessageId,
          card: thinkingOnly,
          accountId,
        });
      } catch {
        /* best effort */
      }
      if (!standaloneDelivered) {
        standaloneDelivered = true;
        await deliverStandalone(fullText);
      }
      return;
    }

    if (thinkingCardMessageId) {
      thinkingStopped = true;
      let replyMd = fullText;
      if (mentionTargets?.length) {
        replyMd = buildMentionedCardContent(mentionTargets, replyMd);
      }
      const card = buildUnifiedCard({
        thinkingMarkdown: hasThinkingContent
          ? buildThinkingSection(thinkingText, activeTools, completedTools, 3000) || "✨ Thinking…"
          : undefined,
        thinkingExpanded: false,
        thinkingTitle: buildThinkingCollapseSummary(completedTools, thinkingStartedAt),
        replyMarkdown: replyMd,
      });
      // Retry up to 3 times with delay for rate limiting
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, PATCH_MIN_INTERVAL_MS));
          }
          await updateCardFeishu({ cfg, messageId: thinkingCardMessageId, card, accountId });
          return; // success
        } catch (err) {
          lastErr = err;
          params.runtime.log?.(
            `feishu: final card patch attempt ${attempt + 1} failed: ${String(err)}`,
          );
        }
      }
      // All retries failed — still don't create a duplicate standalone message.
      // The thinking card already exists; a partial card is better than two messages.
      params.runtime.log?.(`feishu: final card patch failed after retries: ${String(lastErr)}`);
    } else if (!standaloneDelivered) {
      standaloneDelivered = true;
      await deliverStandalone(fullText);
    }
  }

  // --- Streaming card helpers (for non-thinking scenarios) ---

  const mergeStreamingText = (nextText: string) => {
    if (!streamText) {
      streamText = nextText;
      return;
    }
    if (nextText.startsWith(streamText)) {
      streamText = nextText;
      return;
    }
    if (streamText.endsWith(nextText)) {
      return;
    }
    streamText += nextText;
  };

  const queueStreamingUpdate = (
    nextText: string,
    options?: { dedupeWithLastPartial?: boolean },
  ) => {
    if (!nextText) return;
    if (options?.dedupeWithLastPartial && nextText === lastPartial) return;
    if (options?.dedupeWithLastPartial) lastPartial = nextText;
    mergeStreamingText(nextText);
    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) await streamingStartPromise;
      if (streaming?.isActive()) await streaming.update(streamText);
    });
  };

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) return;
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) return;

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        await streaming.start(chatId, resolveReceiveIdType(chatId), {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
        });
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) await streamingStartPromise;
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = streamText;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      await streaming.close(text);
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
  };

  // --- Build dispatcher ---

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        // Do NOT start streaming here — in instant typing mode, onReplyStart fires
        // before reasoning stream data arrives, so hasThinkingContent is still false.
        // Streaming is deferred to onPartialReply where the decision can be made
        // after reasoning stream has had a chance to set hasThinkingContent.
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        const mediaList =
          payload.mediaUrls && payload.mediaUrls.length > 0
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];
        const hasText = Boolean(text.trim());
        const hasMedia = mediaList.length > 0;
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!hasText && !hasMedia) return;

        // --- Path A: Thinking card is active (message-patch approach) ---
        if (hasThinkingContent && !thinkingCardFailed && hasText) {
          // Collapse thinking on first reply content
          if (!thinkingStopped) {
            thinkingStopped = true;
            stopThinkingTimer();
            clearPendingPatch();
          }

          // Accumulate reply text
          if (
            accumulatedReplyText &&
            !accumulatedReplyText.endsWith("\n") &&
            !text.startsWith("\n")
          ) {
            accumulatedReplyText += "\n";
          }
          accumulatedReplyText += text;

          if (info?.kind === "final") {
            await doDeliverFinalReply();
          }

          // Send media separately
          if (hasMedia) {
            for (const mediaUrl of mediaList) {
              await sendMediaFeishu({
                cfg,
                to: chatId,
                mediaUrl,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                accountId,
              });
            }
          }
          return;
        }

        // --- Path B: Streaming card (no thinking) ---
        if (hasText) {
          const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

          if ((info?.kind === "block" || info?.kind === "final") && streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) await streamingStartPromise;
          }

          if (streaming?.isActive()) {
            if (info?.kind === "block") {
              queueStreamingUpdate(text);
            }
            if (info?.kind === "final") {
              mergeStreamingText(text);
              await closeStreaming();
              deliveredFinalTexts.add(text);
            }
            if (hasMedia) {
              for (const mediaUrl of mediaList) {
                await sendMediaFeishu({
                  cfg,
                  to: chatId,
                  mediaUrl,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  accountId,
                });
              }
            }
            return;
          }

          // --- Path C: Standalone delivery ---
          await deliverStandalone(text);
        }

        if (hasMedia) {
          for (const mediaUrl of mediaList) {
            await sendMediaFeishu({
              cfg,
              to: chatId,
              mediaUrl,
              replyToMessageId: sendReplyToMessageId,
              replyInThread: effectiveReplyInThread,
              accountId,
            });
          }
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        stopThinkingTimer();
        clearPendingPatch();
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        stopThinkingTimer();
        clearPendingPatch();
        thinkingStopped = true;
        // Deliver any remaining accumulated reply text via thinking card
        if (hasThinkingContent && accumulatedReplyText.trim() && !standaloneDelivered) {
          try {
            await doDeliverFinalReply();
          } catch (err) {
            params.runtime.log?.(`feishu: idle deliver failed: ${String(err)}`);
          }
        }
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        stopThinkingTimer();
        clearPendingPatch();
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onReasoningStream: (payload: ReplyPayload) => {
        if (payload.text) {
          thinkingText = payload.text;
          triggerThinkingUpdate();
        }
      },
      onReasoningEnd: () => {
        // Reasoning stream can end multiple times (once per tool-call round).
        // Don't collapse the panel here — let deliver/onIdle handle that.
        // Just flush a patch so the latest thinking text is visible.
        if (!thinkingStopped && !thinkingCardFailed && hasThinkingContent) {
          triggerThinkingUpdate();
        }
      },
      onAgentEvent: (evt: { stream?: string; data?: Record<string, unknown> }) => {
        if (evt.stream === "tool") {
          const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
          const toolCallId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId : "";
          const name = typeof evt.data?.name === "string" ? evt.data.name : "";
          if (phase === "start" && toolCallId) {
            const args =
              evt.data?.args && typeof evt.data.args === "object"
                ? (evt.data.args as Record<string, unknown>)
                : undefined;
            activeTools.set(toolCallId, { name, args, startedAt: Date.now() });
            triggerThinkingUpdate();
          } else if (phase === "result" && toolCallId) {
            const entry = activeTools.get(toolCallId);
            if (entry) {
              activeTools.delete(toolCallId);
              completedTools.push({ ...entry, failed: Boolean(evt.data?.isError) });
            }
            triggerThinkingUpdate();
          }
        }
      },
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            // Only use streaming partial updates when NOT using thinking card
            if (hasThinkingContent && !thinkingCardFailed) return;
            if (!payload.text) return;
            // Lazily start streaming card on first partial text (deferred from onReplyStart)
            if (renderMode === "card") {
              startStreaming();
            }
            queueStreamingUpdate(payload.text, { dedupeWithLastPartial: true });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
