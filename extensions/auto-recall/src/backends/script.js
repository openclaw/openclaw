import { spawn } from "node:child_process";
import { configHash } from "../cache.js";

function toSources(value) {
  if (!value) return [];
  if (Array.isArray(value))
    return value.map((item) => (typeof item === "string" ? { title: item } : item)).filter(Boolean);
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
    .map((title) => ({ title }));
}

function object(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function int(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

/**
 * Parse stdout from a script backend into the normalized recall result shape.
 * @param {unknown} stdout Script stdout.
 * @param {"json"|"text"} [protocol="json"] Output protocol.
 * @returns {object} Normalized recall result.
 */
export function parseScriptOutput(stdout, protocol = "json") {
  const text = String(stdout || "").trim();
  if (!text) return { status: "not_found", confidence: 0 };
  if (protocol === "json") {
    try {
      const obj = JSON.parse(text);
      return {
        status: obj.status || (obj.degraded ? "degraded" : obj.answer ? "ok" : "not_found"),
        answer: obj.answer == null ? undefined : String(obj.answer),
        confidence: Number.isFinite(Number(obj.confidence))
          ? Number(obj.confidence)
          : obj.answer
            ? 1
            : 0,
        sources: toSources(obj.sources),
        diagnostics: obj.diagnostics,
        cache: obj.cache,
      };
    } catch (error) {
      return {
        status: "error",
        confidence: 0,
        diagnostics: {
          reason: "malformed_json",
          error: error.message,
          stdout: text.slice(0, 1000),
        },
        cache: { cacheable: false },
      };
    }
  }

  const answerMatch = text.match(/^ANSWER:\s*([\s\S]*?)(?=^CONFIDENCE:|^SOURCES:|$)/im);
  const confidenceMatch = text.match(/^CONFIDENCE:\s*([0-9]*\.?[0-9]+)/im);
  const sourcesMatch = text.match(/^SOURCES:\s*([\s\S]*)$/im);
  const answer = answerMatch?.[1]?.trim();
  const confidence = confidenceMatch ? Number(confidenceMatch[1]) : NaN;
  if (!answer || !Number.isFinite(confidence)) {
    return {
      status: "error",
      confidence: 0,
      diagnostics: { reason: "malformed_text_protocol", stdout: text.slice(0, 1000) },
      cache: { cacheable: false },
    };
  }
  return { status: "ok", answer, confidence, sources: toSources(sourcesMatch?.[1]) };
}

function appendLimited(target, chunk, maxBytes) {
  const next = Buffer.concat([target, Buffer.from(chunk)]);
  return next.length > maxBytes ? next.subarray(0, maxBytes) : next;
}

/**
 * Recall backend that executes a configured command without a shell.
 */
export class ScriptBackend {
  constructor(config = {}) {
    if (!config.command) throw new Error("script backend requires command");
    if (config.args && !Array.isArray(config.args))
      throw new Error("script backend args must be an array");
    this.name = config.name || "script";
    this.kind = "script";
    this.config = {
      command: config.command,
      args: config.args || [],
      queryMode: config.queryMode || "stdin",
      queryArg: config.queryArg || "{query}",
      timeoutMs:
        config.timeoutMs == null ? undefined : int(config.timeoutMs, undefined, 100, 60_000),
      maxStdoutBytes: int(config.maxStdoutBytes, 256_000, 1024, 10_000_000),
      maxStderrBytes: int(config.maxStderrBytes, 32_000, 1024, 1_000_000),
      protocol: config.protocol || "json",
      cwd: config.cwd,
      env: object(config.env),
    };
    this.configHash = configHash(this.config);
  }

  async query(request) {
    const started = Date.now();
    const timeoutMs = this.config.timeoutMs || request.timeoutMs;
    const args = this.config.args.map((arg) =>
      String(arg)
        .replaceAll("{query}", request.text)
        .replaceAll("{normalizedQuery}", request.normalizedText),
    );
    if (this.config.queryMode === "arg")
      args.push(
        String(this.config.queryArg)
          .replaceAll("{query}", request.text)
          .replaceAll("{normalizedQuery}", request.normalizedText),
      );

    if (request.signal?.aborted) {
      return {
        status: "error",
        confidence: 0,
        diagnostics: { reason: "aborted", latencyMs: Date.now() - started },
        cache: { cacheable: false },
      };
    }

    return await new Promise((resolve) => {
      let done = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const child = spawn(this.config.command, args, {
        shell: false,
        detached: true,
        cwd: this.config.cwd,
        env: { ...process.env, ...this.config.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        request.signal?.removeEventListener?.("abort", onAbort);
        resolve({
          ...result,
          diagnostics: {
            ...(result.diagnostics || {}),
            stderr: stderr.toString("utf8").slice(0, this.config.maxStderrBytes),
            latencyMs: Date.now() - started,
          },
        });
      };

      const killGroup = () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      };
      const onAbort = () => {
        killGroup();
        finish({
          status: "error",
          confidence: 0,
          diagnostics: { reason: "aborted" },
          cache: { cacheable: false },
        });
      };
      const timer = setTimeout(() => {
        killGroup();
        finish({
          status: "error",
          confidence: 0,
          diagnostics: { reason: "timeout" },
          cache: { cacheable: false },
        });
      }, timeoutMs).unref?.();
      request.signal?.addEventListener?.("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk) => {
        stdout = appendLimited(stdout, chunk, this.config.maxStdoutBytes);
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendLimited(stderr, chunk, this.config.maxStderrBytes);
      });
      child.on("error", (error) =>
        finish({
          status: "error",
          confidence: 0,
          diagnostics: { reason: error.message },
          cache: { cacheable: false },
        }),
      );
      child.on("close", (code, signal) => {
        if (done) return;
        if (code !== 0)
          return finish({
            status: "error",
            confidence: 0,
            diagnostics: { reason: "exit", code, signal },
            cache: { cacheable: false },
          });
        const parsed = parseScriptOutput(stdout.toString("utf8"), this.config.protocol);
        finish(parsed);
      });
      if (request.signal?.aborted) {
        onAbort();
        return;
      }
      if (this.config.queryMode === "stdin") child.stdin.end(request.text);
      else child.stdin.end();
    });
  }
}
