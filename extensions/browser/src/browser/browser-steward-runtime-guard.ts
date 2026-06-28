export type BrowserStewardRuntimeDecision = {
  boundaryDecision: "allow" | "approval_required";
  requestedAction: string;
  affectedBrowserProfile: string;
  affectedSession: string;
  sessionBoundary: BrowserStewardSessionBoundary;
  credentialExposureKind: BrowserStewardCredentialExposureKind;
  credentialExposureReasonCode: BrowserStewardCredentialExposureReasonCode;
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
  agentId?: string;
  approved?: boolean;
  delegated?: boolean;
  request?: unknown;
};

const BROWSER_STEWARD_AGENT_ID = "browser-session-credential-steward";

export type BrowserStewardSessionBoundaryKind =
  | "browser_steward"
  | "other_agent"
  | "unscoped"
  | "unknown";

export type BrowserStewardSessionBoundary = {
  kind: BrowserStewardSessionBoundaryKind;
  ownerAgentId: string;
  affectedSession: string;
};

export type BrowserStewardCredentialExposureKind =
  | "none"
  | "credential_like"
  | "credential_material";

export type BrowserStewardCredentialExposureReasonCode =
  | "no_credential_material"
  | "credential_like_label"
  | "credential_material_detected";

type BrowserStewardCredentialExposure = {
  exposureKind: BrowserStewardCredentialExposureKind;
  reasonCode: BrowserStewardCredentialExposureReasonCode;
  classes: string[];
  blocked: boolean;
};

const NON_SECRET_READ_ACTIONS = new Set(["status", "profiles", "doctor"]);
const CREDENTIAL_CLASS_ORDER = Object.freeze([
  "api key",
  "password",
  "token",
  "cookie",
  "private key",
  "secret",
]);

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

const UNKNOWN_SESSION_BOUNDARY: BrowserStewardSessionBoundary = {
  kind: "unknown",
  ownerAgentId: "UNKNOWN",
  affectedSession: "UNKNOWN",
};

export function resolveBrowserStewardSessionBoundary(
  sessionKey: string | undefined,
): BrowserStewardSessionBoundary {
  const normalized = sessionKey?.trim().toLowerCase();
  if (!normalized) {
    return UNKNOWN_SESSION_BOUNDARY;
  }
  const parts = normalized.split(":");
  if (parts[0] !== "agent") {
    return {
      kind: "unscoped",
      ownerAgentId: "UNKNOWN",
      affectedSession: "UNSCOPED",
    };
  }
  const ownerAgentId = parts[1]?.trim();
  const hasMalformedEmptyTail =
    parts.length > 2 && !parts.slice(2).some((part) => part.trim().length > 0);
  if (!ownerAgentId || hasMalformedEmptyTail) {
    return UNKNOWN_SESSION_BOUNDARY;
  }
  if (ownerAgentId === BROWSER_STEWARD_AGENT_ID) {
    return {
      kind: "browser_steward",
      ownerAgentId,
      affectedSession: `agent:${BROWSER_STEWARD_AGENT_ID}:REDACTED`,
    };
  }
  return {
    kind: "other_agent",
    ownerAgentId,
    affectedSession: `agent:${ownerAgentId}:REDACTED`,
  };
}

export function isBrowserStewardSession(sessionKey: string | undefined): boolean {
  return resolveBrowserStewardSessionBoundary(sessionKey).kind === "browser_steward";
}

export function isBrowserStewardAgentId(agentId: string | undefined): boolean {
  return agentId?.trim().toLowerCase() === BROWSER_STEWARD_AGENT_ID;
}

export function shouldApplyBrowserStewardRuntimeGuard(params: {
  sessionKey?: string;
  agentId?: string;
}): boolean {
  return isBrowserStewardSession(params.sessionKey) || isBrowserStewardAgentId(params.agentId);
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

function safeRequestedAction(action: string): string {
  if (NON_SECRET_READ_ACTIONS.has(action) || ACTION_CREDENTIAL_CLASSES[action]) {
    return action;
  }
  return "unknown";
}

function classifyCredentialLabel(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (/api[-_ ]?key/.test(normalized)) {
    return "api key";
  }
  if (/password|passphrase|passwd/.test(normalized)) {
    return "password";
  }
  if (/authorization|bearer|access[-_ ]?token|refresh[-_ ]?token|\btoken\b/.test(normalized)) {
    return "token";
  }
  if (/cookie|session[-_ ]?cookie/.test(normalized)) {
    return "cookie";
  }
  if (/private[-_ ]?key|wallet/.test(normalized)) {
    return "private key";
  }
  if (/secret|credential/.test(normalized)) {
    return "secret";
  }
  return undefined;
}

function classifyCredentialMaterial(value: string): string | undefined {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    return "private key";
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{4,}/i.test(value)) {
    return "token";
  }
  if (
    /\b(?:authorization|access[-_ ]?token|refresh[-_ ]?token|token)\s*[:=]\s*["']?[^\s"']{4,}/i.test(
      value,
    )
  ) {
    return "token";
  }
  if (/\bpassword\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "password";
  }
  if (/\bcookie\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "cookie";
  }
  if (/\bapi[-_ ]?key\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "api key";
  }
  if (/\bsecret\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "secret";
  }
  if (/\b(?:sk|pk)-[a-z0-9][a-z0-9._-]{8,}/i.test(value)) {
    return "api key";
  }
  if (/\b(?:xox[baprs]-|gh[pousr]_|glpat-)[a-z0-9_-]{8,}/i.test(value)) {
    return "token";
  }
  return undefined;
}

function hasConcreteCredentialValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasConcreteCredentialValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => hasConcreteCredentialValue(entry));
  }
  return false;
}

function evaluateBrowserCredentialExposure(value: unknown): BrowserStewardCredentialExposure {
  const classes = new Set<string>();
  let credentialLike = false;
  let material = false;
  const scan = (entry: unknown): void => {
    if (typeof entry === "string") {
      const materialClass = classifyCredentialMaterial(entry);
      if (materialClass) {
        classes.add(materialClass);
        material = true;
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) {
        scan(item);
      }
      return;
    }
    if (!entry || typeof entry !== "object") {
      return;
    }
    const record = entry as Record<string, unknown>;
    const labels = Array.isArray(record.labels) ? record.labels : [];
    for (const label of labels) {
      if (typeof label !== "string") {
        continue;
      }
      const labelClass = classifyCredentialLabel(label);
      if (!labelClass) {
        continue;
      }
      classes.add(labelClass);
      credentialLike = true;
      if (hasConcreteCredentialValue(record.value)) {
        material = true;
      }
    }
    for (const [key, nested] of Object.entries(entry)) {
      const labelClass = classifyCredentialLabel(key);
      if (labelClass) {
        classes.add(labelClass);
        credentialLike = true;
        if (hasConcreteCredentialValue(nested)) {
          material = true;
        }
      }
      scan(nested);
    }
  };
  scan(value);
  const sortedClasses = CREDENTIAL_CLASS_ORDER.filter((entry) => classes.has(entry));
  if (material) {
    return {
      exposureKind: "credential_material",
      reasonCode: "credential_material_detected",
      classes: sortedClasses,
      blocked: true,
    };
  }
  if (credentialLike) {
    return {
      exposureKind: "credential_like",
      reasonCode: "credential_like_label",
      classes: sortedClasses,
      blocked: false,
    };
  }
  return {
    exposureKind: "none",
    reasonCode: "no_credential_material",
    classes: [],
    blocked: false,
  };
}

function uniqueCredentialClasses(values: string[]): string[] {
  const unique = new Set(values);
  return values.filter((value) => {
    if (!unique.has(value)) {
      return false;
    }
    unique.delete(value);
    return true;
  });
}

export function evaluateBrowserStewardRuntimeGuard(
  request: BrowserStewardRuntimeRequest,
): BrowserStewardRuntimeDecision {
  const action = normalizeAction(request.action);
  const requestedAction = safeRequestedAction(action);
  const profile = request.profile?.trim() || "UNKNOWN";
  const sessionBoundary = resolveBrowserStewardSessionBoundary(request.agentSessionKey);
  const credentialExposure = evaluateBrowserCredentialExposure(request);
  const credentialClasses = uniqueCredentialClasses([
    ...(ACTION_CREDENTIAL_CLASSES[action] ?? ["browser session"]),
    ...credentialExposure.classes,
  ]);
  const readOnlyAllowed = NON_SECRET_READ_ACTIONS.has(action) && !credentialExposure.blocked;
  const approved = request.approved === true || request.delegated === true;
  const allow = readOnlyAllowed || approved;
  return {
    boundaryDecision: allow ? "allow" : "approval_required",
    requestedAction,
    affectedBrowserProfile: profile,
    affectedSession: sessionBoundary.affectedSession,
    sessionBoundary,
    credentialExposureKind: credentialExposure.exposureKind,
    credentialExposureReasonCode: credentialExposure.reasonCode,
    credentialClassesInvolved: credentialClasses,
    dataSensitivity: readOnlyAllowed ? "low" : credentialExposure.blocked ? "critical" : "high",
    approvalRequired: !allow,
    safeNextAction: allow
      ? "proceed with redacted Browser Steward runtime guard metadata"
      : credentialExposure.blocked
        ? "block credential exposure and hand off to Control Director for explicit approval or delegation"
        : "block and hand off to Control Director for explicit approval or delegation",
    telemetryEvent: allow
      ? "browser_steward.boundary_decision"
      : credentialExposure.blocked
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
