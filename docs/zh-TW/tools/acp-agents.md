---
summary: >-
  Use ACP runtime sessions for Pi, Claude Code, Codex, OpenCode, Gemini CLI, and
  other harness agents
read_when:
  - Running coding harnesses through ACP
  - Setting up thread-bound ACP sessions on thread-capable channels
  - Binding Discord channels or Telegram forum topics to persistent ACP sessions
  - Troubleshooting ACP backend and plugin wiring
  - Operating /acp commands from chat
title: ACP Agents
---

# ACP 代理

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) 會話讓 OpenClaw 透過 ACP 後端插件執行外部程式碼執行環境（例如 Pi、Claude Code、Codex、OpenCode 和 Gemini CLI）。

如果你用自然語言請 OpenClaw「在 Codex 執行這個」或「在線程中啟動 Claude Code」，OpenClaw 應該會將該請求導向 ACP 執行時（而非原生子代理執行時）。

## 快速操作流程

當你想要一個實用的 `/acp` 執行手冊時，請使用此流程：

1. 建立一個會話：
   - `/acp spawn codex --mode persistent --thread auto`
2. 在綁定的線程中工作（或明確指定該會話金鑰）。
3. 檢查執行時狀態：
   - `/acp status`
4. 根據需要調整執行時選項：
   - `/acp model <provider/model>`
   - `/acp permissions <profile>`
   - `/acp timeout <seconds>`
5. 在不替換上下文的情況下推動活躍會話：
   - `/acp steer tighten logging and continue`
6. 停止工作：
   - `/acp cancel`（停止當前回合），或
   - `/acp close`（關閉會話並移除綁定）

## 人類快速入門

自然請求範例：

- 「在這裡的線程中啟動一個持續的 Codex 會話並保持專注。」
- 「以一次性 Claude Code ACP 會話執行這個並總結結果。」
- 「在線程中使用 Gemini CLI 執行此任務，然後在同一線程中保持後續互動。」

OpenClaw 應該執行的步驟：

1. 選擇 `runtime: "acp"`。
2. 解析請求的執行環境目標（`agentId`，例如 `codex`）。
3. 如果請求綁定線程且當前頻道支援，將 ACP 會話綁定到該線程。
4. 將後續線程訊息導向同一 ACP 會話，直到取消專注／關閉／過期。

## ACP 與子代理比較

當你需要外部執行環境時使用 ACP；當你需要 OpenClaw 原生委派執行時使用子代理。

| 領域     | ACP 會話                              | 子代理執行                        |
| -------- | ------------------------------------- | --------------------------------- |
| 執行時   | ACP 後端插件（例如 acpx）             | OpenClaw 原生子代理執行時         |
| 會話金鑰 | `agent:<agentId>:acp:<uuid>`          | `agent:<agentId>:subagent:<uuid>` |
| 主要指令 | `/acp ...`                            | `/subagents ...`                  |
| 建立工具 | `sessions_spawn` 搭配 `runtime:"acp"` | `sessions_spawn`（預設執行時）    |

另見 [子代理](/tools/subagents)。

## 綁定執行緒的會話（與頻道無關）

當頻道適配器啟用執行緒綁定時，ACP 會話可以綁定到執行緒：

- OpenClaw 將執行緒綁定到目標 ACP 會話。
- 該執行緒中的後續訊息會路由到綁定的 ACP 會話。
- ACP 輸出會回傳到相同的執行緒。
- 取消聚焦／關閉／封存／閒置逾時或最大存活時間到期會移除綁定。

執行緒綁定支援為適配器特定功能。如果目前使用的頻道適配器不支援執行緒綁定，OpenClaw 會回傳明確的「不支援／不可用」訊息。

執行緒綁定 ACP 所需的功能旗標：

- `acp.enabled=true`
- `acp.dispatch.enabled` 預設為開啟（設定 `false` 可暫停 ACP 派送）
- 頻道適配器 ACP 執行緒產生旗標啟用（依適配器而異）
  - Discord: `channels.discord.threadBindings.spawnAcpSessions=true`
  - Telegram: `channels.telegram.threadBindings.spawnAcpSessions=true`

### 支援執行緒的頻道

- 任何提供會話／執行緒綁定功能的頻道適配器。
- 目前內建支援：
  - Discord 執行緒／頻道
  - Telegram 主題（群組／超級群組的論壇主題及私訊主題）
- 外掛頻道可透過相同綁定介面新增支援。

## 頻道特定設定

對於非短暫工作流程，請在頂層 `bindings[]` 條目中設定持久 ACP 綁定。

### 綁定模型

- `bindings[].type="acp"` 標記一個持久的 ACP 對話綁定。
- `bindings[].match` 識別目標對話：
  - Discord 頻道或執行緒：`match.channel="discord"` + `match.peer.id="<channelOrThreadId>"`
  - Telegram 論壇主題：`match.channel="telegram"` + `match.peer.id="<chatId>:topic:<topicId>"`
- `bindings[].agentId` 是所屬的 OpenClaw 代理 ID。
- 選用的 ACP 覆寫設定位於 `bindings[].acp`：
  - `mode`（`persistent` 或 `oneshot`）
  - `label`
  - `cwd`
  - `backend`

### 每個代理的執行時預設值

使用 `agents.list[].runtime` 為每個代理定義 ACP 預設值：

- `agents.list[].runtime.type="acp"`
- `agents.list[].runtime.acp.agent`（執行環境 ID，例如 `codex` 或 `claude`）
- `agents.list[].runtime.acp.backend`
- `agents.list[].runtime.acp.mode`
- `agents.list[].runtime.acp.cwd`

覆寫 ACP 綁定會話的優先順序：

1. `bindings[].acp.*`
2. `agents.list[].runtime.acp.*`
3. 全域 ACP 預設值（例如 `acp.backend`）

範例：

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
      },
      {
        id: "claude",
        runtime: {
          type: "acp",
          acp: { agent: "claude", backend: "acpx", mode: "persistent" },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "discord",
        accountId: "default",
        peer: { kind: "channel", id: "222222222222222222" },
      },
      acp: { label: "codex-main" },
    },
    {
      type: "acp",
      agentId: "claude",
      match: {
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-1001234567890:topic:42" },
      },
      acp: { cwd: "/workspace/repo-b" },
    },
    {
      type: "route",
      agentId: "main",
      match: { channel: "discord", accountId: "default" },
    },
    {
      type: "route",
      agentId: "main",
      match: { channel: "telegram", accountId: "default" },
    },
  ],
  channels: {
    discord: {
      guilds: {
        "111111111111111111": {
          channels: {
            "222222222222222222": { requireMention: false },
          },
        },
      },
    },
    telegram: {
      groups: {
        "-1001234567890": {
          topics: { "42": { requireMention: false } },
        },
      },
    },
  },
}
```

行為：

- OpenClaw 確保在使用前已存在所設定的 ACP 會話。
- 該頻道或主題中的訊息會導向設定的 ACP 會話。
- 在綁定的對話中，`/new` 和 `/reset` 會就地重設相同的 ACP 會話金鑰。
- 臨時執行時綁定（例如由 thread-focus 流程建立）仍會在存在時生效。

## 啟動 ACP 會話（介面）

### 從 `sessions_spawn`

使用 `runtime: "acp"` 從代理回合或工具呼叫啟動 ACP 會話。

```json
{
  "task": "Open the repo and summarize failing tests",
  "runtime": "acp",
  "agentId": "codex",
  "thread": true,
  "mode": "session"
}
```

注意事項：

- `runtime` 預設為 `subagent`，因此需明確設定 `runtime: "acp"` 以啟用 ACP 會話。
- 若省略 `agentId`，OpenClaw 在有設定時會使用 `acp.defaultAgent`。
- `mode: "session"` 需要 `thread: true` 以維持持續綁定的對話。

介面細節：

- `task`（必填）：發送給 ACP 會話的初始提示。
- `runtime`（ACP 必填）：必須是 `"acp"`。
- `agentId`（選填）：ACP 目標 harness id。若設定，會回退至 `acp.defaultAgent`。
- `thread`（選填，預設 `false`）：在支援時請求執行緒綁定流程。
- `mode`（選填）：`run`（一次性）或 `session`（持續）。
  - 預設為 `run`
  - 若省略 `thread: true` 和模式，OpenClaw 可能依執行時路徑預設為持續行為
  - `mode: "session"` 需要 `thread: true`
- `cwd`（選填）：請求的執行時工作目錄（由後端/執行時政策驗證）。
- `label`（選填）：操作員面向的標籤，用於會話/橫幅文字。
- `resumeSessionId`（選填）：恢復現有 ACP 會話而非建立新會話。代理會透過 `session/load` 重播其對話歷史。需要 `runtime: "acp"`。
- `streamTo`（選填）：`"parent"` 將初始 ACP 執行進度摘要以系統事件串流回請求者會話。
  - 可用時，接受的回應包含 `streamLogPath`，指向可供追蹤完整中繼歷史的會話範圍 JSONL 日誌 (`<sessionId>.acp-stream.jsonl`)。

### 恢復現有會話

使用 `resumeSessionId` 來繼續先前的 ACP 會話，而非重新開始。代理會透過 `session/load` 重播其對話歷史，因此能完整接續之前的上下文。

```json
{
  "task": "Continue where we left off — fix the remaining test failures",
  "runtime": "acp",
  "agentId": "codex",
  "resumeSessionId": "<previous-session-id>"
}
```

常見使用情境：

- 將 Codex 會話從筆電交接到手機 — 告訴代理從你中斷的地方繼續
- 繼續你在 CLI 互動式開始的程式編寫會話，現在透過代理無頭模式執行
- 接續因閘道器重啟或閒置逾時而中斷的工作

注意事項：

- `resumeSessionId` 需要 `runtime: "acp"` — 若與子代理執行環境搭配使用會回傳錯誤。
- `resumeSessionId` 會還原上游 ACP 對話歷史；`thread` 和 `mode` 仍正常適用於你正在建立的新 OpenClaw 會話，因此 `mode: "session"` 仍需 `thread: true`。
- 目標代理必須支援 `session/load`（Codex 和 Claude Code 均支援）。
- 若找不到會話 ID，啟動會失敗並回傳明確錯誤 — 不會靜默回退到新會話。

### 操作者煙霧測試

當你在閘道器部署後想快速進行端對端的即時檢查，確認 ACP 啟動功能確實運作，而非僅通過單元測試時，請使用此測試。

推薦流程：

1. 驗證目標主機上部署的閘道器版本/提交紀錄。
2. 確認部署的原始碼包含 ACP 衍生接受邏輯於 `src/gateway/sessions-patch.ts` (`subagent:* or acp:* sessions`)。
3. 開啟一個臨時 ACPX 橋接會話連接至線上代理（例如 `razor(main)` 在 `jpclawhq`）。
4. 請該代理呼叫 `sessions_spawn`，並帶入：
   - `runtime: "acp"`
   - `agentId: "codex"`
   - `mode: "run"`
   - 任務：`Reply with exactly LIVE-ACP-SPAWN-OK`
5. 驗證代理回報：
   - `accepted=yes`
   - 一個真實的 `childSessionKey`
   - 無驗證錯誤
6. 清理臨時 ACPX 橋接會話。

給線上代理的範例提示：

```text
Use the sessions_spawn tool now with runtime: "acp", agentId: "codex", and mode: "run".
Set the task to: "Reply with exactly LIVE-ACP-SPAWN-OK".
Then report only: accepted=<yes/no>; childSessionKey=<value or none>; error=<exact text or none>.
```

注意事項：

- 除非你有意測試綁定執行緒的持久 ACP 會話，否則請將此煙霧測試保留在 `mode: "run"`。
- 基本流程不應要求 `streamTo: "parent"`，該路徑依賴請求者/會話能力，是另一項整合檢查。
- 將綁定執行緒的 `mode: "session"` 測試視為第二階段、更完整的整合測試，來自真實 Discord 執行緒或 Telegram 主題。

## 沙盒相容性

ACP 會話目前在主機執行環境中執行，而非在 OpenClaw 沙箱內。

目前限制：

- 如果請求者會話被沙箱限制，ACP 的衍生程序在 `sessions_spawn({ runtime: "acp" })` 和 `/acp spawn` 兩者中都會被阻擋。
  - 錯誤：`Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.`
- `sessions_spawn` 搭配 `runtime: "acp"` 不支援 `sandbox: "require"`。
  - 錯誤：`sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".`

需要沙箱強制執行時，請使用 `runtime: "subagent"`。

### 從 `/acp` 指令

需要時，請使用 `/acp spawn` 以便從聊天中明確控制操作員。

```text
/acp spawn codex --mode persistent --thread auto
/acp spawn codex --mode oneshot --thread off
/acp spawn codex --thread here
```

主要旗標：

- `--mode persistent|oneshot`
- `--thread auto|here|off`
- `--cwd <absolute-path>`
- `--label <name>`

請參考 [斜線指令](/tools/slash-commands)。

## 會話目標解析

大多數 `/acp` 動作接受可選的會話目標（`session-key`、`session-id` 或 `session-label`）。

解析順序：

1. 明確目標參數（或 `--session` 用於 `/acp steer`）
   - 嘗試 key
   - 接著是 UUID 格式的會話 ID
   - 再來是標籤
2. 目前執行緒綁定（如果此對話/執行緒綁定到 ACP 會話）
3. 目前請求者會話作為後備

若無法解析目標，OpenClaw 會回傳明確錯誤（`Unable to resolve session target: ...`）。

## 執行緒產生模式

`/acp spawn` 支援 `--thread auto|here|off`。

| 模式   | 行為                                                                  |
| ------ | --------------------------------------------------------------------- |
| `auto` | 在活躍執行緒中：綁定該執行緒。非執行緒中：在支援時建立/綁定子執行緒。 |
| `here` | 需要當前活躍執行緒；若不在執行緒中則失敗。                            |
| `off`  | 不綁定。會話啟動時為未綁定狀態。                                      |

注意事項：

- 在非執行緒綁定介面上，預設行為實際上是 `off`。
- 執行緒綁定的產生需要頻道政策支援：
  - Discord: `channels.discord.threadBindings.spawnAcpSessions=true`
  - Telegram: `channels.telegram.threadBindings.spawnAcpSessions=true`

## ACP 控制

可用的指令群組：

- `/acp spawn`
- `/acp cancel`
- `/acp steer`
- `/acp close`
- `/acp status`
- `/acp set-mode`
- `/acp set`
- `/acp cwd`
- `/acp permissions`
- `/acp timeout`
- `/acp model`
- `/acp reset-options`
- `/acp sessions`
- `/acp doctor`
- `/acp install`

`/acp status` 顯示有效的執行時選項，並在可用時同時顯示執行時層級與後端層級的會話識別碼。

部分控制依賴後端能力。若後端不支援某控制，OpenClaw 會回傳明確的「不支援控制」錯誤。

## ACP 指令範例集

| 指令                 | 功能                                     | 範例                                                           |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `/acp spawn`         | 建立 ACP 會話；可選擇綁定執行緒。        | `/acp spawn codex --mode persistent --thread auto --cwd /repo` |
| `/acp cancel`        | 取消目標會話中正在進行的回合。           | `/acp cancel agent:codex:acp:<uuid>`                           |
| `/acp steer`         | 傳送導引指令給執行中的會話。             | `/acp steer --session support inbox prioritize failing tests`  |
| `/acp close`         | 關閉會話並解除執行緒綁定目標。           | `/acp close`                                                   |
| `/acp status`        | 顯示後端、模式、狀態、執行時選項、功能。 | `/acp status`                                                  |
| `/acp set-mode`      | 設定目標會話的執行時模式。               | `/acp set-mode plan`                                           |
| `/acp set`           | 通用執行時設定選項寫入。                 | `/acp set model openai/gpt-5.2`                                |
| `/acp cwd`           | 設定執行時工作目錄覆寫。                 | `/acp cwd /Users/user/Projects/repo`                           |
| `/acp permissions`   | 設定審核政策設定檔。                     | `/acp permissions strict`                                      |
| `/acp timeout`       | 設定執行時逾時（秒）。                   | `/acp timeout 120`                                             |
| `/acp model`         | 設定執行時模型覆寫。                     | `/acp model anthropic/claude-opus-4-5`                         |
| `/acp reset-options` | 移除會話執行時選項覆寫。                 | `/acp reset-options`                                           |
| `/acp sessions`      | 列出儲存中最近的 ACP 會話。              | `/acp sessions`                                                |
| `/acp doctor`        | 後端健康狀態、功能、可執行修復。         | `/acp doctor`                                                  |
| `/acp install`       | 列印確定性安裝與啟用步驟。               | `/acp install`                                                 |

`/acp sessions` 會讀取目前綁定或請求者的會話資料。接受 `session-key`、`session-id` 或 `session-label` token 的指令，會透過閘道會話發現解析目標，包括每個代理自訂的 `session.store` 根目錄。

## 執行時選項對應

`/acp` 提供便利指令與通用設定器。

等效操作：

- `/acp model <id>` 對應到執行時設定鍵 `model`。
- `/acp permissions <profile>` 對應到執行時設定鍵 `approval_policy`。
- `/acp timeout <seconds>` 對應到執行時設定鍵 `timeout`。
- `/acp cwd <path>` 直接更新執行時的 cwd 覆寫。
- `/acp set <key> <value>` 是通用路徑。
  - 特殊情況：`key=cwd` 使用 cwd 覆寫路徑。
- `/acp reset-options` 清除目標會話的所有執行時覆寫。

## acpx harness 支援（目前）

目前 acpx 內建的 harness 別名：

- `pi`
- `claude`
- `codex`
- `opencode`
- `gemini`
- `kimi`

當 OpenClaw 使用 acpx 後端時，除非你的 acpx 設定定義了自訂代理別名，否則建議使用這些值作為 `agentId`。

直接使用 acpx CLI 也可以透過 `--agent <command>` 指定任意適配器，但這種原始逃生閥是 acpx CLI 的功能（非一般 OpenClaw 的 `agentId` 路徑）。

## 必要設定

核心 ACP 基線：

```json5
{
  acp: {
    enabled: true,
    // Optional. Default is true; set false to pause ACP dispatch while keeping /acp controls.
    dispatch: { enabled: true },
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: ["pi", "claude", "codex", "opencode", "gemini", "kimi"],
    maxConcurrentSessions: 8,
    stream: {
      coalesceIdleMs: 300,
      maxChunkChars: 1200,
    },
    runtime: {
      ttlMinutes: 120,
    },
  },
}
```

執行緒綁定設定是針對頻道適配器特定的。以下為 Discord 範例：

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        spawnAcpSessions: true,
      },
    },
  },
}
```

如果執行緒綁定的 ACP 啟動失效，請先確認適配器功能標誌：

- Discord: `channels.discord.threadBindings.spawnAcpSessions=true`

請參考 [設定參考](/gateway/configuration-reference)。

## acpx 後端的插件設定

安裝並啟用插件：

```bash
openclaw plugins install acpx
openclaw config set plugins.entries.acpx.enabled true
```

開發期間的本地工作區安裝：

```bash
openclaw plugins install ./extensions/acpx
```

接著驗證後端狀態：

```text
/acp doctor
```

### acpx 指令與版本設定

預設情況下，acpx 插件（發佈為 `@openclaw/acpx`）使用插件本地固定版本的二進位檔：

1. 指令預設為 `extensions/acpx/node_modules/.bin/acpx`。
2. 預期版本預設為擴充套件所固定的版本。
3. 啟動時立即將 ACP 後端註冊為尚未就緒。
4. 背景確保工作會驗證 `acpx --version`。
5. 若插件本地二進位檔遺失或版本不符，會執行：
   `npm install --omit=dev --no-save acpx@<pinned>` 並重新驗證。

你可以在插件設定中覆寫指令與版本：

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "command": "../acpx/dist/cli.js",
          "expectedVersion": "any"
        }
      }
    }
  }
}
```

注意事項：

- `command` 可接受絕對路徑、相對路徑或指令名稱（`acpx`）。
- 相對路徑會從 OpenClaw 工作區目錄解析。
- `expectedVersion: "any"` 可關閉嚴格版本匹配。
- 當 `command` 指向自訂的二進位檔或路徑時，插件本地自動安裝功能會被停用。
- OpenClaw 啟動時，後端健康檢查仍為非阻塞執行。

詳見 [Plugins](/tools/plugin)。

## 權限設定

ACP 會話以非互動方式執行 — 沒有 TTY 來批准或拒絕檔案寫入和 shell 執行權限提示。acpx 外掛提供兩個設定鍵來控制權限的處理方式：

### `permissionMode`

控制 harness agent 在不提示的情況下可執行的操作。

| 值              | 行為                                 |
| --------------- | ------------------------------------ |
| `approve-all`   | 自動批准所有檔案寫入和 shell 命令。  |
| `approve-reads` | 僅自動批准讀取；寫入和執行需要提示。 |
| `deny-all`      | 拒絕所有權限提示。                   |

### `nonInteractivePermissions`

控制當應該顯示權限提示但沒有互動式 TTY 可用時（ACP 會話永遠是這種情況）會發生什麼事。

| 值     | 行為                                           |
| ------ | ---------------------------------------------- |
| `fail` | 中止會話並顯示 `AcpRuntimeError`。**（預設）** |
| `deny` | 靜默拒絕該權限並繼續（優雅降級）。             |

### 設定方式

透過外掛設定設定：

```bash
openclaw config set plugins.entries.acpx.config.permissionMode approve-all
openclaw config set plugins.entries.acpx.config.nonInteractivePermissions fail
```

更改這些值後請重新啟動 gateway。

> **重要：** OpenClaw 目前預設為 `permissionMode=approve-reads` 和 `nonInteractivePermissions=fail`。在非互動式 ACP 會話中，任何觸發權限提示的寫入或執行都可能因 `AcpRuntimeError: Permission prompt unavailable in non-interactive mode` 而失敗。
>
> 如果需要限制權限，請將 `nonInteractivePermissions` 設為 `deny`，讓會話能優雅降級而非崩潰。

## 疑難排解

| 症狀                                                                     | 可能原因                                                       | 解決方法                                                                                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACP runtime backend is not configured`                                  | 後端外掛缺失或被停用。                                         | 安裝並啟用後端外掛，然後執行 `/acp doctor`。                                                                                                    |
| `ACP is disabled by policy (acp.enabled=false)`                          | ACP 全域被停用。                                               | 設定 `acp.enabled=true`。                                                                                                                       |
| `ACP dispatch is disabled by policy (acp.dispatch.enabled=false)`        | 禁用從一般執行緒訊息的分派。                                   | 設定 `acp.dispatch.enabled=true`。                                                                                                              |
| `ACP agent "<id>" is not allowed by policy`                              | Agent 不在允許清單中。                                         | 使用允許的 `agentId` 或更新 `acp.allowedAgents`。                                                                                               |
| `Unable to resolve session target: ...`                                  | 金鑰/ID/標籤 token 錯誤。                                      | 執行 `/acp sessions`，複製正確的金鑰/標籤，然後重試。                                                                                           |
| `--thread here requires running /acp spawn inside an active ... thread`  | `--thread here` 在非執行緒上下文中使用。                       | 移至目標執行緒或使用 `--thread auto`/`off`。                                                                                                    |
| `Only <user-id> can rebind this thread.`                                 | 另一使用者擁有執行緒綁定。                                     | 以擁有者身份重新綁定或使用不同執行緒。                                                                                                          |
| `Thread bindings are unavailable for <channel>.`                         | Adapter 缺乏執行緒綁定能力。                                   | 使用 `--thread off` 或移至支援的 adapter/channel。                                                                                              |
| `Sandboxed sessions cannot spawn ACP sessions ...`                       | ACP 執行時在主機端；請求者會話在沙箱中。                       | 從沙箱會話使用 `runtime="subagent"`，或從非沙箱會話執行 ACP spawn。                                                                             |
| `sessions_spawn sandbox="require" is unsupported for runtime="acp" ...`  | ACP 執行時請求了 `sandbox="require"`。                         | 對於必要的沙箱，使用 `runtime="subagent"`，或從非沙箱會話使用帶有 `sandbox="inherit"` 的 ACP。                                                  |
| 綁定會話缺少 ACP metadata                                                | ACP 會話 metadata 過期或已刪除。                               | 使用 `/acp spawn` 重新建立，然後重新綁定/聚焦執行緒。                                                                                           |
| `AcpRuntimeError: Permission prompt unavailable in non-interactive mode` | `permissionMode` 在非互動式 ACP 會話中阻擋寫入/執行。          | 將 `plugins.entries.acpx.config.permissionMode` 設為 `approve-all` 並重新啟動 gateway。詳見[權限設定](#permission-configuration)。              |
| ACP 會話早期失敗且輸出很少                                               | 權限提示被 `permissionMode`/`nonInteractivePermissions` 阻擋。 | 檢查 gateway 日誌中的 `AcpRuntimeError`。若需完整權限，設定 `permissionMode=approve-all`；若需優雅降級，設定 `nonInteractivePermissions=deny`。 |
| ACP 會話完成工作後無限期停滯                                             | Harness 程序已結束但 ACP 會話未回報完成。                      | 使用 `ps aux \| grep acpx` 監控；手動終止過期程序。                                                                                             |
