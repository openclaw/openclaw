// Signal plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  type SignalApiMode,
  signalCheck,
  signalCheckWithMode,
  signalRpcRequest,
} from "./client-adapter.js";
import { SignalRpcRequestError } from "./client.js";

export type SignalProbeReadiness =
  | "account_missing"
  | "unreachable"
  | "receive_unavailable"
  | "ready";

export type SignalProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  version?: string | null;
  readiness: SignalProbeReadiness;
};

function parseSignalVersion(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "object" && value !== null) {
    const version = (value as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  }
  return null;
}

function classifyFailedSignalCheck(error: string | null | undefined): SignalProbeReadiness {
  return /\breceive\b/i.test(error ?? "") ? "receive_unavailable" : "unreachable";
}

function parseNativeAccountNumbers(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const accounts: string[] = [];
  for (const item of value) {
    const number = normalizeOptionalString(
      typeof item === "string"
        ? item
        : typeof item === "object" && item !== null
          ? (item as { number?: unknown }).number
          : undefined,
    );
    if (!number) {
      return null;
    }
    accounts.push(number);
  }
  return accounts;
}

async function validateNativeProbeAccount(params: {
  baseUrl: string;
  timeoutMs: number;
  account: string | undefined;
  mode: "native" | "container" | null;
}): Promise<{ error: string; readiness: SignalProbeReadiness } | null> {
  if (params.mode !== "native") {
    return null;
  }
  let result: unknown;
  try {
    result = await signalRpcRequest("listAccounts", undefined, {
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
      apiMode: "native",
    });
  } catch (error) {
    if (error instanceof SignalRpcRequestError && error.code === -32601) {
      // A daemon started with `-a` is already bound to one account and does not expose the
      // multi-account inventory command. Its RPC and event handlers ignore account selectors.
      return null;
    }
    return {
      error: `Signal native accounts check failed: ${formatErrorMessage(error)}`,
      readiness: "unreachable",
    };
  }
  const accounts = parseNativeAccountNumbers(result);
  if (!accounts) {
    return {
      error: "Signal native account inventory returned an invalid response",
      readiness: "unreachable",
    };
  }
  if (!params.account) {
    return accounts.length === 1
      ? null
      : {
          error:
            accounts.length === 0
              ? "Signal native daemon has no registered accounts"
              : "Signal native daemon serves multiple accounts; configure a Signal phone number",
          readiness: "account_missing",
        };
  }
  if (accounts.includes(params.account)) {
    return null;
  }
  return {
    error: `Signal native daemon does not list ${params.account}`,
    readiness: "account_missing",
  };
}

async function validateContainerProbeAccount(params: {
  baseUrl: string;
  timeoutMs: number;
  account: string;
  receiveAlreadyChecked: boolean;
  mode: "native" | "container" | null;
}): Promise<{ error: string; readiness: SignalProbeReadiness } | null> {
  if (params.mode !== "container") {
    return null;
  }
  if (!params.receiveAlreadyChecked) {
    const receiveCheck = await signalCheck(params.baseUrl, params.timeoutMs, {
      apiMode: "container",
      account: params.account,
      requireReceive: true,
    });
    if (!receiveCheck.ok) {
      return {
        error: receiveCheck.error ?? "Signal container receive endpoint unavailable",
        readiness: "receive_unavailable",
      };
    }
  }
  const { validateSignalContainerLinkedAccount } = await import("./client-container.js");
  const linked = await validateSignalContainerLinkedAccount({
    httpUrl: params.baseUrl,
    account: params.account,
    timeoutMs: params.timeoutMs,
  });
  if (linked.ok) {
    return null;
  }
  return {
    error: linked.error,
    readiness: linked.code === "account_check_failed" ? "unreachable" : "account_missing",
  };
}

export async function probeSignal(
  baseUrl: string,
  timeoutMs: number,
  options: { apiMode?: SignalApiMode; account?: string } = {},
): Promise<SignalProbe> {
  const started = Date.now();
  const result: SignalProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
    version: null,
    readiness: "unreachable",
  };
  const account = normalizeOptionalString(options.account);
  const apiMode = options.apiMode ?? "native";
  const receiveAlreadyChecked = apiMode === "container" && Boolean(account);
  const detection = await signalCheckWithMode(baseUrl, timeoutMs, {
    apiMode,
    account,
    // Native signal-cli can keep `/api/v1/events` idle before sending headers;
    // the monitor handles that with an infinite stream deadline. Keep finite
    // receive readiness as a container account contract, not a native setup gate.
    requireReceive: receiveAlreadyChecked,
  });
  const check = detection.check;
  if (!check.ok) {
    return {
      ...result,
      status: check.status ?? null,
      error: check.error ?? "unreachable",
      elapsedMs: Date.now() - started,
      readiness: classifyFailedSignalCheck(check.error),
    };
  }
  try {
    const version = await signalRpcRequest("version", undefined, {
      baseUrl,
      timeoutMs,
      apiMode: detection.mode ?? apiMode,
    });
    result.version = parseSignalVersion(version);
  } catch (err) {
    return {
      ...result,
      status: check.status ?? null,
      error: formatErrorMessage(err),
      elapsedMs: Date.now() - started,
      readiness: "unreachable",
    };
  }
  const mode = detection.mode;
  const nativeAccountFailure = await validateNativeProbeAccount({
    baseUrl,
    timeoutMs,
    account,
    mode,
  });
  if (nativeAccountFailure) {
    return {
      ...result,
      status: check.status ?? null,
      error: nativeAccountFailure.error,
      elapsedMs: Date.now() - started,
      readiness: nativeAccountFailure.readiness,
    };
  }
  if (!account) {
    if (mode !== "container") {
      return {
        ...result,
        ok: true,
        status: check.status ?? null,
        elapsedMs: Date.now() - started,
        readiness: "ready",
      };
    }
    return {
      ...result,
      ok: false,
      status: check.status ?? null,
      error: result.error ?? "Signal account is not configured",
      elapsedMs: Date.now() - started,
      readiness: "account_missing",
    };
  }
  const containerAccountFailure = await validateContainerProbeAccount({
    baseUrl,
    timeoutMs,
    account,
    receiveAlreadyChecked,
    mode,
  });
  if (containerAccountFailure) {
    return {
      ...result,
      status: check.status ?? null,
      error: containerAccountFailure.error,
      elapsedMs: Date.now() - started,
      readiness: containerAccountFailure.readiness,
    };
  }
  return {
    ...result,
    ok: true,
    status: check.status ?? null,
    elapsedMs: Date.now() - started,
    readiness: "ready",
  };
}
