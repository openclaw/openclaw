# SuperClaw — OpenClaw Telegram 超級操控介面完整技術規格書

> 版本: 2.0 | 日期: 2026-05-17
> 目的: 交給 Codex CLI 實作的完整藍圖

---

## 1. 專案定義

SuperClaw 是以 Telegram 為統一入口的**智能體操控台**。
透過 OpenClaw Gateway (174 個 WebSocket RPC 方法) 統合 Claude CLI + Codex CLI + 第三方 API。

**核心理念**: Agent 主動告訴你該做什麼，你只需要決定。

### v2 設計哲學（區別於 v1 靜態選單）

| 原則 | 舊設計 (v1) | 新設計 (v2) |
|------|-------------|-------------|
| 首頁 | 8 個固定按鈕選單 | 活的戰情面板：Agent 狀態 + 待處理事項 + 情境按鈕 |
| 交互 | 用戶翻選單找功能 | Agent 根據狀態主動建議下一步 |
| 按鈕 | 固定不變 | 隨系統狀態動態變化（idle/running/error 不同按鈕） |
| 進度 | 無法看到過程 | Task Thread：同一訊息即時更新進度 + 思考過程 |
| 通知 | 所有事件同等對待 | 三級通知：silent（更新面板）/ quiet（新訊息無聲）/ loud（有聲通知） |
| 操作後 | 回到選單 | 智能建議下一步（修完 → 測試 → 提交 → PR） |
| 錯誤 | 靜態錯誤訊息 | 自動附帶「重試」+「分析錯誤」按鈕 |

### Dashboard 示意

```
🟢 待命中
━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ 需要你的注意 (2)
  🔴 CI 失敗: main branch lint error
  📋 PR #42 等待 Review

✅ 上次: 重構 auth module (3m 前)
━━━━━━━━━━━━━━━━━━━━━━━━
🟢 Claude claude-sonnet-4-6  🟢 Codex codex-mini
📊 今日: 5 任務 · 12.4k tokens

[🔍 分析 CI] [📋 Review PR]
[💬 對話] [💻 寫碼] [⚙️ 更多]
```

```
👨‍💻 寫碼中
━━━━━━━━━━━━━━━━━━━━━━━━
💻 重構 auth module
[████████░░░░] 67%
Step 2/3: 執行重構 (42s)
→ 正在修改 src/auth/middleware.ts...

━━━━━━━━━━━━━━━━━━━━━━━━
🟡 Claude busy  🟢 Codex online

[📋 詳情] [⏸ 暫停] [⏹ 停止]
```

---

## 2. 技術堆疊

| 層 | 技術 | 說明 |
|----|------|------|
| Bot 框架 | grammY | 已在 extensions/telegram/ 中 |
| Mini App 前端 | React 19 + Vite + TypeScript | 全螢幕儀表板 |
| Mini App UI | @telegram-apps/telegram-ui + @telegram-apps/sdk | Telegram 原生風格 |
| 即時通訊 | WebSocket | 連接 OpenClaw Gateway |
| 後端 | OpenClaw Gateway (Node.js) | 174 RPC methods |
| AI - 分析 | Claude CLI (subprocess) | claude -p --output-format stream-json |
| AI - 寫碼 | Codex CLI (JSON-RPC stdio) | codex app-server |
| 狀態存儲 | SQLite (sessions) + Telegram Cloud Storage (user prefs) | |
| 靜態服務 | OpenClaw Gateway or Nginx | Mini App HTML/JS/CSS |

---

## 3. 十大模組完整設計

---

### 模組 1: Mini App 全螢幕儀表板

#### 專案初始化

```bash
# 在 extensions/automation/ 下建立 webapp/
cd extensions/automation
mkdir webapp && cd webapp
npm create vite@latest . -- --template react-ts
npm install @telegram-apps/sdk @telegram-apps/telegram-ui zustand react-router-dom
```

#### vite.config.ts

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/superclaw/",
  build: {
    outDir: "../dist-webapp",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
  },
});
```

#### 目錄結構

```
extensions/automation/webapp/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
├── public/
│   └── favicon.svg
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── api/
    │   ├── gateway-ws.ts           # WebSocket RPC client → OpenClaw Gateway
    │   ├── telegram-bridge.ts      # window.Telegram.WebApp 封裝
    │   └── types.ts                # 共用 API 型別
    ├── pages/
    │   ├── Dashboard.tsx           # 首頁 Mission Control
    │   ├── AgentControl.tsx        # Agent 管理
    │   ├── CodeWorkspace.tsx       # 程式碼工作區 + 即時輸出
    │   ├── WorkflowEditor.tsx      # 拖拽 Workflow 編輯器
    │   ├── CronManager.tsx         # Cron 排程管理
    │   ├── ModelSelector.tsx       # 模型切換
    │   ├── DevOpsPanel.tsx         # CI/CD 監控
    │   ├── TaskBoard.tsx           # Kanban 看板
    │   └── Settings.tsx            # 設定面板
    ├── components/
    │   ├── LiveStream.tsx          # 即時 CLI 輸出串流
    │   ├── DiffViewer.tsx          # 程式碼 diff 檢視器
    │   ├── ProgressTracker.tsx     # 多步驟進度條
    │   ├── ConfirmDialog.tsx       # 確認對話框 (含生物辨識)
    │   ├── AgentCard.tsx           # Agent 狀態卡片
    │   ├── WorkflowNode.tsx        # Workflow 節點元件
    │   ├── CronJobCard.tsx         # Cron 任務卡片
    │   ├── StatusBar.tsx           # 底部狀態列
    │   └── NavBar.tsx              # 頂部導航列
    ├── hooks/
    │   ├── useGateway.ts           # WebSocket 連線 + RPC hook
    │   ├── useTelegram.ts          # Telegram WebApp API hook
    │   ├── useAgent.ts             # Agent 狀態訂閱 hook
    │   ├── useTheme.ts             # 主題同步 hook (Telegram dark/light)
    │   └── useStream.ts            # 即時串流 hook
    └── stores/
        ├── app-store.ts            # 全域狀態 (zustand)
        └── session-store.ts        # Session 狀態
```

#### src/main.tsx

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { AppRoot } from "@telegram-apps/telegram-ui";
import "@telegram-apps/telegram-ui/dist/styles.css";
import App from "./App";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
tg?.requestFullscreen?.();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRoot>
      <App />
    </AppRoot>
  </React.StrictMode>,
);
```

#### src/App.tsx

```tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useTelegram } from "./hooks/useTelegram";
import NavBar from "./components/NavBar";
import Dashboard from "./pages/Dashboard";
import AgentControl from "./pages/AgentControl";
import CodeWorkspace from "./pages/CodeWorkspace";
import WorkflowEditor from "./pages/WorkflowEditor";
import CronManager from "./pages/CronManager";
import ModelSelector from "./pages/ModelSelector";
import DevOpsPanel from "./pages/DevOpsPanel";
import TaskBoard from "./pages/TaskBoard";
import Settings from "./pages/Settings";

export default function App() {
  const { colorScheme } = useTelegram();

  return (
    <BrowserRouter basename="/superclaw">
      <div data-theme={colorScheme}>
        <NavBar />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agents" element={<AgentControl />} />
          <Route path="/code" element={<CodeWorkspace />} />
          <Route path="/workflow" element={<WorkflowEditor />} />
          <Route path="/cron" element={<CronManager />} />
          <Route path="/model" element={<ModelSelector />} />
          <Route path="/devops" element={<DevOpsPanel />} />
          <Route path="/tasks" element={<TaskBoard />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
```

#### src/api/gateway-ws.ts — Gateway WebSocket RPC Client

```typescript
type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventHandler = (data: unknown) => void;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingCall>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${this.url}?token=${this.token}`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onclose = () => this.scheduleReconnect();
      this.ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data));
    });
  }

  private handleMessage(msg: any) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)!;
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
    } else if (msg.method) {
      const handlers = this.eventHandlers.get(msg.method);
      handlers?.forEach((h) => h(msg.params));
    }
  }

  private scheduleReconnect() {
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch(() => this.scheduleReconnect());
      }, 3000);
    }
  }

  async call<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as any, reject, timer });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  on(event: string, handler: EventHandler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return () => this.eventHandlers.get(event)?.delete(handler);
  }

  // ── 封裝常用 API ──

  agents = {
    list: () => this.call<any[]>("agents.list"),
    run: (agentId: string, message: string, sessionKey?: string) =>
      this.call("agent", { agentId, message, sessionKey, idempotencyKey: crypto.randomUUID() }),
    wait: (runId: string) => this.call("agent.wait", { runId }),
    filesGet: (agentId: string, path: string) =>
      this.call("agents.files.get", { agentId, path }),
  };

  sessions = {
    list: (filters?: any) => this.call<any[]>("sessions.list", filters),
    describe: (sessionKey: string) => this.call("sessions.describe", { sessionKey }),
    send: (sessionKey: string, message: string) =>
      this.call("sessions.send", { sessionKey, message, idempotencyKey: crypto.randomUUID() }),
    reset: (sessionKey: string) => this.call("sessions.reset", { sessionKey }),
    compact: (sessionKey: string) => this.call("sessions.compact", { sessionKey }),
    patch: (sessionKey: string, patch: any) =>
      this.call("sessions.patch", { sessionKey, ...patch }),
    delete: (sessionKey: string) => this.call("sessions.delete", { sessionKey }),
    preview: (sessionKey: string) => this.call("sessions.preview", { sessionKey }),
    history: (sessionKey: string, limit?: number) =>
      this.call("chat.history", { sessionKey, limit }),
    subscribe: (sessionKey: string) =>
      this.call("sessions.messages.subscribe", { sessionKey }),
    unsubscribe: (sessionKey: string) =>
      this.call("sessions.messages.unsubscribe", { sessionKey }),
  };

  chat = {
    send: (sessionKey: string, message: string) =>
      this.call("chat.send", { sessionKey, message, idempotencyKey: crypto.randomUUID() }),
    abort: (sessionKey: string) => this.call("chat.abort", { sessionKey }),
  };

  cron = {
    list: () => this.call<any[]>("cron.list"),
    status: (id: string) => this.call("cron.status", { id }),
    add: (job: any) => this.call("cron.add", job),
    update: (id: string, patch: any) => this.call("cron.update", { id, ...patch }),
    remove: (id: string) => this.call("cron.remove", { id }),
    run: (id: string) => this.call("cron.run", { id }),
    runs: (id: string) => this.call("cron.runs", { id }),
  };

  models = {
    list: (view?: string) => this.call<any[]>("models.list", view ? { view } : undefined),
    authStatus: () => this.call("models.authStatus"),
  };

  channels = {
    status: () => this.call("channels.status"),
    start: (channel: string) => this.call("channels.start", { channel }),
    stop: (channel: string) => this.call("channels.stop", { channel }),
  };

  config = {
    get: (path: string) => this.call("config.get", { path }),
    set: (path: string, value: unknown) => this.call("config.set", { path, value }),
    patch: (patch: any) => this.call("config.patch", patch),
  };

  tools = {
    catalog: () => this.call<any[]>("tools.catalog"),
    invoke: (name: string, params: unknown) =>
      this.call("tools.invoke", { name, params }, 120000),
  };

  skills = {
    status: () => this.call("skills.status"),
    search: (query: string) => this.call("skills.search", { query }),
    install: (id: string) => this.call("skills.install", { id }),
  };

  system = {
    health: () => this.call("health"),
    status: () => this.call("status"),
    diagnostics: () => this.call("diagnostics.stability"),
    usage: () => this.call("usage.status"),
    cost: () => this.call("usage.cost"),
  };

  approvals = {
    list: () => this.call("exec.approval.list"),
    approve: (id: string) => this.call("exec.approval.approve", { id }),
    deny: (id: string) => this.call("exec.approval.deny", { id }),
  };

  gateway = {
    identity: () => this.call("gateway.identity.get"),
    restart: () => this.call("gateway.restart.request"),
  };

  dispose() {
    this.ws?.close();
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error("disposed"));
    });
    this.pending.clear();
  }
}
```

#### src/api/telegram-bridge.ts — Telegram WebApp API 封裝

```typescript
export interface TelegramBridge {
  initData: string;
  user: { id: number; first_name: string; username?: string };
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  isFullscreen: boolean;
  platform: string;

  expand(): void;
  requestFullscreen(): void;
  exitFullscreen(): void;
  addToHomeScreen(): void;
  close(): void;

  showPopup(params: PopupParams): Promise<string>;
  showAlert(message: string): Promise<void>;
  showConfirm(message: string): Promise<boolean>;

  scanQR(text?: string): Promise<string>;
  haptic(type: "success" | "error" | "warning" | "light" | "medium" | "heavy"): void;

  biometric: {
    isAvailable: boolean;
    type: "finger" | "face" | null;
    requestAccess(reason: string): Promise<boolean>;
    authenticate(reason: string): Promise<boolean>;
  };

  cloudStorage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };

  openInvoice(url: string): Promise<"paid" | "cancelled" | "failed" | "pending">;
  shareToStory(mediaUrl: string, params?: { text?: string }): void;
  downloadFile(url: string, filename: string): void;
}

type PopupParams = {
  title?: string;
  message: string;
  buttons?: Array<{ id: string; type: "default" | "ok" | "close" | "cancel" | "destructive"; text: string }>;
};

export function createTelegramBridge(): TelegramBridge {
  const tg = (window as any).Telegram?.WebApp;
  if (!tg) throw new Error("Not running inside Telegram");

  return {
    initData: tg.initData,
    user: tg.initDataUnsafe?.user ?? { id: 0, first_name: "Unknown" },
    colorScheme: tg.colorScheme,
    themeParams: tg.themeParams ?? {},
    isFullscreen: tg.isFullscreen ?? false,
    platform: tg.platform ?? "unknown",

    expand: () => tg.expand(),
    requestFullscreen: () => tg.requestFullscreen?.(),
    exitFullscreen: () => tg.exitFullscreen?.(),
    addToHomeScreen: () => tg.addToHomeScreen?.(),
    close: () => tg.close(),

    showPopup: (params) =>
      new Promise((resolve) => tg.showPopup(params, (id: string) => resolve(id))),
    showAlert: (message) =>
      new Promise((resolve) => tg.showAlert(message, () => resolve())),
    showConfirm: (message) =>
      new Promise((resolve) => tg.showConfirm(message, (ok: boolean) => resolve(ok))),

    scanQR: (text) =>
      new Promise((resolve) => {
        tg.showScanQrPopup({ text: text ?? "Scan QR" }, (data: string) => {
          tg.closeScanQrPopup();
          resolve(data);
          return true;
        });
      }),

    haptic: (type) => {
      const hf = tg.HapticFeedback;
      if (["success", "error", "warning"].includes(type)) {
        hf?.notificationOccurred(type);
      } else {
        hf?.impactOccurred(type);
      }
    },

    biometric: {
      get isAvailable() { return tg.BiometricManager?.isBiometricAvailable ?? false; },
      get type() { return tg.BiometricManager?.biometricType ?? null; },
      requestAccess: (reason) =>
        new Promise((resolve) => {
          tg.BiometricManager.init(() => {
            tg.BiometricManager.requestAccess({ reason }, (ok: boolean) => resolve(ok));
          });
        }),
      authenticate: (reason) =>
        new Promise((resolve) => {
          tg.BiometricManager.authenticate({ reason }, (ok: boolean) => resolve(ok));
          }),
    },

    cloudStorage: {
      get: (key) =>
        new Promise((resolve) => tg.CloudStorage.getItem(key, (_e: any, v: string) => resolve(v || null))),
      set: (key, value) =>
        new Promise((resolve) => tg.CloudStorage.setItem(key, value, () => resolve())),
      remove: (key) =>
        new Promise((resolve) => tg.CloudStorage.removeItem(key, () => resolve())),
      keys: () =>
        new Promise((resolve) => tg.CloudStorage.getKeys((_e: any, keys: string[]) => resolve(keys))),
    },

    openInvoice: (url) =>
      new Promise((resolve) => tg.openInvoice(url, (status: any) => resolve(status))),
    shareToStory: (mediaUrl, params) => tg.shareToStory?.(mediaUrl, params),
    downloadFile: (url, filename) => tg.downloadFile?.({ url, file_name: filename }),
  };
}
```

#### src/hooks/useGateway.ts

```typescript
import { useEffect, useRef, useState } from "react";
import { GatewayClient } from "../api/gateway-ws";
import { useTelegram } from "./useTelegram";

let sharedClient: GatewayClient | null = null;

export function useGateway() {
  const { initData } = useTelegram();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!sharedClient) {
      const wsUrl = import.meta.env.VITE_GATEWAY_WS ?? "ws://localhost:18789";
      const token = import.meta.env.VITE_GATEWAY_TOKEN ?? "";
      sharedClient = new GatewayClient(wsUrl, token);
      sharedClient.connect().then(() => setConnected(true));
    } else {
      setConnected(true);
    }
  }, []);

  return { gw: sharedClient!, connected };
}
```

#### src/hooks/useTelegram.ts

```typescript
import { useMemo } from "react";
import { createTelegramBridge, type TelegramBridge } from "../api/telegram-bridge";

let bridge: TelegramBridge | null = null;

export function useTelegram(): TelegramBridge {
  return useMemo(() => {
    if (!bridge) bridge = createTelegramBridge();
    return bridge;
  }, []);
}
```

#### src/hooks/useTheme.ts

```typescript
import { useEffect, useState } from "react";

export function useTheme() {
  const tg = (window as any).Telegram?.WebApp;
  const [scheme, setScheme] = useState<"light" | "dark">(tg?.colorScheme ?? "dark");

  useEffect(() => {
    const handler = () => setScheme(tg?.colorScheme ?? "dark");
    tg?.onEvent("themeChanged", handler);
    return () => tg?.offEvent("themeChanged", handler);
  }, []);

  return { scheme, themeParams: tg?.themeParams ?? {} };
}
```

#### src/hooks/useStream.ts

```typescript
import { useEffect, useRef, useState } from "react";
import { useGateway } from "./useGateway";

export function useStream(sessionKey: string | null) {
  const { gw, connected } = useGateway();
  const [messages, setMessages] = useState<any[]>([]);
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    if (!sessionKey || !connected) return;

    gw.sessions.subscribe(sessionKey);
    const unsub = gw.on("sessions.messages.event", (data: any) => {
      if (data.sessionKey !== sessionKey) return;
      setStreaming(true);
      setMessages((prev) => [...prev, data.message]);
    });

    const unsubDone = gw.on("sessions.messages.done", (data: any) => {
      if (data.sessionKey !== sessionKey) return;
      setStreaming(false);
    });

    return () => {
      unsub();
      unsubDone();
      gw.sessions.unsubscribe(sessionKey);
    };
  }, [sessionKey, connected]);

  return { messages, streaming, clear: () => setMessages([]) };
}
```

#### src/stores/app-store.ts

```typescript
import { create } from "zustand";

interface AppState {
  activeAgent: string;
  activeSession: string | null;
  activeWorkflow: string | null;
  notifications: Notification[];

  setActiveAgent: (id: string) => void;
  setActiveSession: (key: string | null) => void;
  setActiveWorkflow: (id: string | null) => void;
  addNotification: (n: Notification) => void;
  clearNotifications: () => void;
}

interface Notification {
  id: string;
  type: "info" | "success" | "warning" | "error";
  title: string;
  body?: string;
  timestamp: number;
}

export const useAppStore = create<AppState>((set) => ({
  activeAgent: "main",
  activeSession: null,
  activeWorkflow: null,
  notifications: [],

  setActiveAgent: (id) => set({ activeAgent: id }),
  setActiveSession: (key) => set({ activeSession: key }),
  setActiveWorkflow: (id) => set({ activeWorkflow: id }),
  addNotification: (n) =>
    set((s) => ({ notifications: [n, ...s.notifications].slice(0, 50) })),
  clearNotifications: () => set({ notifications: [] }),
}));
```

---

### 模組 2: 多 Agent 協作系統

#### Forum Topic 架構

每個 Telegram Forum Topic 映射一個 OpenClaw session：

```
Telegram Supergroup (Forum Mode)
├── 📌 General          → sessionKey: "superclaw-general"   → 狀態通知 + 主控
├── 🧠 Claude           → sessionKey: "superclaw-claude"    → Claude CLI agent
├── 💻 Codex            → sessionKey: "superclaw-codex"     → Codex CLI agent
├── 🔍 Review           → sessionKey: "superclaw-review"    → Code review
├── 🚀 Deploy           → sessionKey: "superclaw-deploy"    → CI/CD 操作
├── 📊 Reports          → sessionKey: "superclaw-reports"   → 定時報告
└── 🗂️ project-<name>   → sessionKey: "superclaw-proj-xxx" → 專案工作區
```

#### extensions/automation/src/multi-agent/topic-router.ts

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const TOPIC_AGENT_MAP: Record<string, string> = {
  claude: "main",
  codex: "coder",
  review: "main",
  deploy: "main",
};

export function resolveAgentFromTopic(topicName: string): string {
  const normalized = topicName.toLowerCase().replace(/[^a-z]/g, "");
  for (const [key, agentId] of Object.entries(TOPIC_AGENT_MAP)) {
    if (normalized.includes(key)) return agentId;
  }
  return "main";
}

export function buildSessionKeyFromTopic(topicId: number | string): string {
  return `superclaw-topic-${topicId}`;
}

export function resolveDeliveryTopic(taskType: string): string {
  switch (taskType) {
    case "coding": return "codex";
    case "review": return "review";
    case "deploy": return "deploy";
    case "report": return "reports";
    default: return "general";
  }
}
```

#### extensions/automation/src/multi-agent/agent-spawner.ts

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export interface SpawnedAgent {
  id: string;
  sessionKey: string;
  provider: string;
  status: "running" | "idle" | "error";
  startedAt: number;
}

const activeAgents = new Map<string, SpawnedAgent>();

export async function spawnAgent(
  api: OpenClawPluginApi,
  opts: { id: string; provider: string; prompt: string; extraSystemPrompt?: string },
): Promise<SpawnedAgent> {
  const sessionKey = `superclaw-agent-${opts.id}-${Date.now()}`;

  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    message: opts.prompt,
    provider: opts.provider,
    extraSystemPrompt: opts.extraSystemPrompt,
  });

  const agent: SpawnedAgent = {
    id: opts.id,
    sessionKey,
    provider: opts.provider,
    status: "running",
    startedAt: Date.now(),
  };

  activeAgents.set(opts.id, agent);

  api.runtime.subagent.waitForRun({ runId, timeoutMs: 300_000 }).then((result) => {
    const a = activeAgents.get(opts.id);
    if (a) a.status = result.status === "ok" ? "idle" : "error";
  });

  return agent;
}

export function listActiveAgents(): SpawnedAgent[] {
  return Array.from(activeAgents.values());
}

export async function getAgentOutput(
  api: OpenClawPluginApi,
  agentId: string,
): Promise<string> {
  const agent = activeAgents.get(agentId);
  if (!agent) return "(agent not found)";
  const { messages } = await api.runtime.subagent.getSessionMessages({
    sessionKey: agent.sessionKey,
    limit: 20,
  });
  return messages
    .map((m: any) => m?.text ?? m?.content ?? JSON.stringify(m))
    .join("\n\n");
}

export async function terminateAgent(
  api: OpenClawPluginApi,
  agentId: string,
): Promise<void> {
  const agent = activeAgents.get(agentId);
  if (agent) {
    await api.runtime.subagent.deleteSession({ sessionKey: agent.sessionKey });
    activeAgents.delete(agentId);
  }
}
```

---

### 模組 3: 即時串流輸出

#### extensions/automation/src/telegram-ui/progress-updater.ts

```typescript
export interface ProgressStep {
  label: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
}

const STATUS_EMOJI: Record<string, string> = {
  pending: "⏳",
  running: "🔄",
  done: "✅",
  error: "❌",
};

const REACTION_MAP: Record<string, string> = {
  thinking: "🤔",
  coding: "👨‍💻",
  testing: "🔬",
  reviewing: "🔍",
  done: "🎉",
  error: "😱",
};

export function formatProgressMessage(
  title: string,
  steps: ProgressStep[],
  elapsed?: number,
): string {
  const lines = [`<b>${title}</b>\n`];
  for (const step of steps) {
    const emoji = STATUS_EMOJI[step.status];
    const detail = step.detail ? ` — <i>${step.detail}</i>` : "";
    lines.push(`${emoji} ${step.label}${detail}`);
  }
  if (elapsed !== undefined) {
    lines.push(`\n⏱ ${(elapsed / 1000).toFixed(1)}s`);
  }
  return lines.join("\n");
}

export function formatStreamChunk(buffer: string, maxLen = 4000): string {
  if (buffer.length <= maxLen) return `<pre><code>${escapeHtml(buffer)}</code></pre>`;
  const truncated = buffer.slice(-maxLen);
  return `<pre><code>...\n${escapeHtml(truncated)}</code></pre>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

---

### 模組 4: 多層安全系統

#### extensions/automation/src/security/risk-assessor.ts

```typescript
export type SecurityLevel = "read" | "write" | "dangerous" | "critical";

const CRITICAL_PATTERNS = [
  /deploy.*prod/i, /production/i, /rm\s+-rf/i, /drop\s+table/i,
  /force.push/i, /delete.*branch/i, /部署.*正式/i, /刪除.*資料庫/i,
];

const DANGEROUS_PATTERNS = [
  /git\s+push/i, /deploy/i, /delete/i, /rollback/i,
  /npm\s+publish/i, /推送/i, /部署/i, /刪除/i, /回滾/i,
];

const WRITE_PATTERNS = [
  /commit/i, /merge/i, /install/i, /update/i, /modify/i, /edit/i,
  /refactor/i, /create/i, /build/i, /提交/i, /合併/i, /修改/i,
  /重構/i, /建立/i, /安裝/i,
];

export function assessRisk(message: string): SecurityLevel {
  if (CRITICAL_PATTERNS.some((p) => p.test(message))) return "critical";
  if (DANGEROUS_PATTERNS.some((p) => p.test(message))) return "dangerous";
  if (WRITE_PATTERNS.some((p) => p.test(message))) return "write";
  return "read";
}

export function requiresConfirmation(level: SecurityLevel): boolean {
  return level === "dangerous" || level === "critical";
}

export function requiresBiometric(level: SecurityLevel): boolean {
  return level === "critical";
}
```

#### extensions/automation/src/security/permission-manager.ts

```typescript
export interface PermissionConfig {
  ownerTelegramIds: number[];
  allowedTelegramIds: number[];
  rateLimits: { maxRequestsPerMinute: number; maxTokensPerDay: number };
  autoApprove: string[];
  requireConfirm: string[];
  deny: string[];
}

const DEFAULT_CONFIG: PermissionConfig = {
  ownerTelegramIds: [],
  allowedTelegramIds: [],
  rateLimits: { maxRequestsPerMinute: 30, maxTokensPerDay: 500_000 },
  autoApprove: ["read:*", "analyze:*"],
  requireConfirm: ["git:push", "deploy:*", "delete:*"],
  deny: ["system:rm-rf", "deploy:production-auto"],
};

const requestCounts = new Map<number, { count: number; resetAt: number }>();

export function isAllowedUser(userId: number, config = DEFAULT_CONFIG): boolean {
  if (config.ownerTelegramIds.includes(userId)) return true;
  if (config.allowedTelegramIds.length === 0) return true;
  return config.allowedTelegramIds.includes(userId);
}

export function checkRateLimit(userId: number, config = DEFAULT_CONFIG): boolean {
  const now = Date.now();
  let entry = requestCounts.get(userId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    requestCounts.set(userId, entry);
  }
  entry.count++;
  return entry.count <= config.rateLimits.maxRequestsPerMinute;
}
```

---

### 模組 5: 多模態輸入

在 system prompt 中指示 Claude 如何處理不同輸入類型：

```typescript
// 追加到 AUTOMATION_SYSTEM_PROMPT
export const MULTIMODAL_PROMPT = `
## Multi-Modal Input Handling

- **Voice messages**: Automatically transcribed to text by OpenClaw STT. Process the transcribed text normally.
- **Photos/Images**: Analyze using vision capabilities. If it's a screenshot of code/error, extract and act on it.
- **Documents/Files**: Read content and process. For code files, offer to review/refactor. For logs, analyze errors.
- **QR codes**: The scanned data will be provided as text. Parse URLs, tokens, or commands from it.
- **Forwarded messages**: Treat as context. The user may want you to act on the forwarded content.
`;
```

---

### 模組 6: DevOps 整合

#### extensions/automation/src/devops/github-webhook.ts

```typescript
import crypto from "node:crypto";

export type GitHubEvent = {
  type: string;
  action?: string;
  payload: any;
};

export function verifyGitHubSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function formatGitHubEvent(event: GitHubEvent): {
  text: string;
  topic: string;
  buttons?: Array<{ label: string; value: string }>;
} {
  switch (event.type) {
    case "push": {
      const { ref, commits, pusher } = event.payload;
      const branch = ref.replace("refs/heads/", "");
      return {
        text: `🔄 <b>Push</b> to <code>${branch}</code> by ${pusher.name}\n${commits.length} commit(s)`,
        topic: "deploy",
      };
    }

    case "pull_request": {
      const pr = event.payload.pull_request;
      const action = event.action;
      const emoji = action === "opened" ? "🆕" : action === "closed" ? (pr.merged ? "🟣" : "🔴") : "🔵";
      return {
        text: `${emoji} <b>PR #${pr.number}</b> ${action}: ${pr.title}`,
        topic: "review",
        buttons:
          action === "opened"
            ? [
                { label: "🔍 Auto Review", value: `devops:review:${pr.number}` },
                { label: "📋 View", value: `devops:view-pr:${pr.number}` },
              ]
            : undefined,
      };
    }

    case "check_run":
    case "check_suite": {
      const check = event.payload.check_run ?? event.payload.check_suite;
      const conclusion = check.conclusion;
      const emoji = conclusion === "success" ? "✅" : conclusion === "failure" ? "❌" : "⏳";
      return {
        text: `${emoji} <b>CI</b> ${check.name ?? "check"}: ${conclusion ?? "in_progress"}`,
        topic: "deploy",
        buttons:
          conclusion === "failure"
            ? [
                { label: "🔁 Retry", value: `devops:retry:${check.id}` },
                { label: "🔍 Analyze", value: `devops:analyze-ci:${check.id}` },
              ]
            : undefined,
      };
    }

    case "issues": {
      const issue = event.payload.issue;
      return {
        text: `📋 <b>Issue #${issue.number}</b> ${event.action}: ${issue.title}`,
        topic: "general",
      };
    }

    default:
      return {
        text: `📡 GitHub: ${event.type} ${event.action ?? ""}`,
        topic: "general",
      };
  }
}
```

#### extensions/automation/src/devops/ci-monitor.ts

```typescript
export interface CIStatus {
  provider: "github-actions" | "gitlab-ci" | "other";
  repo: string;
  branch: string;
  status: "success" | "failure" | "pending" | "running";
  url: string;
  updatedAt: number;
}

export function formatCIStatusBoard(statuses: CIStatus[]): string {
  const lines = ["<b>🏗️ CI/CD Status Board</b>\n"];
  for (const s of statuses) {
    const emoji =
      s.status === "success" ? "✅" :
      s.status === "failure" ? "❌" :
      s.status === "running" ? "🔄" : "⏳";
    const age = Math.round((Date.now() - s.updatedAt) / 60000);
    lines.push(`${emoji} <code>${s.repo}</code> / ${s.branch} — ${age}m ago`);
  }
  return lines.join("\n");
}
```

---

### 模組 7: Workflow 視覺引擎

#### 資料結構（供 Mini App WorkflowEditor 使用）

```typescript
// extensions/automation/src/tools/workflow-types.ts

export type WorkflowNodeType =
  | "claude"    // Claude CLI 執行
  | "codex"     // Codex CLI 執行
  | "gate"      // 確認閘門（等待用戶批准）
  | "notify"    // 傳送通知
  | "webhook"   // 呼叫外部 API
  | "condition" // 條件分支
  | "parallel"  // 並行執行
  | "delay";    // 延遲

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  label: string;
  position: { x: number; y: number }; // Mini App 中的畫布座標
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
  label?: string;          // 條件分支的標籤 (true/false)
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
  nodeResults: Record<string, {
    status: "pending" | "running" | "done" | "error" | "skipped";
    output?: string;
    error?: string;
    startedAt?: number;
    completedAt?: number;
  }>;
};

// 預設模板
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
      { id: "notify", type: "notify", label: "通知", position: { x: 600, y: 100 }, config: { notifyChannel: "review" } },
    ],
    edges: [
      { from: "fetch", to: "security" },
      { from: "fetch", to: "perf" },
      { from: "fetch", to: "arch" },
      { from: "security", to: "report" },
      { from: "perf", to: "report" },
      { from: "arch", to: "report" },
      { from: "report", to: "notify" },
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
      { id: "report", type: "notify", label: "推送報告", position: { x: 600, y: 0 }, config: { notifyChannel: "reports" } },
    ],
    edges: [
      { from: "list-prs", to: "check-ci" },
      { from: "check-ci", to: "check-stale" },
      { from: "check-stale", to: "report" },
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
      { id: "refactor", type: "codex", label: "執行重構", position: { x: 200, y: 0 }, config: { prompt: "執行重構" } },
      { id: "test", type: "codex", label: "跑測試", position: { x: 400, y: 0 }, config: { prompt: "執行測試" } },
      { id: "confirm", type: "gate", label: "確認提交", position: { x: 600, y: 0 }, config: { requireConfirm: true } },
      { id: "commit", type: "codex", label: "提交", position: { x: 800, y: 0 }, config: { prompt: "git commit" } },
    ],
    edges: [
      { from: "analyze", to: "refactor" },
      { from: "refactor", to: "test" },
      { from: "test", to: "confirm" },
      { from: "confirm", to: "commit" },
    ],
    trigger: { type: "manual" },
    createdAt: 0,
    updatedAt: 0,
  },
];
```

---

### 模組 8: 智能排程

已在 config.example.json 中定義 cron jobs，Cron Manager Mini App 頁面使用 Gateway RPC `cron.*` 方法管理。

支援三種觸發方式：
- **Cron**：`cron.add({ schedule: { kind: "cron", expr: "0 9 * * *" } })`
- **Webhook**：OpenClaw Gateway HTTP endpoint 接收外部觸發
- **Event**：GitHub webhook → 解析事件 → 觸發對應 workflow

---

### 模組 9: Telegram Stars 付費

```typescript
// extensions/automation/src/telegram-ui/payments.ts

export async function createSubscriptionInvoice(botToken: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "SuperClaw Pro",
      description: "解鎖全部功能：多 Agent 協作、Workflow 視覺編輯、DevOps 整合、優先執行",
      payload: "superclaw-pro-monthly",
      currency: "XTR",
      prices: [{ label: "Monthly Pro", amount: 100 }],
      subscription_period: 2592000,
    }),
  });
  const data = await res.json();
  return data.result;
}

export type ProFeatures = {
  multiAgent: boolean;
  workflowEditor: boolean;
  devOpsIntegration: boolean;
  priorityExecution: boolean;
  customWorkflows: boolean;
  unlimitedCron: boolean;
};

export function getProFeatures(isPro: boolean): ProFeatures {
  if (isPro) {
    return {
      multiAgent: true,
      workflowEditor: true,
      devOpsIntegration: true,
      priorityExecution: true,
      customWorkflows: true,
      unlimitedCron: true,
    };
  }
  return {
    multiAgent: false,
    workflowEditor: false,
    devOpsIntegration: false,
    priorityExecution: false,
    customWorkflows: false,
    unlimitedCron: false,
  };
}
```

---

### 模組 10: 分享與協作

在 Mini App 中提供分享功能：

```typescript
// webapp/src/components/ShareButton.tsx
export function ShareButton({ content, mediaUrl }: { content: string; mediaUrl?: string }) {
  const tg = useTelegram();
  
  const shareToStory = () => {
    if (mediaUrl) {
      tg.shareToStory(mediaUrl, {
        text: content,
      });
    }
  };
  
  // 透過 bot API 轉發到指定群組
  const forwardToGroup = async (groupId: string) => {
    const { gw } = useGateway();
    await gw.call("send", {
      channel: "telegram",
      to: groupId,
      message: content,
    });
  };
}
```

---

## 4. 斜線命令完整表

| 命令 | 說明 | 安全等級 | 實作方式 |
|------|------|----------|----------|
| `/start` | 開啟主控台 + Mini App 入口按鈕 | read | 回覆歡迎訊息 + web_app button |
| `/menu` | 顯示功能面板 (inline keyboard) | read | InteractiveReply buttons |
| `/dashboard` | 開啟 Mini App 全螢幕儀表板 | read | web_app_info button |
| `/code <指令>` | Codex 執行程式碼任務 | write | automation_codex_execute tool |
| `/ask <問題>` | Claude 回答問題 | read | 直接 agent dispatch |
| `/review <PR#>` | 自動 code review | read | code-review workflow |
| `/workflow <name> [input]` | 執行工作流 | write | automation_workflow tool |
| `/cron` | 排程管理面板 | read | cron panel buttons |
| `/model [name]` | 切換/查看 AI 模型 | write | sessions.patch RPC |
| `/status` | 系統狀態總覽 | read | automation_status tool |
| `/agents` | Agent 管理面板 | read | agent panel buttons |
| `/deploy <env>` | 部署到指定環境 | critical | biometric + confirm gate |
| `/rollback` | 回滾上次部署 | dangerous | confirm gate |
| `/approve <id>` | 批准待確認操作 | write | approval callback |
| `/deny <id>` | 拒絕待確認操作 | write | approval callback |
| `/history [n]` | 對話歷史 | read | chat.history RPC |
| `/reset` | 重置當前對話 | write | sessions.reset RPC |
| `/scan` | 手動觸發程式碼掃描 | read | daily-scan workflow |
| `/voice` | 切換語音模式 | read | talk.mode RPC |
| `/settings` | 設定面板 | read | config buttons |

---

## 5. Telegram Bot 端 UX 設計原則

### 人性化即刻操作設計

基於業界最佳實踐（Telegram Bot API 文件、n8n、Home Assistant Bot、10+ 開源專案），
SuperClaw 的 Telegram UI 遵循以下原則：

1. **Edit-don't-resend** — 永遠編輯同一條訊息切換面板，不發新訊息製造雜訊
2. **Breadcrumb 導航** — 每個面板頂部顯示 `首頁 › 排程 › daily-scan`，用戶永遠知道自己在哪
3. **最近操作** — 主選單動態顯示用戶最近 3 個操作，一鍵重複
4. **情境感知問候** — 根據時間 + 當前模式 顯示個性化問候（早安/寫碼中/工作流執行中）
5. **即刻回饋** — 按鈕 → answerCallbackQuery(毫秒級) → editMessage(結果)，零延遲感
6. **扁平層級** — 最多 2-3 層，按鈕每行最多 3 個，底部永遠有「← 首頁」
7. **操作後果呈現** — 危險操作有確認面板，成功/失敗有明確 emoji 狀態
8. **Retry 按鈕** — 任何失敗畫面自動附帶「🔄 重試」按鈕
9. **Callback data 壓縮** — 統一 `sc:` 命名空間，值 < 20 bytes（Telegram 限制 64 bytes）
10. **系統狀態快照** — 主選單顯示 agent 狀態/執行中工作流/待批准數量

### Callback Data 命名規範

```
sc:{panel}:{action}:{param}

面板代碼:
  home   = 主選單
  chat   = 對話模式
  code   = 寫碼模式
  wf     = 工作流（列表）
  wf:run = 工作流（執行）
  cron   = 排程（列表）
  cr:tg  = 排程（開關）
  cr:run = 排程（執行）
  model  = 模型（列表）
  md:sw  = 模型（切換）
  stat   = Agent 狀態
  ag:sw  = Agent 切換
  ag:rst = Agent 重置
  devops = DevOps 面板
  dv:ref = CI 刷新
  dv:prs = PR 列表
  dv:rv  = PR Review
  dash   = 開啟儀表板
  appr:y = 批准
  appr:n = 拒絕
```

### 整合方式

使用 OpenClaw 的 `registerPluginInteractiveHandler()` API，以 `"sc"` 為命名空間：

```typescript
api.registerInteractiveHandler({
  channel: "telegram",
  namespace: "sc",
  handler: async (ctx) => {
    // ctx.callback.payload = "home", "wf:run:auto-pr", etc.
    // ctx.respond.editMessage({ text, buttons }) — 編輯當前訊息
    // ctx.respond.reply({ text, buttons }) — 發送新訊息
  },
});
```

### 互動流程範例

```
用戶打開 Telegram → /menu

Bot 回覆:
  ☀️ 早安
  SuperClaw 控制台
  🤖 Claude 運行中 · ⏰ 2 排程

  [🕐 重構 auth] [🕐 Review #42] [🕐 排程]    ← 最近操作
  [💬 對話]  [💻 寫碼]  [🔄 Workflow]
  [⏰ 排程]  [🧠 Model] [📊 狀態]
  [🚀 DevOps] [🖥️ 儀表板]

用戶按 [💻 寫碼] →
  (同一條訊息即時更新為)

  💻 程式碼模式
  輸入指令，Codex 會執行：
  例：重構 auth module 改用 JWT
  例：把所有 console.log 換成 logger

用戶輸入: 重構 auth module →
  (新訊息)
  🔄 啟動 Codex...
  (同一訊息持續更新)
  ✅ Step 1/3: 分析目標 (完成)
  🔄 Step 2/3: 執行重構 (進行中...)
  ⏳ Step 3/3: 跑測試
  ⏱ 12.3s

  (完成後)
  🎉 重構完成！修改 5 個檔案
  [📝 查看 diff] [✅ 提交] [↩️ 撤銷] [← 首頁]
```

#### Callback Router 整合

已從舊的靜態路由改為使用 OpenClaw `registerPluginInteractiveHandler` API。
完整實作見 `extensions/automation/src/telegram-ui/callback-router.ts`。

關鍵特性：
- 使用 `"sc"` 命名空間，所有 callback_data 以 `sc:` 開頭
- 統一錯誤處理 + 自動「🔄 重試」按鈕
- 每次操作記錄到 `user-state.ts` 的 `recentActions`
- 所有面板切換使用 `respond.editMessage` (edit-don't-resend)
- Gateway RPC stub 函式預留，Codex 實作時填入真實 API 呼叫

---

## 6. 完整檔案結構

```
extensions/automation/
├── index.ts                              # Plugin 入口
├── README.md                             # 文件
├── config.example.json                   # 配置範例
├── src/
│   ├── register.ts                       # Plugin 註冊 (tools + hooks + UI)
│   ├── system-prompt.ts                  # Claude CLI 系統提示詞
│   ├── hooks/
│   │   └── prompt-build.ts              # before_prompt_build hook
│   ├── tools/
│   │   ├── intent-router.ts             # 意圖分類 + provider 路由
│   │   ├── codex-dispatch.ts            # Codex CLI 子任務調度
│   │   ├── workflow.ts                  # Workflow 執行引擎
│   │   ├── workflow-types.ts            # Workflow 資料型別 + 模板
│   │   ├── confirm-gate.ts             # 確認閘門 (inline buttons)
│   │   └── status.ts                   # 系統狀態查詢
│   ├── telegram-ui/
│   │   ├── dashboard.ts                # 🔑 核心：活的戰情面板 (狀態感知 + 動態按鈕)
│   │   ├── agent-state.ts              # 🔑 系統狀態機 (phase/task/attention/stats)
│   │   ├── task-thread.ts              # 🔑 任務訊息串 (進度/完成/錯誤/等待輸入)
│   │   ├── notification.ts             # 🔑 三級通知系統 (silent/quiet/loud)
│   │   ├── suggestions.ts              # 🔑 智能下一步建議 (根據上次任務+系統狀態)
│   │   ├── callback-router.ts          # registerPluginInteractiveHandler 統一路由
│   │   ├── more-panel.ts               # 「更多」選單 (次要功能入口)
│   │   ├── main-menu.ts                # /start 歡迎訊息
│   │   ├── user-state.ts               # 用戶狀態追蹤 (模式/最近操作/偏好)
│   │   ├── agent-panel.ts              # Agent 管理面板 (含重置確認)
│   │   ├── cron-panel.ts               # Cron 排程管理 (含執行結果)
│   │   ├── model-panel.ts              # Model 切換面板 (含切換結果)
│   │   ├── workflow-panel.ts           # Workflow 面板 (含進度+完成)
│   │   ├── devops-panel.ts             # DevOps 面板 (含部署確認)
│   │   ├── progress-updater.ts         # 即時進度更新器 + reaction emoji
│   │   ├── payments.ts                 # Telegram Stars 付費
│   │   └── types.ts                    # 共用 UI 型別
│   ├── security/
│   │   ├── risk-assessor.ts            # 操作風險評估
│   │   └── permission-manager.ts       # 權限 + Rate Limiting
│   ├── devops/
│   │   ├── github-webhook.ts           # GitHub Webhook 處理
│   │   └── ci-monitor.ts              # CI/CD 狀態監控
│   └── multi-agent/
│       ├── topic-router.ts             # Forum Topic → Agent 路由
│       └── agent-spawner.ts            # 動態 Agent 生成/管理
└── webapp/
    ├── index.html                       # Mini App HTML
    ├── vite.config.ts                   # Vite 配置
    ├── tsconfig.json                    # TypeScript 配置
    ├── package.json                     # 依賴
    └── src/
        ├── main.tsx                     # React 入口
        ├── App.tsx                      # 根元件 + Router
        ├── api/
        │   ├── gateway-ws.ts            # WebSocket RPC client (完整 174 methods 封裝)
        │   ├── telegram-bridge.ts       # Telegram WebApp API 封裝
        │   └── types.ts                 # API 型別定義
        ├── pages/
        │   ├── Dashboard.tsx            # Mission Control 首頁
        │   ├── AgentControl.tsx         # Agent 管理 (列表/切換/啟停)
        │   ├── CodeWorkspace.tsx        # 程式碼工作區 (輸入+串流+diff)
        │   ├── WorkflowEditor.tsx       # 拖拽 Workflow 編輯器
        │   ├── CronManager.tsx          # Cron CRUD + 手動觸發
        │   ├── ModelSelector.tsx        # 模型列表 + 切換
        │   ├── DevOpsPanel.tsx          # CI/CD 監控 + GitHub 事件
        │   ├── TaskBoard.tsx            # Kanban 看板 (任務追蹤)
        │   └── Settings.tsx             # 權限/安全/偏好設定
        ├── components/
        │   ├── LiveStream.tsx           # 即時 CLI 輸出串流區
        │   ├── DiffViewer.tsx           # 程式碼 diff 檢視器
        │   ├── ProgressTracker.tsx      # 多步驟進度條
        │   ├── ConfirmDialog.tsx        # 確認對話框 (含生物辨識)
        │   ├── AgentCard.tsx            # Agent 狀態卡片
        │   ├── WorkflowNode.tsx         # Workflow 節點元件
        │   ├── CronJobCard.tsx          # Cron 任務卡片
        │   ├── StatusBar.tsx            # 底部狀態列
        │   ├── NavBar.tsx               # 頂部導航
        │   └── ShareButton.tsx          # 分享按鈕 (Stories/群組)
        ├── hooks/
        │   ├── useGateway.ts            # WebSocket 連線 + 自動重連
        │   ├── useTelegram.ts           # Telegram WebApp bridge
        │   ├── useAgent.ts              # Agent 狀態訂閱
        │   ├── useTheme.ts              # 主題同步 (dark/light)
        │   └── useStream.ts             # Session 訊息串流
        └── stores/
            ├── app-store.ts             # 全域狀態 (zustand)
            └── session-store.ts         # Session 狀態
```

---

## 7. OpenClaw 配置 (openclaw.json)

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Claude (Brain)",
        "tools": { "exec": { "security": "full", "ask": "off" } }
      },
      {
        "id": "coder",
        "name": "Codex (Hands)"
      }
    ]
  },
  "bindings": [
    { "type": "route", "agentId": "main", "match": { "channel": "telegram" } }
  ],
  "plugins": {
    "entries": {
      "automation": { "enabled": true }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "allowFrom": ["YOUR_TELEGRAM_USER_ID"],
      "inlineButtons": "all"
    }
  },
  "tools": { "exec": { "security": "full", "ask": "off" } },
  "cron": {
    "jobs": [
      {
        "id": "daily-pr-scan",
        "agentId": "main",
        "enabled": true,
        "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Taipei" },
        "payload": { "kind": "agentTurn", "message": "執行 daily-scan workflow" },
        "delivery": { "mode": "announce", "channel": "telegram" }
      }
    ]
  }
}
```

---

## 8. 實作順序（給 Codex 的執行指引）

### Phase 1: 基礎骨架
1. 確認 `extensions/automation/` plugin 骨架已存在（已完成）
2. 初始化 `webapp/` React 專案 (Vite + TelegramUI)
3. 實作 `gateway-ws.ts` WebSocket RPC client
4. 實作 `telegram-bridge.ts` Telegram WebApp 封裝
5. 實作 `Dashboard.tsx` 首頁

### Phase 2: Bot 側 UI
6. 實作 `main-menu.ts` 主選單
7. 實作 `callback-router.ts` callback 路由
8. 實作各 panel (agent, cron, model, workflow, devops)
9. 實作 `progress-updater.ts` 即時進度

### Phase 3: Mini App 頁面
10. 實作 `AgentControl.tsx`
11. 實作 `CodeWorkspace.tsx` + `LiveStream.tsx` + `DiffViewer.tsx`
12. 實作 `WorkflowEditor.tsx` + `WorkflowNode.tsx`
13. 實作 `CronManager.tsx` + `CronJobCard.tsx`
14. 實作 `ModelSelector.tsx`
15. 實作 `DevOpsPanel.tsx`
16. 實作 `TaskBoard.tsx` (Kanban)
17. 實作 `Settings.tsx`

### Phase 4: 進階功能
18. 實作 `risk-assessor.ts` + `permission-manager.ts`
19. 實作 `github-webhook.ts` + `ci-monitor.ts`
20. 實作 `topic-router.ts` + `agent-spawner.ts`
21. 實作 `payments.ts` Telegram Stars
22. 實作 `ShareButton.tsx`

### Phase 5: 整合測試
23. Bot 端: /start, /menu, /code, /workflow 全路徑測試
24. Mini App: 每個頁面 + WebSocket 連線測試
25. 安全: 生物辨識 + 確認閘門測試
26. DevOps: GitHub webhook 接收 + 通知測試
27. Cron: 排程建立 + 觸發 + 結果投遞測試

---

## 9. 環境需求

```bash
# Node.js 22+
node --version

# Claude CLI 已登入
claude --version

# Codex CLI 已登入
codex --version

# OpenClaw Gateway 啟動
openclaw gateway --bind lan --port 18789

# Mini App 開發服務器
cd extensions/automation/webapp && npm run dev

# BotFather 設定
# 1. /setcommands — 設定上述斜線命令
# 2. /setmenubutton — 設定 Mini App URL
# 3. 開啟 Forum Mode (若使用 Topic 路由)
```

---

## 10. 安全檢查清單

- [ ] `allowFrom` 設定只允許你的 Telegram user ID
- [ ] `tools.exec.security = "full"` + `tools.exec.ask = "off"` 確認設定
- [ ] GitHub webhook secret 已設定且驗證 HMAC-SHA256
- [ ] Mini App 的 initData 在後端驗證
- [ ] 敏感操作（deploy/delete/push）需要確認閘門
- [ ] 極敏感操作（production deploy）需要生物辨識
- [ ] API keys 不得寫入程式碼
- [ ] Rate limiting 已啟用
