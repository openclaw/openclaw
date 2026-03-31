type LocalBrowserBridgeBrowser = "safari" | "chrome";
type LocalBrowserBridgeAttachMode = "direct" | "relay";
type LocalBrowserBridgeRouteName = "safari-direct" | "chrome-relay";
type LocalBrowserBridgeKind = "safari-actionable" | "chrome-readonly";
type LocalBrowserBridgeAction = "status" | "tabs" | "open" | "navigate";

export type LocalBrowserBridgeRoute = {
  browser: LocalBrowserBridgeBrowser;
  attachMode: LocalBrowserBridgeAttachMode;
  route: LocalBrowserBridgeRouteName;
  kind: LocalBrowserBridgeKind;
};

type LocalBrowserBridgeSession = {
  browser?: unknown;
  attach?: {
    mode?: unknown;
  };
};

type LocalBrowserBridgeResponseRecord = Record<string, unknown>;
type LocalBrowserBridgeRequestInit = Omit<RequestInit, "signal">;

function asRecord(value: unknown): LocalBrowserBridgeResponseRecord | null {
  return value && typeof value === "object" ? (value as LocalBrowserBridgeResponseRecord) : null;
}

function readSessions(value: unknown): LocalBrowserBridgeSession[] {
  const record = asRecord(value);
  return Array.isArray(record?.sessions) ? (record.sessions as LocalBrowserBridgeSession[]) : [];
}

function readTargetUrl(input: Record<string, unknown>): string {
  const targetUrl = typeof input.targetUrl === "string" ? input.targetUrl.trim() : "";
  if (targetUrl) {
    return targetUrl;
  }
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (url) {
    return url;
  }
  throw new Error("targetUrl is required");
}

export function getLocalBrowserBridgeBaseUrl(): string | null {
  const raw = process.env.OPENCLAW_LOCAL_BROWSER_BRIDGE_URL?.trim();
  if (!raw) {
    return null;
  }
  return raw.replace(/\/$/, "");
}

export function resolveLocalBrowserBridgeRoute(profile?: string): LocalBrowserBridgeRoute | null {
  if (profile === "user") {
    return {
      browser: "safari",
      attachMode: "direct",
      route: "safari-direct",
      kind: "safari-actionable",
    };
  }
  if (profile === "chrome-relay") {
    return {
      browser: "chrome",
      attachMode: "relay",
      route: "chrome-relay",
      kind: "chrome-readonly",
    };
  }
  return null;
}

export function resolveLocalBrowserBridgeRequestAction(params: {
  method: "GET" | "POST" | "DELETE";
  path: string;
}): LocalBrowserBridgeAction | null {
  if (params.method === "GET" && params.path === "/") {
    return "status";
  }
  if (params.method === "GET" && params.path === "/tabs") {
    return "tabs";
  }
  if (params.method === "POST" && params.path === "/tabs/open") {
    return "open";
  }
  if (params.method === "POST" && params.path === "/navigate") {
    return "navigate";
  }
  return null;
}

export async function fetchLocalBrowserBridgeJson(
  path: string,
  init?: LocalBrowserBridgeRequestInit,
  timeoutMs?: number,
): Promise<unknown> {
  const baseUrl = getLocalBrowserBridgeBaseUrl();
  if (!baseUrl) {
    throw new Error("OPENCLAW_LOCAL_BROWSER_BRIDGE_URL is not set.");
  }
  const controller = new AbortController();
  const timer =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : undefined;
    const payloadRecord = asRecord(payload);
    if (!response.ok) {
      throw new Error(
        typeof payloadRecord?.error === "string"
          ? payloadRecord.error
          : typeof payloadRecord?.message === "string"
            ? payloadRecord.message
            : `local-browser-bridge request failed: ${response.status}`,
      );
    }
    return payload;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function summarizeLocalBrowserBridgeDiagnostics(profile: string, diagnostics: unknown) {
  const diagnosticsRecord = asRecord(diagnostics);
  const details = asRecord(diagnosticsRecord?.diagnostics) ?? diagnosticsRecord;
  const blockers = Array.isArray(details?.blockers) ? details.blockers : [];
  const ready = typeof details?.ready === "boolean" ? details.ready : blockers.length === 0;
  return {
    profile,
    browser: details?.browser ?? null,
    attachMode: asRecord(details?.attach)?.mode ?? null,
    route:
      details?.browser === "safari"
        ? "safari-direct"
        : profile === "chrome-relay"
          ? "chrome-relay"
          : null,
    ready,
    blockers,
    diagnostics: details,
  };
}

async function runLocalBrowserBridgeAction(params: {
  action: LocalBrowserBridgeAction;
  profile: string;
  route: LocalBrowserBridgeRoute;
  input: Record<string, unknown>;
  timeoutMs?: number;
}) {
  const { action, profile, route, input, timeoutMs } = params;
  switch (action) {
    case "status": {
      const [capabilities, diagnostics, sessions] = await Promise.all([
        fetchLocalBrowserBridgeJson(
          `/v1/capabilities?browser=${encodeURIComponent(route.browser)}`,
          undefined,
          timeoutMs,
        ),
        fetchLocalBrowserBridgeJson(
          `/v1/diagnostics?browser=${encodeURIComponent(route.browser)}`,
          undefined,
          timeoutMs,
        ),
        fetchLocalBrowserBridgeJson(`/v1/sessions`, undefined, timeoutMs).catch(() => ({
          sessions: [],
        })),
      ]);
      const matchingSessions = readSessions(sessions).filter(
        (session) =>
          session.browser === route.browser &&
          (route.attachMode === "relay" ? session.attach?.mode === "relay" : true),
      );
      const capabilitiesRecord = asRecord(capabilities);
      return {
        ok: true,
        adapter: "local-browser-bridge",
        profile,
        route: route.route,
        kind: route.kind,
        browser: route.browser,
        attachMode: route.attachMode,
        status: summarizeLocalBrowserBridgeDiagnostics(profile, diagnostics),
        matchingSessions,
        capabilities: capabilitiesRecord?.capabilities ?? capabilities,
      };
    }
    case "tabs": {
      const tabsPayload = asRecord(
        await fetchLocalBrowserBridgeJson(
          `/v1/tabs?browser=${encodeURIComponent(route.browser)}`,
          undefined,
          timeoutMs,
        ),
      );
      return {
        ok: true,
        adapter: "local-browser-bridge",
        profile,
        route: route.route,
        tabs: Array.isArray(tabsPayload?.tabs) ? tabsPayload.tabs : [],
      };
    }
    case "open":
    case "navigate": {
      if (route.browser === "chrome") {
        throw new Error(
          `profile="${profile}" is backed by local-browser-bridge Chrome relay, which is read-only in v1. Use tabs/status only.`,
        );
      }
      const url = readTargetUrl(input);
      const navigation = asRecord(
        await fetchLocalBrowserBridgeJson(
          "/v1/navigate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ browser: route.browser, url }),
          },
          timeoutMs,
        ),
      );
      return {
        ok: true,
        adapter: "local-browser-bridge",
        profile,
        route: route.route,
        ...navigation,
        url: typeof navigation?.url === "string" ? navigation.url : url,
      };
    }
  }
}

export async function executeLocalBrowserBridgeAction(params: {
  action: string;
  profile?: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<Record<string, unknown> | null> {
  if (!getLocalBrowserBridgeBaseUrl()) {
    return null;
  }
  const profile = params.profile?.trim();
  const route = resolveLocalBrowserBridgeRoute(profile);
  if (!profile || !route) {
    return null;
  }
  if (
    params.action !== "status" &&
    params.action !== "tabs" &&
    params.action !== "open" &&
    params.action !== "navigate"
  ) {
    return null;
  }
  return await runLocalBrowserBridgeAction({
    action: params.action,
    profile,
    route,
    input: params.input,
    timeoutMs: params.timeoutMs,
  });
}

export async function executeLocalBrowserBridgeRequest(params: {
  profile?: string;
  request: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: unknown;
  };
  timeoutMs?: number;
}): Promise<Record<string, unknown> | null> {
  if (!getLocalBrowserBridgeBaseUrl()) {
    return null;
  }
  const profile = params.profile?.trim();
  const route = resolveLocalBrowserBridgeRoute(profile);
  if (!profile || !route) {
    return null;
  }
  const action = resolveLocalBrowserBridgeRequestAction(params.request);
  if (!action) {
    return null;
  }
  const input = asRecord(params.request.body) ?? {};
  const payload = await runLocalBrowserBridgeAction({
    action,
    profile,
    route,
    input,
    timeoutMs: params.timeoutMs,
  });
  if (action !== "status") {
    return payload;
  }
  return {
    ...payload,
    enabled: true,
    running: Boolean(asRecord(payload.status)?.ready),
    transport: route.attachMode === "relay" ? "chrome-mcp" : "local-browser-bridge",
    chosenBrowser: route.browser,
    detectedBrowser: route.browser,
    color: profile === "chrome-relay" ? "#4285F4" : "#0A84FF",
  };
}
