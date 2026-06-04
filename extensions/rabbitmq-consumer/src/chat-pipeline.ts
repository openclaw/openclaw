import fs from "node:fs/promises";
import path from "node:path";
import type { PluginRuntime, PluginLogger } from "../api.js";
import type { DownloadManager } from "./download-manager.js";
import type { FeedCounter } from "./feed-counter.js";
import type { HistoryManager } from "./history-manager.js";
import { MercurePusher, StreamingMercurePusher } from "./mercure-pusher.js";
import type { ReportTaskPublisher } from "./report-task-publisher.js";
import { detectReportRequest, type ReportPeriod } from "./report-trigger.js";
import type { ProjectCandidate, TopicResolver } from "./topic-resolver.js";
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
    logger.warn(`[CHAT_PIPELINE] Auto-export failed: ${String(err)}`);
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

  const sorted = [...bootstrapFiles].toSorted((a, b) => {
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
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const entry = msg as Record<string, unknown>;
    const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "unknown";
    const content = extractContentText(entry.content);
    if (!content) {
      continue;
    }

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
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return null;
  }
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
  if (typeof delta === "string") {
    return delta;
  }
  if (typeof text === "string") {
    return text;
  }
  return "";
}

/**
 * Pending report disambiguation state, keyed by userId. When a user asks for a
 * report but has multiple project mappings, we store the resolved request here
 * and ask which project; their next message (an option number or a project name)
 * is matched against `candidates` to continue without re-stating intent.
 * In-memory + per-process: entries are short-lived, cleared on use or expiry.
 */
interface PendingReport {
  period: ReportPeriod;
  requirement: string;
  dateScope: { start: string; end: string };
  candidates: ProjectCandidate[];
  createdAt: number;
}

const pendingDisambiguation = new Map<string, PendingReport>();
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Match a user's disambiguation reply to one of the pending candidates.
 * Accepts a project name (unique substring) or a 1-based option number such as
 * "2" / "选 2". Name matching is tried first so project names containing digits
 * are not misread as an option index. Returns null if nothing matches.
 */
function matchPendingChoice(
  message: string,
  candidates: ProjectCandidate[],
): ProjectCandidate | null {
  const text = message.trim();
  if (!text || candidates.length === 0) {
    return null;
  }

  // 1. Unique project-name substring match.
  const nameMatches = candidates.filter(
    (c) => c.projectName.length > 0 && text.includes(c.projectName),
  );
  if (nameMatches.length === 1) {
    return nameMatches[0];
  }

  // 2. Bare option number (e.g. "2", "选 2", "第2个").
  const digits = text.match(/\d+/);
  if (digits) {
    const idx = parseInt(digits[0], 10) - 1;
    if (idx >= 0 && idx < candidates.length) {
      return candidates[idx];
    }
  }

  return null;
}

/**
 * Pre-count feed data, then queue a report task and reply (or report "no data").
 * Always emits a Mercure `done` so the frontend unlocks. Shared by the direct
 * report path and the disambiguation-reply path.
 */
async function createReportTaskAndRespond(args: {
  period: ReportPeriod;
  requirement: string;
  dateScope: { start: string; end: string };
  topicId: number;
  useSlaveTopic: boolean;
  chatMsg: ChatMessage;
  mercure: MercurePusher;
  mercureTopic: string;
  historyManager: HistoryManager;
  downloadManager: DownloadManager;
  feedCounter: FeedCounter | undefined;
  reportTaskPublisher: ReportTaskPublisher | undefined;
  logger: PluginLogger;
}): Promise<string> {
  const {
    period,
    requirement,
    dateScope,
    topicId,
    useSlaveTopic,
    chatMsg,
    mercure,
    mercureTopic,
    historyManager,
    downloadManager,
    feedCounter,
    reportTaskPublisher,
    logger,
  } = args;

  // Pre-check feed data volume. A failed/skipped count leaves feedCount at -1,
  // preserving the plain "generating..." response.
  let feedCount = -1;
  if (feedCounter && topicId > 0) {
    try {
      feedCount = await feedCounter.countFeedData(topicId, dateScope.start, dateScope.end);
      logger.info(
        `[CHAT_PIPELINE] Feed pre-count=${feedCount} for topicId=${topicId} ` +
          `(${dateScope.start} ~ ${dateScope.end})`,
      );
    } catch (err) {
      logger.warn(`[CHAT_PIPELINE] Feed pre-count failed, continuing without hint: ${String(err)}`);
    }
  }

  if (feedCount === 0) {
    const emptyResponse = `该时段（${dateScope.start} ~ ${dateScope.end}）暂无舆情数据，无法生成${period}。`;
    await mercure.pushText(mercureTopic, emptyResponse);
    await mercure.pushDone(mercureTopic);
    await historyManager.updateResponse(chatMsg.historyId, emptyResponse);
    logger.info(`[CHAT_PIPELINE] No feed data for user ${chatMsg.userId}, skipping report task`);
    return emptyResponse;
  }

  const uid = parseInt(chatMsg.userId, 10) || 0;
  const taskId = await downloadManager.createReportTask({
    uid,
    topicId,
    requirement,
    period,
    dateScope,
    title: `${period}舆情报告`,
    useSlaveTopic,
    mercureTopic,
    // Same per-user agent the chat runs under, so the report subagent
    // inherits its workspace, DB skills, and schema knowledge.
    agentId: `rabbitmq-${chatMsg.userId}`,
  });
  logger.info(`[CHAT_PIPELINE] Created report task #${taskId} for user ${uid}`);

  // The report itself is generated asynchronously by the report-generator service.
  const countHint = feedCount > 0 ? `已检索到 ${feedCount} 条数据，` : "";
  const reportResponse = `${countHint}${period}报告已创建，正在生成中...`;
  await mercure.pushText(mercureTopic, reportResponse);
  // Let the frontend open a report card for this taskId right away; progress
  // (`report_text`) and the final `report` event will target the same card.
  await mercure.pushReportCreated(mercureTopic, taskId);
  // Unlock the frontend; the report arrives later as a separate "report" event.
  await mercure.pushDone(mercureTopic);
  await historyManager.updateResponse(chatMsg.historyId, reportResponse);

  // Notify the report-generator so it starts immediately instead of waiting
  // for its fallback poll cycle. Done after the ack pushes so the frontend
  // sees "正在生成中" before the first streamed report chunk. Publish failure
  // is tolerated: the poller picks up the Pending task.
  if (reportTaskPublisher) {
    const published = await reportTaskPublisher.publishTaskCreated(taskId);
    if (published) {
      logger.info(`[CHAT_PIPELINE] Notified report-generator for task #${taskId}`);
    }
  }

  return reportResponse;
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
  feedCounter?: FeedCounter,
  reportTaskPublisher?: ReportTaskPublisher,
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

    // Step 2.4: If we previously asked this user which project, interpret their
    // reply (an option number or a project name) and continue the report flow.
    if (downloadManager) {
      const pending = pendingDisambiguation.get(userId);
      if (pending && Date.now() - pending.createdAt > PENDING_TTL_MS) {
        pendingDisambiguation.delete(userId);
      } else if (pending) {
        const choice = matchPendingChoice(userMessage, pending.candidates);
        if (choice) {
          pendingDisambiguation.delete(userId);
          logger.info(
            `[CHAT_PIPELINE] User ${userId} picked project "${choice.projectName}" ` +
              `for pending ${pending.period}`,
          );
          return await createReportTaskAndRespond({
            period: pending.period,
            requirement: pending.requirement,
            dateScope: pending.dateScope,
            topicId: choice.topicId,
            useSlaveTopic: choice.useSlaveTopic,
            chatMsg,
            mercure,
            mercureTopic,
            historyManager,
            downloadManager,
            feedCounter,
            reportTaskPublisher,
            logger,
          });
        }
        // Unrecognized reply: drop stale state and fall through to normal handling.
        pendingDisambiguation.delete(userId);
        logger.info(
          `[CHAT_PIPELINE] User ${userId} reply did not match pending candidates, clearing`,
        );
      }
    }

    // Step 2.5: Check if this is a report generation request
    const triggerResult = detectReportRequest(userMessage, logger);
    if (triggerResult.isReportRequest && downloadManager) {
      logger.info(`[CHAT_PIPELINE] Report request detected: ${triggerResult.period}`);

      // Resolve topicId from userId via user_topic_mapping
      let resolvedTopicId = 0;
      let useSlaveTopic = false;
      if (topicResolver) {
        const resolution = await topicResolver.getTopicIdsByUser(chatMsg.userId, userMessage);

        // Multiple project mappings and the message did not pin one down: remember
        // the request and ask which project instead of silently picking the first.
        if (resolution.needsDisambiguation) {
          const candidates = resolution.candidates ?? [];
          pendingDisambiguation.set(userId, {
            period: triggerResult.period!,
            requirement: triggerResult.requirement,
            dateScope: triggerResult.dateScope!,
            candidates,
            createdAt: Date.now(),
          });
          const listText = candidates.map((c, i) => `${i + 1}. ${c.projectName}`).join("\n");
          const askResponse =
            `您名下有多个项目，请问要查询哪一个项目的${triggerResult.period}？\n${listText}\n` +
            `直接回复序号（如「1」）或项目名即可。`;
          await mercure.pushText(mercureTopic, askResponse);
          // Signal completion so the frontend unlocks its input for the reply.
          await mercure.pushDone(mercureTopic);
          await historyManager.updateResponse(chatMsg.historyId, askResponse);
          logger.info(
            `[CHAT_PIPELINE] Multiple projects for user ${userId}, asking to disambiguate ` +
              `(${candidates.length} candidates)`,
          );
          return askResponse;
        }

        resolvedTopicId = resolution.topicId ?? 0;
        useSlaveTopic = resolution.useSlaveTopic;
        logger.info(
          `[CHAT_PIPELINE] Resolved topicId=${resolvedTopicId}, useSlaveTopic=${useSlaveTopic} for userId=${userId}`,
        );
      }

      return await createReportTaskAndRespond({
        period: triggerResult.period!,
        requirement: triggerResult.requirement,
        dateScope: triggerResult.dateScope!,
        topicId: resolvedTopicId,
        useSlaveTopic,
        chatMsg,
        mercure,
        mercureTopic,
        historyManager,
        downloadManager,
        feedCounter,
        reportTaskPublisher,
        logger,
      });
    }

    // Per-user agent isolation. Resolved before the event subscription so the
    // listener can scope itself to this run's session.
    const agentId = `rabbitmq-${userId}`;
    const sessionKey = `agent:${agentId}:rabbitmq:${userId}:${sessionId}`;

    // Step 3: Set up streaming pusher + subscribe to agent events
    streamPusherCtx.streamPusher = new StreamingMercurePusher(mercure, mercureTopic);

    // Only forward "assistant" deltas from THIS session. The agent runtime
    // attaches sessionKey to every event of a run; without that filter, any
    // concurrent run in the same gateway process (report subagent, heartbeat,
    // another user's chat) would bleed into this user's Mercure stream.
    const unsubscribe = runtime.events.onAgentEvent((evt) => {
      if (evt.stream !== "assistant" || evt.sessionKey !== sessionKey) {
        return;
      }
      const delta = extractAssistantDelta(evt.data);
      if (delta) {
        streamPusherCtx.streamPusher!.appendDelta(delta);
      }
    });

    try {
      // Step 4: Run subagent for this user's session.
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
        await streamPusherCtx.streamPusher.pushError(waitResult.error ?? "Unknown error");
        return `Error: ${waitResult.error}`;
      }

      if (waitResult.status === "timeout") {
        logger.warn(`[CHAT_PIPELINE] Subagent timed out for runId=${runResult.runId}`);
        await streamPusherCtx.streamPusher.pushError("Processing timed out");
        return "Error: Processing timed out";
      }

      // Step 6: Extract response from session messages as the canonical source
      const sessionMessages = await runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 5,
      });

      let fullResponse = "";
      if (sessionMessages.messages && Array.isArray(sessionMessages.messages)) {
        for (const msg of [...sessionMessages.messages].toReversed()) {
          const m = msg as { role?: string; content?: string };
          if (m.role === "assistant" && m.content) {
            fullResponse = m.content;
            break;
          }
        }
      }

      if (!fullResponse) {
        // Fall back to whatever the streaming pusher collected
        fullResponse = streamPusherCtx.streamPusher.getFullText() || "(No response generated)";
      }

      // Step 7: Update history record
      await historyManager.updateResponse(chatMsg.historyId, fullResponse);

      // Step 8: Finish streaming — flush remaining buffer + push done signal
      await streamPusherCtx.streamPusher.finish();

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

    logger.error(`[CHAT_PIPELINE] Unhandled error: ${String(error)}, code=${errCode}`);
    return `Error: ${String(error)}`;
  }
}
