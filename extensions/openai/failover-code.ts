export function classifyOpenAiFailoverCode(code: string | undefined) {
  switch (code?.trim().toUpperCase()) {
    case "SERVER_ERROR":
      return "server_error" as const;
    case "INSUFFICIENT_QUOTA":
    case "USAGE_NOT_INCLUDED":
      return "billing" as const;
    case "USAGE_LIMIT_REACHED":
      return "rate_limit" as const;
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
