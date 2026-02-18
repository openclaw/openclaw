import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { generateSummary } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { resolveMemorySearchConfig } from "./memory-search.js";

const MEMORY_EXTRACT_INSTRUCTIONS =
  "Extract ONLY the most important facts, decisions, user preferences, and todos from this " +
  "conversation that are worth remembering across future sessions. " +
  "Format as a concise markdown bullet list (use - prefix). " +
  "Include: user preferences, key decisions made, important facts established, pending todos, user-provided context. " +
  "Exclude: transient details, step-by-step summaries, errors already resolved. " +
  "If nothing important was established, respond with exactly: NOTHING_TO_EXTRACT";

const MEMORY_FILE = "MEMORY.md";

function isMemoryExtractionEnabled(cfg: OpenClawConfig, agentId: string): boolean {
  const resolved = resolveMemorySearchConfig(cfg, agentId);
  return resolved !== null && resolved.enabled;
}

/**
 * Extracts important facts/decisions from compacted messages and appends them to MEMORY.md.
 * This is a best-effort operation: errors are silently swallowed.
 */
export async function extractAndSaveMemories(params: {
  messages: AgentMessage[];
  model: Model<Api>;
  apiKey: string;
  workspaceDir: string;
  signal?: AbortSignal;
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): Promise<void> {
  const { messages, model, apiKey, workspaceDir, signal, config, agentSessionKey } = params;

  if (messages.length === 0) {
    return;
  }

  // Check if memory extraction is enabled for this agent; skip when config is absent
  if (!config) {
    return;
  }
  const agentId = resolveSessionAgentId({ sessionKey: agentSessionKey, config });
  if (!isMemoryExtractionEnabled(config, agentId)) {
    return;
  }

  const memPath = path.join(workspaceDir, MEMORY_FILE);

  try {
    const effectiveSignal =
      signal ?? (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout?.(30_000);

    const extracted = await generateSummary(
      messages,
      model,
      2000,
      apiKey,
      effectiveSignal ?? new AbortController().signal,
      MEMORY_EXTRACT_INSTRUCTIONS,
      undefined,
    );

    if (!extracted || extracted.trim() === "NOTHING_TO_EXTRACT") {
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const entry = `\n\n## Compaction memories (${timestamp})\n\n${extracted.trim()}`;

    await fs.mkdir(path.dirname(memPath), { recursive: true });
    await fs.appendFile(memPath, entry, "utf-8");
  } catch {
    // Non-fatal: memory extraction should never break compaction
  }
}
