---
summary: >-
  Sub-agents: spawning isolated agent runs that announce results back to the
  requester chat
read_when:
  - You want background/parallel work via the agent
  - You are changing sessions_spawn or sub-agent tool policy
  - You are implementing or troubleshooting thread-bound subagent sessions
title: Sub-Agents
---

# 子代理

子代理是從現有代理執行中衍生出的背景代理執行。它們在自己的會話中執行 (`agent:<agentId>:subagent:<uuid>`)，完成後會將結果**公告**回請求者的聊天頻道。

## 斜線指令

使用 `/subagents` 來檢視或控制**當前會話**的子代理執行：

- `/subagents list`
- `/subagents kill <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`
- `/subagents steer <id|#> <message>`
- `/subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]`

執行緒綁定控制：

這些指令適用於支援持久執行緒綁定的頻道。詳見下方的**支援執行緒的頻道**。

- `/focus <subagent-label|session-key|session-id|session-label>`
- `/unfocus`
- `/agents`
- `/session idle <duration|off>`
- `/session max-age <duration|off>`

`/subagents info` 顯示執行元資料（狀態、時間戳記、會話 ID、文字記錄路徑、清理狀態）。

### 啟動行為

`/subagents spawn` 以使用者指令啟動背景子代理，而非內部中繼，執行結束時會向請求者聊天頻道發送最後的完成更新。

- 啟動指令為非阻塞；會立即回傳執行 ID。
- 完成時，子代理會向請求者聊天頻道公告摘要/結果訊息。
- 對於手動啟動，傳遞具備彈性：
  - OpenClaw 會先嘗試使用穩定的冪等鍵直接 `agent` 傳送。
  - 若直接傳送失敗，則退回至佇列路由。
  - 若佇列路由仍不可用，公告會以短暫指數退避重試，最後放棄。
- 完成交接給請求者會話的是執行時產生的內部上下文（非使用者撰寫文字），包含：
  - `Result`（`assistant` 回覆文字，或若助理回覆為空則為最新 `toolResult`）
  - `Status`（`completed successfully` / `failed` / `timed out` / `unknown`）
  - 精簡的執行時/token 統計
  - 傳遞指令告知請求代理以正常助理語氣重寫（非轉發原始內部元資料）
- `--model` 和 `--thinking` 可覆寫該次執行的預設值。
- 完成後可用 `info`/`log` 檢視詳細資料與輸出。
- `/subagents spawn` 是一次性模式（`mode: "run"`）。對於持久執行緒綁定會話，請使用 `sessions_spawn` 搭配 `thread: true` 和 `mode: "session"`。
- 對於 ACP 執行環境（Codex、Claude Code、Gemini CLI），請使用 `sessions_spawn` 搭配 `runtime: "acp"`，詳見 [ACP Agents](/tools/acp-agents)。

主要目標：

- 並行處理「研究／長時間任務／慢速工具」工作，避免阻塞主執行。
- 預設保持子代理隔離（會話分離 + 選用沙箱環境）。
- 保持工具介面難以誤用：子代理預設不會取得會話工具。
- 支援可設定的巢狀深度以實現協調者模式。

成本說明：每個子代理擁有**獨立**的上下文與 token 使用量。對於大量或重複任務，請為子代理設定較便宜的模型，並保持主代理使用較高品質模型。可透過 `agents.defaults.subagents.model` 或單一代理覆寫設定。

## 工具

使用 `sessions_spawn`：

- 啟動一個子代理執行 (`deliver: false`，全域通道：`subagent`)
- 接著執行公告步驟並將公告回覆發佈到請求者的聊天頻道
- 預設模型：繼承呼叫者，除非你設定了 `agents.defaults.subagents.model`（或每個代理的 `agents.list[].subagents.model`）；明確指定的 `sessions_spawn.model` 仍然優先。
- 預設思考層級：繼承呼叫者，除非你設定了 `agents.defaults.subagents.thinking`（或每個代理的 `agents.list[].subagents.thinking`）；明確指定的 `sessions_spawn.thinking` 仍然優先。
- 預設執行逾時：如果省略 `sessions_spawn.runTimeoutSeconds`，OpenClaw 會使用已設定的 `agents.defaults.subagents.runTimeoutSeconds`；否則會回退到 `0`（無逾時）。

工具參數：

- `task`（必填）
- `label?`（選填）
- `agentId?`（選填；如果允許，則在另一代理 ID 下產生）
- `model?`（選填；覆寫子代理模型；無效值會被跳過，子代理會在預設模型上執行並在工具結果中顯示警告）
- `thinking?`（選填；覆寫子代理執行的思考層級）
- `runTimeoutSeconds?`（設定時預設為 `agents.defaults.subagents.runTimeoutSeconds`，否則為 `0`；設定後子代理執行會在 N 秒後中止）
- `thread?`（預設 `false`；當為 `true` 時，請求此子代理會話綁定頻道線程）
- `mode?`（`run|session`）
  - 預設為 `run`
  - 如果省略 `thread: true` 和 `mode`，預設變為 `session`
  - `mode: "session"` 需要 `thread: true`
- `cleanup?`（`delete|keep`，預設 `keep`）
- `sandbox?`（`inherit|require`，預設 `inherit`；`require` 拒絕產生，除非目標子執行環境是沙盒）
- `sessions_spawn` **不接受** 頻道傳送參數（`target`、`channel`、`to`、`threadId`、`replyTo`、`transport`）。如需傳送，請使用產生執行的 `message`/`sessions_send`。

## 綁定線程的會話

當頻道啟用線程綁定時，子代理可以綁定到一個線程，讓該線程中的後續使用者訊息持續導向同一子代理會話。

### 支援線程的頻道

- Discord（目前唯一支援的頻道）：支援持久的綁定線程子代理會話（`sessions_spawn` 搭配 `thread: true`）、手動線程控制（`/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age`），以及適配器金鑰 `channels.discord.threadBindings.enabled`、`channels.discord.threadBindings.idleHours`、`channels.discord.threadBindings.maxAgeHours` 和 `channels.discord.threadBindings.spawnSubagentSessions`。

快速流程：

1. 使用 `sessions_spawn` 搭配 `thread: true`（可選 `mode: "session"`）產生子代理。
2. OpenClaw 在該頻道中建立或綁定一個線程到該會話目標。
3. 該線程中的回覆與後續訊息會導向綁定的會話。
4. 使用 `/session idle` 檢查/更新非活動自動失焦，使用 `/session max-age` 控制硬性上限。
5. 使用 `/unfocus` 手動解除綁定。

手動控制：

- `/focus <target>` 將目前線程（或建立一個）綁定到子代理/會話目標。
- `/unfocus` 移除目前綁定線程的綁定。
- `/agents` 列出活動執行與綁定狀態（`thread:<id>` 或 `unbound`）。
- `/session idle` 和 `/session max-age` 僅適用於已聚焦的綁定線程。

設定開關：

- 全域預設：`session.threadBindings.enabled`、`session.threadBindings.idleHours`、`session.threadBindings.maxAgeHours`
- 頻道覆寫與產生自動綁定金鑰為適配器專屬。詳見上方 **支援線程的頻道**。

請參考[設定參考](/gateway/configuration-reference)與[斜線指令](/tools/slash-commands)以了解目前的適配器細節。

允許清單：

- `agents.list[].subagents.allowAgents`：可透過`agentId`指定目標的代理人 ID 清單（`["*"]`允許任何代理人）。預設值：僅限請求者代理人。
- 沙盒繼承防護：若請求者會話處於沙盒環境，`sessions_spawn`會拒絕執行非沙盒環境的目標。

探索：

- 使用`agents_list`查看目前允許用於`sessions_spawn`的代理人 ID。

自動封存：

- 子代理人會話在`agents.defaults.subagents.archiveAfterMinutes`後自動封存（預設：60）。
- 封存使用`sessions.delete`，並將對話記錄重新命名為`*.deleted.<timestamp>`（同一資料夾）。
- `cleanup: "delete"`會在公告後立即封存（仍透過重新命名保留對話記錄）。
- 自動封存為盡力而為；若閘道器重啟，待處理的計時器將遺失。
- `runTimeoutSeconds`不會自動封存；僅停止執行。會話會保留直到自動封存。
- 自動封存同時適用於深度 1 與深度 2 的會話。

## 巢狀子代理人

預設情況下，子代理人無法產生自己的子代理人（`maxSpawnDepth: 1`）。您可以透過設定`maxSpawnDepth: 2`啟用一層巢狀，實現**協調者模式**：主代理人 → 協調者子代理人 → 工作者子子代理人。

### 如何啟用

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // allow sub-agents to spawn children (default: 1)
        maxChildrenPerAgent: 5, // max active children per agent session (default: 5)
        maxConcurrent: 8, // global concurrency lane cap (default: 8)
        runTimeoutSeconds: 900, // default timeout for sessions_spawn when omitted (0 = no timeout)
      },
    },
  },
}
```

### 深度層級

| 深度 | 會話鍵格式                                   | 角色                                | 是否可產生子代理人               |
| ---- | -------------------------------------------- | ----------------------------------- | -------------------------------- |
| 0    | `agent:<id>:main`                            | 主代理人                            | 總是可以                         |
| 1    | `agent:<id>:subagent:<uuid>`                 | 子代理人（若允許深度 2 則為協調者） | 僅當`maxSpawnDepth >= 2`時可產生 |
| 2    | `agent:<id>:subagent:<uuid>:subagent:<uuid>` | 子子代理人（葉節點工作者）          | 永遠不行                         |

### 公告鏈

結果會沿著鏈條向上回傳：

1. 深度2工作者完成 → 向其父節點（深度1協調者）發出通知
2. 深度1協調者接收通知，綜合結果後完成 → 向主節點發出通知
3. 主代理接收通知並傳遞給使用者

每個層級只會看到其直接子節點的通知。

### 按深度的工具政策

- 角色與控制範圍會在啟動時寫入會話元資料。這可防止平坦或還原的會話金鑰意外恢復協調者權限。
- **深度1（協調者，當 `maxSpawnDepth >= 2`）**：取得 `sessions_spawn`、`subagents`、`sessions_list`、`sessions_history`，以便管理其子節點。其他會話/系統工具仍被拒絕。
- **深度1（葉節點，當 `maxSpawnDepth == 1`）**：無會話工具（目前預設行為）。
- **深度2（葉工作者）**：無會話工具 — `sessions_spawn` 在深度2始終被拒絕。無法再產生子節點。

### 每代理啟動限制

每個代理會話（任一深度）最多可同時擁有 `maxChildrenPerAgent`（預設：5）個活躍子節點。此限制防止單一協調者無限制擴散。

### 級聯停止

停止深度1協調者會自動停止其所有深度2子節點：

- 主聊天中的 `/stop` 停止所有深度1代理，並級聯停止其深度2子節點。
- `/subagents kill <id>` 停止特定子代理，並級聯停止其子節點。
- `/subagents kill all` 停止該請求者的所有子代理，並級聯停止。

## 認證

子代理的認證是依據 **代理ID** 解決，而非會話類型：

- 子代理會話金鑰為 `agent:<agentId>:subagent:<uuid>`。
- 認證資料庫從該代理的 `agentDir` 載入。
- 主代理的認證設定作為 **備援** 合併；代理設定在衝突時會覆蓋主設定。

注意：合併是累加式的，因此主設定始終可作為備援。尚未支援完全隔離的代理認證。

## 通知

子代理透過通知步驟回報：

- announce 步驟在子代理會話中執行（非請求者會話）。
- 若子代理回覆正好是 `ANNOUNCE_SKIP`，則不會發布任何內容。
- 否則，傳遞方式取決於請求者深度：
  - 頂層請求者會話使用後續 `agent` 呼叫搭配外部傳遞 (`deliver=true`)
  - 巢狀請求者子代理會話接收內部後續注入 (`deliver=false`)，以便協調器能在會話中合成子結果
  - 若巢狀請求者子代理會話已消失，OpenClaw 會回退到該會話的請求者（若可用）
- 子完成聚合限定於當前請求者執行範圍，建立巢狀完成結果時，避免先前執行的過時子輸出滲入當前 announce。
- announce 回覆在頻道適配器可用時，會保留線程/主題路由。
- announce 上下文標準化為穩定的內部事件區塊：
  - 來源 (`subagent` 或 `cron`)
  - 子會話鍵/ID
  - announce 類型 + 任務標籤
  - 從執行結果推導的狀態行 (`success`、`error`、`timeout` 或 `unknown`)
  - announce 步驟的結果內容（若缺失則為 `(no output)`）
  - 描述何時回覆或保持沉默的後續指令
- `Status` 非從模型輸出推斷，而是來自執行結果信號。

announce 載荷結尾包含統計行（即使被包裹）：

- 執行時間（例如 `runtime 5m12s`）
- token 使用量（輸入/輸出/總計）
- 當模型定價設定時的估計成本 (`models.providers.*.models[].cost`)
- `sessionKey`、`sessionId` 及逐字稿路徑（以便主代理可透過 `sessions_history` 取得歷史或檢視磁碟上的檔案）
- 內部元資料僅供協調使用；面向使用者的回覆應以正常助理語氣重寫。

## 工具政策（子代理工具）

預設情況下，子代理可使用 **所有工具，除了會話工具** 和系統工具：

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

當 `maxSpawnDepth >= 2` 時，深度 1 的協調子代理額外獲得 `sessions_spawn`、`subagents`、`sessions_list` 和 `sessions_history`，以便管理其子代理。

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

## 並行性

子代理使用專用的進程內佇列通道：

- 通道名稱：`subagent`
- 並行度：`agents.defaults.subagents.maxConcurrent`（預設 `8`）

## 停止

- 在請求者聊天中發送 `/stop` 會中止請求者會話，並停止由其衍生的任何活躍子代理執行，且會向巢狀子代理遞迴停止。
- `/subagents kill <id>` 停止特定子代理，並遞迴停止其子代理。

## 限制

- 子代理的公告是**盡力而為**。如果閘道器重新啟動，待處理的「公告回覆」工作將會遺失。
- 子代理仍共用相同的閘道器程序資源；將 `maxConcurrent` 視為安全閥。
- `sessions_spawn` 永遠是非阻塞的：它會立即回傳 `{ status: "accepted", runId, childSessionKey }`。
- 子代理上下文只注入 `AGENTS.md` + `TOOLS.md`（不包含 `SOUL.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md` 或 `BOOTSTRAP.md`）。
- 最大巢狀深度為 5（`maxSpawnDepth` 範圍：1–5）。大多數使用案例建議深度為 2。
- `maxChildrenPerAgent` 限制每個會話的活躍子代理數量（預設：5，範圍：1–20）。
