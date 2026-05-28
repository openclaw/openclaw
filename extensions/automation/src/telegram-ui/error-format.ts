import { isTelegramMessageNotModifiedText } from "./telegram-not-modified.js";

export type InteractiveErrorInfo = {
  code: "CMD_NOT_FOUND" | "AUTH_DENIED" | "TIMEOUT" | "NETWORK" | "UP_TO_DATE" | "UNKNOWN";
  summary: string;
  nextAction: string;
  detail: string;
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatErrorCodeLabel(code: InteractiveErrorInfo["code"]): string {
  const labels: Record<InteractiveErrorInfo["code"], string> = {
    CMD_NOT_FOUND: "命令不存在",
    AUTH_DENIED: "權限不足",
    TIMEOUT: "操作逾時",
    NETWORK: "網路異常",
    UP_TO_DATE: "狀態已最新",
    UNKNOWN: "未知錯誤",
  };
  return `${labels[code]} (${code})`;
}

function collectErrorCandidates(raw: unknown): string[] {
  const messages = new Set<string>();
  const seen = new WeakSet<object>();
  const appendStringifiedObject = (value: object): void => {
    try {
      const rendered = JSON.stringify(value)?.trim() ?? "";
      if (rendered.length === 0) {
        return;
      }
      const lower = rendered.toLowerCase();
      if (lower === "[object object]") {
        return;
      }
      messages.add(rendered);
    } catch {
      // Ignore non-stringifiable objects.
    }
  };
  const append = (value: unknown): void => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        messages.add(trimmed);
      }
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      messages.add(String(value).trim());
    }
  };
  const walk = (value: unknown): void => {
    if (value == null) {
      return;
    }
    append(value);
    if (value instanceof Error) {
      append(value.message);
      append(value.stack);
      appendStringifiedObject(value);
      const withCause = value as Error & { cause?: unknown };
      if ("cause" in withCause) {
        walk(withCause.cause);
      }
    }
    if (typeof value !== "object") {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    appendStringifiedObject(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    append(record.message);
    append(record.description);
    append(record.error_description);
    for (const nested of Object.values(record)) {
      walk(nested);
    }
  };
  walk(raw);
  return [...messages];
}

function normalizeErrorMessage(raw: unknown): string {
  const collected = collectErrorCandidates(raw);
  if (collected.length > 0) {
    return collected[0];
  }
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (raw instanceof Error && typeof raw.message === "string") {
    return raw.message.trim();
  }
  if (raw == null) {
    return "";
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw).trim();
  }
  return JSON.stringify(raw).trim();
}

export function classifyInteractiveError(raw: unknown): InteractiveErrorInfo {
  const candidates = collectErrorCandidates(raw);
  const normalized = normalizeErrorMessage(raw);
  const detail = normalized.slice(0, 240) || "未知錯誤";
  const lower = normalized.toLowerCase();

  const hasNotModifiedHint = candidates.some((candidate) =>
    isTelegramMessageNotModifiedText(candidate),
  );
  if (
    hasNotModifiedHint ||
    isTelegramMessageNotModifiedText(normalized) ||
    isTelegramMessageNotModifiedText(lower)
  ) {
    return {
      code: "UP_TO_DATE",
      summary: "畫面已是最新狀態，無需重複更新。",
      nextAction: "可直接返回上一層或繼續下一步操作。",
      detail,
    };
  }

  if (
    lower.includes("not found") ||
    lower.includes("unknown command") ||
    detail.includes("不存在") ||
    detail.includes("找不到")
  ) {
    return {
      code: "CMD_NOT_FOUND",
      summary: "命令不存在、尚未註冊，或目前環境不可用。",
      nextAction: "先輸入 /menu 或「下一個任務」，再選擇可執行操作。",
      detail,
    };
  }

  if (
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("permission") ||
    detail.includes("沒有權限") ||
    detail.includes("權限")
  ) {
    return {
      code: "AUTH_DENIED",
      summary: "目前帳號或群組權限不足，無法執行此操作。",
      nextAction: "請先確認 allowlist、群組權限與操作授權設定。",
      detail,
    };
  }

  if (lower.includes("timeout") || lower.includes("timed out") || detail.includes("逾時")) {
    return {
      code: "TIMEOUT",
      summary: "操作逾時，尚未在時限內完成。",
      nextAction: "請稍後重試，或先查看狀態確認是否仍在背景執行。",
      detail,
    };
  }

  if (
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("econn") ||
    lower.includes("enotfound")
  ) {
    return {
      code: "NETWORK",
      summary: "網路連線或上游服務暫時不可用。",
      nextAction: "請先檢查 Gateway / 網路，再重試此操作。",
      detail,
    };
  }

  return {
    code: "UNKNOWN",
    summary: "操作失敗，需人工檢查錯誤細節。",
    nextAction: "請點擊重試；若持續失敗，回報錯誤代碼與詳細訊息。",
    detail,
  };
}

export function buildInteractiveErrorHtml(raw: unknown): string {
  const info = classifyInteractiveError(raw);
  if (info.code === "UP_TO_DATE") {
    return (
      `ℹ️ <b>畫面已是最新狀態</b>\n\n` +
      `<b>摘要</b>: ${info.summary}\n` +
      `<b>下一步</b>: ${info.nextAction}\n\n` +
      `<b>詳細</b>: <code>${escapeHtml(info.detail)}</code>`
    );
  }
  return (
    `❌ <b>操作失敗</b>\n\n` +
    `<b>錯誤代碼</b>: <code>${formatErrorCodeLabel(info.code)}</code>\n` +
    `<b>摘要</b>: ${info.summary}\n` +
    `<b>下一步</b>: ${info.nextAction}\n\n` +
    `<b>詳細</b>: <code>${escapeHtml(info.detail)}</code>`
  );
}
