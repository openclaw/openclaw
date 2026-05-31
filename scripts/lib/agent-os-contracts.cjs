"use strict";

const AGENT_OS_SCHEMA_VERSIONS = Object.freeze({
  artifact: "agent-os.artifact.v1",
  capability: "agent-os.capability.v1",
  proofEvent: "agent-os.proof-event.v1",
  sandboxSecurity: "agent-os.sandbox-security.v1",
  ticket: "agent-os.ticket.v1",
});

const AGENT_OS_TICKET_STATUSES = new Set([
  "OPEN",
  "CLAIMED",
  "IN_PROGRESS",
  "WAITING_APPROVAL",
  "BLOCKED",
  "DONE",
  "FAILED",
  "ARCHIVED",
]);

const AGENT_OS_TICKET_STATUS_ALIASES = Object.freeze({
  RUNNING: "IN_PROGRESS",
});

const AGENT_OS_PROOF_STATUSES = new Set(["INFO", "PASS", "WARN", "FAIL", "ACTION"]);
const AGENT_OS_SANDBOX_MODES = new Set([
  "off",
  "workspace-read",
  "workspace-write",
  "container",
  "remote",
]);
const AGENT_OS_NETWORK_POLICIES = new Set(["none", "allowlist", "full"]);
const AGENT_OS_FILESYSTEM_POLICIES = new Set(["none", "read", "workspace-write"]);
const AGENT_OS_SECRET_POLICIES = new Set(["none", "named-refs-only"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonMaybe(value, fallback = value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeString(value, fallback = null) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

function normalizeIdentifier(value, fallback) {
  const text = normalizeString(value, fallback);
  if (!text) {
    return fallback;
  }
  return text
    .replace(/[^A-Za-z0-9_.:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeString(entry)).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n]+/u)
      .map((entry) => normalizeString(entry))
      .filter(Boolean);
  }
  return [];
}

function normalizePlainObject(value, fallback = {}) {
  const parsed = parseJsonMaybe(value, value);
  return isPlainObject(parsed) ? parsed : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return fallback;
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeIsoDate(value, fallback = null) {
  const text = normalizeString(value);
  if (!text) {
    return fallback;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeAgentOsTicketStatus(status, fallback = "OPEN") {
  const normalized = normalizeString(status, fallback).toUpperCase();
  const aliased = AGENT_OS_TICKET_STATUS_ALIASES[normalized] || normalized;
  return AGENT_OS_TICKET_STATUSES.has(aliased) ? aliased : fallback;
}

function normalizeAgentOsProofStatus(status, fallback = "INFO") {
  const normalized = normalizeString(status, fallback).toUpperCase();
  return AGENT_OS_PROOF_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeSandboxMode(value, fallback = "off") {
  const raw = normalizeString(value, fallback).toLowerCase();
  const normalized = raw === "all" || raw === "agent" || raw === "docker" ? "container" : raw;
  return AGENT_OS_SANDBOX_MODES.has(normalized) ? normalized : fallback;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeString(value, fallback).toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeAgentOsTicket(input, options = {}) {
  const value = normalizePlainObject(input);
  const data = normalizePlainObject(value.data, {});
  const createdAt =
    normalizeIsoDate(value.createdAt || value.created_at) ||
    normalizeIsoDate(options.createdAt) ||
    new Date().toISOString();
  const id = normalizeString(value.id || options.id);
  const type = normalizeIdentifier(value.type || data.type || options.type, "generic");
  const inputPayload = normalizePlainObject(value.input, data.input || data);
  return {
    capabilityFamily: normalizeIdentifier(
      value.capabilityFamily || value.capability_family || data.capabilityFamily,
      null,
    ),
    constraints: normalizePlainObject(value.constraints || data.constraints, {}),
    createdAt,
    id,
    input: inputPayload,
    priority: normalizeInteger(value.priority ?? data.priority, 0),
    proofRequired: normalizeStringList(value.proofRequired || data.proofRequired),
    schemaVersion: AGENT_OS_SCHEMA_VERSIONS.ticket,
    status: normalizeAgentOsTicketStatus(value.status || data.status || options.status),
    targetAgent: normalizeString(value.targetAgent || value.target_agent || data.targetAgent),
    title: normalizeString(value.title || data.title, type),
    ttlMinutes: normalizeInteger(value.ttlMinutes ?? value.ttl_minutes ?? data.ttlMinutes, 60),
    type,
    updatedAt: normalizeIsoDate(value.updatedAt || value.updated_at) || createdAt,
  };
}

function normalizeAgentOsSandboxSecurityContract(input = {}) {
  const value = normalizePlainObject(input);
  return {
    approvals: normalizeStringList(value.approvals),
    filesystem: normalizeEnum(value.filesystem, AGENT_OS_FILESYSTEM_POLICIES, "none"),
    hostBridge: normalizeBoolean(value.hostBridge, false),
    mode: normalizeSandboxMode(value.mode),
    network: normalizeEnum(value.network, AGENT_OS_NETWORK_POLICIES, "none"),
    schemaVersion: AGENT_OS_SCHEMA_VERSIONS.sandboxSecurity,
    secrets: normalizeEnum(value.secrets, AGENT_OS_SECRET_POLICIES, "named-refs-only"),
  };
}

function normalizeAgentOsLifecycleContract(input = {}) {
  const value = normalizePlainObject(input);
  return {
    heartbeatSeconds: Math.max(5, normalizeInteger(value.heartbeatSeconds, 30)),
    retryLimit: Math.max(0, normalizeInteger(value.retryLimit, 0)),
    timeoutSeconds: Math.max(30, normalizeInteger(value.timeoutSeconds, 900)),
  };
}

function normalizeAgentOsCapabilityManifest(input) {
  const value = normalizePlainObject(input);
  const params = normalizePlainObject(value.params, {});
  const capabilityFamilies = normalizeStringList(
    value.capabilityFamilies || params.capabilityFamilies || params.capabilityFamily,
  );
  const ticketTypes = normalizeStringList(value.ticketTypes || params.ticketTypes);
  const proof = normalizePlainObject(value.proof, {});
  const artifacts = normalizePlainObject(value.artifacts, {});
  const tools = normalizePlainObject(value.tools, {});
  return {
    artifacts: {
      kinds: normalizeStringList(artifacts.kinds || ["proof-bundle"]),
    },
    capabilityFamilies,
    id: normalizeIdentifier(value.id, "agent"),
    lifecycle: normalizeAgentOsLifecycleContract(value.lifecycle),
    name: normalizeString(value.name, value.id || "Agent"),
    proof: {
      commands: normalizeStringList(proof.commands || "proof-events-bundle"),
      required: proof.required !== false,
    },
    runtime: normalizeString(value.runtime, "native-openclaw"),
    sandbox: normalizeAgentOsSandboxSecurityContract(value.sandbox),
    schemaVersion: AGENT_OS_SCHEMA_VERSIONS.capability,
    ticketTypes,
    tools: {
      allow: normalizeStringList(tools.allow),
      deny: normalizeStringList(tools.deny),
    },
    version: normalizeString(value.version, "1.0.0"),
  };
}

function normalizeArtifactRefs(value) {
  const refs = Array.isArray(value) ? value : value ? [value] : [];
  return refs
    .map((entry) => {
      if (typeof entry === "string") {
        return { path: entry };
      }
      if (!isPlainObject(entry)) {
        return null;
      }
      return {
        id: normalizeString(entry.id),
        kind: normalizeIdentifier(entry.kind, "artifact"),
        path: normalizeString(entry.path || entry.artifactPath),
      };
    })
    .filter((entry) => entry && entry.path);
}

function normalizeAgentOsProofEvent(input) {
  const value = normalizePlainObject(input);
  const payload = value.data !== undefined ? value.data : value.payload;
  const artifactRefs = normalizeArtifactRefs(
    value.artifactRefs || value.artifact_refs || value.artifactPath || value.artifact_path,
  );
  const summary = normalizeString(value.message || value.summary);
  return {
    agentId: normalizeIdentifier(value.agentId || value.agent_id, null),
    artifactRefs,
    component: normalizeIdentifier(value.component || value.componentName, "unknown"),
    createdAt: normalizeIsoDate(value.createdAt || value.created_at) || new Date().toISOString(),
    data: payload === undefined ? null : payload,
    eventType: normalizeIdentifier(
      value.eventType || value.event_type,
      "proof_event",
    ).toUpperCase(),
    message: summary,
    runId: normalizeString(value.runId || value.run_id),
    schemaVersion: AGENT_OS_SCHEMA_VERSIONS.proofEvent,
    status: normalizeAgentOsProofStatus(value.status),
    ticketId: normalizeString(value.ticketId || value.ticket_id),
  };
}

function normalizeAgentOsArtifactContract(input) {
  const value = normalizePlainObject(input);
  return {
    createdAt: normalizeIsoDate(value.createdAt || value.created_at) || new Date().toISOString(),
    createdBy: normalizeIdentifier(value.createdBy || value.created_by, "unknown"),
    id: normalizeString(value.id),
    kind: normalizeIdentifier(value.kind, "artifact"),
    mediaType: normalizeString(value.mediaType || value.media_type, "application/octet-stream"),
    path: normalizeString(value.path || value.artifactPath),
    redaction: {
      status: normalizeIdentifier(value.redaction?.status || value.redactionStatus, "not-needed"),
    },
    runId: normalizeString(value.runId || value.run_id),
    schemaVersion: AGENT_OS_SCHEMA_VERSIONS.artifact,
    sha256: normalizeString(value.sha256),
    ticketId: normalizeString(value.ticketId || value.ticket_id),
    visibility: normalizeIdentifier(value.visibility, "local"),
  };
}

function collectContractErrors(kind, value) {
  const errors = [];
  const requireString = (field) => {
    if (!normalizeString(value[field])) {
      errors.push(`${kind}.${field} is required`);
    }
  };
  if (kind === "ticket") {
    requireString("id");
    requireString("type");
    requireString("status");
  } else if (kind === "capability") {
    requireString("id");
    if (!Array.isArray(value.ticketTypes) || value.ticketTypes.length === 0) {
      errors.push("capability.ticketTypes must contain at least one ticket type");
    }
    if (!Array.isArray(value.capabilityFamilies) || value.capabilityFamilies.length === 0) {
      errors.push("capability.capabilityFamilies must contain at least one family");
    }
  } else if (kind === "proofEvent") {
    requireString("component");
    requireString("eventType");
    requireString("status");
  } else if (kind === "artifact") {
    requireString("kind");
    requireString("path");
  }
  return errors;
}

function validationResult(kind, value) {
  const errors = collectContractErrors(kind, value);
  return { errors, ok: errors.length === 0, value };
}

function validateAgentOsTicket(input, options = {}) {
  return validationResult("ticket", normalizeAgentOsTicket(input, options));
}

function validateAgentOsCapabilityManifest(input) {
  return validationResult("capability", normalizeAgentOsCapabilityManifest(input));
}

function validateAgentOsProofEvent(input) {
  return validationResult("proofEvent", normalizeAgentOsProofEvent(input));
}

function validateAgentOsArtifactContract(input) {
  return validationResult("artifact", normalizeAgentOsArtifactContract(input));
}

function assertContract(result) {
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.value;
}

module.exports = {
  AGENT_OS_FILESYSTEM_POLICIES,
  AGENT_OS_NETWORK_POLICIES,
  AGENT_OS_PROOF_STATUSES,
  AGENT_OS_SANDBOX_MODES,
  AGENT_OS_SCHEMA_VERSIONS,
  AGENT_OS_SECRET_POLICIES,
  AGENT_OS_TICKET_STATUSES,
  assertAgentOsArtifactContract: (input) => assertContract(validateAgentOsArtifactContract(input)),
  assertAgentOsCapabilityManifest: (input) =>
    assertContract(validateAgentOsCapabilityManifest(input)),
  assertAgentOsProofEvent: (input) => assertContract(validateAgentOsProofEvent(input)),
  assertAgentOsTicket: (input, options) => assertContract(validateAgentOsTicket(input, options)),
  normalizeAgentOsArtifactContract,
  normalizeAgentOsCapabilityManifest,
  normalizeAgentOsLifecycleContract,
  normalizeAgentOsProofEvent,
  normalizeAgentOsProofStatus,
  normalizeAgentOsSandboxSecurityContract,
  normalizeAgentOsTicket,
  normalizeAgentOsTicketStatus,
  normalizeStringList,
  validateAgentOsArtifactContract,
  validateAgentOsCapabilityManifest,
  validateAgentOsProofEvent,
  validateAgentOsTicket,
};
