---
summary: >-
  Integrate ACP coding agents via a first-class ACP control plane in core and
  plugin-backed runtimes (acpx first)
owner: onutc
status: draft
last_updated: "2026-02-25"
title: ACP Thread Bound Agents
---

# ACP 線程綁定代理

## 概述

此計畫定義了 OpenClaw 應如何在具備執行緒能力的通道（首先是 Discord）中支援 ACP 編碼代理，並具備生產級的生命週期和恢復能力。

[[BLOCK_1]]

- [統一執行時串流重構計畫](/experiments/plans/acp-unified-streaming-refactor)

[[BLOCK_1]]

- 使用者在一個執行緒中啟動或聚焦一個 ACP 會話
- 該執行緒中的使用者訊息會路由到綁定的 ACP 會話
- 代理的輸出會流回同一執行緒的人格
- 會話可以是持久的或一次性的，並具有明確的清理控制

## 決策摘要

長期建議是一種混合架構：

- OpenClaw 核心擁有 ACP 控制平面相關的問題
  - 會話身份和元數據
  - 執行緒綁定和路由決策
  - 傳遞不變性和重複抑制
  - 生命週期清理和恢復語義
- ACP 執行時後端是可插拔的
  - 第一個後端是一個 acpx 支援的插件服務
  - 執行時處理 ACP 傳輸、佇列、取消、重新連接

OpenClaw 不應該在核心中重新實現 ACP 傳輸內部機制。  
OpenClaw 不應該依賴純插件的攔截路徑來進行路由。

## North-star 架構（聖杯）

將 ACP 視為 OpenClaw 中的一級控制平面，並具備可插拔的執行時適配器。

非可協商的不變條件：

- 每個 ACP 執行緒綁定都參考一個有效的 ACP 會話記錄
- 每個 ACP 會話都有明確的生命週期狀態 (`creating`, `idle`, `running`, `cancelling`, `closed`, `error`)
- 每個 ACP 執行都有明確的執行狀態 (`queued`, `running`, `completed`, `failed`, `cancelled`)
- 產生、綁定和初始排隊是原子操作
- 命令重試是冪等的（不會有重複的執行或重複的 Discord 輸出）
- 綁定執行緒的頻道輸出是 ACP 執行事件的投影，絕不會是臨時的副作用

長期擁有模式：

- `AcpSessionManager` 是單一的 ACP 寫入者和協調者
- 管理者最初位於網關過程中；之後可以移動到同一介面後面的專用側車
- 每個 ACP 會話金鑰，管理者擁有一個記憶體中的演員（序列化命令執行）
- 適配器 (`acpx`，未來的後端) 僅是傳輸/執行時實現

[[BLOCK_1]]  
長期持久性模型：  
[[BLOCK_1]]

- 將 ACP 控制平面狀態移至 OpenClaw 狀態目錄下的專用 SQLite 儲存（WAL 模式）
- 在遷移期間保留 `SessionEntry.acp` 作為相容性投影，而非真實來源
- 將 ACP 事件以附加方式儲存，以支援重播、崩潰恢復和確定性傳遞

### 交付策略（通往聖杯的橋樑）

- 短期橋接
  - 保持目前的執行緒綁定機制和現有的 ACP 設定介面
  - 修正 metadata-gap 錯誤，並通過單一核心 ACP 分支路由 ACP 轉向
  - 立即新增冪等性金鑰和失敗關閉路由檢查
- 長期切換
  - 將 ACP 的真實來源移至控制平面資料庫 + 參與者
  - 使綁定執行緒的交付完全基於事件投影
  - 移除依賴於機會性會話進入 metadata 的舊版回退行為

## 為什麼不僅僅使用純插件

目前的插件鉤子不足以在不進行核心更改的情況下實現端到端的 ACP 會話路由。

- 來自執行緒綁定的入站路由首先在核心調度中解析為會話金鑰
- 訊息鉤子是即發即忘的，無法短路主要回覆路徑
- 插件命令適合控制操作，但不適合替代核心每回合的調度流程

結果：

- ACP 執行時可以插件化
- ACP 路由分支必須存在於核心中

## Existing foundation to reuse

已經實作並應保持為權威版本：

- 線程綁定目標支援 `subagent` 和 `acp`
- 進入線程路由覆寫在正常分派之前通過綁定解析
- 通過 webhook 在回覆交付中實現外發線程身份
- `/focus` 和 `/unfocus` 流程與 ACP 目標相容
- 持久綁定存儲並在啟動時恢復
- 在存檔、刪除、失焦、重置和刪除時進行解除綁定生命週期

這個計畫是基於該基礎進行擴充，而不是取代它。

## Architecture

### Boundary model

[[BLOCK_1]]  
Core (必須在 OpenClaw 核心中)：  
[[BLOCK_2]]

- ACP 會話模式分派分支在回覆管道中
- 交付仲裁以避免父執行緒重複
- ACP 控制平面持久性（在遷移期間與 `SessionEntry.acp` 相容性投影）
- 與會話重置/刪除相關的生命週期解除綁定和執行時分離語義

[[BLOCK_1]]  
Plugin backend (acpx 實作):  
[[BLOCK_1]]

- ACP 執行時工作者監控
- acpx 程序調用和事件解析
- ACP 命令處理器 (`/acp ...`) 和操作員使用者體驗
- 後端特定的設定預設值和診斷

### Runtime 擁有權模型

- 一個網關流程擁有 ACP 編排狀態
- ACP 執行透過 acpx 後端在受監控的子流程中執行
- 流程策略是根據每個活躍的 ACP 會話金鑰長期存在，而不是根據每條消息

這樣可以避免每次提示的啟動成本，並保持取消和重新連接的語義可靠。

### Core runtime contract

新增一個核心 ACP 執行時合約，以便路由程式碼不依賴於 CLI 細節，並且可以在不改變調度邏輯的情況下切換後端：

ts
export type AcpRuntimePromptMode = "prompt" | "steer";

export type AcpRuntimeHandle = {
sessionKey: string;
backend: string;
runtimeSessionName: string;
};

export type AcpRuntimeEvent =
| { type: "text_delta"; stream: "output" | "thought"; text: string }
| { type: "tool_call"; name: string; argumentsText: string }
| { type: "done"; usage?: Record<string, number> }
| { type: "error"; code: string; message: string; retryable?: boolean };

typescript
export interface AcpRuntime {
ensureSession(input: {
sessionKey: string;
agent: string;
mode: "persistent" | "oneshot";
cwd?: string;
env?: Record<string, string>;
idempotencyKey: string;
}): Promise<AcpRuntimeHandle>;
}

submit(input: {
handle: AcpRuntimeHandle;
text: string;
mode: AcpRuntimePromptMode;
idempotencyKey: string;
}): Promise<{ runtimeRunId: string }>;

stream(input: {
handle: AcpRuntimeHandle;
runtimeRunId: string;
onEvent: (event: AcpRuntimeEvent) => Promise<void> | void;
signal?: AbortSignal;
}): Promise<void>;

cancel(input: {
handle: AcpRuntimeHandle;
runtimeRunId?: string;
reason?: string;
idempotencyKey: string;
}): Promise<void>;

close(input: { handle: AcpRuntimeHandle; reason: string; idempotencyKey: string }): Promise<void>;

health?(): Promise<{ ok: boolean; details?: string }>;
}

[[BLOCK_1]]

- 第一個後端: `AcpxRuntime` 作為插件服務發佈
- 核心透過註冊表解析執行時，當沒有可用的 ACP 執行時後端時，會顯示明確的操作員錯誤並失敗

### 控制平面資料模型與持久性

長期的真實來源是一個專用的 ACP SQLite 資料庫（WAL 模式），用於交易更新和崩潰安全恢復：

- `acp_sessions`
  - `session_key` (pk), `backend`, `agent`, `mode`, `cwd`, `state`, `created_at`, `updated_at`, `last_error`
- `acp_runs`
  - `run_id` (pk), `session_key` (fk), `state`, `requester_message_id`, `idempotency_key`, `started_at`, `ended_at`, `error_code`, `error_message`
- `acp_bindings`
  - `binding_key` (pk), `thread_id`, `channel_id`, `account_id`, `session_key` (fk), `expires_at`, `bound_at`
- `acp_events`
  - `event_id` (pk), `run_id` (fk), `seq`, `kind`, `payload_json`, `created_at`
- `acp_delivery_checkpoint`
  - `run_id` (pk/fk), `last_event_seq`, `last_discord_message_id`, `updated_at`
- `acp_idempotency`
  - `scope`, `idempotency_key`, `result_json`, `created_at`, unique `(scope, idempotency_key)`

```ts
export type AcpSessionMeta = {
  backend: string;
  agent: string;
  runtimeSessionName: string;
  mode: "persistent" | "oneshot";
  cwd?: string;
  state: "idle" | "running" | "error";
  lastActivityAt: number;
  lastError?: string;
};
```

[[BLOCK_1]]

- 在遷移期間，將 `SessionEntry.acp` 保持為相容性投影
- 處理的 ID 和套接字僅保留在記憶體中
- 耐久的生命週期和執行狀態存放在 ACP 資料庫中，而不是一般的會話 JSON
- 如果執行時擁有者終止，閘道器將從 ACP 資料庫重新加載並從檢查點恢復

### 路由與交付

[[BLOCK_1]]

- 保持當前線程綁定查找作為第一個路由步驟
- 如果綁定的目標是 ACP 會話，則路由到 ACP 執行時分支，而不是 `getReplyFromConfig`
- 明確的 `/acp steer` 命令使用 `mode: "steer"`

Outbound:

- ACP 事件串流已標準化為 OpenClaw 回覆區塊
- 傳遞目標透過現有的綁定目的地路徑解析
- 當綁定的執行緒在該會話回合中處於活動狀態時，父通道的完成會被抑制

[[BLOCK_1]]

- 使用合併窗口串流部分輸出
- 可設定的最小間隔和最大區塊字節數，以保持在 Discord 的速率限制之下
- 最終消息在完成或失敗時始終發出

### 狀態機與交易邊界

[[BLOCK_1]]  
Session state machine:  
[[BLOCK_1]]

- `creating -> idle -> running -> idle`
- `running -> cancelling -> idle | error`
- `idle -> closed`
- `error -> idle | closed`

執行狀態機：

- `queued -> running -> completed`
- `running -> failed | cancelled`
- `queued -> cancelled`

[[BLOCK_1]]  
所需的交易邊界：  
[[BLOCK_1]]

- 產生交易
  - 創建 ACP 會話列
  - 創建/更新 ACP 執行緒綁定列
  - 排入初始執行列
- 關閉交易
  - 標記會話為已關閉
  - 刪除/過期綁定列
  - 寫入最終關閉事件
- 取消交易
  - 使用冪等鍵標記目標執行為取消/已取消

不允許在這些邊界之間有部分成功。

### 每會話演員模型

`AcpSessionManager` 每個 ACP 會話金鑰執行一個演員：

- 演員郵箱序列化 `submit`, `cancel`, `close`, 和 `stream` 副作用
- 演員擁有執行時句柄的水合和該會話的執行時適配器過程生命週期
- 演員在任何 Discord 傳遞之前按順序寫入執行事件 (`seq`)
- 演員在成功發送後更新傳遞檢查點

這樣可以消除跨回合競爭，並防止重複或錯序的執行緒輸出。

### 幂等性與交付預測

所有外部 ACP 操作必須攜帶冪等性金鑰：

- spawn idempotency key
- prompt/steer idempotency key
- cancel idempotency key
- close idempotency key

[[BLOCK_1]]

- Discord 訊息是由 `acp_events` 加上 `acp_delivery_checkpoint` 產生的
- 重試從檢查點恢復，無需重新發送已經傳送的區塊
- 最終回覆的發送是基於投影邏輯，每次執行僅發送一次

### Recovery and self-healing

在閘道器啟動時：

- 載入非終端的 ACP 會話 (`creating`, `idle`, `running`, `cancelling`, `error`)
- 在第一次進入事件時懶惰地重建演員，或在設定的上限下急切地重建
- 調和任何缺少心跳的 `running` 執行，並標記 `failed` 或通過適配器恢復

在進入的 Discord 主題訊息：

- 如果綁定存在但缺少 ACP 會話，則以明確的過期綁定訊息關閉失敗。
- 可選地在操作員安全驗證後自動解除過期綁定。
- 絕不要靜默地將過期的 ACP 綁定路由到正常的 LLM 路徑。

### 生命週期與安全性

支援的操作：

- 取消當前執行: `/acp cancel`
- 解除綁定執行緒: `/unfocus`
- 關閉 ACP 會話: `/acp close`
- 根據有效的 TTL 自動關閉閒置會話

TTL 政策：

- 有效的 TTL 是以下三者中的最小值：
  - 全域/會話 TTL
  - Discord 線程綁定 TTL
  - ACP 執行時擁有者 TTL

[[BLOCK_1]]

- 按名稱允許清單 ACP 代理
- 限制 ACP 會話的工作區根目錄
- 環境允許清單通過
- 每個帳戶及全域的最大同時 ACP 會話數
- 針對執行時崩潰的有界重啟退避時間

## Config surface

Core keys:

- `acp.enabled`
- `acp.dispatch.enabled` (獨立的 ACP 路由斷電開關)
- `acp.backend` (預設 `acpx`)
- `acp.defaultAgent`
- `acp.allowedAgents[]`
- `acp.maxConcurrentSessions`
- `acp.stream.coalesceIdleMs`
- `acp.stream.maxChunkChars`
- `acp.runtime.ttlMinutes`
- `acp.controlPlane.store` (`sqlite` 預設)
- `acp.controlPlane.storePath`
- `acp.controlPlane.recovery.eagerActors`
- `acp.controlPlane.recovery.reconcileRunningAfterMs`
- `acp.controlPlane.checkpoint.flushEveryEvents`
- `acp.controlPlane.checkpoint.flushEveryMs`
- `acp.idempotency.ttlHours`
- `channels.discord.threadBindings.spawnAcpSessions`

[[BLOCK_1]]  
Plugin/backend keys (acpx plugin section):  
[[BLOCK_1]]

- backend 命令/路徑覆蓋
- backend 環境允許清單
- backend 每個代理的預設設定
- backend 啟動/停止超時
- backend 每個會話的最大同時執行次數

## 實作規範

### 控制平面模組 (新)

在核心中新增專用的 ACP 控制平面模組：

- `src/acp/control-plane/manager.ts`
  - 擁有 ACP 演員、生命週期轉換、命令序列化
- `src/acp/control-plane/store.ts`
  - SQLite 架構管理、交易、查詢輔助工具
- `src/acp/control-plane/events.ts`
  - 類型化的 ACP 事件定義和序列化
- `src/acp/control-plane/checkpoint.ts`
  - 持久交付檢查點和重播游標
- `src/acp/control-plane/idempotency.ts`
  - 幂等性金鑰保留和回應重播
- `src/acp/control-plane/recovery.ts`
  - 啟動時的調和和演員再水合計畫

[[BLOCK_1]] 兼容性橋接模組：[[BLOCK_1]]

- `src/acp/runtime/session-meta.ts`
  - 暫時保留以便投影到 `SessionEntry.acp`
  - 在遷移切換後必須停止作為真實來源

### 必須遵守的不變條件（必須在程式碼中強制執行）

- ACP 會話的創建和線程綁定是原子性的（單一交易）
- 每個 ACP 會話演員同時最多只有一個活躍的執行
- 事件 `seq` 在每次執行中是嚴格遞增的
- 傳遞檢查點永遠不會超過最後已提交的事件
- 重放的冪等性會返回重複命令鍵的先前成功有效載荷
- 陳舊/缺失的 ACP 元數據無法路由到正常的非 ACP 回覆路徑

### 核心接觸點

核心檔案需更改：

- `src/auto-reply/reply/dispatch-from-config.ts`
  - ACP 分支調用 `AcpSessionManager.submit` 和事件投影交付
  - 移除繞過控制平面不變性的直接 ACP 回退
- `src/auto-reply/reply/inbound-context.ts` (或最近的標準化上下文邊界)
  - 為 ACP 控制平面公開標準化路由鍵和冪等性種子
- `src/config/sessions/types.ts`
  - 保留 `SessionEntry.acp` 作為僅投影的相容性欄位
- `src/gateway/server-methods/sessions.ts`
  - 重置/刪除/歸檔必須調用 ACP 管理器關閉/解除綁定交易路徑
- `src/infra/outbound/bound-delivery-router.ts`
  - 強制 ACP 綁定會話轉換的失敗關閉目的地行為
- `src/discord/monitor/thread-bindings.ts`
  - 增加與控制平面查詢連接的 ACP 過期綁定驗證輔助工具
- `src/auto-reply/reply/commands-acp.ts`
  - 通過 ACP 管理器 API 路由生成/取消/關閉/引導
- `src/agents/acp-spawn.ts`
  - 停止臨時元數據寫入；調用 ACP 管理器生成交易
- `src/plugin-sdk/**` 和插件執行時橋接
  - 清晰地公開 ACP 後端註冊和健康語義

核心檔案明確不被替換：

- `src/discord/monitor/message-handler.preflight.ts`
  - 保持執行緒綁定覆寫行為作為標準的會話金鑰解析器

### ACP 執行時登記 API

新增核心註冊模組：

`src/acp/runtime/registry.ts`

所需的 API:

ts
export type AcpRuntimeBackend = {
id: string;
runtime: AcpRuntime;
healthy?: () => boolean;
};

typescript
export function registerAcpRuntimeBackend(backend: AcpRuntimeBackend): void;
export function unregisterAcpRuntimeBackend(id: string): void;
export function getAcpRuntimeBackend(id?: string): AcpRuntimeBackend | null;
export function requireAcpRuntimeBackend(id?: string): AcpRuntimeBackend;

[[BLOCK_1]]

- `requireAcpRuntimeBackend` 在不可用時會拋出類型 ACP 後端缺失的錯誤
- 插件服務在 `start` 上註冊後端，並在 `stop` 上取消註冊
- 執行時查找是唯讀且進程本地的

### acpx 執行時插件合約 (實作細節)

對於第一個生產後端 (`extensions/acpx`), OpenClaw 和 acpx 之間有著嚴格的命令合約：

- 後端 ID: `acpx`
- 插件服務 ID: `acpx-runtime`
- 執行時處理編碼: `runtimeSessionName = acpx:v1:<base64url(json)>`
- 編碼的有效載荷欄位:
  - `name` (acpx 命名會話; 使用 OpenClaw `sessionKey`)
  - `agent` (acpx 代理命令)
  - `cwd` (會話工作區根目錄)
  - `mode` (`persistent | oneshot`)

Command mapping:

- 確保會話:
  - `acpx --format json --json-strict --cwd <cwd> <agent> sessions ensure --name <name>`
- 提示回合:
  - `acpx --format json --json-strict --cwd <cwd> <agent> prompt --session <name> --file -`
- 取消:
  - `acpx --format json --json-strict --cwd <cwd> <agent> cancel --session <name>`
- 關閉:
  - `acpx --format json --json-strict --cwd <cwd> <agent> sessions close <name>`

[[BLOCK_1]]

- OpenClaw 消耗來自 `acpx --format json --json-strict` 的 ndjson 事件
- `text` => `text_delta/output`
- `thought` => `text_delta/thought`
- `tool_call` => `tool_call`
- `done` => `done`
- `error` => `error`

### Session schema patch

Patch `SessionEntry` in `src/config/sessions/types.ts`:

```ts
type SessionAcpMeta = {
  backend: string;
  agent: string;
  runtimeSessionName: string;
  mode: "persistent" | "oneshot";
  cwd?: string;
  state: "idle" | "running" | "error";
  lastActivityAt: number;
  lastError?: string;
};
```

Persisted field:

`SessionEntry.acp?: SessionAcpMeta`

[[BLOCK_1]]  
遷移規則：  
[[BLOCK_1]]

- 階段 A: 雙寫 (`acp` 投影 + ACP SQLite 真實來源)
- 階段 B: 從 ACP SQLite 讀取主要資料，從舊系統 `SessionEntry.acp` 進行備援讀取
- 階段 C: 遷移命令從有效的舊系統條目中回填缺失的 ACP 行
- 階段 D: 移除備援讀取，並將投影保留為僅供使用者體驗選用
- 舊系統欄位 (`cliSessionIds`, `claudeCliSessionId`) 保持不變

### 錯誤合約

新增穩定的 ACP 錯誤程式碼和面向用戶的訊息：

- `ACP_BACKEND_MISSING`
  - message: `ACP runtime backend is not configured. Install and enable the acpx runtime plugin.`
- `ACP_BACKEND_UNAVAILABLE`
  - message: `ACP runtime backend is currently unavailable. Try again in a moment.`
- `ACP_SESSION_INIT_FAILED`
  - message: `Could not initialize ACP session runtime.`
- `ACP_TURN_FAILED`
  - message: `ACP turn failed before completion.`

[[BLOCK_1]]

- 在執行緒中返回可行的用戶安全訊息
- 僅在執行時日誌中記錄詳細的後端/系統錯誤
- 當明確選擇了 ACP 路由時，絕不要默默回退到正常的 LLM 路徑

### 重複交付仲裁

[[BLOCK_1]] 單一路由規則適用於 ACP 綁定轉向： [[BLOCK_1]]

- 如果目標 ACP 會話和請求者上下文存在活躍的執行緒綁定，則僅將資料傳遞給該綁定的執行緒
- 不要在同一回合中也發送到父通道
- 如果綁定的目的地選擇不明確，則以明確的錯誤關閉（不進行隱式的父級回退）
- 如果不存在活躍的綁定，則使用正常的會話目的地行為

### 可觀察性與運營準備性

[[BLOCK_1]]  
所需指標：  
[[BLOCK_1]]

- ACP 依後端和錯誤程式碼的產生成功/失敗計數
- ACP 執行延遲百分位數（佇列等待時間、執行時間、交付預測時間）
- ACP 演員重啟計數和重啟原因
- 陳舊綁定檢測計數
- 重複性重播命中率
- Discord 交付重試和速率限制計數器

所需日誌：

- 以 `sessionKey`、`runId`、`backend`、`threadId`、`idempotencyKey` 為鍵的結構化日誌
- 會話和執行狀態機的明確狀態轉換日誌
- 具有安全隱私的參數和退出摘要的適配器命令日誌

[[BLOCK_1]]  
所需診斷：  
[[BLOCK_1]]

- `/acp sessions` 包含狀態、當前執行、最後錯誤和綁定狀態
- `/acp doctor` （或等效項）驗證後端註冊、存儲健康狀況和過期綁定

### 設定優先順序與有效值

[[BLOCK_1]]  
ACP 啟用優先順序：  
[[BLOCK_2]]

- 帳戶覆蓋: `channels.discord.accounts.<id>.threadBindings.spawnAcpSessions`
- 頻道覆蓋: `channels.discord.threadBindings.spawnAcpSessions`
- 全域 ACP 閘道: `acp.enabled`
- 派遣閘道: `acp.dispatch.enabled`
- 後端可用性: 註冊的後端為 `acp.backend`

[[BLOCK_1]]  
自動啟用行為：  
[[BLOCK_1]]

- 當 ACP 被設定時 (`acp.enabled=true`, `acp.dispatch.enabled=true`, 或 `acp.backend=acpx`), 插件自動啟用標記 `plugins.entries.acpx.enabled=true`，除非被列入拒絕清單或明確禁用。

TTL 有效值：

`min(session ttl, discord thread binding ttl, acp runtime ttl)`

### Test map

[[BLOCK_1]]

- `src/acp/runtime/registry.test.ts` (new)
- `src/auto-reply/reply/dispatch-from-config.acp.test.ts` (new)
- `src/infra/outbound/bound-delivery-router.test.ts` (擴充 ACP 失敗關閉案例)
- `src/config/sessions/types.test.ts` 或最近的 session-store 測試 (ACP 元數據持久性)

[[BLOCK_1]]  
整合測試：  
[[BLOCK_1]]

- `src/discord/monitor/reply-delivery.test.ts` (綁定的 ACP 交付目標行為)
- `src/discord/monitor/message-handler.preflight*.test.ts` (綁定的 ACP 會話金鑰路由連續性)
- acpx 插件在後端套件中的執行時測試 (服務註冊/啟動/停止 + 事件標準化)

Gateway e2e 測試:

- `src/gateway/server.sessions.gateway-server-sessions-a.e2e.test.ts` (擴充 ACP 重置/刪除生命週期的覆蓋範圍)
- ACP 執行緒的回合旅行端到端測試，包括生成、消息、串流、取消、失焦、重啟恢復

### Rollout guard

新增獨立的 ACP 派遣緊急停止開關：

- `acp.dispatch.enabled` 預設 `false` 用於首次發佈
- 當禁用時：
  - ACP 生成/聚焦控制命令仍可能綁定會話
  - ACP 派遣路徑不會啟動
  - 使用者會收到明確的訊息，告知 ACP 派遣因政策而被禁用
- 在金絲雀驗證後，預設可以在後續版本中切換為 `true`

## Command and UX plan

### 新指令

- `/acp spawn <agent-id> [--mode persistent|oneshot] [--thread auto|here|off]`
- `/acp cancel [session]`
- `/acp steer <instruction>`
- `/acp close [session]`
- `/acp sessions`

### 現有指令相容性

- `/focus <sessionKey>` 繼續支援 ACP 目標
- `/unfocus` 保持目前的語意
- `/session idle` 和 `/session max-age` 取代舊的 TTL 覆寫

## 分階段推出

### Phase 0 ADR 和架構凍結

- 發送 ADR 以確定 ACP 控制平面擁有權和適配器邊界
- 凍結資料庫架構 (`acp_sessions`, `acp_runs`, `acp_bindings`, `acp_events`, `acp_delivery_checkpoint`, `acp_idempotency`)
- 定義穩定的 ACP 錯誤程式碼、事件合約和狀態轉換保護器

### Phase 1 控制平面基礎設施在核心

- 實作 `AcpSessionManager` 及每個會話的演員執行環境
- 實作 ACP SQLite 儲存和交易輔助工具
- 實作 重複性儲存和重播輔助工具
- 實作 事件附加 + 傳遞檢查點模組
- 將產生/取消/關閉 API 連接到管理者，並提供交易保證

### Phase 2 核心路由與生命週期整合

- 路由執行緒綁定的 ACP 從派遣管道轉換為 ACP 管理器
- 當 ACP 綁定/會話不變性失敗時，強制執行失效關閉路由
- 將重置/刪除/歸檔/失焦生命週期與 ACP 關閉/解除綁定交易整合
- 增加過期綁定檢測和可選的自動解除綁定政策

### Phase 3 acpx 後端適配器/插件

- 實作 `acpx` 轉接器以符合執行時合約 (`ensureSession`, `submit`, `stream`, `cancel`, `close`)
- 添加後端健康檢查及啟動/關閉註冊
- 將 acpx ndjson 事件標準化為 ACP 執行時事件
- 強制執行後端超時、進程監控及重啟/退避策略

### 第四階段 交付預測與渠道使用者體驗（以 Discord 為先）

- 實作事件驅動的通道投影，並支援檢查點恢復（以 Discord 為首）
- 合併串流區塊，並採用考量速率限制的刷新策略
- 保證每次執行僅發送一次最終完成訊息
- 發送 `/acp spawn`, `/acp cancel`, `/acp steer`, `/acp close`, `/acp sessions`

### Phase 5 遷移與切換

- 將雙寫引入 `SessionEntry.acp` 投影以及 ACP SQLite 真實來源
- 為舊版 ACP 元資料行添加遷移工具
- 將讀取路徑切換至 ACP SQLite 主資料庫
- 移除依賴缺失 `SessionEntry.acp` 的舊版回退路由

### 第六階段 強化、服務水平目標 (SLO) 與擴充限制

- 強制執行併發限制（全域/帳戶/會話）、佇列政策和超時預算
- 添加完整的遙測、儀表板和警報閾值
- 進行混沌測試以檢驗崩潰恢復和重複交付抑制
- 發布後端故障、資料庫損壞和過期綁定修復的執行手冊

### 完整實作檢查清單

- 核心控制平面模組及測試
- 資料庫遷移及回滾計畫
- ACP 管理員 API 整合於調度和命令中
- 外掛執行橋接中的適配器註冊介面
- acpx 適配器實作及測試
- 支援執行緒的通道傳遞投影邏輯，具備檢查點重播（優先支援 Discord）
- 重置/刪除/歸檔/失焦的生命週期鉤子
- 陳舊綁定檢測器及面向操作員的診斷
- 所有新 ACP 鍵的設定驗證及優先順序測試
- 操作文件及故障排除手冊

## 測試計畫

[[BLOCK_1]]

- ACP 資料庫交易邊界（產生/綁定/排隊的原子性、取消、關閉）
- ACP 狀態機轉換保護器，用於會話和執行
- 所有 ACP 命令的冪等性保留/重播語義
- 每個會話的演員序列化和佇列排序
- acpx 事件解析器和區塊合併器
- 執行時監控器重啟和退避策略
- 設定優先順序和有效 TTL 計算
- 核心 ACP 路由分支選擇和當後端/會話無效時的失效關閉行為

[[BLOCK_1]]  
整合測試：  
[[BLOCK_1]]

- 假的 ACP 轉接器過程以實現確定性串流和取消行為
- ACP 管理器 + 交易持久性整合
- 線程綁定的入站路由至 ACP 會話金鑰
- 線程綁定的出站傳遞抑制父通道重複
- 檢查點重播在傳遞失敗後恢復並從最後事件繼續
- 插件服務註冊和 ACP 執行時後端的拆卸

Gateway e2e 測試:

- 使用執行緒產生 ACP，交換多輪提示，失去焦點
- 使用持久化的 ACP 資料庫和綁定重新啟動網關，然後繼續相同的會話
- 多執行緒中的並行 ACP 會話之間沒有交談
- 重複的命令重試（相同的冪等性鍵）不會產生重複的執行或回覆
- 陳舊綁定情境會產生明確的錯誤和可選的自動清理行為

## 風險與緩解措施

- 過渡期間的重複交付
  - 緩解措施：單一目的地解析器和冪等事件檢查點
- 負載下的執行過程波動
  - 緩解措施：長期存在的每個會話擁有者 + 並發上限 + 退避
- 插件缺失或設定錯誤
  - 緩解措施：明確的操作員面向錯誤和失敗關閉的 ACP 路由（不隱式回退到正常會話路徑）
- 子代理和 ACP 閘道之間的設定混淆
  - 緩解措施：明確的 ACP 鍵和包含有效政策來源的命令反饋
- 控制平面存儲損壞或遷移錯誤
  - 緩解措施：WAL 模式、備份/還原鉤子、遷移煙霧測試和只讀回退診斷
- 演員死鎖或郵箱饑餓
  - 緩解措施：看門狗計時器、演員健康探測和有界郵箱深度與拒絕遙測

## 接受檢查清單

- ACP 會話生成可以在支援的通道適配器中創建或綁定一個執行緒（目前支援 Discord）
- 所有執行緒消息僅路由到綁定的 ACP 會話
- ACP 輸出以相同的執行緒身份出現，無論是串流還是批次
- 對於綁定的回合，父通道中不會有重複輸出
- 生成+綁定+初始排隊在持久存儲中是原子操作
- ACP 命令重試是冪等的，不會重複執行或輸出
- 取消、關閉、失去焦點、歸檔、重置和刪除執行確定性清理
- 崩潰重啟保留映射並恢復多回合的連續性
- 同時綁定的 ACP 會話獨立運作
- ACP 後端缺失狀態會產生明確的可操作錯誤
- 過期的綁定會被檢測並明確顯示（可選的安全自動清理）
- 控制平面指標和診斷可供操作員使用
- 新的單元、整合和端到端測試覆蓋通過

## 附錄：針對當前實作的目標重構（狀態）

這些是非阻塞的後續行動，以確保在當前功能集上線後，ACP 路徑能夠保持可維護性。

### 1) 集中化 ACP 派遣政策評估（已完成）

- 透過 `src/acp/policy.ts` 中的共享 ACP 政策輔助工具實現
- 派遣、ACP 命令生命週期處理程序以及 ACP 啟動路徑現在使用共享政策邏輯

### 2) 按子命令領域拆分 ACP 命令處理器（已完成）

- `src/auto-reply/reply/commands-acp.ts` 現在是一個輕量級路由器
- 子命令行為被拆分為：
  - `src/auto-reply/reply/commands-acp/lifecycle.ts`
  - `src/auto-reply/reply/commands-acp/runtime-options.ts`
  - `src/auto-reply/reply/commands-acp/diagnostics.ts`
  - 在 `src/auto-reply/reply/commands-acp/shared.ts` 中共享的輔助工具

### 3) 按責任分割 ACP 會話管理器（已完成）

- manager 被拆分為：
  - `src/acp/control-plane/manager.ts` (公共外觀 + 單例)
  - `src/acp/control-plane/manager.core.ts` (管理者實作)
  - `src/acp/control-plane/manager.types.ts` (管理者類型/依賴)
  - `src/acp/control-plane/manager.utils.ts` (正規化 + 幫助函數)

### 4) 可選的 acpx 執行時適配器清理

- `extensions/acpx/src/runtime.ts` 可以拆分為：
- 程序執行/監控
- ndjson 事件解析/標準化
- 執行時 API 接口 (`submit`, `cancel`, `close`, 等等)
- 提高可測試性並使後端行為更容易審核
