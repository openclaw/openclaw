type ResolveOpenSandboxExecdResult = {
  execdBaseUrl?: string;
  sandboxId?: string;
};

function trimOrUndefined(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseEndpointPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const direct =
    (typeof record.endpoint === "string" && record.endpoint) ||
    (typeof record.url === "string" && record.url) ||
    (typeof record.access_url === "string" && record.access_url);
  if (direct) {
    return direct;
  }
  const data = record.data;
  if (data && typeof data === "object") {
    const nested = data as Record<string, unknown>;
    return (
      (typeof nested.endpoint === "string" && nested.endpoint) ||
      (typeof nested.url === "string" && nested.url) ||
      (typeof nested.access_url === "string" && nested.access_url) ||
      undefined
    );
  }
  return undefined;
}

async function fetchJson(params: {
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; payload?: unknown; text?: string }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), params.timeoutMs ?? 10_000);
  try {
    const res = await fetch(params.url, {
      ...params.init,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!text.trim()) {
      return { ok: res.ok, status: res.status, text };
    }
    try {
      return { ok: res.ok, status: res.status, payload: JSON.parse(text), text };
    } catch {
      return { ok: res.ok, status: res.status, text };
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveOpenSandboxExecdRuntimeFromEnv(params?: {
  warn?: (message: string) => void;
}): Promise<ResolveOpenSandboxExecdResult> {
  const explicitExecdUrl = trimOrUndefined(process.env.OPEN_SANDBOX_EXECD_URL);
  if (explicitExecdUrl) {
    return {
      execdBaseUrl: explicitExecdUrl,
      sandboxId: trimOrUndefined(process.env.OPEN_SANDBOX_SANDBOX_ID),
    };
  }

  const lifecycleBaseUrl = trimOrUndefined(process.env.OPEN_SANDBOX_LIFECYCLE_URL);
  const apiKey = trimOrUndefined(process.env.OPEN_SANDBOX_API_KEY);
  const sandboxId = trimOrUndefined(process.env.OPEN_SANDBOX_SANDBOX_ID);
  const execdPort = Number.parseInt(process.env.OPEN_SANDBOX_EXECD_PORT?.trim() || "44772", 10);
  const renewTimeoutSec = Number.parseInt(
    process.env.OPEN_SANDBOX_RENEW_TIMEOUT_SEC?.trim() || "1800",
    10,
  );
  const requestTimeoutMs = Number.parseInt(
    process.env.OPEN_SANDBOX_LIFECYCLE_TIMEOUT_MS?.trim() || "8000",
    10,
  );

  if (!lifecycleBaseUrl || !apiKey || !sandboxId || !Number.isFinite(execdPort) || execdPort <= 0) {
    return { execdBaseUrl: undefined, sandboxId };
  }

  const normalizedBase = lifecycleBaseUrl.replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    "OPEN-SANDBOX-API-KEY": apiKey,
  };
  // Best-effort renew; failures should not block command execution when endpoint is still valid.
  await fetchJson({
    url: `${normalizedBase}/v1/sandboxes/${encodeURIComponent(sandboxId)}/renew-expiration`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        timeout: Number.isFinite(renewTimeoutSec) && renewTimeoutSec > 0 ? renewTimeoutSec : 1800,
      }),
    },
    timeoutMs: requestTimeoutMs,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    params?.warn?.(`OpenSandbox renew failed for ${sandboxId}: ${message}`);
  });

  const endpointRes = await fetchJson({
    url: `${normalizedBase}/v1/sandboxes/${encodeURIComponent(sandboxId)}/endpoints/${execdPort}`,
    init: { method: "GET", headers },
    timeoutMs: requestTimeoutMs,
  });
  if (!endpointRes.ok) {
    params?.warn?.(
      `OpenSandbox endpoint lookup failed for ${sandboxId}:${execdPort} (status ${endpointRes.status}).`,
    );
    return { execdBaseUrl: undefined, sandboxId };
  }
  const endpoint = parseEndpointPayload(endpointRes.payload);
  if (!endpoint) {
    params?.warn?.(
      `OpenSandbox endpoint payload missing endpoint URL for ${sandboxId}:${execdPort}.`,
    );
    return { execdBaseUrl: undefined, sandboxId };
  }
  return { execdBaseUrl: endpoint, sandboxId };
}
