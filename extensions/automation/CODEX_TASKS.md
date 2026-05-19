# SuperClaw — Codex 自動建置任務清單

> **此檔案是 Codex CLI 的自動化建置指令。**
> 修改本檔並儲存後，Codex 會自動讀取並執行標記為 `[ ]` 的任務。
> 完成的任務會被標記為 `[x]`。
>
> 最後更新: 2026-05-17
> 版本: 1.0

---

## 使用方式

1. 在任務前面標記 `[ ]` = 待執行
2. Codex 完成後會標記為 `[x]`
3. 新增任務：加一行 `- [ ] 任務描述` 即可
4. 優先級：由上到下，越上面越先執行

---

## 📁 專案結構

所有程式碼都在 `extensions/automation/` 下。

```
extensions/automation/
├── openclaw.plugin.json       ✅ 已完成
├── package.json               ✅ 已完成
├── tsconfig.json              ✅ 已完成
├── index.ts                   ✅ 已完成
├── CODEX_TASKS.md             ← 你正在讀的這個檔案
├── src/
│   ├── register.ts            ✅ 已完成（註冊中心）
│   ├── commands.ts            ✅ 已完成（9 個斜線命令）
│   ├── gateway-rpc.ts         ✅ 已完成（Gateway RPC 封裝）
│   ├── system-prompt.ts       ✅ 已完成
│   ├── hooks/
│   │   ├── prompt-build.ts    ✅ 已完成
│   │   ├── lifecycle.ts       ✅ 已完成
│   │   └── file-watcher.ts    ✅ 已完成（監控此檔案變更）
│   ├── telegram-ui/           ✅ 已完成（14 個模組）
│   ├── tools/                 ✅ 已完成（5 個 tool）
│   ├── security/              ✅ 已完成（2 個模組）
│   ├── devops/                ✅ 已完成（2 個模組）
│   └── multi-agent/           ✅ 已完成（2 個模組）
└── webapp/                    🔨 待建（Telegram Mini App）
```

---

## 🔨 Phase 1: Telegram Mini App 基礎框架

> 目標：建立 `extensions/automation/webapp/` React 前端專案

- [x] 在 `extensions/automation/webapp/` 初始化 Vite + React + TypeScript 專案
  - `npm create vite@latest . -- --template react-ts`
  - 安裝: `@telegram-apps/sdk @telegram-apps/telegram-ui zustand react-router-dom`
  - `vite.config.ts`: base="/superclaw/", outDir="../dist-webapp"

- [x] 建立 `webapp/src/main.tsx` — Telegram WebApp 初始化
  - 呼叫 `window.Telegram.WebApp.ready()` + `.expand()` + `.requestFullscreen()`
  - 包裹 `<AppRoot>` (telegram-ui)
  - 設定 `<BrowserRouter basename="/superclaw/">`

- [x] 建立 `webapp/src/App.tsx` — 路由與佈局
  - Routes: `/` (Dashboard), `/agents`, `/code`, `/workflows`, `/cron`, `/models`, `/devops`, `/settings`
  - 底部 Tab 導航: 首頁、Agent、程式碼、更多
  - 使用 `@telegram-apps/telegram-ui` 的 `Tabbar` 元件

- [x] 建立 `webapp/src/api/gateway-ws.ts` — WebSocket RPC Client
  - 連線到 OpenClaw Gateway WebSocket
  - 實作 JSON-RPC 2.0 request/response
  - 自動重連（exponential backoff）
  - 方法: `call(method: string, params?: object): Promise<any>`
  - 事件訂閱: `subscribe(event: string, handler): unsubscribe`

- [x] 建立 `webapp/src/api/telegram-bridge.ts` — Telegram WebApp API 封裝
  - `getTelegramUser()` — 取得用戶資訊
  - `getTheme()` — 取得 dark/light 主題
  - `showConfirm(msg)` — 原生確認對話框
  - `hapticFeedback(type)` — 震動回饋
  - `cloudStorage.get/set` — Telegram Cloud Storage

- [x] 建立 `webapp/src/stores/app-store.ts` — Zustand 全域狀態
  ```typescript
  interface AppState {
    phase: AgentPhase;
    activeTask: ActiveTask | null;
    agents: AgentInfo[];
    cronJobs: CronJobInfo[];
    models: ModelInfo[];
    attentionItems: AttentionItem[];
    stats: { tokensToday: number; tasksToday: number };
    // actions
    refreshAll: () => Promise<void>;
    setPhase: (phase: AgentPhase) => void;
  }
  ```

---

## 🔨 Phase 2: 核心頁面

- [x] 建立 `webapp/src/pages/Dashboard.tsx` — 首頁儀表板
  - 頂部: Agent 狀態指示燈（phase emoji + 文字）
  - 中間: 進行中任務卡片（進度條 + 即時更新）
  - 注意事項列表（按 urgency 排序，可展開操作）
  - 底部: 快捷操作按鈕（動態，根據 phase 變化）
  - 下拉刷新
  - WebSocket 即時推送更新

- [x] 建立 `webapp/src/pages/AgentControl.tsx` — Agent 管理
  - Agent 列表卡片（狀態、模型、session turns）
  - 切換按鈕（switch active agent）
  - 重置對話按鈕（帶確認）
  - 呼叫 GatewayRPC: `agents.list`, `config.patch`, `sessions.reset`

- [x] 建立 `webapp/src/pages/CodeWorkspace.tsx` — 程式碼工作區
  - 頂部: 輸入框（任務指令）
  - 中間: 即時 CLI 輸出串流（Terminal 風格，黑底綠字）
  - 底部: 操作按鈕（提交、撤銷、查看 diff）
  - 使用 WebSocket 訂閱 agent 輸出
  - Diff 檢視器（展開/收合）

- [ ] 建立 `webapp/src/pages/WorkflowEditor.tsx` — 工作流管理
  - 工作流清單（卡片式，顯示步驟數）
  - 點擊執行 → 即時進度追蹤
  - 每步驟狀態: ⏳ 等待 → 🔄 執行中 → ✅ 完成 / ❌ 失敗
  - 4 個內建工作流: auto-pr, code-review, daily-scan, refactor

- [ ] 建立 `webapp/src/pages/CronManager.tsx` — 排程管理
  - Cron 列表（卡片式，顯示 schedule + 下次執行時間）
  - Toggle 開關（啟用/停用）
  - 「立即執行」按鈕
  - 呼叫 GatewayRPC: `cron.list`, `cron.update`, `cron.run`

- [ ] 建立 `webapp/src/pages/ModelSelector.tsx` — 模型切換
  - 模型列表按 provider 分組
  - 當前模型高亮標記
  - 點擊切換（帶確認 + 載入動畫）
  - 呼叫 GatewayRPC: `models.list`, `sessions.patch`

- [ ] 建立 `webapp/src/pages/DevOpsPanel.tsx` — DevOps 面板
  - CI/CD 狀態看板（emoji 狀態 + repo + branch）
  - PR 列表（number, title, state, draft 標記）
  - 部署確認按鈕（danger 風格）
  - 呼叫 GatewayRPC: `ci.statuses`, `github.prs.list`

- [ ] 建立 `webapp/src/pages/Settings.tsx` — 設定面板
  - 通知級別選擇（silent / quiet / loud）
  - 安全設定（auto-approve patterns）
  - 偏好設定存 Telegram Cloud Storage
  - 帳號資訊顯示

---

## 🔨 Phase 3: 共用元件

- [ ] 建立 `webapp/src/components/LiveStream.tsx` — 即時輸出
  - Terminal 風格渲染（monospace, 黑底）
  - 自動捲動到底部
  - ANSI 色彩支援
  - 複製按鈕

- [ ] 建立 `webapp/src/components/DiffViewer.tsx` — Diff 檢視器
  - Unified diff 格式
  - 語法高亮（紅=刪除, 綠=新增）
  - 檔案路徑標題
  - 展開/收合

- [ ] 建立 `webapp/src/components/ProgressTracker.tsx` — 進度追蹤
  - 多步驟垂直時間線
  - 每步狀態 emoji
  - 動態更新（WebSocket 推送）
  - 耗時顯示

- [ ] 建立 `webapp/src/components/ConfirmDialog.tsx` — 確認對話框
  - 使用 Telegram 原生 `showConfirm()` 如可用
  - 否則 fallback 到自訂 modal
  - 支援 danger 風格（紅色按鈕）
  - 可選生物辨識確認

- [ ] 建立 `webapp/src/components/AgentCard.tsx` — Agent 卡片
  - 狀態指示燈（🟢 online / 🟡 busy / 🔴 offline）
  - Agent 名稱 + 模型
  - Session 統計（turns 數）
  - 操作按鈕（切換 / 重置）

- [ ] 建立 `webapp/src/components/StatusBar.tsx` — 狀態列
  - 連線狀態（WebSocket）
  - 今日統計（tokens + tasks）
  - Agent 狀態摘要

- [ ] 建立 `webapp/src/components/NavBar.tsx` — 導航列
  - 麵包屑導航
  - 返回按鈕
  - 標題

---

## 🔨 Phase 4: Hooks

- [ ] 建立 `webapp/src/hooks/useGateway.ts` — Gateway 連線 Hook
  ```typescript
  function useGateway() {
    // 連線管理 + RPC 呼叫 + 重連
    return { call, subscribe, connected, reconnect };
  }
  ```

- [ ] 建立 `webapp/src/hooks/useTelegram.ts` — Telegram API Hook
  ```typescript
  function useTelegram() {
    return { user, theme, showConfirm, haptic, cloudStorage };
  }
  ```

- [ ] 建立 `webapp/src/hooks/useAgent.ts` — Agent 狀態 Hook
  ```typescript
  function useAgent() {
    // 訂閱 agent 狀態變化
    return { phase, activeTask, agents, attentionItems };
  }
  ```

- [ ] 建立 `webapp/src/hooks/useTheme.ts` — 主題同步 Hook
  - 監聽 Telegram `themeChanged` 事件
  - 同步 CSS variables
  - dark / light 模式

- [ ] 建立 `webapp/src/hooks/useStream.ts` — 串流 Hook
  ```typescript
  function useStream(sessionKey: string) {
    // WebSocket 訂閱 agent 輸出
    return { lines, isStreaming, clear };
  }
  ```

---

## 🔨 Phase 5: 整合與部署

- [ ] 在 `extensions/automation/src/register.ts` 加入 HTTP route 註冊
  - `api.registerHttpRoute({ path: "/superclaw", ... })` 靜態檔案服務
  - 從 `dist-webapp/` 目錄伺服 React 建置產物

- [ ] 建立 `webapp/src/api/types.ts` — 共用型別
  - 複用 `extensions/automation/src/telegram-ui/` 的型別定義
  - AgentPhase, ActiveTask, AttentionItem, SystemState
  - AgentInfo, CronJobInfo, ModelInfo, CIStatus

- [ ] 設定 Telegram BotFather — 註冊 Mini App
  - Menu Button → Web App URL: `https://{host}/superclaw/`
  - 設定 Domain whitelist

- [ ] 建置腳本
  - `webapp/package.json` scripts: `build`, `dev`, `preview`
  - 確保 `pnpm build` 時自動建置 webapp

---

## 🔨 Phase 6: 進階功能（可選）

- [ ] 建立 `webapp/src/pages/TaskBoard.tsx` — Kanban 看板
  - 三欄: 待處理 / 進行中 / 已完成
  - 拖拽排序
  - 任務卡片（標題 + 狀態 + agent）

- [ ] 實作 PWA 離線支援
  - Service Worker 快取靜態資源
  - 離線時顯示最後快取的狀態

- [ ] 實作 Push Notification
  - Telegram Mini App push API
  - 綁定 OpenClaw 通知系統

---

## ⚠️ 重要規範

### 型別系統
- 所有檔案使用 TypeScript strict mode
- 從 `extensions/automation/src/telegram-ui/agent-state.ts` 複用型別
- API 回傳一律使用 `any` 再 type guard，不信任外部資料

### UI 規範
- 使用 `@telegram-apps/telegram-ui` 元件庫
- 顏色跟隨 Telegram 主題（dark/light）
- 中文介面（繁體中文）
- 所有按鈕帶 haptic feedback
- 載入狀態使用 skeleton / spinner

### Gateway RPC 呼叫
- WebSocket 連線: `wss://{host}/ws`
- 格式: JSON-RPC 2.0 `{ method, params, id }`
- 已知方法（用到的）:
  - `agents.list`, `agent.identity.get`
  - `cron.list`, `cron.update`, `cron.run`
  - `models.list`, `sessions.patch`, `sessions.reset`
  - `health`, `usage.status`
  - `chat.history`, `chat.abort`
  - `tools.catalog`, `channels.status`
  - `exec.approval.list`, `exec.approval.resolve`
  - `ci.statuses`, `github.prs.list`

### 安全
- 所有 Gateway 呼叫需驗證 Telegram `initData`
- 危險操作（deploy, reset, delete）需二次確認
- Rate limiting: 30 actions/min

### 程式碼風格
- 註解使用繁體中文
- 函數/變數名用英文
- 每個檔案頂部說明用途
- import 順序: React → 第三方 → 本地
