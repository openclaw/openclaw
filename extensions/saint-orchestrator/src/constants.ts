import type { TierConfig } from "./types.js";

export const PLATFORM_PROTECTED_FILES = new Set(["SOUL.md", "IDENTITY.md", "AGENTS.md"]);
export const SESSION_TIER_TTL_MS = 10 * 60 * 1000;
export const STATE_CACHE_TTL_MS = 250;
export const CONFIRM_TTL_MS = 10 * 60 * 1000;

export const FALLBACK_OWNER_CEILING: TierConfig = {
  description: "Business owner",
  tools: [
    "exec",
    "process",
    "read",
    "write",
    "edit",
    "apply_patch",
    "web_search",
    "web_fetch",
    "browser",
    "message",
    "memory_search",
    "memory_get",
    "tts",
    "image",
    "sessions_spawn",
    "sessions_list",
    "sessions_history",
    "cron",
  ],
  deny_tools: [],
  exec_blocklist: [],
  memory_scope: ["shared", "private", "daily", "own_user", "all_users"],
  skills: "*",
  max_budget_usd: null,
  system_prompt_includes: {
    bootstrap: ["SOUL.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md", "USER.md", "HEARTBEAT.md"],
    inject: ["COMPANY.md"],
  },
  file_access: {
    read: ["*"],
    write: ["*"],
    deny_write: Array.from(PLATFORM_PROTECTED_FILES),
  },
  sessions_scope: "all",
  model: "claude-sonnet-4-5",
};

export const FALLBACK_EXTERNAL_CEILING: TierConfig = {
  description: "External contacts",
  tools: ["web_search", "web_fetch"],
  deny_tools: [],
  exec_blocklist: ["*"],
  memory_scope: ["own_user"],
  skills: [],
  max_budget_usd: 0.5,
  system_prompt_includes: {
    bootstrap: ["SOUL.md", "IDENTITY.md"],
    inject: [],
  },
  file_access: {
    read: [],
    write: [],
    deny_write: Array.from(PLATFORM_PROTECTED_FILES),
  },
  sessions_scope: "own",
  model: "claude-haiku-4-5",
};

export const FALLBACK_CUSTOM: Record<string, TierConfig> = {
  manager: {
    description: "Manager",
    tools: [
      "exec",
      "read",
      "web_search",
      "web_fetch",
      "message",
      "memory_search",
      "memory_get",
      "tts",
      "sessions_spawn",
      "cron",
    ],
    deny_tools: ["process", "apply_patch"],
    exec_blocklist: [
      "gog gmail delete *",
      "gog drive delete *",
      "cat /agent/config/*",
      "cat /agent/memory/private/*",
      "rm -rf *",
    ],
    memory_scope: ["shared", "daily", "own_user", "all_users"],
    skills: "*",
    max_budget_usd: 5,
    system_prompt_includes: {
      bootstrap: ["SOUL.md", "IDENTITY.md", "USER.md"],
      inject: ["COMPANY.md"],
    },
    sessions_scope: "all",
    model: "claude-sonnet-4-5",
  },
  employee: {
    description: "Employee",
    tools: ["exec", "read", "web_search", "web_fetch", "message", "memory_search"],
    deny_tools: ["process", "apply_patch"],
    exec_blocklist: [
      "gog gmail send *",
      "gog gmail delete *",
      "gog calendar delete *",
      "gog drive delete *",
      "cat /agent/config/*",
      "cat /agent/memory/private/*",
      "rm -rf *",
    ],
    memory_scope: ["shared", "own_user"],
    skills: ["google-workspace", "scheduling"],
    max_budget_usd: 2,
    system_prompt_includes: {
      bootstrap: ["SOUL.md", "IDENTITY.md", "USER.md"],
      inject: [],
    },
    sessions_scope: "own",
    model: "claude-haiku-4-5",
  },
};

export const TOOL_COST_USD: Record<string, number> = {
  web_search: 0.004,
  web_fetch: 0.002,
  browser: 0.015,
  exec: 0.01,
  process: 0.002,
  tts: 0.01,
  image: 0.01,
  memory_search: 0.001,
  memory_get: 0.001,
  cron: 0.003,
  sessions_spawn: 0.003,
  sessions_list: 0.0005,
  sessions_history: 0.0005,
};
