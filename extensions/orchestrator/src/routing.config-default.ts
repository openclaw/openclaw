import type { RoutingConfig } from "./types/schema.js";

/**
 * First-run default routing config. Written to disk on cold start.
 * Operators are expected to hand-edit `routing.json` thereafter; the
 * extension only re-creates this file if it is missing.
 *
 * Rules order (by priority):
 *   priority 10 — narrow domain matches (code, ops).
 *   priority 5  — broad domain matches (research, writing, design, audit).
 *   priority 1  — generic catch-alls (planning, fast-cheap).
 *   default     — `main` (Jarvis) when no rule matches.
 */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  schemaVersion: 1,
  rules: [
    {
      id: "code-tasks",
      pattern: "\\b(code|debug|refactor|test|fix|implement|build|lint|typecheck)\\b",
      capabilities: [],
      agent: "coder",
      priority: 10,
    },
    {
      id: "ops-tasks",
      pattern: "\\b(ssh|deploy|server|launchd|plist|systemd|brew|postinstall)\\b",
      capabilities: [],
      agent: "helpdesk",
      priority: 10,
    },
    {
      id: "research-tasks",
      pattern: "\\b(research|find out|investigate|summarize|paper|literature)\\b",
      capabilities: [],
      agent: "researcher",
      priority: 5,
    },
    {
      id: "writing-tasks",
      pattern: "\\b(write|draft|email|reply|compose|copyedit)\\b",
      capabilities: [],
      agent: "main",
      priority: 5,
    },
    {
      id: "design-tasks",
      pattern: "\\b(design|mockup|figma|wireframe|ux|ui)\\b",
      capabilities: [],
      agent: "design-ui-designer",
      priority: 5,
    },
    {
      id: "planning-tasks",
      pattern: "\\b(plan|breakdown|spec|requirements|brainstorm|proposal)\\b",
      capabilities: [],
      agent: "main",
      priority: 1,
    },
    {
      id: "audit-tasks",
      pattern: "\\b(audit|review|inspect|check)\\b",
      capabilities: [],
      agent: "overwatch",
      priority: 5,
    },
    {
      id: "fast-cheap-tasks",
      pattern: "\\b(quick|brief|short|one-line|tldr)\\b",
      capabilities: [],
      agent: "gemini-flash-lite",
      priority: 1,
    },
  ],
  default: { agent: "main", requireApproval: false },
  approvalRequired: ["coder", "helpdesk"],
  approvalRequiredCapabilities: ["mutate-external", "ops", "publish", "deploy"],
};
