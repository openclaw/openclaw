import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { setActiveTask, completeTask, addAttentionItem } from "../telegram-ui/agent-state.js";
import { startEventRelay } from "../telegram-ui/event-relay.js";
import { setActiveChatId } from "../telegram-ui/telegram-push.js";

export function registerLifecycleHooks(api: OpenClawPluginApi) {
  // ── 啟動事件中繼（P0 核心：Agent 事件流 → Telegram 推送）──
  startEventRelay(api);

  // ── 從 inbound 訊息追蹤 chatId ──
  api.on("inbound_claim", async (event: unknown) => {
    const record = recordValue(event);
    // Telegram: conversationId 是 chat ID（群組或私聊都適用）
    // senderId 是用戶 ID（私聊時 = chatId，群組時 ≠ chatId）
    if (record?.channel === "telegram") {
      const chatId = asText(record.conversationId ?? record.senderId);
      if (chatId) {
        setActiveChatId(chatId);
      }
    }
  });

  // ── 基礎生命週期 hooks（保留為 event-relay 的 fallback）──

  api.on("agent_end", async (event: unknown) => {
    const record = recordValue(event);
    if (asBoolean(record?.success)) {
      completeTask(true);
    } else {
      completeTask(false);
      const errorRecord = recordValue(record?.error);
      const errorText = asText(errorRecord?.message ?? record?.error, "Agent 未知錯誤");
      addAttentionItem({
        id: `err-${Date.now()}`,
        kind: "error",
        title: errorText.slice(0, 200),
        urgency: "loud",
        createdAt: Date.now(),
        actionCallbacks: [
          { label: "🔍 查看", data: "sc:errlog" },
          { label: "🔄 重試", data: "sc:retry" },
        ],
      });
    }
  });

  api.on("before_tool_call", async (event: unknown) => {
    const record = recordValue(event);
    const toolName = asText(record?.toolName);
    if (toolName.includes("codex") || toolName.includes("code")) {
      setActiveTask({
        id: asText(record?.runId, `tool-${Date.now()}`),
        title: toolName,
        agent: "codex",
        phase: "coding",
        stepCurrent: 0,
        stepTotal: 1,
        currentAction: `執行 ${toolName}`,
        startedAt: Date.now(),
      });
    }
  });

  api.on("subagent_spawned", async (event: unknown) => {
    const record = recordValue(event);
    setActiveTask({
      id: asText(record?.runId, `sub-${Date.now()}`),
      title: "子 Agent 執行中",
      agent: "claude",
      phase: "thinking",
      stepCurrent: 0,
      stepTotal: 1,
      currentAction: "子 Agent 啟動",
      startedAt: Date.now(),
    });
  });

  api.on("subagent_ended", async (event: unknown) => {
    const record = recordValue(event);
    const outcome = asText(record?.outcome);
    if (outcome === "ok") {
      completeTask(true);
    } else if (outcome === "error" || outcome === "timeout") {
      completeTask(false);
      addAttentionItem({
        id: `sub-err-${Date.now()}`,
        kind: "error",
        title: `子 Agent ${outcome === "timeout" ? "逾時" : "錯誤"}`,
        urgency: "quiet",
        createdAt: Date.now(),
        actionCallbacks: [{ label: "🔍 查看", data: "sc:errlog" }],
      });
    } else {
      completeTask(true);
    }
  });

  api.on("cron_changed", async (event: unknown) => {
    const record = recordValue(event);
    if (record?.action === "finished") {
      const jobId = asText(record.jobId, "unknown");
      addAttentionItem({
        id: `cron-${jobId}-${Date.now()}`,
        kind: "task_done",
        title: `排程 ${jobId} 完成`,
        urgency: "silent",
        createdAt: Date.now(),
        actionCallbacks: [],
      });
    }
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}
