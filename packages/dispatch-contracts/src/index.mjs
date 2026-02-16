const DECISION_VALUES = ["ALLOW", "DENY", "REQUIRE_APPROVAL", "REQUIRE_EVIDENCE"];
const COMMS_DIRECTIONS = ["INBOUND", "OUTBOUND"];
const RETENTION_CLASS_VALUES = ["SHORT", "STANDARD", "LONG_TERM", "REGULATORY"];
const REDACTION_STATES = ["NONE", "PENDING", "REDACTED"];
const REQUIRED_STRING_FIELDS = {
  nonEmpty: (value) => typeof value === "string" && value.trim() !== "",
  stringOrNull: (value) => value == null || typeof value === "string",
};

const W3C_TRACEPARENT_RE =
  /^([0-9a-fA-F]{2})-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{2})(?:-.*)?$/;

function isNonZeroHex(value, expectedLength) {
  if (typeof value !== "string" || value.length !== expectedLength) {
    return false;
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    return false;
  }
  return !/^0+$/.test(value);
}

function readHeaderValue(headers, name) {
  if (!headers || typeof headers !== "object") {
    return null;
  }

  const normalizedName = String(name).toLowerCase();
  const direct = headers[normalizedName];
  if (typeof direct === "string") {
    const value = direct.trim();
    return value === "" ? null : value;
  }
  if (Array.isArray(direct)) {
    const first = direct.find((entry) => typeof entry === "string" && entry.trim() !== "");
    if (first == null) {
      return null;
    }
    const value = first.trim();
    return value === "" ? null : value;
  }

  if (typeof headers.get === "function") {
    const value = headers.get(name);
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized === "" ? null : normalized;
    }
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalizedName) {
      continue;
    }
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized === "" ? null : normalized;
    }
    return null;
  }

  return null;
}

function trimOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

export function parseTraceParent(traceparent) {
  const normalized = trimOrNull(traceparent);
  if (!normalized) {
    return null;
  }

  const match = W3C_TRACEPARENT_RE.exec(normalized);
  if (!match) {
    return null;
  }

  const traceId = match[2];
  const parentId = match[3];
  if (!isNonZeroHex(traceId, 32) || !isNonZeroHex(parentId, 16)) {
    return null;
  }

  return {
    version: match[1].toLowerCase(),
    traceId: traceId.toLowerCase(),
    parentId: parentId.toLowerCase(),
    traceFlags: match[4].toLowerCase(),
    traceparent: `${match[1].toLowerCase()}-${traceId.toLowerCase()}-${parentId.toLowerCase()}-${match[4].toLowerCase()}`,
  };
}

export function extractTraceContextFromHeaders(headers = {}) {
  const traceparentHeader = readHeaderValue(headers, "traceparent");
  const tracestateHeader = readHeaderValue(headers, "tracestate");
  const legacyTraceId = readHeaderValue(headers, "x-trace-id");

  if (traceparentHeader) {
    const parsed = parseTraceParent(traceparentHeader);
    if (parsed) {
      return {
        source: "traceparent",
        traceId: parsed.traceId,
        traceParent: parsed.traceparent,
        traceState: tracestateHeader,
        isLegacy: false,
      };
    }
    if (legacyTraceId) {
      return {
        source: "legacy-fallback",
        traceId: legacyTraceId,
        traceParent: null,
        traceState: null,
        isLegacy: true,
      };
    }
  }

  if (legacyTraceId) {
    return {
      source: "legacy",
      traceId: legacyTraceId,
      traceParent: null,
      traceState: null,
      isLegacy: true,
    };
  }

  return {
    source: null,
    traceId: null,
    traceParent: null,
    traceState: null,
    isLegacy: null,
  };
}

function validateDispatchActor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "actor must be an object" };
  }
  if (!REQUIRED_STRING_FIELDS.nonEmpty(value.id)) {
    return { ok: false, reason: "actor.id is required" };
  }
  if (!REQUIRED_STRING_FIELDS.nonEmpty(value.role)) {
    return { ok: false, reason: "actor.role is required" };
  }
  if (!REQUIRED_STRING_FIELDS.nonEmpty(value.type)) {
    return { ok: false, reason: "actor.type is required" };
  }
  return { ok: true };
}

function validatePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "payload must be an object" };
  }
  return { ok: true };
}

function validateObjectUri(value) {
  if (!REQUIRED_STRING_FIELDS.nonEmpty(value)) {
    return { ok: false, reason: "object_uri is required" };
  }
  return { ok: true };
}

function validateRetentionClass(value) {
  if (!REQUIRED_STRING_FIELDS.nonEmpty(value)) {
    return { ok: false, reason: "retention_class is required" };
  }
  if (!RETENTION_CLASS_VALUES.includes(value)) {
    return { ok: false, reason: "retention_class must be a known value" };
  }
  return { ok: true };
}

function validatePolicyDecisionValue(value, path) {
  if (!DECISION_VALUES.includes(value)) {
    return { ok: false, reason: `${path} must be one of ${DECISION_VALUES.join(", ")}` };
  }
  return { ok: true };
}

function collectValidationErrors(validationFns) {
  const errors = [];
  for (const validate of validationFns) {
    const result = validate();
    if (!result.ok) {
      errors.push(result.reason);
    }
  }
  return errors;
}

export function validateDispatchCommand(payload) {
  const errors = collectValidationErrors([
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.tenantId)
        ? { ok: true }
        : { ok: false, reason: "tenantId is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.toolName)
        ? { ok: true }
        : { ok: false, reason: "toolName is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.requestId)
        ? { ok: true }
        : { ok: false, reason: "requestId is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.correlationId)
        ? { ok: true }
        : { ok: false, reason: "correlationId is required" },
    () => validateDispatchActor(payload?.actor),
    () => validatePayload(payload?.payload),
  ]);
  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0 ? payload : null,
  };
}

export function validatePolicyDecision(payload) {
  const errors = collectValidationErrors([
    () => validatePolicyDecisionValue(payload?.decision, "decision"),
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.reasonCode)
        ? { ok: true }
        : { ok: false, reason: "reasonCode is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.explanation)
        ? { ok: true }
        : { ok: false, reason: "explanation is required" },
  ]);

  if (
    payload?.effectivePolicy &&
    typeof payload.effectivePolicy === "object" &&
    !Array.isArray(payload.effectivePolicy)
  ) {
    if (!REQUIRED_STRING_FIELDS.nonEmpty(payload.effectivePolicy.bundleVersion)) {
      errors.push("effectivePolicy.bundleVersion is required");
    }
    if (!REQUIRED_STRING_FIELDS.nonEmpty(payload.effectivePolicy.bundleHash)) {
      errors.push("effectivePolicy.bundleHash is required");
    }
  } else {
    errors.push("effectivePolicy is required");
  }

  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0 ? payload : null,
  };
}

export function validateEvidenceRecord(payload) {
  const errors = collectValidationErrors([
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.ticketId)
        ? { ok: true }
        : { ok: false, reason: "ticketId is required" },
    () => validateObjectUri(payload?.objectUri),
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.sha256)
        ? { ok: true }
        : { ok: false, reason: "sha256 is required" },
    () => validateRetentionClass(payload?.retentionClass),
    () => {
      if (payload == null || payload === "") {
        return { ok: true };
      }
      if (!REQUIRED_STRING_FIELDS.stringOrNull(payload.redactionState)) {
        return { ok: false, reason: "redactionState must be a string" };
      }
      if (payload.redactionState != null && !REDACTION_STATES.includes(payload.redactionState)) {
        return {
          ok: false,
          reason: `redactionState must be one of ${REDACTION_STATES.join(", ")}`,
        };
      }
      return { ok: true };
    },
  ]);

  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0 ? payload : null,
  };
}

export function validateOutboxEvent(payload) {
  const errors = collectValidationErrors([
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.eventId)
        ? { ok: true }
        : { ok: false, reason: "eventId is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.tenantId)
        ? { ok: true }
        : { ok: false, reason: "tenantId is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.aggregateType)
        ? { ok: true }
        : { ok: false, reason: "aggregateType is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.aggregateId)
        ? { ok: true }
        : { ok: false, reason: "aggregateId is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.eventType)
        ? { ok: true }
        : { ok: false, reason: "eventType is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.version)
        ? { ok: true }
        : { ok: false, reason: "version is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.correlationId)
        ? { ok: true }
        : { ok: false, reason: "correlationId is required" },
    () => (payload?.occurredAt ? { ok: true } : { ok: false, reason: "occurredAt is required" }),
    () => {
      if (payload == null || payload === "") {
        return { ok: true };
      }
      if (typeof payload.payload !== "object" || Array.isArray(payload.payload)) {
        return { ok: false, reason: "payload must be an object" };
      }
      return { ok: true };
    },
  ]);

  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0 ? payload : null,
  };
}

export function validateCommsEnvelope(payload) {
  const errors = collectValidationErrors([
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.envelopeId)
        ? { ok: true }
        : { ok: false, reason: "envelopeId is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.tenantId)
        ? { ok: true }
        : { ok: false, reason: "tenantId is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.ticketId)
        ? { ok: true }
        : { ok: false, reason: "ticketId is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.direction)
        ? { ok: true }
        : { ok: false, reason: "direction is required" },
    () => {
      if (!COMMS_DIRECTIONS.includes(payload?.direction)) {
        return {
          ok: false,
          reason: `direction must be one of ${COMMS_DIRECTIONS.join(", ")}`,
        };
      }
      return { ok: true };
    },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.channel)
        ? { ok: true }
        : { ok: false, reason: "channel is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.peer)
        ? { ok: true }
        : { ok: false, reason: "peer is required" },
    () =>
      REQUIRED_STRING_FIELDS.nonEmpty(payload?.correlationId)
        ? { ok: true }
        : { ok: false, reason: "correlationId is required" },
  ]);

  if (payload?.body == null || typeof payload.body !== "object" || Array.isArray(payload.body)) {
    errors.push("body is required");
  }

  if (payload?.providerMetadata != null && typeof payload.providerMetadata !== "object") {
    errors.push("providerMetadata must be an object");
  }

  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0 ? payload : null,
  };
}

export function buildTraceContextHeaders(input = {}) {
  const traceParent = trimOrNull(input.traceParent) ?? trimOrNull(input.traceparent);
  const traceState = trimOrNull(input.traceState) ?? trimOrNull(input.tracestate);
  const traceId = trimOrNull(input.traceId) ?? trimOrNull(input.trace_id);

  const headers = {};
  let source = null;
  let emittedTraceId = null;
  let emittedTraceParent = null;

  if (traceParent) {
    const parsed = parseTraceParent(traceParent);
    if (!parsed) {
      throw new Error("INVALID_TRACEPARENT");
    }
    headers.traceparent = parsed.traceparent;
    if (traceState) {
      headers.tracestate = traceState;
    }
    emittedTraceId = parsed.traceId;
    emittedTraceParent = parsed.traceparent;
    source = "traceparent";
  } else if (traceId) {
    headers["x-trace-id"] = traceId;
    emittedTraceId = traceId;
  }

  return {
    headers,
    emittedTraceId,
    emittedTraceParent,
    emittedTraceState: source === "traceparent" ? traceState : null,
    source,
  };
}

export function serializeTraceContextForLog(traceContext) {
  if (!traceContext || typeof traceContext !== "object") {
    return {
      trace_id: null,
      trace_parent: null,
      trace_state: null,
      trace_source: null,
    };
  }

  return {
    trace_id: traceContext.traceId ?? null,
    trace_parent: traceContext.traceParent ?? null,
    trace_state: traceContext.traceState ?? null,
    trace_source: traceContext.source,
  };
}

export { COMMS_DIRECTIONS, DECISION_VALUES, REDACTION_STATES, RETENTION_CLASS_VALUES };
