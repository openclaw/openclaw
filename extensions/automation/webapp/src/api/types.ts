/**
 * WebApp 與 Gateway RPC 共用的最小型別定義。
 * 這些型別對齊 extensions/automation/src/telegram-ui/agent-state.ts 的核心語意。
 */

export type AgentPhase = "idle" | "running" | "waiting" | "error";

export type ActiveTask = {
  id: string;
  title: string;
  progress: number;
};

export type AttentionItemUrgency = "high" | "medium" | "low";

export type AttentionItem = {
  id: string;
  title: string;
  urgency: AttentionItemUrgency;
};

export type AgentInfo = {
  id: string;
  name: string;
  status: string;
  model?: string;
  turns?: number;
};

export type CronJobInfo = {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  nextRunAt?: string;
};

export type ModelInfo = {
  id: string;
  provider?: string;
  displayName: string;
  active?: boolean;
};

export type SystemState = {
  phase: AgentPhase;
  activeTask: ActiveTask | null;
  agents: AgentInfo[];
  attentionItems: AttentionItem[];
  cronJobs: CronJobInfo[];
  models: ModelInfo[];
  stats: {
    tokensToday: number;
    tasksToday: number;
  };
};

export type GatewayCallParams = Record<string, unknown> | undefined;

export type JsonRpcId = number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcEventMessage = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};

export type GatewayEventHandler = (payload: unknown) => void;

export type TelegramTheme = "light" | "dark";

export type HapticFeedbackType =
  | "selection"
  | "light"
  | "medium"
  | "heavy"
  | "success"
  | "warning"
  | "error";

export type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TelegramWebApp = {
  ready?: () => void;
  expand?: () => void;
  requestFullscreen?: () => void;
  colorScheme?: "light" | "dark";
  initDataUnsafe?: { user?: TelegramUser };
  showConfirm?: (message: string, callback: (ok: boolean) => void) => void;
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy") => void;
    notificationOccurred?: (type: "success" | "warning" | "error") => void;
    selectionChanged?: () => void;
  };
  CloudStorage?: {
    getItem?: (key: string, callback: (error?: string, value?: string | null) => void) => void;
    setItem?: (
      key: string,
      value: string,
      callback: (error?: string, stored?: boolean) => void,
    ) => void;
  };
};

export type TelegramWindow = Window & {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
};
