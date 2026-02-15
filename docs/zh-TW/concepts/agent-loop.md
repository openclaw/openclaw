---
summary: "智慧代理迴圈的生命週期、串流和等待語意"
read_when:
  - 當您需要精確了解智慧代理迴圈或生命週期事件時
title: "智慧代理迴圈"
---

# 智慧代理迴圈 (OpenClaw)

智慧代理迴圈是智慧代理的完整「實際」執行流程：資料攝取 → 上下文組裝 → 模型推論 → 工具執行 → 串流回覆 → 持久化。這是一條權威路徑，它將訊息轉化為動作和最終回覆，同時保持工作階段狀態的一致性。

在 OpenClaw 中，迴圈是每個工作階段一次單一、序列化的執行，當模型思考、呼叫工具並串流輸出時，會發出生命週期和串流事件。這份文件解釋了這個真實迴圈是如何端對端連接的。

## 進入點

- Gateway RPC: `agent` 和 `agent.wait`。
- CLI: `agent` 指令。

## 運作方式 (高階)

1.  `agent` RPC 會驗證參數，解析工作階段 (sessionKey/sessionId)，持久化工作階段中繼資料，並立即回傳 `{ runId, acceptedAt }`。
2.  `agentCommand` 執行智慧代理：
    -   解析模型 + 思考/詳細預設
    -   載入 Skills 快照
    -   呼叫 `runEmbeddedPiAgent` (pi-agent-core 執行時環境)
    -   如果嵌入式迴圈未發出，則發出**生命週期結束/錯誤**
3.  `runEmbeddedPiAgent`：
    -   透過每個工作階段 + 全域佇列序列化執行
    -   解析模型 + 憑證設定檔並建立 pi 工作階段
    -   訂閱 pi 事件並串流助理/工具增量
    -   強制逾時 -> 若超出則中止執行
    -   回傳酬載 + 使用量中繼資料
4.  `subscribeEmbeddedPiSession` 將 pi-agent-core 事件橋接到 OpenClaw `agent` 串流：
    -   工具事件 => `stream: "tool"`
    -   助理增量 => `stream: "assistant"`
    -   生命週期事件 => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5.  `agent.wait` 使用 `waitForAgentJob`：
    -   等待 `runId` 的**生命週期結束/錯誤**
    -   回傳 `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## 佇列 + 並行

執行是透過每個工作階段金鑰（工作階段通道）以及可選的全域通道進行序列化的。
這可以防止工具/工作階段競爭並保持工作階段歷史的一致性。
訊息通道可以選擇佇列模式（收集/引導/追蹤）來提供此通道系統。請參閱 [指令佇列](/concepts/queue)。

## 工作階段 + 工作區準備

工作區被解析並建立；沙箱隔離執行可能會重新導向到沙箱工作區根目錄。
Skills 被載入（或從快照中重複使用）並注入到環境和提示中。
啟動/上下文檔案被解析並注入到系統提示報告中。
取得工作階段寫入鎖；在串流之前，`SessionManager` 已開啟並準備好。

## 提示組裝 + 系統提示

系統提示是從 OpenClaw 的基礎提示、Skills 提示、啟動上下文和每個執行的覆寫中建立的。
強制執行模型特定的限制和壓縮保留權杖。
請參閱 [系統提示](/concepts/system-prompt) 以了解模型所看到的內容。

## 鉤子點 (您可以攔截的地方)

OpenClaw 有兩個鉤子系統：

-   **內部鉤子** (Gateway 鉤子)：用於指令和生命週期事件的事件驅動腳本。
-   **外掛鉤子**：智慧代理/工具生命週期和 Gateway 管線內部的擴充點。

### 內部鉤子 (Gateway 鉤子)

-   `agent:bootstrap`：在系統提示定稿之前，建立啟動檔案時執行。使用此選項可新增/移除啟動上下文檔案。
-   指令鉤子：`/new`、`/reset`、`/stop` 和其他指令事件（請參閱鉤子文件）。

請參閱 [鉤子](/automation/hooks) 以了解設定和範例。

### 外掛鉤子 (智慧代理 + Gateway 生命週期)

這些在智慧代理迴圈或 Gateway 管線內部執行：

-   `before_agent_start`：在執行開始之前注入上下文或覆寫系統提示。
-   `agent_end`：完成後檢查最終訊息列表和執行中繼資料。
-   `before_compaction` / `after_compaction`：觀察或註解壓縮週期。
-   `before_tool_call` / `after_tool_call`：攔截工具參數/結果。
-   `tool_result_persist`：在工具結果寫入工作階段記錄之前，同步轉換它們。
-   `message_received` / `message_sending` / `message_sent`：入站 + 出站訊息鉤子。
-   `session_start` / `session_end`：工作階段生命週期邊界。
-   `gateway_start` / `gateway_stop`：Gateway 生命週期事件。

請參閱 [外掛](/tools/plugin#plugin-hooks) 以了解鉤子 API 和註冊詳情。

## 串流 + 部分回覆

助理增量從 pi-agent-core 串流傳輸，並作為 `assistant` 事件發出。
區塊串流傳輸可以在 `text_end` 或 `message_end` 時發出部分回覆。
推理串流可以作為單獨的串流或作為區塊回覆發出。
請參閱 [串流](/concepts/streaming) 以了解分塊和區塊回覆行為。

## 工具執行 + 訊息工具

工具開始/更新/結束事件在 `tool` 串流上發出。
工具結果在記錄/發出之前會針對大小和圖片酬載進行清理。
訊息工具的發送會被追蹤，以抑制重複的助理確認。

## 回覆塑形 + 抑制

最終酬載由以下內容組裝而成：
-   助理文字（以及可選的推理）
-   行內工具摘要（當詳細模式 + 允許時）
-   模型出錯時的助理錯誤文字
`NO_REPLY` 被視為一個靜默權杖，並從出站酬載中過濾掉。
訊息工具的重複項將從最終酬載列表中移除。
如果沒有可渲染的酬載且工具出錯，則會發出一個備用工具錯誤回覆（除非訊息工具已經發送了使用者可見的回覆）。

## 壓縮 + 重試

自動壓縮會發出 `compaction` 串流事件並可以觸發重試。
重試時，記憶體緩衝區和工具摘要會被重設，以避免重複輸出。
請參閱 [壓縮](/concepts/compaction) 以了解壓縮管線。

## 事件串流 (目前)

-   `lifecycle`：由 `subscribeEmbeddedPiSession` 發出（並作為 `agentCommand` 的備用）
-   `assistant`：從 pi-agent-core 串流傳輸的增量
-   `tool`：從 pi-agent-core 串流傳輸的工具事件

## 聊天頻道處理

助理增量被緩衝到聊天 `delta` 訊息中。
聊天 `final` 在**生命週期結束/錯誤**時發出。

## 逾時

-   `agent.wait` 預設：30 秒（僅等待）。`timeoutMs` 參數會覆寫。
-   智慧代理執行時：`agents.defaults.timeoutSeconds` 預設 600 秒；在 `runEmbeddedPiAgent` 中止計時器中強制執行。

## 可能提前結束的情境

-   智慧代理逾時（中止）
-   AbortSignal（取消）
-   Gateway 斷線或 RPC 逾時
-   `agent.wait` 逾時（僅等待，不會停止智慧代理）
