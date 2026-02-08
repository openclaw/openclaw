---
summary: 「Agent loop 的生命週期、串流與等待語義」
read_when:
  - 當你需要對 agent loop 或生命週期事件有精確的逐步說明
title: 「Agent Loop」
x-i18n:
  source_path: concepts/agent-loop.md
  source_hash: e2c14fb74bd42caa
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:46Z
---

# Agent Loop（OpenClaw）

Agentic loop 是代理程式一次完整且「真實」的執行流程：輸入接收 → 情境組裝 → 模型推論 →
工具執行 → 串流回覆 → 持久化。這是一條權威路徑，將一則訊息轉化為行動與最終回覆，同時維持工作階段狀態的一致性。

在 OpenClaw 中，一個 loop 是每個工作階段一次、序列化的執行，會在模型思考、呼叫工具與串流輸出時發出生命週期與串流事件。本文件說明這個真實 loop 如何端到端地連接運作。

## 進入點

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
   - 透過每個工作階段與全域佇列來序列化執行
   - 解析模型與身分驗證設定檔並建立 pi 工作階段
   - 訂閱 pi 事件並串流 assistant/tool 的增量
   - 強制逾時 → 超過即中止執行
   - 回傳負載與用量中繼資料
4. `subscribeEmbeddedPiSession` 將 pi-agent-core 事件橋接到 OpenClaw 的 `agent` 串流：
   - 工具事件 ⇒ `stream: "tool"`
   - assistant 增量 ⇒ `stream: "assistant"`
   - 生命週期事件 ⇒ `stream: "lifecycle"`（`phase: "start" | "end" | "error"`）
5. `agent.wait` 使用 `waitForAgentJob`：
   - 等待 **lifecycle end/error** 以取得 `runId`
   - 回傳 `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## 佇列與並行

- 執行會依工作階段金鑰（session lane）序列化，並可選擇再經過全域 lane。
- 這可防止工具／工作階段競態，並保持工作階段歷史的一致性。
- 訊息頻道可選擇佇列模式（collect/steer/followup）以餵入此 lane 系統。
  請參見 [Command Queue](/concepts/queue)。

## 工作階段與工作空間準備

- 解析並建立工作空間；沙箱隔離的執行可能會重新導向至沙箱工作空間根目錄。
- 載入 Skills（或重用快照），並注入至環境與提示詞。
- 解析並注入啟動／情境檔案至系統提示詞報告。
- 取得工作階段寫入鎖；在開始串流前會開啟並準備 `SessionManager`。

## 提示詞組裝與系統提示詞

- 系統提示詞由 OpenClaw 的基礎提示詞、Skills 提示詞、啟動情境與每次執行的覆寫所組成。
- 會強制執行模型特定的限制與壓縮保留權杖。
- 模型實際看到的內容請參見 [System prompt](/concepts/system-prompt)。

## 掛鉤點（可攔截的位置）

OpenClaw 有兩套掛鉤系統：

- **內部掛鉤**（Gateway 掛鉤）：用於指令與生命週期事件的事件驅動腳本。
- **外掛掛鉤**：位於 agent／工具生命週期與 Gateway 管線中的擴充點。

### 內部掛鉤（Gateway 掛鉤）

- **`agent:bootstrap`**：在系統提示詞最終確定前、建立啟動檔案期間執行。
  可用於新增／移除啟動情境檔案。
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
- 推理串流可作為獨立串流或以區塊回覆發出。
- 分塊與區塊回覆行為請參見 [Streaming](/concepts/streaming)。

## 工具執行與訊息工具

- 工具的開始／更新／結束事件會在 `tool` 串流上發出。
- 在記錄／發出前，工具結果會針對大小與影像負載進行清理。
- 會追蹤訊息工具的送出，以抑制重複的 assistant 確認訊息。

## 回覆整形與抑制

- 最終負載由以下組成：
  - assistant 文字（與可選的推理）
  - 內嵌工具摘要（在 verbose 且允許時）
  - 模型出錯時的 assistant 錯誤文字
- `NO_REPLY` 被視為靜默權杖，並會從對外負載中過濾。
- 訊息工具的重複項會從最終負載清單中移除。
- 若沒有任何可渲染的負載且工具發生錯誤，則會送出後備的工具錯誤回覆
  （除非訊息工具已經送出對使用者可見的回覆）。

## 壓縮與重試

- 自動壓縮會發出 `compaction` 串流事件，並可能觸發重試。
- 重試時，會重設記憶體中的緩衝區與工具摘要，以避免重複輸出。
- 壓縮管線請參見 [Compaction](/concepts/compaction)。

## 事件串流（目前）

- `lifecycle`：由 `subscribeEmbeddedPiSession` 發出（並由 `agentCommand` 作為後備）
- `assistant`：來自 pi-agent-core 的串流增量
- `tool`：來自 pi-agent-core 的串流工具事件

## 聊天頻道處理

- assistant 增量會緩衝為聊天 `delta` 訊息。
- 在 **lifecycle end/error** 時會送出聊天 `final`。

## 逾時

- `agent.wait` 預設：30 秒（僅等待）。可由 `timeoutMs` 參數覆寫。
- Agent runtime：`agents.defaults.timeoutSeconds` 預設 600 秒；由 `runEmbeddedPiAgent` 的中止計時器強制執行。

## 可能提早結束的情況

- Agent 逾時（中止）
- AbortSignal（取消）
- Gateway 斷線或 RPC 逾時
- `agent.wait` 逾時（僅等待，不會停止 agent）
