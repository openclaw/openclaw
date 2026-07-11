// Discord plugin module implements pluralkit behavior.
import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";

const PLURALKIT_API_BASE = "https://api.pluralkit.me/v2";
const PLURALKIT_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const PLURALKIT_LOOKUP_TIMEOUT_MS = 10_000;

export type DiscordPluralKitConfig = {
  enabled?: boolean;
  token?: string;
};

export type PluralKitSystemInfo = {
  id: string;
  name?: string | null;
  tag?: string | null;
};

export type PluralKitMemberInfo = {
  id: string;
  name?: string | null;
  display_name?: string | null;
};

export type PluralKitMessageInfo = {
  id: string;
  original?: string | null;
  sender?: string | null;
  system?: PluralKitSystemInfo | null;
  member?: PluralKitMemberInfo | null;
};

function createPluralKitLookupSignal(params: { signal?: AbortSignal; timeoutMs?: number }): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, PLURALKIT_LOOKUP_TIMEOUT_MS, 1);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort(params.signal?.reason);

  if (params.signal?.aborted) {
    abortFromCaller();
  } else {
    params.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timeoutId);
      params.signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

export async function fetchPluralKitMessageInfo(params: {
  messageId: string;
  config?: DiscordPluralKitConfig;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<PluralKitMessageInfo | null> {
  if (!params.config?.enabled) {
    return null;
  }
  const fetchImpl = resolveFetch(params.fetcher);
  if (!fetchImpl) {
    return null;
  }
  const headers: Record<string, string> = {};
  if (params.config.token?.trim()) {
    headers.Authorization = params.config.token.trim();
  }
  const timeout = createPluralKitLookupSignal({
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  try {
    const res = await fetchImpl(`${PLURALKIT_API_BASE}/messages/${params.messageId}`, {
      headers,
      signal: timeout.signal,
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      const text = await readResponseTextLimited(res, PLURALKIT_ERROR_BODY_LIMIT_BYTES).catch(
        () => "",
      );
      const detail = text.trim() ? `: ${text.trim()}` : "";
      throw new Error(`PluralKit API failed (${res.status})${detail}`);
    }
    return await readProviderJsonResponse<PluralKitMessageInfo>(res, "PluralKit message");
  } finally {
    timeout.release();
  }
}
