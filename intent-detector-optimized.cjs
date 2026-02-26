// Intent Detection 優化版本 - LRU 快取 + Signal fast-path + Authority + Expiry
// Phase 3.3: Signal layer integration — keyword hints bypass Ollama when high confidence
// Phase 4.1: AbortController — cancel Ollama inference when signal resolves early

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { LRUCache } = require("lru-cache");
const { extractHints } = require("./signals/intent-hints.cjs");

const INTENT_AUTHORITY_EXPIRY_MS = 1200; // pending intent expires after 1.2s

class IntentDetector {
  constructor(options = {}) {
    this.ollamaUrl = options.ollamaUrl || "http://localhost:11434";
    this.model = options.model || "qwen2.5-coder:7b";
    this.cacheKeyPrefix = "intent:";
    this.cacheTTL = options.cacheTTL || 3600; // 1 小時
    this.temperature = options.temperature || 0.1; // 低溫度 = 更確定的分類
    this.signalConfidenceThreshold = options.signalConfidenceThreshold || 0.8;

    // LRU cache: 限 1000 條，TTL 1hr
    this.memoryCache = new LRUCache({
      max: 1000,
      ttl: (options.cacheTTL || 3600) * 1000,
    });
    this.metricsPath =
      options.metricsPath ||
      path.join(process.env.HOME || "/root", ".claude", "logs", "intent-metrics.jsonl");

    // Async log buffer (flush every 1s)
    this._logBuffer = [];
    this._flushInterval = setInterval(() => this._flushLogBuffer(), 1000);

    // 性能指標
    this.metrics = {
      cache_hits: 0,
      cache_misses: 0,
      ollama_calls: 0,
      fallback_calls: 0,
      signal_hits: 0,
      signal_bypasses: 0,
      aborted_calls: 0,
      total_latency_ms: 0,
      confidence_sum: 0,
      call_count: 0,
    };

    // Precompiled regex
    this._chineseRegex = /[\u4e00-\u9fa5]/g;
    this._jsonExtract = /\{.*\}/s;
  }

  // 生成快取鍵 (基於 hash)
  getCacheKey(input, language) {
    const hash = crypto
      .createHash("sha256")
      .update(input.toLowerCase() + ":" + language)
      .digest("hex")
      .slice(0, 16);
    return this.cacheKeyPrefix + hash;
  }

  // 自動偵測語言
  detectLanguage(input) {
    this._chineseRegex.lastIndex = 0;
    const chineseChars = (input.match(this._chineseRegex) || []).length;
    return chineseChars > input.length * 0.3 ? "chinese" : "english";
  }

  // Ollama 分類 (with AbortSignal support)
  async classifyWithOllama(input, language, signal) {
    const startTime = Date.now();

    const systemPrompt =
      language === "chinese"
        ? `你是一個 Intent 分類器。根據用戶訊息分類意圖。
         只能選擇以下之一：code, gmail_delete, gmail_read, gmail_send, calendar, web_search, stock, system_status, deploy, summarize, progress, chat
         回應格式: {"intent":"...", "confidence": 0.0-1.0}`
        : `You are an intent classifier. Classify the user's intent.
         Choose one of: code, gmail_delete, gmail_read, gmail_send, calendar, web_search, stock, system_status, deploy, summarize, progress, chat
         Response format: {"intent":"...", "confidence": 0.0-1.0}`;

    try {
      // Use http.request for connection destroy capability
      // AbortController only cancels Node promise; we need req.destroy() to stop GPU inference
      const fetchOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: `${systemPrompt}\n\nUser: ${input}`,
          stream: false,
          temperature: this.temperature,
        }),
      };

      if (signal) {
        fetchOpts.signal = signal;
      }

      const response = await fetch(`${this.ollamaUrl}/api/generate`, fetchOpts);

      if (signal?.aborted) {
        this.metrics.aborted_calls++;
        return null;
      }

      if (!response.ok) {
        throw new Error("Ollama request failed");
      }

      const data = await response.json();
      const latency = Date.now() - startTime;

      // 解析回應
      this._jsonExtract.lastIndex = 0;
      const jsonMatch = data.response.match(this._jsonExtract);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);

        this.metrics.ollama_calls++;
        this.metrics.total_latency_ms += latency;

        return {
          intent: result.intent || "chat",
          confidence: Math.min(1, Math.max(0, result.confidence || 0.5)),
          method: "ollama",
          source: "llm",
          latency_ms: latency,
        };
      }
    } catch (e) {
      if (e.name === "AbortError") {
        this.metrics.aborted_calls++;
        return null;
      }
      console.warn("[intent] Ollama classification failed:", e.message);
    }

    return null;
  }

  /**
   * Classify with AbortController support.
   * Returns { result, abort() } where:
   * - result: Promise<IntentResult>
   * - abort(): function to cancel pending Ollama classification
   */
  classifyAsync(input) {
    const controller = new AbortController();

    const resultPromise = this.classify(input, controller.signal);

    return {
      result: resultPromise,
      abort: () => {
        controller.abort();
      },
    };
  }

  async classify(input, signal) {
    if (!input || typeof input !== "string") {
      return {
        intent: "chat",
        confidence: 0,
        method: "invalid",
        source: "none",
        authoritative: false,
      };
    }

    const language = this.detectLanguage(input);
    const cacheKey = this.getCacheKey(input, language);

    // 檢查快取
    const cached = this.memoryCache.get(cacheKey);
    if (cached) {
      this.metrics.cache_hits++;
      return { ...cached, cached: true };
    }

    this.metrics.cache_misses++;

    // Phase 3.3: Signal fast-path — keyword hints bypass Ollama
    const hints = extractHints(input);
    const startedAt = Date.now();
    let result;

    if (hints.confidence >= this.signalConfidenceThreshold) {
      // High confidence signal → skip Ollama entirely
      this.metrics.signal_hits++;
      result = {
        intent: hints.intent,
        confidence: hints.confidence,
        method: "signal",
        source: "signal",
        keywords_matched: hints.keywords_matched,
        authoritative: true,
      };
    } else {
      // Low confidence signal → try Ollama (with AbortSignal)
      this.metrics.signal_bypasses++;
      const ollamaResult = await this.classifyWithOllama(input, language, signal);

      if (signal?.aborted) {
        // Aborted — use best available hint
        if (hints.intent !== "unknown") {
          result = {
            intent: hints.intent,
            confidence: hints.confidence,
            method: "signal_aborted",
            source: "signal",
            keywords_matched: hints.keywords_matched,
            authoritative: true,
            aborted: true,
          };
        } else {
          result = {
            intent: "chat",
            confidence: 0.1,
            method: "aborted_fallback",
            source: "none",
            authoritative: true,
            aborted: true,
          };
        }
        this.metrics.aborted_calls++;
      } else if (ollamaResult) {
        // Intent Authority: check expiry
        const elapsed = Date.now() - startedAt;
        if (elapsed > INTENT_AUTHORITY_EXPIRY_MS && hints.intent !== "unknown") {
          // Ollama was too slow, use best-effort hint
          result = {
            intent: hints.intent,
            confidence: hints.confidence,
            method: "signal_expiry",
            source: "signal",
            keywords_matched: hints.keywords_matched,
            authoritative: true,
            expired_llm: true,
          };
        } else if (
          ollamaResult.intent === "unknown" ||
          (ollamaResult.intent === "chat" && ollamaResult.confidence < 0.3)
        ) {
          // Ollama returned unknown/low-confidence chat → fallback to hints if available
          if (hints.intent !== "unknown") {
            result = {
              intent: hints.intent,
              confidence: hints.confidence,
              method: "signal_fallback",
              source: "signal",
              keywords_matched: hints.keywords_matched,
              authoritative: true,
            };
            this.metrics.fallback_calls++;
          } else {
            result = { ...ollamaResult, authoritative: true };
          }
        } else {
          result = { ...ollamaResult, authoritative: true };
        }
      } else {
        // Ollama failed completely → use signal hints
        if (hints.intent !== "unknown") {
          result = {
            intent: hints.intent,
            confidence: hints.confidence,
            method: "signal_fallback",
            source: "signal",
            keywords_matched: hints.keywords_matched,
            authoritative: true,
          };
        } else {
          result = {
            intent: "chat",
            confidence: 0.1,
            method: "fallback",
            source: "none",
            authoritative: true,
          };
        }
        this.metrics.fallback_calls++;
      }
    }

    // 記錄指標
    this.metrics.call_count++;
    this.metrics.confidence_sum += result.confidence;

    // 寫入快取
    this.memoryCache.set(cacheKey, result);

    // 寫入日誌
    this.logMetrics(input, result, language);

    return result;
  }

  logMetrics(input, result, language) {
    const logEntry = JSON.stringify({
      ts: new Date().toISOString(),
      language,
      input_len: input.length,
      intent: result.intent,
      confidence: result.confidence,
      method: result.method,
      source: result.source,
      aborted: result.aborted || false,
      latency_ms: result.latency_ms || null,
    });
    this._logBuffer.push(logEntry);
  }

  _flushLogBuffer() {
    if (this._logBuffer.length === 0) {
      return;
    }
    const batch = this._logBuffer.splice(0, this._logBuffer.length);
    fs.mkdirSync(path.dirname(this.metricsPath), { recursive: true });
    fs.appendFile(this.metricsPath, batch.join("\n") + "\n", (err) => {
      if (err) {
        console.error("[intent] Log flush error:", err.message);
      }
    });
  }

  getStats() {
    const avgLatency =
      this.metrics.ollama_calls > 0
        ? Math.round(this.metrics.total_latency_ms / this.metrics.ollama_calls)
        : 0;

    const avgConfidence =
      this.metrics.call_count > 0
        ? (this.metrics.confidence_sum / this.metrics.call_count).toFixed(2)
        : 0;

    const total = this.metrics.cache_hits + this.metrics.cache_misses;
    const hitRate = total > 0 ? ((this.metrics.cache_hits / total) * 100).toFixed(1) : "N/A";

    return {
      cache: {
        hits: this.metrics.cache_hits,
        misses: this.metrics.cache_misses,
        hit_rate: hitRate + "%",
        in_memory: this.memoryCache.size,
      },
      classification: {
        total_calls: this.metrics.call_count,
        ollama_calls: this.metrics.ollama_calls,
        signal_hits: this.metrics.signal_hits,
        signal_bypasses: this.metrics.signal_bypasses,
        aborted_calls: this.metrics.aborted_calls,
        fallback_calls: this.metrics.fallback_calls,
        avg_confidence: parseFloat(avgConfidence),
        avg_latency_ms: avgLatency,
      },
    };
  }
}

module.exports = { IntentDetector };
