const DEFAULT_DISPATCH_API_URL = "http://dispatch-api:8080";

function parseJsonSafe(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch {
    return {
      malformed_payload: true,
      raw: rawBody,
    };
  }
}

function normalizeApiUrl(rawApiUrl) {
  const normalized = typeof rawApiUrl === "string" ? rawApiUrl.trim() : "";
  if (normalized === "") {
    return DEFAULT_DISPATCH_API_URL;
  }
  return normalized.replace(/\/+$/u, "");
}

async function dispatchGet(path, options = {}) {
  const headers = {
    accept: "application/json",
    ...options.headers,
  };
  if (options.actorHeaders != null) {
    if (options.actorHeaders.actorId) {
      headers["x-actor-id"] = options.actorHeaders.actorId;
    }
    if (options.actorHeaders.actorRole) {
      headers["x-actor-role"] = options.actorHeaders.actorRole;
    }
    if (options.actorHeaders.actorType) {
      headers["x-actor-type"] = options.actorHeaders.actorType;
    }
  }
  if (options.correlationId) {
    headers["x-correlation-id"] = options.correlationId;
  }
  if (options.traceParent) {
    headers.traceparent = options.traceParent;
  }
  if (options.traceState) {
    headers.tracestate = options.traceState;
  } else if (options.traceId) {
    headers["x-trace-id"] = options.traceId;
  }

  const controller = new AbortController();
  const timeoutMs = Number.parseInt(
    process.env.DISPATCH_CONTROL_PLANE_ACTIVITY_TIMEOUT_MS ?? "8000",
    10,
  );
  const timeout = setTimeout(
    () => controller.abort("dispatch-activity-timeout"),
    Number.isNaN(timeoutMs) ? 8_000 : timeoutMs,
  );

  const apiBase = normalizeApiUrl(options.apiUrl);
  const url = `${apiBase}${path}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const payload = parseJsonSafe(bodyText);
    if (!response.ok) {
      const apiError = new Error(`dispatch-api ${path} -> ${response.status}`);
      apiError.name = "DispatchApiError";
      apiError.status = response.status;
      apiError.payload = payload;
      apiError.path = path;
      throw apiError;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readTicket(ticketId, context = {}) {
  if (!ticketId || typeof ticketId !== "string" || ticketId.trim() === "") {
    throw new Error("readTicket requires ticketId");
  }
  return dispatchGet(`/tickets/${ticketId}`, context);
}

export async function readTimeline(ticketId, context = {}) {
  if (!ticketId || typeof ticketId !== "string" || ticketId.trim() === "") {
    throw new Error("readTimeline requires ticketId");
  }
  return dispatchGet(`/tickets/${ticketId}/timeline`, context);
}
