export type TelegramMcpPluginManifest = {
  id: string;
  serverName: string;
  enabledByDefault: boolean;
  telegramDefault: boolean;
  autoCall: boolean;
  catalogPolicy: "selected_only" | "full_allowed";
  defaultMode: "read_only" | "approval_required";
  triggers: readonly string[];
};

export const TELEGRAM_MCP_PLUGIN_MANIFESTS = [
  {
    id: "github",
    serverName: "github",
    enabledByDefault: false,
    telegramDefault: false,
    autoCall: false,
    catalogPolicy: "selected_only",
    defaultMode: "read_only",
    triggers: ["github", "깃허브", "repo", "repository", "pr", "pull request", "issue", "branch"],
  },
  {
    id: "gmail",
    serverName: "gmail",
    enabledByDefault: false,
    telegramDefault: false,
    autoCall: false,
    catalogPolicy: "selected_only",
    defaultMode: "read_only",
    triggers: ["gmail", "메일", "이메일", "inbox", "받은편지"],
  },
  {
    id: "notion",
    serverName: "notion",
    enabledByDefault: false,
    telegramDefault: false,
    autoCall: false,
    catalogPolicy: "selected_only",
    defaultMode: "read_only",
    triggers: ["notion", "노션"],
  },
  {
    id: "tavily",
    serverName: "tavily",
    enabledByDefault: false,
    telegramDefault: false,
    autoCall: false,
    catalogPolicy: "selected_only",
    defaultMode: "read_only",
    triggers: ["tavily", "타빌리", "심층검색", "정밀검색", "deep research", "research"],
  },
  {
    id: "sqlite",
    serverName: "sqlite",
    enabledByDefault: false,
    telegramDefault: false,
    autoCall: false,
    catalogPolicy: "selected_only",
    defaultMode: "read_only",
    triggers: ["sqlite", "db", "database", "데이터베이스", "sql"],
  },
  {
    id: "kordoc",
    serverName: "kordoc",
    enabledByDefault: false,
    telegramDefault: false,
    autoCall: false,
    catalogPolicy: "selected_only",
    defaultMode: "read_only",
    triggers: ["kordoc", "ocr", "문서인식", "문서 OCR", "이미지 문서"],
  },
  {
    id: "n8n-mcp",
    serverName: "n8n-mcp",
    enabledByDefault: false,
    telegramDefault: false,
    autoCall: false,
    catalogPolicy: "selected_only",
    defaultMode: "read_only",
    triggers: ["n8n", "workflow", "워크플로", "자동화 플로우"],
  },
] as const satisfies readonly TelegramMcpPluginManifest[];

export const TELEGRAM_FULL_MCP_TRIGGERS = [
  "tools",
  "mcp 전체",
  "전체 mcp",
  "전체 도구",
  "full mcp",
  "모든 도구",
] as const;
