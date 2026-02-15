---
summary: "智慧代理迴圈生命週期、串流與等待語義"
read_when:
  - 您需要智慧代理迴圈或生命週期事件的確切流程說明時
title: "智慧代理迴圈"
---

# 智慧代理迴圈 (OpenClaw)

智慧代理迴圈（Agentic loop）是智慧代理一次完整的「實際」執行：接收輸入 → 組合內容 → 模型推論 → 工具執行 → 串流回覆 → 持久化。這是將訊息轉換為行動與最終回覆，同時保持工作階段狀態一致性的權威路徑。

在 OpenClaw 中，迴圈是每個工作階段的單次序列化執行，隨模型思考、呼叫工具與串流輸出時發送生命週期與串流事件。本文件將說明此權威迴圈如何端到端地運作。

## 進入點

- Gateway RPC: `agent` 和 `agent.wait`。
- CLI: `agent` 指令。

## 運作方式（高階概覽）

1. `agent` RPC 驗證參數、解析工作階段 (sessionKey/sessionId)、持久化工作階段中繼資料，並立即返回 `{ runId, acceptedAt }`。
2. `agentCommand` 執行智慧代理：
   - 解析模型 + 思考/詳細（verbose）預設值
   - 載入 Skills 快照
   - 呼叫 `runEmbeddedPiAgent` (pi-agent-core 執行階段)
   - 如果嵌入式迴圈未發送生命週期事件，則發送 **lifecycle end/error**
3. `runEmbeddedPiAgent`:
   - 透過每個工作階段 + 全域佇列序列化執行
   - 解析模型 + 認證設定檔並建立 pi 工作階段
   - 訂閱 pi 事件並串流 assistant/tool 差異（deltas）
   - 執行逾時限制 -> 超過則中斷執行
   - 回傳內容（payloads）+ 使用量中繼資料
4. `subscribeEmbeddedPiSession` 將 pi-agent-core 事件橋接到 OpenClaw `agent` 串流：
   - 工具事件 => `stream: "tool"`
   - 助手差異 => `stream: "assistant"`
   - 生命週期事件 => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` 使用 `waitForAgentJob`:
   - 等待 `runId` 的 **lifecycle end/error**
   - 回傳 `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## 佇列 + 並行處理

- 執行是按工作階段金鑰（工作階段通道）序列化的，也可以選擇透過全域通道。
- 這能防止工具/工作階段競態（races），並保持工作階段歷史紀錄的一致性。
- 通訊頻道可以選擇佇列模式（收集/引導/追蹤），並饋入此通道系統。請參閱 [命令佇列](/concepts/queue)。

## 工作階段 + 工作區準備

- 工作區（Workspace）已解析並建立；沙箱隔離執行可能會重新導向到沙箱工作區根目錄。
- Skills 已載入（或從快照重複使用）並注入到環境變數與提示詞中。
- 引導（Bootstrap）/內容檔案已解析並注入到系統提示詞報告中。
- 取得工作階段寫入鎖定；`SessionManager` 在串流前已開啟並準備就緒。

## 提示詞組合 + 系統提示詞

- 系統提示詞是由 OpenClaw 基礎提示詞、Skills 提示詞、引導內容以及每次執行的覆寫所構成。
- 執行模型特定的限制與壓縮保留權杖（compaction reserve tokens）。
- 請參閱 [系統提示詞](/concepts/system-prompt) 了解模型看到的內容。

## 掛鉤點（可攔截處）

OpenClaw 有兩個掛鉤（hook）系統：

- **內部掛鉤** (Gateway hooks)：用於指令與生命週期事件的事件驅動指令碼。
- **外掛掛鉤** (Plugin hooks)：智慧代理/工具生命週期與 Gateway 管線內部的擴充點。

### 內部掛鉤 (Gateway hooks)

- **`agent:bootstrap`**: 在系統提示詞最終確定前，建立引導檔案時執行。用於新增/移除引導內容檔案。
- **指令掛鉤**: `/new`, `/reset`, `/stop` 等指令事件（請參閱掛鉤文件）。

請參閱 [掛鉤](/automation/hooks) 了解設定與範例。

### 外掛掛鉤（智慧代理 + Gateway 生命週期）

這些掛鉤在智慧代理迴圈或 Gateway 管線內部執行：

- **`before_agent_start`**: 在執行開始前注入內容或覆寫系統提示詞。
- **`agent_end`**: 在完成後檢查最終訊息列表與執行中繼資料。
- **`before_compaction` / `after_compaction`**: 觀察或註記壓縮週期。
- **`before_tool_call` / `after_tool_call`**: 攔截工具參數/結果。
- **`tool_result_persist`**: 在工具結果寫入工作階段逐字稿前進行同步轉換。
- **`message_received` / `message_sending` / `message_sent`**: 入站 + 出站訊息掛鉤。
- **`session_start` / `session_end`**: 工作階段生命週期邊界。
- **`gateway_start` / `gateway_stop`**: Gateway 生命週期事件。

請參閱 [外掛](/tools/plugin#plugin-hooks) 了解掛鉤 API 與註冊詳情。

## 串流 + 部分回覆

- 助手差異從 pi-agent-core 串流傳輸，並以 `assistant` 事件發送。
- 區塊串流傳輸可以在 `text_end` 或 `message_end` 發送部分回覆。
- 推理串流可以作為獨立串流或作為區塊回覆發送。
- 請參閱 [串流](/concepts/streaming) 了解分塊與區塊回覆行為。

## 工具執行 + 通訊工具

- 工具開始/更新/結束事件在 `tool` 串流中發送。
- 工具結果在記錄/發送前會針對大小與圖片內容進行清理。
- 通訊工具的傳送會被追蹤，以抑制重複的助手確認訊息。

## 回覆成形 + 抑制

- 最終內容由以下部分組合：
  - 助手文字（與選用的推理內容）
  - 行內工具摘要（當啟用詳細模式且允許時）
  - 模型出錯時的助手錯誤文字
- `NO_REPLY` 被視為靜默權杖，並從輸出內容中過濾。
- 從最終內容列表中移除重複的通訊工具。
- 如果沒有剩餘可呈現的內容且工具出錯，則發送備援工具錯誤回覆（除非通訊工具已傳送使用者可見的回覆）。

## 壓縮 + 重試

- 自動壓縮發送 `compaction` 串流事件，並可觸發重試。
- 重試時，記憶體緩衝區與工具摘要會重設，以避免重複輸出。
- 請參閱 [壓縮](/concepts/compaction) 了解壓縮管線。

## 事件串流（目前狀態）

- `lifecycle`: 由 `subscribeEmbeddedPiSession` 發送（或作為 `agentCommand` 的備援）
- `assistant`: 來自 pi-agent-core 的串流差異
- `tool`: 來自 pi-agent-core 的串流工具事件

## 聊天頻道處理

- 助手差異會緩衝到聊天 `delta` 訊息中。
- 在 **lifecycle end/error** 時發送聊天 `final`。

## 逾時

- `agent.wait` 預設：30s（僅等待）。`timeoutMs` 參數可覆寫。
- 智慧代理執行階段：`agents.defaults.timeoutSeconds` 預設 600s；在 `runEmbeddedPiAgent` 的中止計時器中執行。

## 可能提前結束之處

- 智慧代理逾時 (中止)
- AbortSignal (取消)
- Gateway 斷線或 RPC 逾時
- `agent.wait` 逾時（僅等待，不會停止智慧代理）
