// Token Tracker — unified token usage tracking
// Phase 5.2: Shared module for tracking token usage across executors

const fs = require("fs");
const path = require("path");

const TOKEN_LOG_PATH = path.join(
  process.env.HOME || "/root",
  ".claude",
  "metrics",
  "token-usage.jsonl",
);

// Buffer for batched writes
let _buffer = [];
let _flushTimer = null;

/**
 * Track token usage for an executor
 * @param {string} model - Model name
 * @param {string} executor - Executor type ("ollama" | "claude" | "local")
 * @param {{ input_tokens: number, output_tokens: number }} usage
 * @param {number} latencyMs
 */
function trackTokenUsage(model, executor, usage, latencyMs) {
  const entry = {
    ts: new Date().toISOString(),
    model,
    executor,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    latency_ms: latencyMs,
  };

  _buffer.push(JSON.stringify(entry));

  // Debounced flush
  if (!_flushTimer) {
    _flushTimer = setTimeout(() => {
      _flush();
      _flushTimer = null;
    }, 2000);
  }
}

function _flush() {
  if (_buffer.length === 0) {
    return;
  }
  const batch = _buffer.splice(0);
  const dir = path.dirname(TOKEN_LOG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFile(TOKEN_LOG_PATH, batch.join("\n") + "\n", (err) => {
    if (err) {
      console.error("[token-tracker] flush error:", err.message);
    }
  });
}

/**
 * Get summary of token usage from buffer
 * @returns {{ buffered: number }}
 */
function getStats() {
  return { buffered: _buffer.length };
}

module.exports = { trackTokenUsage, getStats };
