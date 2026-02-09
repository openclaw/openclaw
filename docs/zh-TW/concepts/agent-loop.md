---
summary: "Agent loop 的生命週期、串流與等待語義"
read_when:
  - 當你需要對 agent loop 或生命週期事件有精確的逐步說明
title: "Agent Loop"
---

# Agent Loop（OpenClaw）

Agentic loop 是代理程式一次完整且「真實」的執行流程：輸入接收 → 情境組裝 → 模型推論 →
工具執行 → 串流回覆 → 持久化。這是一條權威路徑，將一則訊息轉化為行動與最終回覆，同時維持工作階段狀態的一致性。 It’s the authoritative path that turns a message
into actions and a final reply, while keeping session state consistent.

在 OpenClaw 中，一個 loop 是每個工作階段一次、序列化的執行，會在模型思考、呼叫工具與串流輸出時發出生命週期與串流事件。本文件說明這個真實 loop 如何端到端地連接運作。 This doc explains how that authentic loop is
wired end-to-end.

## Entry points

- Gateway RPC：`agent` 與 `agent.wait`。
- CLI：`agent` 指令。

## 運作方式（高層）

1. `agent` RPC 會驗證參數、解析工作階段（sessionKey/sessionId）、持久化工作階段中繼資料，並立即回傳 `{ runId, acceptedAt }`。
2. `agentCommand` 會執行 agent：
   - 解析模型與 thinking/verbose 的預設值
   - 載入 Skills 快照
   - 呼叫 `runEmbeddedPiAgent`（pi-agent-core runtime）
   - 若內嵌 loop 未發出事件，則送出 **lifecycle end/error**
3. `runEmbeddedPiAgent`：
   - serializes runs via per-session + global queues
   - resolves model + auth profile and builds the pi session
   - 訂閱 pi 事件並串流 assistant/tool 的增量
   - enforces timeout -> aborts run if exceeded
   - returns payloads + usage metadata
4. `subscribeEmbeddedPiSession` 將 pi-agent-core 事件橋接到 OpenClaw 的 `agent` 串流：
   - 工具事件 ⇒ `stream: "tool"`
   - assistant 增量 ⇒ `stream: "assistant"`
   - 生命週期事件 ⇒ `stream: "lifecycle"`（`phase: "start" | "end" | "error"`）
5. `agent.wait` 使用 `waitForAgentJob`：
   - 等待 **lifecycle end/error** 以取得 `runId`
   - 回傳 `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Queueing + concurrency

- Runs are serialized per session key (session lane) and optionally through a global lane.
- This prevents tool/session races and keeps session history consistent.
- 訊息頻道可選擇佇列模式（collect/steer/followup）以餵入此 lane 系統。
  請參見 [Command Queue](/concepts/queue)。
  See [Command Queue](/concepts/queue).

## 工作階段與工作空間準備

- 解析並建立工作空間；沙箱隔離的執行可能會重新導向至沙箱工作空間根目錄。
- Skills are loaded (or reused from a snapshot) and injected into env and prompt.
- Bootstrap/context files are resolved and injected into the system prompt report.
- 取得工作階段寫入鎖；在開始串流前會開啟並準備 `SessionManager`。

## Prompt assembly + system prompt

- 系統提示詞由 OpenClaw 的基礎提示詞、Skills 提示詞、啟動情境與每次執行的覆寫所組成。
- Model-specific limits and compaction reserve tokens are enforced.
- 模型實際看到的內容請參見 [System prompt](/concepts/system-prompt)。

## 掛鉤點（可攔截的位置）

OpenClaw 有兩套掛鉤系統：

- **Internal hooks** (Gateway hooks): event-driven scripts for commands and lifecycle events.
- **Plugin hooks**: extension points inside the agent/tool lifecycle and gateway pipeline.

### 內部掛鉤（Gateway 掛鉤）

- **`agent:bootstrap`**：在系統提示詞最終確定前、建立啟動檔案期間執行。
  可用於新增／移除啟動情境檔案。
  Use this to add/remove bootstrap context files.
- **Command 掛鉤**：`/new`、`/reset`、`/stop`，以及其他指令事件（見 Hooks 文件）。

設定與範例請參見 [Hooks](/automation/hooks)。

### 外掛掛鉤（agent + Gateway 生命週期）

這些會在 agent loop 或 Gateway 管線內執行：

- **`before_agent_start`**：在執行開始前注入情境或覆寫系統提示詞。
- **`agent_end`**：完成後檢視最終訊息清單與執行中繼資料。
- **`before_compaction` / `after_compaction`**：觀察或標註壓縮循環。
- **`before_tool_call` / `after_tool_call`**：攔截工具參數／結果。
- **`tool_result_persist`**：在寫入工作階段逐字稿前，同步轉換工具結果。
- **`message_received` / `message_sending` / `message_sent`**：入站＋出站訊息掛鉤。
- **`session_start` / `session_end`**：工作階段生命週期邊界。
- **`gateway_start` / `gateway_stop`**：Gateway 生命週期事件。

掛鉤 API 與註冊細節請參見 [Plugins](/tools/plugin#plugin-hooks)。

## 串流與部分回覆

- assistant 增量由 pi-agent-core 串流並以 `assistant` 事件發出。
- 區塊串流可在 `text_end` 或 `message_end` 上發出部分回覆。
- Reasoning streaming can be emitted as a separate stream or as block replies.
- See [Streaming](/concepts/streaming) for chunking and block reply behavior.

## 工具執行與訊息工具

- 工具的開始／更新／結束事件會在 `tool` 串流上發出。
- Tool results are sanitized for size and image payloads before logging/emitting.
- 會追蹤訊息工具的送出，以抑制重複的 assistant 確認訊息。

## Reply shaping + suppression

- 最終負載由以下組成：
  - assistant 文字（與可選的推理）
  - 內嵌工具摘要（在 verbose 且允許時）
  - 模型出錯時的 assistant 錯誤文字
- `NO_REPLY` is treated as a silent token and filtered from outgoing payloads.
- 訊息工具的重複項會從最終負載清單中移除。
- If no renderable payloads remain and a tool errored, a fallback tool error reply is emitted
  (unless a messaging tool already sent a user-visible reply).

## Compaction + retries

- Auto-compaction emits `compaction` stream events and can trigger a retry.
- 重試時，會重設記憶體中的緩衝區與工具摘要，以避免重複輸出。
- See [Compaction](/concepts/compaction) for the compaction pipeline.

## 事件串流（目前）

- `lifecycle`：由 `subscribeEmbeddedPiSession` 發出（並由 `agentCommand` 作為後備）
- `assistant`：來自 pi-agent-core 的串流增量
- `tool`：來自 pi-agent-core 的串流工具事件

## 聊天頻道處理

- assistant 增量會緩衝為聊天 `delta` 訊息。
- 在 **lifecycle end/error** 時會送出聊天 `final`。

## 逾時

- `agent.wait` default: 30s (just the wait). `timeoutMs` param overrides.
- Agent runtime：`agents.defaults.timeoutSeconds` 預設 600 秒；由 `runEmbeddedPiAgent` 的中止計時器強制執行。

## Where things can end early

- Agent 逾時（中止）
- AbortSignal（取消）
- Gateway 斷線或 RPC 逾時
- `agent.wait` 逾時（僅等待，不會停止 agent）
