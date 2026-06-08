import type { PluginRuntime, PluginLogger } from "../api.js";
import type { DownloadManager } from "./download-manager.js";
import type { FeedCounter } from "./feed-counter.js";
import type { HistoryManager } from "./history-manager.js";
import { MercurePusher, StreamingMercurePusher } from "./mercure-pusher.js";
import type { ReportTaskPublisher } from "./report-task-publisher.js";
import { computeDateScope, detectReportRequest, type ReportPeriod } from "./report-trigger.js";
import type { ReportTemplateLookup } from "./report-template-lookup.js";
import { ToolActivityNarrator } from "./tool-activity.js";
import type { TopicResolver } from "./topic-resolver.js";
import type { ChatMessage, MercureConfig } from "./types.js";

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
 * Resolve the user's report topic (entity_auth: uid -> masterId/slaveId).
 * Shared by the explicit-template and keyword report paths so both agree on
 * which feed_topic the report covers. Returns zeros when no resolver/mapping.
 */
async function resolveReportTopic(
  userId: string,
  topicResolver: TopicResolver | undefined,
  logger: PluginLogger,
): Promise<{ topicId: number; useSlaveTopic: boolean; masterId: number }> {
  if (!topicResolver) {
    return { topicId: 0, useSlaveTopic: false, masterId: 0 };
  }
  const resolution = await topicResolver.getTopicIdsByUser(userId);
  const topicId = resolution.topicId ?? 0;
  logger.info(
    `[CHAT_PIPELINE] Resolved topicId=${topicId}, useSlaveTopic=${resolution.useSlaveTopic}, ` +
      `masterId=${resolution.masterId} for userId=${userId}`,
  );
  return {
    topicId,
    useSlaveTopic: resolution.useSlaveTopic,
    masterId: resolution.masterId,
  };
}

/**
 * Pre-count feed data, then queue a report task and reply (or report "no data").
 * Always emits a Mercure `done` so the frontend unlocks.
 */
async function createReportTaskAndRespond(args: {
  period: ReportPeriod;
  requirement: string;
  dateScope: { start: string; end: string };
  topicId: number;
  useSlaveTopic: boolean;
  /** Master topic id from entity_auth; stored as download.topicId in slave mode. */
  masterId: number;
  /** report_template.id the user picked explicitly (undefined for keyword reports). */
  templateId: number | undefined;
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
    masterId,
    templateId,
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
      feedCount = await feedCounter.countFeedData(
        topicId,
        dateScope.start,
        dateScope.end,
        useSlaveTopic,
      );
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
    await mercure.pushText(mercureTopic, emptyResponse, chatMsg.historyId);
    await mercure.pushDone(mercureTopic, chatMsg.historyId);
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
    masterId,
    mercureTopic,
    templateId,
    // Same per-user agent the chat runs under, so the report subagent
    // inherits its workspace, DB skills, and schema knowledge.
    agentId: `rabbitmq-${chatMsg.userId}`,
  });
  logger.info(`[CHAT_PIPELINE] Created report task #${taskId} for user ${uid}`);

  // The report itself is generated asynchronously by the report-generator service.
  const countHint = feedCount > 0 ? `已检索到 ${feedCount} 条数据，` : "";
  const reportResponse = `${countHint}${period}报告已创建，正在生成中...`;
  await mercure.pushText(mercureTopic, reportResponse, chatMsg.historyId);
  // Let the frontend open a report card for this taskId right away; progress
  // (`report_text`) and the final `report` event will target the same card.
  await mercure.pushReportCreated(mercureTopic, taskId);
  // Unlock the frontend; the report arrives later as a separate "report" event.
  await mercure.pushDone(mercureTopic, chatMsg.historyId);
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
  templateLookup?: ReportTemplateLookup,
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

    // Step 2.4: Explicit template-driven report request. The frontend's report
    // template panel sends the picked report_template.id; that template's own
    // period drives the date scope and the report-generator loads this exact
    // template. Takes precedence over keyword detection. An unresolvable id
    // (deleted, disabled, another user's) falls through to ordinary handling.
    if (chatMsg.templateId && downloadManager && templateLookup) {
      const tpl = await templateLookup.resolve(chatMsg.templateId, userId, logger);
      if (tpl) {
        logger.info(
          `[CHAT_PIPELINE] Explicit template #${tpl.id} ("${tpl.name}") -> ${tpl.period} report`,
        );
        const topic = await resolveReportTopic(userId, topicResolver, logger);
        return await createReportTaskAndRespond({
          period: tpl.period,
          // The user's typed text becomes the requirement; it may just be the
          // template name when they only clicked the template without editing.
          requirement: userMessage,
          dateScope: computeDateScope(tpl.period),
          topicId: topic.topicId,
          useSlaveTopic: topic.useSlaveTopic,
          masterId: topic.masterId,
          templateId: tpl.id,
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
      logger.warn(
        `[CHAT_PIPELINE] templateId=${chatMsg.templateId} did not resolve; ` +
          `falling back to normal handling`,
      );
    }

    // Step 2.5: Check if this is a report generation request (keyword path)
    const triggerResult = detectReportRequest(userMessage, logger);
    if (triggerResult.isReportRequest && downloadManager) {
      logger.info(`[CHAT_PIPELINE] Report request detected: ${triggerResult.period}`);

      const topic = await resolveReportTopic(userId, topicResolver, logger);

      return await createReportTaskAndRespond({
        period: triggerResult.period!,
        requirement: triggerResult.requirement,
        dateScope: triggerResult.dateScope!,
        topicId: topic.topicId,
        useSlaveTopic: topic.useSlaveTopic,
        masterId: topic.masterId,
        templateId: undefined,
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

    // Resolve the user's topic ownership up front (entity_auth: uid ->
    // masterId/slaveId) and inject it into the message, so the agent never
    // has to guess which feed_topic belongs to this user. Resolution failure
    // degrades to the plain [userId:...] prefix instead of failing the chat.
    let topicContext = "";
    if (topicResolver) {
      try {
        const resolution = await topicResolver.getTopicIdsByUser(userId);
        if (resolution.topicId && resolution.topicId > 0) {
          // JSON.stringify keeps the quoting deterministic even when the
          // title itself contains quotes or brackets (prompt-cache friendly).
          const namePart = resolution.topicName
            ? ` topicName:${JSON.stringify(resolution.topicName)}`
            : "";
          topicContext = ` [topicId:${resolution.topicId}${namePart} useSlaveTopic:${resolution.useSlaveTopic}]`;
          // A user can own several topics; list them all (sorted by topicId
          // upstream) so the agent never has to guess beyond the prefix.
          if (resolution.topics.length > 1) {
            const all = resolution.topics
              .map((t) => `${t.topicId}${t.topicName ? `:${JSON.stringify(t.topicName)}` : ""}`)
              .join(", ");
            topicContext += ` [allTopics: ${all}]`;
          }
          logger.info(
            `[CHAT_PIPELINE] Injecting topic context for userId=${userId}:${topicContext}`,
          );
        }
      } catch (err) {
        logger.warn(
          `[CHAT_PIPELINE] Topic resolution failed, continuing without topic context: ${String(err)}`,
        );
      }
    }

    // Per-user agent isolation. Resolved before the event subscription so the
    // listener can scope itself to this run's session.
    const agentId = `rabbitmq-${userId}`;
    const sessionKey = `agent:${agentId}:rabbitmq:${userId}:${sessionId}`;

    // Step 3: Set up streaming pusher + subscribe to agent events.
    // Tag every push with this turn's historyId so stale frontend
    // subscriptions on the shared per-user topic can drop foreign chunks.
    streamPusherCtx.streamPusher = new StreamingMercurePusher(
      mercure,
      mercureTopic,
      chatMsg.historyId,
    );

    // Sanitized tool-activity narration: while the agent runs tools (DB
    // queries etc.) it produces no assistant deltas, so without these pushes
    // the frontend sees nothing for the whole tool phase. Only the tool NAME
    // is mapped to a generic status line — args (SQL, paths) never leak.
    const narrator = new ToolActivityNarrator({
      push: (message) => {
        void mercure.pushProgress(mercureTopic, message, chatMsg.historyId);
      },
    });

    // Only forward events from THIS session. The agent runtime attaches
    // sessionKey to every event of a run; without that filter, any
    // concurrent run in the same gateway process (report subagent, heartbeat,
    // another user's chat) would bleed into this user's Mercure stream.
    const unsubscribe = runtime.events.onAgentEvent((evt) => {
      if (evt.sessionKey !== sessionKey) {
        return;
      }
      if (evt.stream === "tool") {
        narrator.handleAgentEvent(evt);
        return;
      }
      if (evt.stream !== "assistant") {
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
      void mercure.pushText(mercureTopic, "正在处理，请稍候…", chatMsg.historyId);

      const runResult = await runtime.subagent.run({
        sessionKey,
        message: `[userId:${userId}]${topicContext} ${userMessage}`,
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
