---
summary: "Agent loop lifecycle, streams, and wait semantics"
read_when:
  - You need an exact walkthrough of the agent loop or lifecycle events
title: Agent Loop
---

# Agent Loop (OpenClaw)

一個 agentic loop 是代理的完整「真實」執行流程：輸入 → 上下文組裝 → 模型推論 → 工具執行 → 串流回覆 → 持久化。它是將訊息轉換成動作與最終回覆的權威路徑，同時保持會話狀態一致。

在 OpenClaw 中，loop 是每個會話的單一序列化執行，會在模型思考、呼叫工具及串流輸出時發出生命週期與串流事件。本文檔說明這個真實 loop 如何端到端串接。

## 進入點

- Gateway RPC：`agent` 和 `agent.wait`。
- CLI：`agent` 指令。

## 運作方式（高階）

1. `agent` RPC 驗證參數，解析會話（sessionKey/sessionId），持久化會話元資料，立即回傳 `{ runId, acceptedAt }`。
2. `agentCommand` 執行代理：
   - 解析模型與思考/詳細模式預設
   - 載入技能快照
   - 呼叫 `runEmbeddedPiAgent`（pi-agent-core 執行時）
   - 若內嵌 loop 未發出，則發出 **生命週期結束/錯誤** 事件
3. `runEmbeddedPiAgent`：
   - 透過每會話與全域佇列序列化執行
   - 解析模型與授權設定，建立 pi 會話
   - 訂閱 pi 事件並串流助理/工具差異
   - 強制逾時，逾時則中止執行
   - 回傳負載與使用元資料
4. `subscribeEmbeddedPiSession` 將 pi-agent-core 事件橋接到 OpenClaw `agent` 串流：
   - 工具事件 => `stream: "tool"`
   - 助理差異 => `stream: "assistant"`
   - 生命週期事件 => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` 使用 `waitForAgentJob`：
   - 等待 **生命週期結束/錯誤** 以完成 `runId`
   - 回傳 `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## 佇列與併發

- 執行依會話鍵（session lane）序列化，且可選擇透過全域 lane。
- 這避免工具/會話競爭，並保持會話歷史一致。
- 訊息通道可選擇佇列模式（collect/steer/followup）來餵入此 lane 系統。
  詳見 [Command Queue](/concepts/queue)。

## 會話與工作區準備

- 解析並建立工作區；沙盒執行可能會重定向到沙盒工作區根目錄。
- 載入技能（或重用快照）並注入環境與提示。
- 解析並注入啟動/上下文檔案到系統提示報告。
- 取得會話寫入鎖；`SessionManager` 在串流前開啟並準備。

## 提示組裝與系統提示

- 系統提示由 OpenClaw 基礎提示、技能提示、啟動上下文與每次執行覆寫組成。
- 強制執行模型特定限制與壓縮保留 token。
- 詳見 [System prompt](/concepts/system-prompt) 了解模型所見。

## 鉤子點（可攔截位置）

OpenClaw 有兩套鉤子系統：

- **內部掛勾**（Gateway hooks）：針對指令與生命週期事件的事件驅動腳本。
- **插件掛勾**：代理/工具生命週期及 Gateway 流程中的擴充點。

### 內部掛勾（Gateway hooks）

- **`agent:bootstrap`**：在系統提示完成前，建構 bootstrap 檔案時執行。  
  用於新增或移除 bootstrap 上下文檔案。
- 指令掛勾：`/new`、`/reset`、`/stop` 及其他指令事件（詳見 Hooks 文件）。

請參考 [Hooks](/automation/hooks) 了解設定與範例。

### 插件掛勾（代理 + Gateway 生命週期）

這些掛勾在代理迴圈或 Gateway 流程中執行：

- **`before_model_resolve`**：會在會話前執行（無 `messages`），用於在模型解析前確定性地覆寫提供者/模型。
- **`before_prompt_build`**：會在會話載入後執行（搭配 `messages`），用於在提示提交前注入 `prependContext`、`systemPrompt`、`prependSystemContext` 或 `appendSystemContext`。  
  使用 `prependContext` 來處理每回合的動態文字，系統上下文字段則用於放置應該在系統提示空間中保持穩定的指引。
- **`before_agent_start`**：舊版相容掛勾，可能在任一階段執行；建議優先使用上述明確掛勾。
- **`agent_end`**：檢查最終訊息列表並在完成後執行元資料處理。
- **`before_compaction` / `after_compaction`**：觀察或註解壓縮週期。
- **`before_tool_call` / `after_tool_call`**：攔截工具參數與結果。
- **`tool_result_persist`**：同步轉換工具結果，於寫入會話記錄前執行。
- **`message_received` / `message_sending` / `message_sent`**：進出訊息掛勾。
- **`session_start` / `session_end`**：會話生命週期邊界。
- **`gateway_start` / `gateway_stop`**：Gateway 生命週期事件。

請參考 [Plugins](/tools/plugin#plugin-hooks) 了解掛勾 API 與註冊細節。

## 串流與部分回覆

- 助理增量（deltas）由 pi-agent-core 串流並以 `assistant` 事件發出。
- 區塊串流可在 `text_end` 或 `message_end` 發出部分回覆。
- 推理串流可作為獨立串流或區塊回覆發出。
- 詳見 [Streaming](/concepts/streaming) 了解分塊與區塊回覆行為。

## 工具執行與訊息工具

- 工具啟動/更新/結束事件會在 `tool` 串流中發出。
- 工具結果在記錄/發出前會進行大小與圖片載荷的淨化。
- 訊息工具的發送會被追蹤以抑制重複的助理確認。

## 回覆塑形與抑制

- 最終載荷組成包括：
  - 助理文字（及可選的推理）
  - 內嵌工具摘要（當詳細模式且允許時）
  - 模型錯誤時的助理錯誤文字
- `NO_REPLY` 被視為靜默 token，會從輸出載荷過濾。
- 訊息工具重複項會從最終載荷清單中移除。
- 若無可呈現的載荷且工具發生錯誤，會發出備用的工具錯誤回覆（除非訊息工具已發送使用者可見回覆）。

## 壓縮與重試

- 自動壓縮會發出 `compaction` 流事件，並可能觸發重試。
- 在重試時，會重置記憶體緩衝區和工具摘要，以避免重複輸出。
- 請參考 [壓縮](/concepts/compaction) 了解壓縮流程。

## 事件流（目前）

- `lifecycle`：由 `subscribeEmbeddedPiSession` 發出（以及作為備援由 `agentCommand` 發出）
- `assistant`：來自 pi-agent-core 的串流差異
- `tool`：來自 pi-agent-core 的串流工具事件

## 聊天頻道處理

- 助理差異會緩衝成聊天 `delta` 訊息。
- 在 **生命週期結束/錯誤** 時會發出聊天 `final`。

## 超時

- `agent.wait` 預設：30秒（僅等待時間）。可由 `timeoutMs` 參數覆蓋。
- Agent 執行時間：`agents.defaults.timeoutSeconds` 預設 600 秒；由 `runEmbeddedPiAgent` 中的中止計時器強制執行。

## 可能提前結束的情況

- Agent 超時（中止）
- AbortSignal（取消）
- Gateway 斷線或 RPC 超時
- `agent.wait` 超時（僅等待，不會停止 agent）
