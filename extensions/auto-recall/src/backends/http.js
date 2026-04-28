import { configHash } from "../cache.js";

function normalizeAllowedHosts(value) {
  return Array.isArray(value)
    ? value.map((host) => String(host).trim().toLowerCase()).filter(Boolean)
    : [];
}

function object(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function int(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function timeoutSignal(parent, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const abort = (event) => {
    const signal = event?.target || parent;
    controller.abort(signal?.reason || new Error("aborted"));
  };
  if (parent) {
    if (parent.aborted) {
      abort();
    } else {
      parent.addEventListener("abort", abort, { once: true });
    }
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs).unref?.();
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) {
        clearTimeout(timer);
      }
      parent?.removeEventListener?.("abort", abort);
    },
  };
}

async function readBounded(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error("response_too_large");
    }
    return text;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function getPath(obj, path) {
  if (!path) {
    return undefined;
  }
  return String(path)
    .split(".")
    .reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

function normalizeSource(source) {
  if (typeof source === "string") {
    return { title: source };
  }
  if (!source || typeof source !== "object") {
    return undefined;
  }
  return {
    id: source.id != null ? String(source.id) : undefined,
    title: source.title != null ? String(source.title) : undefined,
    uri: source.uri || source.url || source.path,
    excerpt: source.excerpt != null ? String(source.excerpt) : undefined,
    score: Number.isFinite(Number(source.score)) ? Number(source.score) : undefined,
  };
}

/**
 * Map backend JSON response fields into the normalized recall result shape.
 * @param {object} json Backend JSON response.
 * @param {object} [mapping={}] Dot-path response mapping options.
 * @returns {object} Normalized recall result.
 */
export function mapJsonToResult(json, mapping = {}) {
  const answer = getPath(json, mapping.answerPath || "answer");
  const confidence = getPath(json, mapping.confidencePath || "confidence");
  const rawStatus = getPath(json, mapping.statusPath || "status");
  const degraded = Boolean(getPath(json, mapping.degradedPath || "degraded"));
  const sourceValue = getPath(json, mapping.sourcesPath || "sources");
  const status = rawStatus || (degraded ? "degraded" : answer ? "ok" : "not_found");
  return {
    status: ["ok", "not_found", "degraded", "error"].includes(status) ? status : "error",
    answer: answer == null ? undefined : String(answer),
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : answer ? 1 : 0,
    sources: Array.isArray(sourceValue) ? sourceValue.map(normalizeSource).filter(Boolean) : [],
    diagnostics:
      json?.diagnostics && typeof json.diagnostics === "object" ? json.diagnostics : undefined,
    cache: json?.cache && typeof json.cache === "object" ? json.cache : undefined,
  };
}

function buildBody(mode, request, template = {}) {
  if (mode === "text") {
    return request.text;
  }
  if (mode === "query") {
    return JSON.stringify({ query: request.text });
  }
  if (mode === "normalizedQuery") {
    return JSON.stringify({ query: request.normalizedText });
  }
  return JSON.stringify({
    ...template.static,
    query: request.text,
    normalizedQuery: request.normalizedText,
    maxResults: request.maxResults,
    minConfidence: request.minConfidence,
    trigger: request.trigger,
    locale: request.locale,
    session: request.session,
  });
}

function defaultContentType(mode) {
  return mode === "text" ? "text/plain; charset=utf-8" : "application/json";
}

/**
 * Recall backend that calls a configured HTTP endpoint.
 */
export class HttpBackend {
  constructor(config = {}) {
    if (!config.url) {
      throw new Error("http backend requires url");
    }
    this.name = config.name || "http";
    this.kind = "http";
    this.config = {
      method: config.method || "POST",
      url: config.url,
      headers: object(config.headers),
      timeoutMs:
        config.timeoutMs == null ? undefined : int(config.timeoutMs, undefined, 100, 60_000),
      maxResponseBytes: int(config.maxResponseBytes, 256_000, 1024, 10_000_000),
      requestMode: config.requestMode || "default",
      bodyTemplate: object(config.bodyTemplate),
      responseMapping: object(config.responseMapping),
      allowedHosts: normalizeAllowedHosts(config.allowedHosts),
    };
    this.configHash = configHash(this.config);
  }

  hostAllowed() {
    if (!this.config.allowedHosts.length) {
      return true;
    }
    try {
      return this.config.allowedHosts.includes(new URL(this.config.url).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  async query(request) {
    const started = Date.now();
    const timeoutMs = this.config.timeoutMs || request.timeoutMs;
    const { signal, cleanup } = timeoutSignal(request.signal, timeoutMs);
    try {
      if (!this.hostAllowed()) {
        return {
          status: "error",
          confidence: 0,
          diagnostics: { reason: "url_not_allowed", latencyMs: Date.now() - started },
          cache: { cacheable: false },
        };
      }
      const headers = {
        accept: "application/json",
        "content-type": defaultContentType(this.config.requestMode),
        ...this.config.headers,
      };
      const init = {
        method: this.config.method,
        headers,
        signal,
        redirect: this.config.allowedHosts.length ? "manual" : "follow",
      };
      if (!/^(GET|HEAD)$/i.test(this.config.method)) {
        init.body = buildBody(this.config.requestMode, request, this.config.bodyTemplate);
      }
      const response = await fetch(this.config.url, init);
      if (
        this.config.allowedHosts.length &&
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        return {
          status: "error",
          confidence: 0,
          diagnostics: {
            reason: "redirect_blocked",
            httpStatus: response.status,
            latencyMs: Date.now() - started,
          },
          cache: { cacheable: false },
        };
      }
      const text = await readBounded(response, this.config.maxResponseBytes);
      if (!response.ok) {
        return {
          status: response.status === 404 ? "not_found" : "error",
          confidence: 0,
          diagnostics: {
            httpStatus: response.status,
            body: text.slice(0, 1000),
            latencyMs: Date.now() - started,
          },
          cache: { cacheable: response.status === 404 },
        };
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch (error) {
        return {
          status: "error",
          confidence: 0,
          diagnostics: {
            reason: "malformed_json",
            body: text.slice(0, 1000),
            error: error.message,
            latencyMs: Date.now() - started,
          },
          cache: { cacheable: false },
        };
      }
      const result = mapJsonToResult(json, this.config.responseMapping);
      return {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          httpStatus: response.status,
          latencyMs: Date.now() - started,
        },
      };
    } catch (error) {
      const reason = signal.aborted
        ? signal.reason?.message || "aborted"
        : error?.message || String(error);
      return {
        status: "error",
        confidence: 0,
        diagnostics: { reason, latencyMs: Date.now() - started },
        cache: { cacheable: false },
      };
    } finally {
      cleanup();
    }
  }

  async healthCheck(signal) {
    const started = Date.now();
    try {
      if (!this.hostAllowed()) {
        return { ok: false, reason: "url_not_allowed", latencyMs: Date.now() - started };
      }
      const response = await fetch(this.config.url, {
        method: "HEAD",
        signal,
        redirect: this.config.allowedHosts.length ? "manual" : "follow",
      });
      if (
        this.config.allowedHosts.length &&
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        return { ok: false, reason: "redirect_blocked", latencyMs: Date.now() - started };
      }
      return {
        ok: response.ok,
        reason: response.ok ? undefined : `http_${response.status}`,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        reason: error?.message || String(error),
        latencyMs: Date.now() - started,
      };
    }
  }
}
