import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CIStatus } from "../devops/ci-monitor.js";
import { callGatewayCompat, getGatewayRPC, type GatewaySessionInfo } from "../gateway-rpc.js";
import {
  checkRateLimit,
  getActionPermission,
  isAllowedUser,
  isOwnerUser,
  loadPermissionConfigFromEnv,
} from "../security/permission-manager.js";
import { assessRisk, requiresBiometric, requiresConfirmation } from "../security/risk-assessor.js";
import { WORKFLOW_TEMPLATES, type WorkflowDefinition } from "../tools/workflow-types.js";
import { buildAgentPanel, buildResetConfirm } from "./agent-panel.js";
import {
  getSystemState,
  completeTask,
  dismissAttentionItem,
  setActiveTask,
  updateTaskProgress,
} from "./agent-state.js";
import { buildCronPanel, buildCronRunPicker, buildCronRunResult } from "./cron-panel.js";
import { buildDashboard } from "./dashboard.js";
import { buildDevOpsPanel, buildPRListPanel, buildDeployConfirm } from "./devops-panel.js";
import { buildInteractiveErrorHtml } from "./error-format.js";
import { buildModelPanel, buildModelSwitchResult } from "./model-panel.js";
import { buildMorePanel } from "./more-panel.js";
import { createSubscriptionInvoice } from "./payments.js";
import { buildProPanel } from "./pro-panel.js";
import {
  resolveTelegramAuthBadge,
  resolveTelegramProSource,
  resolveTelegramProStatus,
} from "./pro-status.js";
import { formatProgressMessage, type ProgressStep } from "./progress-updater.js";
import {
  buildSessionActionResult,
  buildSessionDeleteConfirmPanel,
  buildSessionDetailPanel,
  buildSessionPanel,
  type SessionDetailItem,
} from "./session-panel.js";
import {
  buildTaskAwaitingInput,
  buildTaskComplete,
  buildTaskError,
  buildTaskRoot,
} from "./task-thread.js";
import { isTelegramMessageNotModifiedText } from "./telegram-not-modified.js";
import {
  setActiveChatId,
  getActiveChatId,
  pushMessage as pushTelegramMessage,
  editMessage as editTelegramMessage,
} from "./telegram-push.js";
import { TRADING_BUTTON_COPY } from "./trading-copy.js";
import {
  buildTradingPanel,
  buildAiTradingPlatformPanel,
  buildFastOrderIntentWritePanel,
  buildFastOrderIntentReviewPanel,
  buildFastOrderAuditTrailPanel,
  buildPaperOrderPanel,
  buildQuoteDetailPanel,
  buildStrategyPanel,
  buildLearningSummaryPanel,
  buildCapitalServiceStatusPanel,
  buildCapitalDirectOperationPanel,
  buildCapitalLocalExecutorDispatchPanel,
  buildCapitalLiveExecutorArmProfilePanel,
  buildCapitalPaperAssistantPanel,
  buildOkxStatusPanel,
  buildOkxOrderProposalPanel,
  buildOkxOrderStatusPanel,
  type TradingState,
  type QuoteStatus,
  type TradingSnapshotPanelState,
  type TradingFastOrderIntentWriteState,
  type TradingFastOrderIntentReviewState,
  type TradingFastOrderAuditSnapshotState,
  type StrategyPanelState,
  type TelegramTradingShortcutsSummaryState,
  type CapitalServiceStatusState,
  type CapitalDirectOperationState,
  type CapitalLocalExecutorDispatchState,
  type CapitalLiveExecutorArmProfileState,
  type CapitalPaperAssistantState,
  type OkxGateState,
  type OkxOrderProposalGateState,
  type OkxOrderStatusGateState,
} from "./trading-panel.js";
import type { InteractiveReply, PanelButton } from "./types.js";
import { trackAction, setUserMode } from "./user-state.js";
import { buildWorkflowList } from "./workflow-panel.js";

const NAMESPACE = "sc";

/** callback_data 最大 64 bytes（Telegram 限制） */
const CALLBACK_DATA_MAX_BYTES = 64;

/** RPC 呼叫逾時保護（避免卡住 callback handler） */
const RPC_TIMEOUT_MS = 8_000;

const LEGACY_TELEGRAM_BUTTON_LABEL_MAP: Array<[RegExp, string]> = [
  [/\bWorkfl(?:ow)?\b(?:\.\.\.)?/gi, "工作流程"],
  [/\bDevOp(?:s)?\b(?:\.\.\.)?/gi, "維運"],
  [/\bAgen(?:t)?\b(?:\.\.\.)?/gi, "智能體"],
  [/\bSess(?:ion)?\b(?:\.\.\.)?/gi, "工作階段"],
  [/\bMod(?:el)?\b(?:\.\.\.)?/gi, "模型"],
  [/\bDash(?:board)?\b(?:\.\.\.)?/gi, "儀表板"],
  [/\bMor(?:e)?\b(?:\.\.\.)?/gi, "更多功能"],
  [/\bCodex\b(?:\.\.\.)?/gi, "寫碼"],
];

type TelegramButton = {
  text: string;
  callback_data: string;
};

type TelegramMessage = {
  text: string;
  buttons?: TelegramButton[][];
  textMode?: string;
};

type TelegramResponder = {
  editMessage: (message: TelegramMessage) => Promise<void>;
  reply: (message: TelegramMessage) => Promise<void>;
};

type CallbackRouterContext = {
  senderId?: number | string;
  callback: { payload: string };
  respond: TelegramResponder;
};

type RawInteractiveContext = {
  callback?: { chatId?: unknown };
  conversationId?: unknown;
  senderId?: unknown;
};

type SubagentRuntime = {
  run: (params: { sessionKey: string; message: string; deliver: boolean }) => Promise<{
    runId: string;
  }>;
  waitForRun: (params: { runId: string; timeoutMs: number }) => Promise<
    | { status: "ok" }
    | { status: "timeout" }
    | {
        status: "error";
        error?: string;
      }
  >;
  getSessionMessages: (params: { sessionKey: string; limit: number }) => Promise<{
    messages: unknown[];
  }>;
  deleteSession: (params: { sessionKey: string }) => Promise<void>;
};

type OpenClawPluginApiWithRuntime = OpenClawPluginApi & {
  runtime?: {
    subagent?: Partial<SubagentRuntime>;
  };
};

type PullRequestInfo = {
  number: number;
  title: string;
  state: string;
  draft: boolean;
};

/** 已處理的 approval ID 集合（防止重複點擊） */
const handledApprovals = new Set<string>();

/** 清理過期的 approval 記錄（超過 10 分鐘） */
const approvalTimestamps = new Map<string, number>();
function trackApproval(id: string) {
  handledApprovals.add(id);
  approvalTimestamps.set(id, Date.now());
  // 清理過期記錄
  const cutoff = Date.now() - 600_000;
  for (const [key, ts] of approvalTimestamps) {
    if (ts < cutoff) {
      handledApprovals.delete(key);
      approvalTimestamps.delete(key);
    }
  }
}

/** RPC 呼叫加逾時保護 */
function withTimeout<T>(promise: Promise<T>, ms = RPC_TIMEOUT_MS, label = "RPC"): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 逾時 (${ms}ms)`)), ms),
    ),
  ]);
}

/** 驗證 callback_data 是否在 64 bytes 限制內 */
function validateCallbackData(data: string): boolean {
  return new TextEncoder().encode(data).length <= CALLBACK_DATA_MAX_BYTES;
}

export function normalizeLegacyTelegramButtonLabel(label: string): string {
  let normalized = label;
  for (const [pattern, localized] of LEGACY_TELEGRAM_BUTTON_LABEL_MAP) {
    normalized = normalized.replace(pattern, localized);
  }
  const cleaned = normalized.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "操作";
}

function normalizeTelegramButtons(buttons: TelegramButton[][]): TelegramButton[][] {
  return buttons.map((row) =>
    row.map((btn) => ({
      text: normalizeLegacyTelegramButtonLabel(btn.text),
      callback_data: btn.callback_data,
    })),
  );
}

function resolveSubagentRuntime(api: OpenClawPluginApi): SubagentRuntime | null {
  const subagent = (api as OpenClawPluginApiWithRuntime).runtime?.subagent;
  if (
    typeof subagent?.run === "function" &&
    typeof subagent.waitForRun === "function" &&
    typeof subagent.getSessionMessages === "function" &&
    typeof subagent.deleteSession === "function"
  ) {
    return subagent as SubagentRuntime;
  }
  return null;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (value.role === "assistant" || value.from === "assistant");
}

function extractMessageText(value: Record<string, unknown>): string {
  const content = value.content ?? value.text ?? "";
  return typeof content === "string" ? content : JSON.stringify(content);
}

function isMessageDeliveryFailureWarning(text: string | undefined): boolean {
  const normalized = text?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /^(?:(?:[-*•>\u25e6]|\d+[.)])\s*)?⚠️\s*✉️\s*message failed(?:\s*:.*)?$/i.test(normalized);
}

function sanitizeSubagentSummaryText(text: string): string {
  if (!text.trim()) {
    return "";
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isMessageDeliveryFailureWarning(line))
    .join("\n");
}

function parseTelegramUserId(senderId: string | number | undefined): number | undefined {
  if (typeof senderId === "number" && Number.isFinite(senderId)) {
    return senderId;
  }
  if (typeof senderId !== "string") {
    return undefined;
  }
  const matched = senderId.match(/-?\d+/);
  if (!matched) {
    return undefined;
  }
  const parsed = Number(matched[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type SessionTokenEntry = {
  key: string;
  detail: SessionDetailItem;
  createdAt: number;
};

const SESSION_TOKEN_TTL_MS = 15 * 60 * 1000;
const sessionTokenEntries = new Map<string, SessionTokenEntry>();
const TELEGRAM_EDIT_NOOP_CACHE_TTL_MS = 15_000;
const telegramEditNoopCache = new Map<string, { signature: string; updatedAt: number }>();

function buildTelegramEditNoopSignature(message: TelegramMessage): string {
  const rows = (message.buttons ?? [])
    .map((row) => row.map((btn) => `${btn.text}\u0000${btn.callback_data}`).join("\u0001"))
    .join("\u0002");
  return `${message.textMode ?? ""}\u0003${message.text}\u0003${rows}`;
}

function pruneTelegramEditNoopCache(now = Date.now()): void {
  const cutoff = now - TELEGRAM_EDIT_NOOP_CACHE_TTL_MS;
  for (const [key, entry] of telegramEditNoopCache.entries()) {
    if (entry.updatedAt < cutoff) {
      telegramEditNoopCache.delete(key);
    }
  }
}

function isRecentTelegramEditNoop(cacheKey: string, signature: string): boolean {
  pruneTelegramEditNoopCache();
  const entry = telegramEditNoopCache.get(cacheKey);
  return entry?.signature === signature;
}

function rememberTelegramEditNoop(cacheKey: string, signature: string): void {
  telegramEditNoopCache.set(cacheKey, { signature, updatedAt: Date.now() });
}

export function resetTelegramEditNoopCacheForTests(): void {
  telegramEditNoopCache.clear();
}

function pruneSessionTokenEntries(now = Date.now()): void {
  const cutoff = now - SESSION_TOKEN_TTL_MS;
  for (const [token, entry] of sessionTokenEntries.entries()) {
    if (entry.createdAt < cutoff) {
      sessionTokenEntries.delete(token);
    }
  }
}

function createSessionToken(detail: SessionDetailItem): string {
  pruneSessionTokenEntries();
  for (const [token, entry] of sessionTokenEntries.entries()) {
    if (entry.key === detail.key) {
      sessionTokenEntries.set(token, {
        ...entry,
        detail,
        createdAt: Date.now(),
      });
      return token;
    }
  }
  let token = "";
  do {
    token = `${Math.random().toString(36).slice(2, 6)}${Date.now().toString(36).slice(-2)}`;
  } while (sessionTokenEntries.has(token));
  sessionTokenEntries.set(token, {
    key: detail.key,
    detail,
    createdAt: Date.now(),
  });
  return token;
}

function resolveSessionDetailByToken(token: string | undefined): SessionDetailItem | null {
  if (!token) {
    return null;
  }
  pruneSessionTokenEntries();
  const found = sessionTokenEntries.get(token);
  if (!found) {
    return null;
  }
  found.createdAt = Date.now();
  sessionTokenEntries.set(token, found);
  return found.detail;
}

function toSessionDetailItem(session: GatewaySessionInfo): SessionDetailItem {
  return {
    token: "",
    key: session.key,
    displayName: session.displayName,
    label: session.label,
    modelProvider: session.modelProvider,
    model: session.model,
    totalTokens: session.totalTokens,
    spawnedBy: session.spawnedBy,
    updatedAt: session.updatedAt,
    hasActiveRun: session.hasActiveRun,
  };
}

function buildSessionPanelFromGatewaySessions(sessions: GatewaySessionInfo[]) {
  const items = sessions.map((session) => {
    const base = toSessionDetailItem(session);
    const token = createSessionToken(base);
    const detail = { ...base, token };
    sessionTokenEntries.set(token, {
      key: detail.key,
      detail,
      createdAt: Date.now(),
    });
    return {
      token,
      key: detail.key,
      displayName: detail.displayName || detail.label,
      updatedAt: detail.updatedAt,
      hasActiveRun: detail.hasActiveRun,
      model: [detail.modelProvider, detail.model].filter(Boolean).join("/"),
    };
  });
  return buildSessionPanel(items);
}

function resolvePermissionActionFromPayload(payload: string): string {
  const normalized = payload.startsWith("sc:") ? payload.slice(3) : payload;
  if (normalized.startsWith("dv:depgo:")) {
    return "deploy:production";
  }
  if (normalized.startsWith("approve:") || normalized.startsWith("risk:ok:")) {
    return "deploy:approve";
  }
  if (
    normalized.startsWith("kill") ||
    normalized.startsWith("ag:rst") ||
    normalized.startsWith("cr:rmok:") ||
    normalized.startsWith("ss:dlok:")
  ) {
    return "delete:session";
  }
  if (normalized.startsWith("ss:cp:") || normalized.startsWith("ss:ab:")) {
    return "deploy:approve";
  }
  if (
    normalized.startsWith("tr:buy") ||
    normalized.startsWith("tr:sell") ||
    normalized.startsWith("tr:closeok")
  ) {
    return "deploy:trade";
  }
  return "read:dashboard";
}

function requiresOwnerForPayload(payload: string): boolean {
  const normalized = payload.startsWith("sc:") ? payload.slice(3) : payload;
  return (
    normalized.startsWith("approve:") ||
    normalized.startsWith("deny:") ||
    normalized.startsWith("risk:ok:") ||
    normalized.startsWith("dv:depgo:")
  );
}

export function interactiveReplyToTelegramMessage(
  panel: InteractiveReply,
  overrides?: { buttons?: TelegramButton[][]; textMode?: string },
): TelegramMessage {
  const text = panel.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const buttonBlocks = panel.blocks.filter(
    (b): b is { type: "buttons"; buttons: PanelButton[] } => b.type === "buttons",
  );
  const defaultButtons = buttonBlocks
    .map((b) =>
      b.buttons
        .filter((btn) => validateCallbackData(btn.value))
        .map((btn) => ({
          text: normalizeLegacyTelegramButtonLabel(btn.label),
          callback_data: btn.value,
        })),
    )
    .filter((row) => row.length > 0);
  const buttons = normalizeTelegramButtons(overrides?.buttons ?? defaultButtons);
  return {
    text,
    ...(buttons.length > 0 ? { buttons } : {}),
    textMode: overrides?.textMode ?? "html",
  };
}

export function registerSuperClawInteractiveHandler(api: OpenClawPluginApi) {
  api.registerInteractiveHandler({
    channel: "telegram",
    namespace: NAMESPACE,
    handler: async (rawCtx: unknown) => {
      const ctx = parseCallbackRouterContext(rawCtx);
      if (!ctx) {
        return { handled: false };
      }
      const userId = parseTelegramUserId(ctx.senderId) ?? 0;
      const payload = ctx.callback.payload;
      const normalizedPayload = payload.startsWith(`${NAMESPACE}:`)
        ? payload.slice(NAMESPACE.length + 1)
        : payload;
      const parts = normalizedPayload.split(":");
      const [action, sub, param] = parts;

      const respond = ctx.respond;

      // 追蹤 chatId — 讓事件推送知道要發到哪裡
      // TelegramInteractiveHandlerContext 的 chatId 在 callback.chatId
      const interactionCtx = rawCtx as RawInteractiveContext;
      const resolvedChatId =
        interactionCtx?.callback?.chatId ??
        interactionCtx?.conversationId ??
        interactionCtx?.senderId;
      if (typeof resolvedChatId === "string" || typeof resolvedChatId === "number") {
        setActiveChatId(resolvedChatId);
      }

      if (userId > 0) {
        const permissionConfig = loadPermissionConfigFromEnv();
        const hasRateLimitOverride =
          process.env.OPENCLAW_TELEGRAM_RATE_LIMIT_PER_MINUTE !== undefined ||
          process.env.OPENCLAW_TELEGRAM_RATE_LIMIT_TOKENS_PER_DAY !== undefined;
        const enforcePermissions =
          process.env.OPENCLAW_TELEGRAM_ENFORCE_PERMISSIONS === "true" ||
          permissionConfig.ownerTelegramIds.length > 0 ||
          permissionConfig.allowedTelegramIds.length > 0 ||
          hasRateLimitOverride;

        if (enforcePermissions && !isAllowedUser(userId, permissionConfig)) {
          await respond.reply({ text: "🚫 你沒有使用此功能的權限。" });
          return { handled: true };
        }
        if (enforcePermissions && !checkRateLimit(userId, permissionConfig)) {
          await respond.reply({ text: "⏱ 操作過於頻繁，請稍後再試。" });
          return { handled: true };
        }

        const permissionAction = resolvePermissionActionFromPayload(payload);
        const permission = getActionPermission(permissionAction, permissionConfig);
        if (enforcePermissions && permission === "deny") {
          await respond.reply({ text: "🔒 此操作已被安全策略禁止。" });
          return { handled: true };
        }
        if (
          enforcePermissions &&
          requiresOwnerForPayload(payload) &&
          !isOwnerUser(userId, permissionConfig)
        ) {
          await respond.reply({ text: "🔒 此操作僅限管理者。" });
          return { handled: true };
        }
      }

      const editPanel = async (panel: InteractiveReply) => {
        const text = panel.blocks
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const buttonBlocks = panel.blocks.filter(
          (b): b is { type: "buttons"; buttons: PanelButton[] } => b.type === "buttons",
        );
        const buttons = buttonBlocks
          .map((b) =>
            b.buttons
              .filter((btn) => validateCallbackData(btn.value)) // 過濾超長 callback_data
              .map((btn) => ({
                text: normalizeLegacyTelegramButtonLabel(btn.label),
                callback_data: btn.value,
              })),
          )
          .filter((row) => row.length > 0); // 過濾空行
        await respond.editMessage({ text, buttons, textMode: "html" });
      };

      try {
        switch (action) {
          // ── Dashboard (home) ──
          case "home": {
            const state = getSystemState();
            await editPanel(buildDashboard(state));
            break;
          }

          // ── Primary actions (from dashboard / main menu) ──
          case "chat":
          case "ask": {
            setUserMode(userId, "chat");
            trackAction(userId, "對話", "sc:ask");
            await respond.editMessage({
              text: "💬 <b>對話模式</b>\n\n直接打字，智能體會回覆。\n語音、圖片、檔案都能處理。\n\n<i>輸入任何訊息開始...</i>",
              textMode: "html",
              buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
            });
            break;
          }

          case "code": {
            setUserMode(userId, "code");
            trackAction(userId, "寫碼", "sc:code");
            await respond.editMessage({
              text:
                "💻 <b>程式碼模式</b>\n\n輸入你要做的事，智能體會執行：\n\n" +
                "<i>→ 重構 auth module 改用 JWT</i>\n" +
                "<i>→ 修復 login 頁面的 bug</i>\n" +
                "<i>→ 幫我寫測試</i>\n\n" +
                "直接輸入文字訊息即可。",
              textMode: "html",
              buttons: [
                [
                  { text: "🔧 快速：修錯誤", callback_data: "sc:spawn:fix" },
                  { text: "🧪 快速：寫測試", callback_data: "sc:spawn:test" },
                ],
                [{ text: "← 首頁", callback_data: "sc:home" }],
              ],
            });
            break;
          }

          // ── Task lifecycle ──
          case "detail": {
            const state = getSystemState();
            if (state.activeTask) {
              const t = state.activeTask;
              const elapsed = Date.now() - t.startedAt;
              await respond.reply({
                text:
                  `📋 <b>任務詳情</b>\n\n` +
                  `ID: <code>${escapeHtml(t.id)}</code>\n` +
                  `智能體: ${escapeHtml(t.agent)}\n` +
                  `階段: ${escapeHtml(t.phase)}\n` +
                  `進度: ${t.stepCurrent}/${t.stepTotal}\n` +
                  `耗時: ${(elapsed / 1000).toFixed(0)}s\n` +
                  `動作: ${escapeHtml(t.currentAction)}`,
                textMode: "html",
              });
            } else {
              await respond.reply({
                text: "📋 目前沒有進行中的任務。",
              });
            }
            break;
          }

          case "pause":
            await respond.editMessage({
              text: "⏸ 已暫停任務。\n\n輸入任何訊息繼續。",
              buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
            });
            break;

          case "kill":
            completeTask(false);
            await editPanel(buildDashboard(getSystemState()));
            break;

          case "retry": {
            if (sub) {
              trackAction(userId, "重試任務", `sc:retry:${sub}`);
              await executeSubagentTask(api, respond, {
                title: "重試任務",
                prompt:
                  `請重試任務 ${sub}，先檢查上一輪失敗原因，` +
                  "再提供最小修復步驟與驗證命令，並立即執行一輪。",
                backAction: "sc:home",
                retryAction: `sc:retry:${sub}`,
              });
              break;
            }
            await respond.editMessage({
              text: "🔄 重新嘗試中...",
              buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
            });
            break;
          }

          case "analyze": {
            if (sub) {
              trackAction(userId, "分析錯誤", `sc:analyze:${sub}`);
              await executeSubagentTask(api, respond, {
                title: "分析錯誤",
                prompt:
                  `請分析任務 ${sub} 失敗原因，輸出：` +
                  "1) 根因 2) 最小修復點 3) 驗證命令 4) 下一個安全任務。",
                backAction: "sc:home",
                retryAction: `sc:analyze:${sub}`,
              });
              break;
            }
            await respond.editMessage({
              text: "🔍 缺少任務 ID，無法分析。",
              buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
            });
            break;
          }

          case "edit": {
            if (sub) {
              trackAction(userId, "修改後批准", `sc:edit:${sub}`);
              await respond.editMessage({
                text:
                  "✏️ <b>修改後批准</b>\n\n" +
                  `任務 ID: <code>${escapeHtml(sub)}</code>\n` +
                  "請直接回覆你要修改的內容，確認後再按批准。",
                textMode: "html",
                buttons: [
                  [
                    { text: "✅ 直接批准", callback_data: `sc:approve:${sub}` },
                    { text: "🔍 先分析", callback_data: `sc:analyze:${sub}` },
                  ],
                  [{ text: "← 首頁", callback_data: "sc:home" }],
                ],
              });
              break;
            }
            await respond.editMessage({
              text: "✏️ 缺少任務 ID，無法進入修改流程。",
              buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
            });
            break;
          }

          case "skip": {
            if (sub) {
              dismissAttentionItem(sub);
            }
            await editPanel(buildDashboard(getSystemState()));
            break;
          }

          case "risk": {
            if (!param) {
              await respond.editMessage({
                text: "⚠️ 缺少風險任務 ID。",
                buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
              });
              break;
            }
            prunePendingRiskTasks();
            const pending = pendingRiskTasks.get(param);
            if (!pending) {
              await respond.editMessage({
                text: "⚠️ 風險確認已過期或不存在，請重新發起任務。",
                buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
              });
              break;
            }
            if (sub === "deny") {
              pendingRiskTasks.delete(param);
              await respond.editMessage({
                text: "❌ 已拒絕高風險任務。",
                buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
              });
              break;
            }
            if (sub !== "ok") {
              await respond.editMessage({
                text: `❓ 未知風險操作: ${escapeHtml(sub ?? "")}`,
                buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
              });
              break;
            }
            pendingRiskTasks.delete(param);
            await executeSubagentTask(api, respond, {
              ...pending.opts,
              skipRiskCheck: true,
            });
            break;
          }

          case "approve": {
            if (sub) {
              // 冪等性檢查 — 防止重複點擊
              if (handledApprovals.has(sub)) {
                await respond.editMessage({
                  text: `✅ 已批准（此操作已處理過）`,
                  buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
                });
                break;
              }
              trackApproval(sub);
              try {
                await withTimeout(rpc(api).approveExecution(sub), RPC_TIMEOUT_MS, "approve");
                await respond.editMessage({
                  text: `✅ 已批准 — 繼續執行中...`,
                  buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
                });
              } catch {
                await respond.editMessage({
                  text: `✅ 已批准（本地確認）`,
                  buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
                });
              }
            }
            break;
          }

          case "deny": {
            if (sub) {
              // 冪等性檢查
              if (handledApprovals.has(sub)) {
                await respond.editMessage({
                  text: `❌ 已拒絕（此操作已處理過）`,
                  buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
                });
                break;
              }
              trackApproval(sub);
              completeTask(false);
              try {
                await withTimeout(rpc(api).denyExecution(sub), RPC_TIMEOUT_MS, "deny");
              } catch {
                /* ignore */
              }
              await respond.editMessage({
                text: `❌ 已拒絕 — 任務已取消`,
                buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
              });
            }
            break;
          }

          case "errlog": {
            const logResult = await withTimeout(
              rpc(api).tailLogsWithStatus({ limit: 20, level: "error" }),
              RPC_TIMEOUT_MS,
              "logs.tail",
            );
            if (!logResult.ok) {
              await respond.reply({
                text:
                  "📋 <b>錯誤日誌</b>\n\n" +
                  "<code>來源不可用：logs.tail 呼叫失敗</code>\n" +
                  `<code>${escapeHtml((logResult.error ?? "unknown").slice(0, 220))}</code>`,
                textMode: "html",
              });
              break;
            }
            const logs = logResult.logs;
            if (logs.length === 0) {
              await respond.reply({
                text: "📋 <b>錯誤日誌</b>\n\n<code>(目前沒有錯誤記錄)</code>",
                textMode: "html",
              });
              break;
            }
            const lines = logs.slice(0, 20).map((entry) => {
              const hhmmss = new Date(entry.ts).toTimeString().slice(0, 8);
              return (
                `• [${escapeHtml(entry.level.toUpperCase())}] ${hhmmss}\n` +
                `  <code>${escapeHtml(entry.message.slice(0, 180))}</code>`
              );
            });
            await respond.reply({
              text: `📋 <b>錯誤日誌</b> (最近 ${Math.min(logs.length, 20)} 筆)\n\n${lines.join("\n")}`,
              textMode: "html",
            });
            break;
          }

          // ── Do actions (proactive suggestions) ──
          case "do": {
            const taskMap: Record<string, { title: string; prompt: string }> = {
              test: {
                title: "跑測試",
                prompt: "執行專案測試：跑所有 unit test 和 integration test，回報結果摘要。",
              },
              commit: {
                title: "提交變更",
                prompt: "檢查 git status，用有意義的繁體中文 commit 訊息提交所有變更。",
              },
              pr: {
                title: "建立 PR",
                prompt: "根據目前分支的 commit 建立 Pull Request，含摘要和測試計畫。",
              },
              push: {
                title: "推送分支",
                prompt: "推送目前分支到 remote origin。",
              },
              merge: {
                title: "合併 PR",
                prompt: "合併目前 PR（如果 CI 通過且已 approved）。",
              },
              scan: {
                title: "掃描專案",
                prompt: "掃描專案：檢查 CI 狀態、開放 PR、過期 issue，產出報告。",
              },
              cleanup: {
                title: "程式碼清理",
                prompt: "清理程式碼：移除 unused imports、dead code、console.log。",
              },
              "analyze-ci": {
                title: "分析 CI",
                prompt: "分析最近 CI 失敗原因，建議修復方法。",
              },
              review: {
                title: "Code Review",
                prompt: "對目前分支的 diff 進行 code review，提出改善建議。",
              },
              verify: {
                title: "驗證部署",
                prompt: "驗證最近部署：檢查服務是否正常運作。",
              },
              monitor: {
                title: "系統監控",
                prompt: "檢查系統健康狀態、資源使用、錯誤率。",
              },
              feedback: {
                title: "整理回饋",
                prompt: "收集最近任務的回饋摘要。",
              },
              stale: {
                title: "處理過期 PR",
                prompt: "找出超過 3 天未更新的 PR，逐一檢查並建議處理方式。",
              },
            };

            const task = taskMap[sub ?? ""];
            if (!task) {
              await respond.editMessage({
                text: `❓ 未知動作: ${escapeHtml(sub ?? "")}`,
                buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
              });
              break;
            }

            trackAction(userId, task.title, `sc:do:${sub}`);
            await executeSubagentTask(api, respond, {
              title: task.title,
              prompt: task.prompt,
              backAction: "sc:home",
              retryAction: `sc:do:${sub}`,
            });
            break;
          }

          // ── More panel ──
          case "more":
            await editPanel(buildMorePanel());
            break;

          case "sess": {
            trackAction(userId, "對話工作階段", "sc:sess");
            const sessions = await withTimeout(fetchSessions(api), RPC_TIMEOUT_MS, "sessions.list");
            await editPanel(buildSessionPanelFromGatewaySessions(sessions));
            break;
          }

          case "ss": {
            if (sub === "rf") {
              const sessions = await withTimeout(
                fetchSessions(api),
                RPC_TIMEOUT_MS,
                "sessions.list",
              );
              await editPanel(buildSessionPanelFromGatewaySessions(sessions));
              break;
            }
            const detail = resolveSessionDetailByToken(param);
            if (!detail) {
              await respond.editMessage({
                text: "⚠️ 工作階段操作已過期，請重新進入對話工作階段面板。",
                buttons: [[{ text: "← 對話工作階段", callback_data: "sc:sess" }]],
              });
              break;
            }
            if (sub === "vw") {
              const remote = await withTimeout(
                fetchSessionDetail(api, detail.key),
                RPC_TIMEOUT_MS,
                "sessions.describe",
              );
              const merged = remote
                ? ({
                    ...detail,
                    ...toSessionDetailItem(remote),
                    token: detail.token,
                  } satisfies SessionDetailItem)
                : detail;
              sessionTokenEntries.set(detail.token, {
                key: merged.key,
                detail: merged,
                createdAt: Date.now(),
              });
              await editPanel(buildSessionDetailPanel(merged));
              break;
            }
            if (sub === "ab") {
              const ok = await withTimeout(
                abortSession(api, detail.key),
                RPC_TIMEOUT_MS,
                "sessions.abort",
              );
              await editPanel(
                buildSessionActionResult(
                  "終止工作階段",
                  ok,
                  ok
                    ? `已送出終止請求：${detail.key}`
                    : `無法終止 session（可能沒有 active run）：${detail.key}`,
                ),
              );
              break;
            }
            if (sub === "cp") {
              const ok = await withTimeout(
                compactSession(api, detail.key),
                RPC_TIMEOUT_MS,
                "sessions.compact",
              );
              await editPanel(
                buildSessionActionResult(
                  "壓縮工作階段",
                  ok,
                  ok ? `已完成壓縮：${detail.key}` : `壓縮失敗：${detail.key}`,
                ),
              );
              break;
            }
            if (sub === "dly") {
              await editPanel(buildSessionDeleteConfirmPanel(detail));
              break;
            }
            if (sub === "dlok") {
              const ok = await withTimeout(
                deleteSession(api, detail.key),
                RPC_TIMEOUT_MS,
                "sessions.delete",
              );
              await editPanel(
                buildSessionActionResult(
                  "刪除工作階段",
                  ok,
                  ok ? `已刪除：${detail.key}` : `刪除失敗：${detail.key}`,
                ),
              );
              break;
            }
            await respond.editMessage({
              text: `❓ 未知對話工作階段操作: ${escapeHtml(sub ?? "")}`,
              buttons: [[{ text: "← 對話工作階段", callback_data: "sc:sess" }]],
            });
            break;
          }

          case "pro": {
            trackAction(userId, "會員", "sc:pro");
            const proSource = resolveTelegramProSource(userId);
            const isProUser = resolveTelegramProStatus(userId);
            if (sub === "env") {
              const botTokenConfigured = (process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "").length > 0;
              const proUsersRaw = (process.env.OPENCLAW_TELEGRAM_PRO_USERS ?? "").trim();
              const proUsersValidCount =
                proUsersRaw === "*"
                  ? -1
                  : new Set(
                      proUsersRaw
                        .split(/[,\s;|]+/)
                        .map((v) => Number(v.trim()))
                        .filter((v) => Number.isFinite(v) && v > 0),
                    ).size;
              const proUsersSummary =
                proUsersRaw === "*"
                  ? "✅ 全部用戶 (*)"
                  : proUsersRaw
                    ? proUsersValidCount > 0
                      ? `✅ 已設定 ${proUsersValidCount} 個 ID`
                      : "⚠️ 已設定但目前無有效 ID"
                    : "❌ 未設定";
              await respond.editMessage({
                text:
                  "🛠 <b>會員設定範例</b>\n\n" +
                  `目前授權：${resolveTelegramAuthBadge(userId)}\n` +
                  `目前授權來源：<code>${escapeHtml(proSource)}</code>\n` +
                  `設定檢查：\n` +
                  `- TELEGRAM_BOT_TOKEN：${botTokenConfigured ? "✅ 已設定" : "❌ 未設定"}\n` +
                  `- OPENCLAW_TELEGRAM_PRO_USERS：${proUsersSummary}\n\n` +
                  "1) 全員啟用會員：\n" +
                  "<code>OPENCLAW_TELEGRAM_PRO_ALL=true</code>\n\n" +
                  "2) 指定用戶啟用會員：\n" +
                  "<code>OPENCLAW_TELEGRAM_PRO_USERS=123456789,987654321</code>\n\n" +
                  "3) 升級付款連結需要：\n" +
                  "<code>TELEGRAM_BOT_TOKEN=123456:ABCDEF</code>\n\n" +
                  "修改環境變數後，重啟 automation 即可生效。",
                textMode: "html",
                buttons: [
                  [
                    { text: "⭐ 一鍵重試升級", callback_data: "sc:pro:buy" },
                    { text: "← 會員", callback_data: "sc:pro" },
                    { text: "← 更多功能", callback_data: "sc:more" },
                  ],
                  [{ text: "← 首頁", callback_data: "sc:home" }],
                ],
              });
              break;
            }
            if (sub === "buy") {
              if (isProUser) {
                await editPanel(buildProPanel(true, undefined, proSource));
                break;
              }
              const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
              if (!botToken) {
                await respond.editMessage({
                  text: "⚠️ 尚未設定 TELEGRAM_BOT_TOKEN，無法建立付款連結。",
                  buttons: [
                    [
                      { text: "🛠 會員設定", callback_data: "sc:pro:env" },
                      { text: "← 會員", callback_data: "sc:pro" },
                      { text: "← 更多功能", callback_data: "sc:more" },
                    ],
                    [{ text: "← 首頁", callback_data: "sc:home" }],
                  ],
                });
                break;
              }
              try {
                const invoiceLink = await createSubscriptionInvoice(botToken);
                await editPanel(buildProPanel(isProUser, invoiceLink, proSource));
              } catch (err: unknown) {
                if (isTelegramMessageNotModifiedError(err)) {
                  await replyUpToDateNotice(respond);
                  break;
                }
                await respond.editMessage({
                  text: buildInteractiveErrorHtml(err),
                  textMode: "html",
                  buttons: [
                    [
                      { text: "🔄 重試升級", callback_data: "sc:pro:buy" },
                      { text: "🛠 會員設定", callback_data: "sc:pro:env" },
                      { text: "← 會員", callback_data: "sc:pro" },
                    ],
                    [{ text: "← 首頁", callback_data: "sc:home" }],
                  ],
                });
              }
              break;
            }
            await editPanel(buildProPanel(isProUser, undefined, proSource));
            break;
          }

          // ── Sub-panels ──
          case "wf":
            if (!sub) {
              trackAction(userId, "工作流", "sc:wf");
              await editPanel(buildWorkflowList());
            } else if (sub === "run" && param) {
              trackAction(userId, `▶️ ${param}`, `sc:wf:run:${param}`);
              await executeWorkflow(api, param, respond);
            } else if (sub === "stop" && param) {
              completeTask(false);
              await respond.editMessage({
                text: "⏹ 工作流已取消",
                buttons: [[{ text: "← 工作流", callback_data: "sc:wf" }]],
              });
            }
            break;

          case "cron":
            trackAction(userId, "排程", "sc:cron");
            await editPanel(
              buildCronPanel(await withTimeout(fetchCronJobs(api), RPC_TIMEOUT_MS, "cron.list")),
            );
            break;

          case "cr":
            await handleCron(sub, param, api, respond, editPanel, userId).catch(async (err) => {
              if (isTelegramMessageNotModifiedError(err)) {
                await replyUpToDateNotice(respond);
                return;
              }
              await respond.editMessage({
                text: buildInteractiveErrorHtml(err),
                textMode: "html",
                buttons: [
                  [
                    { text: "← 排程", callback_data: "sc:cron" },
                    { text: "← 首頁", callback_data: "sc:home" },
                  ],
                ],
              });
            });
            break;

          case "model":
            trackAction(userId, "模型", "sc:model");
            await editPanel(
              buildModelPanel(
                await withTimeout(fetchModels(api), RPC_TIMEOUT_MS, "models.list"),
                await withTimeout(fetchCurrentModel(api), RPC_TIMEOUT_MS, "models.current"),
              ),
            );
            break;

          case "md":
            if (sub === "sw" && param) {
              trackAction(userId, `模型→${param}`, `sc:md:sw:${param}`);
              await respond.editMessage({ text: "🔄 切換模型中...", textMode: "html" });
              try {
                await withTimeout(switchModel(api, param), RPC_TIMEOUT_MS, "model.switch");
                await editPanel(buildModelSwitchResult(param, true));
              } catch {
                await editPanel(buildModelSwitchResult(param, false));
              }
            }
            break;

          case "agents":
            trackAction(userId, "智能體", "sc:agents");
            await editPanel(
              buildAgentPanel(
                await withTimeout(fetchAgents(api), RPC_TIMEOUT_MS, "agents.list"),
                await withTimeout(fetchActiveAgentId(api), RPC_TIMEOUT_MS, "agents.active"),
              ),
            );
            break;

          case "ag":
            await handleAgent(sub, param, api, respond, editPanel);
            break;

          case "devops":
            trackAction(userId, "維運", "sc:devops");
            await editPanel(
              buildDevOpsPanel(
                await withTimeout(fetchCIStatuses(api), RPC_TIMEOUT_MS, "ci.statuses"),
              ),
            );
            break;

          // ── 交易面板 ──
          case "trade": {
            trackAction(userId, "交易", "sc:trade");
            const [tradingState, auditSummary, shortcutGateSummary] = await Promise.all([
              fetchTradingState(api),
              fetchTradingFastOrderAuditSnapshot(api, { filter: "all", offset: 0, limit: 3 }),
              fetchTelegramTradingShortcutsSummaryState(),
            ]);
            await editPanel(
              buildTradingPanel({ ...tradingState, auditSummary, shortcutGateSummary }),
            );
            break;
          }

          case "tr":
            await handleTrading(sub, param, api, respond, editPanel, userId);
            break;

          case "dv":
            await handleDevOps(sub, param, api, respond, editPanel, userId);
            break;

          case "history": {
            trackAction(userId, "歷史", "sc:history");
            try {
              const history = await withTimeout(
                rpc(api).fetchChatHistory(10),
                RPC_TIMEOUT_MS,
                "history",
              );
              if (history.length === 0) {
                await respond.reply({
                  text: "📜 <b>對話歷史</b>\n\n目前沒有對話記錄。",
                  textMode: "html",
                });
              } else {
                const lines = history.map((h) => {
                  const role = h.role === "user" ? "👤" : "🤖";
                  const content = escapeHtml(h.content.slice(0, 80));
                  return `${role} ${content}${h.content.length > 80 ? "..." : ""}`;
                });
                await respond.reply({
                  text: `📜 <b>對話歷史</b> (最近 ${history.length} 輪)\n\n${lines.join("\n\n")}`,
                  textMode: "html",
                });
              }
            } catch {
              await respond.reply({
                text: "📜 <b>對話歷史</b>\n\n無法取得對話記錄。",
                textMode: "html",
              });
            }
            break;
          }

          case "reset":
            await editPanel(buildResetConfirm("main"));
            break;

          case "dash": {
            const dashState = getSystemState();
            await editPanel(buildDashboard(dashState));
            break;
          }

          case "stat": {
            trackAction(userId, "狀態", "sc:stat");
            try {
              const rpcClient = rpc(api);
              const [health, usage, snapshot] = await withTimeout(
                Promise.all([
                  rpcClient.fetchHealth(),
                  rpcClient.fetchUsage(),
                  rpcClient.fetchSystemSnapshot(),
                ]),
                RPC_TIMEOUT_MS,
                "system.status",
              );
              const text =
                `📊 <b>系統狀態</b>\n\n` +
                `智能體: ${escapeHtml(snapshot.agentStatus)}\n` +
                `健康: ${health.ok ? "✅ 正常" : `❌ ${escapeHtml(health.details ?? "異常")}`}\n` +
                `授權: ${resolveTelegramAuthBadge(userId)}\n` +
                `授權來源: <code>${resolveTelegramProSource(userId)}</code>\n` +
                `今日權杖: ${usage.tokensToday.toLocaleString()}\n` +
                `今日費用: $${usage.costToday.toFixed(2)}\n` +
                `排程: ${snapshot.cronJobsEnabled} 個啟用`;
              await respond.editMessage({
                text,
                textMode: "html",
                buttons: [
                  [
                    { text: "🔄 重新整理", callback_data: "sc:stat" },
                    { text: "🛠 會員設定", callback_data: "sc:pro:env" },
                    { text: "📊 智能體管理", callback_data: "sc:agents" },
                  ],
                  [{ text: "← 首頁", callback_data: "sc:home" }],
                ],
              });
            } catch (err: unknown) {
              if (isTelegramMessageNotModifiedError(err)) {
                await replyUpToDateNotice(respond);
                break;
              }
              await respond.editMessage({
                text: buildInteractiveErrorHtml(err),
                textMode: "html",
                buttons: [
                  [
                    { text: "🔄 重試", callback_data: "sc:stat" },
                    { text: "← 首頁", callback_data: "sc:home" },
                  ],
                ],
              });
            }
            break;
          }

          // ── Subagent 任務生成 ──
          case "spawn": {
            const taskType = sub ?? "general";
            const taskPrompts: Record<string, { title: string; prompt: string }> = {
              fix: {
                title: "修錯誤",
                prompt:
                  "請檢查最近的程式碼變更，找出並修復可能的 bug。分析 git diff 和最近的錯誤日誌。修復後回報修改了哪些檔案、改了什麼。",
              },
              test: {
                title: "寫測試",
                prompt:
                  "請為最近修改的程式碼撰寫單元測試。確保覆蓋主要邏輯分支。完成後回報新增了哪些測試檔案、測試結果。",
              },
              refactor: {
                title: "重構",
                prompt:
                  "請分析目前的程式碼架構，提出重構建議並實作改善。完成後回報重構了哪些模組、改善了什麼。",
              },
              general: {
                title: "通用任務",
                prompt: "請分析目前專案狀態，回報任何需要注意的問題。",
              },
            };
            const task = taskPrompts[taskType] ?? taskPrompts.general;
            trackAction(userId, task.title, `sc:spawn:${taskType}`);

            await executeSubagentTask(api, respond, {
              title: task.title,
              prompt: task.prompt,
              backAction: "sc:code",
              backLabel: "← 寫碼",
              retryAction: `sc:spawn:${taskType}`,
            });
            break;
          }

          case "build": {
            trackAction(userId, "建置狀態", "sc:build");
            await respond.editMessage({
              text:
                "🔨 <b>程式建置</b>\n\n" +
                "此功能需要程式執行代理整合。\n" +
                "使用 /code 指令或直接發送訊息來執行程式碼任務。",
              textMode: "html",
              buttons: [
                [
                  { text: "💻 寫碼", callback_data: "sc:code" },
                  { text: "← 返回", callback_data: "sc:home" },
                ],
              ],
            });
            break;
          }

          case "buildrun": {
            trackAction(userId, "觸發建置", "sc:buildrun");
            await respond.editMessage({
              text: "💻 請直接輸入你要執行的程式碼任務，系統會自動處理。",
              buttons: [[{ text: "← 返回", callback_data: "sc:home" }]],
            });
            break;
          }

          default:
            await respond.editMessage({
              text: `❓ 未知操作: ${escapeHtml(action)}`,
              buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
            });
        }
      } catch (err: unknown) {
        if (isTelegramMessageNotModifiedError(err)) {
          await replyUpToDateNotice(respond);
          return { handled: true };
        }
        await respond.editMessage({
          text: buildInteractiveErrorHtml(err),
          textMode: "html",
          buttons: [
            [
              { text: "🔄 重試", callback_data: `sc:${payload}` },
              { text: "← 回首頁", callback_data: "sc:home" },
            ],
          ],
        });
      }
      return { handled: true };
    },
  });
}

async function handleCron(
  sub: string | undefined,
  param: string | undefined,
  api: OpenClawPluginApi,
  respond: TelegramResponder,
  editPanel: (p: InteractiveReply) => Promise<void>,
  userId: number,
) {
  switch (sub) {
    case "tg":
      if (param) {
        const jobs = await withTimeout(fetchCronJobs(api), RPC_TIMEOUT_MS, "cron.list");
        const job = jobs.find((j) => j.id === param);
        if (job) {
          await withTimeout(toggleCronJob(api, param, !job.enabled), RPC_TIMEOUT_MS, "cron.toggle");
          trackAction(userId, `${!job.enabled ? "▶️" : "⏸"} ${param}`, `sc:cr:tg:${param}`);
          await editPanel(
            buildCronPanel(await withTimeout(fetchCronJobs(api), RPC_TIMEOUT_MS, "cron.list")),
          );
        } else {
          await respond.editMessage({
            text: `❓ 找不到排程: ${escapeHtml(param)}`,
            buttons: [[{ text: "← 排程", callback_data: "sc:cron" }]],
          });
        }
      }
      break;
    case "pick":
      await editPanel(
        buildCronRunPicker(await withTimeout(fetchCronJobs(api), RPC_TIMEOUT_MS, "cron.list")),
      );
      break;
    case "run":
      if (param) {
        trackAction(userId, `執行 ${param}`, `sc:cr:run:${param}`);
        await respond.editMessage({
          text: `▶️ 執行 <b>${escapeHtml(param)}</b> 中...`,
          textMode: "html",
        });
        try {
          await withTimeout(rpc(api).runCronJob(param), RPC_TIMEOUT_MS, "cron.run");
          await editPanel(buildCronRunResult(param, true, "手動觸發成功"));
        } catch (err: unknown) {
          await editPanel(buildCronRunResult(param, false, getErrorMessage(err)));
        }
      }
      break;
    default:
      await respond.editMessage({
        text: `❓ 未知排程操作: ${escapeHtml(sub ?? "")}`,
        buttons: [
          [
            { text: "← 排程", callback_data: "sc:cron" },
            { text: "← 首頁", callback_data: "sc:home" },
          ],
        ],
      });
      break;
  }
}

async function handleAgent(
  sub: string | undefined,
  param: string | undefined,
  api: OpenClawPluginApi,
  respond: TelegramResponder,
  editPanel: (p: InteractiveReply) => Promise<void>,
) {
  switch (sub) {
    case "sw":
      if (param) {
        await withTimeout(switchAgent(api, param), RPC_TIMEOUT_MS, "agent.switch");
        await editPanel(
          buildAgentPanel(
            await withTimeout(fetchAgents(api), RPC_TIMEOUT_MS, "agents.list"),
            param,
          ),
        );
      }
      break;
    case "rst":
      if (!param) {
        await editPanel(buildResetConfirm("main"));
      } else if (param === "yes") {
        await withTimeout(resetSession(api), RPC_TIMEOUT_MS, "session.reset");
        await respond.editMessage({
          text: "✅ 對話已重置",
          buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
        });
      }
      break;
    default:
      await respond.editMessage({
        text: `❓ 未知智能體操作: ${escapeHtml(sub ?? "")}`,
        buttons: [
          [
            { text: "← 智能體管理", callback_data: "sc:agents" },
            { text: "← 首頁", callback_data: "sc:home" },
          ],
        ],
      });
      break;
  }
}

async function handleDevOps(
  sub: string | undefined,
  param: string | undefined,
  api: OpenClawPluginApi,
  respond: TelegramResponder,
  editPanel: (p: InteractiveReply) => Promise<void>,
  userId: number,
) {
  switch (sub) {
    case "ref":
      trackAction(userId, "CI 刷新", "sc:dv:ref");
      await editPanel(
        buildDevOpsPanel(await withTimeout(fetchCIStatuses(api), RPC_TIMEOUT_MS, "ci.statuses")),
      );
      break;
    case "prs":
      await editPanel(
        buildPRListPanel(await withTimeout(fetchPRs(api), RPC_TIMEOUT_MS, "github.prs")),
      );
      break;
    case "rv":
      if (param) {
        trackAction(userId, `Review #${param}`, `sc:dv:rv:${param}`);
        await executeSubagentTask(api, respond, {
          title: `Code Review PR #${param}`,
          prompt:
            `請對 PR #${param} 進行完整的 Code Review。包含：\n` +
            `1. 拉取 PR diff\n` +
            `2. 安全性審查（SQL injection, XSS, 認證問題等）\n` +
            `3. 效能審查（N+1 查詢, 記憶體洩漏等）\n` +
            `4. 架構設計審查\n` +
            `5. 產出審查報告摘要`,
          backAction: "sc:devops",
          backLabel: "← 維運",
        });
      }
      break;
    case "dep":
      if (param) {
        await editPanel(buildDeployConfirm(param));
      }
      break;
    case "depgo":
      if (param) {
        trackAction(userId, `部署 ${param}`, `sc:dv:depgo:${param}`);
        await executeSubagentTask(api, respond, {
          title: `部署到 ${param}`,
          prompt:
            `請執行部署到 ${param} 環境：\n` +
            `1. 檢查當前分支狀態\n` +
            `2. 執行測試確保品質\n` +
            `3. 建置專案\n` +
            `4. 執行部署指令\n` +
            `5. 驗證部署結果`,
          backAction: "sc:devops",
          backLabel: "← 維運",
        });
      }
      break;
    case "fix":
      trackAction(userId, "分析 CI 失敗", "sc:dv:fix");
      await executeSubagentTask(api, respond, {
        title: "分析 CI 失敗",
        prompt:
          `請分析最近的 CI 失敗原因：\n` +
          `1. 檢查最近的 git log 和 CI 輸出\n` +
          `2. 找出失敗的測試或建置步驟\n` +
          `3. 分析根本原因\n` +
          `4. 提出修復建議\n` +
          `5. 如果可以，自動修復問題`,
        backAction: "sc:devops",
        backLabel: "← 維運",
      });
      break;
    default:
      await respond.editMessage({
        text: `❓ 未知維運操作: ${escapeHtml(sub ?? "")}`,
        buttons: [
          [
            { text: "← 維運", callback_data: "sc:devops" },
            { text: "← 首頁", callback_data: "sc:home" },
          ],
        ],
      });
      break;
  }
}

// ── 交易子處理 ────────────────────────────────────────────────────

async function handleTrading(
  sub: string | undefined,
  param: string | undefined,
  api: OpenClawPluginApi,
  respond: TelegramResponder,
  editPanel: (p: InteractiveReply) => Promise<void>,
  userId: number,
) {
  const normalizedSub = normalizeLegacyTradingCallbackSub(sub);
  switch (normalizedSub) {
    case "platform": {
      trackAction(userId, "AI 交易平台", "sc:tr:platform");
      const snapshot = await fetchTradingPlatformSnapshot(api);
      const auditSummary = snapshot
        ? await fetchTradingFastOrderAuditSnapshot(api, { filter: "all", offset: 0, limit: 5 })
        : null;
      await editPanel(buildAiTradingPlatformPanel(snapshot, auditSummary));
      break;
    }
    case "write": {
      trackAction(userId, "寫入快速進出場審核票", "sc:tr:write");
      const writeState = await writeTradingFastOrderIntent(api);
      await editPanel(buildFastOrderIntentWritePanel(writeState));
      break;
    }
    case "paperloop": {
      trackAction(userId, "一鍵快速進出場模擬閉環", "sc:tr:paperloop");
      const writeState = await writeTradingFastOrderIntent(api);
      const writeStatus = typeof writeState?.status === "string" ? writeState.status : "";
      const writeFailed =
        !writeState ||
        writeStatus === "gateway_unreachable" ||
        writeStatus === "gateway_timeout" ||
        writeStatus === "write_failed" ||
        writeStatus === "gateway_invalid_response";
      if (writeFailed) {
        await editPanel(buildFastOrderIntentWritePanel(writeState));
        break;
      }
      const reviewState = await reviewTradingFastOrderIntent(api, "approve_paper");
      if (!reviewState) {
        await editPanel(buildFastOrderIntentReviewPanel(null));
        break;
      }
      const learningSnapshotRefresh = await refreshTradingFastOrderLearningSnapshot(api);
      const auditState = await fetchTradingFastOrderAuditSnapshot(api, {
        filter: "all",
        offset: 0,
        limit: 5,
      });
      await editPanel(
        buildFastOrderAuditTrailPanel(
          auditState && learningSnapshotRefresh
            ? { ...auditState, learningSnapshotRefresh }
            : auditState,
        ),
      );
      break;
    }
    case "auto": {
      trackAction(userId, "交易總循環", "sc:tr:auto");
      await executeSubagentTask(api, respond, {
        title: "交易總循環",
        prompt: buildTradingOpsPrompt(
          "Capital paper-only 交易總循環",
          [
            "pnpm capital:trade:auto-cycle",
            "pnpm capital:trade:auto-cycle:check",
            "pnpm capital-hft:telegram-trading-shortcuts:check",
          ],
          "回報 capitalTradeAutoCycle.status、decision.status、quoteFreshness、sealedOrderIntent.sha256、positionDecision.status、externalBrokerAdapterAck.status、strategyFillGate、operatorCanExecute、noLiveOrderSent、sentOrder、remaining blockers、next task。此入口只允許 paper-only 策略總循環與 Telegram summary 回讀；不得啟用 live、不得持有券商/交易所寫入權限、不得送出真單。",
        ),
        backAction: "sc:trade",
        backLabel: TRADING_BUTTON_COPY.backToTrade,
        retryAction: "sc:tr:auto",
        timeoutMs: 240_000,
        skipRiskCheck: true,
      });
      break;
    }
    case "approve": {
      trackAction(userId, "核准快速進出場模擬執行", "sc:tr:approve");
      const reviewState = await reviewTradingFastOrderIntent(api, "approve_paper");
      if (shouldBlockFastOrderApproveAndGuideWrite(reviewState)) {
        await respond.editMessage(buildFastOrderApproveWriteGuideMessage(reviewState));
        break;
      }
      await editPanel(
        appendTradingActionReceipt(buildFastOrderIntentReviewPanel(reviewState), "核准模擬執行"),
      );
      break;
    }
    case "deny": {
      trackAction(userId, "拒絕快速進出場審核票", "sc:tr:deny");
      const reviewState = await reviewTradingFastOrderIntent(api, "deny");
      await editPanel(
        appendTradingActionReceipt(buildFastOrderIntentReviewPanel(reviewState), "拒絕審核票"),
      );
      break;
    }
    case "audit": {
      const query = parseFastOrderAuditQuery(param);
      trackAction(userId, "快速進出場審核紀錄", `sc:tr:audit:${query.filter}_${query.offset}`);
      const auditState = await fetchTradingFastOrderAuditSnapshot(api, query);
      await editPanel(buildFastOrderAuditTrailPanel(auditState));
      break;
    }
    case "quote": {
      trackAction(userId, "報價", "sc:tr:quote");
      const state = await fetchTradingState(api);
      await editPanel(
        buildQuoteDetailPanel(state.quotes, {
          quoteStatus: state.quoteStatus,
          connected: state.connected,
        }),
      );
      break;
    }
    case "corequote": {
      trackAction(userId, "全商品報價矩陣", "sc:tr:corequote");
      await executeSubagentTask(api, respond, {
        title: "全商品報價矩陣 Gate",
        prompt: buildTradingOpsPrompt(
          "群益全商品核心報價矩陣 Gate",
          [
            "pnpm capital:quote:core-products:check",
            "pnpm capital-hft:telegram-trading-shortcuts:check",
          ],
          "回報 coreProductMatrix.status、productCount、requiredCount、freshCount、requiredReady、subscribedDomesticCount、subscribedOverseasCount、blockedRequiredIds、stale/nonready products、nextSafeTask、noLiveOrderSent。此入口只允許讀取與刷新全商品報價矩陣報告；不得啟用 live、不得寫入券商或交易所、不得套用 adapter ack、不得 arm executor、不得送出真單。",
        ),
        backAction: "sc:trade",
        backLabel: TRADING_BUTTON_COPY.backToTrade,
        retryAction: "sc:tr:corequote",
        timeoutMs: 180_000,
        skipRiskCheck: true,
      });
      break;
    }
    case "pos": {
      trackAction(userId, "持倉", "sc:tr:pos");
      const state = await fetchTradingState(api);
      if (state.positions.length === 0) {
        await respond.editMessage({
          text: "📋 <b>持倉詳情</b>\n\n目前無持倉。",
          textMode: "html",
          buttons: [[{ text: TRADING_BUTTON_COPY.backToTrade, callback_data: "sc:trade" }]],
        });
      } else {
        const lines = state.positions.map((p) => {
          const sideIcon = p.side === "long" ? "🔺 多" : "🔻 空";
          const pnlSign = p.pnl >= 0 ? "+" : "";
          return (
            `<b>${p.symbol}</b> ${sideIcon} ×${p.qty}\n` +
            `  進場: ${p.entryPrice} → 現價: ${p.currentPrice}\n` +
            `  損益: ${pnlSign}${p.pnl.toFixed(0)} (${pnlSign}${p.pnlPercent.toFixed(1)}%)`
          );
        });
        await respond.editMessage({
          text: `📋 <b>持倉詳情</b> (${state.positions.length})\n\n${lines.join("\n\n")}`,
          textMode: "html",
          buttons: [
            [
              { text: TRADING_BUTTON_COPY.refresh, callback_data: "sc:tr:pos" },
              { text: TRADING_BUTTON_COPY.backToTrade, callback_data: "sc:trade" },
            ],
          ],
        });
      }
      break;
    }
    case "paper":
      trackAction(userId, "模擬下單", "sc:tr:paper");
      await editPanel(buildPaperOrderPanel());
      break;
    case "buy":
    case "sell": {
      const side = sub === "buy" ? "買入" : "賣出";
      trackAction(userId, side, `sc:tr:${sub}`);
      const quickTx = `sc:tr:ord:${sub}_TX00_1`;
      const quickMcl = `sc:tr:ord:${sub}_MCL0000_1`;
      await respond.editMessage({
        text:
          `${sub === "buy" ? "🔺" : "🔻"} <b>${side}</b>\n\n` +
          `請輸入標的和數量：\n` +
          `<i>例：TX00 1口</i>\n` +
          `<i>例：MCL0000 1口</i>\n\n` +
          `或直接使用下方快速模擬單。\n\n` +
          `直接在聊天輸入即可，助手會處理。`,
        textMode: "html",
        buttons: [
          [
            {
              text: `${sub === "buy" ? "🟢" : "🔴"} TX00 1口`,
              callback_data: quickTx,
            },
            {
              text: `${sub === "buy" ? "🟢" : "🔴"} MCL0000 1口`,
              callback_data: quickMcl,
            },
          ],
          [
            { text: TRADING_BUTTON_COPY.backToOrder, callback_data: "sc:tr:paper" },
            { text: TRADING_BUTTON_COPY.backToTrade, callback_data: "sc:trade" },
          ],
        ],
      });
      break;
    }
    case "ord": {
      const parsed = parseTradingOrderShortcut(param);
      if (!parsed) {
        await respond.editMessage({
          text:
            "⚠️ <b>模擬下單參數錯誤</b>\n\n" +
            "請回到模擬下單面板重新選擇快速按鈕，或手動輸入指令。",
          textMode: "html",
          buttons: [
            [
              { text: TRADING_BUTTON_COPY.backToOrder, callback_data: "sc:tr:paper" },
              { text: TRADING_BUTTON_COPY.backToTrade, callback_data: "sc:trade" },
            ],
          ],
        });
        break;
      }
      const sideLabel = parsed.side === "buy" ? "買入" : "賣出";
      trackAction(
        userId,
        `模擬下單 ${sideLabel} ${parsed.symbol}×${parsed.quantity}`,
        `sc:tr:ord:${parsed.side}_${parsed.symbol}_${parsed.quantity}`,
      );
      const sideText = parsed.side === "buy" ? "多" : "空";
      const orderText = `模擬真單 ${parsed.symbol} ${sideText} ${parsed.quantity}口`;
      await executeSubagentTask(api, respond, {
        title: `模擬下單：${sideLabel} ${parsed.symbol} ×${parsed.quantity}`,
        prompt: buildTradingOpsPrompt(
          "Telegram 模擬下單（paper-only）",
          [
            `node scripts/openclaw-capital-telegram-simulated-live-order.mjs --text "${orderText}" --write-state --json`,
          ],
          "回報 replyText / blockers / nextSafeTask。不得啟用 live，不得送出真單。",
        ),
        backAction: "sc:tr:paper",
        backLabel: TRADING_BUTTON_COPY.backToOrder,
        retryAction: `sc:tr:ord:${parsed.side}_${parsed.symbol}_${parsed.quantity}`,
        skipRiskCheck: true,
      });
      break;
    }
    case "closeall": {
      await respond.editMessage({
        text: "⚠️ <b>確認全部平倉？</b>\n\n這會關閉所有模擬持倉。",
        textMode: "html",
        buttons: [
          [
            { text: TRADING_BUTTON_COPY.confirmClose, callback_data: "sc:tr:closeok" },
            { text: TRADING_BUTTON_COPY.backToTrade, callback_data: "sc:trade" },
          ],
        ],
      });
      break;
    }
    case "closeok": {
      trackAction(userId, "全部平倉", "sc:tr:closeok");
      await executeSubagentTask(api, respond, {
        title: "全部平倉",
        prompt: "請執行全部平倉操作，關閉所有模擬持倉。回報平倉結果。",
        backAction: "sc:trade",
        backLabel: TRADING_BUTTON_COPY.backToTrade,
      });
      break;
    }
    case "strat": {
      trackAction(userId, "策略", "sc:tr:strat");
      const [stratState, auditSummary] = await Promise.all([
        fetchStrategyState(api),
        fetchTradingFastOrderAuditSnapshot(api, { filter: "all", offset: 0, limit: 5 }),
      ]);
      await editPanel(buildStrategyPanel(stratState, auditSummary));
      break;
    }
    case "rerun": {
      trackAction(userId, "重跑交易檢查", "sc:tr:rerun");
      await executeSubagentTask(api, respond, {
        title: "重跑交易檢查",
        prompt: buildTradingOpsPrompt(
          "策略與成交模擬一鍵重跑",
          [
            "pnpm capital:strategy:fill-simulation",
            "pnpm capital:strategy:fill-simulation:check",
            "pnpm capital-hft:auto-trading",
            "pnpm capital-hft:auto-trading-assistant:check",
            "pnpm capital-hft:auto-trading-loop:check",
            "pnpm capital-hft:auto-trading:check",
          ],
          "回報 fill-simulation 的 recommendation / fill_rate / expected_value_pts / mc_p05，以及 auto-trading 的 status / flowDecision.gates / blockers / nextSafeTask。完成後最新結果會由 sc:tr:assist 快速狀態列讀取。只能讀取或更新 OpenClaw state/report，不得啟用 live、不得 approve、不得 auto-activate、不得送出真單。",
        ),
        backAction: "sc:tr:assist",
        backLabel: "← 模擬助手",
        retryAction: "sc:tr:rerun",
        skipRiskCheck: true,
      });
      break;
    }
    case "learn": {
      trackAction(userId, "學習摘要", "sc:tr:learn");
      const [summary, auditSummary, shortcutGateSummary] = await Promise.all([
        fetchLearningSummary(api),
        fetchTradingFastOrderAuditSnapshot(api, {
          filter: "all",
          offset: 0,
          limit: 5,
        }),
        fetchTelegramTradingShortcutsSummaryState(),
      ]);
      await editPanel(buildLearningSummaryPanel(summary, auditSummary, shortcutGateSummary));
      break;
    }
    case "cap": {
      trackAction(userId, "群益狀態", "sc:tr:cap");
      const capitalState = await fetchCapitalServiceStatusState();
      await editPanel(buildCapitalServiceStatusPanel(capitalState));
      break;
    }
    case "okx": {
      trackAction(userId, "OKX 狀態", "sc:tr:okx");
      const okxState = await fetchOkxGateState();
      await editPanel(buildOkxStatusPanel(okxState));
      break;
    }
    case "okxrefresh": {
      trackAction(userId, "OKX 就緒刷新", "sc:tr:okxrefresh");
      const operationContextHtml = await buildOkxHeartbeatOperationReplyContextHtml();
      await executeSubagentTask(api, respond, {
        title: "OKX current-readiness 刷新",
        prompt: buildTradingOpsPrompt(
          "OKX current-readiness 刷新",
          [
            "pnpm okx:current-readiness:refresh",
            "pnpm okx:current-readiness:refresh:check",
            "pnpm okx:current-readiness:check",
            "pnpm capital-hft:telegram-trading-shortcuts:check",
          ],
          "回報 okxCurrentReadinessRefresh status / steps / freshness / noOrderWrite / failedSteps，並確認 noOrderWrite=true、readOnly=true、summaryOnly=true。只能刷新公開報價、本地 demo 模擬、paper audit 與 Telegram summary，不得查私有訂單、不得送單、不得取消、不得啟用 live、不得寫入交易所。",
        ),
        backAction: "sc:tr:okx",
        backLabel: TRADING_BUTTON_COPY.okxStatus,
        retryAction: "sc:tr:okxrefresh",
        timeoutMs: 240_000,
        skipRiskCheck: true,
        ...(operationContextHtml ? { operationContextHtml } : {}),
      });
      break;
    }
    case "okxord": {
      trackAction(userId, "OKX 下單提案", "sc:tr:okxord");
      const proposalState = await fetchOkxOrderProposalGateState();
      await editPanel(buildOkxOrderProposalPanel(proposalState));
      break;
    }
    case "okxstat": {
      trackAction(userId, "OKX 訂單狀態", "sc:tr:okxstat");
      const orderStatusState = await fetchOkxOrderStatusGateState();
      await editPanel(buildOkxOrderStatusPanel(orderStatusState));
      break;
    }
    case "diag": {
      trackAction(userId, "交易診斷", "sc:tr:diag");
      await executeSubagentTask(api, respond, {
        title: "交易系統診斷",
        prompt:
          "請執行交易系統診斷：\n" +
          "1. 診斷群益報價服務程序狀態\n" +
          "2. 診斷報價連線是否即時（新鮮度）\n" +
          "3. 診斷模擬交易循環狀態\n" +
          "4. 回報所有阻擋項目與建議",
        backAction: "sc:trade",
        backLabel: TRADING_BUTTON_COPY.backToTrade,
      });
      break;
    }
    case "hft": {
      trackAction(userId, "高頻閘門", "sc:tr:hft");
      await executeSubagentTask(api, respond, {
        title: "高頻閘門查驗",
        prompt: buildTradingOpsPrompt(
          "高頻閘門查驗",
          [
            "node scripts/check-capital-se-hft-hftengine-gate.mjs",
            "node scripts/check-capital-se-hft-riskguard-gate.mjs",
            "node scripts/check-capital-se-hft-hft-config-gate.mjs",
            "node scripts/check-capital-se-hft-strategies-marketmakingstrategy-gate.mjs",
            "node scripts/check-capital-se-hft-strategies-meanreversionhftstrategy-gate.mjs",
            "node scripts/check-capital-se-hft-strategies-orderimbalancestrategy-gate.mjs",
            "node scripts/check-capital-se-hft-strategies-tickmomentumstrategy-gate.mjs",
            "node scripts/check-capital-se-hft-strategies-twapvwapexecutor-gate.mjs",
          ],
          "回報每個 gate 的 status、blockers、changed files。不得啟用 live、不得寫 broker order。",
        ),
        backAction: "sc:trade",
        backLabel: TRADING_BUTTON_COPY.backToTrade,
        retryAction: "sc:tr:hft",
        skipRiskCheck: true,
      });
      break;
    }
    case "disp": {
      trackAction(userId, "下單串接", "sc:tr:disp");
      await executeSubagentTask(api, respond, {
        title: "下單串接查驗",
        prompt: buildTradingOpsPrompt(
          "HFT 到 BrokerAdapter 串接查驗",
          ["pnpm capital-hft:hft-broker-dispatcher:check"],
          "回報 Capital/OKX paper dispatch、live promotion blocker、no_live_order_sent。不得啟用 live。",
        ),
        backAction: "sc:trade",
        backLabel: TRADING_BUTTON_COPY.backToTrade,
        retryAction: "sc:tr:disp",
        skipRiskCheck: true,
      });
      break;
    }
    case "live": {
      trackAction(userId, "實單阻擋", "sc:tr:live");
      await executeSubagentTask(api, respond, {
        title: "實單阻擋查驗",
        prompt: buildTradingOpsPrompt(
          "群益實單阻擋與 promotion gate 查驗",
          [
            "pnpm capital-hft:live-trading:approval:summary:check",
            "pnpm capital-hft:live-trading:promotion:check",
          ],
          "只回報實單目前為 blocked/demo_pending/rejected 的證據與剩餘條件。不得 approve、不得 auto-activate、不得送出真單。",
        ),
        backAction: "sc:trade",
        backLabel: TRADING_BUTTON_COPY.backToTrade,
        retryAction: "sc:tr:live",
        skipRiskCheck: true,
      });
      break;
    }
    case "direct": {
      trackAction(userId, "直接操作", "sc:tr:direct");
      const directState = await fetchCapitalDirectOperationState();
      await editPanel(buildCapitalDirectOperationPanel(directState));
      break;
    }
    case "localexec": {
      trackAction(userId, "本地執行器", "sc:tr:localexec");
      const localExecutorState = await fetchCapitalLocalExecutorDispatchState();
      await editPanel(buildCapitalLocalExecutorDispatchPanel(localExecutorState));
      break;
    }
    case "armprofile": {
      trackAction(userId, "實單 Arm Profile", "sc:tr:armprofile");
      const armProfileState = await fetchCapitalLiveExecutorArmProfileState();
      await editPanel(buildCapitalLiveExecutorArmProfilePanel(armProfileState));
      break;
    }
    case "directrun": {
      trackAction(userId, "重跑直接Gate", "sc:tr:directrun");
      await executeSubagentTask(api, respond, {
        title: "直接操作 Gate",
        prompt: buildTradingOpsPrompt(
          "OpenClaw / Codex / Claude / Telegram 直接操作 Gate",
          [
            "pnpm capital:trade:direct",
            "pnpm capital:trade:direct:check",
            "pnpm capital:trade:direct:inputs",
            "pnpm capital:trade:direct:inputs:check",
            "pnpm capital:trade:direct:status",
            "pnpm capital:trade:direct:status:check",
            "pnpm capital:trade:operator-packet",
            "pnpm capital:trade:operator-packet:check",
            "pnpm capital:trade:platform",
            "pnpm capital:trade:platform:check",
            "pnpm capital-hft:hft-broker-dispatcher:check",
            "pnpm capital-hft:telegram-trading-shortcuts:check",
          ],
          "回報 capitalDirectOperationStatus、direct-operation input templates、operatorPacket.status、operatorCanExecute、strategyPlatform.liveCompletion、sealedOrderIntent.sha256、positionDecision.status、externalBrokerAdapter.ack.status、blocked reasons、no_live_order_sent。此入口是四端共用直接操作入口；OpenClaw 只產生封存意圖、模板與 adapter ack contract，不得由 Codex/Claude/OpenClaw/Telegram 直接持有券商寫入權限、不得繞過 ack/canary/rollback、不得送出未驗證真單。",
        ),
        backAction: "sc:trade",
        backLabel: TRADING_BUTTON_COPY.backToTrade,
        retryAction: "sc:tr:directrun",
        timeoutMs: 240_000,
        skipRiskCheck: true,
      });
      break;
    }
    case "directpos": {
      trackAction(userId, "重讀倉位Gate", "sc:tr:directpos");
      await executeSubagentTask(api, respond, {
        title: "倉位快照重讀 Gate",
        prompt: buildTradingOpsPrompt(
          "OpenClaw / Telegram verified position snapshot refresh readback",
          [
            "pnpm capital:trade:direct:status:check",
            "pnpm capital:trade:platform:check",
            "pnpm capital-hft:telegram-trading-shortcuts:check",
          ],
          "只重讀 operator-owned verified position snapshot，回報 positionDecision.status、freshnessStatus、verifiedAgeSeconds/maxFreshSeconds、sealedOrderIntent.sha256、externalBrokerAdapter.ack.status、operatorCanExecute、no_live_order_sent。不得建立或覆寫 active position snapshot、不得改 adapter ack、不得送出真單。",
        ),
        backAction: "sc:tr:direct",
        backLabel: TRADING_BUTTON_COPY.directOperate,
        retryAction: "sc:tr:directpos",
        timeoutMs: 180_000,
        skipRiskCheck: true,
      });
      break;
    }
    case "ackapply": {
      trackAction(userId, "Ack套用收據Gate", "sc:tr:ackapply");
      await executeSubagentTask(api, respond, {
        title: "Ack套用收據 Gate",
        prompt: buildTradingOpsPrompt(
          "OpenClaw / Telegram adapter ack apply receipt readback",
          [
            "pnpm capital:trade:adapter-ack-apply-verifier:check",
            "pnpm capital:trade:adapter-ack-apply-plan:check",
            "pnpm capital:trade:adapter-ack-apply-receipt:check",
            "pnpm capital:trade:adapter-ack:check",
            "pnpm capital:trade:post-apply-closure:check",
            "pnpm capital:trade:direct:check",
            "pnpm capital:trade:direct:status:check",
            "pnpm capital-hft:telegram-trading-shortcuts:check",
          ],
          "只重讀 operator-owned adapter ack verifier、apply plan、apply receipt、adapter ack 與 post-apply closure，回報 adapterApplyReceipt.status、operatorMayApply、operatorApplyVerified、activeState、expected/active/candidate hash、sealedOrderIntent.sha256、operatorCanExecute、noLiveOrderSent、remaining blockers、next task。不得複製 staged ack 到 active ack、不得建立或覆寫 active ack、不得 arm executor、不得送出真單。",
        ),
        backAction: "sc:tr:direct",
        backLabel: TRADING_BUTTON_COPY.directOperate,
        retryAction: "sc:tr:ackapply",
        timeoutMs: 180_000,
        skipRiskCheck: true,
      });
      break;
    }
    case "receipt": {
      trackAction(userId, "回關收據Gate", "sc:tr:receipt");
      await executeSubagentTask(api, respond, {
        title: "回關收據 Gate",
        prompt: buildTradingOpsPrompt(
          "OpenClaw / Telegram live auto-deactivate receipt gate readback",
          [
            "pnpm capital:live-trading:operator:auto-deactivate:receipt:check",
            "pnpm check:openclaw-controlled-task-runner-telegram-publish",
            "pnpm capital-hft:telegram-trading-shortcuts:check",
          ],
          "只重讀 live auto-deactivate receipt gate 與 Telegram publish token contract，回報 receiptPrompt.status、pendingExplicitExecuteReceipt、receiptVerified、heartbeatExecuteAllowed、noLiveOrderSent、sentOrder、messageTokenCounts.receiptPrompt、remaining blockers、next task。不得執行 auto-deactivate execute、不得 approve/activate/deactivate live、不得送出真單。",
        ),
        backAction: "sc:tr:direct",
        backLabel: TRADING_BUTTON_COPY.directOperate,
        retryAction: "sc:tr:receipt",
        timeoutMs: 180_000,
        skipRiskCheck: true,
      });
      break;
    }
    case "assist": {
      trackAction(userId, "模擬助手", "sc:tr:assist");
      const [assistantState, shortcutGateSummary] = await Promise.all([
        fetchCapitalPaperAssistantState(),
        fetchTelegramTradingShortcutsSummaryState(),
      ]);
      const assistantPanelState = assistantState
        ? { ...assistantState, shortcutGateSummary }
        : assistantState;
      await editPanel(buildCapitalPaperAssistantPanel(assistantPanelState));
      break;
    }
    default:
      await respond.editMessage({
        text: `❓ 未知交易操作: ${escapeHtml(sub ?? "")}`,
        buttons: [
          [
            { text: TRADING_BUTTON_COPY.backToTrade, callback_data: "sc:trade" },
            { text: "← 首頁", callback_data: "sc:home" },
          ],
        ],
      });
      break;
  }
}

function appendTradingActionReceipt(
  panel: InteractiveReply,
  actionLabel: string,
): InteractiveReply {
  const receiptTime = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  return {
    blocks: [
      {
        type: "text",
        text: `ℹ️ 已收到操作：${actionLabel}\n回執時間：${receiptTime}`,
      },
      ...panel.blocks,
    ],
  };
}

function normalizeLegacyTradingCallbackSub(sub: string | undefined): string | undefined {
  if (!sub) {
    return sub;
  }
  const normalized = sub.trim().toLowerCase();
  switch (normalized) {
    case "status":
    case "capital":
    case "capital_status":
      return "cap";
    default:
      return sub;
  }
}

function buildTradingOpsPrompt(title: string, commands: string[], outputRule: string): string {
  return (
    `請在 D:\\OpenClaw 執行「${title}」。\n` +
    "先確認 pwd 與 git rev-parse --show-toplevel 都是 D:\\OpenClaw。\n" +
    "依序執行：\n" +
    commands.map((cmd, index) => `${index + 1}. ${cmd}`).join("\n") +
    "\n" +
    `${outputRule}\n` +
    "最後用繁體中文回報：核心結論 / validation result / remaining blockers / next task。"
  );
}

function parseTradingOrderShortcut(
  param: string | undefined,
): { side: "buy" | "sell"; symbol: string; quantity: number } | null {
  if (!param) {
    return null;
  }
  const [sideRaw, symbolRaw, qtyRaw] = param.split("_");
  const side = sideRaw === "buy" || sideRaw === "sell" ? sideRaw : null;
  const symbol = (symbolRaw ?? "").trim().toUpperCase();
  const quantity = Number.parseInt(qtyRaw ?? "", 10);
  if (!side || !/^[A-Z0-9]{2,12}$/.test(symbol) || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }
  return {
    side,
    symbol,
    quantity: Math.min(quantity, 99),
  };
}

function parseFastOrderAuditQuery(param: string | undefined): {
  filter: string;
  offset: number;
  limit: number;
} {
  const allowedFilters = new Set(["all", "intent", "review", "paper", "denied"]);
  const [filterRaw, offsetRaw] = (param ?? "all_0").split("_");
  const filter = allowedFilters.has(filterRaw) ? filterRaw : "all";
  const offset = Number.parseInt(offsetRaw ?? "0", 10);
  return {
    filter,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
    limit: 5,
  };
}

async function fetchTradingPlatformSnapshot(
  api: OpenClawPluginApi,
): Promise<TradingSnapshotPanelState | null> {
  try {
    const snapshot = await withTimeout(
      callGatewayCompat<unknown>(api, "trading.snapshot"),
      RPC_TIMEOUT_MS,
      "trading.snapshot",
    );
    return isRecord(snapshot) ? (snapshot as TradingSnapshotPanelState) : null;
  } catch {
    return null;
  }
}

async function writeTradingFastOrderIntent(
  api: OpenClawPluginApi,
): Promise<TradingFastOrderIntentWriteState | null> {
  try {
    const result = await withTimeout(
      callGatewayCompat<unknown>(api, "trading.fastOrderIntent.write"),
      RPC_TIMEOUT_MS,
      "trading.fastOrderIntent.write",
    );
    if (isRecord(result)) {
      return result as TradingFastOrderIntentWriteState;
    }
    return {
      generatedAt: new Date().toISOString(),
      status: "gateway_invalid_response",
      source: "telegram.ai-platform",
      mode: "paper_only",
      brokerCommandEnabled: false,
      submissionCommand: "",
      sentBrokerOrder: false,
      blockers: ["gateway:invalid-response"],
      errorDetail: `gateway_invalid_response:${typeof result}`,
      retryCommand: "sc:tr:write",
      nextSafeTask: `Gateway 已回覆但格式不符合預期（${typeof result}），請檢查 trading.fastOrderIntent.write 回傳結構。`,
    };
  } catch (error) {
    const errorDetail = error instanceof Error ? error.message : "unknown_error";
    return {
      generatedAt: new Date().toISOString(),
      status: "gateway_unreachable",
      source: "telegram.ai-platform",
      mode: "paper_only",
      brokerCommandEnabled: false,
      submissionCommand: "",
      sentBrokerOrder: false,
      blockers: ["gateway:no-response"],
      errorDetail,
      retryCommand: "sc:tr:write",
      nextSafeTask: `請確認 Automation Gateway 連線後重試（${errorDetail}）。`,
    };
  }
}

async function reviewTradingFastOrderIntent(
  api: OpenClawPluginApi,
  decision: "approve_paper" | "deny",
): Promise<TradingFastOrderIntentReviewState | null> {
  const method =
    decision === "approve_paper"
      ? "trading.fastOrderIntent.approvePaper"
      : "trading.fastOrderIntent.deny";
  try {
    const result = await withTimeout(
      callGatewayCompat<unknown>(api, method),
      RPC_TIMEOUT_MS,
      method,
    );
    return isRecord(result) ? (result as TradingFastOrderIntentReviewState) : null;
  } catch {
    return null;
  }
}

function shouldBlockFastOrderApproveAndGuideWrite(
  reviewState: TradingFastOrderIntentReviewState | null,
): boolean {
  if (!isRecord(reviewState)) {
    return true;
  }
  const status =
    typeof reviewState.status === "string" ? reviewState.status.trim().toLowerCase() : "";
  const audit = isRecord(reviewState.audit) ? reviewState.audit : null;
  const blockers = Array.isArray(audit?.blockers)
    ? audit.blockers
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
    : [];
  if (
    blockers.includes("telegram-manual-review-required") ||
    blockers.includes("gateway:no-response") ||
    blockers.includes("gateway:invalid-response")
  ) {
    return true;
  }
  return status !== "paper_execution_recorded";
}

function buildFastOrderApproveWriteGuideMessage(
  reviewState: TradingFastOrderIntentReviewState | null,
): TelegramMessage {
  const statusText =
    isRecord(reviewState) && typeof reviewState.status === "string"
      ? reviewState.status
      : "unknown";
  const nextSafeTaskText =
    isRecord(reviewState) && typeof reviewState.nextSafeTask === "string"
      ? reviewState.nextSafeTask
      : "先按「✍️ 寫入審核票」，再按「✅ 核准模擬執行」。";
  return {
    text:
      "🧾 核准前檢查未通過\n" +
      "尚未取得可核准的審核票，請先按「✍️ 寫入審核票」。\n" +
      `目前狀態: ${statusText}\n` +
      `下一步: ${nextSafeTaskText}`,
    buttons: [
      [
        { text: TRADING_BUTTON_COPY.writeFastTicket, callback_data: "sc:tr:write" },
        { text: TRADING_BUTTON_COPY.auditTrail, callback_data: "sc:tr:audit" },
      ],
      [{ text: TRADING_BUTTON_COPY.backToTrade, callback_data: "sc:trade" }],
    ],
  };
}

async function fetchTradingFastOrderAuditSnapshot(
  api: OpenClawPluginApi,
  query: { filter: string; offset: number; limit: number },
): Promise<TradingFastOrderAuditSnapshotState | null> {
  try {
    const result = await withTimeout(
      callGatewayCompat<unknown>(api, "trading.fastOrderAudit.snapshot", query),
      RPC_TIMEOUT_MS,
      "trading.fastOrderAudit.snapshot",
    );
    return isRecord(result) ? (result as TradingFastOrderAuditSnapshotState) : null;
  } catch {
    return null;
  }
}

async function refreshTradingFastOrderLearningSnapshot(
  api: OpenClawPluginApi,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await withTimeout(
      callGatewayCompat<unknown>(api, "trading.fastOrderLearningSnapshot.refresh"),
      RPC_TIMEOUT_MS,
      "trading.fastOrderLearningSnapshot.refresh",
    );
    return isRecord(result) ? result : null;
  } catch {
    // paperloop UI 優先回傳審核結果；learning snapshot refresh 失敗時不阻塞流程。
    return null;
  }
}

/** 從 BrokerDesk 狀態檔讀取交易狀態 */
async function fetchTradingState(_api: OpenClawPluginApi): Promise<TradingState> {
  const ASSISTANT_STATE_MAX_AGE_MS = 45 * 60 * 1000;
  const defaultState: TradingState = {
    mode: "paper",
    connected: false,
    quoteStatus: "disconnected",
    positions: [],
    quotes: [],
    blockers: [],
  };

  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const stateDirs = resolveOpenClawStateDirCandidates(path);
    const candidateFiles = [
      "auto-trading-assistant-state.json",
      "capital-paper-assistant-state.json",
    ];
    let staleFallback: Record<string, unknown> | null = null;
    let staleFallbackAt = Number.NEGATIVE_INFINITY;

    for (const stateDir of stateDirs) {
      for (const fileName of candidateFiles) {
        const statePath = path.join(stateDir, "ui", fileName);
        if (!existsSync(statePath)) {
          continue;
        }
        const raw = JSON.parse(readFileSync(statePath, "utf8"));
        if (!isRecord(raw)) {
          continue;
        }
        const generatedAtMs = parseGeneratedAtMillis(raw.generatedAt);
        if (generatedAtMs !== null) {
          if (Date.now() - generatedAtMs <= ASSISTANT_STATE_MAX_AGE_MS) {
            return parseTradingStateFromFile(raw, defaultState);
          }
          if (generatedAtMs > staleFallbackAt) {
            staleFallbackAt = generatedAtMs;
            staleFallback = raw;
          }
          continue;
        }
        if (!staleFallback) {
          staleFallback = raw;
        }
      }
    }

    if (staleFallback) {
      return parseTradingStateFromFile(staleFallback, defaultState);
    }
  } catch {
    /* ignore — 回傳預設值 */
  }

  return defaultState;
}

function resolveOpenClawStateDirCandidates(pathMod: typeof import("node:path")): string[] {
  const dedup = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    dedup.add(pathMod.resolve(trimmed));
  };
  const explicitStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicitStateDir) {
    push(explicitStateDir);
    return [...dedup];
  }
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) {
    push(pathMod.dirname(process.env.OPENCLAW_CONFIG_PATH));
  }
  if (process.env.OPENCLAW_REPO_ROOT?.trim()) {
    push(pathMod.join(process.env.OPENCLAW_REPO_ROOT, ".openclaw"));
  }
  push(pathMod.join(process.cwd(), ".openclaw"));
  push(pathMod.join(process.env.HOME || process.env.USERPROFILE || ".", ".openclaw"));
  return [...dedup];
}

function parseGeneratedAtMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseTradingStateFromFile(
  raw: Record<string, unknown>,
  defaultState: TradingState,
): TradingState {
  const quoteStatus = resolveQuoteStatus(raw);
  const now = Date.now();
  const quotes = resolveQuotes(raw, quoteStatus, now);
  const quote = isRecord(raw.quote) ? raw.quote : null;
  const summary = isRecord(raw.summary) ? raw.summary : null;
  const diagnostics = quote && isRecord(quote.diagnostics) ? quote.diagnostics : null;
  const diagnosticBlockers = diagnostics?.blockers;
  return {
    mode: raw.mode === "live" ? "live" : "paper",
    connected:
      typeof raw.connected === "boolean"
        ? raw.connected
        : raw.ready === true ||
          quote?.ready === true ||
          summary?.quoteReady === true ||
          quoteStatus !== "disconnected",
    quoteStatus,
    positions: Array.isArray(raw.positions) ? raw.positions : defaultState.positions,
    quotes,
    blockers: Array.isArray(raw.blockers)
      ? raw.blockers
      : Array.isArray(diagnosticBlockers)
        ? diagnosticBlockers
        : defaultState.blockers,
    learningSummary:
      typeof raw.learningSummary === "string"
        ? raw.learningSummary
        : typeof quote?.nextSafeTask === "string"
          ? quote.nextSafeTask
          : defaultState.learningSummary,
  };
}

function resolveQuoteStatus(raw: Record<string, unknown>): TradingState["quoteStatus"] {
  const quote = isRecord(raw.quote) ? raw.quote : null;
  const summary = isRecord(raw.summary) ? raw.summary : null;
  const rawStatus =
    raw.quoteStatus ??
    summary?.quoteFreshnessStatus ??
    summary?.quoteStatus ??
    quote?.freshnessStatus ??
    quote?.status;
  const status = normalizeStatusText(rawStatus);
  if (status === "fresh" || status === "ready") {
    return "fresh";
  }
  if (status === "stale" || status === "session_closed" || status === "delayed") {
    return "stale";
  }
  return "disconnected";
}

function resolveQuotes(
  raw: Record<string, unknown>,
  quoteStatus: TradingState["quoteStatus"],
  now: number,
): QuoteStatus[] {
  const fromTopLevel = Array.isArray(raw.quotes)
    ? raw.quotes
        .map((item) => mapQuoteRecord(item, quoteStatus === "fresh", now))
        .filter((item): item is QuoteStatus => item !== null)
    : [];
  if (fromTopLevel.length > 0) {
    return fromTopLevel;
  }

  const quote = isRecord(raw.quote) ? raw.quote : null;
  const diagnostics = quote && isRecord(quote.diagnostics) ? quote.diagnostics : null;
  const latestQuote =
    diagnostics && isRecord(diagnostics.latestQuote) ? diagnostics.latestQuote : null;
  if (!latestQuote) {
    return [];
  }
  const normalized = mapQuoteRecord(
    {
      symbol: latestQuote.stockNo ?? quote?.latestStock,
      name: latestQuote.stockName ?? quote?.latestStockName,
      price: latestQuote.close ?? latestQuote.ask ?? latestQuote.bid,
      volume: latestQuote.qty,
      updatedAt: latestQuote.receivedAt ?? raw.generatedAt,
      fresh: quoteStatus === "fresh",
    },
    quoteStatus === "fresh",
    now,
  );
  return normalized ? [normalized] : [];
}

function mapQuoteRecord(
  value: unknown,
  fallbackFresh: boolean,
  fallbackTimestamp: number,
): QuoteStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const symbol = displayValue(value.symbol ?? value.stockNo ?? value.code).trim();
  if (!symbol) {
    return null;
  }
  const price = parseNumericValue(
    value.price ?? value.last ?? value.close ?? value.ask ?? value.bid,
  );
  const fresh = typeof value.fresh === "boolean" ? value.fresh : fallbackFresh;
  return {
    symbol,
    name: displayValue(value.name ?? value.stockName ?? value.displayName),
    price,
    change: parseNumericValue(value.change ?? value.delta, 0),
    changePercent: parseNumericValue(
      value.changePercent ?? value.deltaPercent ?? value.pctChange,
      0,
    ),
    volume: parseNumericValue(value.volume ?? value.qty ?? value.quantity, 0),
    updatedAt: parseTimestampValue(
      value.updatedAt ?? value.receivedAt ?? value.timestamp ?? value.time,
      fallbackTimestamp,
    ),
    fresh,
  };
}

function parseNumericValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    if (!normalized) {
      return fallback;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function parseTimestampValue(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeStatusText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  return "";
}

/** 取得策略狀態 */
async function fetchStrategyState(_api: OpenClawPluginApi): Promise<StrategyPanelState> {
  const state: StrategyPanelState = parseStrategyStateFromAssistant(
    readLatestAssistantStateForStrategy(),
  ) ?? {
    paperLoop: "stopped",
  };
  const fillSimulation = parseStrategyFillSimulationState(readStrategyFillSimulationState());
  if (fillSimulation) {
    Object.assign(state, fillSimulation);
  }
  const blockerSnapshot = parseStrategyBlockerSnapshot({
    quoteStatus: readOpenClawRepoJson([".openclaw", "quote", "capital-quote-status.json"]),
    reportableQuote: readOpenClawRepoJson([
      ".openclaw",
      "quote",
      "capital-reportable-quote-state.json",
    ]),
    tickDiagnostic: readOpenClawRepoJson([".openclaw", "quote", "capital-tick-diagnostic.json"]),
    learningSummary: readOpenClawRepoJson([
      ".openclaw",
      "trading",
      "capital-paper-learning-summary.json",
    ]),
    fullChain: await readOpenClawReportJson(
      "openclaw-capital-full-chain-simulation-gate-latest.json",
    ),
    livePromotion: await readOpenClawReportJson(
      "openclaw-capital-live-trading-promotion-gate-latest.json",
    ),
  });
  if (blockerSnapshot) {
    Object.assign(state, blockerSnapshot);
  }

  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const stateDir of resolveOpenClawStateDirCandidates(path)) {
      const watchPath = path.join(stateDir, "ui", "auto-trading-watch-state.json");
      if (!existsSync(watchPath)) {
        continue;
      }
      const raw = JSON.parse(readFileSync(watchPath, "utf8"));
      return {
        ...state,
        paperLoop:
          raw?.paperLoop === "running"
            ? "running"
            : raw?.paperLoop === "blocked"
              ? "blocked"
              : "stopped",
        blockReason: raw?.blockReason,
        lastSignal: raw?.lastSignal,
        lastSignalAt: raw?.lastSignalAt,
        winRate: raw?.winRate,
        totalTrades: raw?.totalTrades,
      };
    }
  } catch {
    /* ignore */
  }

  return state;
}

function readLatestAssistantStateForStrategy(): Record<string, unknown> | null {
  const ASSISTANT_STATE_MAX_AGE_MS = 45 * 60 * 1000;
  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const candidateFiles = [
      "auto-trading-assistant-state.json",
      "capital-paper-assistant-state.json",
    ];
    let staleFallback: Record<string, unknown> | null = null;
    let staleFallbackAt = Number.NEGATIVE_INFINITY;

    for (const stateDir of resolveOpenClawStateDirCandidates(path)) {
      for (const fileName of candidateFiles) {
        const statePath = path.join(stateDir, "ui", fileName);
        if (!existsSync(statePath)) {
          continue;
        }
        const raw = JSON.parse(readFileSync(statePath, "utf8"));
        if (!isRecord(raw)) {
          continue;
        }
        const generatedAtMs = parseGeneratedAtMillis(raw.generatedAt);
        if (generatedAtMs !== null) {
          if (Date.now() - generatedAtMs <= ASSISTANT_STATE_MAX_AGE_MS) {
            return raw;
          }
          if (generatedAtMs > staleFallbackAt) {
            staleFallbackAt = generatedAtMs;
            staleFallback = raw;
          }
          continue;
        }
        if (!staleFallback) {
          staleFallback = raw;
        }
      }
    }

    return staleFallback;
  } catch {
    return null;
  }
}

function readCapitalPaperAssistantUiState(): Record<string, unknown> | null {
  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const stateDir of resolveOpenClawStateDirCandidates(path)) {
      for (const fileName of [
        "capital-paper-assistant-state.json",
        "auto-trading-assistant-state.json",
      ]) {
        const statePath = path.join(stateDir, "ui", fileName);
        if (!existsSync(statePath)) {
          continue;
        }
        const raw = JSON.parse(readFileSync(statePath, "utf8"));
        if (isRecord(raw)) {
          const watchPath = path.join(stateDir, "ui", "auto-trading-watch-state.json");
          if (!existsSync(watchPath)) {
            return raw;
          }
          const watchRaw = JSON.parse(readFileSync(watchPath, "utf8"));
          if (!isRecord(watchRaw) || !isRecord(watchRaw.telegramPaperLoopLearningRefresh)) {
            return raw;
          }
          return {
            ...raw,
            telegramPaperLoopLearningRefresh: watchRaw.telegramPaperLoopLearningRefresh,
          };
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function parseStrategyStateFromAssistant(
  raw: Record<string, unknown> | null,
): StrategyPanelState | null {
  if (!raw) {
    return null;
  }
  const summary = isRecord(raw.summary) ? raw.summary : null;
  const chartStrategy = isRecord(raw.chartStrategy) ? raw.chartStrategy : null;
  const chartData =
    chartStrategy && isRecord(chartStrategy.chartData) ? chartStrategy.chartData : null;
  const strategyBook =
    chartStrategy && isRecord(chartStrategy.strategyBook) ? chartStrategy.strategyBook : null;
  const simulation =
    chartStrategy && isRecord(chartStrategy.simulation) ? chartStrategy.simulation : null;
  const safety = chartStrategy && isRecord(chartStrategy.safety) ? chartStrategy.safety : null;
  const loop = isRecord(raw.loop) ? raw.loop : null;
  const recommendation = isRecord(raw.recommendation) ? raw.recommendation : null;
  const liveTradingEnabled = raw.liveTradingEnabled === true;
  const writeTradingEnabled = raw.writeTradingEnabled === true;
  const brokerOrderPathEnabled = raw.brokerOrderPathEnabled === true;

  return {
    paperLoop:
      raw.status === "ready" || raw.ready === true
        ? "running"
        : loop?.status || raw.status
          ? "blocked"
          : "stopped",
    blockReason: displayValue(loop?.status ?? raw.status, "unknown"),
    chartStrategyStatus: displayValue(
      chartStrategy?.status ?? summary?.chartStrategyStatus,
      chartStrategy ? "unknown" : "",
    ),
    chartDataReady: boolValue(chartData?.ready ?? summary?.chartDataReady),
    strategyBookReady: boolValue(strategyBook?.ready ?? summary?.strategyBookReady),
    strategyCount: optionalNumber(strategyBook?.strategyCount ?? summary?.strategyCount),
    enabledStrategyCount: optionalNumber(
      strategyBook?.enabledStrategyCount ?? summary?.enabledStrategyCount,
    ),
    simulationStatus: displayValue(simulation?.status, ""),
    simulationWinRate: optionalNumber(simulation?.winRate ?? simulation?.fillRate),
    simulationPaperIntentCount: optionalNumber(
      simulation?.paperIntentCount ?? simulation?.paperIntents,
    ),
    realQuoteVerified: boolValue(simulation?.realQuoteVerified),
    brokerWriteLocked: boolValue(safety?.brokerWriteLocked ?? !brokerOrderPathEnabled),
    liveOrderAllowed: liveTradingEnabled && writeTradingEnabled && brokerOrderPathEnabled,
    nextSafeTask: displayValue(
      recommendation?.nextSafeTask ?? loop?.nextSafeTask ?? raw.nextSafeTask,
      "",
    ),
  };
}

function readStrategyFillSimulationState(): Record<string, unknown> | null {
  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const repoRoot of resolveOpenClawRepoRootCandidates(path)) {
      const fillSimulationPath = path.join(
        repoRoot,
        ".openclaw",
        "trading",
        "capital-strategy-fill-simulation.json",
      );
      if (!existsSync(fillSimulationPath)) {
        continue;
      }
      const raw = JSON.parse(readFileSync(fillSimulationPath, "utf8"));
      return isRecord(raw) ? raw : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function parseStrategyFillSimulationState(
  raw: Record<string, unknown> | null,
): Partial<StrategyPanelState> | null {
  if (!raw) {
    return null;
  }
  const stats = isRecord(raw.stats) ? raw.stats : null;
  const monteCarlo = isRecord(raw.monteCarlo) ? raw.monteCarlo : null;
  const safetyLock = isRecord(raw.safetyLock) ? raw.safetyLock : null;
  return {
    fillSimulationStatus: displayValue(raw.status, ""),
    fillRecommendation: displayValue(raw.recommendation, ""),
    fillTotalIntents: optionalNumber(stats?.total_intents ?? stats?.totalIntents),
    fillFilledCount: optionalNumber(stats?.filled_count ?? stats?.filledCount),
    fillRate: optionalNumber(stats?.fill_rate ?? stats?.fillRate),
    fillWinRate: optionalNumber(stats?.win_rate ?? stats?.winRate),
    expectedValuePts: optionalNumber(stats?.expected_value_pts ?? stats?.expectedValuePts),
    monteCarloP05Pts: optionalNumber(monteCarlo?.p05_total_pnl_pts ?? monteCarlo?.p05TotalPnlPts),
    monteCarloP50Pts: optionalNumber(monteCarlo?.p50_total_pnl_pts ?? monteCarlo?.p50TotalPnlPts),
    monteCarloP95Pts: optionalNumber(monteCarlo?.p95_total_pnl_pts ?? monteCarlo?.p95TotalPnlPts),
    monteCarloPositiveRate: optionalNumber(monteCarlo?.positive_rate ?? monteCarlo?.positiveRate),
    fillPaperOnly: boolValue(safetyLock?.paperOnly),
    fillExecutionEligible: boolValue(safetyLock?.executionEligible),
    fillPromotionBlocked: boolValue(safetyLock?.promotionBlocked),
  };
}

function parseStrategyBlockerSnapshot(raw: {
  quoteStatus: Record<string, unknown> | null;
  reportableQuote: Record<string, unknown> | null;
  tickDiagnostic: Record<string, unknown> | null;
  learningSummary: Record<string, unknown> | null;
  fullChain: Record<string, unknown> | null;
  livePromotion: Record<string, unknown> | null;
}): Partial<StrategyPanelState> | null {
  if (
    !raw.quoteStatus &&
    !raw.reportableQuote &&
    !raw.tickDiagnostic &&
    !raw.learningSummary &&
    !raw.fullChain &&
    !raw.livePromotion
  ) {
    return null;
  }

  const quoteProof = isRecord(raw.quoteStatus?.quoteProof) ? raw.quoteStatus.quoteProof : null;
  const quoteDiagnostics = isRecord(raw.quoteStatus?.diagnostics)
    ? raw.quoteStatus.diagnostics
    : null;
  const selectedStock =
    quoteDiagnostics && isRecord(quoteDiagnostics.selectedStock)
      ? quoteDiagnostics.selectedStock
      : null;
  const reportableSummary = isRecord(raw.reportableQuote?.summary)
    ? raw.reportableQuote.summary
    : null;
  const blockedCounts = isRecord(reportableSummary?.blockedCategoryCounts)
    ? reportableSummary.blockedCategoryCounts
    : null;
  const blockedCategory = blockedCounts ? Object.keys(blockedCounts)[0] : "";
  const firstBlockedQuote = firstRecord(raw.reportableQuote?.blockedQuotes);
  const firstBlockedEvent =
    firstBlockedQuote && isRecord(firstBlockedQuote.lastEvent) ? firstBlockedQuote.lastEvent : null;
  const tick = isRecord(raw.tickDiagnostic?.tick) ? raw.tickDiagnostic.tick : null;
  const monitorFreshness = isRecord(raw.tickDiagnostic?.monitorFreshness)
    ? raw.tickDiagnostic.monitorFreshness
    : null;
  const realtimeFreshness = isRecord(raw.tickDiagnostic?.realtimeFreshness)
    ? raw.tickDiagnostic.realtimeFreshness
    : null;
  const latestCallback = isRecord(raw.tickDiagnostic?.latestCallback)
    ? raw.tickDiagnostic.latestCallback
    : null;
  const learningSummary = isRecord(raw.learningSummary?.summary)
    ? raw.learningSummary.summary
    : null;
  const registry = isRecord(raw.learningSummary?.registry) ? raw.learningSummary.registry : null;
  const counters = isRecord(registry?.counters) ? registry.counters : null;
  const fullChainSummary = isRecord(raw.fullChain?.summary) ? raw.fullChain.summary : null;

  return {
    quoteGateStatus: displayValue(raw.quoteStatus?.status ?? quoteProof?.freshnessStatus, ""),
    quoteLatestStock: displayValue(
      quoteProof?.latestStock ?? selectedStock?.targetStockNo ?? latestCallback?.stockNo,
      "",
    ),
    quoteFreshnessAgeSeconds: optionalNumber(
      quoteProof?.freshnessAgeSeconds ?? realtimeFreshness?.ageSeconds,
    ),
    quoteMaxAllowedFreshAgeSeconds: optionalNumber(
      quoteProof?.maxAllowedFreshAgeSeconds ??
        quoteProof?.maxFreshSeconds ??
        realtimeFreshness?.maxFreshSeconds,
    ),
    quoteReportableStatus: displayValue(raw.reportableQuote?.status, ""),
    quoteReportableCount: optionalNumber(reportableSummary?.reportableCount),
    quoteBlockedCount: optionalNumber(reportableSummary?.blockedCount),
    quoteBlockedCategory: displayValue(firstBlockedQuote?.blockedCategory ?? blockedCategory, ""),
    quoteBlockedReason: displayValue(firstBlockedQuote?.reason ?? firstBlockedQuote?.diagnosis, ""),
    quoteUnblockCondition: displayValue(firstBlockedQuote?.unblockCondition, ""),
    quoteServiceAlive: boolValue(monitorFreshness?.running ?? tick?.monitorRunning),
    quoteRealtimeRunning: boolValue(realtimeFreshness?.running ?? tick?.realtimeRunning),
    quoteLatestCallbackAt: displayValue(
      latestCallback?.receivedAt ?? firstBlockedEvent?.receivedAt,
      "",
    ),
    learningStatus: displayValue(raw.learningSummary?.status, ""),
    learningPaperEligible: boolValue(raw.learningSummary?.paperEligible),
    consecutiveReadinessBlocks: optionalNumber(
      learningSummary?.consecutiveReadinessBlocks ?? counters?.consecutiveReadinessBlocks,
    ),
    latestQuoteAgeSeconds: optionalNumber(learningSummary?.latestQuoteAgeSeconds),
    fullChainStatus: displayValue(raw.fullChain?.status, ""),
    fullChainStageFailedCount: optionalNumber(fullChainSummary?.stageFailedCount),
    fullChainFaultFailedCount: optionalNumber(fullChainSummary?.faultFailedCount),
    fullChainBlockers: stringArray(raw.fullChain?.blockers),
    livePromotionStatus: displayValue(raw.livePromotion?.status, ""),
    livePromotionBlockerCode: displayValue(raw.livePromotion?.blockerCode, ""),
    livePromotionBlockers: stringArray(raw.livePromotion?.blockers),
    readyForManualReview: boolValue(raw.livePromotion?.readyForManualReview),
  };
}

function readOpenClawRepoJson(relativePath: string[]): Record<string, unknown> | null {
  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const repoRoot of resolveOpenClawRepoRootCandidates(path)) {
      const filePath = path.join(repoRoot, ...relativePath);
      if (!existsSync(filePath)) {
        continue;
      }
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      return isRecord(raw) ? raw : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function fetchCapitalServiceStatusState(): Promise<CapitalServiceStatusState | null> {
  const raw = await readOpenClawReportJson("openclaw-capital-service-status-latest.json");
  return isRecord(raw) ? (raw as CapitalServiceStatusState) : null;
}

async function fetchCapitalDirectOperationState(): Promise<CapitalDirectOperationState | null> {
  const [
    statusReport,
    inputsReport,
    operatorPacketReport,
    adapterAckGateReport,
    localExecutorDispatchReport,
    liveExecutorArmProfileReport,
    autoDeactivateReceiptGateReport,
    strategyPlatformReport,
    adapterAckApplyVerifierReport,
    adapterAckApplyPlanReport,
    adapterAckApplyReceiptReport,
    postApplyClosureReport,
  ] = await Promise.all([
    readOpenClawReportJson("openclaw-capital-direct-operation-status-latest.json"),
    readOpenClawReportJson("openclaw-capital-direct-operation-inputs-latest.json"),
    readOpenClawReportJson("openclaw-capital-live-operator-execution-packet-latest.json"),
    readOpenClawReportJson("openclaw-capital-external-broker-adapter-ack-gate-latest.json"),
    readOpenClawReportJson("openclaw-capital-local-broker-executor-dispatch-contract-latest.json"),
    readOpenClawReportJson("openclaw-capital-live-executor-arm-profile-latest.json"),
    readOpenClawReportJson(
      "openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json",
    ),
    readOpenClawReportJson("openclaw-capital-direct-strategy-platform-gate-latest.json"),
    readOpenClawReportJson("openclaw-capital-adapter-ack-operator-apply-verifier-latest.json"),
    readOpenClawReportJson("openclaw-capital-adapter-ack-operator-apply-plan-latest.json"),
    readOpenClawReportJson("openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json"),
    readOpenClawReportJson("openclaw-capital-post-apply-live-closure-gate-latest.json"),
  ]);
  const status = isRecord(statusReport) ? statusReport : null;
  const inputs = isRecord(inputsReport) ? inputsReport : null;
  const operatorPacket = isRecord(operatorPacketReport) ? operatorPacketReport : null;
  const adapterAckGate = isRecord(adapterAckGateReport) ? adapterAckGateReport : null;
  const localExecutorDispatch = isRecord(localExecutorDispatchReport)
    ? localExecutorDispatchReport
    : null;
  const liveExecutorArmProfile = isRecord(liveExecutorArmProfileReport)
    ? liveExecutorArmProfileReport
    : null;
  const autoDeactivateReceiptGate = isRecord(autoDeactivateReceiptGateReport)
    ? autoDeactivateReceiptGateReport
    : null;
  const strategyPlatform = isRecord(strategyPlatformReport) ? strategyPlatformReport : null;
  const adapterAckApplyVerifier = isRecord(adapterAckApplyVerifierReport)
    ? adapterAckApplyVerifierReport
    : null;
  const adapterAckApplyPlan = isRecord(adapterAckApplyPlanReport)
    ? adapterAckApplyPlanReport
    : null;
  const adapterAckApplyReceipt = isRecord(adapterAckApplyReceiptReport)
    ? adapterAckApplyReceiptReport
    : null;
  const postApplyClosure = isRecord(postApplyClosureReport) ? postApplyClosureReport : null;
  if (
    !status &&
    !inputs &&
    !operatorPacket &&
    !adapterAckGate &&
    !localExecutorDispatch &&
    !liveExecutorArmProfile &&
    !autoDeactivateReceiptGate &&
    !strategyPlatform &&
    !adapterAckApplyVerifier &&
    !adapterAckApplyPlan &&
    !adapterAckApplyReceipt &&
    !postApplyClosure
  ) {
    return null;
  }
  if (inputs) {
    return {
      ...inputs,
      statusReport: status,
      inputsReport: inputs,
      operatorPacketReport: operatorPacket,
      adapterAckGateReport: adapterAckGate,
      localExecutorDispatchReport: localExecutorDispatch,
      liveExecutorArmProfileReport: liveExecutorArmProfile,
      autoDeactivateReceiptGateReport: autoDeactivateReceiptGate,
      strategyPlatformReport: strategyPlatform,
      adapterAckApplyVerifierReport: adapterAckApplyVerifier,
      adapterAckApplyPlanReport: adapterAckApplyPlan,
      adapterAckApplyReceiptReport: adapterAckApplyReceipt,
      postApplyClosureReport: postApplyClosure,
    } as CapitalDirectOperationState;
  }
  const summary = isRecord(status?.summary) ? status.summary : null;
  const sealedIntent = isRecord(summary?.sealedOrderIntent) ? summary.sealedOrderIntent : null;
  return {
    generatedAt: status?.generatedAt,
    status: status?.status,
    requestedTrade: summary?.requestedTrade,
    sealedIntentSha256: sealedIntent?.sha256,
    safety: summary?.safety,
    nextSafeTask: status?.nextSafeTask,
    statusReport: status,
    operatorPacketReport: operatorPacket,
    adapterAckGateReport: adapterAckGate,
    localExecutorDispatchReport: localExecutorDispatch,
    liveExecutorArmProfileReport: liveExecutorArmProfile,
    autoDeactivateReceiptGateReport: autoDeactivateReceiptGate,
    strategyPlatformReport: strategyPlatform,
    adapterAckApplyVerifierReport: adapterAckApplyVerifier,
    adapterAckApplyPlanReport: adapterAckApplyPlan,
    adapterAckApplyReceiptReport: adapterAckApplyReceipt,
    postApplyClosureReport: postApplyClosure,
  } as CapitalDirectOperationState;
}

async function fetchCapitalLocalExecutorDispatchState(): Promise<CapitalLocalExecutorDispatchState | null> {
  const raw = await readOpenClawReportJson(
    "openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
  );
  return isRecord(raw) ? (raw as CapitalLocalExecutorDispatchState) : null;
}

async function fetchCapitalLiveExecutorArmProfileState(): Promise<CapitalLiveExecutorArmProfileState | null> {
  const raw = await readOpenClawReportJson(
    "openclaw-capital-live-executor-arm-profile-latest.json",
  );
  return isRecord(raw) ? (raw as CapitalLiveExecutorArmProfileState) : null;
}

async function fetchTelegramTradingShortcutsSummaryState(): Promise<TelegramTradingShortcutsSummaryState | null> {
  const [
    raw,
    okxHeartbeatOperation,
    okxRefreshWorkflow,
    telegramPublishReport,
    capitalHighConfidencePaperRerunReport,
    capitalStrategyPlatformReport,
  ] = await Promise.all([
    readOpenClawReportJson("openclaw-telegram-trading-shortcuts-latest.json"),
    readOpenClawReportJson("openclaw-okx-current-readiness-heartbeat-operation-latest.json"),
    readOpenClawReportJson("openclaw-okx-current-readiness-refresh-workflow-latest.json"),
    readOpenClawReportJson("openclaw-controlled-task-runner-telegram-publish-latest.json"),
    readOpenClawReportJson("openclaw-capital-high-confidence-paper-rerun-gate-latest.json"),
    readOpenClawReportJson("openclaw-capital-direct-strategy-platform-gate-latest.json"),
  ]);
  if (!isRecord(raw)) {
    return null;
  }
  const summary = isRecord(raw.summary) ? raw.summary : {};
  return {
    ...raw,
    summary: {
      ...summary,
      ...(isRecord(okxRefreshWorkflow)
        ? {
            okxCurrentReadinessRefreshWorkflowClosure:
              buildOkxCurrentReadinessRefreshWorkflowClosure(
                okxRefreshWorkflow,
                isRecord(okxHeartbeatOperation) ? okxHeartbeatOperation : undefined,
              ),
          }
        : {}),
      ...(isRecord(okxHeartbeatOperation)
        ? {
            okxCurrentReadinessHeartbeatOperationClosure:
              buildOkxCurrentReadinessHeartbeatOperationClosure(okxHeartbeatOperation),
          }
        : {}),
      ...(isRecord(telegramPublishReport)
        ? {
            okxHeartbeatPublishTokenCountClosure:
              buildOkxHeartbeatPublishTokenCountClosure(telegramPublishReport),
          }
        : {}),
      ...(isRecord(capitalHighConfidencePaperRerunReport)
        ? {
            capitalHighConfidencePaperRerunClosure: buildCapitalHighConfidencePaperRerunClosure(
              capitalHighConfidencePaperRerunReport,
            ),
          }
        : {}),
      ...(isRecord(capitalStrategyPlatformReport)
        ? {
            capitalVerifiedPositionSnapshotClosure: buildCapitalVerifiedPositionSnapshotClosure(
              capitalStrategyPlatformReport,
            ),
          }
        : {}),
    },
  } as TelegramTradingShortcutsSummaryState;
}

function buildCapitalVerifiedPositionSnapshotClosure(
  report: Record<string, unknown>,
): Record<string, unknown> {
  const positionDecision = isRecord(report.positionDecision) ? report.positionDecision : {};
  const execution = isRecord(report.execution) ? report.execution : {};
  const activeTargets = isRecord(execution.activeTargets) ? execution.activeTargets : {};
  const activeSnapshot = isRecord(activeTargets.verifiedPositionSnapshot)
    ? activeTargets.verifiedPositionSnapshot
    : {};
  const safety = isRecord(report.safety) ? report.safety : {};
  const verifiedAgeSeconds = numericCountValue(
    positionDecision.verifiedAgeSeconds ?? activeSnapshot.verifiedAgeSeconds,
  );
  const maxFreshSeconds = numericCountValue(
    positionDecision.maxFreshSeconds ?? activeSnapshot.maxFreshSeconds ?? 43200,
  );
  const freshnessStatus = displayValue(
    positionDecision.freshnessStatus ?? activeSnapshot.freshnessStatus,
    "unknown",
  );
  const decisionStatus = displayValue(positionDecision.decisionStatus, "unknown");
  const usable =
    boolValue(positionDecision.usable) === true || boolValue(activeSnapshot.usable) === true;
  const fresh =
    usable &&
    freshnessStatus === "fresh" &&
    (maxFreshSeconds <= 0 || verifiedAgeSeconds <= maxFreshSeconds);
  const noOrderWrite =
    boolValue(safety.noLiveOrderSent) === true ||
    boolValue(safety.no_live_order_sent) === true ||
    safety.writeBrokerOrders === false ||
    boolValue(execution.noLiveOrderSent) === true;
  const sentOrder = boolValue(safety.sentOrder) === true || boolValue(execution.sentOrder) === true;
  const status = fresh ? "fresh_verified" : "stale_operator_refresh_required";
  const path = displayValue(positionDecision.path ?? activeSnapshot.path, "missing");
  const machineLine = [
    `capitalVerifiedPositionSnapshot=${status}`,
    `decision=${decisionStatus}`,
    `freshness=${freshnessStatus}`,
    `age=${verifiedAgeSeconds}`,
    `maxFresh=${maxFreshSeconds}`,
    `hasOpenPosition=${boolValue(positionDecision.hasOpenPosition) === true}`,
    `net=${displayValue(positionDecision.netContracts, "0")}`,
    `path=${path}`,
    `next=operator_refresh_snapshot_then_pnpm_capital_trade_direct_status_check`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(";");
  return {
    status,
    reportRead: true,
    usable,
    decisionStatus,
    freshnessStatus,
    verifiedAgeSeconds,
    maxFreshSeconds,
    hasOpenPosition: boolValue(positionDecision.hasOpenPosition) === true,
    netContracts: positionDecision.netContracts ?? 0,
    path,
    nextCommand: "pnpm capital:trade:direct:status:check",
    noOrderWrite,
    sentOrder,
    machineLine,
  };
}

function buildCapitalHighConfidencePaperRerunClosure(
  report: Record<string, unknown>,
): Record<string, unknown> {
  const confidenceGate = isRecord(report.confidenceGate) ? report.confidenceGate : {};
  const safetyLock = isRecord(report.safetyLock) ? report.safetyLock : {};
  const machineLine = displayValue(report.machineLine, "");
  const candidates = Array.isArray(report.candidates) ? report.candidates.filter(isRecord) : [];
  const candidateSymbols = candidates
    .map((candidate) => displayValue(candidate.symbol, ""))
    .filter((symbol) => symbol.length > 0);
  const passCount = numericCountValue(report.passCount);
  const blockedCount = numericCountValue(report.blockedCount);
  const noOrderWrite =
    boolValue(report.noOrderWrite) === true ||
    boolValue(safetyLock.noLiveOrderSent) === true ||
    safetyLock.writeBrokerOrders === false ||
    machineLine.includes("noOrderWrite=true");
  const sentOrder =
    boolValue(safetyLock.sentOrder) === true || machineLine.includes("sentOrder=true");
  const reportRead = report.schema === "openclaw.capital.high-confidence-paper-rerun-gate.v1";
  const status =
    reportRead && noOrderWrite && !sentOrder && passCount === 0
      ? "visible_blocked"
      : reportRead && noOrderWrite && !sentOrder && passCount > 0
        ? "visible_passed"
        : "blocked";
  return {
    status,
    reportRead,
    gateStatus: displayValue(report.status, "unknown"),
    threshold: optionalNumber(confidenceGate.threshold),
    requiredConfidence: optionalNumber(confidenceGate.requiredConfidenceForPositiveP05),
    requiredConfidenceStatus: displayValue(confidenceGate.requiredConfidenceStatus, "unknown"),
    candidateCount: candidateSymbols.length,
    candidateSymbols,
    passCount,
    blockedCount,
    blockers: stringArray(report.blockers).slice(0, 10),
    noOrderWrite,
    sentOrder,
    reportPath:
      "reports/hermes-agent/state/openclaw-capital-high-confidence-paper-rerun-gate-latest.json",
    machineLine:
      machineLine ||
      [
        `highConfidencePaperRerun=${displayValue(report.status, "missing")}`,
        `threshold=${displayValue(confidenceGate.threshold, "missing")}`,
        `requiredConfidence=${displayValue(
          confidenceGate.requiredConfidenceForPositiveP05,
          "missing",
        )}`,
        `candidates=${candidateSymbols.join("|") || "none"}`,
        `pass=${passCount}`,
        `blocked=${blockedCount}`,
        `noOrderWrite=${noOrderWrite}`,
      ].join(";"),
  };
}

function buildOkxCurrentReadinessRefreshWorkflowClosure(
  report: Record<string, unknown>,
  heartbeatOperation?: Record<string, unknown>,
): Record<string, unknown> {
  const safety = isRecord(report.safety) ? report.safety : {};
  const steps = Array.isArray(report.steps) ? report.steps.filter(isRecord) : [];
  const totalSteps = steps.length;
  const passedSteps = steps.filter((step) => displayValue(step.status) === "pass").length;
  const failedSteps = steps
    .filter((step) => displayValue(step.status) !== "pass")
    .map((step) => displayValue(step.id, "unknown"));
  const refreshRun = isRecord(heartbeatOperation?.refreshRun)
    ? heartbeatOperation.refreshRun
    : null;
  return {
    status: displayValue(report.status, "unknown"),
    code: displayValue(report.code, "unknown"),
    callbackPair: ["sc:tr:okxrefresh", "sc:tr:assist"],
    totalSteps,
    passedSteps,
    failedSteps,
    latestRefreshRunStatus: refreshRun
      ? displayValue(refreshRun.status, "unknown")
      : "skipped_not_needed",
    latestRefreshRunExitCode: refreshRun ? displayValue(refreshRun.exitCode, "null") : "null",
    noOrderWrite: boolValue(safety.noOrderWrite),
    reportPath:
      "reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json",
    machineLine: displayValue(report.machineLine, ""),
  };
}

function buildOkxCurrentReadinessHeartbeatOperationClosure(
  report: Record<string, unknown>,
): Record<string, unknown> {
  const action = isRecord(report.action) ? report.action : {};
  const safety = isRecord(report.safety) ? report.safety : {};
  const reports = isRecord(report.reports) ? report.reports : {};
  const currentReadiness = isRecord(reports.currentReadiness) ? reports.currentReadiness : {};
  const inventoryProbe = isRecord(reports.inventoryProbe) ? reports.inventoryProbe : {};
  const inventoryProbeMachineLine = displayValue(inventoryProbe.machineLine, "");
  const inventoryProbeReady =
    boolValue(inventoryProbe.ready) === true ||
    inventoryProbeMachineLine.includes("okxInventoryProbe=pass");
  const inventoryProbeNoOrderWrite =
    boolValue(inventoryProbe.noOrderWrite) === true ||
    inventoryProbeMachineLine.includes("noOrderWrite=true");
  const publishBridgeStatus = isRecord(inventoryProbe.publishBridgeStatus)
    ? inventoryProbe.publishBridgeStatus
    : {};
  const publishBridgeMachineLine = displayValue(publishBridgeStatus.machineLine, "");
  const publishBridgeStatusReady =
    boolValue(publishBridgeStatus.ready) === true ||
    publishBridgeMachineLine.includes("publishBridge=pass");
  const upstreamNoOrderWriteVerified =
    boolValue(publishBridgeStatus.upstreamNoOrderWriteVerified) === true ||
    publishBridgeMachineLine.includes("upstreamNoOrderWriteVerified=true");
  const upstreamDmadGateVerified =
    boolValue(publishBridgeStatus.upstreamDmadGateVerified) === true ||
    publishBridgeMachineLine.includes("upstreamDmadGateVerified=true");
  const upstreamOkxContractVerified =
    boolValue(publishBridgeStatus.upstreamOkxContractVerified) === true ||
    publishBridgeMachineLine.includes("upstreamOkxContractVerified=true");
  const sourceMachineLine = displayValue(report.machineLine, "");
  const schedulerNextRunAt =
    displayValue(currentReadiness.schedulerNextRunAt, "") ||
    (sourceMachineLine.match(/\bschedulerNextRunAt=([^\s]+)/u)?.[1] ?? "");
  return {
    status: displayValue(report.status, "unknown"),
    code: displayValue(report.code, "unknown"),
    callbackPair: ["sc:tr:okxrefresh", "sc:tr:assist"],
    telegramCallback: displayValue(action.telegramCallback, "sc:tr:okxrefresh"),
    refreshCommand: displayValue(action.refreshCommand, "pnpm okx:current-readiness:refresh"),
    heartbeatCommand: displayValue(action.heartbeatCommand, "pnpm okx:current-readiness:heartbeat"),
    executeCommand: displayValue(
      action.executeCommand,
      "pnpm okx:current-readiness:heartbeat:execute",
    ),
    oneClickRefresh: boolValue(action.oneClickRefresh),
    executeRequired: boolValue(action.executeRequired),
    noOrderWrite: boolValue(safety.noOrderWrite),
    inventoryProbeStatus: displayValue(
      inventoryProbe.status,
      inventoryProbeReady ? "ready" : "unknown",
    ),
    inventoryProbeReady,
    inventoryProbeNoOrderWrite,
    inventoryProbeMachineLine,
    publishBridgeStatusReady,
    publishBridgeMachineLine,
    upstreamNoOrderWriteVerified,
    upstreamOkxContractVerified,
    upstreamDmadGateVerified,
    upstreamNoOrderWriteCount: optionalNumber(publishBridgeStatus.upstreamNoOrderWriteCount),
    upstreamExecuteRequiredCount: optionalNumber(publishBridgeStatus.upstreamExecuteRequiredCount),
    upstreamOkxContractCount: optionalNumber(publishBridgeStatus.upstreamOkxContractCount),
    upstreamDmadGateCount: optionalNumber(publishBridgeStatus.upstreamDmadGateCount),
    upstreamMessageTokenCountsSummaryZhTw: displayValue(
      publishBridgeStatus.upstreamMessageTokenCountsSummaryZhTw,
      "",
    ),
    schedulerNextRunAt,
    nextSafeTask: displayValue(report.nextSafeTask, ""),
    reportPath:
      "reports/hermes-agent/state/openclaw-okx-current-readiness-heartbeat-operation-latest.json",
    machineLine: sourceMachineLine,
  };
}

function numericCountValue(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

function buildOkxHeartbeatPublishTokenCountClosure(
  report: Record<string, unknown>,
): Record<string, unknown> {
  const counts = isRecord(report.messageTokenCounts) ? report.messageTokenCounts : {};
  const summaryZhTw = displayValue(report.messageTokenCountsSummaryZhTw, "");
  const okxRefresh = numericCountValue(counts.okxRefresh);
  const okxHeartbeat = numericCountValue(counts.okxHeartbeat);
  const okxContract = numericCountValue(counts.okxContract);
  const localExecutorDispatch = numericCountValue(counts.localExecutorDispatch);
  const positionSnapshot = numericCountValue(counts.positionSnapshot);
  const executeRequired = numericCountValue(counts.executeRequired);
  const noOrderWriteCount = numericCountValue(counts.noOrderWrite);
  const noOrderWrite = noOrderWriteCount === 4 && summaryZhTw.includes("noOrderWrite=true=4");
  const status =
    okxRefresh === 1 &&
    okxHeartbeat === 1 &&
    okxContract === 1 &&
    localExecutorDispatch === 1 &&
    positionSnapshot === 1 &&
    executeRequired === 1 &&
    noOrderWrite
      ? "ready"
      : "blocked";
  const reportPath =
    "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json";
  const machineLine = [
    `okxHeartbeatPublishTokenCounts=${status === "ready" ? "pass" : "fail"}`,
    `okxRefresh=${okxRefresh}`,
    `okxHeartbeat=${okxHeartbeat}`,
    `okxContract=${okxContract}`,
    `localExecutorDispatch=${localExecutorDispatch}`,
    `positionSnapshot=${positionSnapshot}`,
    `executeRequired=${executeRequired}`,
    `noOrderWriteCount=${noOrderWriteCount}`,
    `summary=${summaryZhTw.length > 0 ? "present" : "missing"}`,
    `report=${reportPath}`,
    `noOrderWrite=${noOrderWrite}`,
  ].join(" ");
  return {
    status,
    messageTokenCounts: {
      okxRefresh,
      okxHeartbeat,
      okxContract,
      localExecutorDispatch,
      positionSnapshot,
      executeRequired,
      noOrderWrite: noOrderWriteCount,
    },
    summaryZhTw,
    noOrderWrite,
    reportPath,
    machineLine,
  };
}

async function buildOkxHeartbeatOperationReplyContextHtml(): Promise<string | undefined> {
  const [report, publishReport] = await Promise.all([
    readOpenClawReportJson("openclaw-okx-current-readiness-heartbeat-operation-latest.json"),
    readOpenClawReportJson("openclaw-controlled-task-runner-telegram-publish-latest.json"),
  ]);
  if (!isRecord(report)) {
    return undefined;
  }
  const closure = buildOkxCurrentReadinessHeartbeatOperationClosure(report);
  const tokenCountClosure = isRecord(publishReport)
    ? buildOkxHeartbeatPublishTokenCountClosure(publishReport)
    : null;
  const nextSafeTask = displayValue(closure.nextSafeTask, "none");
  const telegramCallback = displayValue(closure.telegramCallback, "sc:tr:okxrefresh");
  const refreshCommand = displayValue(closure.refreshCommand, "pnpm okx:current-readiness:refresh");
  const inventoryProbeStatus = displayValue(closure.inventoryProbeStatus, "unknown");
  const inventoryProbeMachineLine = displayValue(closure.inventoryProbeMachineLine, "missing");
  const publishBridgeMachineLine = displayValue(closure.publishBridgeMachineLine, "");
  return [
    "🧭 <b>OKX heartbeat next-action</b>",
    `okxHeartbeatNext=<code>${escapeHtml(nextSafeTask)}</code>`,
    `okxHeartbeatRefresh=<code>${escapeHtml(`${telegramCallback} / ${refreshCommand}`)}</code> ` +
      `oneClick=${formatBoolBadge(closure.oneClickRefresh)} ` +
      `executeRequired=${formatBoolBadge(closure.executeRequired)} ` +
      `noOrderWrite=${formatBoolBadge(closure.noOrderWrite)}`,
    `okxHeartbeatSchedulerNextRunAt=<code>${escapeHtml(
      displayValue(closure.schedulerNextRunAt, "unavailable"),
    )}</code>`,
    `okxHeartbeatInventory=<code>${escapeHtml(
      `${inventoryProbeStatus} / ${inventoryProbeMachineLine}`,
    )}</code> ready=${formatBoolBadge(closure.inventoryProbeReady)} noOrderWrite=${formatBoolBadge(
      closure.inventoryProbeNoOrderWrite,
    )}`,
    ...(publishBridgeMachineLine.length > 0
      ? [
          `okxHeartbeatPublishBridge=<code>${escapeHtml(
            publishBridgeMachineLine,
          )}</code> ready=${formatBoolBadge(
            closure.publishBridgeStatusReady,
          )} upstreamNoOrderWriteVerified=${formatBoolBadge(
            closure.upstreamNoOrderWriteVerified,
          )} upstreamOkxContractVerified=${formatBoolBadge(
            closure.upstreamOkxContractVerified,
          )} upstreamDmadGateVerified=${formatBoolBadge(
            closure.upstreamDmadGateVerified,
          )} noOrderWriteCount=<code>${escapeHtml(
            displayValue(closure.upstreamNoOrderWriteCount, "0"),
          )}</code> executeRequiredCount=<code>${escapeHtml(
            displayValue(closure.upstreamExecuteRequiredCount, "0"),
          )}</code> okxContractCount=<code>${escapeHtml(
            displayValue(closure.upstreamOkxContractCount, "0"),
          )}</code> dmadGateCount=<code>${escapeHtml(
            displayValue(closure.upstreamDmadGateCount, "0"),
          )}</code>`,
        ]
      : []),
    ...(tokenCountClosure
      ? [
          `okxHeartbeatTokenCounts=<code>${escapeHtml(
            displayValue(
              tokenCountClosure.summaryZhTw,
              displayValue(tokenCountClosure.machineLine, "missing"),
            ),
          )}</code> noOrderWrite=${formatBoolBadge(tokenCountClosure.noOrderWrite)}`,
        ]
      : []),
  ].join("\n");
}

async function fetchCapitalPaperAssistantState(): Promise<CapitalPaperAssistantState | null> {
  const raw = readCapitalPaperAssistantUiState();
  return isRecord(raw) ? (raw as CapitalPaperAssistantState) : null;
}

async function fetchOkxGateState(): Promise<OkxGateState | null> {
  const [
    raw,
    currentReadinessSummary,
    currentReadinessRefreshWorkflow,
    currentReadinessHeartbeatOperation,
    marketSnapshotScheduler,
  ] = await Promise.all([
    readOpenClawReportJson("openclaw-okx-api-status-gate-latest.json"),
    readOpenClawReportJson("openclaw-okx-current-readiness-summary-latest.json"),
    readOpenClawReportJson("openclaw-okx-current-readiness-refresh-workflow-latest.json"),
    readOpenClawReportJson("openclaw-okx-current-readiness-heartbeat-operation-latest.json"),
    readOpenClawReportJson("openclaw-okx-market-snapshot-scheduler-latest.json"),
  ]);
  if (!isRecord(raw)) {
    return null;
  }
  return {
    ...raw,
    ...(isRecord(currentReadinessSummary) ? { currentReadinessSummary } : {}),
    ...(isRecord(currentReadinessRefreshWorkflow) ? { currentReadinessRefreshWorkflow } : {}),
    ...(isRecord(currentReadinessHeartbeatOperation) ? { currentReadinessHeartbeatOperation } : {}),
    ...(isRecord(marketSnapshotScheduler) ? { marketSnapshotScheduler } : {}),
  } as OkxGateState;
}

async function fetchOkxOrderProposalGateState(): Promise<OkxOrderProposalGateState | null> {
  const raw = await readOpenClawReportJson("openclaw-okx-order-proposal-gate-latest.json");
  return isRecord(raw) ? (raw as OkxOrderProposalGateState) : null;
}

async function fetchOkxOrderStatusGateState(): Promise<OkxOrderStatusGateState | null> {
  const [raw, paperAuditSummary] = await Promise.all([
    readOpenClawReportJson("openclaw-okx-order-status-gate-latest.json"),
    readOpenClawReportJson("openclaw-okx-paper-audit-summary-latest.json"),
  ]);
  if (!isRecord(raw)) {
    return null;
  }
  return {
    ...raw,
    ...(isRecord(paperAuditSummary) ? { paperAuditSummary } : {}),
  } as OkxOrderStatusGateState;
}

async function readOpenClawReportJson(fileName: string): Promise<Record<string, unknown> | null> {
  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const repoRoot of resolveOpenClawRepoRootCandidates(path)) {
      const reportPath = path.join(repoRoot, "reports", "hermes-agent", "state", fileName);
      if (!existsSync(reportPath)) {
        continue;
      }
      const raw = JSON.parse(readFileSync(reportPath, "utf8"));
      return isRecord(raw) ? raw : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function resolveOpenClawRepoRootCandidates(pathMod: typeof import("node:path")): string[] {
  const dedup = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    dedup.add(pathMod.resolve(trimmed));
  };
  push(process.env.OPENCLAW_REPO_ROOT);
  push(process.cwd());
  return [...dedup];
}

/** 取得學習摘要 */
async function fetchLearningSummary(_api: OpenClawPluginApi): Promise<string | null> {
  try {
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const stateDir of resolveOpenClawStateDirCandidates(path)) {
      const summaryPath = path.join(stateDir, "ui", "auto-trading-learning-summary.md");
      if (!existsSync(summaryPath)) {
        continue;
      }
      return readFileSync(summaryPath, "utf8").trim() || null;
    }
  } catch {
    /* ignore */
  }

  return null;
}

function parseCallbackRouterContext(value: unknown): CallbackRouterContext | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const ctx = value as {
    senderId?: unknown;
    callback?: { payload?: unknown };
    respond?: Partial<TelegramResponder>;
  };
  if (
    typeof ctx.callback?.payload !== "string" ||
    typeof ctx.respond?.editMessage !== "function" ||
    typeof ctx.respond?.reply !== "function"
  ) {
    return null;
  }
  const editMessage = ctx.respond.editMessage.bind(ctx.respond);
  const reply = ctx.respond.reply.bind(ctx.respond);
  const senderId =
    typeof ctx.senderId === "number" || typeof ctx.senderId === "string" ? ctx.senderId : undefined;
  const callbackPayload = ctx.callback.payload;
  const editNoopCacheKey = `${String(senderId ?? "anon")}:${callbackPayload}`;
  const duplicateNoopHint: TelegramMessage | null =
    callbackPayload === "tr:write"
      ? {
          text:
            "ℹ️ 寫入結果已是最新狀態。\n" +
            "若仍看到 Gateway 無回應，請先按「🛡 實單阻擋」再按「✍️ 寫入審核票」。",
          buttons: [
            [
              { text: TRADING_BUTTON_COPY.liveBlockers, callback_data: "sc:tr:live" },
              { text: TRADING_BUTTON_COPY.writeFastTicket, callback_data: "sc:tr:write" },
            ],
            [{ text: TRADING_BUTTON_COPY.backToTrade, callback_data: "sc:trade" }],
          ],
        }
      : callbackPayload === "tr:approve"
        ? {
            text:
              "ℹ️ 核准結果已是最新狀態。\n" +
              "若仍無法送出，請先按「✍️ 寫入審核票」再按「✅ 核准模擬執行」。",
            buttons: [
              [
                { text: TRADING_BUTTON_COPY.writeFastTicket, callback_data: "sc:tr:write" },
                { text: TRADING_BUTTON_COPY.approvePaper, callback_data: "sc:tr:approve" },
              ],
              [{ text: TRADING_BUTTON_COPY.backToTrade, callback_data: "sc:trade" }],
            ],
          }
        : callbackPayload.startsWith("tr:audit")
          ? {
              text: "ℹ️ 審核紀錄已是最新狀態。",
              buttons: [
                [
                  { text: TRADING_BUTTON_COPY.auditTrail, callback_data: "sc:tr:audit" },
                  { text: TRADING_BUTTON_COPY.paperReviewLoop, callback_data: "sc:tr:paperloop" },
                ],
                [{ text: TRADING_BUTTON_COPY.backToTrade, callback_data: "sc:trade" }],
              ],
            }
          : null;
  const notModifiedHint: TelegramMessage = duplicateNoopHint ?? { text: "ℹ️ 畫面已是最新狀態。" };
  return {
    senderId,
    callback: { payload: callbackPayload },
    respond: {
      editMessage: async (message: TelegramMessage) => {
        const signature = buildTelegramEditNoopSignature(message);
        if (isRecentTelegramEditNoop(editNoopCacheKey, signature)) {
          if (duplicateNoopHint) {
            try {
              await reply(duplicateNoopHint);
            } catch {
              // ignore follow-up notice failures
            }
          }
          return;
        }
        try {
          await editMessage(message);
          rememberTelegramEditNoop(editNoopCacheKey, signature);
        } catch (error: unknown) {
          if (isTelegramMessageNotModifiedError(error)) {
            rememberTelegramEditNoop(editNoopCacheKey, signature);
            try {
              await reply(notModifiedHint);
            } catch {
              // ignore follow-up notice failures
            }
            return;
          }
          throw error;
        }
      },
      reply,
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function collectErrorMessages(error: unknown): string[] {
  const messages = new Set<string>();
  const append = (value: unknown) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        messages.add(trimmed);
      }
    }
  };
  const readRecord = (value: unknown) => {
    const record = isRecord(value) ? value : null;
    if (!record) {
      return;
    }
    append(record.message);
    append(record.description);
    if (isRecord(record.response)) {
      append(record.response.message);
      append(record.response.description);
    }
    if (isRecord(record.error)) {
      append(record.error.message);
      append(record.error.description);
    }
    if (isRecord(record.cause)) {
      append(record.cause.message);
      append(record.cause.description);
    }
  };

  if (error instanceof Error) {
    append(error.message);
    append(error.stack);
    readRecord(error as unknown);
  }
  readRecord(error);

  if (messages.size === 0) {
    append(String(error));
  }

  return [...messages];
}

function getErrorMessage(error: unknown): string {
  return collectErrorMessages(error)[0] ?? String(error);
}

async function replyUpToDateNotice(respond: TelegramResponder): Promise<void> {
  try {
    await respond.reply({ text: "ℹ️ 畫面已是最新狀態。" });
  } catch {
    // ignore follow-up notice failures
  }
}

function isTelegramMessageNotModifiedError(error: unknown): boolean {
  const seen = new WeakSet<object>();
  const scanDeep = (value: unknown): boolean => {
    if (typeof value === "string") {
      return isTelegramMessageNotModifiedText(value);
    }
    if (value == null || typeof value !== "object") {
      return false;
    }
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.some((item) => scanDeep(item));
    }
    for (const nested of Object.values(value)) {
      if (scanDeep(nested)) {
        return true;
      }
    }
    return false;
  };
  if (collectErrorMessages(error).some((message) => isTelegramMessageNotModifiedText(message))) {
    return true;
  }
  if (typeof error === "string") {
    return isTelegramMessageNotModifiedText(error);
  }
  if (scanDeep(error)) {
    return true;
  }
  try {
    return isTelegramMessageNotModifiedText(JSON.stringify(error));
  } catch {
    return isTelegramMessageNotModifiedText(String(error));
  }
}

function displayValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formatBoolBadge(value: unknown): string {
  if (value === true) {
    return "✅";
  }
  if (value === false) {
    return "❌";
  }
  return "unknown";
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => displayValue(item, "")).filter((item) => item.length > 0)
    : [];
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const first = value.find(isRecord);
  return first ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ciProvider(value: unknown): CIStatus["provider"] {
  return value === "github-actions" || value === "gitlab-ci" || value === "other"
    ? value
    : "github-actions";
}

function ciStatus(value: unknown): CIStatus["status"] {
  return value === "success" || value === "failure" || value === "pending" || value === "running"
    ? value
    : "pending";
}

function displayTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

// ── Gateway RPC (透過 LoopbackGatewayClient) ──

function rpc(api: OpenClawPluginApi) {
  return getGatewayRPC(api);
}

async function fetchCronJobs(api: OpenClawPluginApi) {
  return rpc(api).fetchCronJobs();
}

async function fetchModels(api: OpenClawPluginApi) {
  return rpc(api).fetchModels();
}

async function fetchCurrentModel(api: OpenClawPluginApi) {
  return rpc(api).fetchCurrentModel();
}

async function fetchAgents(api: OpenClawPluginApi) {
  return rpc(api).fetchAgents();
}

async function fetchSessions(api: OpenClawPluginApi) {
  return rpc(api).fetchSessions({
    limit: 6,
    includeDerivedTitles: true,
    includeLastMessage: false,
    includeGlobal: true,
    includeUnknown: true,
  });
}

async function fetchSessionDetail(api: OpenClawPluginApi, key: string) {
  return rpc(api).fetchSessionDetail(key);
}

async function abortSession(api: OpenClawPluginApi, key: string) {
  return rpc(api).abortSession(key);
}

async function compactSession(api: OpenClawPluginApi, key: string) {
  return rpc(api).compactSession(key);
}

async function deleteSession(api: OpenClawPluginApi, key: string) {
  return rpc(api).deleteSession(key);
}

async function fetchActiveAgentId(api: OpenClawPluginApi) {
  return rpc(api).fetchActiveAgentId();
}

async function fetchCIStatuses(api: OpenClawPluginApi): Promise<CIStatus[]> {
  try {
    const statuses = await callGatewayCompat<unknown[]>(api, "ci.statuses");
    return statuses.map((s) => {
      const rec = isRecord(s) ? s : {};
      return {
        provider: ciProvider(rec.provider),
        repo: displayValue(rec.repo ?? rec.repository, "unknown"),
        branch: displayValue(rec.branch, "main"),
        status: ciStatus(rec.status),
        url: displayValue(rec.url),
        updatedAt: displayTimestamp(rec.updatedAt),
      };
    });
  } catch {
    return [];
  }
}

async function fetchPRs(api: OpenClawPluginApi): Promise<PullRequestInfo[]> {
  try {
    const prs = await callGatewayCompat<unknown[]>(api, "github.prs.list");
    return prs.map((pr) => {
      const rec = isRecord(pr) ? pr : {};
      const number = typeof rec.number === "number" ? rec.number : Number(rec.number) || 0;
      return {
        number,
        title: displayValue(rec.title, `PR #${number}`),
        state: displayValue(rec.state, "open"),
        draft: Boolean(rec.draft),
      };
    });
  } catch {
    return [];
  }
}

async function switchModel(api: OpenClawPluginApi, id: string) {
  return rpc(api).switchModel(id);
}

async function switchAgent(api: OpenClawPluginApi, id: string) {
  return rpc(api).switchAgent(id);
}

async function resetSession(api: OpenClawPluginApi) {
  return rpc(api).resetSession();
}

async function toggleCronJob(api: OpenClawPluginApi, id: string, enabled: boolean) {
  return rpc(api).toggleCronJob(id, enabled);
}

// ── Subagent 完整執行流程 ────────────────────────────────────────

type SubagentTaskOptions = {
  title: string;
  prompt: string;
  backAction?: string;
  backLabel?: string;
  retryAction?: string;
  timeoutMs?: number;
  skipRiskCheck?: boolean;
  operationContextHtml?: string;
};

type PendingRiskTask = {
  createdAt: number;
  opts: SubagentTaskOptions;
};

const PENDING_RISK_TASK_TTL_MS = 10 * 60 * 1000;
const pendingRiskTasks = new Map<string, PendingRiskTask>();

function createPendingRiskTaskId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function prunePendingRiskTasks(): void {
  const cutoff = Date.now() - PENDING_RISK_TASK_TTL_MS;
  for (const [id, item] of pendingRiskTasks.entries()) {
    if (item.createdAt < cutoff) {
      pendingRiskTasks.delete(id);
    }
  }
}

/**
 * 執行 subagent 任務的完整流程（非同步背景執行）：
 * 1. 立即回應「啟動中」（不阻塞 callback handler）
 * 2. 背景啟動 subagent.run()
 * 3. 背景 waitForRun() 等待完成
 * 4. 完成後用 telegram-push 推送結果
 */
async function executeSubagentTask(
  api: OpenClawPluginApi,
  respond: TelegramResponder,
  opts: SubagentTaskOptions,
) {
  const backBtn = {
    text: opts.backLabel ?? "← 首頁",
    callback_data: opts.backAction ?? "sc:home",
  };
  const timeoutMs = opts.timeoutMs ?? 180_000; // 3 分鐘
  const startedAt = Date.now();

  if (!opts.skipRiskCheck) {
    const riskLevel = assessRisk(opts.prompt);
    if (requiresBiometric(riskLevel)) {
      await respond.editMessage({
        text:
          "🔴 <b>高風險操作已攔截</b>\n\n" +
          `風險等級：<code>${riskLevel}</code>\n` +
          "此操作需要管理者追加驗證後再執行。",
        textMode: "html",
        buttons: [[backBtn]],
      });
      return;
    }
    if (requiresConfirmation(riskLevel)) {
      prunePendingRiskTasks();
      const riskTaskId = createPendingRiskTaskId();
      pendingRiskTasks.set(riskTaskId, {
        createdAt: Date.now(),
        opts,
      });
      const panel = buildTaskAwaitingInput(
        escapeHtml(opts.title),
        `⚠️ 風險等級：<code>${riskLevel}</code>\n\n<code>${escapeHtml(opts.prompt.slice(0, 220))}</code>`,
        riskTaskId,
        [
          { label: "✅ 批准", value: `sc:risk:ok:${riskTaskId}` },
          { label: "❌ 拒絕", value: `sc:risk:deny:${riskTaskId}` },
        ],
      );
      await respond.editMessage(interactiveReplyToTelegramMessage(panel, { textMode: "html" }));
      return;
    }
  }

  const subagent = resolveSubagentRuntime(api);
  if (!subagent) {
    await respond.editMessage({
      text: "❌ 子代理 API 不可用。請確認 OpenClaw 版本。",
      buttons: [[backBtn]],
    });
    return;
  }

  const sessionKey = `superclaw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // 1. 立即回應（不阻塞 callback handler）
  try {
    const { runId } = await subagent.run({
      sessionKey,
      message: opts.prompt,
      deliver: false,
    });

    setActiveTask({
      id: runId,
      title: opts.title,
      agent: "claude",
      phase: "thinking",
      stepCurrent: 0,
      stepTotal: 1,
      currentAction: "智能體執行中...",
      startedAt,
    });

    const startPanel = buildTaskRoot(runId, escapeHtml(opts.title), "claude");
    appendTaskPanelContext(startPanel, opts.operationContextHtml);
    await respond.editMessage(
      interactiveReplyToTelegramMessage(startPanel, {
        buttons: [
          [
            { text: "⏹ 取消", callback_data: "sc:kill" },
            { text: "📊 看板", callback_data: "sc:home" },
          ],
        ],
        textMode: "html",
      }),
    );

    // 2. 背景等待完成 + 推送結果（不 await — 不阻塞 handler）
    runSubagentBackground(api, subagent, {
      runId,
      sessionKey,
      title: opts.title,
      timeoutMs,
      startedAt,
      retryAction: opts.retryAction,
      backAction: opts.backAction ?? "sc:home",
      ...(opts.operationContextHtml ? { operationContextHtml: opts.operationContextHtml } : {}),
    });
  } catch (err: unknown) {
    if (isTelegramMessageNotModifiedError(err)) {
      await replyUpToDateNotice(respond);
      return;
    }
    await respond.editMessage({
      text: buildInteractiveErrorHtml(err),
      textMode: "html",
      buttons: [
        [
          ...(opts.retryAction ? [{ text: "🔄 重試", callback_data: opts.retryAction }] : []),
          backBtn,
        ],
      ],
    });
  }
}

/** 背景等待 subagent 完成，結果用 telegram-push 推送 */
function runSubagentBackground(
  api: OpenClawPluginApi,
  subagent: SubagentRuntime,
  opts: {
    runId: string;
    sessionKey: string;
    title: string;
    timeoutMs: number;
    startedAt: number;
    retryAction?: string;
    backAction: string;
    operationContextHtml?: string;
  },
) {
  const push = pushTelegramMessage;

  const doWork = async () => {
    const chatId = getActiveChatId();
    if (!chatId) {
      return;
    }

    try {
      const waitResult = await subagent.waitForRun({
        runId: opts.runId,
        timeoutMs: opts.timeoutMs,
      });

      if (waitResult.status === "timeout") {
        completeTask(false);
        const timeoutPanel = buildTaskComplete(
          escapeHtml(opts.title),
          false,
          appendOperationContextHtml(
            `智能體超過 ${Math.round(opts.timeoutMs / 1000)}s 未完成。`,
            opts.operationContextHtml,
          ),
          Date.now() - opts.startedAt,
          [],
        );
        const timeoutMessage = interactiveReplyToTelegramMessage(timeoutPanel, {
          buttons: [
            [
              ...(opts.retryAction ? [{ text: "🔄 重試", callback_data: opts.retryAction }] : []),
              { text: "← 首頁", callback_data: opts.backAction },
            ],
          ],
          textMode: "html",
        });
        await push(api, {
          chatId,
          text: timeoutMessage.text,
          buttons: timeoutMessage.buttons,
        });
        return;
      }

      if (waitResult.status === "error") {
        completeTask(false);
        const errorPanel = buildTaskComplete(
          escapeHtml(opts.title),
          false,
          appendOperationContextHtml(
            `錯誤：<code>${escapeHtml((waitResult.error ?? "未知錯誤").slice(0, 500))}</code>`,
            opts.operationContextHtml,
          ),
          Date.now() - opts.startedAt,
          [],
        );
        const errorMessage = interactiveReplyToTelegramMessage(errorPanel, {
          buttons: [
            [
              ...(opts.retryAction ? [{ text: "🔄 重試", callback_data: opts.retryAction }] : []),
              { text: "← 首頁", callback_data: opts.backAction },
            ],
          ],
          textMode: "html",
        });
        await push(api, {
          chatId,
          text: errorMessage.text,
          buttons: errorMessage.buttons,
        });
        return;
      }

      // 成功 — 取得結果
      completeTask(true);
      let resultText = "";
      try {
        const { messages } = await subagent.getSessionMessages({
          sessionKey: opts.sessionKey,
          limit: 5,
        });
        const rawResultText = messages
          .filter(isAssistantMessage)
          .map(extractMessageText)
          .join("\n\n");
        resultText = sanitizeSubagentSummaryText(rawResultText).slice(0, 3000);
      } catch {
        resultText = "(無法取得執行結果)";
      }

      try {
        await subagent.deleteSession({ sessionKey: opts.sessionKey });
      } catch {
        /* ignore */
      }

      const truncated = resultText.length >= 3000 ? "\n\n<i>... (結果已截斷)</i>" : "";
      const successPanel = buildTaskComplete(
        escapeHtml(opts.title),
        true,
        appendOperationContextHtml(
          `${escapeHtml(resultText || "操作完成（通知回傳異常，請回主面板刷新）。")}${truncated}`,
          opts.operationContextHtml,
        ),
        Date.now() - opts.startedAt,
        [],
      );
      const successMessage = interactiveReplyToTelegramMessage(successPanel, {
        buttons: [
          [
            ...(opts.retryAction ? [{ text: "🔄 再執行", callback_data: opts.retryAction }] : []),
            { text: "← 首頁", callback_data: opts.backAction },
          ],
        ],
        textMode: "html",
      });
      await push(api, {
        chatId,
        text: successMessage.text,
        buttons: successMessage.buttons,
      });
    } catch (err) {
      completeTask(false);
      console.error("[subagent-bg] 背景任務錯誤:", err);
      try {
        const uncaughtPanel = buildTaskError(
          escapeHtml(opts.title),
          getErrorMessage(err),
          opts.runId,
        );
        const uncaughtMessage = interactiveReplyToTelegramMessage(uncaughtPanel, {
          buttons: [[{ text: "← 首頁", callback_data: opts.backAction }]],
          textMode: "html",
        });
        await push(api, {
          chatId,
          text: uncaughtMessage.text,
          buttons: uncaughtMessage.buttons,
        });
      } catch {
        /* ignore push error */
      }
    }
  };

  // 不 await — 讓 callback handler 立即返回
  doWork().catch((err) => console.error("[subagent-bg] uncaught:", err));
}

function appendTaskPanelContext(
  panel: ReturnType<typeof buildTaskRoot>,
  contextHtml: string | undefined,
): void {
  if (!contextHtml) {
    return;
  }
  const [firstBlock] = panel.blocks;
  if (firstBlock?.type === "text") {
    firstBlock.text = `${firstBlock.text}\n\n${contextHtml}`;
  }
}

function appendOperationContextHtml(summaryHtml: string, contextHtml: string | undefined): string {
  return contextHtml ? `${summaryHtml}\n\n${contextHtml}` : summaryHtml;
}

// getActiveChatId 已從 telegram-push.js import

// ── Workflow 多步執行引擎 ────────────────────────────────────────

/**
 * 執行多步 workflow（非同步背景執行）：
 * 1. 立即顯示初始進度面板
 * 2. 背景逐步用 subagent 執行每個 node
 * 3. 每完成一步用 telegram-push 推送進度
 */
async function executeWorkflow(
  api: OpenClawPluginApi,
  workflowId: string,
  respond: TelegramResponder,
) {
  const workflow = WORKFLOW_TEMPLATES.find((w) => w.id === workflowId);
  if (!workflow) {
    await respond.editMessage({
      text: `❌ 找不到工作流: ${escapeHtml(workflowId)}`,
      buttons: [[{ text: "← 工作流", callback_data: "sc:wf" }]],
    });
    return;
  }

  const subagent = resolveSubagentRuntime(api);
  if (!subagent) {
    await respond.editMessage({
      text: "❌ 子代理 API 不可用。",
      buttons: [[{ text: "← 工作流", callback_data: "sc:wf" }]],
    });
    return;
  }

  // 取得執行順序
  const orderedNodes = topologicalSort(workflow);

  // 初始化進度
  const steps: ProgressStep[] = orderedNodes.map((node) => ({
    label: node.label,
    status: "pending",
  }));

  // 立即回應 callback
  await respond.editMessage({
    text: formatProgressMessage(`🔄 ${workflow.name}`, steps),
    textMode: "html",
    buttons: [[{ text: "⏹ 取消", callback_data: `sc:wf:stop:${workflowId}` }]],
  });

  setActiveTask({
    id: `wf-${workflowId}-${Date.now()}`,
    title: workflow.name,
    agent: "claude",
    phase: "thinking",
    stepCurrent: 0,
    stepTotal: orderedNodes.length,
    currentAction: orderedNodes[0]?.label ?? "啟動中",
    startedAt: Date.now(),
  });

  // 背景執行（不阻塞 callback handler）
  runWorkflowBackground(api, subagent, workflow, orderedNodes, steps).catch((err) =>
    console.error("[workflow-bg] uncaught:", err),
  );
}

/** 背景逐步執行 workflow nodes */
async function runWorkflowBackground(
  api: OpenClawPluginApi,
  subagent: SubagentRuntime,
  workflow: WorkflowDefinition,
  orderedNodes: WorkflowDefinition["nodes"],
  steps: ProgressStep[],
) {
  const push = pushTelegramMessage;
  const edit = editTelegramMessage;
  const chatId = getActiveChatId();
  if (!chatId) {
    return;
  }

  const startTime = Date.now();
  let prevOutput = "";
  let allSuccess = true;
  let progressMsgId: number | null = null;

  // 發送一條新的進度訊息（背景用 push，不用 respond）
  const sent = await push(api, {
    chatId,
    text: formatProgressMessage(`🔄 ${workflow.name}`, steps),
    buttons: [[{ text: "⏹ 取消", callback_data: `sc:wf:stop:${workflow.id}` }]],
    silent: true,
  });
  progressMsgId = sent?.messageId ?? null;

  for (let i = 0; i < orderedNodes.length; i++) {
    const node = orderedNodes[i];

    // 更新步驟為 running
    steps[i].status = "running";
    updateTaskProgress(i, node.label);

    if (progressMsgId) {
      await edit(api, {
        chatId,
        messageId: progressMsgId,
        text: formatProgressMessage(`🔄 ${workflow.name}`, steps, Date.now() - startTime),
        buttons: [[{ text: "⏹ 取消", callback_data: `sc:wf:stop:${workflow.id}` }]],
      });
    }

    // Gate / Notify — 直接通過
    if (node.type === "gate") {
      steps[i].status = "done";
      steps[i].detail = "自動通過";
      continue;
    }
    if (node.type === "notify") {
      steps[i].status = "done";
      steps[i].detail = "已通知";
      continue;
    }

    // Claude / Codex node — subagent 執行
    const sessionKey = `wf-${workflow.id}-${node.id}-${Date.now()}`;
    const contextLine = prevOutput ? `\n\n前一步結果：${prevOutput.slice(0, 500)}` : "";
    const prompt = `${node.config.prompt ?? node.label}${contextLine}`;

    try {
      const { runId } = await subagent.run({ sessionKey, message: prompt, deliver: false });
      const timeoutMs = node.config.timeoutMs ?? 120_000;
      const result = await subagent.waitForRun({ runId, timeoutMs });

      if (result.status === "ok") {
        try {
          const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 3 });
          const rawOutput = messages.filter(isAssistantMessage).map(extractMessageText).join("\n");
          prevOutput = sanitizeSubagentSummaryText(rawOutput).slice(0, 500);
        } catch {
          prevOutput = "";
        }
        steps[i].status = "done";
        steps[i].detail = prevOutput.slice(0, 40) || "完成";
      } else if (result.status === "timeout") {
        steps[i].status = "error";
        steps[i].detail = "逾時";
        allSuccess = false;
        break;
      } else {
        steps[i].status = "error";
        steps[i].detail = result.error?.slice(0, 40) ?? "錯誤";
        allSuccess = false;
        break;
      }

      try {
        await subagent.deleteSession({ sessionKey });
      } catch {
        /* ignore */
      }
    } catch (err: unknown) {
      steps[i].status = "error";
      steps[i].detail = getErrorMessage(err).slice(0, 40);
      allSuccess = false;
      break;
    }
  }

  // 最終結果
  completeTask(allSuccess);
  const elapsed = Date.now() - startTime;
  const emoji = allSuccess ? "🎉" : "❌";
  const statusText = allSuccess ? "全部完成" : "執行中斷";

  if (progressMsgId) {
    await edit(api, {
      chatId,
      messageId: progressMsgId,
      text: formatProgressMessage(`${emoji} ${workflow.name} — ${statusText}`, steps, elapsed),
      buttons: [
        [
          { text: "🔄 再執行", callback_data: `sc:wf:run:${workflow.id}` },
          { text: "← 首頁", callback_data: "sc:home" },
        ],
      ],
    });
  } else {
    await push(api, {
      chatId,
      text: formatProgressMessage(`${emoji} ${workflow.name} — ${statusText}`, steps, elapsed),
      buttons: [[{ text: "← 首頁", callback_data: "sc:home" }]],
    });
  }
}

/** 依 edges 做簡易拓撲排序，取得 node 執行順序 */
function topologicalSort(workflow: WorkflowDefinition) {
  const { nodes, edges } = workflow;
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
  }
  for (const edge of edges) {
    adj.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  const result = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    for (const next of adj.get(node.id) ?? []) {
      const deg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, deg);
      if (deg === 0) {
        const nextNode = nodes.find((n) => n.id === next);
        if (nextNode) {
          queue.push(nextNode);
        }
      }
    }
  }

  // 如果有環或遺漏，補上未加入的 node
  if (result.length < nodes.length) {
    const added = new Set(result.map((n) => n.id));
    for (const node of nodes) {
      if (!added.has(node.id)) {
        result.push(node);
      }
    }
  }

  return result;
}
