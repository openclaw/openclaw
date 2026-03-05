import type { HarnessRule } from "./rules.js";

/**
 * Layer 1: Built-in rules. Hardcoded safety floor.
 * These cannot be overridden by operator or client rules.
 */
export const BUILTIN_RULES: HarnessRule[] = [
  // Bulk destruction
  {
    tool: "email.delete",
    when: { count: ">10" },
    tier: "block",
    reason: "Bulk email deletion (>10 items)",
  },
  {
    tool: "calendar.delete",
    when: { count: ">5" },
    tier: "block",
    reason: "Bulk calendar deletion (>5 items)",
  },
  {
    tool: "contacts.delete",
    when: { count: ">5" },
    tier: "block",
    reason: "Bulk contact deletion (>5 items)",
  },

  // Data exfiltration
  {
    tool: "contacts.export",
    tier: "block",
    reason: "Bulk contact export",
  },

  // Contact manipulation (prompt injection defense)
  {
    tool: "contacts.add",
    tier: "confirm",
    reason: "Adding new contact",
    message: "Add {name} ({email}) to your contacts?",
  },

  // Catch-all: any export to unknown recipient
  {
    tool: "*",
    when: { verb: "export" },
    tier: "confirm",
    reason: "Export action requires confirmation",
    message: "Share data with {recipient}?",
  },

  // Gap 3: Community plugin tools — automatic confirm floor
  {
    tool: "*",
    when: { source: "community" },
    tier: "confirm",
    reason: "Community plugin tool — requires confirmation",
  },

  // Gap 4: Protect fridaclaw configuration files
  {
    tool: "write_file",
    when: { path_contains: "/fridaclaw/" },
    tier: "block",
    reason: "Cannot modify fridaclaw configuration",
  },
  {
    tool: "bash",
    when: { command_contains: "/fridaclaw/" },
    tier: "confirm",
    reason: "Shell command targeting fridaclaw paths",
  },

  // Gap 6: Shell/exec tools — always confirm
  {
    tool: "bash",
    tier: "confirm",
    reason: "Shell command execution",
  },
  {
    tool: "shell.*",
    tier: "confirm",
    reason: "Shell execution",
  },
  {
    tool: "exec.*",
    tier: "confirm",
    reason: "Command execution",
  },
  {
    tool: "run_command",
    tier: "confirm",
    reason: "Command execution",
  },

  // Gap 6: Sensitive file writes — block
  {
    tool: "write_file",
    when: { path_matches: ".*\\.(env|key|pem|crt|secret)$" },
    tier: "block",
    reason: "Write to sensitive file type",
  },

  // Gap 6: Network exfiltration via shell — block
  {
    tool: "bash",
    when: { command_contains: "curl|wget|nc|ssh|scp" },
    tier: "block",
    reason: "Network command in shell — potential exfiltration",
  },
];
