---
summary: "子代理程式：產生隔離的代理程式執行，並將結果回報給請求者聊天"
read_when:
  - 你需要透過代理程式進行背景／平行工作
  - 你正在變更 sessions_spawn 或 子代理程式 工具政策
title: "子代理程式"
x-i18n:
  source_path: tools/subagents.md
  source_hash: 3c83eeed69a65dbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:48Z
---

# 子代理程式

子代理程式是從既有代理程式執行中產生的背景代理程式執行。它們在各自的工作階段中執行（`agent:<agentId>:subagent:<uuid>`），完成後會將結果**公告**回請求者的聊天頻道。

## 斜線指令

使用 `/subagents` 來檢視或控制**目前工作階段**的子代理程式執行：

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` 會顯示執行中繼資料（狀態、時間戳記、工作階段 id、逐字稿路徑、清理）。

主要目標：

- 在不阻塞主要執行的情況下，將「研究／長時間任務／慢速工具」的工作平行化。
- 預設保持子代理程式的隔離（工作階段分離＋可選的沙箱隔離）。
- 讓工具介面難以誤用：子代理程式預設**不**會取得工作階段工具。
- 避免巢狀扇出：子代理程式不能再產生子代理程式。

成本說明：每個子代理程式都有**自己的**脈絡與權杖使用量。對於繁重或重複的
任務，請為子代理程式設定較便宜的模型，並讓主要代理程式使用較高品質的模型。
你可以透過 `agents.defaults.subagents.model` 或逐代理程式覆寫來設定。

## 工具

使用 `sessions_spawn`：

- 啟動一個子代理程式執行（`deliver: false`，全域佇列通道：`subagent`）
- 接著執行公告步驟，並將公告回覆張貼到請求者聊天頻道
- 預設模型：繼承呼叫者，除非你設定 `agents.defaults.subagents.model`（或逐代理程式的 `agents.list[].subagents.model`）；明確指定的 `sessions_spawn.model` 仍然優先。
- 預設思考層級：繼承呼叫者，除非你設定 `agents.defaults.subagents.thinking`（或逐代理程式的 `agents.list[].subagents.thinking`）；明確指定的 `sessions_spawn.thinking` 仍然優先。

工具參數：

- `task`（必填）
- `label?`（選填）
- `agentId?`（選填；若允許，則在另一個代理程式 id 底下產生）
- `model?`（選填；覆寫子代理程式模型；無效值會被略過，子代理程式將以預設模型執行，並在工具結果中顯示警告）
- `thinking?`（選填；覆寫子代理程式執行的思考層級）
- `runTimeoutSeconds?`（預設 `0`；設定後，子代理程式執行會在 N 秒後中止）
- `cleanup?`（`delete|keep`，預設 `keep`）

允許清單：

- `agents.list[].subagents.allowAgents`：可透過 `agentId` 指定的代理程式 id 清單（`["*"]` 以允許任何）。預設：僅請求者代理程式。

探索：

- 使用 `agents_list` 查看目前允許用於 `sessions_spawn` 的代理程式 id。

自動封存：

- 子代理程式工作階段會在 `agents.defaults.subagents.archiveAfterMinutes` 後自動封存（預設：60）。
- 封存會使用 `sessions.delete`，並將逐字稿重新命名為 `*.deleted.<timestamp>`（同一資料夾）。
- `cleanup: "delete"` 會在公告後立即封存（仍會透過重新命名保留逐字稿）。
- 自動封存為盡力而為；若 Gateway 閘道器 重新啟動，待處理的計時器會遺失。
- `runTimeoutSeconds` **不會**自動封存；它只會停止執行。工作階段會保留直到自動封存。

## 身分驗證

子代理程式的驗證是依**代理程式 id** 解析，而非依工作階段類型：

- 子代理程式的工作階段金鑰為 `agent:<agentId>:subagent:<uuid>`。
- 驗證儲存區會從該代理程式的 `agentDir` 載入。
- 主要代理程式的驗證設定檔會作為**後備**合併；若有衝突，代理程式設定檔會覆寫主要設定檔。

注意：合併是加法式的，因此主要設定檔一律可作為後備。尚未支援每個代理程式完全隔離的驗證。

## 公告

子代理程式會透過公告步驟回報：

- 公告步驟在子代理程式工作階段內執行（不是請求者工作階段）。
- 若子代理程式回覆內容完全等於 `ANNOUNCE_SKIP`，則不會張貼任何內容。
- 否則，公告回覆會透過後續的 `agent` 呼叫（`deliver=true`）張貼到請求者聊天頻道。
- 在可用時，公告回覆會保留執行緒／主題路由（Slack 執行緒、Telegram 主題、Matrix 執行緒）。
- 公告訊息會正規化為穩定的範本：
  - `Status:` 依據執行結果推導（`success`、`error`、`timeout`，或 `unknown`）。
  - `Result:` 為公告步驟的摘要內容（若缺失則為 `(not available)`）。
  - `Notes:` 為錯誤細節與其他有用的脈絡。
- `Status` 並非從模型輸出推斷；它來自執行期的結果訊號。

公告承載內容在結尾會包含一行統計資訊（即使被包裝）：

- 執行時間（例如：`runtime 5m12s`）
- 權杖使用量（輸入／輸出／總計）
- 在設定模型定價時的估計成本（`models.providers.*.models[].cost`）
- `sessionKey`、`sessionId`，以及逐字稿路徑（因此主要代理程式可透過 `sessions_history` 取得歷史紀錄，或在磁碟上檢視檔案）

## 工具政策（子代理程式工具）

預設情況下，子代理程式會取得**除工作階段工具以外的所有工具**：

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

可透過設定覆寫：

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## 併發

子代理程式使用專用的行程內佇列通道：

- 通道名稱：`subagent`
- 併發數：`agents.defaults.subagents.maxConcurrent`（預設 `8`）

## 停止

- 在請求者聊天中送出 `/stop` 會中止請求者工作階段，並停止由其產生的任何活動中子代理程式執行。

## 限制

- 子代理程式的公告為**盡力而為**。若 Gateway 閘道器 重新啟動，待處理的「回傳公告」工作會遺失。
- 子代理程式仍共享相同的 Gateway 閘道器 行程資源；請將 `maxConcurrent` 視為安全閥。
- `sessions_spawn` 一律為非阻塞：它會立即回傳 `{ status: "accepted", runId, childSessionKey }`。
- 子代理程式脈絡只會注入 `AGENTS.md` ＋ `TOOLS.md`（不包含 `SOUL.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`，或 `BOOTSTRAP.md`）。
