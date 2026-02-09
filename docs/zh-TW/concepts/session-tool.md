---
summary: "用於列出工作階段、擷取歷史紀錄，以及傳送跨工作階段訊息的代理程式工作階段工具"
read_when:
  - 新增或修改工作階段工具
title: "工作階段工具"
---

# 工作階段工具

目標：提供一組小巧且不易誤用的工具，讓代理程式可以列出工作階段、擷取歷史紀錄，並傳送訊息到另一個工作階段。

## 工具名稱

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 金鑰模型

- 主要直接聊天桶一律是字面鍵值 `"main"`（解析為目前代理的主要鍵）。
- 群組聊天使用 `agent:<agentId>:<channel>:group:<id>` 或 `agent:<agentId>:<channel>:channel:<id>`（需傳入完整金鑰）。
- 排程工作使用 `cron:<job.id>`。
- Hooks 除非明確設定，否則使用 `hook:<uuid>`。
- Node 工作階段除非明確設定，否則使用 `node-<nodeId>`。

`global` 與 `unknown` 為保留值，且永不列出。 `global` 與 `unknown` 為保留值，且永遠不會被列出。若為 `session.scope = "global"`，我們會在所有工具中將其別名為 `main`，以確保呼叫端永遠不會看到 `global`。

## sessions_list

將工作階段列為一個列（rows）陣列。

參數：

- `kinds?: string[]` 篩選：`"main" | "group" | "cron" | "hook" | "node" | "other"` 之一
- `limit?: number` 最大列數（預設：伺服器預設值，會限制，例如 200）
- `activeMinutes?: number` 僅列出在 N 分鐘內更新的工作階段
- `messageLimit?: number` 0 = 不包含訊息（預設 0）；>0 = 包含最後 N 則訊息

行為：

- `messageLimit > 0` 會為每個工作階段擷取 `chat.history`，並包含最後 N 則訊息。
- 工具結果會從清單輸出中過濾；如需工具訊息，請使用 `sessions_history`。
- 在 **沙盒化** 的代理工作階段中執行時，工作階段工具預設為 **僅限已生成可見性**（見下文）。

列結構（JSON）：

- `key`：工作階段金鑰（string）
- `kind`：`main | group | cron | hook | node | other`
- `channel`：`whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName`（若可用的群組顯示標籤）
- `updatedAt`（毫秒）
- `sessionId`
- `model`、`contextTokens`、`totalTokens`
- `thinkingLevel`、`verboseLevel`、`systemSent`、`abortedLastRun`
- `sendPolicy`（若有設定的工作階段覆寫）
- `lastChannel`、`lastTo`
- `deliveryContext`（可用時的正規化 `{ channel, to, accountId }`）
- `transcriptPath`（由儲存目錄 + sessionId 推導的最佳努力路徑）
- `messages?`（僅在 `messageLimit > 0` 時）

## sessions_history

擷取單一工作階段的逐字稿。

參數：

- `sessionKey`（必要；接受工作階段金鑰或來自 `sessions_list` 的 `sessionId`）
- `limit?: number` 最大訊息數（伺服器會限制）
- `includeTools?: boolean`（預設 false）

行為：

- `includeTools=false` 會篩選 `role: "toolResult"` 訊息。
- 回傳原始逐字稿格式的訊息陣列。
- 當提供 `sessionId` 時，OpenClaw 會將其解析為對應的工作階段金鑰（缺少 id 會報錯）。

## sessions_send

將訊息送入另一個工作階段。

參數：

- `sessionKey`（必要；接受工作階段金鑰或來自 `sessions_list` 的 `sessionId`）
- `message`（必要）
- `timeoutSeconds?: number`（預設 >0；0 = 發送即不等待）

行為：

- `timeoutSeconds = 0`：加入佇列並回傳 `{ runId, status: "accepted" }`。
- `timeoutSeconds > 0`：最多等待 N 秒完成，然後回傳 `{ runId, status: "ok", reply }`。
- 若等待逾時：`{ runId, status: "timeout", error }`。 若等待逾時：`{ runId, status: "timeout", error }`。執行仍會繼續；可稍後呼叫 `sessions_history`。
- 若執行失敗：`{ runId, status: "error", error }`。
- 宣告（announce）傳遞會在主要執行完成後進行，且為最佳努力；`status: "ok"` 不保證宣告一定送達。
- 透過 Gateway 閘道器的 `agent.wait`（伺服器端）進行等待，因此重新連線不會中斷等待。
- 主要執行會注入代理對代理的訊息內容。
- 主要執行完成後，OpenClaw 會執行 **回覆往返迴圈**：
  - 第 2 輪以上在請求方與目標代理之間交替。
  - 回覆必須完全等於 `REPLY_SKIP` 才會停止來回。
  - 最大回合數為 `session.agentToAgent.maxPingPongTurns`（0–5，預設 5）。
- 迴圈結束後，OpenClaw 會執行 **代理程式對代理程式宣告步驟**（僅目標代理程式）：
  - 回覆必須完全等於 `ANNOUNCE_SKIP` 才會保持靜默。
  - 任何其他回覆都會送到目標頻道。
  - 公告步驟包含原始請求 + 第 1 輪回覆 + 最新的來回回覆。

## Channel 欄位

- 對於群組，`channel` 為記錄在工作階段項目上的頻道。
- 對於直接聊天，`channel` 會從 `lastChannel` 對應而來。
- 對於 cron/hook/node，`channel` 為 `internal`。
- 若缺少，`channel` 為 `unknown`。

## 安全性／傳送政策

依頻道／聊天類型（非依工作階段 id）的政策式封鎖。

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

執行期覆寫（每個工作階段項目）：

- `sendPolicy: "allow" | "deny"`（未設定 = 繼承設定）
- 可透過 `sessions.patch` 或僅限擁有者的 `/send on|off|inherit`（獨立訊息）設定。

強制執行點：

- `chat.send`／`agent`（Gateway 閘道器）
- 自動回覆傳遞邏輯

## sessions_spawn

在隔離的工作階段中生成子代理程式執行，並將結果宣告回請求者的聊天頻道。

參數：

- `task`（必要）
- `label?`（選用；用於日誌／UI）
- `agentId?`（選用；若允許，可在另一個代理程式 id 底下生成）
- `model?`（選用；覆寫子代理程式模型；無效值會報錯）
- `runTimeoutSeconds?`（預設 0；設定後，於 N 秒後中止子代理程式執行）
- `cleanup?`（`delete|keep`，預設 `keep`）

允許清單：

- `agents.list[].subagents.allowAgents`：透過 `agentId` 允許的代理程式 id 清單（`["*"]` 代表允許任何）。預設：僅請求者代理程式。 預設：僅請求方代理。

探索：

- 使用 `agents_list` 來探索哪些代理程式 id 被允許用於 `sessions_spawn`。

行為：

- 以 `deliver: false` 啟動一個新的 `agent:<agentId>:subagent:<uuid>` 工作階段。
- 子代理程式預設可使用完整工具集，**但不包含工作階段工具**（可透過 `tools.subagents.tools` 設定）。
- 不允許子代理程式呼叫 `sessions_spawn`（禁止子代理程式 → 子代理程式生成）。
- 一律為非阻塞：立即回傳 `{ status: "accepted", runId, childSessionKey }`。
- 完成後，OpenClaw 會執行子代理程式的 **宣告步驟**，並將結果張貼到請求者的聊天頻道。
- 在宣告步驟中，回覆必須完全等於 `ANNOUNCE_SKIP` 才會保持靜默。
- 宣告回覆會正規化為 `Status`/`Result`/`Notes`；`Status` 來自執行期結果（非模型文字）。
- 子代理程式工作階段會在 `agents.defaults.subagents.archiveAfterMinutes` 後自動封存（預設：60）。
- 宣告回覆包含一行統計資訊（執行時間、tokens、sessionKey/sessionId、逐字稿路徑，以及選用的成本）。

## 沙盒工作階段可見性

沙箱隔離的工作階段可以使用工作階段工具，但預設僅能看到它們透過 `sessions_spawn` 所生成的工作階段。

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
