function formatUnknownError(err) {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err === null) {
    return "null";
  }
  if (err === void 0) {
    return "undefined";
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    return err.description ?? err.toString();
  }
  if (typeof err === "function") {
    return err.name ? `[function ${err.name}]` : "[function]";
  }
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function extractStatusCode(err) {
  if (!isRecord(err)) {
    return null;
  }
  const direct = err.statusCode ?? err.status;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  if (typeof direct === "string") {
    const parsed = Number.parseInt(direct, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const response = err.response;
  if (isRecord(response)) {
    const status = response.status;
    if (typeof status === "number" && Number.isFinite(status)) {
      return status;
    }
    if (typeof status === "string") {
      const parsed = Number.parseInt(status, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}
function extractRetryAfterMs(err) {
  if (!isRecord(err)) {
    return null;
  }
  const direct = err.retryAfterMs ?? err.retry_after_ms;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
    return direct;
  }
  const retryAfter = err.retryAfter ?? err.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return retryAfter >= 0 ? retryAfter * 1e3 : null;
  }
  if (typeof retryAfter === "string") {
    const parsed = Number.parseFloat(retryAfter);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed * 1e3;
    }
  }
  const response = err.response;
  if (!isRecord(response)) {
    return null;
  }
  const headers = response.headers;
  if (!headers) {
    return null;
  }
  if (isRecord(headers)) {
    const raw = headers["retry-after"] ?? headers["Retry-After"];
    if (typeof raw === "string") {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed * 1e3;
      }
    }
  }
  if (typeof headers === "object" && headers !== null && "get" in headers && typeof headers.get === "function") {
    const raw = headers.get("retry-after");
    if (raw) {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed * 1e3;
      }
    }
  }
  return null;
}
function classifyMSTeamsSendError(err) {
  const statusCode = extractStatusCode(err);
  const retryAfterMs = extractRetryAfterMs(err);
  if (statusCode === 401 || statusCode === 403) {
    return { kind: "auth", statusCode };
  }
  if (statusCode === 429) {
    return {
      kind: "throttled",
      statusCode,
      retryAfterMs: retryAfterMs ?? void 0
    };
  }
  if (statusCode === 408 || statusCode != null && statusCode >= 500) {
    return {
      kind: "transient",
      statusCode,
      retryAfterMs: retryAfterMs ?? void 0
    };
  }
  if (statusCode != null && statusCode >= 400) {
    return { kind: "permanent", statusCode };
  }
  return {
    kind: "unknown",
    statusCode: statusCode ?? void 0,
    retryAfterMs: retryAfterMs ?? void 0
  };
}
function isRevokedProxyError(err) {
  if (!(err instanceof TypeError)) {
    return false;
  }
  return /proxy that has been revoked/i.test(err.message);
}
function formatMSTeamsSendErrorHint(classification) {
  if (classification.kind === "auth") {
    return "check msteams appId/appPassword/tenantId (or env vars MSTEAMS_APP_ID/MSTEAMS_APP_PASSWORD/MSTEAMS_TENANT_ID)";
  }
  if (classification.kind === "throttled") {
    return "Teams throttled the bot; backing off may help";
  }
  if (classification.kind === "transient") {
    return "transient Teams/Bot Framework error; retry may succeed";
  }
  return void 0;
}
export {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
  isRevokedProxyError
};
