import fs from "node:fs/promises";
import path from "node:path";
import type { PluginRuntime, PluginLogger } from "../api.js";
import type { DownloadManager } from "./download-manager.js";
import type { HistoryManager } from "./history-manager.js";
import { MercurePusher, StreamingMercurePusher } from "./mercure-pusher.js";
import { detectReportRequest } from "./report-trigger.js";
import type { TopicResolver } from "./topic-resolver.js";
import type { ChatMessage, MercureConfig } from "./types.js";

/**
 * Automatically export session context to workspace after conversation completes.
 */
async function autoExportContext(
  chatMsg: ChatMessage,
  runtime: PluginRuntime,
  logger: PluginLogger,
): Promise<void> {
  try {
    const agentId = `rabbitmq-${chatMsg.userId}`;
    const sessionKey = `agent:${agentId}:rabbitmq:${chatMsg.userId}:${chatMsg.sessionId}`;

    // Use the main agent's workspace directory (where all configs live)
    const workspaceDir = runtime.agent.resolveAgentWorkspaceDir({}, "main");

    // Ensure workspace directory exists
    await fs.mkdir(workspaceDir, { recursive: true });

    // Get session messages
    const sessionMessages = await runtime.subagent.getSessionMessages({
      sessionKey,
      limit: 100,
    });

    // Load workspace bootstrap files
    const bootstrapFiles = await loadWorkspaceBootstrapFiles(workspaceDir);
    const systemPrompt = buildContextFromBootstrap(bootstrapFiles);

    // Format messages as markdown
    const sessionHistory = formatMessagesAsMarkdown(sessionMessages.messages || []);

    // Build export document
    const outputPath = path.join(workspaceDir, "exported-context.md");
    const markdown = buildMarkdownDocument({
      agentId,
      sessionKey,
      systemPrompt,
      sessionHistory,
    });

    await fs.writeFile(outputPath, markdown, "utf-8");
    logger.info(`[CHAT_PIPELINE] Context exported to: ${outputPath}`);
  } catch (err) {
    logger.warn(`[CHAT_PIPELINE] Auto-export failed: ${err}`);
  }
}

async function loadWorkspaceBootstrapFiles(
  workspaceDir: string,
): Promise<Array<{ path: string; content: string }>> {
  const fileNames = [
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "TOOLS.md",
    "BOOTSTRAP.md",
    "MEMORY.md",
  ];
  const files: Array<{ path: string; content: string }> = [];

  for (const name of fileNames) {
    const filePath = path.join(workspaceDir, name);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      files.push({ path: name, content });
    } catch {
      // File doesn't exist, skip
    }
  }

  return files;
}

function buildContextFromBootstrap(
  bootstrapFiles: Array<{ path: string; content: string }>,
): string {
  const sections: string[] = [];
  const order: Record<string, number> = {
    agents: 10,
    soul: 20,
    identity: 30,
    user: 40,
    tools: 50,
    bootstrap: 60,
    memory: 70,
  };

  const sorted = [...bootstrapFiles].sort((a, b) => {
    const getOrder = (name: string) => order[name.toLowerCase().replace(".md", "")] ?? 99;
    return getOrder(a.path) - getOrder(b.path);
  });

  for (const file of sorted) {
    sections.push(`## ${file.path}`, "", file.content, "");
  }

  return sections.join("\n");
}

function formatMessagesAsMarkdown(messages: unknown[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const entry = msg as Record<string, unknown>;
    const role = String(entry.role ?? "unknown").toLowerCase();
    const content = extractContentText(entry.content);
    if (!content) continue;

    const timestamp = entry.timestamp ? new Date(Number(entry.timestamp)).toISOString() : "";
    lines.push(
      `### ${role.charAt(0).toUpperCase() + role.slice(1)}${timestamp ? ` (${timestamp})` : ""}`,
      "",
      content,
      "",
    );
  }

  return lines.length > 0 ? lines.join("\n") : "(no messages)";
}

function extractContentText(content: unknown): string | null {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((b) => b && typeof b === "object" && "text" in b)
    .map((b) => (b as { text: unknown }).text)
    .filter((t) => typeof t === "string");
  return texts.length > 0 ? texts.join("\n").trim() : null;
}

function buildMarkdownDocument(params: {
  agentId: string;
  sessionKey: string;
  systemPrompt: string;
  sessionHistory: string;
}): string {
  const sections = [
    "# Exported Context",
    "",
    `> **Agent:** ${params.agentId}`,
    `> **Session:** ${params.sessionKey}`,
    `> **Exported:** ${new Date().toISOString()}`,
    "",
    "---",
    "",
    "# System Prompt",
    "",
    "```system",
    "",
    params.systemPrompt,
    "",
    "```",
    "",
    "---",
    "",
    "# Session History",
    "",
    params.sessionHistory,
    "",
  ];

  return sections.join("\n");
}

/**
 * Resolve the assistant text delta from an agent event payload.
 * The event carries `data.delta` (streaming) or `data.text` (final).
 */
function extractAssistantDelta(data: Record<string, unknown>): string {
  const delta = data.delta;
  const text = data.text;
  if (typeof delta === "string") return delta;
  if (typeof text === "string") return text;
  return "";
}

/**
 * Process a chat message from RabbitMQ with real-time streaming:
 *
 * 1. Fetch history record from MySQL
 * 2. Idempotency check (skip if already has response)
 * 3. Subscribe to agent events for streaming push
 * 4. Run OpenClaw subagent to generate response
 * 5. Wait for completion and extract response
 * 6. Update MySQL history record
 * 7. Push any remaining response via Mercure + done signal
 *
 * The streaming mirrors the Python `_stream_response_with_mercure` pattern:
 * each LLM text delta is forwarded to the frontend in near-real-time via
 * Mercure SSE, creating a typewriter effect.
 */
export async function processChatMessage(
  chatMsg: ChatMessage,
  historyManager: HistoryManager,
  mercureConfig: MercureConfig,
  runtime: PluginRuntime,
  logger: PluginLogger,
  downloadManager?: DownloadManager,
  topicResolver?: TopicResolver,
): Promise<string> {
  const mercure = new MercurePusher(mercureConfig);

  // Declare streamPusherCtx early so it's available in catch block
  const streamPusherCtx: { streamPusher: StreamingMercurePusher | null } = { streamPusher: null };

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

    // Step 2.5: Check if this is a report generation request
    const triggerResult = detectReportRequest(userMessage, logger);
    if (triggerResult.isReportRequest && downloadManager) {
      logger.info(`[CHAT_PIPELINE] Report request detected: ${triggerResult.period}`);

      // Resolve topicId from userId via user_topic_mapping
      let resolvedTopicId = 0;
      let useSlaveTopic = false;
      if (topicResolver) {
        const resolution = await topicResolver.getTopicIdsByUser(chatMsg.userId, chatMsg.message);
        resolvedTopicId = resolution.topicId ?? 0;
        useSlaveTopic = resolution.useSlaveTopic;
        logger.info(
          `[CHAT_PIPELINE] Resolved topicId=${resolvedTopicId}, useSlaveTopic=${useSlaveTopic} for userId=${chatMsg.userId}`,
        );
      }

      // Create report task in download table
      const uid = parseInt(chatMsg.userId, 10) || 0;
      const taskId = await downloadManager.createReportTask({
        uid,
        topicId: resolvedTopicId,
        requirement: triggerResult.requirement,
        period: triggerResult.period!,
        dateScope: triggerResult.dateScope!,
        title: `${triggerResult.period}舆情报告`,
        useSlaveTopic,
      });

      logger.info(`[CHAT_PIPELINE] Created report task #${taskId} for user ${uid}`);

      // For report requests, we still respond via Mercure but skip subagent processing
      // The report will be generated by the report-generator service
      const reportResponse = `${triggerResult.period}报告已创建，正在生成中...`;
      const mercureTopicForReport = chatMsg.topic || chatMsg.userId;
      await mercure.pushText(mercureTopicForReport, reportResponse);

      // Update history record with the report creation message
      await historyManager.updateResponse(chatMsg.historyId, reportResponse);

      return reportResponse;
    }

    // Step 3: Set up streaming pusher + subscribe to agent events
    streamPusherCtx.streamPusher = new StreamingMercurePusher(mercure, mercureTopic);

    const unsubscribe = runtime.events.onAgentEvent((evt) => {
      // Only handle "assistant" stream events (text deltas from the LLM)
      if (evt.stream !== "assistant") return;
      const delta = extractAssistantDelta(evt.data);
      if (delta) {
        streamPusherCtx.streamPusher!.appendDelta(delta);
      }
    });

    try {
      // Step 4: Run subagent with per-user agent isolation.
      const agentId = `rabbitmq-${userId}`;
      const sessionKey = `agent:${agentId}:rabbitmq:${userId}:${sessionId}`;
      logger.info(
        `[CHAT_PIPELINE] Running subagent for agentId=${agentId}, sessionKey=${sessionKey}`,
      );

      // Early ack: reassure the frontend we are processing so it does not time
      // out waiting for the first token (cold-start + model latency can be long).
      // Fire-and-forget: a `text` chunk, not a `done` signal, so it just prefixes
      // the streamed reply and never blocks the pipeline.
      void mercure.pushText(mercureTopic, "正在处理，请稍候…");

      const runResult = await runtime.subagent.run({
        sessionKey,
        message: `[userId:${userId}] ${userMessage}`,
        deliver: false,
      });

      // Step 5: Wait for completion (5 minute timeout)
      const waitResult = await runtime.subagent.waitForRun({
        runId: runResult.runId,
        timeoutMs: 300_000,
      });

      if (waitResult.status === "error") {
        logger.error(`[CHAT_PIPELINE] Subagent error: ${waitResult.error}`);
        await streamPusherCtx.streamPusher!.pushError(waitResult.error ?? "Unknown error");
        return `Error: ${waitResult.error}`;
      }

      if (waitResult.status === "timeout") {
        logger.warn(`[CHAT_PIPELINE] Subagent timed out for runId=${runResult.runId}`);
        await streamPusherCtx.streamPusher!.pushError("Processing timed out");
        return "Error: Processing timed out";
      }

      // Step 6: Extract response from session messages as the canonical source
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
        // Fall back to whatever the streaming pusher collected
        fullResponse = streamPusherCtx.streamPusher!.getFullText() || "(No response generated)";
      }

      // Step 7: Update history record
      await historyManager.updateResponse(chatMsg.historyId, fullResponse);

      // Step 8: Finish streaming — flush remaining buffer + push done signal
      await streamPusherCtx.streamPusher!.finish();

      // Step 9: Auto-export session context to workspace
      await autoExportContext(chatMsg, runtime, logger);

      logger.info(
        `[CHAT_PIPELINE] Completed: historyId=${chatMsg.historyId}, ` +
          `response length=${fullResponse.length}`,
      );

      return fullResponse;
    } finally {
      unsubscribe();
    }
  } catch (error) {
    const err = error as { code?: string; cause?: { code?: string } };
    const errCode = err?.code ?? err?.cause?.code ?? "unknown";

    // ECONNRESET means the frontend closed the connection while we were processing.
    // This typically happens when the frontend times out before we could respond.
    if (errCode === "ECONNRESET") {
      logger.warn(
        `[CHAT_PIPELINE] Connection reset by frontend (timeout?) for historyId=${chatMsg.historyId}. ` +
          `The response may not have reached the client.`,
      );
      // Try to persist what we have in the history record before failing
      try {
        const partialText = streamPusherCtx.streamPusher?.getFullText();
        if (partialText) {
          await historyManager.updateResponse(chatMsg.historyId, partialText);
          logger.info(
            `[CHAT_PIPELINE] Persisted partial response (${partialText.length} chars) before connection reset`,
          );
        }
      } catch {
        // best effort - don't fail the whole handler
      }
      return `Error: Connection reset by client (possible timeout). Response may be incomplete.`;
    }

    logger.error(`[CHAT_PIPELINE] Unhandled error: ${error}, code=${errCode}`);
    return `Error: ${String(error)}`;
  }
}
