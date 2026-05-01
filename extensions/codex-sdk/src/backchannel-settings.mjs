const PROTOCOL_VERSION = 3;
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

const DEFAULT_READ_METHODS = [
  "health",
  "status",
  "models.list",
  "tools.catalog",
  "agents.list",
  "agent.identity.get",
  "skills.status",
  "sessions.list",
  "sessions.get",
  "sessions.preview",
  "sessions.resolve",
  "sessions.usage",
  "chat.history",
  "config.get",
  "config.schema.lookup",
  "codex.status",
  "codex.routes",
  "codex.sessions",
  "codex.events",
  "codex.session.export",
  "codex.inbox",
  "codex.doctor",
];

const DEFAULT_SAFE_WRITE_METHODS = ["codex.proposal.create", "codex.proposal.update"];

export function createBackchannelSettings() {
  const readMethods = parseStringListEnv(
    "OPENCLAW_CODEX_BACKCHANNEL_READ_METHODS",
    DEFAULT_READ_METHODS,
  );
  const safeWriteMethods = parseStringListEnv(
    "OPENCLAW_CODEX_BACKCHANNEL_SAFE_WRITE_METHODS",
    DEFAULT_SAFE_WRITE_METHODS,
  );
  const allowedMethods = parseStringListEnv("OPENCLAW_CODEX_BACKCHANNEL_ALLOWED_METHODS", [
    ...readMethods,
    ...safeWriteMethods,
  ]);
  return {
    gatewayUrl:
      process.env.OPENCLAW_CODEX_BACKCHANNEL_URL ||
      process.env.OPENCLAW_GATEWAY_URL ||
      process.env.CLAWDBOT_GATEWAY_URL ||
      DEFAULT_GATEWAY_URL,
    token:
      process.env.OPENCLAW_CODEX_BACKCHANNEL_TOKEN ||
      process.env.OPENCLAW_GATEWAY_TOKEN ||
      process.env.CLAWDBOT_GATEWAY_TOKEN ||
      "",
    password:
      process.env.OPENCLAW_CODEX_BACKCHANNEL_PASSWORD ||
      process.env.OPENCLAW_GATEWAY_PASSWORD ||
      process.env.CLAWDBOT_GATEWAY_PASSWORD ||
      "",
    stateDir:
      process.env.OPENCLAW_CODEX_BACKCHANNEL_STATE_DIR || process.env.OPENCLAW_STATE_DIR || "",
    allowedMethods: new Set(allowedMethods),
    readMethods: new Set(readMethods),
    safeWriteMethods: new Set(safeWriteMethods),
    requireWriteToken: parseBooleanEnv("OPENCLAW_CODEX_BACKCHANNEL_REQUIRE_WRITE_TOKEN", true),
    writeTokenEnv:
      process.env.OPENCLAW_CODEX_BACKCHANNEL_WRITE_TOKEN_ENV ||
      "OPENCLAW_CODEX_BACKCHANNEL_WRITE_TOKEN",
    requestTimeoutMs: parsePositiveIntegerEnv(
      "OPENCLAW_CODEX_BACKCHANNEL_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    maxPayloadBytes: parsePositiveIntegerEnv(
      "OPENCLAW_CODEX_BACKCHANNEL_MAX_PAYLOAD_BYTES",
      DEFAULT_MAX_PAYLOAD_BYTES,
    ),
  };
}

export function normalizeMethod(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]+$/.test(value.trim()) ? value.trim() : "";
}

export function isMethodAllowed(settings, method) {
  return settings.allowedMethods.has(method);
}

export function requiresWriteToken(settings, method) {
  if (!settings.requireWriteToken) {
    return false;
  }
  return !settings.readMethods.has(method) && !settings.safeWriteMethods.has(method);
}

export function authorizeGatewayMethod(settings, method, args) {
  if (!isMethodAllowed(settings, method)) {
    throw new Error(`Gateway method is not allowed by the Codex backchannel: ${method}`);
  }
  if (!requiresWriteToken(settings, method)) {
    return;
  }
  const expected = process.env[settings.writeTokenEnv] || "";
  const provided =
    args && typeof args === "object" && typeof args.writeToken === "string" ? args.writeToken : "";
  if (!expected) {
    throw new Error(
      `Gateway method ${method} requires ${settings.writeTokenEnv}, but that environment variable is not set.`,
    );
  }
  if (provided !== expected) {
    throw new Error(`Gateway method ${method} requires a matching writeToken.`);
  }
}

export function connectParams(settings, method) {
  const auth =
    settings.token || settings.password
      ? {
          ...(settings.token ? { token: settings.token } : {}),
          ...(settings.password ? { password: settings.password } : {}),
        }
      : undefined;
  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "codex-sdk-backchannel",
      displayName: "Codex SDK Backchannel",
      version: "2026.5.1",
      platform: process.platform,
      mode: "cli",
      instanceId: `codex-backchannel:${process.pid}:${Date.now()}`,
    },
    caps: ["mcp.backchannel", "codex.sdk"],
    commands: ["openclaw_status", "openclaw_gateway_request", "openclaw_proposal"],
    ...(auth ? { auth } : {}),
    role: "operator",
    scopes: scopesForMethod(settings, method),
  };
}

function scopesForMethod(settings, method) {
  if (settings.readMethods.has(method)) {
    return ["operator.read"];
  }
  if (settings.safeWriteMethods.has(method)) {
    return ["operator.write"];
  }
  return [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
  ];
}

function parseStringListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return [...fallback];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => entry.trim());
    }
  } catch {
    // Fall through to comma parsing.
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
