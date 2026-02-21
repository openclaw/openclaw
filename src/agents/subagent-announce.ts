import { resolveQueueSettings } from "../auto-reply/reply/queue.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
  resolveQueueAnnounceId,
} from "./announce-idempotency.js";
import {
  isEmbeddedPiRunActive,
  queueEmbeddedPiMessage,
  waitForEmbeddedPiRunEnd,
} from "./pi-embedded.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { sanitizeTextContent, extractAssistantText } from "./tools/sessions-helpers.js";

type ToolResultMessage = {
  role?: unknown;
  content?: unknown;
};

type SubagentDeliveryPath = "queued" | "steered" | "direct" | "none";

type SubagentAnnounceDeliveryResult = {
  delivered: boolean;
  path: SubagentDeliveryPath;
  error?: string;
};

function buildCompletionDeliveryMessage(params: {
  findings: string;
  subagentName: string;
}): string {
  const findingsText = params.findings.trim();
  const hasFindings = findingsText.length > 0 && findingsText !== "(no output)";
  const header = `✅ Subagent ${params.subagentName} finished`;
  if (!hasFindings) {
    return header;
  }
  return `${header}\n\n${findingsText}`;
}

function summarizeDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "error";
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return sanitizeTextContent(content);
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const obj = content as {
      text?: unknown;
      output?: unknown;
      content?: unknown;
      result?: unknown;
      error?: unknown;
      summary?: unknown;
    };
    if (typeof obj.text === "string") {
      return sanitizeTextContent(obj.text);
    }
    if (typeof obj.output === "string") {
      return sanitizeTextContent(obj.output);
    }
    if (typeof obj.content === "string") {
      return sanitizeTextContent(obj.content);
    }
    if (typeof obj.result === "string") {
      return sanitizeTextContent(obj.result);
    }
    if (typeof obj.error === "string") {
      return sanitizeTextContent(obj.error);
    }
    if (typeof obj.summary === "string") {
      return sanitizeTextContent(obj.summary);
    }
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const joined = extractTextFromChatContent(content, {
    sanitizeText: sanitizeTextContent,
    normalizeText: (text) => text,
    joinWith: "\n",
  });
  return joined?.trim() ?? "";
}

function extractInlineTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return (
    extractTextFromChatContent(content, {
      sanitizeText: sanitizeTextContent,
      normalizeText: (text) => text.trim(),
      joinWith: "",
    }) ?? ""
  );
}

function extractSubagentOutputText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const role = (message as { role?: unknown }).role;
  const content = (message as { content?: unknown }).content;
  if (role === "assistant") {
    const assistantText = extractAssistantText(message);
    if (assistantText) {
      return assistantText;
    }
    if (typeof content === "string") {
      return sanitizeTextContent(content);
    }
    if (Array.isArray(content)) {
      return extractInlineTextContent(content);
    }
    return "";
  }
  if (role === "toolResult" || role === "tool") {
    return extractToolResultText((message as ToolResultMessage).content);
  }
  if (typeof content === "string") {
    return sanitizeTextContent(content);
  }
  if (Array.isArray(content)) {
    return extractInlineTextContent(content);
  }
  return "";
}

async function readLatestSubagentOutput(sessionKey: string): Promise<string | undefined> {
  const history = await callGateway<{ messages?: Array<unknown> }>({
    method: "chat.history",
    params: { sessionKey, limit: 50 },
  });
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const text = extractSubagentOutputText(msg);
    if (text) {
      return text;
    }
  }
  return undefined;
}

async function readLatestSubagentOutputWithRetry(params: {
  sessionKey: string;
  maxWaitMs: number;
}): Promise<string | undefined> {
  const RETRY_INTERVAL_MS = 100;
  const deadline = Date.now() + Math.max(0, Math.min(params.maxWaitMs, 15_000));
  let result: string | undefined;
  while (Date.now() < deadline) {
    result = await readLatestSubagentOutput(params.sessionKey);
    if (result?.trim()) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
  return result;
}

function formatDurationShort(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  const totalSeconds = Math.round(valueMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

function formatTokenCount(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

async function buildCompactAnnounceStatsLine(params: {
  sessionKey: string;
  startedAt?: number;
  endedAt?: number;
}) {
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  let entry = loadSessionStore(storePath)[params.sessionKey];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hasTokenData =
      typeof entry?.inputTokens === "number" ||
      typeof entry?.outputTokens === "number" ||
      typeof entry?.totalTokens === "number";
    if (hasTokenData) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    entry = loadSessionStore(storePath)[params.sessionKey];
  }

  const input = typeof entry?.inputTokens === "number" ? entry.inputTokens : 0;
  const output = typeof entry?.outputTokens === "number" ? entry.outputTokens : 0;
  const ioTotal = input + output;
  const promptCache = typeof entry?.totalTokens === "number" ? entry.totalTokens : undefined;
  const runtimeMs =
    typeof params.startedAt === "number" && typeof params.endedAt === "number"
      ? Math.max(0, params.endedAt - params.startedAt)
      : undefined;

  const parts = [
    `runtime ${formatDurationShort(runtimeMs)}`,
    `tokens ${formatTokenCount(ioTotal)} (in ${formatTokenCount(input)} / out ${formatTokenCount(output)})`,
  ];
  if (typeof promptCache === "number" && promptCache > ioTotal) {
    parts.push(`prompt/cache ${formatTokenCount(promptCache)}`);
  }
  return `Stats: ${parts.join(" • ")}`;
}

type DeliveryContextSource = Parameters<typeof deliveryContextFromSession>[0];

function resolveAnnounceOrigin(
  entry?: DeliveryContextSource,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedRequester = normalizeDeliveryContext(requesterOrigin);
  const normalizedEntry = deliveryContextFromSession(entry);
  if (normalizedRequester?.channel && !isDeliverableMessageChannel(normalizedRequester.channel)) {
    // Ignore internal/non-deliverable channel hints (for example webchat)
    // so a valid persisted route can still be used for outbound delivery.
    return mergeDeliveryContext(
      {
        accountId: normalizedRequester.accountId,
        threadId: normalizedRequester.threadId,
      },
      normalizedEntry,
    );
  }
  // requesterOrigin (captured at spawn time) reflects the channel the user is
  // actually on and must take priority over the session entry, which may carry
  // stale lastChannel / lastTo values from a previous channel interaction.
  return mergeDeliveryContext(normalizedRequester, normalizedEntry);
}

async function sendAnnounce(item: AnnounceQueueItem) {
  const requesterDepth = getSubagentDepthFromSessionStore(item.sessionKey);
  const requesterIsSubagent = requesterDepth >= 1;
  const origin = item.origin;
  const threadId =
    origin?.threadId != null && origin.threadId !== "" ? String(origin.threadId) : undefined;
  // Share one announce identity across direct and queued delivery paths so
  // gateway dedupe suppresses true retries without collapsing distinct events.
  const idempotencyKey = buildAnnounceIdempotencyKey(
    resolveQueueAnnounceId({
      announceId: item.announceId,
      sessionKey: item.sessionKey,
      enqueuedAt: item.enqueuedAt,
    }),
  );
  await callGateway({
    method: "agent",
    params: {
      sessionKey: item.sessionKey,
      message: item.prompt,
      channel: requesterIsSubagent ? undefined : origin?.channel,
      accountId: requesterIsSubagent ? undefined : origin?.accountId,
      to: requesterIsSubagent ? undefined : origin?.to,
      threadId: requesterIsSubagent ? undefined : threadId,
      deliver: !requesterIsSubagent,
      idempotencyKey,
    },
    timeoutMs: 15_000,
  });
}

function resolveRequesterStoreKey(
  cfg: ReturnType<typeof loadConfig>,
  requesterSessionKey: string,
): string {
  const raw = requesterSessionKey.trim();
  if (!raw) {
    return raw;
  }
  if (raw === "global" || raw === "unknown") {
    return raw;
  }
  if (raw.startsWith("agent:")) {
    return raw;
  }
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  if (raw === "main" || raw === mainKey) {
    return resolveMainSessionKey(cfg);
  }
  const agentId = resolveAgentIdFromSessionKey(raw);
  return `agent:${agentId}:${raw}`;
}

function loadRequesterSessionEntry(requesterSessionKey: string) {
  const cfg = loadConfig();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  return { cfg, entry, canonicalKey };
}

async function maybeQueueSubagentAnnounce(params: {
  requesterSessionKey: string;
  announceId?: string;
  triggerMessage: string;
  summaryLine?: string;
  requesterOrigin?: DeliveryContext;
}): Promise<"steered" | "queued" | "none"> {
  const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
  const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return "none";
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: entry?.channel ?? entry?.lastChannel,
    sessionEntry: entry,
  });
  const isActive = isEmbeddedPiRunActive(sessionId);

  const shouldSteer = queueSettings.mode === "steer" || queueSettings.mode === "steer-backlog";
  if (shouldSteer) {
    const steered = queueEmbeddedPiMessage(sessionId, params.triggerMessage);
    if (steered) {
      return "steered";
    }
  }

  const shouldFollowup =
    queueSettings.mode === "followup" ||
    queueSettings.mode === "collect" ||
    queueSettings.mode === "steer-backlog" ||
    queueSettings.mode === "interrupt";
  if (isActive && (shouldFollowup || queueSettings.mode === "steer")) {
    const origin = resolveAnnounceOrigin(entry, params.requesterOrigin);
    enqueueAnnounce({
      key: canonicalKey,
      item: {
        announceId: params.announceId,
        prompt: params.triggerMessage,
        summaryLine: params.summaryLine,
        enqueuedAt: Date.now(),
        sessionKey: canonicalKey,
        origin,
      },
      settings: queueSettings,
      send: sendAnnounce,
    });
    return "queued";
  }

  return "none";
}

function queueOutcomeToDeliveryResult(
  outcome: "steered" | "queued" | "none",
): SubagentAnnounceDeliveryResult {
  if (outcome === "steered") {
    return {
      delivered: true,
      path: "steered",
    };
  }
  if (outcome === "queued") {
    return {
      delivered: true,
      path: "queued",
    };
  }
  return {
    delivered: false,
    path: "none",
  };
}

async function sendSubagentAnnounceDirectly(params: {
  targetRequesterSessionKey: string;
  triggerMessage: string;
  completionMessage?: string;
  expectsCompletionMessage: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterIsSubagent: boolean;
}): Promise<SubagentAnnounceDeliveryResult> {
  const cfg = loadConfig();
  const canonicalRequesterSessionKey = resolveRequesterStoreKey(
    cfg,
    params.targetRequesterSessionKey,
  );
  try {
    const completionDirectOrigin = normalizeDeliveryContext(params.completionDirectOrigin);
    const completionChannelRaw =
      typeof completionDirectOrigin?.channel === "string"
        ? completionDirectOrigin.channel.trim()
        : "";
    const completionChannel =
      completionChannelRaw && isDeliverableMessageChannel(completionChannelRaw)
        ? completionChannelRaw
        : "";
    const completionTo =
      typeof completionDirectOrigin?.to === "string" ? completionDirectOrigin.to.trim() : "";
    const hasCompletionDirectTarget =
      !params.requesterIsSubagent && Boolean(completionChannel) && Boolean(completionTo);

    if (
      params.expectsCompletionMessage &&
      hasCompletionDirectTarget &&
      params.completionMessage?.trim()
    ) {
      const completionThreadId =
        completionDirectOrigin?.threadId != null && completionDirectOrigin.threadId !== ""
          ? String(completionDirectOrigin.threadId)
          : undefined;
      await callGateway({
        method: "send",
        params: {
          channel: completionChannel,
          to: completionTo,
          accountId: completionDirectOrigin?.accountId,
          threadId: completionThreadId,
          sessionKey: canonicalRequesterSessionKey,
          message: params.completionMessage,
          idempotencyKey: params.directIdempotencyKey,
        },
        timeoutMs: 15_000,
      });

      return {
        delivered: true,
        path: "direct",
      };
    }

    const directOrigin = normalizeDeliveryContext(params.directOrigin);
    const threadId =
      directOrigin?.threadId != null && directOrigin.threadId !== ""
        ? String(directOrigin.threadId)
        : undefined;
    await callGateway({
      method: "agent",
      params: {
        sessionKey: canonicalRequesterSessionKey,
        message: params.triggerMessage,
        deliver: !params.requesterIsSubagent,
        channel: params.requesterIsSubagent ? undefined : directOrigin?.channel,
        accountId: params.requesterIsSubagent ? undefined : directOrigin?.accountId,
        to: params.requesterIsSubagent ? undefined : directOrigin?.to,
        threadId: params.requesterIsSubagent ? undefined : threadId,
        idempotencyKey: params.directIdempotencyKey,
      },
      expectFinal: true,
      timeoutMs: 15_000,
    });

    return {
      delivered: true,
      path: "direct",
    };
  } catch (err) {
    return {
      delivered: false,
      path: "direct",
      error: summarizeDeliveryError(err),
    };
  }
}

async function deliverSubagentAnnouncement(params: {
  requesterSessionKey: string;
  announceId?: string;
  triggerMessage: string;
  completionMessage?: string;
  summaryLine?: string;
  requesterOrigin?: DeliveryContext;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  targetRequesterSessionKey: string;
  requesterIsSubagent: boolean;
  expectsCompletionMessage: boolean;
  directIdempotencyKey: string;
}): Promise<SubagentAnnounceDeliveryResult> {
  // Non-completion mode mirrors historical behavior: try queued/steered delivery first,
  // then (only if not queued) attempt direct delivery.
  if (!params.expectsCompletionMessage) {
    const queueOutcome = await maybeQueueSubagentAnnounce({
      requesterSessionKey: params.requesterSessionKey,
      announceId: params.announceId,
      triggerMessage: params.triggerMessage,
      summaryLine: params.summaryLine,
      requesterOrigin: params.requesterOrigin,
    });
    const queued = queueOutcomeToDeliveryResult(queueOutcome);
    if (queued.delivered) {
      return queued;
    }
  }

  // Completion-mode uses direct send first so manual spawns can return immediately
  // in the common ready-to-deliver case.
  const direct = await sendSubagentAnnounceDirectly({
    targetRequesterSessionKey: params.targetRequesterSessionKey,
    triggerMessage: params.triggerMessage,
    completionMessage: params.completionMessage,
    directIdempotencyKey: params.directIdempotencyKey,
    completionDirectOrigin: params.completionDirectOrigin,
    directOrigin: params.directOrigin,
    requesterIsSubagent: params.requesterIsSubagent,
    expectsCompletionMessage: params.expectsCompletionMessage,
  });
  if (direct.delivered || !params.expectsCompletionMessage) {
    return direct;
  }

  // If completion path failed direct delivery, try queueing as a fallback so the
  // report can still be delivered once the requester session is idle.
  const queueOutcome = await maybeQueueSubagentAnnounce({
    requesterSessionKey: params.requesterSessionKey,
    announceId: params.announceId,
    triggerMessage: params.triggerMessage,
    summaryLine: params.summaryLine,
    requesterOrigin: params.requesterOrigin,
  });
  if (queueOutcome === "steered" || queueOutcome === "queued") {
    return queueOutcomeToDeliveryResult(queueOutcome);
  }

  return direct;
}

function loadSessionEntryByKey(sessionKey: string) {
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  return store[sessionKey];
}

export function buildSubagentSystemPrompt(params: {
  requesterSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey: string;
  label?: string;
  task?: string;
  /** Depth of the child being spawned (1 = sub-agent, 2 = sub-sub-agent). */
  childDepth?: number;
  /** Config value: max allowed spawn depth. */
  maxSpawnDepth?: number;
}) {
  const taskText =
    typeof params.task === "string" && params.task.trim()
      ? params.task.replace(/\s+/g, " ").trim()
      : "{{TASK_DESCRIPTION}}";
  const childDepth = typeof params.childDepth === "number" ? params.childDepth : 1;
  const maxSpawnDepth = typeof params.maxSpawnDepth === "number" ? params.maxSpawnDepth : 1;
  const canSpawn = childDepth < maxSpawnDepth;
  const parentLabel = childDepth >= 2 ? "parent orchestrator" : "main agent";

  const lines = [
    "# Subagent Context",
    "",
    `You are a **subagent** spawned by the ${parentLabel} for a specific task.`,
    "",
    "## Your Role",
    `- You were created to handle: ${taskText}`,
    "- Complete this task. That's your entire purpose.",
    `- You are NOT the ${parentLabel}. Don't try to be.`,
    "",
    "## Rules",
    "1. **Stay focused** - Do your assigned task, nothing else",
    `2. **Complete the task** - Your final message will be automatically reported to the ${parentLabel}`,
    "3. **Don't initiate** - No heartbeats, no proactive actions, no side quests",
    "4. **Be ephemeral** - You may be terminated after task completion. That's fine.",
    "5. **Trust push-based completion** - Descendant results are auto-announced back to you; do not busy-poll for status.",
    "6. **Recover from compacted/truncated tool output** - If you see `[compacted: tool output removed to free context]` or `[truncated: output exceeded context limit]`, assume prior output was reduced. Re-read only what you need using smaller chunks (`read` with offset/limit, or targeted `rg`/`head`/`tail`) instead of full-file `cat`.",
    "",
    "## Output Format",
    "When complete, your final response should include:",
    `- What you accomplished or found`,
    `- Any relevant details the ${parentLabel} should know`,
    "- Keep it concise but informative",
    "",
    "## What You DON'T Do",
    `- NO user conversations (that's ${parentLabel}'s job)`,
    "- NO external messages (email, tweets, etc.) unless explicitly tasked with a specific recipient/channel",
    "- NO cron jobs or persistent state",
    `- NO pretending to be the ${parentLabel}`,
    `- Only use the \`message\` tool when explicitly instructed to contact a specific external recipient; otherwise return plain text and let the ${parentLabel} deliver it`,
    "",
  ];

  if (canSpawn) {
    lines.push(
      "## Sub-Agent Spawning",
      "You CAN spawn your own sub-agents for parallel or complex work using `sessions_spawn`.",
      "Use the `subagents` tool to steer, kill, or do an on-demand status check for your spawned sub-agents.",
      "Your sub-agents will announce their results back to you automatically (not to the main agent).",
      "Default workflow: spawn work, continue orchestrating, and wait for auto-announced completions.",
      "Do NOT repeatedly poll `subagents list` in a loop unless you are actively debugging or intervening.",
      "Coordinate their work and synthesize results before reporting back.",
      "",
    );
  } else if (childDepth >= 2) {
    lines.push(
      "## Sub-Agent Spawning",
      "You are a leaf worker and CANNOT spawn further sub-agents. Focus on your assigned task.",
      "",
    );
  }

  lines.push(
    "## Session Context",
    ...[
      params.label ? `- Label: ${params.label}` : undefined,
      params.requesterSessionKey
        ? `- Requester session: ${params.requesterSessionKey}.`
        : undefined,
      params.requesterOrigin?.channel
        ? `- Requester channel: ${params.requesterOrigin.channel}.`
        : undefined,
      `- Your session: ${params.childSessionKey}.`,
    ].filter((line): line is string => line !== undefined),
    "",
  );
  return lines.join("\n");
}

export type SubagentRunOutcome = {
  status: "ok" | "error" | "timeout" | "unknown";
  error?: string;
};

export type SubagentAnnounceType = "subagent task" | "cron job";

function buildAnnounceReplyInstruction(params: {
  remainingActiveSubagentRuns: number;
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
}): string {
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type).`;
  }
  if (params.remainingActiveSubagentRuns > 0) {
    const activeRunsLabel = params.remainingActiveSubagentRuns === 1 ? "run" : "runs";
    return `There are still ${params.remainingActiveSubagentRuns} active subagent ${activeRunsLabel} for this session. If they are part of the same workflow, wait for the remaining results before sending a user update. If they are unrelated, respond normally using only the result above.`;
  }
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the system message verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  announceType?: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
}): Promise<boolean> {
  let didAnnounce = false;
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  let shouldDeleteChildSession = params.cleanup === "delete";
  try {
    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionId = (() => {
      const entry = loadSessionEntryByKey(params.childSessionKey);
      return typeof entry?.sessionId === "string" && entry.sessionId.trim()
        ? entry.sessionId.trim()
        : undefined;
    })();
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    let reply = params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    // Lifecycle "end" can arrive before auto-compaction retries finish. If the
    // subagent is still active, wait for the embedded run to fully settle.
    if (!expectsCompletionMessage && childSessionId && isEmbeddedPiRunActive(childSessionId)) {
      const settled = await waitForEmbeddedPiRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedPiRunActive(childSessionId)) {
        // The child run is still active (e.g., compaction retry still in progress).
        // Defer announcement so we don't report stale/partial output.
        // Keep the child session so output is not lost while the run is still active.
        shouldDeleteChildSession = false;
        return false;
      }
    }

    if (!reply && params.waitForCompletion !== false) {
      const waitMs = settleTimeoutMs;
      const wait = await callGateway<{
        status?: string;
        startedAt?: number;
        endedAt?: number;
        error?: string;
      }>({
        method: "agent.wait",
        params: {
          runId: params.childRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      });
      const waitError = typeof wait?.error === "string" ? wait.error : undefined;
      if (wait?.status === "timeout") {
        outcome = { status: "timeout" };
      } else if (wait?.status === "error") {
        outcome = { status: "error", error: waitError };
      } else if (wait?.status === "ok") {
        outcome = { status: "ok" };
      }
      if (typeof wait?.startedAt === "number" && !params.startedAt) {
        params.startedAt = wait.startedAt;
      }
      if (typeof wait?.endedAt === "number" && !params.endedAt) {
        params.endedAt = wait.endedAt;
      }
      if (wait?.status === "timeout") {
        if (!outcome) {
          outcome = { status: "timeout" };
        }
      }
      reply = await readLatestSubagentOutput(params.childSessionKey);
    }

    if (!reply) {
      reply = await readLatestSubagentOutput(params.childSessionKey);
    }

    if (!reply?.trim()) {
      reply = await readLatestSubagentOutputWithRetry({
        sessionKey: params.childSessionKey,
        maxWaitMs: params.timeoutMs,
      });
    }

    if (
      !expectsCompletionMessage &&
      !reply?.trim() &&
      childSessionId &&
      isEmbeddedPiRunActive(childSessionId)
    ) {
      // Avoid announcing "(no output)" while the child run is still producing output.
      shouldDeleteChildSession = false;
      return false;
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    let activeChildDescendantRuns = 0;
    try {
      const { countActiveDescendantRuns } = await import("./subagent-registry.js");
      activeChildDescendantRuns = Math.max(0, countActiveDescendantRuns(params.childSessionKey));
    } catch {
      // Best-effort only; fall back to direct announce behavior when unavailable.
    }
    if (!expectsCompletionMessage && activeChildDescendantRuns > 0) {
      // The finished run still has active descendant subagents. Defer announcing
      // this run until descendants settle so we avoid posting in-progress updates.
      shouldDeleteChildSession = false;
      return false;
    }

    // Build status label
    const statusLabel =
      outcome.status === "ok"
        ? "completed successfully"
        : outcome.status === "timeout"
          ? "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    // Build instructional message for main agent
    const announceType = params.announceType ?? "subagent task";
    const taskLabel = params.label || params.task || "task";
    const subagentName = resolveAgentIdFromSessionKey(params.childSessionKey);
    const announceSessionId = childSessionId || "unknown";
    const findings = reply || "(no output)";
    let completionMessage = "";
    let triggerMessage = "";

    let requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
    let requesterIsSubagent = !expectsCompletionMessage && requesterDepth >= 1;
    // If the requester subagent has already finished, bubble the announce to its
    // requester (typically main) so descendant completion is not silently lost.
    // BUT: only fallback if the parent SESSION is deleted, not just if the current
    // run ended. A parent waiting for child results has no active run but should
    // still receive the announce — injecting will start a new agent turn.
    if (requesterIsSubagent) {
      const { isSubagentSessionRunActive, resolveRequesterForChildSession } =
        await import("./subagent-registry.js");
      if (!isSubagentSessionRunActive(targetRequesterSessionKey)) {
        // Parent run has ended. Check if parent SESSION still exists.
        // If it does, the parent may be waiting for child results — inject there.
        const parentSessionEntry = loadSessionEntryByKey(targetRequesterSessionKey);
        const parentSessionAlive =
          parentSessionEntry &&
          typeof parentSessionEntry.sessionId === "string" &&
          parentSessionEntry.sessionId.trim();

        if (!parentSessionAlive) {
          // Parent session is truly gone — fallback to grandparent
          const fallback = resolveRequesterForChildSession(targetRequesterSessionKey);
          if (!fallback?.requesterSessionKey) {
            // Without a requester fallback we cannot safely deliver this nested
            // completion. Keep cleanup retryable so a later registry restore can
            // recover and re-announce instead of silently dropping the result.
            shouldDeleteChildSession = false;
            return false;
          }
          targetRequesterSessionKey = fallback.requesterSessionKey;
          targetRequesterOrigin =
            normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
          requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
          requesterIsSubagent = requesterDepth >= 1;
        }
        // If parent session is alive (just has no active run), continue with parent
        // as target. Injecting the announce will start a new agent turn for processing.
      }
    }

    let remainingActiveSubagentRuns = 0;
    try {
      const { countActiveDescendantRuns } = await import("./subagent-registry.js");
      remainingActiveSubagentRuns = Math.max(
        0,
        countActiveDescendantRuns(targetRequesterSessionKey),
      );
    } catch {
      // Best-effort only; fall back to default announce instructions when unavailable.
    }
    const replyInstruction = buildAnnounceReplyInstruction({
      remainingActiveSubagentRuns,
      requesterIsSubagent,
      announceType,
      expectsCompletionMessage,
    });
    const statsLine = await buildCompactAnnounceStatsLine({
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });
    completionMessage = buildCompletionDeliveryMessage({
      findings,
      subagentName,
    });
    const internalSummaryMessage = [
      `[System Message] [sessionId: ${announceSessionId}] A ${announceType} "${taskLabel}" just ${statusLabel}.`,
      "",
      "Result:",
      findings,
      "",
      statsLine,
    ].join("\n");
    triggerMessage = [internalSummaryMessage, "", replyInstruction].join("\n");

    const announceId = buildAnnounceIdFromChildRun({
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
    });
    // Send to the requester session. For nested subagents this is an internal
    // follow-up injection (deliver=false) so the orchestrator receives it.
    let directOrigin = targetRequesterOrigin;
    if (!requesterIsSubagent) {
      const { entry } = loadRequesterSessionEntry(targetRequesterSessionKey);
      directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
    }
    // Use a deterministic idempotency key so the gateway dedup cache
    // catches duplicates if this announce is also queued by the gateway-
    // level message queue while the main session is busy (#17122).
    const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
    const delivery = await deliverSubagentAnnouncement({
      requesterSessionKey: targetRequesterSessionKey,
      announceId,
      triggerMessage,
      completionMessage,
      summaryLine: taskLabel,
      requesterOrigin: targetRequesterOrigin,
      completionDirectOrigin: targetRequesterOrigin,
      directOrigin,
      targetRequesterSessionKey,
      requesterIsSubagent,
      expectsCompletionMessage: expectsCompletionMessage,
      directIdempotencyKey,
    });
    didAnnounce = delivery.delivered;
    if (!delivery.delivered && delivery.path === "direct" && delivery.error) {
      defaultRuntime.error?.(
        `Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`,
      );
    }
  } catch (err) {
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // Patch label after all writes complete
    if (params.label) {
      try {
        await callGateway({
          method: "sessions.patch",
          params: { key: params.childSessionKey, label: params.label },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort
      }
    }
    if (shouldDeleteChildSession) {
      try {
        await callGateway({
          method: "sessions.delete",
          params: { key: params.childSessionKey, deleteTranscript: true },
          timeoutMs: 10_000,
        });
      } catch {
        // ignore
      }
    }
  }
  return didAnnounce;
}
