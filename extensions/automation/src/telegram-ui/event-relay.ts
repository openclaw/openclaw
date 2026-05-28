/**
 * event-relay.ts — Agent 事件流 → Telegram 推送
 *
 * 訂閱 runtime.events.onAgentEvent，將 agent 事件轉換為：
 * 1. agent-state.ts 的狀態更新（讓 Dashboard 即時反映）
 * 2. Telegram 推送通知（依 notification tier 分級）
 * 3. 即時進度更新（用 editMessage 更新同一條訊息）
 *
 * 事件流分類：
 * - lifecycle: agent 啟動/結束
 * - item: 工具呼叫、命令執行、檔案修改等工作項目
 * - approval: 執行確認請求（最重要！需要人類介入）
 * - error: 錯誤
 * - thinking: 思考過程
 * - plan: 執行計畫
 * - patch: 檔案修改摘要
 * - command_output: 命令輸出
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  setActiveTask,
  completeTask,
  updateTaskProgress,
  addAttentionItem,
  updateSystemState,
  getSystemState,
  type AgentPhase,
} from "./agent-state.js";
import {
  classifyNotificationTier,
  formatNotificationMessage,
  shouldSendNewMessage,
  shouldNotifyWithSound,
} from "./notification.js";
import { pushMessage, editMessage, setReaction, getActiveChatId } from "./telegram-push.js";

// ── 型別（對應 agent-events.ts 的 payload） ──────────────────────

type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

type AgentEventSource = {
  runtime?: {
    events?: {
      onAgentEvent?: (handler: (evt: AgentEventPayload) => void) => () => void;
    };
  };
};

// ── 進度追蹤狀態 ─────────────────────────────────────────────────

type ActiveProgressMessage = {
  chatId: string | number;
  messageId: number;
  runId: string;
  lastUpdatedAt: number;
  itemCount: number;
};

/** 目前進行中的進度訊息（每個 runId 一條） */
const progressMessages = new Map<string, ActiveProgressMessage>();

/** 進度更新節流 — 避免 Telegram API rate limit（最少間隔 2 秒） */
const PROGRESS_UPDATE_THROTTLE_MS = 2000;

/** 取得 runId 對應的進度訊息 */
export function getProgressMessage(runId: string): ActiveProgressMessage | undefined {
  return progressMessages.get(runId);
}

// ── 主要事件處理器 ────────────────────────────────────────────────

let unsubscribe: (() => void) | null = null;
/**
 * 啟動事件中繼。
 * 在 registerLifecycleHooks 中呼叫，訂閱 onAgentEvent。
 */
export function startEventRelay(api: OpenClawPluginApi) {
  if (unsubscribe) {
    return;
  }

  const onEvent = (api as OpenClawPluginApi & AgentEventSource).runtime?.events?.onAgentEvent;
  if (typeof onEvent !== "function") {
    console.warn("[event-relay] runtime.events.onAgentEvent 不可用，跳過事件中繼");
    return;
  }

  unsubscribe = onEvent((evt: AgentEventPayload) => {
    // 非同步處理，不阻塞事件流
    handleAgentEvent(api, evt).catch((err) => {
      console.error("[event-relay] 處理事件錯誤:", err);
    });
  });
}

/** 停止事件中繼。 */
export function stopEventRelay() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  progressMessages.clear();
}

// ── 事件分派 ──────────────────────────────────────────────────────

async function handleAgentEvent(api: OpenClawPluginApi, evt: AgentEventPayload) {
  const { stream, data, runId } = evt;

  switch (stream) {
    case "lifecycle":
      await handleLifecycleEvent(api, runId, data);
      break;
    case "item":
      await handleItemEvent(api, runId, data);
      break;
    case "approval":
      await handleApprovalEvent(api, runId, data);
      break;
    case "error":
      await handleErrorEvent(api, runId, data);
      break;
    case "thinking":
      handleThinkingEvent(data);
      break;
    case "plan":
      await handlePlanEvent(api, runId, data);
      break;
    case "patch":
      await handlePatchEvent(api, runId, data);
      break;
    case "command_output":
      // 命令輸出太頻繁，只更新內部狀態不推送
      handleCommandOutputEvent(data);
      break;
    default:
      break;
  }
}

// ── Lifecycle 事件 ─────────────────────────────────────────────────

async function handleLifecycleEvent(
  api: OpenClawPluginApi,
  runId: string,
  data: Record<string, unknown>,
) {
  const phase = asText(data.phase);

  if (phase === "start" || phase === "running") {
    setActiveTask({
      id: runId,
      title: asText(data.title, "智能體執行中"),
      agent: "claude",
      phase: "thinking",
      stepCurrent: 0,
      stepTotal: 0,
      currentAction: "啟動中...",
      startedAt: Date.now(),
    });

    const chatId = getActiveChatId();
    if (chatId) {
      const sent = await pushMessage(api, {
        chatId,
        text: "🔄 <b>智能體開始執行</b>\n\n<i>初始化中...</i>",
        silent: true,
      });
      if (sent) {
        progressMessages.set(runId, {
          chatId,
          messageId: sent.messageId,
          runId,
          lastUpdatedAt: Date.now(),
          itemCount: 0,
        });
      }
    }
  } else if (phase === "end" || phase === "completed") {
    const success = data.status !== "error" && data.status !== "failed";
    completeTask(success);

    // 更新進度訊息為完成狀態
    const progress = progressMessages.get(runId);
    if (progress) {
      const summary = asText(data.summary, success ? "執行完成" : "執行失敗");
      const emoji = success ? "✅" : "❌";
      await editMessage(api, {
        chatId: progress.chatId,
        messageId: progress.messageId,
        text: `${emoji} <b>${escapeHtml(summary)}</b>`,
        buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
      });
      await setReaction(api, progress.chatId, progress.messageId, success ? "👍" : "👎");
      progressMessages.delete(runId);
    } else {
      const chatId = getActiveChatId();
      if (chatId) {
        const tier = classifyNotificationTier(success ? "task_complete" : "task_error", {
          isError: !success,
        });
        const formatted = formatNotificationMessage({
          id: `lifecycle-${runId}`,
          tier,
          title: success ? "任務完成" : "任務失敗",
          body: escapeHtml(asText(data.summary, success ? "執行完成" : "執行失敗").slice(0, 300)),
          source: "event-relay",
          timestamp: Date.now(),
        });
        if (shouldSendNewMessage(tier)) {
          await pushMessage(api, {
            chatId,
            text: formatted.text,
            silent: !shouldNotifyWithSound(tier),
            buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
          });
        }
      }
    }
  }
}

// ── Item 事件（工具呼叫、命令執行等）─────────────────────────────

async function handleItemEvent(
  api: OpenClawPluginApi,
  runId: string,
  data: Record<string, unknown>,
) {
  const phase = asText(data.phase);
  const kind = asText(data.kind);
  const title = asText(data.title);

  // 推斷 AgentPhase
  const agentPhase = inferPhaseFromKind(kind);

  if (phase === "start") {
    updateTaskProgress(getSystemState().activeTask?.stepCurrent ?? 0, title || `${kind} 執行中`);
    updateSystemState({ phase: agentPhase });
  } else if (phase === "end") {
    const progress = progressMessages.get(runId);
    if (progress) {
      progress.itemCount++;
    }
  }

  // 即時更新進度訊息（節流）
  await throttledProgressUpdate(api, runId, data);
}

// ── Approval 事件（最重要！）──────────────────────────────────────

async function handleApprovalEvent(
  api: OpenClawPluginApi,
  runId: string,
  data: Record<string, unknown>,
) {
  const phase = asText(data.phase);
  const approvalId = asText(data.approvalId ?? data.itemId);
  const title = asText(data.title, "執行確認");
  const command = optionalText(data.command);
  const kind = asText(data.kind, "exec");

  if (phase === "requested") {
    // 更新系統狀態
    updateSystemState({ phase: "awaiting_input" });

    // 截斷 approvalId 確保 callback_data 不超過 64 bytes
    const safeId = approvalId.slice(0, 40);
    const approveData = `sc:approve:${safeId}`;
    const denyData = `sc:deny:${safeId}`;

    // 加入 attention item
    addAttentionItem({
      id: `approval-${safeId}`,
      kind: "approval",
      title: `⚠️ ${title}`,
      urgency: "loud",
      createdAt: Date.now(),
      actionCallbacks: [
        { label: "✅ 批准", data: approveData },
        { label: "❌ 拒絕", data: denyData },
      ],
    });

    // 推送 loud 通知到 Telegram
    const chatId = getActiveChatId();
    if (chatId) {
      const lines = [`🔔 <b>需要確認</b>\n`];
      lines.push(`<b>${escapeHtml(title)}</b>`);
      if (command) {
        lines.push(`\n<code>${escapeHtml(command.slice(0, 300))}</code>`);
      }
      lines.push(`\n類型: ${escapeHtml(kind)}`);

      const tier = classifyNotificationTier("approval_needed", { needsHumanInput: true });
      const formatted = formatNotificationMessage({
        id: `approval-${safeId}`,
        tier,
        title: "需要確認",
        body: lines.join("\n"),
        source: "event-relay",
        timestamp: Date.now(),
      });
      if (!shouldSendNewMessage(tier)) {
        return;
      }

      await pushMessage(api, {
        chatId,
        text: formatted.text,
        silent: !shouldNotifyWithSound(tier),
        buttons: [
          [
            { text: "✅ 批准", callback_data: approveData },
            { text: "❌ 拒絕", callback_data: denyData },
          ],
          [{ text: "📋 詳情", callback_data: `sc:detail` }],
        ],
      });
    }
  } else if (phase === "resolved") {
    const status = asText(data.status);
    const resolvedOk = status === "approved";

    // 從 attention items 移除
    // （callback-router 的 approve/deny handler 已經會處理）

    if (!resolvedOk) {
      updateSystemState({ phase: "idle" });
    }
  }
}

// ── Error 事件 ─────────────────────────────────────────────────────

async function handleErrorEvent(
  api: OpenClawPluginApi,
  runId: string,
  data: Record<string, unknown>,
) {
  const message = asText(data.message ?? data.error, "未知錯誤");

  addAttentionItem({
    id: `err-${runId}-${Date.now()}`,
    kind: "error",
    title: message.slice(0, 200),
    urgency: "loud",
    createdAt: Date.now(),
    actionCallbacks: [
      { label: "🔍 查看", data: "sc:errlog" },
      { label: "🔄 重試", data: "sc:retry" },
    ],
  });

  const chatId = getActiveChatId();
  if (chatId) {
    const tier = classifyNotificationTier("task_error", { isError: true });
    const formatted = formatNotificationMessage({
      id: `err-${runId}`,
      tier,
      title: "Agent 錯誤",
      body: `<code>${escapeHtml(message.slice(0, 500))}</code>`,
      source: "event-relay",
      timestamp: Date.now(),
    });
    if (!shouldSendNewMessage(tier)) {
      return;
    }
    await pushMessage(api, {
      chatId,
      text: formatted.text,
      silent: !shouldNotifyWithSound(tier),
      buttons: [
        [
          { text: "🔄 重試", callback_data: "sc:retry" },
          { text: "← 首頁", callback_data: "sc:home" },
        ],
      ],
    });
  }
}

// ── Thinking 事件 ──────────────────────────────────────────────────

function handleThinkingEvent(data: Record<string, unknown>) {
  const text = asText(data.text ?? data.content);
  if (text) {
    updateTaskProgress(
      getSystemState().activeTask?.stepCurrent ?? 0,
      "思考中...",
      text.slice(0, 100),
    );
  }
}

// ── Plan 事件 ──────────────────────────────────────────────────────

async function handlePlanEvent(
  api: OpenClawPluginApi,
  runId: string,
  data: Record<string, unknown>,
) {
  const title = asText(data.title, "執行計畫");
  const steps = Array.isArray(data.steps) ? data.steps : [];

  updateTaskProgress(0, `計畫: ${title}`);

  // 計畫更新 — quiet 通知
  const progress = progressMessages.get(runId);
  if (progress && steps.length > 0) {
    const stepsText = steps
      .slice(0, 8)
      .map((s, i) => `  ${i + 1}. ${escapeHtml(asText(s).slice(0, 60))}`)
      .join("\n");
    const extra = steps.length > 8 ? `\n  ... 還有 ${steps.length - 8} 步` : "";

    await editMessage(api, {
      chatId: progress.chatId,
      messageId: progress.messageId,
      text: `🧠 <b>${escapeHtml(title)}</b>\n\n${stepsText}${extra}\n\n<i>執行中...</i>`,
    });
  }
}

// ── Patch 事件（檔案修改摘要）──────────────────────────────────────

async function handlePatchEvent(
  api: OpenClawPluginApi,
  runId: string,
  data: Record<string, unknown>,
) {
  const added = Array.isArray(data.added) ? data.added : [];
  const modified = Array.isArray(data.modified) ? data.modified : [];
  const deleted = Array.isArray(data.deleted) ? data.deleted : [];
  const summary = asText(data.summary);

  const total = added.length + modified.length + deleted.length;
  if (total === 0) {
    return;
  }

  updateTaskProgress(getSystemState().activeTask?.stepCurrent ?? 0, `修改 ${total} 個檔案`);

  // 更新進度訊息
  const progress = progressMessages.get(runId);
  if (progress) {
    const lines = [`📝 <b>檔案變更</b>\n`];
    if (added.length) {
      lines.push(`  ➕ 新增: ${added.length} 個`);
    }
    if (modified.length) {
      lines.push(`  ✏️ 修改: ${modified.length} 個`);
    }
    if (deleted.length) {
      lines.push(`  🗑 刪除: ${deleted.length} 個`);
    }
    if (summary) {
      lines.push(`\n${escapeHtml(summary.slice(0, 200))}`);
    }

    await throttledEdit(api, progress, lines.join("\n"));
  }
}

// ── Command Output 事件 ────────────────────────────────────────────

function handleCommandOutputEvent(data: Record<string, unknown>) {
  const title = asText(data.title);
  if (title) {
    updateTaskProgress(getSystemState().activeTask?.stepCurrent ?? 0, title);
  }
}

// ── 節流進度更新 ──────────────────────────────────────────────────

async function throttledProgressUpdate(
  api: OpenClawPluginApi,
  runId: string,
  data: Record<string, unknown>,
) {
  const progress = progressMessages.get(runId);
  if (!progress) {
    return;
  }

  const now = Date.now();
  if (now - progress.lastUpdatedAt < PROGRESS_UPDATE_THROTTLE_MS) {
    return;
  }

  const state = getSystemState();
  const task = state.activeTask;
  if (!task) {
    return;
  }

  const title = asText(data.title ?? task.currentAction);
  const kind = asText(data.kind);
  const phase = asText(data.phase);
  const statusEmoji = phase === "end" ? "✅" : "🔄";

  const lines = [`🔄 <b>Agent 執行中</b>\n`];
  if (task.thinkingLine) {
    lines.push(`💭 <i>${escapeHtml(task.thinkingLine)}</i>\n`);
  }
  lines.push(`${statusEmoji} ${escapeHtml(title || kind)}`);
  if (progress.itemCount > 0) {
    lines.push(`\n📊 已完成 ${progress.itemCount} 個步驟`);
  }

  await throttledEdit(api, progress, lines.join("\n"));
}

async function throttledEdit(
  api: OpenClawPluginApi,
  progress: ActiveProgressMessage,
  text: string,
) {
  const now = Date.now();
  if (now - progress.lastUpdatedAt < PROGRESS_UPDATE_THROTTLE_MS) {
    return;
  }

  progress.lastUpdatedAt = now;
  await editMessage(api, {
    chatId: progress.chatId,
    messageId: progress.messageId,
    text,
  });
}

// ── 輔助 ──────────────────────────────────────────────────────────

function inferPhaseFromKind(kind: string): AgentPhase {
  switch (kind) {
    case "tool":
    case "search":
      return "thinking";
    case "command":
      return "coding";
    case "patch":
      return "coding";
    case "analysis":
      return "reviewing";
    default:
      return "thinking";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function optionalText(value: unknown): string | undefined {
  const text = asText(value);
  return text ? text : undefined;
}
