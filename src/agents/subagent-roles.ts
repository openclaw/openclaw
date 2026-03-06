/**
 * Subagent Role System
 *
 * This module defines a role-based system for subagents, enabling specialized
 * agents with different capabilities, prompts, and tool access policies.
 *
 * @module subagent-roles
 */

// =============================================================================
// Role Type Definitions
// =============================================================================

/**
 * Built-in subagent role identifiers.
 */
export const SUBAGENT_ROLE_CODER = "coder" as const;
export const SUBAGENT_ROLE_REVIEWER = "reviewer" as const;
export const SUBAGENT_ROLE_PLANNER = "planner" as const;
export const SUBAGENT_ROLE_RESEARCHER = "researcher" as const;
export const SUBAGENT_ROLE_DEBUGGER = "debugger" as const;
export const SUBAGENT_ROLE_TESTER = "tester" as const;
export const SUBAGENT_ROLE_WRITER = "writer" as const;
export const SUBAGENT_ROLE_ANALYZER = "analyzer" as const;

/**
 * Subagent role type - supports both built-in and custom roles.
 */
export type SubagentRole =
  | typeof SUBAGENT_ROLE_CODER
  | typeof SUBAGENT_ROLE_REVIEWER
  | typeof SUBAGENT_ROLE_PLANNER
  | typeof SUBAGENT_ROLE_RESEARCHER
  | typeof SUBAGENT_ROLE_DEBUGGER
  | typeof SUBAGENT_ROLE_TESTER
  | typeof SUBAGENT_ROLE_WRITER
  | typeof SUBAGENT_ROLE_ANALYZER
  | (string & {});

/**
 * Configuration for a subagent role.
 */
export type SubagentRoleConfig = {
  /** Display name for the role */
  name: string;
  /** Human-readable description */
  description: string;
  /** Additional system prompt to append */
  systemPromptSuffix?: string;
  /** Preferred model for this role (e.g., "claude-3-opus") */
  preferredModel?: string;
  /** Preferred provider for this role (e.g., "anthropic") */
  preferredProvider?: string;
  /** Tools this role is allowed to use (if specified, only these tools are available) */
  toolAllowlist?: string[];
  /** Tools this role is denied from using */
  toolDenylist?: string[];
  /** Default timeout in seconds for this role */
  defaultTimeoutSeconds?: number;
  /** Whether this role should have read-only access by default */
  readOnlyHint?: boolean;
  /** Icon/emoji for UI display */
  icon?: string;
};

// =============================================================================
// Built-in Role Definitions
// =============================================================================

/**
 * Built-in subagent role configurations.
 */
export const BUILTIN_SUBAGENT_ROLES: Record<string, SubagentRoleConfig> = {
  coder: {
    name: "Coder",
    description: "Writes and implements code. Focuses on clean, efficient, and maintainable code.",
    systemPromptSuffix: `You are a coding specialist. Your primary focus is writing clean, efficient, and well-structured code.

Guidelines:
- Write code that is easy to read and maintain
- Follow established patterns and conventions in the codebase
- Include appropriate error handling
- Add comments for complex logic
- Consider edge cases and potential issues`,
    preferredModel: "claude-3-5-sonnet",
    preferredProvider: "anthropic",
    toolAllowlist: ["bash", "read", "write", "edit", "glob", "grep"],
    icon: "💻",
  },

  reviewer: {
    name: "Reviewer",
    description: "Reviews code for quality, bugs, and improvements. Read-only access by default.",
    systemPromptSuffix: `You are a code reviewer. Your primary focus is ensuring code quality, identifying bugs, and suggesting improvements.

Guidelines:
- Check for potential bugs and edge cases
- Evaluate code readability and maintainability
- Suggest improvements for performance where applicable
- Ensure adherence to coding standards
- Provide constructive, actionable feedback`,
    preferredModel: "claude-3-opus",
    preferredProvider: "anthropic",
    toolAllowlist: ["read", "bash", "glob", "grep"],
    toolDenylist: ["write", "edit"],
    readOnlyHint: true,
    icon: "🔍",
  },

  planner: {
    name: "Planner",
    description: "Analyzes requirements and creates implementation plans. Focuses on architecture and task breakdown.",
    systemPromptSuffix: `You are a planning specialist. Your primary focus is analyzing requirements and creating detailed implementation plans.

Guidelines:
- Break down complex tasks into manageable steps
- Identify dependencies between tasks
- Consider potential risks and mitigation strategies
- Propose clear milestones and deliverables
- Document assumptions and constraints`,
    preferredModel: "claude-3-opus",
    preferredProvider: "anthropic",
    toolAllowlist: ["read", "web_search", "web_fetch", "glob", "grep"],
    readOnlyHint: true,
    icon: "📋",
  },

  researcher: {
    name: "Researcher",
    description: "Gathers information, documentation, and best practices. Focuses on information synthesis.",
    systemPromptSuffix: `You are a research specialist. Your primary focus is gathering and synthesizing information.

Guidelines:
- Search for relevant documentation and resources
- Summarize findings clearly and concisely
- Cite sources when possible
- Identify best practices and patterns
- Note any limitations or caveats`,
    preferredModel: "claude-3-5-sonnet",
    preferredProvider: "anthropic",
    toolAllowlist: ["web_search", "web_fetch", "read", "glob", "grep"],
    readOnlyHint: true,
    icon: "📚",
  },

  debugger: {
    name: "Debugger",
    description: "Diagnoses and fixes issues. Focuses on problem identification and resolution.",
    systemPromptSuffix: `You are a debugging specialist. Your primary focus is identifying and resolving issues.

Guidelines:
- Start by understanding the expected behavior
- Identify the root cause, not just symptoms
- Propose targeted fixes
- Verify fixes don't introduce new issues
- Document the problem and solution`,
    preferredModel: "claude-3-5-sonnet",
    preferredProvider: "anthropic",
    toolAllowlist: ["bash", "read", "edit", "glob", "grep"],
    icon: "🐛",
  },

  tester: {
    name: "Tester",
    description: "Writes and runs tests. Focuses on test coverage and quality assurance.",
    systemPromptSuffix: `You are a testing specialist. Your primary focus is ensuring code quality through comprehensive testing.

Guidelines:
- Write clear, maintainable tests
- Cover happy paths and edge cases
- Use appropriate testing patterns
- Ensure tests are deterministic
- Document test coverage and limitations`,
    preferredModel: "claude-3-5-sonnet",
    preferredProvider: "anthropic",
    toolAllowlist: ["bash", "read", "write", "edit", "glob", "grep"],
    icon: "🧪",
  },

  writer: {
    name: "Writer",
    description: "Creates documentation and content. Focuses on clear communication.",
    systemPromptSuffix: `You are a documentation specialist. Your primary focus is creating clear, comprehensive documentation.

Guidelines:
- Write for the intended audience
- Use clear, concise language
- Include examples where helpful
- Structure content logically
- Keep documentation up-to-date`,
    preferredModel: "claude-3-5-sonnet",
    preferredProvider: "anthropic",
    toolAllowlist: ["read", "write", "edit", "glob", "grep"],
    icon: "✍️",
  },

  analyzer: {
    name: "Analyzer",
    description: "Analyzes data, logs, and metrics. Focuses on insights and patterns.",
    systemPromptSuffix: `You are an analysis specialist. Your primary focus is extracting insights from data and logs.

Guidelines:
- Look for patterns and anomalies
- Provide data-driven insights
- Visualize data when helpful
- Identify root causes
- Suggest actionable improvements`,
    preferredModel: "claude-3-5-sonnet",
    preferredProvider: "anthropic",
    toolAllowlist: ["bash", "read", "glob", "grep"],
    readOnlyHint: true,
    icon: "📊",
  },
};

// =============================================================================
// Role Resolution Functions
// =============================================================================

/**
 * Resolves the effective role configuration by merging built-in defaults with custom overrides.
 *
 * @param role - The role identifier (built-in or custom)
 * @param customConfig - Optional custom configuration to merge
 * @returns The resolved role configuration, or undefined if role is not specified
 */
export function resolveRoleConfig(
  role?: SubagentRole,
  customConfig?: Partial<SubagentRoleConfig>,
): SubagentRoleConfig | undefined {
  if (!role) {
    return undefined;
  }

  const builtin = BUILTIN_SUBAGENT_ROLES[role];

  if (!builtin && !customConfig) {
    // Custom role without any config - return minimal config
    return {
      name: role,
      description: `Custom role: ${role}`,
    };
  }

  if (!builtin) {
    // Custom role with config
    return {
      name: customConfig?.name ?? role,
      description: customConfig?.description ?? `Custom role: ${role}`,
      ...customConfig,
    } as SubagentRoleConfig;
  }

  // Built-in role, potentially with overrides
  return {
    ...builtin,
    ...customConfig,
  } as SubagentRoleConfig;
}

/**
 * Applies role configuration to a base system prompt.
 *
 * @param basePrompt - The base system prompt
 * @param roleConfig - The role configuration to apply
 * @returns The modified system prompt with role context
 */
export function applyRoleToSystemPrompt(
  basePrompt: string,
  roleConfig?: SubagentRoleConfig,
): string {
  if (!roleConfig) {
    return basePrompt;
  }

  const roleHeader = `## Role: ${roleConfig.name}`;
  const roleDescription = roleConfig.description;
  const rolePrompt = roleConfig.systemPromptSuffix;

  let roleSection = roleHeader;
  if (roleDescription) {
    roleSection += `\n${roleDescription}`;
  }
  if (rolePrompt) {
    roleSection += `\n\n${rolePrompt}`;
  }

  return `${basePrompt}\n\n${roleSection}`;
}

/**
 * Resolves the tool policy for a role.
 *
 * @param roleConfig - The role configuration
 * @returns Tool policy with allow and deny lists
 */
export function resolveRoleToolPolicy(
  roleConfig?: SubagentRoleConfig,
): { allow?: string[]; deny?: string[] } {
  if (!roleConfig) {
    return {};
  }

  return {
    allow: roleConfig.toolAllowlist,
    deny: roleConfig.toolDenylist,
  };
}

/**
 * Resolves the model selection for a role.
 *
 * @param roleConfig - The role configuration
 * @param defaultModel - The default model to use if role doesn't specify one
 * @returns The model reference (provider/model format) or undefined
 */
export function resolveRoleModel(
  roleConfig?: SubagentRoleConfig,
  defaultModel?: string,
): string | undefined {
  if (!roleConfig) {
    return defaultModel;
  }

  const provider = roleConfig.preferredProvider;
  const model = roleConfig.preferredModel;

  if (model?.includes("/")) {
    return model;
  }

  if (provider && model) {
    return `${provider}/${model}`;
  }

  return model ?? defaultModel;
}

/**
 * Checks if a role is a built-in role.
 *
 * @param role - The role identifier
 * @returns True if the role is built-in
 */
export function isBuiltinRole(role: string): boolean {
  return role in BUILTIN_SUBAGENT_ROLES;
}

/**
 * Gets all available role names (built-in only).
 *
 * @returns Array of built-in role names
 */
export function getBuiltinRoleNames(): string[] {
  return Object.keys(BUILTIN_SUBAGENT_ROLES);
}

/**
 * Gets the display information for a role.
 *
 * @param role - The role identifier
 * @returns Object with name, description, and icon
 */
export function getRoleDisplay(role?: SubagentRole): {
  name: string;
  description: string;
  icon?: string;
} | undefined {
  if (!role) {
    return undefined;
  }

  const config = BUILTIN_SUBAGENT_ROLES[role];
  if (!config) {
    return {
      name: role,
      description: `Custom role: ${role}`,
    };
  }

  return {
    name: config.name,
    description: config.description,
    icon: config.icon,
  };
}
