import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";

const DEFAULT_TIMEOUT_MS = 10_000;
const SIGNAL_CONTAINER_ACCOUNTS_RESPONSE_MAX_BYTES = 64 * 1024;
const SIGNAL_CONTAINER_MAX_LINKED_ACCOUNTS = 100;
const SIGNAL_CONTAINER_ACCOUNT_ERROR_PREVIEW_COUNT = 5;
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;

type SignalContainerAccountsRuntime = {
  fetchWithTimeout: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
};

export type SignalContainerLinkedAccountResult =
  | { ok: true }
  | {
      ok: false;
      code: "invalid_account" | "account_check_failed" | "account_missing";
      error: string;
    };

export function normalizeSignalContainerBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Signal base URL unsupported protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Signal base URL must not include credentials");
  }
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export async function releaseSignalContainerResponseBody(res: Response | undefined): Promise<void> {
  if (res?.bodyUsed !== true) {
    await res?.body?.cancel().catch(() => undefined);
  }
}

function normalizeContainerAccountInput(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeE164(trimmed);
  const digits = normalized.slice(1);
  if (!DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

async function readContainerAccounts(
  baseUrl: string,
  timeoutMs: number,
  runtime: SignalContainerAccountsRuntime,
): Promise<{ ok: true; accounts: string[] } | { ok: false; error: string }> {
  const normalized = normalizeSignalContainerBaseUrl(baseUrl);
  let res: Response | undefined;
  try {
    res = await runtime.fetchWithTimeout(`${normalized}/v1/accounts`, { method: "GET" }, timeoutMs);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const bodyIdleTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_TIMEOUT_MS);
    const bytes = await readResponseWithLimit(res, SIGNAL_CONTAINER_ACCOUNTS_RESPONSE_MAX_BYTES, {
      chunkTimeoutMs: bodyIdleTimeoutMs,
      onIdleTimeout: ({ chunkTimeoutMs }) =>
        new Error(`Signal accounts response body stalled after ${chunkTimeoutMs}ms`),
      onOverflow: ({ maxBytes }) => new Error(`Signal accounts response exceeds ${maxBytes} bytes`),
    });
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      return { ok: false, error: "Signal accounts response was not a string array" };
    }
    if (parsed.length > SIGNAL_CONTAINER_MAX_LINKED_ACCOUNTS) {
      return {
        ok: false,
        error: `Signal accounts response exceeded ${SIGNAL_CONTAINER_MAX_LINKED_ACCOUNTS} entries`,
      };
    }
    const accounts: string[] = [];
    for (const entry of parsed) {
      const normalizedAccount = normalizeContainerAccountInput(entry);
      if (!normalizedAccount) {
        return { ok: false, error: "Signal accounts response contained an invalid phone number" };
      }
      accounts.push(normalizedAccount);
    }
    return { ok: true, accounts };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await releaseSignalContainerResponseBody(res);
  }
}

function formatSignalContainerAccountPreview(accounts: string[]): string {
  const preview = accounts.slice(0, SIGNAL_CONTAINER_ACCOUNT_ERROR_PREVIEW_COUNT);
  const remaining = accounts.length - preview.length;
  return `${preview.join(", ")}${remaining > 0 ? `, … ${remaining} more` : ""}`;
}

export async function validateSignalContainerLinkedAccountWithRuntime(
  params: { httpUrl: string; account: string; timeoutMs?: number },
  runtime: SignalContainerAccountsRuntime,
): Promise<SignalContainerLinkedAccountResult> {
  const account = normalizeContainerAccountInput(params.account);
  if (!account) {
    return {
      ok: false,
      code: "invalid_account",
      error: "Signal account is not a valid phone number",
    };
  }
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, DEFAULT_TIMEOUT_MS);
  const accounts = await readContainerAccounts(params.httpUrl, timeoutMs, runtime);
  if (!accounts.ok) {
    return {
      ok: false,
      code: "account_check_failed",
      error: `Signal accounts check failed: ${accounts.error}`,
    };
  }
  if (accounts.accounts.includes(account)) {
    return { ok: true };
  }
  if (accounts.accounts.length === 0) {
    return {
      ok: false,
      code: "account_missing",
      error: `Signal container has no linked accounts; expected ${account}.`,
    };
  }
  return {
    ok: false,
    code: "account_missing",
    error: `Signal container does not list ${account}; linked accounts: ${formatSignalContainerAccountPreview(accounts.accounts)}.`,
  };
}
