import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type AuthStorage, estimateTokens, generateSummary } from "@mariozechner/pi-coding-agent";
import type { ContextDecayConfig } from "../../config/types.agent-defaults.js";
import type { GroupSummaryEntry, GroupSummaryStore, SummaryStore } from "./summary-store.js";
import { log } from "../pi-embedded-runner/logger.js";
import { loadGroupSummaryStore, loadSummaryStore, saveGroupSummaryStore } from "./summary-store.js";
import { computeTurnAges, groupIndicesByTurn } from "./turn-ages.js";

/** Reserve tokens for the group summarization model response. */
const GROUP_SUMMARY_RESERVE_TOKENS = 1000;

/** Minimum estimated tokens in a window to warrant summarization. */
const MIN_WINDOW_TOKENS = 500;

/** Maximum chars for the summarization prompt payload. */
const MAX_PROMPT_CHARS = 100_000;

/** Estimate total tokens for a set of message indices. */
function estimateWindowTokens(messages: AgentMessage[], indices: number[]): number {
  let total = 0;
  for (const idx of indices) {
    const tokenMsg = {
      role: "user",
      content: extractContentText(messages[idx]),
      timestamp: Date.now(),
    } as AgentMessage;
    total += estimateTokens(tokenMsg);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnWindow {
  turnRange: [number, number]; // [oldest age, newest age]
  indices: number[];
  anchorIndex: number;
}

// ---------------------------------------------------------------------------
// Window identification
// ---------------------------------------------------------------------------

function extractContentText(msg: AgentMessage): string {
  const msgUnk = msg as unknown as { content: unknown };
  if (typeof msgUnk.content === "string") {
    return msgUnk.content;
  }
  if (!Array.isArray(msgUnk.content)) {
    return JSON.stringify(msgUnk.content);
  }
  return (msgUnk.content as Array<Record<string, unknown>>)
    .filter((b) => b.type === "text")
    .map((b) => b.text as string)
    .join("\n");
}

function extractToolInfo(
  messages: AgentMessage[],
  toolResultIndex: number,
): { toolName: string; args: string } {
  const toolResultMsg = messages[toolResultIndex] as unknown as Record<string, unknown>;
  const toolUseId = toolResultMsg.toolUseId as string | undefined;
  if (!toolUseId) {
    return { toolName: "unknown", args: "{}" };
  }
  for (let i = toolResultIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") {
      continue;
    }
    const msgContent = (msg as unknown as { content: unknown }).content;
    if (!Array.isArray(msgContent)) {
      continue;
    }
    for (const block of msgContent) {
      if (block.type === "tool_use" && block.id === toolUseId) {
        return {
          toolName: (block.name as string) ?? "unknown",
          args: JSON.stringify(block.input ?? {}),
        };
      }
    }
  }
  return { toolName: "unknown", args: "{}" };
}

/**
 * Find eligible windows of turns ready for group summarization.
 */
export function findEligibleWindows(params: {
  messages: AgentMessage[];
  config: ContextDecayConfig;
  existingGroupSummaries: GroupSummaryStore;
}): TurnWindow[] {
  const { messages, config, existingGroupSummaries } = params;
  const windowAfter = config.summarizeWindowAfterTurns;
  if (!windowAfter || windowAfter < 1) {
    return [];
  }

  const windowSize = config.summarizeWindowSize ?? 4;
  const turnAges = computeTurnAges(messages);
  const turnGroups = groupIndicesByTurn(turnAges);

  // Build set of indices already covered by existing group summaries
  const coveredIndices = new Set<number>();
  for (const entry of existingGroupSummaries) {
    for (const idx of entry.indices) {
      coveredIndices.add(idx);
    }
  }

  // Collect eligible turn ages (sorted descending = oldest first by age number)
  const eligibleTurnAges: number[] = [];
  for (const [age] of turnGroups) {
    if (age < windowAfter) {
      continue;
    }
    // Skip turns past strip threshold (they'll be stripped anyway)
    if (config.stripToolResultsAfterTurns && age >= config.stripToolResultsAfterTurns) {
      continue;
    }
    // Check if any index in this turn is NOT already covered
    const indices = turnGroups.get(age) ?? [];
    const hasUncovered = indices.some((idx) => !coveredIndices.has(idx));
    if (hasUncovered) {
      eligibleTurnAges.push(age);
    }
  }

  if (eligibleTurnAges.length < 2) {
    return [];
  }

  // Sort by age descending (oldest first = highest age number)
  eligibleTurnAges.sort((a, b) => b - a);

  // Group consecutive eligible turns into windows
  const windows: TurnWindow[] = [];
  for (let i = 0; i < eligibleTurnAges.length; i += windowSize) {
    const chunk = eligibleTurnAges.slice(i, i + windowSize);
    if (chunk.length < 2) {
      continue; // Skip windows with < 2 turns
    }

    // Collect all indices for this window
    const windowIndices: number[] = [];
    for (const age of chunk) {
      const indices = turnGroups.get(age) ?? [];
      windowIndices.push(...indices);
    }
    windowIndices.sort((a, b) => a - b);

    // Estimate tokens — skip if too small
    const estimatedTokens = estimateWindowTokens(messages, windowIndices);
    if (estimatedTokens < MIN_WINDOW_TOKENS) {
      continue;
    }

    // Find anchor: first user message index in this window
    let anchorIndex = windowIndices[0];
    for (const idx of windowIndices) {
      if (messages[idx].role === "user") {
        anchorIndex = idx;
        break;
      }
    }

    const oldestAge = Math.max(...chunk);
    const newestAge = Math.min(...chunk);

    windows.push({
      turnRange: [oldestAge, newestAge],
      indices: windowIndices,
      anchorIndex,
    });
  }

  return windows;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/**
 * Build a multi-turn summarization prompt for a window of messages.
 * Uses existing individual summaries where available for more concise input.
 */
export function buildGroupSummarizationPrompt(params: {
  messages: AgentMessage[];
  window: TurnWindow;
  turnAges: Map<number, number>;
  individualSummaries: SummaryStore;
}): string {
  const { messages, window: win, turnAges, individualSummaries } = params;

  const lines: string[] = [
    "Summarize this conversation window concisely. Preserve: user intent, decisions made, tool call outcomes, file paths, function names, error messages, key values. Maintain causal chains (what was requested → what was done → what resulted).",
    "",
  ];

  let currentTurnAge: number | undefined;

  for (const idx of win.indices) {
    const msg = messages[idx];
    const age = turnAges.get(idx) ?? 0;

    if (age !== currentTurnAge) {
      lines.push(`--- Turn [age ${age}] ---`);
      currentTurnAge = age;
    }

    if (msg.role === "user") {
      lines.push(`[User]: ${extractContentText(msg)}`);
    } else if (msg.role === "assistant") {
      const content = (msg as unknown as { content: unknown }).content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === "text") {
            textParts.push(block.text as string);
          } else if (block.type === "tool_use") {
            textParts.push(`[Called tool: ${block.name}(${JSON.stringify(block.input ?? {})})]`);
          }
          // Skip thinking blocks
        }
        if (textParts.length > 0) {
          lines.push(`[Assistant]: ${textParts.join("\n")}`);
        }
      } else {
        lines.push(`[Assistant]: ${extractContentText(msg)}`);
      }
    } else if (msg.role === "toolResult") {
      // Use existing individual summary if available
      const individualSummary = individualSummaries[idx];
      if (individualSummary) {
        const { toolName } = extractToolInfo(messages, idx);
        lines.push(`[Tool: ${toolName}]: [Previously summarized] ${individualSummary.summary}`);
      } else {
        const { toolName } = extractToolInfo(messages, idx);
        const content = extractContentText(msg);
        lines.push(`[Tool: ${toolName}]: ${content}`);
      }
    }
  }

  let prompt = lines.join("\n");
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + "\n[truncated]";
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Fire-and-forget entry point
// ---------------------------------------------------------------------------

/**
 * Summarize aged turn windows. Fire-and-forget — failures are logged but don't affect the agent run.
 */
export async function summarizeAgedTurnWindows(params: {
  sessionFilePath: string;
  messages: AgentMessage[];
  config: ContextDecayConfig;
  model: NonNullable<ExtensionContext["model"]>;
  authStorage: AuthStorage;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { sessionFilePath, messages, config, model, authStorage, abortSignal } = params;

  const windowAfter = config.summarizeWindowAfterTurns;
  if (!windowAfter || windowAfter < 1) {
    return;
  }

  const existingGroupSummaries = await loadGroupSummaryStore(sessionFilePath);
  const individualSummaries = await loadSummaryStore(sessionFilePath);

  const windows = findEligibleWindows({
    messages,
    config,
    existingGroupSummaries,
  });

  if (windows.length === 0) {
    return;
  }

  // Resolve API key for the model's provider
  const apiKey = await authStorage.getApiKey(model.provider);
  if (!apiKey) {
    log.warn(
      `context-decay: no API key found for provider "${model.provider}"; skipping group summarization`,
    );
    return;
  }

  log.info(
    `context-decay: group-summarizing ${windows.length} window(s) with ${model.provider}/${model.id}`,
  );

  const turnAges = computeTurnAges(messages);
  const updatedStore = [...existingGroupSummaries];
  let didUpdate = false;

  for (const win of windows) {
    if (abortSignal?.aborted) {
      break;
    }

    try {
      const prompt = buildGroupSummarizationPrompt({
        messages,
        window: win,
        turnAges,
        individualSummaries,
      });

      const summaryMessages: AgentMessage[] = [
        {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        } as AgentMessage,
      ];

      const summaryText = await generateSummary(
        summaryMessages,
        model,
        GROUP_SUMMARY_RESERVE_TOKENS,
        apiKey,
        abortSignal ?? new AbortController().signal,
      );

      if (summaryText && summaryText.length > 0) {
        const originalTokenEstimate = estimateWindowTokens(messages, win.indices);
        const summaryMsg = {
          role: "user",
          content: summaryText,
          timestamp: Date.now(),
        } as AgentMessage;

        const entry: GroupSummaryEntry = {
          summary: summaryText,
          anchorIndex: win.anchorIndex,
          indices: win.indices,
          turnRange: win.turnRange,
          originalTokenEstimate,
          summaryTokenEstimate: estimateTokens(summaryMsg),
          summarizedAt: new Date().toISOString(),
          model: `${model.provider}/${model.id}`,
        };
        updatedStore.push(entry);
        didUpdate = true;
      }
    } catch (err) {
      log.warn(
        `context-decay: failed to group-summarize window [turns ${win.turnRange[0]}-${win.turnRange[1]}]: ${err}`,
      );
    }
  }

  if (didUpdate) {
    try {
      await saveGroupSummaryStore(sessionFilePath, updatedStore);
      log.info(`context-decay: saved ${updatedStore.length} group summaries`);
    } catch (err) {
      log.warn(`context-decay: failed to save group summary store: ${err}`);
    }
  }
}
