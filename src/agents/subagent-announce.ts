import crypto from "node:crypto";
import path from "node:path";

import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { normalizeMainKey } from "../routing/session-key.js";
import {
  resolveQueueSettings,
  type QueueDropPolicy,
  type QueueMode,
} from "../auto-reply/reply/queue.js";
import { callGateway } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  deliveryContextKey,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import { isEmbeddedPiRunActive, queueEmbeddedPiMessage } from "./pi-embedded.js";
import { readLatestAssistantReply } from "./tools/agent-step.js";

function formatDurationShort(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) return undefined;
  const totalSeconds = Math.round(valueMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function formatTokenCount(value?: number) {
  if (!value || !Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatUsd(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
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
  if (!provider || !model) return undefined;
  const models = params.config.models?.providers?.[provider]?.models ?? [];
  const entry = models.find((candidate) => candidate.id === model);
  return entry?.cost;
}

async function waitForSessionUsage(params: { sessionKey: string }) {
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  let entry = loadSessionStore(storePath)[params.sessionKey];
  if (!entry) return { entry, storePath };
  const hasTokens = () =>
    entry &&
    (typeof entry.totalTokens === "number" ||
      typeof entry.inputTokens === "number" ||
      typeof entry.outputTokens === "number");
  if (hasTokens()) return { entry, storePath };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    entry = loadSessionStore(storePath)[params.sessionKey];
    if (hasTokens()) break;
  }
  return { entry, storePath };
}

type AnnounceQueueItem = {
  prompt: string;
  summaryLine?: string;
  enqueuedAt: number;
  sessionKey: string;
  origin?: DeliveryContext;
  originKey?: string;
};

type AnnounceQueueState = {
  items: AnnounceQueueItem[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
};

const ANNOUNCE_QUEUES = new Map<string, AnnounceQueueState>();

type DeliveryContextSource = Parameters<typeof deliveryContextFromSession>[0];

function resolveAnnounceOrigin(
  entry?: DeliveryContextSource,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  return mergeDeliveryContext(deliveryContextFromSession(entry), requesterOrigin);
}

function getAnnounceQueue(
  key: string,
  settings: { mode: QueueMode; debounceMs?: number; cap?: number; dropPolicy?: QueueDropPolicy },
) {
  const existing = ANNOUNCE_QUEUES.get(key);
  if (existing) {
    existing.mode = settings.mode;
    existing.debounceMs =
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : existing.debounceMs;
    existing.cap =
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : existing.cap;
    existing.dropPolicy = settings.dropPolicy ?? existing.dropPolicy;
    return existing;
  }
  const created: AnnounceQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs: typeof settings.debounceMs === "number" ? Math.max(0, settings.debounceMs) : 1000,
    cap: typeof settings.cap === "number" && settings.cap > 0 ? Math.floor(settings.cap) : 20,
    dropPolicy: settings.dropPolicy ?? "summarize",
    droppedCount: 0,
    summaryLines: [],
  };
  ANNOUNCE_QUEUES.set(key, created);
  return created;
}

function elideText(text: string, limit = 140): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function buildQueueSummaryLine(item: AnnounceQueueItem): string {
  const base = item.summaryLine?.trim() || item.prompt.trim();
  const cleaned = base.replace(/\s+/g, " ").trim();
  return elideText(cleaned, 160);
}

function enqueueAnnounce(
  key: string,
  item: AnnounceQueueItem,
  settings: { mode: QueueMode; debounceMs?: number; cap?: number; dropPolicy?: QueueDropPolicy },
): boolean {
  const queue = getAnnounceQueue(key, settings);
  queue.lastEnqueuedAt = Date.now();

  const cap = queue.cap;
  if (cap > 0 && queue.items.length >= cap) {
    if (queue.dropPolicy === "new") {
      return false;
    }
    const dropCount = queue.items.length - cap + 1;
    const dropped = queue.items.splice(0, dropCount);
    if (queue.dropPolicy === "summarize") {
      for (const droppedItem of dropped) {
        queue.droppedCount += 1;
        queue.summaryLines.push(buildQueueSummaryLine(droppedItem));
      }
      while (queue.summaryLines.length > cap) queue.summaryLines.shift();
    }
  }

  const origin = normalizeDeliveryContext(item.origin);
  const originKey = deliveryContextKey(origin);
  queue.items.push({ ...item, origin, originKey });
  return true;
}

async function waitForQueueDebounce(queue: { debounceMs: number; lastEnqueuedAt: number }) {
  const debounceMs = Math.max(0, queue.debounceMs);
  if (debounceMs <= 0) return;
  while (true) {
    const since = Date.now() - queue.lastEnqueuedAt;
    if (since >= debounceMs) return;
    await new Promise((resolve) => setTimeout(resolve, debounceMs - since));
  }
}

function buildSummaryPrompt(queue: {
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
}): string | undefined {
  if (queue.dropPolicy !== "summarize" || queue.droppedCount <= 0) {
    return undefined;
  }
  const lines = [
    `[Queue overflow] Dropped ${queue.droppedCount} announce${queue.droppedCount === 1 ? "" : "s"} due to cap.`,
  ];
  if (queue.summaryLines.length > 0) {
    lines.push("Summary:");
    for (const line of queue.summaryLines) {
      lines.push(`- ${line}`);
    }
  }
  queue.droppedCount = 0;
  queue.summaryLines = [];
  return lines.join("\n");
}

function buildCollectPrompt(items: AnnounceQueueItem[], summary?: string): string {
  const blocks: string[] = ["[Queued announce messages while agent was busy]"];
  if (summary) blocks.push(summary);
  items.forEach((item, idx) => {
    blocks.push(`---\nQueued #${idx + 1}\n${item.prompt}`.trim());
  });
  return blocks.join("\n\n");
}

function hasCrossChannelItems(items: AnnounceQueueItem[]): boolean {
  const keys = new Set<string>();
  let hasUnkeyed = false;
  for (const item of items) {
    if (!item.origin) {
      hasUnkeyed = true;
      continue;
    }
    if (!item.originKey) {
      return true;
    }
    keys.add(item.originKey);
  }
  if (keys.size === 0) return false;
  if (hasUnkeyed) return true;
  return keys.size > 1;
}

function scheduleAnnounceDrain(key: string) {
  const queue = ANNOUNCE_QUEUES.get(key);
  if (!queue || queue.draining) return;
  queue.draining = true;
  void (async () => {
    try {
      let forceIndividualCollect = false;
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
        if (queue.mode === "collect") {
          if (forceIndividualCollect) {
            const next = queue.items.shift();
            if (!next) break;
            await sendAnnounce(next);
            continue;
          }
          const isCrossChannel = hasCrossChannelItems(queue.items);
          if (isCrossChannel) {
            forceIndividualCollect = true;
            const next = queue.items.shift();
            if (!next) break;
            await sendAnnounce(next);
            continue;
          }
          const items = queue.items.splice(0, queue.items.length);
          const summary = buildSummaryPrompt(queue);
          const prompt = buildCollectPrompt(items, summary);
          const last = items.at(-1);
          if (!last) break;
          await sendAnnounce({ ...last, prompt });
          continue;
        }

        const summaryPrompt = buildSummaryPrompt(queue);
        if (summaryPrompt) {
          const next = queue.items.shift();
          if (!next) break;
          await sendAnnounce({ ...next, prompt: summaryPrompt });
          continue;
        }

        const next = queue.items.shift();
        if (!next) break;
        await sendAnnounce(next);
      }
    } catch (err) {
      defaultRuntime.error?.(`announce queue drain failed for ${key}: ${String(err)}`);
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        ANNOUNCE_QUEUES.delete(key);
      } else {
        scheduleAnnounceDrain(key);
      }
    }
  })();
}

async function sendAnnounce(item: AnnounceQueueItem) {
  const origin = item.origin;
  await callGateway({
    method: "agent",
    params: {
      sessionKey: item.sessionKey,
      message: item.prompt,
      channel: origin?.channel,
      accountId: origin?.accountId,
      to: origin?.to,
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
  if (!raw) return raw;
  if (raw === "global" || raw === "unknown") return raw;
  if (raw.startsWith("agent:")) return raw;
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
  const legacyKey = canonicalKey.startsWith("agent:")
    ? canonicalKey.split(":").slice(2).join(":")
    : undefined;
  const entry =
    store[canonicalKey] ?? store[requesterSessionKey] ?? (legacyKey ? store[legacyKey] : undefined);
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
  if (!sessionId) return "none";

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: entry?.channel ?? entry?.lastChannel,
    sessionEntry: entry,
  });
  const isActive = isEmbeddedPiRunActive(sessionId);

  const shouldSteer = queueSettings.mode === "steer" || queueSettings.mode === "steer-backlog";
  if (shouldSteer) {
    const steered = queueEmbeddedPiMessage(sessionId, params.triggerMessage);
    if (steered) return "steered";
  }

  const shouldFollowup =
    queueSettings.mode === "followup" ||
    queueSettings.mode === "collect" ||
    queueSettings.mode === "steer-backlog" ||
    queueSettings.mode === "interrupt";
  if (isActive && (shouldFollowup || queueSettings.mode === "steer")) {
    const origin = resolveAnnounceOrigin(entry, params.requesterOrigin);
    enqueueAnnounce(
      canonicalKey,
      {
        prompt: params.triggerMessage,
        summaryLine: params.summaryLine,
        enqueuedAt: Date.now(),
        sessionKey: canonicalKey,
        origin,
      },
      queueSettings,
    );
    scheduleAnnounceDrain(canonicalKey);
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
  if (costText) parts.push(`est ${costText}`);
  parts.push(`sessionKey ${params.sessionKey}`);
  if (sessionId) parts.push(`sessionId ${sessionId}`);
  if (transcriptPath) parts.push(`transcript ${transcriptPath}`);

  return `Stats: ${parts.join(" \u2022 ")}`;
}

export function buildSubagentSystemPrompt(params: {
  requesterSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey: string;
  label?: string;
  task?: string;
}) {
  const taskText =
    typeof params.task === "string" && params.task.trim()
      ? params.task.replace(/\s+/g, " ").trim()
      : "{{TASK_DESCRIPTION}}";
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
    "When complete, your final response should include:",
    "- What you accomplished or found",
    "- Any relevant details the main agent should know",
    "- Keep it concise but informative",
    "",
    "## What You DON'T Do",
    "- NO user conversations (that's main agent's job)",
    "- NO external messages (email, tweets, etc.) unless explicitly tasked",
    "- NO cron jobs or persistent state",
    "- NO pretending to be the main agent",
    "- NO using the `message` tool directly",
    "",
    "## Session Context",
    params.label ? `- Label: ${params.label}` : undefined,
    params.requesterSessionKey ? `- Requester session: ${params.requesterSessionKey}.` : undefined,
    params.requesterOrigin?.channel
      ? `- Requester channel: ${params.requesterOrigin.channel}.`
      : undefined,
    `- Your session: ${params.childSessionKey}.`,
    "",
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
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
      const wait = (await callGateway({
        method: "agent.wait",
        params: {
          runId: params.childRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      })) as {
        status?: string;
        error?: string;
        startedAt?: number;
        endedAt?: number;
      };
      if (wait?.status === "timeout") {
        outcome = { status: "timeout" };
      } else if (wait?.status === "error") {
        outcome = { status: "error", error: wait.error };
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
        if (!outcome) outcome = { status: "timeout" };
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

    if (!outcome) outcome = { status: "unknown" };

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
    if (queued === "steered") {
      didAnnounce = true;
      return true;
    }
    if (queued === "queued") {
      didAnnounce = true;
      return true;
    }

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
        idempotencyKey: crypto.randomUUID(),
      },
      expectFinal: true,
      timeoutMs: 60_000,
    });

    didAnnounce = true;
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
