import crypto from "node:crypto";
import path from "node:path";
import type { OriginatingChannelType } from "../auto-reply/templating.js";
import { resolveQueueSettings } from "../auto-reply/reply/queue.js";
import { isRoutableChannel, routeReply } from "../auto-reply/reply/route-reply.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { type ThreadBinding, getSessionThreadBinding } from "../config/thread-registry.js";
import { callGateway } from "../gateway/call.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import { isEmbeddedPiRunActive, queueEmbeddedPiMessage } from "./pi-embedded.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";
import { readLatestAssistantReply } from "./tools/agent-step.js";

function formatDurationShort(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return undefined;
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
  if (!value || !Number.isFinite(value)) {
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

function formatUsd(value?: number) {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

function resolveModelCost(params: {
  provider?: string;
  model?: string;
  config: ReturnType<typeof loadConfig>;
}):
  | {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return undefined;
  }
  const models = params.config.models?.providers?.[provider]?.models ?? [];
  const entry = models.find((candidate) => candidate.id === model);
  return entry?.cost;
}

async function waitForSessionUsage(params: { sessionKey: string }) {
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  let entry = loadSessionStore(storePath)[params.sessionKey];
  if (!entry) {
    return { entry, storePath };
  }
  const hasTokens = () =>
    entry &&
    (typeof entry.totalTokens === "number" ||
      typeof entry.inputTokens === "number" ||
      typeof entry.outputTokens === "number");
  if (hasTokens()) {
    return { entry, storePath };
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    entry = loadSessionStore(storePath)[params.sessionKey];
    if (hasTokens()) {
      break;
    }
  }
  return { entry, storePath };
}

type DeliveryContextSource = Parameters<typeof deliveryContextFromSession>[0];

function resolveAnnounceOrigin(
  entry?: DeliveryContextSource,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  // requesterOrigin (captured at spawn time) reflects the channel the user is
  // actually on and must take priority over the session entry, which may carry
  // stale lastChannel / lastTo values from a previous channel interaction.
  return mergeDeliveryContext(requesterOrigin, deliveryContextFromSession(entry));
}

async function sendAnnounce(item: AnnounceQueueItem) {
  const origin = item.origin;
  const threadId =
    origin?.threadId != null && origin.threadId !== "" ? String(origin.threadId) : undefined;
  await callGateway({
    method: "agent",
    params: {
      sessionKey: item.sessionKey,
      message: item.prompt,
      channel: origin?.channel,
      accountId: origin?.accountId,
      to: origin?.to,
      threadId,
      deliver: true,
      idempotencyKey: crypto.randomUUID(),
    },
    expectFinal: true,
    timeoutMs: 60_000,
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

async function buildSubagentStatsLine(params: {
  sessionKey: string;
  startedAt?: number;
  endedAt?: number;
}) {
  const cfg = loadConfig();
  const { entry, storePath } = await waitForSessionUsage({
    sessionKey: params.sessionKey,
  });

  const sessionId = entry?.sessionId;
  const transcriptPath =
    sessionId && storePath ? path.join(path.dirname(storePath), `${sessionId}.jsonl`) : undefined;

  const input = entry?.inputTokens;
  const output = entry?.outputTokens;
  const total =
    entry?.totalTokens ??
    (typeof input === "number" && typeof output === "number" ? input + output : undefined);
  const runtimeMs =
    typeof params.startedAt === "number" && typeof params.endedAt === "number"
      ? Math.max(0, params.endedAt - params.startedAt)
      : undefined;

  const provider = entry?.modelProvider;
  const model = entry?.model;
  const costConfig = resolveModelCost({ provider, model, config: cfg });
  const cost =
    costConfig && typeof input === "number" && typeof output === "number"
      ? (input * costConfig.input + output * costConfig.output) / 1_000_000
      : undefined;

  const parts: string[] = [];
  const runtime = formatDurationShort(runtimeMs);
  parts.push(`runtime ${runtime ?? "n/a"}`);
  if (typeof total === "number") {
    const inputText = typeof input === "number" ? formatTokenCount(input) : "n/a";
    const outputText = typeof output === "number" ? formatTokenCount(output) : "n/a";
    const totalText = formatTokenCount(total);
    parts.push(`tokens ${totalText} (in ${inputText} / out ${outputText})`);
  } else {
    parts.push("tokens n/a");
  }
  const costText = formatUsd(cost);
  if (costText) {
    parts.push(`est ${costText}`);
  }
  parts.push(`sessionKey ${params.sessionKey}`);
  if (sessionId) {
    parts.push(`sessionId ${sessionId}`);
  }
  if (transcriptPath) {
    parts.push(`transcript ${transcriptPath}`);
  }

  return `Stats: ${parts.join(" \u2022 ")}`;
}

export function buildSubagentSystemPrompt(params: {
  requesterSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey: string;
  label?: string;
  task?: string;
  threadBinding?: {
    channel: string;
    to: string;
    threadId: string;
    label?: string;
  };
}) {
  const taskText =
    typeof params.task === "string" && params.task.trim()
      ? params.task.replace(/\s+/g, " ").trim()
      : "{{TASK_DESCRIPTION}}";

  const hasThread =
    params.threadBinding?.channel && params.threadBinding?.to && params.threadBinding?.threadId;

  const lines = [
    "# Subagent Context",
    "",
    "You are a **subagent** spawned by the main agent for a specific task.",
    "",
    "## Your Role",
    `- You were created to handle: ${taskText}`,
    "- Complete this task. That's your entire purpose.",
    "- You are NOT the main agent. Don't try to be.",
    "",
    "## Rules",
    "1. **Stay focused** - Do your assigned task, nothing else",
    "2. **Complete the task** - Your final message will be automatically reported to the main agent",
    "3. **Don't initiate** - No heartbeats, no proactive actions, no side quests",
    "4. **Be ephemeral** - You may be terminated after task completion. That's fine.",
    "",
    "## Output Format",
    "When complete, your final response MUST end with a status line:",
    "",
    "- `STATUS: DONE` — task completed successfully, no further action needed",
    "- `STATUS: DONE — [summary]` — completed with key info the orchestrator should know",
    "- `STATUS: BLOCKED — [reason]` — cannot proceed, explain what's blocking",
    "- `STATUS: NEEDS_INPUT — [questions]` — need human/orchestrator answers to continue",
    "",
    "Before the status line, include:",
    "- What you accomplished or found",
    "- Any relevant details the parent agent should know",
    "- Keep it concise but informative",
    "",
    "## What You DON'T Do",
    "- NO user conversations (that's main agent's job)",
    "- NO external messages (email, tweets, etc.) unless explicitly tasked with a specific recipient/channel",
    "- NO cron jobs or persistent state",
    "- NO pretending to be the main agent",
    hasThread
      ? undefined
      : "- Only use the `message` tool when explicitly instructed to contact a specific external recipient; otherwise return plain text and let the main agent deliver it",
    "",
  ].filter((line): line is string => line !== undefined);

  // Thread binding context — tells the agent where to post progress updates
  if (hasThread) {
    const tb = params.threadBinding!;
    lines.push(
      "## Thread Communication",
      "",
      "You are bound to a platform thread. Post progress updates there so humans can follow along.",
      "",
      `- **Channel:** ${tb.channel}`,
      `- **Target:** ${tb.to}`,
      `- **Thread ID:** ${tb.threadId}`,
      tb.label ? `- **Thread label:** ${tb.label}` : (undefined as unknown as string),
      "",
      "To post an update, use the `message` tool:",
      `  action=send, channel=${tb.channel}, target=${tb.to}, threadId=${tb.threadId}`,
      "",
      "**When to post:**",
      "- Significant progress milestones (e.g., 'Found the issue', 'Starting implementation')",
      "- Key findings or decisions",
      "- Errors or blockers encountered",
      "- Completion summary",
      "",
      "**Don't spam** — a few meaningful updates, not every command you run.",
      "",
    );
    // Filter out any undefined entries from conditional label line
    const filtered = lines.filter(
      (line): line is string => line !== undefined && typeof line === "string",
    );
    lines.length = 0;
    lines.push(...filtered);
  }

  lines.push(
    "## Session Context",
    params.label ? `- Label: ${params.label}` : (undefined as unknown as string),
    params.requesterSessionKey
      ? `- Requester session: ${params.requesterSessionKey}.`
      : (undefined as unknown as string),
    params.requesterOrigin?.channel
      ? `- Requester channel: ${params.requesterOrigin.channel}.`
      : (undefined as unknown as string),
    `- Your session: ${params.childSessionKey}.`,
    "",
  );

  return lines
    .filter((line): line is string => line !== undefined && typeof line === "string")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Thread-aware announce routing
// ---------------------------------------------------------------------------

/**
 * Determine announcement targets based on the child session's thread binding.
 *
 * Returns:
 *   - `thread`: post directly to the bound thread (bypass requester agent)
 *   - `requester`: send to requester agent as today (default)
 *   - `both`: post to thread AND send to requester
 */
type AnnounceTarget = "thread" | "requester" | "both";

async function resolveAnnounceTarget(params: { childSessionKey: string }): Promise<{
  target: AnnounceTarget;
  threadBinding?: ThreadBinding;
}> {
  try {
    const agentId = resolveAgentIdFromSessionKey(params.childSessionKey);
    const cfg = loadConfig();
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const binding = await getSessionThreadBinding({
      storePath,
      sessionKey: params.childSessionKey,
    });
    if (!binding || !binding.to) {
      return { target: "requester" };
    }
    switch (binding.mode) {
      case "thread-only":
        return { target: "thread", threadBinding: binding };
      case "thread+announcer":
        return { target: "both", threadBinding: binding };
      case "announcer-only":
        return { target: "requester", threadBinding: binding };
      default:
        return { target: "requester" };
    }
  } catch {
    return { target: "requester" };
  }
}

/**
 * Post a completion summary directly to the bound thread via routeReply.
 *
 * This bypasses the requester agent re-prompt flow — the sub-agent's final
 * reply IS the output, so no additional LLM summarisation is needed.
 */
async function postCompletionToThread(params: {
  threadBinding: ThreadBinding;
  reply: string | undefined;
  statsLine: string;
  statusLabel: string;
  taskLabel: string;
}): Promise<void> {
  const { threadBinding, reply, statusLabel, taskLabel } = params;

  if (!threadBinding.to || !isRoutableChannel(threadBinding.channel as OriginatingChannelType)) {
    throw new Error("Thread binding missing 'to' or channel not routable");
  }

  // Format a concise completion message
  const lines: string[] = [];
  if (statusLabel.includes("completed")) {
    lines.push(`✅ Task "${taskLabel}" completed.`);
  } else if (statusLabel.includes("timed out")) {
    lines.push(`⏱️ Task "${taskLabel}" timed out.`);
  } else if (statusLabel.includes("failed")) {
    lines.push(`❌ Task "${taskLabel}" ${statusLabel}.`);
  } else {
    lines.push(`📋 Task "${taskLabel}" ${statusLabel}.`);
  }

  if (reply) {
    lines.push("");
    lines.push(reply);
  }

  const text = lines.join("\n");
  const cfg = loadConfig();

  await routeReply({
    payload: { text },
    channel: threadBinding.channel as OriginatingChannelType,
    to: threadBinding.to,
    threadId: threadBinding.threadId,
    accountId: threadBinding.accountId,
    cfg,
  });
}

export type SubagentRunOutcome = {
  status: "ok" | "error" | "timeout" | "unknown";
  error?: string;
};

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
}): Promise<boolean> {
  let didAnnounce = false;
  try {
    const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    let reply = params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (!reply && params.waitForCompletion !== false) {
      const waitMs = Math.min(params.timeoutMs, 60_000);
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
      reply = await readLatestAssistantReply({
        sessionKey: params.childSessionKey,
      });
    }

    if (!reply) {
      reply = await readLatestAssistantReply({
        sessionKey: params.childSessionKey,
      });
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    // Build stats
    const statsLine = await buildSubagentStatsLine({
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });

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
    const taskLabel = params.label || params.task || "background task";

    // -----------------------------------------------------------------------
    // Thread-aware routing: check if the child session has a thread binding
    // and route the completion accordingly.
    // -----------------------------------------------------------------------
    const { target: announceTarget, threadBinding: childThreadBinding } =
      await resolveAnnounceTarget({ childSessionKey: params.childSessionKey });

    // --- Thread delivery (direct post, no re-prompting) ---
    if ((announceTarget === "thread" || announceTarget === "both") && childThreadBinding) {
      try {
        await postCompletionToThread({
          threadBinding: childThreadBinding,
          reply,
          statsLine,
          statusLabel,
          taskLabel,
        });
        didAnnounce = true;
      } catch (err) {
        defaultRuntime.error?.(`Thread announce failed, falling back to requester: ${String(err)}`);
        // Fall through to requester announce as fallback
      }
    }

    // --- Requester delivery (existing behavior) ---
    // Send to requester when: target is "requester", target is "both",
    // or thread delivery failed (didAnnounce is still false).
    if (announceTarget === "requester" || announceTarget === "both" || !didAnnounce) {
      const triggerMessage = [
        `A background task "${taskLabel}" just ${statusLabel}.`,
        "",
        "Findings:",
        reply || "(no output)",
        "",
        statsLine,
        "",
        "Summarize this naturally for the user. Keep it brief (1-2 sentences). Flow it into the conversation naturally.",
        "Do not mention technical details like tokens, stats, or that this was a background task.",
        "You can respond with NO_REPLY if no announcement is needed (e.g., internal task with no user-facing result).",
      ].join("\n");

      const queued = await maybeQueueSubagentAnnounce({
        requesterSessionKey: params.requesterSessionKey,
        triggerMessage,
        summaryLine: taskLabel,
        requesterOrigin,
      });
      if (queued === "steered" || queued === "queued") {
        didAnnounce = true;
      } else {
        // Send to main agent - it will respond in its own voice
        let directOrigin = requesterOrigin;
        if (!directOrigin) {
          const { entry } = loadRequesterSessionEntry(params.requesterSessionKey);
          directOrigin = deliveryContextFromSession(entry);
        }
        await callGateway({
          method: "agent",
          params: {
            sessionKey: params.requesterSessionKey,
            message: triggerMessage,
            deliver: true,
            channel: directOrigin?.channel,
            accountId: directOrigin?.accountId,
            to: directOrigin?.to,
            threadId:
              directOrigin?.threadId != null && directOrigin.threadId !== ""
                ? String(directOrigin.threadId)
                : undefined,
            idempotencyKey: crypto.randomUUID(),
          },
          expectFinal: true,
          timeoutMs: 60_000,
        });
        didAnnounce = true;
      }
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
    if (params.cleanup === "delete") {
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
