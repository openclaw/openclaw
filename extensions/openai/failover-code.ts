/** Maps OpenAI error codes to OpenClaw failover reasons. */
export function classifyOpenAiFailoverCode(code: string | undefined) {
  switch (code?.trim().toUpperCase()) {
    case "SERVER_ERROR":
      return "server_error" as const;
    case "INSUFFICIENT_QUOTA":
      return "billing" as const;
    case "CONTEXT_LENGTH_EXCEEDED":
      return "context_overflow" as const;
    case "INVALID_PROMPT":
    case "INVALID_REQUEST_ERROR":
    case "CONTENT_POLICY_VIOLATION":
    case "CONTENT_FILTER":
      return "format" as const;
    default:
      return undefined;
  }
}
