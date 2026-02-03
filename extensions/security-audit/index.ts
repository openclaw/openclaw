/**
 * Security Audit Plugin
 *
 * Restricts access to sensitive credential and configuration files.
 * Prevents reads, writes, and edits to API tokens, SSH keys, and
 * shell configuration files.
 */

import os from "node:os";
import path from "node:path";
import {
  emptyPluginConfigSchema,
  type BaseStageConfig,
  type GuardrailBaseConfig,
  type GuardrailEvaluation,
  type GuardrailEvaluationContext,
  type OpenClawPluginApi,
  createGuardrailPlugin,
} from "openclaw/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

type SensitivePathRule = {
  /** Rule identifier */
  id: string;
  /** Human-readable description */
  description: string;
  /** Glob-like patterns (supports * and **) */
  patterns: string[];
  /** Which operations to block */
  operations: ("read" | "write" | "execute")[];
};

type SecurityAuditConfig = GuardrailBaseConfig & {
  /** Additional sensitive path patterns (glob-like) */
  extraPaths?: string[];
  /** Paths to allow even if they match block rules */
  allowPaths?: string[];
  /** Disable specific built-in rules by ID */
  disabledRules?: string[];
  stages?: {
    beforeToolCall?: BaseStageConfig;
  };
};

// ============================================================================
// Built-in Rules
// ============================================================================

const BUILT_IN_RULES: SensitivePathRule[] = [
  // SSH credentials
  {
    id: "ssh-keys",
    description: "SSH private keys and configuration",
    patterns: [
      "~/.ssh/id_*",
      "~/.ssh/*_key",
      "~/.ssh/config",
      "~/.ssh/known_hosts",
      "~/.ssh/authorized_keys",
    ],
    operations: ["read", "write"],
  },

  // GPG keys
  {
    id: "gpg-keys",
    description: "GPG private keys",
    patterns: ["~/.gnupg/private-keys-v1.d/*", "~/.gnupg/secring.gpg"],
    operations: ["read", "write"],
  },

  // AI assistant credentials
  {
    id: "claude-credentials",
    description: "Claude Code credentials",
    patterns: ["~/.claude/*", "~/.claude.json", "~/.config/claude/*"],
    operations: ["read", "write"],
  },
  {
    id: "openclaw-credentials",
    description: "OpenClaw credentials and sessions",
    patterns: ["~/.openclaw/credentials/*", "~/.openclaw/sessions/*"],
    operations: ["read", "write"],
  },
  {
    id: "openai-credentials",
    description: "OpenAI API credentials",
    patterns: ["~/.openai/*", "~/.config/openai/*"],
    operations: ["read", "write"],
  },
  {
    id: "copilot-credentials",
    description: "GitHub Copilot credentials",
    patterns: ["~/.config/github-copilot/*", "~/.copilot/*"],
    operations: ["read", "write"],
  },

  // Cloud provider credentials
  {
    id: "aws-credentials",
    description: "AWS credentials and config",
    patterns: ["~/.aws/credentials", "~/.aws/config"],
    operations: ["read", "write"],
  },
  {
    id: "gcloud-credentials",
    description: "Google Cloud credentials",
    patterns: [
      "~/.config/gcloud/credentials.db",
      "~/.config/gcloud/application_default_credentials.json",
    ],
    operations: ["read", "write"],
  },
  {
    id: "azure-credentials",
    description: "Azure credentials",
    patterns: ["~/.azure/credentials", "~/.azure/accessTokens.json"],
    operations: ["read", "write"],
  },

  // Package manager credentials
  {
    id: "npm-credentials",
    description: "npm authentication",
    patterns: ["~/.npmrc", "~/.npm/_authToken"],
    operations: ["read", "write"],
  },
  {
    id: "pypi-credentials",
    description: "PyPI credentials",
    patterns: ["~/.pypirc"],
    operations: ["read", "write"],
  },

  // Shell configuration (write-only block to prevent backdoors)
  {
    id: "shell-config",
    description: "Shell configuration files",
    patterns: [
      "~/.bashrc",
      "~/.bash_profile",
      "~/.profile",
      "~/.zshrc",
      "~/.zprofile",
      "~/.zshenv",
    ],
    operations: ["write"],
  },

  // Environment files
  {
    id: "env-files",
    description: "Environment variable files",
    patterns: ["**/.env", "**/.env.local", "**/.env.production", "**/.env.*"],
    operations: ["read"],
  },

  // Git credentials
  {
    id: "git-credentials",
    description: "Git credential storage",
    patterns: ["~/.git-credentials", "~/.gitconfig"],
    operations: ["read", "write"],
  },

  // Netrc (FTP/HTTP auth)
  {
    id: "netrc",
    description: "Network authentication file",
    patterns: ["~/.netrc"],
    operations: ["read", "write"],
  },

  // Kubernetes
  {
    id: "kube-config",
    description: "Kubernetes configuration",
    patterns: ["~/.kube/config", "~/.kube/credentials/*"],
    operations: ["read", "write"],
  },

  // Docker
  {
    id: "docker-config",
    description: "Docker authentication",
    patterns: ["~/.docker/config.json"],
    operations: ["read", "write"],
  },

  // System files (read protection)
  {
    id: "system-passwd",
    description: "System password file",
    patterns: ["/etc/passwd", "/etc/shadow", "/etc/sudoers"],
    operations: ["read", "write"],
  },

  // Certificate and key files
  {
    id: "certificate-files",
    description: "Certificate and private key files",
    patterns: ["**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx"],
    operations: ["read", "write"],
  },

  // Password store
  {
    id: "password-store",
    description: "Password store directory",
    patterns: ["~/.password-store/*"],
    operations: ["read", "write"],
  },

  // Additional AI tool credentials
  {
    id: "codex-credentials",
    description: "OpenAI Codex credentials",
    patterns: ["~/.codex/auth.json", "~/.codex/*"],
    operations: ["read", "write"],
  },
  {
    id: "qwen-credentials",
    description: "Qwen OAuth credentials",
    patterns: ["~/.qwen/oauth_creds.json", "~/.qwen/*"],
    operations: ["read", "write"],
  },
  {
    id: "minimax-credentials",
    description: "MiniMax OAuth credentials",
    patterns: ["~/.minimax/oauth_creds.json", "~/.minimax/*"],
    operations: ["read", "write"],
  },

  // WhatsApp session credentials
  {
    id: "whatsapp-credentials",
    description: "WhatsApp session credentials",
    patterns: ["**/whatsapp/*/creds.json", "**/whatsapp/**/creds.json"],
    operations: ["read", "write"],
  },

  // Google CLI OAuth
  {
    id: "google-cli-credentials",
    description: "Google CLI OAuth credentials",
    patterns: ["~/.config/gcloud/**/credentials.json", "**/gogcli/credentials.json"],
    operations: ["read", "write"],
  },

  // Fish shell config
  {
    id: "fish-config",
    description: "Fish shell configuration",
    patterns: ["~/.config/fish/config.fish"],
    operations: ["write"],
  },
];

// ============================================================================
// Exception Patterns (paths that match but should be allowed)
// ============================================================================

const EXCEPTION_PATTERNS: RegExp[] = [
  /node_modules\//,
  /\.test\./,
  /\/test\//,
  /\/tests\//,
  /\/fixtures\//,
  /\/__fixtures__\//,
  /\/mocks\//,
  /\/__mocks__\//,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
];

/**
 * Check if a path should be excepted from security checks.
 * Allows test files, fixtures, and dependency locks to avoid false positives.
 */
function isExceptedPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return EXCEPTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

// ============================================================================
// Helper Functions
// ============================================================================

const HOME_DIR = os.homedir();

/**
 * Normalize a path, expanding ~ to home directory.
 */
function normalizePath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(HOME_DIR, p.slice(2));
  }
  if (p.startsWith("~")) {
    return path.join(HOME_DIR, p.slice(1));
  }
  return path.resolve(p);
}

/**
 * Convert a glob-like pattern to a regex.
 * Supports:
 * - * matches any characters except /
 * - ** matches any characters including /
 * - ~ expands to home directory
 */
function patternToRegex(pattern: string): RegExp {
  let normalized = pattern;

  // Expand ~
  if (normalized.startsWith("~/")) {
    normalized = HOME_DIR + normalized.slice(1);
  } else if (normalized === "~") {
    normalized = HOME_DIR;
  }

  // Escape regex special chars except * and **
  let regexStr = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*");

  return new RegExp(`^${regexStr}$`);
}

/**
 * Check if a path matches any of the given patterns.
 */
function pathMatchesPatterns(filePath: string, patterns: string[]): boolean {
  const normalizedPath = normalizePath(filePath);
  return patterns.some((pattern) => {
    const regex = patternToRegex(pattern);
    return regex.test(normalizedPath);
  });
}

/**
 * Determine the operation type from tool name.
 * Tool names are lowercase (e.g. "exec", "read", "write").
 */
function getOperationType(toolName: string, params: unknown): "read" | "write" | "execute" | null {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
    case "edit":
    case "apply_patch":
      return "write";
    case "exec": {
      // exec can be read, write, or execute depending on command
      const cmd = (params as { command?: string })?.command ?? "";
      if (hasUnquotedRedirection(cmd)) {
        return "write";
      }
      if (/\b(cat|head|tail|less|more|grep|awk|sed)\b/.test(cmd)) {
        return "read";
      }
      if (/\b(echo|printf|tee)\b.*>/.test(cmd) || /\b(cp|mv|rm)\b/.test(cmd)) {
        return "write";
      }
      return "execute";
    }
    case "find":
    case "grep":
      return "read";
    default:
      return null;
  }
}

function hasUnquotedRedirection(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === ">") {
      return true;
    }
  }

  return false;
}

/**
 * Extract file paths from tool parameters.
 * Tool names are lowercase (e.g. "exec", "read", "write").
 */
function extractPaths(toolName: string, params: unknown): string[] {
  if (!params || typeof params !== "object") {
    return [];
  }
  const p = params as Record<string, unknown>;

  switch (toolName) {
    case "read":
    case "write":
    case "edit":
    case "apply_patch":
      if (typeof p.file_path === "string") {
        return [p.file_path];
      }
      if (typeof p.path === "string") {
        return [p.path];
      }
      return [];

    case "find":
    case "grep":
      if (typeof p.path === "string") {
        return [p.path];
      }
      if (typeof p.pattern === "string") {
        // Extract directory from glob pattern
        const parts = p.pattern.split("/");
        if (parts.length > 1) {
          return [parts.slice(0, -1).join("/")];
        }
      }
      return [];

    case "exec": {
      // Try to extract paths from command
      const cmd = (p.command as string) ?? "";
      const paths: string[] = [];

      // Match common file path patterns in commands
      // This is best-effort; complex commands may not be fully parsed
      const pathMatches = cmd.match(/(?:^|\s)((?:~|\/)[^\s;|&><]+)/g);
      if (pathMatches) {
        for (const match of pathMatches) {
          paths.push(match.trim());
        }
      }
      return paths;
    }

    default:
      return [];
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const securityAuditPlugin = createGuardrailPlugin<SecurityAuditConfig>({
  id: "security-audit",
  name: "Security Audit",
  description: "Restricts access to sensitive credential and configuration files",

  async evaluate(
    ctx: GuardrailEvaluationContext,
    config: SecurityAuditConfig,
    _api: OpenClawPluginApi,
  ): Promise<GuardrailEvaluation | null> {
    // Only evaluate before_tool_call
    if (ctx.stage !== "before_tool_call") {
      return { safe: true };
    }

    const toolName = ctx.metadata.toolName;
    const params = ctx.metadata.toolParams;

    if (!toolName) {
      return { safe: true };
    }

    // Determine operation type
    const operation = getOperationType(toolName, params);
    if (!operation) {
      return { safe: true };
    }

    // Extract paths from tool parameters
    const paths = extractPaths(toolName, params);
    if (paths.length === 0) {
      return { safe: true };
    }

    // Check allow patterns first (escape hatch)
    const allowPatterns = config.allowPaths ?? [];
    const disabledRules = new Set(config.disabledRules ?? []);

    for (const filePath of paths) {
      // Skip test/fixture paths to reduce false positives
      if (isExceptedPath(filePath)) {
        continue;
      }

      // Skip if path is in allow list
      if (allowPatterns.length > 0 && pathMatchesPatterns(filePath, allowPatterns)) {
        continue;
      }

      // Check extra sensitive paths from config
      if (config.extraPaths && config.extraPaths.length > 0) {
        if (pathMatchesPatterns(filePath, config.extraPaths)) {
          return {
            safe: false,
            reason: "Access to sensitive path blocked",
            details: {
              path: filePath,
              operation,
              source: "custom",
            },
          };
        }
      }

      // Check built-in rules
      for (const rule of BUILT_IN_RULES) {
        if (disabledRules.has(rule.id)) {
          continue;
        }

        // Check if operation matches rule
        if (!rule.operations.includes(operation)) {
          continue;
        }

        // Check if path matches rule patterns
        if (pathMatchesPatterns(filePath, rule.patterns)) {
          return {
            safe: false,
            reason: rule.description,
            details: {
              path: filePath,
              operation,
              ruleId: rule.id,
            },
          };
        }
      }
    }

    return { safe: true };
  },

  formatViolationMessage(evaluation: GuardrailEvaluation, _location: string): string {
    const details = evaluation.details as
      | {
          path?: string;
          operation?: string;
          ruleId?: string;
        }
      | undefined;

    const parts = [`Access blocked: ${evaluation.reason}.`];

    if (details?.operation) {
      parts.push(`Operation: ${details.operation}.`);
    }

    if (details?.ruleId) {
      parts.push(`Rule: ${details.ruleId}.`);
    }

    return parts.join(" ");
  },

  onRegister(api: OpenClawPluginApi, config: SecurityAuditConfig) {
    const disabledCount = config.disabledRules?.length ?? 0;
    const extraCount = config.extraPaths?.length ?? 0;
    api.logger.info(
      `Security audit enabled (${BUILT_IN_RULES.length - disabledCount} built-in rules, ${extraCount} custom paths)`,
    );
  },
});

// Apply config schema
const pluginWithSchema = {
  ...securityAuditPlugin,
  configSchema: emptyPluginConfigSchema(),
};

export default pluginWithSchema;

// Export for testing
export {
  BUILT_IN_RULES,
  EXCEPTION_PATTERNS,
  normalizePath,
  patternToRegex,
  pathMatchesPatterns,
  extractPaths,
  isExceptedPath,
};
export type { SecurityAuditConfig, SensitivePathRule };
