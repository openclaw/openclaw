---
summary: "Agent loop lifecycle, streams, and wait semantics"
read_when:
  - You need an exact walkthrough of the agent loop or lifecycle events
title: Agent Loop
---

# Agent Loop (OpenClaw)

一個代理迴圈是代理的完整“真實”執行：輸入 → 上下文組裝 → 模型推斷 → 工具執行 → 串流回覆 → 持久化。這是將訊息轉換為行動和最終回覆的權威路徑，同時保持會話狀態的一致性。

在 OpenClaw 中，迴圈是每個會話中單一的序列化執行，會在模型思考、呼叫工具和串流輸出時發出生命週期和串流事件。本文檔說明了這個真實的迴圈是如何端對端連接的。

## Entry points

- Gateway RPC: `agent` 和 `agent.wait`。
- CLI: `agent` 指令。

## 它是如何運作的（高層次）

1. `agent` RPC 驗證參數，解析會話 (sessionKey/sessionId)，持久化會話元數據，立即返回 `{ runId, acceptedAt }`。
2. `agentCommand` 執行代理：
   - 解析模型 + 思考/詳細預設值
   - 載入技能快照
   - 呼叫 `runEmbeddedPiAgent` (pi-agent-core 執行環境)
   - 如果嵌入的循環未發出，則發出 **生命週期結束/錯誤**
3. `runEmbeddedPiAgent`：
   - 通過每個會話 + 全局隊列序列化執行
   - 解析模型 + 認證設定並構建 pi 會話
   - 訂閱 pi 事件並串流助手/工具變更
   - 強制超時 -> 如果超過則中止執行
   - 返回有效負載 + 使用元數據
4. `subscribeEmbeddedPiSession` 將 pi-agent-core 事件橋接到 OpenClaw `agent` 串流：
   - 工具事件 => `stream: "tool"`
   - 助手變更 => `stream: "assistant"`
   - 生命週期事件 => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` 使用 `waitForAgentJob`：
   - 等待 **生命週期結束/錯誤** 以獲取 `runId`
   - 返回 `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## 排隊 + 並發性

- 每個會話金鑰（會話通道）的執行是序列化的，並且可以選擇通過全域通道進行。
- 這可以防止工具/會話之間的競爭，並保持會話歷史的一致性。
- 訊息通道可以選擇佇列模式（收集/引導/後續），這些模式會供應給這個通道系統。
  參見 [Command Queue](/concepts/queue)。

## Session + workspace 準備

- 工作區已解析並創建；沙盒執行可能會重定向到沙盒工作區根目錄。
- 技能已加載（或從快照中重用）並注入到環境和提示中。
- 引導/上下文檔案已解析並注入到系統提示報告中。
- 獲取會話寫入鎖；`SessionManager` 在串流之前已打開並準備好。

## Prompt assembly + system prompt

- 系統提示是由 OpenClaw 的基本提示、技能提示、啟動上下文和每次執行的覆蓋組成。
- 會強制執行特定於模型的限制和壓縮保留 token。
- 請參閱 [System prompt](/concepts/system-prompt) 以了解模型所見內容。

## Hook points (where you can intercept)

OpenClaw 有兩個掛鉤系統：

- **內部鉤子**（Gateway 鉤子）：用於命令和生命週期事件的事件驅動腳本。
- **插件鉤子**：在代理/工具生命週期和網關管道內的擴充點。

### 內部鉤子（閘道鉤子）

- **`agent:bootstrap`**：在系統提示尚未完成之前，執行以建立引導檔案。使用此功能來新增/移除引導上下文檔案。
- **命令鉤子**：`/new`、`/reset`、`/stop`，以及其他命令事件（請參閱鉤子文件）。

請參閱 [Hooks](/automation/hooks) 以獲取設置和範例。

### 插件鉤子（代理 + 閘道生命週期）

這些在代理迴圈或網關管道中執行：

- **`before_model_resolve`**: 在模型解析之前執行預先會話（不含 `messages`），以確定性地覆蓋提供者/模型。
- **`before_prompt_build`**: 在會話加載後執行（含 `messages`），以在提示提交之前注入 `prependContext`、`systemPrompt`、`prependSystemContext` 或 `appendSystemContext`。使用 `prependContext` 進行每回合的動態文本，並使用系統上下文欄位提供穩定的指導，這些應該放在系統提示空間中。
- **`before_agent_start`**: 遺留相容性鉤子，可以在任一階段執行；建議使用上面的明確鉤子。
- **`agent_end`**: 檢查最終消息列表並在完成後執行元數據。
- **`before_compaction` / `after_compaction`**: 觀察或註解壓縮週期。
- **`before_tool_call` / `after_tool_call`**: 攔截工具參數/結果。
- **`tool_result_persist`**: 在工具結果寫入會話記錄之前同步轉換工具結果。
- **`message_received` / `message_sending` / `message_sent`**: 進站 + 出站消息鉤子。
- **`session_start` / `session_end`**: 會話生命週期邊界。
- **`gateway_start` / `gateway_stop`**: 閘道生命週期事件。

請參閱 [Plugins](/tools/plugin#plugin-hooks) 以獲取掛鉤 API 和註冊詳細資訊。

## Streaming + 部分回覆

- 助手的增量是從 pi-agent-core 串流並作為 `assistant` 事件發出。
- 區塊串流可以在 `text_end` 或 `message_end` 上發出部分回覆。
- 推理串流可以作為單獨的串流或作為區塊回覆發出。
- 請參閱 [Streaming](/concepts/streaming) 以了解分塊和區塊回覆的行為。

## 工具執行 + 訊息工具

- 工具的開始/更新/結束事件會在 `tool` 流上發送。
- 工具結果在記錄/發送之前會對大小和影像負載進行清理。
- 訊息工具的發送會被追蹤，以抑制重複的助手確認。

## Reply shaping + suppression

- 最終的有效負載由以下組成：
  - 助手文本（及可選的推理）
  - 行內工具摘要（當啟用詳細模式且允許時）
  - 當模型出現錯誤時的助手錯誤文本
- `NO_REPLY` 被視為靜默標記，並從外發的有效負載中過濾。
- 最終有效負載列表中會移除消息工具的重複項。
- 如果沒有可渲染的有效負載且某個工具出現錯誤，則會發出後備工具錯誤回覆
  （除非某個消息工具已經發送了可見的用戶回覆）。

## Compaction + retries

- 自動壓縮會發出 `compaction` 流事件並可以觸發重試。
- 在重試時，記憶體緩衝區和工具摘要會被重置，以避免重複輸出。
- 請參閱 [Compaction](/concepts/compaction) 以了解壓縮管道。

## 事件串流（今日）

- `lifecycle`: 由 `subscribeEmbeddedPiSession` 發出（並作為備用由 `agentCommand` 發出）
- `assistant`: 來自 pi-agent-core 的串流增量
- `tool`: 來自 pi-agent-core 的串流工具事件

## 聊天頻道處理

- 助手的變更會被緩衝到聊天 `delta` 訊息中。
- 在 **生命週期結束/錯誤** 時會發出聊天 `final`。

## Timeouts

- `agent.wait` 預設：30秒（僅為等待時間）。 `timeoutMs` 參數覆蓋。
- 代理執行時間：`agents.defaults.timeoutSeconds` 預設為600秒；在 `runEmbeddedPiAgent` 中強制執行中止計時器。

## 事情可能提前結束的地方

- 代理逾時 (中止)
- 中止信號 (取消)
- 網關斷線或 RPC 逾時
- `agent.wait` 逾時 (僅等待，不會停止代理)
