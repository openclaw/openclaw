---
summary: "智慧代理工作階段工具，用於列出工作階段、獲取歷程記錄以及發送跨工作階段訊息"
read_when:
  - 新增或修改工作階段工具時
title: "工作階段工具"
---

# 工作階段工具

目標：精簡、不易誤用的工具集，讓智慧代理能夠列出工作階段、獲取歷程記錄，並發送到另一個工作階段。

## 工具名稱

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 關鍵模型

- 主要直接對話存儲桶始終是字面鍵名 `"main"` (解析為當前智慧代理的主鍵)。
- 群組對話使用 `agent:<agentId>:<channel>:group:<id>` 或 `agent:<agentId>:<channel>:channel:<id>` (傳遞完整鍵名)。
- 排程作業 (Cron jobs) 使用 `cron:<job.id>`。
- Hooks 使用 `hook:<uuid>`，除非有明確設定。
- Node 工作階段使用 `node-<nodeId>`，除非有明確設定。

`global` 和 `unknown` 是保留值且永遠不會被列出。如果 `session.scope = "global"`，我們會為所有工具將其別名為 `main`，以便呼叫者永遠看不到 `global`。

## sessions_list

以資料列陣列的形式列出工作階段。

參數：

- `kinds?: string[]` 篩選：`"main" | "group" | "cron" | "hook" | "node" | "other"` 中的任一項
- `limit?: number` 最大列數 (預設：伺服器預設值，限制如 200)
- `activeMinutes?: number` 僅包含在 N 分鐘內更新的工作階段
- `messageLimit?: number` 0 = 不包含訊息 (預設為 0)；>0 = 包含最後 N 則訊息

行為：

- `messageLimit > 0` 會獲取每個工作階段的 `chat.history` 並包含最後 N 則訊息。
- 工具結果會在列表輸出中過濾掉；請使用 `sessions_history` 獲取工具訊息。
- 在**沙箱隔離**的智慧代理工作階段中執行時，工作階段工具預設僅具有**生成的能見度** (見下文)。

資料列結構 (JSON)：

- `key`: 工作階段鍵名 (字串)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (如果有群組顯示標籤)
- `updatedAt` (毫秒)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (如果有工作階段覆寫設定)
- `lastChannel`, `lastTo`
- `deliveryContext` (可用時標準化的 `{ channel, to, accountId }`)
- `transcriptPath` (根據儲存目錄 + sessionId 推導出的最佳路徑)
- `messages?` (僅當 `messageLimit > 0` 時)

## sessions_history

獲取單一工作階段的對話紀錄。

參數：

- `sessionKey` (必填；接受工作階段鍵名或來自 `sessions_list` 的 `sessionId`)
- `limit?: number` 最大訊息數 (伺服器限制)
- `includeTools?: boolean` (預設為 false)

行為：

- `includeTools=false` 會過濾掉 `role: "toolResult"` 的訊息。
- 以原始對話紀錄格式返回訊息陣列。
- 給予 `sessionId` 時，OpenClaw 會將其解析為對應的工作階段鍵名 (找不到 ID 則報錯)。

## sessions_send

將訊息發送到另一個工作階段。

參數：

- `sessionKey` (必填；接受工作階段鍵名或來自 `sessions_list` 的 `sessionId`)
- `message` (必填)
- `timeoutSeconds?: number` (預設 >0；0 = 發送後即忽略)

行為：

- `timeoutSeconds = 0`：排入佇列並返回 `{ runId, status: "accepted" }`。
- `timeoutSeconds > 0`：等待最多 N 秒以完成，然後返回 `{ runId, status: "ok", reply }`。
- 如果等待逾時：`{ runId, status: "timeout", error }`。執行仍會繼續；稍後可呼叫 `sessions_history`。
- 如果執行失敗：`{ runId, status: "error", error }`。
- 公告發送 (Announce delivery) 會在主要執行完成後進行，且屬於盡力而為；`status: "ok"` 不保證公告已送達。
- 透過 Gateway `agent.wait` (伺服器端) 進行等待，因此重新連線不會遺失等待狀態。
- 智慧代理對智慧代理 (Agent-to-agent) 的訊息內容會注入到主要執行中。
- 工作階段間的訊息會以 `message.provenance.kind = "inter_session"` 進行持久化，以便對話紀錄讀取器區分路由的智慧代理指令與外部使用者輸入。
- 主要執行完成後，OpenClaw 會執行 **回覆迴圈 (reply-back loop)**：
  - 第 2 輪及之後會在請求與目標智慧代理之間交替。
  - 回覆內容若完全符合 `REPLY_SKIP` 則停止來回。
  - 最大輪次為 `session.agentToAgent.maxPingPongTurns` (0–5，預設為 5)。
- 迴圈結束後，OpenClaw 會執行 **智慧代理對智慧代理公告步驟** (僅限目標智慧代理)：
  - 回覆內容若完全符合 `ANNOUNCE_SKIP` 則保持沉默。
  - 任何其他回覆都會發送到目標頻道。
  - 公告步驟包含原始請求 + 第 1 輪回覆 + 最新的來回回覆。

## 頻道欄位 (Channel Field)

- 對於群組，`channel` 是工作階段條目中紀錄的頻道。
- 對於直接對話，`channel` 映射自 `lastChannel`。
- 對於 cron/hook/node，`channel` 為 `internal`。
- 如果缺失，`channel` 為 `unknown`。

## 安全性 / 發送策略 (Security / Send Policy)

依據頻道/對話類型 (而非工作階段 ID) 進行基於策略的封鎖。

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

執行時期覆寫 (針對個別工作階段條目)：

- `sendPolicy: "allow" | "deny"` (未設定 = 繼承設定)
- 可透過 `sessions.patch` 或僅限擁有者的 `/send on|off|inherit` (獨立訊息) 進行設定。

強制執行點：

- `chat.send` / `agent` (Gateway)
- 自動回覆遞送邏輯

## sessions_spawn

在隔離的工作階段中生成子智慧代理執行，並將結果公告回請求者的對話頻道。

參數：

- `task` (必填)
- `label?` (選填；用於日誌/UI)
- `agentId?` (選填；如果允許，在另一個智慧代理 ID 下生成)
- `model?` (選填；覆寫子智慧代理模型；無效值會報錯)
- `runTimeoutSeconds?` (預設為 0；設定時，在 N 秒後中止子智慧代理執行)
- `cleanup?` (`delete|keep`，預設為 `keep`)

允許清單：

- `agents.list[].subagents.allowAgents`：允許透過 `agentId` 使用的智慧代理 ID 列表 (`["*"]` 允許所有)。預設：僅限請求智慧代理。

探索：

- 使用 `agents_list` 來探索哪些智慧代理 ID 允許用於 `sessions_spawn`。

行為：

- 啟動一個新的 `agent:<agentId>:subagent:<uuid>` 工作階段，並設定 `deliver: false`。
- 子智慧代理預設擁有完整的工具集，但**不包含工作階段工具** (可透過 `tools.subagents.tools` 設定)。
- 子智慧代理不允許呼叫 `sessions_spawn` (禁止子智慧代理再生成子智慧代理)。
- 始終為非阻塞：立即返回 `{ status: "accepted", runId, childSessionKey }`。
- 完成後，OpenClaw 會執行子智慧代理**公告步驟**，並將結果發布到請求者的對話頻道。
- 在公告步驟期間回覆 `ANNOUNCE_SKIP` 可保持沉默。
- 公告回覆會標準化為 `Status`/`Result`/`Notes`；`Status` 來自執行結果 (而非模型文字)。
- 子智慧代理工作階段會在 `agents.defaults.subagents.archiveAfterMinutes` (預設：60) 之後自動封存。
- 公告回覆包含統計行 (執行時間、Token、sessionKey/sessionId、對話紀錄路徑，以及選填的成本)。

## 沙箱工作階段能見度 (Sandbox Session Visibility)

沙箱隔離的工作階段可以使用工作階段工具，但預設情況下，它們只能看到透過 `sessions_spawn` 生成的工作階段。

設定：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // 預設值: "spawned"
        sessionToolsVisibility: "spawned", // 或 "all"
      },
    },
  },
}
```
