import { estimateTokens, generateSummary } from "@mariozechner/pi-coding-agent";

//#region src/agents/defaults.ts
const DEFAULT_CONTEXT_TOKENS = 2e5;

//#endregion
//#region src/agents/session-transcript-repair.ts
function extractToolCallsFromAssistant(msg) {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const toolCalls = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block;
    if (typeof rec.id !== "string" || !rec.id) {
      continue;
    }
    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : void 0,
      });
    }
  }
  return toolCalls;
}
function extractToolResultId(msg) {
  const toolCallId = msg.toolCallId;
  if (typeof toolCallId === "string" && toolCallId) {
    return toolCallId;
  }
  const toolUseId = msg.toolUseId;
  if (typeof toolUseId === "string" && toolUseId) {
    return toolUseId;
  }
  return null;
}
function makeMissingToolResult(params) {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  };
}
function repairToolUseResultPairing(messages) {
  const out = [];
  const added = [];
  const seenToolResultIds = /* @__PURE__ */ new Set();
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  let moved = false;
  let changed = false;
  const pushToolResult = (msg) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) {
      droppedDuplicateCount += 1;
      changed = true;
      return;
    }
    if (id) {
      seenToolResultIds.add(id);
    }
    out.push(msg);
  };
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }
    const role = msg.role;
    if (role !== "assistant") {
      if (role !== "toolResult") {
        out.push(msg);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }
    const assistant = msg;
    const stopReason = assistant.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      out.push(msg);
      continue;
    }
    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      out.push(msg);
      continue;
    }
    const toolCallIds = new Set(toolCalls.map((t) => t.id));
    const spanResultsById = /* @__PURE__ */ new Map();
    const remainder = [];
    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j];
      if (!next || typeof next !== "object") {
        remainder.push(next);
        continue;
      }
      const nextRole = next.role;
      if (nextRole === "assistant") {
        break;
      }
      if (nextRole === "toolResult") {
        const toolResult = next;
        const id = extractToolResultId(toolResult);
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id)) {
            droppedDuplicateCount += 1;
            changed = true;
            continue;
          }
          if (!spanResultsById.has(id)) {
            spanResultsById.set(id, toolResult);
          }
          continue;
        }
      }
      if (nextRole !== "toolResult") {
        remainder.push(next);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
    }
    out.push(msg);
    if (spanResultsById.size > 0 && remainder.length > 0) {
      moved = true;
      changed = true;
    }
    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else {
        const missing = makeMissingToolResult({
          toolCallId: call.id,
          toolName: call.name,
        });
        added.push(missing);
        changed = true;
        pushToolResult(missing);
      }
    }
    for (const rem of remainder) {
      if (!rem || typeof rem !== "object") {
        out.push(rem);
        continue;
      }
      out.push(rem);
    }
    i = j - 1;
  }
  const changedOrMoved = changed || moved;
  return {
    messages: changedOrMoved ? out : messages,
    added,
    droppedDuplicateCount,
    droppedOrphanCount,
    moved: changedOrMoved,
  };
}

//#endregion
//#region src/agents/compaction.ts
const BASE_CHUNK_RATIO = 0.4;
const MIN_CHUNK_RATIO = 0.15;
const SAFETY_MARGIN = 1.2;
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;
const MERGE_SUMMARIES_INSTRUCTIONS =
  "Merge these partial summaries into a single cohesive summary. Preserve decisions, TODOs, open questions, and any constraints.";
function stripToolResultDetails(messages) {
  let touched = false;
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "toolResult") {
      out.push(msg);
      continue;
    }
    if (!("details" in msg)) {
      out.push(msg);
      continue;
    }
    const { details: _details, ...rest } = msg;
    touched = true;
    out.push(rest);
  }
  return touched ? out : messages;
}
function estimateMessagesTokens(messages) {
  return stripToolResultDetails(messages).reduce(
    (sum, message) => sum + estimateTokens(message),
    0,
  );
}
function normalizeParts(parts, messageCount) {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}
function splitMessagesByTokenShare(messages, parts = DEFAULT_PARTS) {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }
  const targetTokens = estimateMessagesTokens(messages) / normalizedParts;
  const chunks = [];
  let current = [];
  let currentTokens = 0;
  for (const message of messages) {
    const messageTokens = estimateTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
function chunkMessagesByMaxTokens(messages, maxTokens) {
  if (messages.length === 0) {
    return [];
  }
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;
  for (const message of messages) {
    const messageTokens = estimateTokens(message);
    if (currentChunk.length > 0 && currentTokens + messageTokens > maxTokens) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
    currentChunk.push(message);
    currentTokens += messageTokens;
    if (messageTokens > maxTokens) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  return chunks;
}
/**
 * Compute adaptive chunk ratio based on average message size.
 * When messages are large, we use smaller chunks to avoid exceeding model limits.
 */
function computeAdaptiveChunkRatio(messages, contextWindow) {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }
  const avgRatio =
    ((estimateMessagesTokens(messages) / messages.length) * SAFETY_MARGIN) / contextWindow;
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }
  return BASE_CHUNK_RATIO;
}
/**
 * Check if a single message is too large to summarize.
 * If single message > 50% of context, it can't be summarized safely.
 */
function isOversizedForSummary(msg, contextWindow) {
  return estimateTokens(msg) * SAFETY_MARGIN > contextWindow * 0.5;
}
async function summarizeChunks(params) {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }
  const chunks = chunkMessagesByMaxTokens(
    stripToolResultDetails(params.messages),
    params.maxChunkTokens,
  );
  let summary = params.previousSummary;
  for (const chunk of chunks) {
    summary = await generateSummary(
      chunk,
      params.model,
      params.reserveTokens,
      params.apiKey,
      params.signal,
      params.customInstructions,
      summary,
    );
  }
  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}
/**
 * Summarize with progressive fallback for handling oversized messages.
 * If full summarization fails, tries partial summarization excluding oversized messages.
 */
async function summarizeWithFallback(params) {
  const { messages, contextWindow } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }
  try {
    return await summarizeChunks(params);
  } catch (fullError) {
    console.warn(
      `Full summarization failed, trying partial: ${fullError instanceof Error ? fullError.message : String(fullError)}`,
    );
  }
  const smallMessages = [];
  const oversizedNotes = [];
  for (const msg of messages) {
    if (isOversizedForSummary(msg, contextWindow)) {
      const role = msg.role ?? "message";
      const tokens = estimateTokens(msg);
      oversizedNotes.push(
        `[Large ${role} (~${Math.round(tokens / 1e3)}K tokens) omitted from summary]`,
      );
    } else smallMessages.push(msg);
  }
  if (smallMessages.length > 0) {
    try {
      return (
        (await summarizeChunks({
          ...params,
          messages: smallMessages,
        })) + (oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "")
      );
    } catch (partialError) {
      console.warn(
        `Partial summarization also failed: ${partialError instanceof Error ? partialError.message : String(partialError)}`,
      );
    }
  }
  return `Context contained ${messages.length} messages (${oversizedNotes.length} oversized). Summary unavailable due to size limits.`;
}
async function summarizeInStages(params) {
  const { messages } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }
  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
  const totalTokens = estimateMessagesTokens(messages);
  if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) {
    return summarizeWithFallback(params);
  }
  const splits = splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0);
  if (splits.length <= 1) {
    return summarizeWithFallback(params);
  }
  const partialSummaries = [];
  for (const chunk of splits) {
    partialSummaries.push(
      await summarizeWithFallback({
        ...params,
        messages: chunk,
        previousSummary: void 0,
      }),
    );
  }
  if (partialSummaries.length === 1) {
    return partialSummaries[0];
  }
  const summaryMessages = partialSummaries.map((summary) => ({
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }));
  const mergeInstructions = params.customInstructions
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\nAdditional focus:\n${params.customInstructions}`
    : MERGE_SUMMARIES_INSTRUCTIONS;
  return summarizeWithFallback({
    ...params,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
}
function pruneHistoryForContextShare(params) {
  const maxHistoryShare = params.maxHistoryShare ?? 0.5;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
  let keptMessages = params.messages;
  const allDroppedMessages = [];
  let droppedChunks = 0;
  let droppedMessages = 0;
  let droppedTokens = 0;
  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);
  while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
    const chunks = splitMessagesByTokenShare(keptMessages, parts);
    if (chunks.length <= 1) {
      break;
    }
    const [dropped, ...rest] = chunks;
    const repairReport = repairToolUseResultPairing(rest.flat());
    const repairedKept = repairReport.messages;
    const orphanedCount = repairReport.droppedOrphanCount;
    droppedChunks += 1;
    droppedMessages += dropped.length + orphanedCount;
    droppedTokens += estimateMessagesTokens(dropped);
    allDroppedMessages.push(...dropped);
    keptMessages = repairedKept;
  }
  return {
    messages: keptMessages,
    droppedMessagesList: allDroppedMessages,
    droppedChunks,
    droppedMessages,
    droppedTokens,
    keptTokens: estimateMessagesTokens(keptMessages),
    budgetTokens,
  };
}
function resolveContextWindowTokens(model) {
  return Math.max(1, Math.floor(model?.contextWindow ?? DEFAULT_CONTEXT_TOKENS));
}

//#endregion
//#region src/agents/pi-extensions/compaction-safeguard-runtime.ts
const REGISTRY = /* @__PURE__ */ new WeakMap();
function getCompactionSafeguardRuntime(sessionManager) {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }
  return REGISTRY.get(sessionManager) ?? null;
}

//#endregion
//#region src/agents/pi-extensions/compaction-safeguard.ts
const FALLBACK_SUMMARY =
  "Summary unavailable due to context limits. Older messages were truncated.";
const TURN_PREFIX_INSTRUCTIONS =
  "This summary covers the prefix of a split turn. Focus on the original request, early progress, and any details needed to understand the retained suffix.";
const MAX_TOOL_FAILURES = 8;
const MAX_LAST_TURN_TOKENS = 4e3;
const MAX_TOOL_FAILURE_CHARS = 240;
function normalizeFailureText(text) {
  return text.replace(/\s+/g, " ").trim();
}
function truncateFailureText(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
function formatToolFailureMeta(details) {
  if (!details || typeof details !== "object") {
    return;
  }
  const record = details;
  const status = typeof record.status === "string" ? record.status : void 0;
  const exitCode =
    typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
      ? record.exitCode
      : void 0;
  const parts = [];
  if (status) {
    parts.push(`status=${status}`);
  }
  if (exitCode !== void 0) {
    parts.push(`exitCode=${exitCode}`);
  }
  return parts.length > 0 ? parts.join(" ") : void 0;
}
function extractToolResultText(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block;
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
    }
  }
  return parts.join("\n");
}
function collectToolFailures(messages) {
  const failures = [];
  const seen = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    if (message.role !== "toolResult") {
      continue;
    }
    const toolResult = message;
    if (toolResult.isError !== true) {
      continue;
    }
    const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
    if (!toolCallId || seen.has(toolCallId)) {
      continue;
    }
    seen.add(toolCallId);
    const toolName =
      typeof toolResult.toolName === "string" && toolResult.toolName.trim()
        ? toolResult.toolName
        : "tool";
    const rawText = extractToolResultText(toolResult.content);
    const meta = formatToolFailureMeta(toolResult.details);
    const summary = truncateFailureText(
      normalizeFailureText(rawText) || (meta ? "failed" : "failed (no output)"),
      MAX_TOOL_FAILURE_CHARS,
    );
    failures.push({
      toolCallId,
      toolName,
      summary,
      meta,
    });
  }
  return failures;
}
function formatToolFailuresSection(failures) {
  if (failures.length === 0) {
    return "";
  }
  const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
    const meta = failure.meta ? ` (${failure.meta})` : "";
    return `- ${failure.toolName}${meta}: ${failure.summary}`;
  });
  if (failures.length > MAX_TOOL_FAILURES) {
    lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
  }
  return `\n\n## Tool Failures\n${lines.join("\n")}`;
}
function computeFileLists(fileOps) {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((f) => !modified.has(f)).toSorted(),
    modifiedFiles: [...modified].toSorted(),
  };
}
function formatFileOperations(readFiles, modifiedFiles) {
  const sections = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}
/**
 * Extract the last conversation turn from messages.
 * A "turn" starts at the last user message and includes everything after it
 * (assistant responses, tool calls, tool results).
 * If no user message is found, returns the last assistant message (if any).
 */
function extractLastTurn(messages) {
  if (messages.length === 0) {
    return [];
  }
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && typeof msg === "object" && msg.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex >= 0) {
    return messages.slice(lastUserIndex);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && typeof msg === "object" && msg.role === "assistant") {
      return [msg];
    }
  }
  return [];
}
/**
 * Serialize a set of messages (typically the last turn) into human-readable text.
 * Truncates if the estimated token count exceeds maxTokens.
 *
 * Uses the same serialization format as the upstream compaction serializer:
 *   [User]: ..., [Assistant]: ..., [Tool result]: ...
 */
function serializeLastTurn(messages, maxTokens) {
  if (messages.length === 0) {
    return "";
  }
  const parts = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = msg.role;
    if (role === "user") {
      const content = msg.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("")
            : "";
      if (text) {
        parts.push(`[User]: ${text}`);
      }
    } else if (role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        const textParts = [];
        const toolCalls = [];
        for (const block of content) {
          if (block.type === "text" && block.text) textParts.push(block.text);
          else if (block.type === "toolCall" && block.name) {
            const args = block.arguments ?? {};
            const argsStr = Object.entries(args)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(", ");
            toolCalls.push(`${block.name}(${argsStr})`);
          }
        }
        if (textParts.length > 0) {
          parts.push(`[Assistant]: ${textParts.join("\n")}`);
        }
        if (toolCalls.length > 0) {
          parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
        }
      }
    } else if (role === "toolResult") {
      const content = msg.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
        if (text) {
          parts.push(`[Tool result]: ${text}`);
        }
      }
    }
  }
  if (parts.length === 0) {
    return "";
  }
  let serialized = parts.join("\n\n");
  const maxChars = maxTokens * 4;
  if (serialized.length > maxChars) {
    serialized = serialized.slice(0, Math.max(0, maxChars - 20)) + "\n\n[truncated]";
  }
  return serialized;
}
function compactionSafeguardExtension(api) {
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
    const toolFailureSection = formatToolFailuresSection(
      collectToolFailures([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
    );
    const fallbackSummary = `${FALLBACK_SUMMARY}${toolFailureSection}${fileOpsSummary}`;
    const model = ctx.model;
    if (!model) {
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            readFiles,
            modifiedFiles,
          },
        },
      };
    }
    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            readFiles,
            modifiedFiles,
          },
        },
      };
    }
    try {
      const runtime = getCompactionSafeguardRuntime(ctx.sessionManager);
      const modelContextWindow = resolveContextWindowTokens(model);
      const contextWindowTokens = runtime?.contextWindowTokens ?? modelContextWindow;
      const turnPrefixMessages = preparation.turnPrefixMessages ?? [];
      let messagesToSummarize = preparation.messagesToSummarize;
      const maxHistoryShare = runtime?.maxHistoryShare ?? 0.5;
      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : void 0;
      let droppedSummary;
      if (tokensBefore !== void 0) {
        const summarizableTokens =
          estimateMessagesTokens(messagesToSummarize) + estimateMessagesTokens(turnPrefixMessages);
        const newContentTokens = Math.max(0, Math.floor(tokensBefore - summarizableTokens));
        if (newContentTokens > Math.floor(contextWindowTokens * maxHistoryShare * SAFETY_MARGIN)) {
          const pruned = pruneHistoryForContextShare({
            messages: messagesToSummarize,
            maxContextTokens: contextWindowTokens,
            maxHistoryShare,
            parts: 2,
          });
          if (pruned.droppedChunks > 0) {
            const newContentRatio = (newContentTokens / contextWindowTokens) * 100;
            console.warn(
              `Compaction safeguard: new content uses ${newContentRatio.toFixed(1)}% of context; dropped ${pruned.droppedChunks} older chunk(s) (${pruned.droppedMessages} messages) to fit history budget.`,
            );
            messagesToSummarize = pruned.messages;
            if (pruned.droppedMessagesList.length > 0) {
              try {
                const droppedChunkRatio = computeAdaptiveChunkRatio(
                  pruned.droppedMessagesList,
                  contextWindowTokens,
                );
                const droppedMaxChunkTokens = Math.max(
                  1,
                  Math.floor(contextWindowTokens * droppedChunkRatio),
                );
                droppedSummary = await summarizeInStages({
                  messages: pruned.droppedMessagesList,
                  model,
                  apiKey,
                  signal,
                  reserveTokens: Math.max(1, Math.floor(preparation.settings.reserveTokens)),
                  maxChunkTokens: droppedMaxChunkTokens,
                  contextWindow: contextWindowTokens,
                  customInstructions,
                  previousSummary: preparation.previousSummary,
                });
              } catch (droppedError) {
                console.warn(
                  `Compaction safeguard: failed to summarize dropped messages, continuing without: ${droppedError instanceof Error ? droppedError.message : String(droppedError)}`,
                );
              }
            }
          }
        }
      }
      const adaptiveRatio = computeAdaptiveChunkRatio(
        [...messagesToSummarize, ...turnPrefixMessages],
        contextWindowTokens,
      );
      const maxChunkTokens = Math.max(1, Math.floor(contextWindowTokens * adaptiveRatio));
      const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));
      const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;
      const historySummary = await summarizeInStages({
        messages: messagesToSummarize,
        model,
        apiKey,
        signal,
        reserveTokens,
        maxChunkTokens,
        contextWindow: contextWindowTokens,
        customInstructions,
        previousSummary: effectivePreviousSummary,
      });
      let summary = historySummary;
      if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
        summary = `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${await summarizeInStages(
          {
            messages: turnPrefixMessages,
            model,
            apiKey,
            signal,
            reserveTokens,
            maxChunkTokens,
            contextWindow: contextWindowTokens,
            customInstructions: TURN_PREFIX_INSTRUCTIONS,
            previousSummary: void 0,
          },
        )}`;
      }
      const lastTurn = extractLastTurn([...messagesToSummarize, ...turnPrefixMessages]);
      if (lastTurn.length > 0) {
        const lastTurnText = serializeLastTurn(lastTurn, MAX_LAST_TURN_TOKENS);
        if (lastTurnText) {
          summary += `\n\n---\n\n<last-turn>\n${lastTurnText}\n</last-turn>`;
        }
      }
      summary += toolFailureSection;
      summary += fileOpsSummary;
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            readFiles,
            modifiedFiles,
          },
        },
      };
    } catch (error) {
      console.warn(
        `Compaction summarization failed; truncating history: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            readFiles,
            modifiedFiles,
          },
        },
      };
    }
  });
}
const __testing = {
  collectToolFailures,
  formatToolFailuresSection,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  extractLastTurn,
  serializeLastTurn,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  MAX_LAST_TURN_TOKENS,
};

//#endregion
export {
  MAX_LAST_TURN_TOKENS,
  __testing,
  compactionSafeguardExtension as default,
  extractLastTurn,
  serializeLastTurn,
};
