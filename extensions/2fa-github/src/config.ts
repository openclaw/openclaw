/**
 * GitHub 2FA Extension Configuration
 */

export type TwoFactorConfig = {
  clientId?: string;
  tokenTtlMinutes?: number;
  sensitiveTools?: string[];
  gateAllTools?: boolean;
};

const DEFAULT_SENSITIVE_TOOLS = ["exec", "Bash", "Write", "Edit", "NotebookEdit"];
const DEFAULT_TTL_MINUTES = 30;

export function parseConfig(value: unknown): TwoFactorConfig {
  if (!value || typeof value !== "object") return {};
  const cfg = value as Record<string, unknown>;
  return {
    clientId: typeof cfg.clientId === "string" ? cfg.clientId : undefined,
    tokenTtlMinutes:
      typeof cfg.tokenTtlMinutes === "number" ? cfg.tokenTtlMinutes : DEFAULT_TTL_MINUTES,
    sensitiveTools: Array.isArray(cfg.sensitiveTools)
      ? cfg.sensitiveTools.filter((t): t is string => typeof t === "string")
      : DEFAULT_SENSITIVE_TOOLS,
    gateAllTools: typeof cfg.gateAllTools === "boolean" ? cfg.gateAllTools : false,
  };
}

export const twoFactorConfigSchema = {
  parse: parseConfig,
  uiHints: {
    clientId: {
      label: "GitHub OAuth App Client ID",
      placeholder: "Iv1.xxxxxxxxxxxxxxxx",
      help: "Create at GitHub Settings > Developer Settings > OAuth Apps (enable Device Flow)",
    },
    tokenTtlMinutes: {
      label: "Session TTL (minutes)",
      placeholder: "30",
      help: "How long before re-authentication is required",
    },
    sensitiveTools: {
      label: "Sensitive Tools",
      help: "Tool names requiring 2FA (default: Bash, Write, Edit, NotebookEdit)",
    },
    gateAllTools: {
      label: "Gate All Tools",
      help: "Require 2FA for all tools, not just sensitive ones",
    },
  },
};
