/**
 * A2A 1.0 wire data model.
 *
 * v1.0 dropped the v0.3 `kind` discriminators. Parts, `SendMessage` results and
 * stream frames are now identified by *which* member appears (a ProtoJSON `oneof`),
 * so none of these shapes carry a `kind` field on the wire. See
 * `docs/specification.md` §4 and `specification/a2a.proto`.
 */

export const A2A_TASK_STATES = {
  SUBMITTED: "TASK_STATE_SUBMITTED",
  WORKING: "TASK_STATE_WORKING",
  COMPLETED: "TASK_STATE_COMPLETED",
  FAILED: "TASK_STATE_FAILED",
  CANCELED: "TASK_STATE_CANCELED",
  INPUT_REQUIRED: "TASK_STATE_INPUT_REQUIRED",
  REJECTED: "TASK_STATE_REJECTED",
  AUTH_REQUIRED: "TASK_STATE_AUTH_REQUIRED",
} as const;

export type A2aTaskState = (typeof A2A_TASK_STATES)[keyof typeof A2A_TASK_STATES];

/** States after which no further task updates may be applied. */
export const A2A_TERMINAL_TASK_STATES: readonly A2aTaskState[] = [
  A2A_TASK_STATES.COMPLETED,
  A2A_TASK_STATES.FAILED,
  A2A_TASK_STATES.CANCELED,
  A2A_TASK_STATES.REJECTED,
];

/**
 * Interrupted states. The task stays alive and accepts a follow-up message with
 * the same `taskId`; that is how `input-required` / `auth-required` are resolved.
 */
export const A2A_INTERRUPTED_TASK_STATES: readonly A2aTaskState[] = [
  A2A_TASK_STATES.INPUT_REQUIRED,
  A2A_TASK_STATES.AUTH_REQUIRED,
];

export function isTerminalTaskState(state: A2aTaskState): boolean {
  return A2A_TERMINAL_TASK_STATES.includes(state);
}

export function isInterruptedTaskState(state: A2aTaskState): boolean {
  return A2A_INTERRUPTED_TASK_STATES.includes(state);
}

export const A2A_ROLES = {
  USER: "ROLE_USER",
  AGENT: "ROLE_AGENT",
} as const;

export type A2aRole = (typeof A2A_ROLES)[keyof typeof A2A_ROLES];

export type A2aMetadata = Record<string, unknown>;

/**
 * A single `Part`. Exactly one of `text` / `raw` / `url` / `data` is the payload:
 * - `text`  — plain text
 * - `raw`   — inline file bytes, base64 on the wire
 * - `url`   — reference to file content
 * - `data`  — arbitrary structured JSON
 */
export type A2aPart = {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  metadata?: A2aMetadata;
  filename?: string;
  mediaType?: string;
};

export type A2aMessage = {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: A2aRole;
  parts: A2aPart[];
  metadata?: A2aMetadata;
  extensions?: string[];
  referenceTaskIds?: string[];
};

export type A2aArtifact = {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2aPart[];
  metadata?: A2aMetadata;
  extensions?: string[];
};

export type A2aTaskStatus = {
  state: A2aTaskState;
  message?: A2aMessage;
  timestamp?: string;
};

export type A2aTask = {
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  artifacts: A2aArtifact[];
  history: A2aMessage[];
  metadata?: A2aMetadata;
};

export type A2aTaskStatusUpdateEvent = {
  taskId: string;
  contextId: string;
  status: A2aTaskStatus;
  metadata?: A2aMetadata;
};

export type A2aTaskArtifactUpdateEvent = {
  taskId: string;
  contextId: string;
  artifact: A2aArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: A2aMetadata;
};

/** `StreamResponse`: the discriminating key tells the peer what arrived. */
export type A2aStreamResponse =
  | { task: A2aTask }
  | { message: A2aMessage }
  | { statusUpdate: A2aTaskStatusUpdateEvent }
  | { artifactUpdate: A2aTaskArtifactUpdateEvent };

export type A2aAuthenticationInfo = {
  scheme: string;
  credentials?: string;
};

export type A2aPushNotificationConfig = {
  tenant?: string;
  id: string;
  taskId: string;
  url: string;
  token?: string;
  authentication?: A2aAuthenticationInfo;
};

export type A2aAgentInterface = {
  url: string;
  protocolBinding: string;
  tenant?: string;
  protocolVersion: string;
};

export type A2aAgentSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
};

export type A2aAgentCapabilities = {
  streaming?: boolean;
  pushNotifications?: boolean;
  extendedAgentCard?: boolean;
  extensions?: A2aAgentExtension[];
};

export type A2aAgentExtension = {
  uri: string;
  description?: string;
  required?: boolean;
  params?: A2aMetadata;
};

export type A2aSecurityScheme = {
  description?: string;
} & (
  | { httpAuthSecurityScheme: { scheme: string; bearerFormat?: string } }
  | { apiKeySecurityScheme: { location: "query" | "header" | "cookie"; name: string } }
  | { openIdConnectSecurityScheme: { openIdConnectUrl: string } }
  | { oauth2SecurityScheme: { oauth2MetadataUrl?: string } }
  | { mtlsSecurityScheme: Record<string, never> }
);

export type A2aSecurityRequirement = {
  schemes: Record<string, { list: string[] }>;
};

export type A2aAgentCard = {
  name: string;
  description: string;
  supportedInterfaces: A2aAgentInterface[];
  provider?: { organization?: string; url?: string };
  version: string;
  documentationUrl?: string;
  capabilities: A2aAgentCapabilities;
  securitySchemes?: Record<string, A2aSecurityScheme>;
  securityRequirements?: A2aSecurityRequirement[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aAgentSkill[];
  iconUrl?: string;
};

/** HTTP headers carrying A2A service parameters (§3.2.6, RFC 6648-style naming). */
export const A2A_VERSION_HEADER = "a2a-version";
export const A2A_EXTENSIONS_HEADER = "a2a-extensions";
export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_LEGACY_PROTOCOL_VERSION = "0.3";
export const A2A_NOTIFICATION_TOKEN_HEADER = "x-a2a-notification-token";
export const A2A_CONTENT_TYPE = "application/a2a+json";

/** Parse a comma-separated service-parameter header into trimmed entries. */
export function parseServiceParameterHeader(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const raw = Array.isArray(value) ? value.join(",") : value;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function normalizeA2aVersion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A2A 1.0 publishes `Major.Minor` only. Peers that still send `1.0.0` are
 * normalized rather than rejected so a patch suffix never breaks discovery.
 */
export function isSupportedA2aVersion(value: string | undefined): boolean {
  const version = normalizeA2aVersion(value);
  if (!version) {
    return true;
  }
  const [major, minor] = version.split(".");
  if (major !== "1") {
    return false;
  }
  return minor === undefined || minor === "0";
}
