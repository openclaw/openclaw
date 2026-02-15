---
summary: "智慧代理工作階段工具，用於列出工作階段、擷取歷史記錄和傳送跨工作階段訊息"
read_when:
  - 新增或修改工作階段工具時
title: "工作階段工具"
---

# 工作階段工具

目標：一套小型、不易誤用的工具集，讓智慧代理能夠列出工作階段、擷取歷史記錄並傳送至另一個工作階段。

## 工具名稱

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 主要模型

- 主要直接聊天儲存桶始終是字面量鍵值 `"main"` (解析為當前智慧代理的主要鍵值)。
- 群組聊天使用 `agent:<agentId>:<channel>:group:<id>` 或 `agent:<agentId>:<channel>:channel:<id>` (傳遞完整鍵值)。
- Cron 工作使用 `cron:<job.id>`。
- Hooks 使用 `hook:<uuid>`，除非明確設定。
- 節點工作階段使用 `node-<nodeId>`，除非明確設定。

`global` 和 `unknown` 是保留值，永不列出。如果 `session.scope = "global"`，我們將其別名為 `main`，供所有工具使用，以便呼叫者永不看到 `global`。

## sessions_list

將工作階段列為列陣列。

參數：

- `kinds?: string[]` 篩選器：`"main" | "group" | "cron" | "hook" | "node" | "other"` 中任何一個
- `limit?: number` 最大列數 (預設：伺服器預設值，例如限制為 200)
- `activeMinutes?: number` 僅在 N 分鐘內更新的工作階段
- `messageLimit?: number` 0 = 無訊息 (預設 0)；>0 = 包含最後 N 條訊息

行為：

- `messageLimit > 0` 會針對每個工作階段擷取 `chat.history` 並包含最後 N 條訊息。
- 工具結果會在清單輸出中被篩選掉；工具訊息請使用 `sessions_history`。
- 當在 **沙箱隔離** 智慧代理工作階段中執行時，工作階段工具預設為 **僅限生成的可見性** (請參閱下方)。

列形狀 (JSON)：

- `key`：工作階段鍵值 (字串)
- `kind`：`main | group | cron | hook | node | other`
- `channel`：`whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (如果可用，為群組顯示標籤)
- `updatedAt` (毫秒)
- `sessionId`
- `model`、`contextTokens`、`totalTokens`
- `thinkingLevel`、`verboseLevel`、`systemSent`、`abortedLastRun`
- `sendPolicy` (如果設定，則為工作階段覆寫)
- `lastChannel`、`lastTo`
- `deliveryContext` (可用時為標準化 `{ channel, to, accountId }`)
- `transcriptPath` (從儲存目錄 + `sessionId` 衍生出的最佳路徑)
- `messages?` (僅當 `messageLimit > 0` 時)

## sessions_history

擷取單一工作階段的對話紀錄。

參數：

- `sessionKey` (必填；接受 `sessions_list` 中的工作階段鍵值或 `sessionId`)
- `limit?: number` 最大訊息數 (伺服器限制)
- `includeTools?: boolean` (預設為 false)

行為：

- `includeTools=false` 會篩選 `role: "toolResult"` 訊息。
- 以原始對話紀錄格式傳回訊息陣列。
- 當給定 `sessionId` 時，OpenClaw 會將其解析為對應的工作階段鍵值 (缺少 ID 會出錯)。

## sessions_send

傳送訊息到另一個工作階段。

參數：

- `sessionKey` (必填；接受 `sessions_list` 中的工作階段鍵值或 `sessionId`)
- `message` (必填)
- `timeoutSeconds?: number` (預設 >0；0 = 發送後不等待回應)

行為：

- `timeoutSeconds = 0`：將訊息排入佇列並傳回 `{ runId, status: "accepted" }`。
- `timeoutSeconds > 0`：等待最多 N 秒以完成，然後傳回 `{ runId, status: "ok", reply }`。
- 如果等待逾時：`{ runId, status: "timeout", error }`。執行會繼續；稍後呼叫 `sessions_history`。
- 如果執行失敗：`{ runId, status: "error", error }`。
- 宣告傳送會在主要執行完成後執行，並且是盡力而為；`status: "ok"` 不保證宣告已送達。
- 透過 Gateway `agent.wait` (伺服器端) 等待，因此重新連線不會中斷等待。
- 智慧代理到智慧代理的訊息上下文會注入到主要執行中。
- 跨工作階段訊息會以 `message.provenance.kind = "inter_session"` 持久化，以便對話紀錄讀取器可以區分路由的智慧代理指令與外部使用者輸入。
- 主要執行完成後，OpenClaw 會執行一個 **回覆循環**：
- 第 2+ 輪在請求者和目標智慧代理之間交替。
- 精確回覆 `REPLY_SKIP` 以停止來回傳遞。
- 最大輪數為 `session.agentToAgent.maxPingPongTurns` (0–5，預設 5)。
- 循環結束後，OpenClaw 會執行 **智慧代理到智慧代理宣告步驟** (僅限目標智慧代理)：
- 精確回覆 `ANNOUNCE_SKIP` 以保持靜默。
- 任何其他回覆都會傳送至目標頻道。
- 宣告步驟包括原始請求 + 第 1 輪回覆 + 最新來回傳遞的回覆。

## 頻道欄位

- 對於群組，`channel` 是工作階段條目上記錄的頻道。
- 對於直接聊天，`channel` 從 `lastChannel` 對應。
- 對於 cron/hook/node，`channel` 是 `internal`。
- 如果遺失，`channel` 是 `unknown`。

## 安全性 / 傳送策略

基於策略的按頻道/聊天類型封鎖 (非每個工作階段 ID)。

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

執行時覆寫 (每個工作階段條目)：

- `sendPolicy: "allow" | "deny"` (未設定 = 繼承設定)
- 可透過 `sessions.patch` 或僅限擁有者的 `/send on|off|inherit` (獨立訊息) 設定。

強制執行點：

- `chat.send` / `agent` (Gateway)
- 自動回覆傳送邏輯

## sessions_spawn

在隔離的工作階段中生成子智慧代理執行，並將結果回報給請求者的聊天頻道。

參數：

- `task` (必填)
- `label?` (選填；用於日誌/使用者介面)
- `agentId?` (選填；如果允許，可在另一個智慧代理 ID 下生成)
- `model?` (選填；覆寫子智慧代理模型；無效值會出錯)
- `runTimeoutSeconds?` (預設 0；設定後，N 秒後中止子智慧代理執行)
- `cleanup?` (`delete|keep`，預設 `keep`)

允許清單：

- `agents.list[].subagents.allowAgents`：透過 `agentId` 允許的智慧代理 ID 清單 (`` `["*"]` `` 允許任何)。預設：僅限請求者智慧代理。

裝置探索：

- 使用 `agents_list` 探索哪些智慧代理 ID 允許用於 `sessions_spawn`。

行為：

- 啟動一個新的 `agent:<agentId>:subagent:<uuid>` 工作階段，並設定 `deliver: false`。
- 子智慧代理預設為完整的工具集，**減去工作階段工具** (可透過 `tools.subagents.tools` 設定)。
- 子智慧代理不允許呼叫 `sessions_spawn` (沒有子智慧代理 → 子智慧代理生成)。
- 始終非阻塞：立即傳回 `{ status: "accepted", runId, childSessionKey }`。
- 完成後，OpenClaw 會執行一個子智慧代理 **宣告步驟**，並將結果發布到請求者的聊天頻道。
- 在宣告步驟中精確回覆 `ANNOUNCE_SKIP` 以保持靜默。
- 宣告回覆會標準化為 `Status`/`Result`/`Notes`；`Status` 來自執行時結果 (而非模型文本)。
- 子智慧代理工作階段會在 `agents.defaults.subagents.archiveAfterMinutes` (預設：60) 後自動歸檔。
- 宣告回覆包括統計資訊行 (執行時、權杖、`sessionKey`/`sessionId`、對話紀錄路徑以及可選成本)。

## 沙箱隔離工作階段可見性

沙箱隔離工作階段可以使用工作階段工具，但預設情況下，它們只能看到透過 `sessions_spawn` 生成的工作階段。

設定：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
