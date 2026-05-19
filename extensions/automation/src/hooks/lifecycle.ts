import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  setActiveTask,
  completeTask,
  addAttentionItem,
} from "../telegram-ui/agent-state.js";

export function registerLifecycleHooks(api: OpenClawPluginApi) {
  api.on("agent_end", async (event: any) => {
    if (event.success) {
      completeTask(true);
    } else {
      completeTask(false);
      addAttentionItem({
        id: `err-${Date.now()}`,
        kind: "error",
        title: event.error?.slice(0, 200) ?? "Agent 未知錯誤",
        urgency: "loud",
        createdAt: Date.now(),
        actionCallbacks: [
          { label: "🔍 查看", data: "sc:errlog" },
          { label: "🔄 重試", data: "sc:retry" },
        ],
      });
    }
  });

  api.on("before_tool_call", async (event: any) => {
    const toolName: string = event.toolName ?? "";
    if (toolName.includes("codex") || toolName.includes("code")) {
      setActiveTask({
        id: event.runId ?? `tool-${Date.now()}`,
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

  api.on("subagent_spawned", async (event: any) => {
    setActiveTask({
      id: event.runId ?? `sub-${Date.now()}`,
      title: "子 Agent 執行中",
      agent: "claude",
      phase: "thinking",
      stepCurrent: 0,
      stepTotal: 1,
      currentAction: "子 Agent 啟動",
      startedAt: Date.now(),
    });
  });

  api.on("subagent_ended", async (event: any) => {
    if (event.outcome === "ok") {
      completeTask(true);
    } else if (event.outcome === "error" || event.outcome === "timeout") {
      completeTask(false);
      addAttentionItem({
        id: `sub-err-${Date.now()}`,
        kind: "error",
        title: `子 Agent ${event.outcome === "timeout" ? "逾時" : "錯誤"}`,
        urgency: "quiet",
        createdAt: Date.now(),
        actionCallbacks: [
          { label: "🔍 查看", data: "sc:errlog" },
        ],
      });
    } else {
      completeTask(true);
    }
  });

  api.on("cron_changed", async (event: any) => {
    if (event.action === "finished") {
      addAttentionItem({
        id: `cron-${event.jobId}-${Date.now()}`,
        kind: "task_done",
        title: `排程 ${event.jobId} 完成`,
        urgency: "silent",
        createdAt: Date.now(),
        actionCallbacks: [],
      });
    }
  });
}
