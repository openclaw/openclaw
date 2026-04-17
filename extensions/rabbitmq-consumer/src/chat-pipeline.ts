import type { PluginRuntime, PluginLogger } from "../api.js";
import type { ChatMessage, MercureConfig } from "./types.js";
import type { HistoryManager } from "./history-manager.js";
import { MercurePusher } from "./mercure-pusher.js";

/**
 * Process a chat message from RabbitMQ:
 *
 * 1. Fetch history record from MySQL
 * 2. Idempotency check (skip if already has response)
 * 3. Run OpenClaw subagent to generate response
 * 4. Wait for completion and extract response
 * 5. Update MySQL history record
 * 6. Push response via Mercure
 */
export async function processChatMessage(
  chatMsg: ChatMessage,
  historyManager: HistoryManager,
  mercureConfig: MercureConfig,
  runtime: PluginRuntime,
  logger: PluginLogger,
): Promise<string> {
  const mercure = new MercurePusher(mercureConfig);

  try {
    // Step 1: Fetch history record
    logger.info(
      `[CHAT_PIPELINE] Processing message: historyId=${chatMsg.historyId}, ` +
        `userId=${chatMsg.userId}, sessionId=${chatMsg.sessionId}`,
    );

    const record = await historyManager.getRecord(chatMsg.historyId);
    if (!record) {
      logger.error(`[CHAT_PIPELINE] History record not found: ${chatMsg.historyId}`);
      return `Error: History record ${chatMsg.historyId} not found`;
    }

    // Step 2: Idempotency check
    if (record.response) {
      logger.info(`[CHAT_PIPELINE] Record ${chatMsg.historyId} already has response, skipping`);
      return record.response;
    }

    // Resolve the user message (prefer from chat body, fallback to record)
    const userMessage = chatMsg.message?.trim() || record.message;
    const sessionId = chatMsg.sessionId || record.sessionId;
    const userId = chatMsg.userId || record.userId;
    const mercureTopic = chatMsg.topic || userId;

    if (!userMessage) {
      logger.error(`[CHAT_PIPELINE] Empty message for historyId=${chatMsg.historyId}`);
      return "Error: Empty message";
    }

    // Step 3: Run subagent (session key includes userId for isolation)
    const sessionKey = `rabbitmq:${userId}:${sessionId}`;
    logger.info(`[CHAT_PIPELINE] Running subagent for sessionKey=${sessionKey}`);

    const runResult = await runtime.subagent.run({
      sessionKey,
      message: userMessage,
      deliver: false,
    });

    // Step 4: Wait for completion (5 minute timeout)
    const waitResult = await runtime.subagent.waitForRun({
      runId: runResult.runId,
      timeoutMs: 300_000,
    });

    if (waitResult.status === "error") {
      logger.error(`[CHAT_PIPELINE] Subagent error: ${waitResult.error}`);
      await mercure.pushError(mercureTopic, waitResult.error ?? "Unknown error");
      return `Error: ${waitResult.error}`;
    }

    if (waitResult.status === "timeout") {
      logger.warn(`[CHAT_PIPELINE] Subagent timed out for runId=${runResult.runId}`);
      await mercure.pushError(mercureTopic, "Processing timed out");
      return "Error: Processing timed out";
    }

    // Step 5: Extract response from session messages
    const sessionMessages = await runtime.subagent.getSessionMessages({
      sessionKey,
      limit: 5,
    });

    let fullResponse = "";
    if (sessionMessages.messages && Array.isArray(sessionMessages.messages)) {
      for (const msg of [...sessionMessages.messages].reverse()) {
        const m = msg as { role?: string; content?: string };
        if (m.role === "assistant" && m.content) {
          fullResponse = m.content;
          break;
        }
      }
    }

    if (!fullResponse) {
      fullResponse = "(No response generated)";
    }

    // Step 6: Update history record
    await historyManager.updateResponse(chatMsg.historyId, fullResponse);

    // Step 7: Push response via Mercure
    await mercure.pushText(mercureTopic, fullResponse);
    await mercure.pushDone(mercureTopic);

    logger.info(
      `[CHAT_PIPELINE] Completed: historyId=${chatMsg.historyId}, ` +
        `response length=${fullResponse.length}`,
    );

    return fullResponse;
  } catch (error) {
    logger.error(`[CHAT_PIPELINE] Unhandled error: ${error}`);
    return `Error: ${String(error)}`;
  }
}
