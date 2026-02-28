// OpenClaw Ollama Router — Ollama-first routing with model selection
// Default: qwen2.5-coder:7b (fast), @glm: glm-4.7-flash (powerful)

const http = require("http");
const { execSync } = require("child_process");

const OLLAMA_HOST = "localhost";
const OLLAMA_PORT = 11434;
const OLLAMA_MODEL = "qwen2.5-coder:7b";
const OLLAMA_MODEL_GLM = "glm-4.7-flash";
const OLLAMA_TIMEOUT = 30000; // 30 seconds (7B model is fast, no need for 60s)

// ─── P1: Ollama Watchdog 強化 ────────────────────────────────────
const MAX_CONSECUTIVE_FAILURES = 3;
// ──────────────────────────────────────────────────────────────────

// ─── Stats ───────────────────────────────────────────────────────

const ollamaStats = {
  total: 0,
  success: 0,
  timeout: 0,
  error: 0,
  fallback: 0,
  qualityReject: 0,
  totalLatency: 0,
  consecutiveFailures: 0, // P1: 連續失敗計數
};

// ─── Force Model Detection ───────────────────────────────────────

function detectForceModel(userText) {
  if (!userText) {
    return null;
  }
  const lower = userText.toLowerCase();
  if (lower.includes("@opus")) {
    return "opus";
  }
  if (lower.includes("@claude") || lower.includes("@haiku")) {
    return "claude";
  }
  if (lower.includes("@glm")) {
    return "glm";
  } // GLM-4.7-Flash specifically
  if (lower.includes("@ollama")) {
    return "ollama";
  } // default Ollama model
  return null;
}

function stripForceDirective(userText) {
  return userText.replace(/@(?:claude|haiku|opus|ollama|glm)\b/gi, "").trim();
}

// ─── Quality Assessment ──────────────────────────────────────────

function assessQuality(response, userText) {
  if (!response || response.length < 5) {
    return 0;
  }

  let score = 0.8; // base score

  // Too short for a meaningful response
  if (response.length < 20) {
    score -= 0.3;
  }

  // Has structure (code blocks, lists)
  if (response.includes("```")) {
    score += 0.1;
  }
  if (response.includes("\n- ") || response.includes("\n1.")) {
    score += 0.05;
  }

  // Repetitive content detection
  const words = response.split(/\s+/);
  if (words.length > 20) {
    const uniqueRatio = new Set(words).size / words.length;
    if (uniqueRatio < 0.3) {
      score -= 0.4;
    } // very repetitive
  }

  // Truncated or incomplete
  if (response.endsWith("...") && response.length < 100) {
    score -= 0.2;
  }

  // Language mismatch: user wrote Chinese but response is mostly non-Chinese
  const hasChinese = (t) => /[一-鿿]/.test(t);
  if (userText && hasChinese(userText)) {
    const chineseChars = (response.match(/[一-鿿]/g) || []).length;
    const totalChars = response.replace(/\s/g, "").length;
    if (totalChars > 20 && chineseChars / totalChars < 0.1) {
      score -= 0.3; // response should contain Chinese if user asked in Chinese
    }
  }

  // Refuse/deflect detection (model says it cant help)
  const deflect = /i cannot|i can't|as an ai|i'm unable|i don't have/i;
  if (deflect.test(response) && response.length < 200) {
    score -= 0.2;
  }

  return Math.max(0, Math.min(1, score));
}

// ─── P1: Ollama Watchdog ─────────────────────────────────────────
function restartOllama() {
  try {
    console.warn("[Ollama Watchdog] 失敗 3 次，嘗試重啟 Ollama...");
    execSync("launchctl kickstart -k system/homebrew.mxcl.ollama", { timeout: 5000 });
    console.warn("[Ollama Watchdog] Ollama 已重啟");
    return true;
  } catch (e) {
    console.error("[Ollama Watchdog] 重啟失敗:", e.message);
    return false;
  }
}

// Centralized failure tracking — replaces 6 copy-pasted blocks
function trackFailure(reason) {
  ollamaStats.error++;
  ollamaStats.consecutiveFailures++;
  console.error(
    `[Ollama] ${reason}, failures: ${ollamaStats.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`,
  );
  if (ollamaStats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    restartOllama();
    ollamaStats.consecutiveFailures = 0;
  }
}
// ──────────────────────────────────────────────────────────────────

// ─── Ollama Chat ─────────────────────────────────────────────────

function tryOllamaChat(messages, options) {
  const model = (options && options.model) || OLLAMA_MODEL;
  const timeout = (options && options.timeout) || OLLAMA_TIMEOUT;

  return new Promise((resolve) => {
    const startTime = Date.now();
    ollamaStats.total++;

    const body = JSON.stringify({
      model: model,
      messages: messages,
      keep_alive: "1h",
      stream: false,
    });

    const opts = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: timeout,
    };

    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const latency = Date.now() - startTime;
        ollamaStats.totalLatency += latency;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content || "";

          if (!content) {
            trackFailure("empty_response");
            resolve({ success: false, reason: "empty_response", latency });
            return;
          }

          // P1: 成功時重置計數
          ollamaStats.consecutiveFailures = 0;
          ollamaStats.success++;
          resolve({
            success: true,
            content: content,
            model: model,
            latency: latency,
            usage: parsed.usage || {},
          });
        } catch (e) {
          trackFailure(`parse_error: ${e.message}`);
          resolve({ success: false, reason: "parse_error", error: e.message, latency });
        }
      });
    });

    req.on("error", (e) => {
      const latency = Date.now() - startTime;
      trackFailure(`connection_error: ${e.message}`);
      resolve({ success: false, reason: "connection_error", error: e.message, latency });
    });

    req.on("timeout", () => {
      req.destroy();
      const latency = Date.now() - startTime;
      ollamaStats.timeout++;
      trackFailure(`timeout (${latency}ms)`);
      resolve({ success: false, reason: "timeout", latency });
    });

    req.write(body);
    req.end();
  });
}

// ─── Streaming Chat (Phase 4.3) ─────────────────────────────────

/**
 * Stream Ollama response with TTFT/TPS metrics.
 * Returns { success, stream, metrics } where stream is a ReadableStream-like.
 * Caller must pipe stream to response.
 *
 * @param {Array} messages - Chat messages
 * @param {Object} options - { model, timeout }
 * @param {Function} onChunk - (text, isFirst) => void
 * @param {Function} onDone - ({ content, metrics }) => void
 * @param {Function} onError - (error) => void
 */
function tryOllamaChatStream(messages, options, onChunk, onDone, onError) {
  const model = (options && options.model) || OLLAMA_MODEL;
  const timeout = (options && options.timeout) || OLLAMA_TIMEOUT;

  const startTime = Date.now();
  ollamaStats.total++;

  const body = JSON.stringify({
    model: model,
    messages: messages,
    keep_alive: "1h",
    stream: true,
  });

  const opts = {
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: timeout,
  };

  let firstTokenTime = null;
  let tokenCount = 0;
  let fullContent = "";
  let buffer = "";

  const req = http.request(opts, (res) => {
    if (res.statusCode !== 200) {
      trackFailure(`HTTP ${res.statusCode}`);
      onError(new Error(`Ollama HTTP ${res.statusCode}`));
      return;
    }

    res.on("data", (chunk) => {
      buffer += chunk.toString();
      // Parse SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            if (!firstTokenTime) {
              firstTokenTime = Date.now();
            }
            tokenCount++;
            fullContent += delta;
            onChunk(delta, tokenCount === 1);
          }
        } catch {
          // skip malformed chunks
        }
      }
    });

    res.on("end", () => {
      const totalMs = Date.now() - startTime;
      const ttft = firstTokenTime ? firstTokenTime - startTime : totalMs;
      const streamMs = firstTokenTime ? Date.now() - firstTokenTime : 0;
      const tps = streamMs > 0 ? Math.round((tokenCount / streamMs) * 1000) : 0;

      ollamaStats.totalLatency += totalMs;

      if (!fullContent) {
        trackFailure("empty_stream_response");
        onError(new Error("empty_stream_response"));
        return;
      }

      ollamaStats.consecutiveFailures = 0;
      ollamaStats.success++;

      onDone({
        content: fullContent,
        model,
        latency: totalMs,
        metrics: {
          ttft_ms: ttft,
          tps,
          total_stream_ms: streamMs,
          token_count: tokenCount,
        },
      });
    });
  });

  req.on("error", (e) => {
    trackFailure(`stream_error: ${e.message}`);
    onError(e);
  });

  req.on("timeout", () => {
    req.destroy();
    ollamaStats.timeout++;
    trackFailure("stream_timeout");
    onError(new Error("stream_timeout"));
  });

  req.write(body);
  req.end();

  return req; // return for abort capability
}

// ─── Model Selection Helper ──────────────────────────────────────

function getModelForForce(forceModel) {
  if (forceModel === "glm") {
    return { model: OLLAMA_MODEL_GLM, timeout: 60000 };
  }
  return { model: OLLAMA_MODEL, timeout: OLLAMA_TIMEOUT };
}

// ─── Stats API ───────────────────────────────────────────────────

function getStats() {
  return {
    ...ollamaStats,
    defaultModel: OLLAMA_MODEL,
    glmModel: OLLAMA_MODEL_GLM,
    avgLatency:
      ollamaStats.total > 0 ? Math.round(ollamaStats.totalLatency / ollamaStats.total) : 0,
    successRate:
      ollamaStats.total > 0
        ? ((ollamaStats.success / ollamaStats.total) * 100).toFixed(1) + "%"
        : "N/A",
  };
}

module.exports = {
  tryOllamaChat,
  tryOllamaChatStream,
  assessQuality,
  detectForceModel,
  stripForceDirective,
  getModelForForce,
  getStats,
  ollamaStats,
  OLLAMA_MODEL,
  OLLAMA_MODEL_GLM,
  OLLAMA_TIMEOUT,
};
