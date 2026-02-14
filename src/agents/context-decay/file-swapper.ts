import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContextDecayConfig } from "../../config/types.agent-defaults.js";
import { log } from "../pi-embedded-runner/logger.js";
import { loadSwappedFileStore, resultsDir, saveSwappedFileStore } from "./file-store.js";
import { generateHeuristicHint } from "./hint-generator.js";
import { extractContentText, extractToolInfo } from "./message-utils.js";
import { computeTurnAges } from "./turn-ages.js";

const DEFAULT_SWAP_MIN_CHARS = 256;

/**
 * Swap aged tool results to files on disk.
 * This is fire-and-forget — failures are logged but don't affect the agent run.
 * No LLM calls. No API key needed. Pure I/O.
 */
export async function swapAgedToolResults(params: {
  sessionFilePath: string;
  messages: AgentMessage[];
  config: ContextDecayConfig;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { sessionFilePath, messages, config, abortSignal } = params;

  const swapAfter = config.swapToolResultsAfterTurns;
  if (!swapAfter || swapAfter < 1) {
    return;
  }

  const minChars = config.swapMinChars ?? DEFAULT_SWAP_MIN_CHARS;
  const existingStore = await loadSwappedFileStore(sessionFilePath);
  const turnAges = computeTurnAges(messages);
  const toSwap: Array<{ index: number; toolName: string; args: string; content: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    if (abortSignal?.aborted) {
      return;
    }

    const msg = messages[i];
    if (msg.role !== "toolResult") {
      continue;
    }

    const age = turnAges.get(i) ?? 0;
    if (age < swapAfter) {
      continue;
    }
    // Skip if already swapped
    if (existingStore[i]) {
      continue;
    }
    // Skip if past summarize threshold — let the summarizer handle it
    if (config.summarizeToolResultsAfterTurns && age >= config.summarizeToolResultsAfterTurns) {
      continue;
    }
    // Skip if past strip threshold — will be stripped anyway
    if (config.stripToolResultsAfterTurns && age >= config.stripToolResultsAfterTurns) {
      continue;
    }

    const content = extractContentText(msg);
    if (content.length < minChars) {
      continue;
    }

    const { toolName, args } = extractToolInfo(messages, i);
    toSwap.push({ index: i, toolName, args, content });
  }

  if (toSwap.length === 0) {
    return;
  }

  // Ensure results directory exists
  const resDir = resultsDir(sessionFilePath);
  await fs.mkdir(resDir, { recursive: true });

  const updatedStore = { ...existingStore };
  let didUpdate = false;

  for (const item of toSwap) {
    if (abortSignal?.aborted) {
      break;
    }

    try {
      // Sanitize tool name for filename
      const safeName = item.toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
      const fileName = `${Date.now()}-${safeName}.txt`;
      const filePath = path.join(resDir, fileName);

      await fs.writeFile(filePath, item.content, "utf-8");

      const hint = generateHeuristicHint({
        toolName: item.toolName,
        args: item.args,
        content: item.content,
      });

      updatedStore[item.index] = {
        filePath,
        toolName: item.toolName,
        hint,
        originalChars: item.content.length,
        swappedAt: new Date().toISOString(),
      };
      didUpdate = true;
    } catch (err) {
      log.warn(`context-decay: failed to swap tool result at index ${item.index}: ${String(err)}`);
    }
  }

  if (didUpdate) {
    try {
      await saveSwappedFileStore(sessionFilePath, updatedStore);
      log.info(
        `context-decay: swapped ${toSwap.length} tool result(s) to files in ${resDir}`,
      );
    } catch (err) {
      log.warn(`context-decay: failed to save swapped file store: ${String(err)}`);
    }
  }
}
