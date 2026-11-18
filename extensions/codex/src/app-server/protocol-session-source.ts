export const CODEX_INTERACTIVE_THREAD_SOURCE_KINDS = ["cli", "vscode"] as const;
export const CODEX_INTERACTIVE_CUSTOM_THREAD_SOURCES = ["atlas", "chatgpt"] as const;

export type CodexThreadSourceKind =
  | (typeof CODEX_INTERACTIVE_THREAD_SOURCE_KINDS)[number]
  | "exec"
  | "appServer"
  | "subAgent"
  | "subAgentReview"
  | "subAgentCompact"
  | "subAgentThreadSpawn"
  | "subAgentOther"
  | "unknown";

type CodexSubAgentThreadSpawnSource = {
  parent_thread_id: string;
  depth?: number;
  agent_path?: string | null;
  agent_nickname?: string | null;
  agent_role?: string | null;
};

type CodexSubAgentSource =
  | "review"
  | "compact"
  | "memory_consolidation"
  | { thread_spawn: CodexSubAgentThreadSpawnSource }
  | { other: string };

export type CodexSessionSource =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | "unknown"
  | { custom: string }
  | { subAgent: CodexSubAgentSource };
