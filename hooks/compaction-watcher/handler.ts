import { mkdir, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Log session compaction events and provide lightweight token-loss diagnostics.
 */
const logCompactionEvent = async (event) => {
  if (event.type !== "session:compact:before" && event.type !== "session:compact:after") {
    return;
  }

  try {
    const now = new Date();
    const timestamp =
      typeof event.timestamp === "string"
        ? event.timestamp
        : event.timestamp instanceof Date
          ? event.timestamp.toISOString()
          : now.toISOString();

    const ctx = event.context || {};
    const logDir = path.join(os.homedir(), ".openclaw", "logs");
    await mkdir(logDir, { recursive: true });

    const logPath = path.join(logDir, "compaction-events.log");
    const line =
      JSON.stringify({
        timestamp,
        type: event.type,
        sessionKey: event.sessionKey,
        messageCount: ctx.messageCount,
        tokenCount: ctx.tokenCount,
        compactedCount: ctx.compactedCount,
        summaryLength: ctx.summaryLength,
        tokensBefore: ctx.tokensBefore,
        tokensAfter: ctx.tokensAfter,
        action: event.action,
        compactRatio:
          typeof ctx.tokensBefore === "number" &&
          typeof ctx.tokensAfter === "number" &&
          ctx.tokensBefore > 0
            ? ctx.tokensAfter / ctx.tokensBefore
            : undefined,
      }) + "\n";

    await appendFile(logPath, line, "utf-8");

    if (
      event.type === "session:compact:after" &&
      typeof ctx.tokensBefore === "number" &&
      typeof ctx.tokensAfter === "number"
    ) {
      const dropped = ctx.tokensBefore - ctx.tokensAfter;
      if (ctx.tokensBefore >= 40000 && dropped > 40000 && Array.isArray(event.messages)) {
        event.messages.push(
          `Compaction dropped ~${dropped.toLocaleString()} tokens (${ctx.tokensBefore.toLocaleString()} -> ${ctx.tokensAfter.toLocaleString()}) for session ${event.sessionKey}`,
        );
      }
    }
  } catch (error) {
    // Intentionally non-blocking: hooks should never fail open-claw execution flow.
    try {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[compaction-watcher] diagnostics write skipped: ${message}`);
    } catch {
      // Never let observability fallback interfere with session flow.
    }
  }
};

export default logCompactionEvent;
