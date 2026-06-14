export type BrowserStewardRuntimeDecision = {
  boundaryDecision: "allow" | "approval_required";
  requestedAction: string;
  affectedBrowserProfile: string;
  affectedSession: string;
  credentialClassesInvolved: string[];
  dataSensitivity: "low" | "medium" | "high" | "critical";
  approvalRequired: boolean;
  safeNextAction: string;
  telemetryEvent: string;
};

type BrowserStewardRuntimeRequest = {
  action: string;
  profile?: string;
  agentSessionKey?: string;
  approved?: boolean;
  delegated?: boolean;
  request?: unknown;
};

const BROWSER_STEWARD_AGENT_ID = "browser-session-credential-steward";

const NON_SECRET_READ_ACTIONS = new Set(["status", "profiles", "doctor"]);

const ACTION_CREDENTIAL_CLASSES: Record<string, string[]> = {
  start: ["browser profile"],
  stop: ["browser profile"],
  open: ["browser session"],
  focus: ["browser session"],
  close: ["browser session"],
  snapshot: ["browser session", "page content"],
  screenshot: ["browser session", "page image"],
  navigate: ["browser session"],
  console: ["browser session", "page content"],
  pdf: ["authenticated export"],
  upload: ["browser session", "local file"],
  dialog: ["browser session"],
  act: ["browser session", "profile mutation"],
  tabs: ["browser session", "tab metadata"],
};

export function isBrowserStewardSession(sessionKey: string | undefined): boolean {
  return Boolean(sessionKey?.includes(BROWSER_STEWARD_AGENT_ID));
}

function normalizeProxyPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveBrowserStewardProxyAction(params: {
  method?: string;
  path?: string;
  body?: unknown;
}): string {
  const method = String(params.method ?? "GET")
    .trim()
    .toUpperCase();
  const path = normalizeProxyPath(String(params.path ?? ""));
  if (method === "GET" && path === "/") {
    return "status";
  }
  if (method === "GET" && path === "/profiles") {
    return "profiles";
  }
  if (method === "GET" && path === "/doctor") {
    return "doctor";
  }
  if (method === "GET" && path === "/tabs") {
    return "tabs";
  }
  if (method === "POST" && path === "/start") {
    return "start";
  }
  if (method === "POST" && path === "/stop") {
    return "stop";
  }
  if (method === "POST" && path === "/tabs/open") {
    return "open";
  }
  if (method === "POST" && path === "/tabs/focus") {
    return "focus";
  }
  if (method === "DELETE" && path.startsWith("/tabs/")) {
    return "close";
  }
  if (method === "POST" && path === "/act") {
    const kind =
      params.body && typeof params.body === "object"
        ? (params.body as Record<string, unknown>).kind
        : undefined;
    return kind === "close" ? "close" : "act";
  }
  if (method === "POST" && path === "/navigate") {
    return "navigate";
  }
  if (method === "POST" && path === "/snapshot") {
    return "snapshot";
  }
  if (method === "POST" && path === "/screenshot") {
    return "screenshot";
  }
  if (method === "POST" && path === "/pdf") {
    return "pdf";
  }
  if (method === "POST" && path === "/hooks/file-chooser") {
    return "upload";
  }
  if (method === "POST" && path === "/hooks/dialog") {
    return "dialog";
  }
  return "unknown";
}

function normalizeAction(value: string): string {
  return value.trim().toLowerCase();
}

function containsSecretLikeValue(value: unknown): boolean {
  if (typeof value === "string") {
    return /(?:password|token|cookie|secret|private[-_ ]?key|api[-_ ]?key|wallet|bearer\s+[a-z0-9._-]+)/i.test(
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSecretLikeValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, entry]) =>
        /(?:password|token|cookie|secret|privateKey|apiKey|wallet)/i.test(key) ||
        containsSecretLikeValue(entry),
    );
  }
  return false;
}

export function evaluateBrowserStewardRuntimeGuard(
  request: BrowserStewardRuntimeRequest,
): BrowserStewardRuntimeDecision {
  const action = normalizeAction(request.action);
  const profile = request.profile?.trim() || "UNKNOWN";
  const credentialClasses = ACTION_CREDENTIAL_CLASSES[action] ?? ["browser session"];
  const readOnlyAllowed = NON_SECRET_READ_ACTIONS.has(action) && !containsSecretLikeValue(request);
  const approved = request.approved === true || request.delegated === true;
  const allow = readOnlyAllowed || approved;
  return {
    boundaryDecision: allow ? "allow" : "approval_required",
    requestedAction: action || "UNKNOWN",
    affectedBrowserProfile: profile,
    affectedSession: "UNKNOWN",
    credentialClassesInvolved: credentialClasses,
    dataSensitivity: readOnlyAllowed ? "low" : "high",
    approvalRequired: !allow,
    safeNextAction: allow
      ? "proceed with redacted Browser Steward runtime guard metadata"
      : "block and hand off to Control Director for explicit approval or delegation",
    telemetryEvent: allow
      ? "browser_steward.boundary_decision"
      : containsSecretLikeValue(request)
        ? "browser_steward.blocked_credential_exposure"
        : "browser_steward.approval_gate",
  };
}

export function assertBrowserStewardRuntimeAllowed(
  request: BrowserStewardRuntimeRequest,
): BrowserStewardRuntimeDecision {
  const decision = evaluateBrowserStewardRuntimeGuard(request);
  if (decision.approvalRequired) {
    throw new Error(
      `Browser Steward runtime guard blocked ${decision.requestedAction}: approval_required; telemetry=${decision.telemetryEvent}; safe_next_action=${decision.safeNextAction}`,
    );
  }
  return decision;
}
