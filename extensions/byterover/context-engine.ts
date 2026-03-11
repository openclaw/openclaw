import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
  PluginLogger,
} from "openclaw/plugin-sdk/byterover";
import { brvCurate, brvQuery, type BrvProcessConfig } from "./brv-process.js";
import { stripUserMetadata, extractSenderInfo, stripAssistantTags } from "./message-utils.js";

/**
 * ByteRoverContextEngine integrates the brv CLI as an OpenClaw context engine.
 *
 * Lifecycle mapping:
 *   - afterTurn  → `brv curate` (feed conversation turns for curation)
 *   - assemble   → `brv query`  (retrieve curated knowledge as system prompt addition)
 *   - ingest     → no-op (afterTurn handles batch ingestion)
 *   - compact    → not owned (runtime handles compaction via legacy path)
 */
export class ByteRoverContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "byterover",
    name: "ByteRover",
    version: "2026.3.8",
    // We don't own compaction — let the runtime's built-in auto-compaction handle it.
    ownsCompaction: false,
  };

  private readonly config: BrvProcessConfig;
  private readonly logger: PluginLogger;

  constructor(config: BrvProcessConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // ingest — no-op (afterTurn handles it)
  // ---------------------------------------------------------------------------

  async ingest(_params: {
    sessionId: string;
    message: unknown;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: false };
  }

  // ---------------------------------------------------------------------------
  // afterTurn — feed the completed turn to brv curate
  // ---------------------------------------------------------------------------

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: unknown[];
    prePromptMessageCount: number;
    isHeartbeat?: boolean;
  }): Promise<void> {
    if (params.isHeartbeat) {
      this.logger.debug?.("afterTurn skipped (heartbeat)");
      return;
    }

    // Extract only the new messages from this turn
    const newMessages = params.messages.slice(params.prePromptMessageCount);
    if (newMessages.length === 0) {
      this.logger.debug?.("afterTurn skipped (no new messages)");
      return;
    }

    // Serialize messages into a text block for brv curate
    const serialized = serializeMessagesForCurate(newMessages);
    if (!serialized.trim()) {
      this.logger.debug?.("afterTurn skipped (empty serialized context)");
      return;
    }

    const context =
      `The following is a conversation between a user and an AI assistant (OpenClaw).\n` +
      `Curate only information with lasting value: facts, decisions, technical details, preferences, or notable outcomes.\n` +
      `Skip trivial messages such as greetings, acknowledgments ("ok", "thanks", "sure", "got it"), one-word replies, anything with no substantive content, or automated session-start messages (e.g. "/new", "/reset" and their system-generated continuations).\n\n` +
      `Conversation:\n${serialized}`;

    this.logger.info(
      `afterTurn curating ${newMessages.length} new messages (${context.length} chars)`,
    );
    try {
      const result = await brvCurate({
        config: this.config,
        logger: this.logger,
        context,
        detach: true, // Fire-and-forget so we don't block the turn
      });
      this.logger.debug?.(`afterTurn curate result: ${JSON.stringify(result.data?.status)}`);
    } catch (err) {
      // Best-effort: don't fail the turn if curation fails
      this.logger.warn(`curate failed (best-effort): ${String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // assemble — query brv for curated knowledge and inject as system prompt
  // ---------------------------------------------------------------------------

  async assemble(params: {
    sessionId: string;
    messages: unknown[];
    tokenBudget?: number;
    prompt?: string;
  }): Promise<AssembleResult> {
    // Use the incoming prompt (new upstream field) — this is the actual user
    // message for this turn. Fall back to history scan for older runtimes.
    const rawPrompt = params.prompt ?? null;
    const query = rawPrompt
      ? stripUserMetadata(rawPrompt).trim() || null
      : extractLatestUserQuery(params.messages);
    if (!query) {
      this.logger.debug?.("assemble skipped brv query (no user message found)");
      return {
        messages: params.messages as AssembleResult["messages"],
        estimatedTokens: 0,
      };
    }

    // Skip trivially short queries (e.g. "ok", "hi", "yes") — not worth a brv spawn.
    // Applied after metadata stripping so inflated raw prompts don't bypass this.
    if (query.length < 5) {
      this.logger.debug?.(`assemble skipped brv query (query too short: "${query}")`);
      return {
        messages: params.messages as AssembleResult["messages"],
        estimatedTokens: 0,
      };
    }

    // Race brv query against a deadline so we never exceed the agent ready timeout (15s).
    // Default assembleTimeoutMs is 10s — leaves headroom for the runtime's own overhead.
    const assembleTimeout = this.config.queryTimeoutMs
      ? Math.min(this.config.queryTimeoutMs, 10_000)
      : 10_000;

    this.logger.debug?.(
      `assemble querying brv: "${query.slice(0, 100)}${query.length > 100 ? "..." : ""}" (timeout=${assembleTimeout}ms)`,
    );
    let systemPromptAddition: string | undefined;
    try {
      const result = await Promise.race([
        brvQuery({ config: this.config, logger: this.logger, query }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), assembleTimeout)),
      ]);

      if (result === null) {
        this.logger.warn(
          `assemble brv query timed out after ${assembleTimeout}ms — proceeding without context`,
        );
      } else {
        const answer = result.data?.result ?? result.data?.content;
        if (answer && answer.trim()) {
          systemPromptAddition =
            `<byterover-context>\n` +
            `The following curated knowledge is from ByteRover context engine:\n\n` +
            `${answer.trim()}\n` +
            `</byterover-context>`;
          this.logger.info(
            `assemble injecting systemPromptAddition (${systemPromptAddition.length} chars)`,
          );
        } else {
          this.logger.debug?.("assemble brv query returned empty result");
        }
      }
    } catch (err) {
      // Don't fail the prompt if brv query fails
      this.logger.warn(`query failed (best-effort): ${String(err)}`);
    }

    return {
      messages: params.messages as AssembleResult["messages"],
      estimatedTokens: 0, // Caller handles estimation
      systemPromptAddition,
    };
  }

  // ---------------------------------------------------------------------------
  // compact — we don't own compaction; return not-compacted
  // ---------------------------------------------------------------------------

  async compact(_params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: false,
      reason: "ByteRover does not own compaction; delegating to runtime.",
    };
  }

  // ---------------------------------------------------------------------------
  // dispose — no persistent resources to clean up
  // ---------------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.logger.debug?.("dispose called");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize agent messages into a human-readable text block for brv curate.
 *
 * - User messages: strip metadata noise, attribute with sender name + timestamp
 * - Assistant messages: strip <final>/<think> tags
 * - toolResult messages: skipped (internal implementation details)
 */
export function serializeMessagesForCurate(messages: unknown[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const m = msg as { role?: string; content?: unknown };
    if (!m.role) continue;

    // Skip tool results — internal details, not useful for curation
    if (m.role === "toolResult") continue;

    let text = extractTextContent(m.content);
    if (!text.trim()) continue;

    if (m.role === "user") {
      // Extract sender info before stripping metadata
      const sender = extractSenderInfo(text);
      text = stripUserMetadata(text);
      if (!text.trim()) continue;

      // Build clean attribution header
      const parts = [sender?.name, sender?.timestamp].filter(Boolean);
      const label = parts.length > 0 ? parts.join(" @ ") : "user";
      lines.push(`[${label}]: ${text.trim()}`);
    } else if (m.role === "assistant") {
      text = stripAssistantTags(text);
      if (!text.trim()) continue;
      lines.push(`[assistant]: ${text.trim()}`);
    } else {
      lines.push(`[${m.role}]: ${text.trim()}`);
    }
  }
  return lines.join("\n\n");
}

/** Extract text from string content or ContentBlock[] arrays. */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown) => (b as { type?: string }).type === "text")
      .map((b: unknown) => (b as { text: string }).text)
      .join("\n");
  }
  return "";
}

/**
 * Extract the latest user message text to use as the brv query.
 * Strips OpenClaw metadata so brv receives only the actual question.
 */
export function extractLatestUserQuery(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "user") continue;

    const raw = extractTextContent(m.content);
    const clean = stripUserMetadata(raw).trim();
    return clean || null;
  }
  return null;
}
