import { redactSecrets, truncate } from "./sanitize.js";

export type JiraErrorCode =
  | "jira_timeout"
  | "jira_rate_limited"
  | "jira_unauthorized"
  | "jira_forbidden"
  | "jira_not_found"
  | "jira_conflict"
  | "jira_request_failed"
  | "jira_validation_failed"
  | "jira_polling_timeout";

export type JiraErrorPayload = {
  ok: false;
  code: JiraErrorCode;
  message: string;
  status?: number;
  retryable: boolean;
};

export class JiraApiError extends Error {
  constructor(
    message: string,
    public readonly code: JiraErrorCode,
    public readonly status?: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

export function sanitizeJiraErrorMessage(params: {
  message: string;
  secrets?: string[];
  maxLength?: number;
}): string {
  const redacted = redactSecrets(params.message, params.secrets ?? []);
  return truncate(redacted, params.maxLength ?? 1_000);
}

export function normalizeJiraError(
  error: unknown,
  options: { secrets?: string[]; fallbackCode?: JiraErrorCode } = {},
): JiraErrorPayload {
  const fallbackCode = options.fallbackCode ?? "jira_request_failed";

  if (error instanceof JiraApiError) {
    return {
      ok: false,
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      message: sanitizeJiraErrorMessage({
        message: error.message,
        secrets: options.secrets,
      }),
    };
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: fallbackCode,
    retryable: false,
    message: sanitizeJiraErrorMessage({
      message: rawMessage,
      secrets: options.secrets,
    }),
  };
}
