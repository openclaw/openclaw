/** Maps OpenAI error codes to OpenClaw failover reasons. */
export function classifyOpenAiFailoverCode(code: string | undefined) {
  switch (code?.trim().toUpperCase()) {
    case "SERVER_ERROR":
      return "server_error" as const;
    case "INSUFFICIENT_QUOTA":
      return "billing" as const;
    default:
      return undefined;
  }
}
