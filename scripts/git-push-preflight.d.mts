export const DEFAULT_PROTECTED_BRANCHES: string[];
export const DEFAULT_FORBIDDEN_PATHS: string[];
export const EXPECTED_PUSH_REMOTE_ENV: string;
export const FORBIDDEN_PATH_CONFIG_KEY: string;

export type GitPushPreflightIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  detail?: string;
};

export type GitPushPreflightResult = {
  ok: boolean;
  issues: GitPushPreflightIssue[];
  facts: Record<string, unknown>;
};

export function evaluateGitPushPreflight(params?: Record<string, unknown>): GitPushPreflightResult;
