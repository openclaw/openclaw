import {
  type FailoverClassificationCorpusRow,
  billingSource,
  messageRows,
  failoverSignalRows,
  openRouterSource,
  reason,
  retrySource,
} from "./failover-classification.corpus.test-support.js";
export const overflowServerMiscCases = [
  {
    id: "openai-sdk-malformed-sse",
    source: "openai/core/streaming",
    signal: {
      provider: "openai",
      message: "Error reading response: malformed server-sent event JSON.",
    },
    expected: reason("server_error"),
  },
  {
    id: "google-sse-eof-incomplete-frame",
    source: "extensions/google/transport-stream.ts",
    signal: { provider: "google", message: "Google SSE stream ended with an incomplete frame" },
    expected: reason("timeout"),
  },
  {
    id: "google-sse-malformed-json-frame",
    source: "extensions/google/transport-stream.ts",
    signal: { provider: "google", message: "Google SSE stream returned malformed JSON" },
    expected: null,
  },
  ...failoverSignalRows(billingSource, reason("server_error"), [
    [
      "billing-cloudflare-521",
      {
        message:
          "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
      },
    ],
  ]),
  ...failoverSignalRows(billingSource, reason("timeout"), [
    ["billing-econnrefused", { message: "network error: ECONNREFUSED" }],
  ]),
  ...messageRows(retrySource, reason("server_error"), [
    { id: "retry-http-500", message: "HTTP 500 temporary provider response" },
  ]),
  ...failoverSignalRows(billingSource, reason("server_error"), [
    [
      "billing-openai-structured-server-error",
      {
        provider: "openai",
        message:
          'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}',
      },
    ],
  ]),
  {
    id: "openrouter-missing-model",
    source: openRouterSource,
    signal: {
      provider: "openrouter",
      status: 404,
      message: "No endpoints found for missing/model.",
    },
    expected: reason("model_not_found"),
  },
  ...failoverSignalRows(billingSource, reason("session_expired"), [
    [
      "billing-claude-conversation-missing",
      { provider: "claude-cli", message: "No conversation found with session ID: abc123" },
    ],
  ]),
] satisfies readonly FailoverClassificationCorpusRow[];
