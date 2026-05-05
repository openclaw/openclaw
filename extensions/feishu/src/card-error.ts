/**
 * Feishu Card API error detection & classification.
 *
 * The Card Kit API returns structured errors with `code` (HTTP-level) and
 * inner `data.code` / `data.msg` (domain-level).  When a card payload
 * contains more markdown tables than the platform allows (~3), the API
 * rejects it with:
 *
 *   - outer code: 230099
 *   - inner ErrCode: 11310 ("card table number over limit")
 *
 * This module provides predicates so that call-sites can degrade gracefully
 * (e.g. re-send as plain text) instead of failing hard.
 */

/** Parsed CardKit error shape (extracted from raw API responses / SDK throws). */
export interface CardKitApiErrorData {
  /** HTTP-gateway level code, e.g. 230099 */
  code?: number;
  /** Domain-level error code inside `data`, e.g. 11310 */
  errCode?: number;
  /** Human-readable message, may contain "table number over limit" */
  msg?: string;
}

/**
 * Attempt to extract structured fields from a thrown value that originated
 * from the Feishu Card Kit API.
 *
 * Handles:
 *   - Error instances with a JSON-stringified `.message`
 *   - Plain objects (SDK sometimes re-throws response bodies)
 *   - Strings containing JSON
 */
export function parseCardKitError(raw: unknown): CardKitApiErrorData | null {
  // Check Axios response data first — before JSON.stringify which throws on circular refs.
  const axiosData = extractAxiosResponseData(raw);
  if (axiosData) {
    return {
      code: numField(axiosData, "code"),
      errCode:
        numField(axiosData, "data", "code") ??
        numField(axiosData, "data", "ErrCode") ??
        numField(axiosData, "ErrCode"),
      msg:
        strField(axiosData, "data", "msg") ||
        strField(axiosData, "data", "ErrMsg") ||
        strField(axiosData, "msg") ||
        strField(axiosData, "ErrMsg") ||
        undefined,
    };
  }

  let msg: string;

  if (raw instanceof Error) {
    msg = raw.message;
  } else if (typeof raw === "string") {
    msg = raw;
  } else if (raw !== null && typeof raw === "object") {
    // SDK may throw the response body directly
    try {
      msg = JSON.stringify(raw);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  // Try to parse as JSON first (structured error envelope)
  const parsed = tryParseJson(msg);
  if (parsed) {
    return {
      code: numField(parsed, "code"),
      errCode:
        numField(parsed, "data", "code") ??
        numField(parsed, "data", "ErrCode") ??
        numField(parsed, "ErrCode"),
      msg:
        strField(parsed, "data", "msg") ||
        strField(parsed, "data", "ErrMsg") ||
        strField(parsed, "msg") ||
        strField(parsed, "ErrMsg") ||
        undefined,
    };
  }

  // Fallback: match against flat string patterns
  return { msg };
}

/** True when the error is a card table-count-over-limit rejection. */
export function isCardTableLimitError(err: unknown): boolean {
  const data = parseCardKitError(err);
  if (!data) {
    return false;
  }

  const hasOuterCode = data.code === 230099;
  const hasInnerCode = data.errCode === 11310;
  const hasMsg = /table\s+number\s+over\s+limit/i.test(data.msg ?? "");

  // Strong signal: outer code + inner code/msg
  if (hasOuterCode && (hasInnerCode || hasMsg)) {
    return true;
  }
  // Weak signal: message alone (covers plain-string errors from assertFeishuMessageApiSuccess)
  if (hasMsg && !hasOuterCode) {
    return true;
  }
  return false;
}

/** True when the error is a card rate-limit (429-equivalent at card-kit level). */
export function isCardRateLimitError(err: unknown): boolean {
  const data = parseCardKitError(err);
  if (!data) {
    return false;
  }
  return data.code === 230099 && /rate.?limit/i.test(data.msg ?? "");
}

// ── Internal helpers ────────────────────────────────────────────

// ── Type-safe field extractors (no `as` assertions) ─────────

function numField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "number" ? cur : undefined;
}

function strField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "string" ? cur : undefined;
}

function extractAxiosResponseData(raw: unknown): Record<string, unknown> | null {
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const response = (raw as { response?: unknown }).response;
  if (response == null || typeof response !== "object") {
    return null;
  }
  const data = (response as { data?: unknown }).data;
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  return data as Record<string, unknown>;
}

function tryParseJson(s: string): Record<string, unknown> | null {
  const jsonMatch = s.match(/\{[\s\S]*\}$/);
  if (!jsonMatch) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
