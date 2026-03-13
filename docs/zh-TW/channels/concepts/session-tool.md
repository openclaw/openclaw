---
summary: >-
  Agent session tools for listing sessions, fetching history, and sending
  cross-session messages
read_when:
  - Adding or modifying session tools
title: Session Tools
---

# Session Tools

目標：提供一套小型且不易誤用的工具集，以便代理可以列出會話、獲取歷史紀錄並發送到另一個會話。

## Tool Names

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Key Model

- 主要的直接聊天桶始終是字面上的鍵 `"main"`（解析為當前代理的主要鍵）。
- 群組聊天使用 `agent:<agentId>:<channel>:group:<id>` 或 `agent:<agentId>:<channel>:channel:<id>`（傳遞完整的鍵）。
- 定時任務使用 `cron:<job.id>`。
- 鉤子使用 `hook:<uuid>`，除非明確設定。
- 節點會話使用 `node-<nodeId>`，除非明確設定。

`global` 和 `unknown` 是保留值，永遠不會被列出。如果 `session.scope = "global"`，我們將其別名為 `main`，以便所有工具都能使用，這樣呼叫者就不會看到 `global`。

## sessions_list

將會話列出為一個行的陣列。

[[BLOCK_1]]

- `kinds?: string[]` 過濾：任一 `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` 最大行數（預設：伺服器預設，限制例如 200）
- `activeMinutes?: number` 只顯示在 N 分鐘內更新的會話
- `messageLimit?: number` 0 = 無消息（預設 0）；>0 = 包含最後 N 條消息

[[BLOCK_1]]

- `messageLimit > 0` 每個會話擷取 `chat.history` 並包含最後 N 條訊息。
- 工具結果在列表輸出中被過濾；使用 `sessions_history` 來顯示工具訊息。
- 當在 **sandboxed** 代理會話中執行時，會話工具預設為 **僅可見於產生的內容**（見下文）。

[[BLOCK_1]]  
Row shape (JSON):  
[[INLINE_1]]

- `key`: 會話金鑰 (字串)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (如果可用的群組顯示標籤)
- `updatedAt` (毫秒)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (如果設定了會話覆蓋)
- `lastChannel`, `lastTo`
- `deliveryContext` (當可用時的標準化 `{ channel, to, accountId }`)
- `transcriptPath` (從存儲目錄 + sessionId 派生的最佳努力路徑)
- `messages?` (僅在 `messageLimit > 0` 時)

## sessions_history

[[BLOCK_1]]  
獲取一個會話的逐字稿。  
[[BLOCK_1]]

[[BLOCK_1]]

- `sessionKey`（必填；接受會話金鑰或 `sessionId` 來自 `sessions_list`）
- `limit?: number` 最大訊息數（伺服器限制）
- `includeTools?: boolean`（預設為 false）

[[BLOCK_1]]

- `includeTools=false` 過濾 `role: "toolResult"` 訊息。
- 以原始逐字稿格式返回訊息陣列。
- 當給定 `sessionId` 時，OpenClaw 將其解析為對應的會話金鑰（缺少 ID 錯誤）。

## sessions_send

將訊息發送到另一個會話中。

[[BLOCK_1]]

- `sessionKey`（必填；接受會話金鑰或 `sessionId` 來自 `sessions_list`）
- `message`（必填）
- `timeoutSeconds?: number`（預設 >0；0 = fire-and-forget）

[[BLOCK_1]]

- `timeoutSeconds = 0`: 將請求加入佇列並返回 `{ runId, status: "accepted" }`。
- `timeoutSeconds > 0`: 最多等待 N 秒以完成，然後返回 `{ runId, status: "ok", reply }`。
- 如果等待超時: `{ runId, status: "timeout", error }`。執行將繼續；稍後呼叫 `sessions_history`。
- 如果執行失敗: `{ runId, status: "error", error }`。
- 在主要執行完成後宣布交付執行，並且是最佳努力；`status: "ok"` 不保證公告已送達。
- 透過閘道 `agent.wait` 進行等待（伺服器端），因此重新連接不會中斷等待。
- 代理之間的消息上下文會在主要執行中注入。
- 會話間的消息會使用 `message.provenance.kind = "inter_session"` 持久化，以便逐字稿讀取器可以區分路由的代理指令與外部用戶輸入。
- 在主要執行完成後，OpenClaw 會執行 **回覆迴圈**：
  - 第 2 輪及以上在請求者和目標代理之間交替進行。
  - 精確回覆 `REPLY_SKIP` 以停止乒乓。
  - 最大回合數為 `session.agentToAgent.maxPingPongTurns`（0–5，預設為 5）。
- 一旦迴圈結束，OpenClaw 會執行 **代理之間的公告步驟**（僅限目標代理）：
  - 精確回覆 `ANNOUNCE_SKIP` 以保持沉默。
  - 任何其他回覆將發送到目標頻道。
  - 公告步驟包括原始請求 + 第 1 輪回覆 + 最新的乒乓回覆。

## Channel Field

- 對於群組，`channel` 是在會話進入時記錄的頻道。
- 對於直接聊天，`channel` 來自 `lastChannel` 的映射。
- 對於 cron/hook/node，`channel` 是 `internal`。
- 如果缺失，`channel` 是 `unknown`。

## 安全性 / 發送政策

基於政策的阻擋依據頻道/聊天類型（而非每個會話 ID）。

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

[[BLOCK_1]]  
Runtime override (per session entry):  
[[BLOCK_1]]

- `sendPolicy: "allow" | "deny"` (unset = 繼承設定)
- 可透過 `sessions.patch` 設定或僅限擁有者的 `/send on|off|inherit` (獨立訊息)。

[[BLOCK_1]]

- `chat.send` / `agent` (網關)
- 自動回覆傳遞邏輯

## sessions_spawn

在一個隔離的會話中啟動一個子代理，並將結果回報給請求者的聊天頻道。

[[BLOCK_1]]  
Parameters:  
[[BLOCK_1]]

- `task` (必填)
- `label?` (選填；用於日誌/UI)
- `agentId?` (選填；如果允許，則在另一個代理 ID 下產生)
- `model?` (選填；覆蓋子代理模型；無效值錯誤)
- `thinking?` (選填；覆蓋子代理執行的思考級別)
- `runTimeoutSeconds?` (設置時預設為 `agents.defaults.subagents.runTimeoutSeconds`，否則為 `0`；設置時，在 N 秒後中止子代理執行)
- `thread?` (預設為 false；當通道/插件支援時，請求此產生的線程綁定路由)
- `mode?` (`run|session`；預設為 `run`，但當 `thread=true` 時預設為 `session`；`mode="session"` 需要 `thread=true`)
- `cleanup?` (`delete|keep`，預設 `keep`)
- `sandbox?` (`inherit|require`，預設 `inherit`；`require` 拒絕產生，除非目標子執行時被沙盒化)
- `attachments?` (選填的內聯檔案陣列；僅限子代理執行時，ACP 拒絕)。每個條目：`{ name, content, encoding?: "utf8" | "base64", mimeType? }`。檔案在 `.openclaw/attachments/<uuid>/` 的子工作區中實體化。每個檔案返回一個帶有 sha256 的收據。
- `attachAs?` (選填；`{ mountPath? }` 提示保留給未來的掛載實現)

Allowlist:

- `agents.list[].subagents.allowAgents`: 允許的代理 ID 列表，透過 `agentId` (`["*"]` 允許任何)。預設：僅限請求者代理。
- 沙盒繼承保護：如果請求者會話是沙盒化的，`sessions_spawn` 會拒絕那些將在非沙盒環境中執行的目標。

Discovery:

- 使用 `agents_list` 來查詢哪些代理 ID 被允許用於 `sessions_spawn`。

[[BLOCK_1]]

- 開始一個新的 `agent:<agentId>:subagent:<uuid>` 會話與 `deliver: false`。
- 子代理預設使用完整的工具集 **不包括會話工具**（可透過 `tools.subagents.tools` 設定）。
- 子代理不允許呼叫 `sessions_spawn`（不允許子代理 → 子代理的產生）。
- 始終非阻塞：立即返回 `{ status: "accepted", runId, childSessionKey }`。
- 使用 `thread=true` 時，通道插件可以將交付/路由綁定到執行緒目標（Discord 支援由 `session.threadBindings.*` 和 `channels.discord.threadBindings.*` 控制）。
- 完成後，OpenClaw 會執行子代理 **公告步驟** 並將結果發佈到請求者的聊天頻道。
  - 如果助理的最終回覆為空，則會將子代理歷史中的最新 `toolResult` 包含為 `Result`。
- 在公告步驟中精確回覆 `ANNOUNCE_SKIP` 以保持靜默。
- 公告回覆被標準化為 `Status`/`Result`/`Notes`；`Status` 來自執行時結果（而非模型文本）。
- 子代理會話在 `agents.defaults.subagents.archiveAfterMinutes` 後自動歸檔（預設：60）。
- 公告回覆包括一行統計資訊（執行時間、token、sessionKey/sessionId、逐字稿路徑，以及可選的成本）。

## Sandbox Session Visibility

會話工具可以被範圍化，以減少跨會話的存取。

Default behavior:

- `tools.sessions.visibility` 預設為 `tree`（當前會話 + 產生的子代理會話）。
- 對於沙盒會話，`agents.defaults.sandbox.sessionToolsVisibility` 可以強制限制可見性。

Config:

```json5
{
  tools: {
    sessions: {
      // "self" | "tree" | "agent" | "all"
      // default: "tree"
      visibility: "tree",
    },
  },
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

[[BLOCK_1]]

- `self`: 只有當前的會話金鑰。
- `tree`: 當前會話 + 由當前會話產生的會話。
- `agent`: 任何屬於當前代理 ID 的會話。
- `all`: 任何會話（跨代理存取仍需 `tools.agentToAgent`）。
- 當一個會話被沙盒化且 `sessionToolsVisibility="spawned"` 時，即使您設置了 `tools.sessions.visibility="all"`，OpenClaw 也會限制可見性到 `tree`。
