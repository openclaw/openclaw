// Response Formatter — unified response formatting + footer
// Phase 5.2: Shared module extracted from tool-wrapper-proxy.cjs

/**
 * Format Ollama response with model footer
 * @param {string} content - Response content
 * @param {string} modelName - Model name
 * @param {number} latencyMs - Latency in milliseconds
 * @returns {string}
 */
function formatOllamaResponse(content, modelName, latencyMs) {
  const latencySec = (latencyMs / 1000).toFixed(1);
  const footer = `\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nOllama ${modelName} (${latencySec}s)`;
  return content + footer;
}

/**
 * Format error response for dev mode
 * @param {string} type - Error type
 * @param {string} message - Error message
 * @param {string} suggestion - Suggestion for user
 * @returns {string}
 */
function formatDevError(type, message, suggestion) {
  return `[開發模式 ${type}] ${message}\n建議: ${suggestion}`;
}

/**
 * Truncate long output with marker
 * @param {string} text - Text to truncate
 * @param {number} maxLen - Maximum length (default 3000)
 * @returns {string}
 */
function truncateOutput(text, maxLen = 3000) {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen) + "\n...(truncated)";
}

module.exports = { formatOllamaResponse, formatDevError, truncateOutput };
