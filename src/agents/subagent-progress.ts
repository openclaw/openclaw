import type { DeliveryContext } from "../utils/delivery-context.js";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import { loadConfig } from "../config/config.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { defaultRuntime } from "../runtime.js";
import { maybeQueueSubagentAnnounce } from "./subagent-announce.js";
import { resolveToolDisplay, formatToolSummary } from "./tool-display.js";
import { normalizeToolName } from "./tool-policy.js";

export type SubagentProgressConfig = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  label?: string;
  /** Channel status message minimum interval (ms). default: 5000 */
  channelThrottleMs?: number;
  /** Parent agent intermediate report interval (ms). default: 30000 */
  parentReportIntervalMs?: number;
};

type ToolUsageEntry = {
  name: string;
  count: number;
};

type ProgressState = {
  toolCounts: Map<string, number>;
  currentTool: string | undefined;
  currentDetail: string | undefined;
  lastChannelSendAt: number;
  lastParentReportAt: number;
  startedAt: number;
};

function buildToolSummaryLine(toolName: string, args: unknown): string {
  const display = resolveToolDisplay({ name: toolName, args });
  return formatToolSummary(display);
}

function buildParentProgressMessage(config: SubagentProgressConfig, state: ProgressState): string {
  const label = config.label || config.childSessionKey;
  const toolEntries: ToolUsageEntry[] = [];
  for (const [name, count] of state.toolCounts.entries()) {
    toolEntries.push({ name, count });
  }
  const toolsUsedLine =
    toolEntries.length > 0
      ? toolEntries.map((e) => `${e.name} (${e.count})`).join(", ")
      : "none yet";

  const elapsedMs = Date.now() - state.startedAt;
  const elapsedSec = Math.round(elapsedMs / 1000);

  const currentLine = state.currentTool
    ? `Currently: ${state.currentDetail || state.currentTool}`
    : "Idle";

  return [
    `Subagent "${label}" progress update:`,
    `- Tools used so far: ${toolsUsedLine}`,
    `- ${currentLine}`,
    `- Elapsed: ${elapsedSec}s`,
    "",
    "Briefly update the user on the subagent's progress. One sentence max.",
  ].join("\n");
}

export function subscribeSubagentProgress(config: SubagentProgressConfig): () => void {
  const channelThrottleMs = config.channelThrottleMs ?? 5_000;
  const parentReportIntervalMs = config.parentReportIntervalMs ?? 30_000;

  const state: ProgressState = {
    toolCounts: new Map(),
    currentTool: undefined,
    currentDetail: undefined,
    lastChannelSendAt: 0,
    lastParentReportAt: Date.now(),
    startedAt: Date.now(),
  };

  let parentReportTimer: NodeJS.Timeout | null = null;

  function scheduleParentReport() {
    if (parentReportTimer) {
      return;
    }
    parentReportTimer = setTimeout(() => {
      parentReportTimer = null;
      void relayToParent();
    }, parentReportIntervalMs);
    parentReportTimer.unref?.();
  }

  async function relayToChannel(message: string) {
    if (!config.requesterOrigin?.channel || !config.requesterOrigin?.to) {
      return;
    }
    const now = Date.now();
    if (now - state.lastChannelSendAt < channelThrottleMs) {
      return;
    }
    state.lastChannelSendAt = now;

    try {
      await routeReply({
        payload: { text: message },
        channel: config.requesterOrigin.channel,
        to: config.requesterOrigin.to,
        sessionKey: config.requesterSessionKey,
        threadId: config.requesterOrigin.threadId,
        cfg: loadConfig(),
      });
    } catch (err) {
      defaultRuntime.log(
        `[subagent-progress] channel relay failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function relayToParent() {
    const summary = buildParentProgressMessage(config, state);
    state.lastParentReportAt = Date.now();

    try {
      const queued = await maybeQueueSubagentAnnounce({
        requesterSessionKey: config.requesterSessionKey,
        triggerMessage: summary,
        summaryLine: `${config.label || "subagent"}: progress`,
        requesterOrigin: config.requesterOrigin,
      });
      defaultRuntime.log(
        `[subagent-progress] parent report: queued=${queued} runId=${config.runId}`,
      );
    } catch (err) {
      defaultRuntime.log(
        `[subagent-progress] parent relay failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const stopListener = onAgentEvent((evt) => {
    if (!evt || evt.stream !== "tool") {
      return;
    }
    const matchesRun = evt.runId === config.runId;
    const matchesSession = evt.sessionKey === config.childSessionKey;
    if (!matchesRun && !matchesSession) {
      return;
    }

    const phase = evt.data?.phase;
    const rawName = typeof evt.data?.name === "string" ? evt.data.name : undefined;
    if (!rawName) {
      return;
    }
    const toolName = normalizeToolName(rawName);

    if (phase === "start") {
      // Track tool usage count
      state.toolCounts.set(toolName, (state.toolCounts.get(toolName) ?? 0) + 1);
      state.currentTool = toolName;

      // Build human-readable summary
      const summaryLine = buildToolSummaryLine(toolName, evt.data?.args);
      state.currentDetail = summaryLine;

      defaultRuntime.log(`[subagent-progress] ${summaryLine} (runId=${config.runId})`);

      // Relay to channel (throttled)
      void relayToChannel(summaryLine);

      // Schedule parent report if not already scheduled
      scheduleParentReport();
    } else if (phase === "result") {
      const isError = Boolean(evt.data?.isError);
      if (isError) {
        const errorLine = `❌ Tool failed: ${toolName}`;
        defaultRuntime.log(`[subagent-progress] ${errorLine} (runId=${config.runId})`);
        void relayToChannel(errorLine);
      }
      state.currentTool = undefined;
      state.currentDetail = undefined;
    }
  });

  return () => {
    stopListener();
    if (parentReportTimer) {
      clearTimeout(parentReportTimer);
      parentReportTimer = null;
    }
  };
}
