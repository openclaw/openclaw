export type WorkflowNodeType =
  | "claude"
  | "codex"
  | "gate"
  | "notify"
  | "webhook"
  | "condition"
  | "parallel"
  | "delay";

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  label: string;
  position: { x: number; y: number };
  config: {
    prompt?: string;
    provider?: string;
    model?: string;
    timeoutMs?: number;
    requireConfirm?: boolean;
    webhookUrl?: string;
    condition?: string;
    delayMs?: number;
    notifyChannel?: string;
  };
};

export type WorkflowEdge = {
  from: string;
  to: string;
  label?: string;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  trigger: {
    type: "manual" | "cron" | "webhook" | "event";
    cronExpr?: string;
    webhookPath?: string;
    eventSource?: string;
    eventType?: string;
  };
  createdAt: number;
  updatedAt: number;
};

export type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "awaiting_confirm";
  currentNodeId: string;
  startedAt: number;
  completedAt?: number;
  nodeResults: Record<
    string,
    {
      status: "pending" | "running" | "done" | "error" | "skipped";
      output?: string;
      error?: string;
      startedAt?: number;
      completedAt?: number;
    }
  >;
};

export const WORKFLOW_TEMPLATES: WorkflowDefinition[] = [
  {
    id: "auto-pr",
    name: "Auto PR",
    description: "分析需求 → Codex 實作 → 測試 → Claude 審查 → 建立 PR",
    nodes: [
      { id: "analyze", type: "claude", label: "分析需求", position: { x: 0, y: 0 }, config: { prompt: "分析用戶需求，產出實作計畫" } },
      { id: "implement", type: "codex", label: "Codex 實作", position: { x: 200, y: 0 }, config: { prompt: "根據計畫實作程式碼" } },
      { id: "test", type: "codex", label: "跑測試", position: { x: 400, y: 0 }, config: { prompt: "執行測試套件" } },
      { id: "review", type: "claude", label: "自我審查", position: { x: 600, y: 0 }, config: { prompt: "審查 diff，檢查安全/效能問題" } },
      { id: "confirm", type: "gate", label: "確認推送", position: { x: 800, y: 0 }, config: { requireConfirm: true } },
      { id: "push", type: "codex", label: "建立 PR", position: { x: 1000, y: 0 }, config: { prompt: "建立 git branch, commit, push, 建立 PR" } },
    ],
    edges: [
      { from: "analyze", to: "implement" },
      { from: "implement", to: "test" },
      { from: "test", to: "review" },
      { from: "review", to: "confirm" },
      { from: "confirm", to: "push" },
    ],
    trigger: { type: "manual" },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "拉取 diff → 安全審查 + 效能審查 + 架構審查 → 彙報",
    nodes: [
      { id: "fetch", type: "claude", label: "拉取 diff", position: { x: 0, y: 100 }, config: { prompt: "取得 PR diff" } },
      { id: "security", type: "claude", label: "安全審查", position: { x: 200, y: 0 }, config: { prompt: "檢查安全漏洞" } },
      { id: "perf", type: "claude", label: "效能審查", position: { x: 200, y: 100 }, config: { prompt: "檢查效能問題" } },
      { id: "arch", type: "claude", label: "架構審查", position: { x: 200, y: 200 }, config: { prompt: "檢查架構設計" } },
      { id: "report", type: "claude", label: "彙整報告", position: { x: 400, y: 100 }, config: { prompt: "整合三份審查結果" } },
      { id: "notify-node", type: "notify", label: "通知", position: { x: 600, y: 100 }, config: { notifyChannel: "review" } },
    ],
    edges: [
      { from: "fetch", to: "security" },
      { from: "fetch", to: "perf" },
      { from: "fetch", to: "arch" },
      { from: "security", to: "report" },
      { from: "perf", to: "report" },
      { from: "arch", to: "report" },
      { from: "report", to: "notify-node" },
    ],
    trigger: { type: "manual" },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "daily-scan",
    name: "Daily Scan",
    description: "檢查 PR 狀態 → CI 結果 → 逾期提醒",
    nodes: [
      { id: "list-prs", type: "claude", label: "列出 PR", position: { x: 0, y: 0 }, config: { prompt: "列出所有 open PR" } },
      { id: "check-ci", type: "claude", label: "檢查 CI", position: { x: 200, y: 0 }, config: { prompt: "檢查每個 PR 的 CI 狀態" } },
      { id: "check-stale", type: "claude", label: "逾期檢查", position: { x: 400, y: 0 }, config: { prompt: "找出超過 3 天未合的 PR" } },
      { id: "report-node", type: "notify", label: "推送報告", position: { x: 600, y: 0 }, config: { notifyChannel: "reports" } },
    ],
    edges: [
      { from: "list-prs", to: "check-ci" },
      { from: "check-ci", to: "check-stale" },
      { from: "check-stale", to: "report-node" },
    ],
    trigger: { type: "cron", cronExpr: "0 9 * * *" },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "refactor",
    name: "Refactor",
    description: "分析目標 → 重構 → 測試 → 提交",
    nodes: [
      { id: "analyze", type: "claude", label: "分析目標", position: { x: 0, y: 0 }, config: { prompt: "分析需要重構的部分" } },
      { id: "refactor-exec", type: "codex", label: "執行重構", position: { x: 200, y: 0 }, config: { prompt: "執行重構" } },
      { id: "test", type: "codex", label: "跑測試", position: { x: 400, y: 0 }, config: { prompt: "執行測試" } },
      { id: "confirm", type: "gate", label: "確認提交", position: { x: 600, y: 0 }, config: { requireConfirm: true } },
      { id: "commit", type: "codex", label: "提交", position: { x: 800, y: 0 }, config: { prompt: "git commit" } },
    ],
    edges: [
      { from: "analyze", to: "refactor-exec" },
      { from: "refactor-exec", to: "test" },
      { from: "test", to: "confirm" },
      { from: "confirm", to: "commit" },
    ],
    trigger: { type: "manual" },
    createdAt: 0,
    updatedAt: 0,
  },
];
