import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  CliBackendParseJsonlEvent,
  CliBackendParsedJsonlEvent,
} from "../plugins/cli-backend.types.js";
import type {
  CliJsonlStreamingParserOptions,
  CliOutput,
  CliUsage,
} from "./cli-output-contracts.js";
import type { CliEventProjectionState, ThinkingTracker } from "./cli-output-events.js";
import {
  createLeadingTaggedReasoningRouter,
  dispatchClaudeCliStreamingToolEvent,
  dispatchClaudeCliThinking,
  dispatchGeminiCliStreamingToolEvent,
  partitionLeadingTaggedReasoning,
  projectCliBackendEvent,
  projectCliTaggedReasoning,
} from "./cli-output-events.js";
import * as cliOutputLifecycle from "./cli-output-lifecycle.js";
import {
  decodeCliRecords,
  isClaudeStopHookFeedbackRecord,
  isClaudeStreamJsonDialect,
  isClaudeSyntheticNoResponse,
  isClaudeSubagentRecord,
  isClaudeToolUseBlockType,
  isGeminiStreamJsonDialect,
  parseClaudeCliJsonlResult,
  parseClaudeCliStreamingDelta,
  pickCliResumeCheckpointId,
  pickCliSessionId,
  preferGeminiCliStreamJsonError,
  readClaudeAttributedSubagentProgressId,
  readCliUsage,
  readGeminiCliStreamJsonError,
  supportsCliJsonlToolEvents,
} from "./cli-output-records.js";
import { createClaudeReplyBoundary } from "./cli-output-reply-boundary.js";
import { appendCliResultText, recordItemText, withCliRawFinalText } from "./cli-output-results.js";
import {
  createClaudePostBudgetWatcher,
  createCliStreamJsonTurnBudget,
  createTerminalResultEventDispatcher,
} from "./cli-output-stream-budget.js";
import {
  chargeClaudeStreamJsonLine,
  CLI_STREAM_JSON_OUTPUT_LIMITS,
  frameBoundedCliJsonlChunk,
  streamJsonOutputLimitErrorText,
} from "./cli-output-stream-limits.js";
import { resolveCliStreamOutput } from "./cli-output-stream-output.js";
import { createToolUseTracker } from "./cli-output-tool-tracker.js";
export { CLI_STREAM_JSON_MISSING_RESULT_ERROR } from "./cli-output-stream-output.js";
const CLAUDE_SYNTHETIC_NO_RESPONSE_ERROR = "Claude CLI returned a synthetic no-response result.";

export function createCliJsonlStreamingParser(params: CliJsonlStreamingParserOptions) {
  const lineBuffer = { pending: "" };
  let assistantText = "";
  let customThinkingText = "";
  let pendingClaudeText = "";
  let currentClaudeMessageId: string | undefined;
  let currentClaudeMessageText = "";
  const replyBoundary = createClaudeReplyBoundary();
  // Commentary-buffered text skips emitClaudeVisibleText's boundary handling;
  // this diagnostics-only offset marks where its current message starts.
  let flushedMessageStart = 0;
  let sessionId: string | undefined;
  let resumeCheckpointId: string | undefined;
  let usage: CliUsage | undefined;
  let diagnosticUsage: CliUsage | undefined;
  let output: CliOutput | null = null;
  let parseErrorText = "";
  const texts: string[] = [];
  // The last item text is the final message only until a later message or tool
  // call begins; boundary flags set before that text must not blank it.
  let finalItemText: string | undefined;
  let sawCustomJsonlEvent = false;
  let sawGeminiStructuredOutput = false;
  let sawTerminalResult = false;
  let sawClaudeSyntheticNoResponse = false;
  const toolTracker = createToolUseTracker();
  const outputLimits = CLI_STREAM_JSON_OUTPUT_LIMITS;
  const turnBudget = createCliStreamJsonTurnBudget(outputLimits);
  // Classification is keyed on consumer presence so reclassified pre-tool text
  // always has a destination; a separate enable flag let it be dropped (#92092).
  const classifyClaudeCommentary =
    Boolean(params.onCommentaryText) && supportsCliJsonlToolEvents(params);
  const thinkingTracker: ThinkingTracker = {
    streamedByIndex: new Map(),
    highestStreamedIndex: Number.NEGATIVE_INFINITY,
    emittedText: "",
    nextSyntheticBlockIndex: 0,
    progressTokens: 0,
  };
  const claudeStreamJson = isClaudeStreamJsonDialect(params);
  let taggedReasoningRouter = createLeadingTaggedReasoningRouter();
  let currentTaggedReasoningText = "";

  const appendAssistantText = (delta: string) => {
    assistantText += delta;
    params.onAssistantDelta({ text: assistantText, delta, sessionId, usage });
  };

  const flushPendingClaudeAssistantText = () => {
    if (!pendingClaudeText) {
      return;
    }
    const delta = pendingClaudeText;
    pendingClaudeText = "";
    // A flushed assistant segment after a boundary starts a fresh
    // final-message segment; commentary routing never touches it.
    if (replyBoundary.boundaryPending()) {
      flushedMessageStart = assistantText.length;
    }
    replyBoundary.clearBoundary();
    appendAssistantText(delta);
  };

  const flushPendingClaudeCommentaryText = () => {
    if (!pendingClaudeText) {
      return;
    }
    const text = pendingClaudeText.trim();
    pendingClaudeText = "";
    if (text) {
      params.onCommentaryText?.(text);
    }
  };

  const emitClaudeVisibleText = (delta: string) => {
    if (!delta) {
      return;
    }
    if (classifyClaudeCommentary) {
      pendingClaudeText = `${pendingClaudeText}${delta}`;
      return;
    }
    appendAssistantText(`${replyBoundary.settleText(assistantText, delta)}${delta}`);
  };

  const routeTaggedReasoningDeltas = (
    deltas: Parameters<typeof projectCliTaggedReasoning>[0]["deltas"],
  ) => {
    currentTaggedReasoningText = projectCliTaggedReasoning({
      deltas,
      currentText: currentTaggedReasoningText,
      hasNativeThinking: Boolean(thinkingTracker.emittedText),
      onThinkingDelta: params.onThinkingDelta,
      onVisibleText: emitClaudeVisibleText,
    });
  };

  const finishTaggedReasoningMessage = () => {
    if (claudeStreamJson) {
      routeTaggedReasoningDeltas(taggedReasoningRouter.finish());
    }
  };

  // The boundary facts alone; past a spent budget nothing is left to flush.
  const markClaudeMessageBoundary = (messageId?: string) => {
    replyBoundary.beginMessage();
    finalItemText = undefined;
    currentClaudeMessageId = messageId;
    currentClaudeMessageText = "";
  };
  const beginClaudeMessage = (messageId?: string) => {
    finishTaggedReasoningMessage();
    taggedReasoningRouter = createLeadingTaggedReasoningRouter();
    currentTaggedReasoningText = "";
    markClaudeMessageBoundary(messageId);
  };
  // A stream delta can precede the first identified snapshot for the same
  // message, so the first id names the open message; a later new id begins one.
  const observeClaudeMessageId = (messageId: unknown, begin: (id: string) => void) => {
    if (typeof messageId !== "string" || !messageId || messageId === currentClaudeMessageId) {
      return;
    }
    if (currentClaudeMessageId === undefined) {
      currentClaudeMessageId = messageId;
    } else {
      begin(messageId);
    }
  };
  const markClaudeToolUse = () => {
    replyBoundary.markToolUse();
    finalItemText = undefined;
    if (classifyClaudeCommentary) {
      flushPendingClaudeCommentaryText();
    }
  };

  // Diagnostics need the model's final message alone; `text` stays the
  // cumulative delivery reply. The final message is the last streamed segment,
  // empty when a new message began or a tool call followed its last text.
  const finalStreamedMessageText = () =>
    finalItemText?.trim() ??
    (replyBoundary.boundaryPending()
      ? ""
      : assistantText.slice(Math.max(replyBoundary.finalMessageStart, flushedMessageStart)).trim());

  const handleCustomJsonlEvent = (event: CliBackendParsedJsonlEvent) => {
    const previousOutput = output;
    const state: CliEventProjectionState = {
      assistantText,
      customThinkingText,
      sessionId,
      usage,
      output,
      sawCustomJsonlEvent,
    };
    projectCliBackendEvent({
      ...params,
      event,
      state,
      texts,
      toolTracker,
    });
    ({ assistantText, customThinkingText, sessionId, usage, output, sawCustomJsonlEvent } = state);
    // Custom events carry no message boundaries: a tool start begins the next
    // final-message segment, so pre-tool narration is never the final message.
    if (event.kind === "toolStart") {
      replyBoundary.startFinalMessageSegment(assistantText.length);
    } else if (event.kind === "result" && output && !output.errorText) {
      // A metadata-only result keeps the earlier result's final message.
      const prior = previousOutput?.rawFinalText ?? previousOutput?.text.trim();
      const finalText = event.text?.trim() || (prior ?? finalStreamedMessageText());
      output = withCliRawFinalText(output, finalText);
    }
  };

  const dispatchTerminalResultEvents = createTerminalResultEventDispatcher((event) => {
    sawTerminalResult = true;
    handleCustomJsonlEvent(event);
  });

  // A line a custom or lifecycle parser claims is an ordinary frame: it pays a
  // line as well as its characters, whatever it decodes to.
  const chargeClaudeRawLine = (chars: number) =>
    !claudeStreamJson || (turnBudget.chargeLine() && turnBudget.chargeChars(chars));

  const observeSessionId = (parsed: Record<string, unknown>) => {
    const parsedSessionId = pickCliSessionId(parsed, params.backend);
    if (parsedSessionId && parsedSessionId !== sessionId) {
      sessionId = parsedSessionId;
      params.onSessionId?.(parsedSessionId);
    }
  };

  const handleCustomJsonlLine = (line: string, rawLine: string): boolean => {
    const lifecycle = cliOutputLifecycle.parseCliBackendLifecycleLine({
      line,
      backendId: params.providerId,
      backend: params.backend,
      parse: params.parseJsonlLifecycleEvent,
    });
    if (lifecycle) {
      if ("errorText" in lifecycle) {
        parseErrorText = lifecycle.errorText;
      } else {
        if (chargeClaudeRawLine(rawLine.length + 1)) {
          for (const parsed of decodeCliRecords(line)) {
            observeSessionId(parsed);
          }
        }
        // The line that spends the budget may itself be a compaction phase.
        // Only assembly stops when the budget is gone; the watchdog still has to
        // know a silent compaction is running, or finish, on that very record.
        for (const event of lifecycle.events) {
          params.onCompaction?.(cliOutputLifecycle.projectCliBackendLifecycleEvent(event));
        }
      }
      return true;
    }
    if (!params.parseJsonlEvent) {
      return false;
    }
    let parsed: ReturnType<CliBackendParseJsonlEvent>;
    try {
      parsed = params.parseJsonlEvent(line, {
        backendId: params.providerId,
        backend: params.backend,
      });
    } catch (error) {
      parseErrorText = truncateUtf16Safe(
        `CLI backend ${params.providerId} JSONL parser failed: ${formatErrorMessage(error)}`,
        500,
      );
      return true;
    }
    if (parsed == null) {
      return false;
    }
    if (!chargeClaudeRawLine(rawLine.length + 1)) {
      // The line that exhausts the budget may itself be the terminal result.
      dispatchTerminalResultEvents(parsed);
      return true;
    }
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      if (event.kind === "result") {
        sawTerminalResult = true;
      }
      handleCustomJsonlEvent(event);
    }
    return true;
  };

  // Committed or rejected text cannot join the next reply through a tool split.
  const resetReplySegment = () => {
    replyBoundary.rebase(assistantText.length);
  };

  const handleParsedRecord = (parsed: Record<string, unknown>) => {
    if (parseErrorText) {
      return;
    }
    const attributedParentToolUseId = readClaudeAttributedSubagentProgressId(parsed);
    if (attributedParentToolUseId) {
      params.onAttributedSubagentProgress?.(attributedParentToolUseId);
    }
    if (
      claudeStreamJson &&
      parsed.type === "system" &&
      parsed.subtype === "init" &&
      !isClaudeSubagentRecord(parsed)
    ) {
      try {
        params.onNativeTools?.(parsed.tools);
      } catch (error) {
        parseErrorText = truncateUtf16Safe(formatErrorMessage(error), 500);
        return;
      }
    }
    if (
      parsed.type === "result" &&
      parsed.openclaw_interim_result !== true &&
      supportsCliJsonlToolEvents(params)
    ) {
      sawTerminalResult = true;
    }
    observeSessionId(parsed);
    const nextUsage = readCliUsage(parsed);
    const isClaudeTerminalResult = claudeStreamJson && parsed.type === "result";
    if (isClaudeTerminalResult && nextUsage && usage) {
      diagnosticUsage = nextUsage;
    }
    if (nextUsage) {
      params.onUsage?.(nextUsage, isClaudeTerminalResult);
    }
    const shouldUseUsage =
      !supportsCliJsonlToolEvents(params) || parsed.type !== "result" || !usage;
    if (shouldUseUsage) {
      usage = nextUsage ?? usage;
    }
    if (
      parsed.type === "assistant" &&
      isRecord(parsed.message) &&
      !isClaudeSubagentRecord(parsed)
    ) {
      if (claudeStreamJson) {
        observeClaudeMessageId(parsed.message.id, beginClaudeMessage);
      }
      resumeCheckpointId = pickCliResumeCheckpointId({ ...params, parsed }) ?? resumeCheckpointId;
      params.onAssistantMessage?.(parsed.message);
      if (claudeStreamJson && isClaudeSyntheticNoResponse(parsed)) {
        sawClaudeSyntheticNoResponse = true;
      }
    }
    const geminiErrorText = isGeminiStreamJsonDialect(params)
      ? readGeminiCliStreamJsonError(parsed)
      : undefined;
    if (
      isGeminiStreamJsonDialect(params) &&
      (parsed.type === "tool_use" || parsed.type === "tool_result" || parsed.type === "result")
    ) {
      sawGeminiStructuredOutput = true;
      // A Gemini tool call ends the message before it, like a tool_use block.
      if (parsed.type === "tool_use") {
        replyBoundary.markToolUseWithoutMessage();
      }
    }
    if (geminiErrorText) {
      output = {
        text: "",
        sessionId,
        usage,
        errorText: preferGeminiCliStreamJsonError(output?.errorText, geminiErrorText),
      };
      return;
    }

    const stopHookFeedback =
      claudeStreamJson && !isClaudeSubagentRecord(parsed) && isClaudeStopHookFeedbackRecord(parsed);
    if (parsed.type === "result" || stopHookFeedback) {
      finishTaggedReasoningMessage();
      if (classifyClaudeCommentary) {
        flushPendingClaudeAssistantText();
      }
    }

    if (stopHookFeedback) {
      resetReplySegment();
    }

    const result = parseClaudeCliJsonlResult({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      sessionId,
      usage,
    });
    if (result) {
      // A stopped turn is only a failure when nothing was delivered; text
      // streamed before the stop is still the reply, so this one defers until
      // the resolved text below is known.
      const stoppedTurn =
        result.terminalFailure?.reason === "turn_stopped" ? result.terminalFailure : undefined;
      const stoppedTurnErrorText = stoppedTurn ? (result.errorText ?? "") : "";
      if (stoppedTurn) {
        delete result.errorText;
        delete result.terminalFailure;
      } else if (result.errorText) {
        output = result;
        return;
      }
      if (claudeStreamJson && result.text) {
        const taggedResult = partitionLeadingTaggedReasoning(result.text, true);
        if (!taggedResult.pending && taggedResult.reasoningText) {
          if (
            !thinkingTracker.emittedText &&
            taggedResult.reasoningText !== currentTaggedReasoningText
          ) {
            currentTaggedReasoningText = projectCliTaggedReasoning({
              deltas: [{ kind: "thinking", text: taggedResult.reasoningText }],
              currentText: "",
              hasNativeThinking: false,
              onThinkingDelta: params.onThinkingDelta,
              onVisibleText: emitClaudeVisibleText,
            });
          }
          result.text = taggedResult.visibleText.trim();
        }
      }
      const nextText = replyBoundary.resolveReplyText({
        assistantText,
        resultText: result.text,
        fallbackText: () => texts.join("\n").trim(),
      });
      const { text, textParts, completedText } = appendCliResultText(output, nextText);
      const syntheticNoResponse =
        sawClaudeSyntheticNoResponse &&
        parsed.subtype === "success" &&
        !text &&
        toolTracker.pendingByIndex.size === 0 &&
        toolTracker.startedIds.size === 0 &&
        toolTracker.resultDeliveredIds.size === 0;
      output = {
        ...result,
        text,
        ...((textParts.length > 1 ||
          output?.textParts ||
          parsed.openclaw_interim_result === true) &&
        !(stoppedTurn && !nextText)
          ? { textParts }
          : {}),
        ...(syntheticNoResponse
          ? {
              errorText: CLAUDE_SYNTHETIC_NO_RESPONSE_ERROR,
              terminalFailure: { reason: "synthetic_no_response" as const },
            }
          : {}),
        // The CLI's own terminal reason outranks the synthetic marker: it names
        // why the turn stopped and must not be retried like a format fault.
        // Delivery is judged on this result's own segment; text an earlier
        // interim result already committed is not this turn's reply.
        ...(stoppedTurn && !nextText
          ? { text: "", errorText: stoppedTurnErrorText, terminalFailure: stoppedTurn }
          : {}),
        ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
        ...(diagnosticUsage ? { diagnosticUsage } : {}),
      };
      // The result envelope carries the final message when present.
      output = withCliRawFinalText(output, result.text?.trim() || finalStreamedMessageText());
      if (
        parsed.openclaw_interim_result === true &&
        completedText &&
        !output.errorText &&
        !output.terminalFailure
      ) {
        params.onCompletedReply?.(completedText, textParts.length - 1);
      }
      resetReplySegment();
      return;
    }

    finalItemText = recordItemText(parsed, texts, finalItemText);

    if (parsed.type === "stream_event" && isRecord(parsed.event)) {
      const evt = parsed.event;
      // Tool-split turns stream as separate assistant messages. Mark the
      // boundary so accumulated text joins with a paragraph break instead of
      // gluing the pre-tool text to the next message's first delta.
      if (evt.type === "message_start") {
        const message = isRecord(evt.message) ? evt.message : undefined;
        beginClaudeMessage(typeof message?.id === "string" ? message.id : undefined);
      } else if (evt.type === "message_stop") {
        finishTaggedReasoningMessage();
      }
      const isToolUseBlockStart =
        evt.type === "content_block_start" &&
        isRecord(evt.content_block) &&
        isClaudeToolUseBlockType(evt.content_block.type);
      if (isToolUseBlockStart) {
        markClaudeToolUse();
      } else if (
        classifyClaudeCommentary &&
        (evt.type === "content_block_start" || evt.type === "message_stop")
      ) {
        flushPendingClaudeAssistantText();
      }
    }

    if (params.onThinkingDelta || params.onThinkingProgress) {
      dispatchClaudeCliThinking({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: thinkingTracker,
        onThinkingDelta: params.onThinkingDelta,
        onThinkingProgress: params.onThinkingProgress,
      });
    }

    const delta = parseClaudeCliStreamingDelta({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      previousText: currentClaudeMessageText,
    });
    if (delta) {
      currentClaudeMessageText = `${currentClaudeMessageText}${delta}`;
      if (claudeStreamJson) {
        routeTaggedReasoningDeltas(taggedReasoningRouter.push(delta));
      } else {
        emitClaudeVisibleText(delta);
      }
    }

    if (params.onToolUseStart || params.onToolResult) {
      dispatchGeminiCliStreamingToolEvent({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: toolTracker,
        onToolUseStart: params.onToolUseStart,
        onToolResult: params.onToolResult,
      });
    }
    if (
      claudeStreamJson ||
      params.onToolUseStart ||
      params.onToolInputDelta ||
      params.onToolResult
    ) {
      const onToolUseStart =
        claudeStreamJson && parsed.type === "assistant"
          ? (tool: Parameters<NonNullable<typeof params.onToolUseStart>>[0]) => {
              markClaudeToolUse();
              params.onToolUseStart?.(tool);
            }
          : params.onToolUseStart;
      dispatchClaudeCliStreamingToolEvent({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: toolTracker,
        onToolUseStart,
        onToolInputDelta: params.onToolInputDelta,
        onToolResult: params.onToolResult,
      });
    }
    if (!delta && isGeminiStreamJsonDialect(params)) {
      if (
        parsed.type === "message" &&
        parsed.role === "assistant" &&
        typeof parsed.content === "string" &&
        parsed.content
      ) {
        // Tool output before this text starts a new final-message segment so
        // pre-tool narration is never the final message.
        replyBoundary.startFinalMessageSegmentAfterToolUse(assistantText.length);
        appendAssistantText(parsed.content);
      } else if (parsed.type === "result" && parsed.status === "success") {
        output = withCliRawFinalText(
          {
            text: assistantText.trim(),
            sessionId,
            usage,
          },
          finalStreamedMessageText(),
        );
      }
    }
  };

  const handlePostBudgetLine = createClaudePostBudgetWatcher({
    ...params,
    tracker: toolTracker,
    hasTerminalResult: () => sawTerminalResult,
    onResultEvents: dispatchTerminalResultEvents,
    onResultRecord: handleParsedRecord,
    // Nothing is assembled past the budget, so no tagged reasoning is flushed.
    boundaries: {
      onMessageStart: markClaudeMessageBoundary,
      onAssistantMessageId: (id) => observeClaudeMessageId(id, markClaudeMessageBoundary),
      onToolUse: markClaudeToolUse,
      onText: (record) => {
        // Diffed against the text assembled before the budget, which never grows.
        const delta = parseClaudeCliStreamingDelta({
          backend: params.backend,
          providerId: params.providerId,
          parsed: record,
          previousText: currentClaudeMessageText,
        });
        if (delta) {
          // With a commentary consumer pre-tool text is commentary, never reply.
          replyBoundary.dropText(assistantText, delta, !classifyClaudeCommentary);
        }
      },
    },
  });

  const handleJsonlLine = (rawLine: string) => {
    if (parseErrorText) {
      return;
    }
    const line = rawLine.trim();
    if (!line && !claudeStreamJson) {
      return;
    }
    if (!turnBudget.observeLine(claudeStreamJson) && !claudeStreamJson) {
      parseErrorText = turnBudget.errorText(false);
      lineBuffer.pending = "";
      return;
    }
    if (turnBudget.exhausted) {
      handlePostBudgetLine(line);
      return;
    }
    if (!line) {
      // An actual blank Claude frame is an ordinary record: it pays a line too.
      turnBudget.chargeLine();
      turnBudget.chargeChars(rawLine.length + 1);
      return;
    }
    if (handleCustomJsonlLine(line, rawLine)) {
      return;
    }
    const parsedRecords = decodeCliRecords(line);
    if (claudeStreamJson) {
      const record = parsedRecords.length === 1 ? parsedRecords[0] : undefined;
      // Owns every discount, including the fixed allowance for the forwarded
      // subagent message records the parent lane discards. Also normalizes
      // Claude's echoed binary in place, as the dispatch below and the
      // post-budget watcher both require.
      const charge = chargeClaudeStreamJsonLine(record, rawLine);
      // Partial-message deltas and the discarded control frames that share
      // their per-frame callbacks are consumed as soon as they're assembled, so
      // they are exempt from the ordinary line odometer (matches
      // #150132/#153545); every other Claude line still counts, forwarded
      // subagent records included.
      if (!charge.partialMessage && !turnBudget.chargeLine()) {
        // The line that exhausts the budget may itself be the terminal result.
        handlePostBudgetLine(line);
        return;
      }
      if (!turnBudget.chargeChars(charge.chars + 1)) {
        // The line that exhausts the budget may itself be the terminal result.
        handlePostBudgetLine(line);
        return;
      }
    }
    for (const parsed of parsedRecords) {
      handleParsedRecord(parsed);
    }
  };

  return {
    push(chunk: string) {
      if (!chunk || parseErrorText) {
        return;
      }
      if (!claudeStreamJson && !turnBudget.chargeChars(chunk.length)) {
        parseErrorText = turnBudget.errorText(false);
        lineBuffer.pending = "";
        return;
      }
      if (
        !frameBoundedCliJsonlChunk(lineBuffer, chunk, (line) => {
          handleJsonlLine(line);
          return !parseErrorText;
        })
      ) {
        parseErrorText = streamJsonOutputLimitErrorText("line", outputLimits.maxPendingLineChars);
      }
    },
    finish() {
      try {
        if (parseErrorText) {
          return;
        }
        const tail = lineBuffer.pending;
        lineBuffer.pending = "";
        if (tail) {
          handleJsonlLine(tail);
        }
        finishTaggedReasoningMessage();
        if (classifyClaudeCommentary) {
          flushPendingClaudeAssistantText();
        }
      } finally {
        toolTracker.inputProgressById.clear();
      }
    },
    getErrorText() {
      return parseErrorText || turnBudget.errorText(sawTerminalResult) || null;
    },
    /**
     * A refusal no later record can lift. A spent Claude turn budget is not one:
     * its terminal result can still arrive, so the run must be left running.
     */
    getUnrecoverableErrorText() {
      return parseErrorText || null;
    },
    /** Non-null when a budget was spent but the finished turn was still recovered. */
    getOutputTruncationText() {
      return turnBudget.truncationText(sawTerminalResult);
    },
    hasTerminalResult() {
      return sawTerminalResult;
    },
    getOutput(): (CliOutput & { partialOutputRejected?: true }) | null {
      const errorText = parseErrorText || turnBudget.errorText(sawTerminalResult);
      if (errorText) {
        return {
          text: "",
          sessionId,
          usage,
          ...(diagnosticUsage ? { diagnosticUsage } : {}),
          errorText,
        };
      }
      if (output) {
        return output;
      }
      return resolveCliStreamOutput({
        params,
        texts,
        assistantText,
        sessionId,
        usage,
        resumeCheckpointId,
        // Every frame the parser saw, including the ones the odometers discount
        // or exempt: output presence is a fact about the stream, not a charge.
        rawLines: turnBudget.lines,
        sawCustomJsonlEvent,
        sawGeminiStructuredOutput,
        claudeStreamJson,
        finalStreamedMessageText,
      });
    },
  };
}
