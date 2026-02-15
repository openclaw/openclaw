---
summary: "OpenClaw 的智慧代理工具介面（browser、canvas、nodes、message、cron），取代舊有的 `openclaw-*` Skills"
read_when:
  - 新增或修改智慧代理工具時
  - 停用或變更 `openclaw-*` Skills 時
title: "工具"
---

# 工具 (OpenClaw)

OpenClaw 為 browser、canvas、nodes 與 cron 提供了**一等智慧代理工具 (first-class agent tools)**。
這些工具取代了舊有的 `openclaw-*` Skills：工具皆具備型別定義 (typed)，無需執行 Shell 指令，智慧代理應直接依賴它們。

## 停用工具

您可以透過 `openclaw.json` 中的 `tools.allow` / `tools.deny` 全域允許或拒絕工具（以拒絕清單優先）。這可以防止不被允許的工具被發送到模型供應商。

```json5
{
  tools: { deny: ["browser"] },
}
```

備註：

- 比對不區分大小寫。
- 支援 `*` 萬用字元（`"*"` 表示所有工具）。
- 如果 `tools.allow` 僅參照到未知或未載入的外掛程式工具名稱，OpenClaw 會記錄警告並忽略允許清單，以確保核心工具保持可用。

## 工具設定檔 (基礎允許清單)

`tools.profile` 在 `tools.allow`/`tools.deny` 之前設定**基礎工具允許清單**。
智慧代理個別覆寫：`agents.list[].tools.profile`。

設定檔類型：

- `minimal`: 僅限 `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: 無限制（與未設定相同）

範例（預設僅限通訊工具，但也允許 Slack + Discord 工具）：

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

範例（使用 coding 設定檔，但在所有地方拒絕執行/程序工具）：

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

範例（全域使用 coding 設定檔，但支援代理僅限通訊工具）：

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## 供應商專用工具策略

使用 `tools.byProvider` 為特定的供應商（或單一 `provider/model`）**進一步限制**工具，而無需更改您的全域預設值。
智慧代理個別覆寫：`agents.list[].tools.byProvider`。

此設定會在基礎工具設定檔**之後**以及允許/拒絕清單**之前**套用，因此它只能縮小工具集。
供應商鍵名接受 `provider`（例如 `google-antigravity`）或 `provider/model`（例如 `openai/gpt-5.2`）。

範例（保持全域 coding 設定檔，但對 Google Antigravity 使用最小化工具）：

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

範例（針對不穩定的端點使用供應商/模型專用的允許清單）：

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

範例（針對單一供應商進行智慧代理個別覆寫）：

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## 工具群組 (簡寫)

工具策略（全域、智慧代理、沙箱）支援 `group:*` 項目，可展開為多個工具。
請在 `tools.allow` / `tools.deny` 中使用這些項目。

可用群組：

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: 所有內建的 OpenClaw 工具（不含供應商外掛程式）

範例（僅允許檔案工具 + 瀏覽器）：

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## 外掛程式 + 工具

外掛程式可以註冊核心工具集之外的**額外工具**（以及 CLI 指令）。
請參閱 [外掛程式](/tools/plugin) 了解安裝與設定，以及 [Skills](/tools/skills) 了解工具使用指引如何注入到提示詞中。某些外掛程式在提供工具的同時也會附帶自己的 Skills（例如語音通話外掛程式）。

選用外掛程式工具：

- [Lobster](/tools/lobster): 具備可恢復審核機制的型別化工作流執行環境（需要在 Gateway 主機上安裝 Lobster CLI）。
- [LLM Task](/tools/llm-task): 僅限 JSON 的 LLM 步驟，用於結構化工作流輸出（選用的結構定義驗證）。

## 工具清單

### `apply_patch`

在一個或多個檔案中套用結構化補丁。用於多區塊 (multi-hunk) 編輯。
實驗性功能：透過 `tools.exec.applyPatch.enabled` 啟用（僅限 OpenAI 模型）。

### `exec`

在工作區執行 Shell 指令。

核心參數：

- `command` (必要)
- `yieldMs` (逾時後自動轉入背景，預設為 10000)
- `background` (立即轉入背景)
- `timeout` (秒；若超過則刪除程序，預設為 1800)
- `elevated` (布林值；若已啟用/允許提高權限模式，則在主機上執行；僅在智慧代理被沙箱隔離時才會改變行為)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (當 `host=node` 時的節點 ID/名稱)
- 需要真實的 TTY？設定 `pty: true`。

備註：

- 轉入背景執行時，會回傳 `status: "running"` 以及一個 `sessionId`。
- 使用 `process` 來輪詢/記錄/寫入/刪除/清除背景工作階段。
- 如果 `process` 被禁用，`exec` 會同步執行並忽略 `yieldMs`/`background`。
- `elevated` 受控於 `tools.elevated` 以及任何 `agents.list[].tools.elevated` 覆寫（兩者皆須允許），且為 `host=gateway` + `security=full` 的別名。
- `elevated` 僅在智慧代理被沙箱隔離時才會改變行為（否則無效）。
- `host=node` 可以指向 macOS 配套應用或無介面 (headless) 節點主機 (`openclaw node run`)。
- Gateway/節點審核與允許清單：[Exec 審核](/tools/exec-approvals)。

### `process`

管理背景執行工作階段。

核心動作：

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

備註：

- `poll` 在完成時回傳新輸出與結束狀態。
- `log` 支援基於行數的 `offset`/`limit`（省略 `offset` 則獲取最後 N 行）。
- `process` 的範圍限於每個智慧代理；無法看到來自其他智慧代理的工作階段。

### `web_search`

使用 Brave Search API 搜尋網路。

核心參數：

- `query` (必要)
- `count` (1–10；預設值來自 `tools.web.search.maxResults`)

備註：

- 需要 Brave API 金鑰（推薦：`openclaw configure --section web`，或設定 `BRAVE_API_KEY`）。
- 透過 `tools.web.search.enabled` 啟用。
- 回應會被快取（預設 15 分鐘）。
- 請參閱 [網路工具](/tools/web) 了解設定詳情。

### `web_fetch`

從 URL 擷取並提取可讀內容（HTML → markdown/text）。

核心參數：

- `url` (必要)
- `extractMode` (`markdown` | `text`)
- `maxChars` (截斷過長的頁面)

備註：

- 透過 `tools.web.fetch.enabled` 啟用。
- `maxChars` 受限於 `tools.web.fetch.maxCharsCap`（預設 50000）。
- 回應會被快取（預設 15 分鐘）。
- 對於重度使用 JS 的網站，建議優先使用 browser 工具。
- 請參閱 [網路工具](/tools/web) 了解設定詳情。
- 請參閱 [Firecrawl](/tools/firecrawl) 了解選用的反機器人備援方案。

### `browser`

控制 OpenClaw 管理的專用瀏覽器。

核心動作：

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (回傳影像區塊 + `MEDIA:<路徑>`)
- `act` (UI 動作：點擊/輸入/按壓/懸停/拖曳/選取/填寫/調整大小/等待/評估)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

設定檔管理：

- `profiles` — 列出所有瀏覽器設定檔及其狀態
- `create-profile` — 建立新設定檔並自動分配連接埠（或 `cdpUrl`）
- `delete-profile` — 停止瀏覽器、刪除使用者資料，並從設定中移除（僅限本地）
- `reset-profile` — 刪除設定檔連接埠上的孤兒程序（僅限本地）

常用參數：

- `profile` (選用；預設為 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (選用；挑選特定的節點 ID/名稱)

備註：

- 需要 `browser.enabled=true`（預設為 `true`；設定為 `false` 以停用）。
- 所有動作皆接受選用的 `profile` 參數以支援多執行個體。
- 當省略 `profile` 時，使用 `browser.defaultProfile`（預設為 "chrome"）。
- 設定檔名稱：僅限小寫字母數字 + 連字號（最多 64 個字元）。
- 連接埠範圍：18800-18899（最多約 100 個設定檔）。
- 遠端設定檔僅限附加 (attach-only)（無法啟動/停止/重設）。
- 如果連接了具備瀏覽器能力的節點，工具可能會自動路由至該節點（除非您固定了 `target`）。
- 安裝 Playwright 後，`snapshot` 預設為 `ai`；使用 `aria` 獲取無障礙樹 (accessibility tree)。
- `snapshot` 也支援角色快照 (role-snapshot) 選項（`interactive`, `compact`, `depth`, `selector`），會回傳如 `e12` 之類的參照。
- `act` 需要來自 `snapshot` 的 `ref`（AI 快照為數字如 `12`，或角色快照如 `e12`）；對於罕見的 CSS 選擇器需求，請使用 `evaluate`。
- 預設請避免使用 `act` → `wait`；僅在特殊情況下使用（沒有可靠的 UI 狀態可供等待）。
- `upload` 可以選用傳遞一個 `ref` 以在準備好後自動點擊。
- `upload` 也支援 `inputRef`（aria 參照）或 `element`（CSS 選擇器）來直接設定 `<input type="file">`。

### `canvas`

驅動節點 Canvas (present, eval, snapshot, A2UI)。

核心動作：

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (回傳影像區塊 + `MEDIA:<路徑>`)
- `a2ui_push`, `a2ui_reset`

備註：

- 底層使用 Gateway `node.invoke`。
- 如果未提供 `node`，工具會挑選預設值（單一連接節點或本地 Mac 節點）。
- A2UI 僅限 v0.8（無 `createSurface`）；CLI 會拒絕帶有行錯誤的 v0.9 JSONL。
- 快速測試：`openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`。

### `nodes`

探索並定位已配對的節點；發送通知；擷取攝影機/螢幕。

核心動作：

- `status`, `describe`
- `pending`, `approve`, `reject` (配對)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

備註：

- 攝影機/螢幕指令要求節點應用程式處於前景。
- 影像會回傳影像區塊 + `MEDIA:<路徑>`。
- 影片會回傳 `FILE:<路徑>` (mp4)。
- 位置會回傳 JSON 內容（緯度/經度/準確度/時間戳記）。
- `run` 參數：`command` 引數陣列；選用的 `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`。

範例 (`run`)：

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

使用設定的影像模型分析影像。

核心參數：

- `image` (必要的路徑或 URL)
- `prompt` (選用；預設為 "Describe the image.")
- `model` (選用覆寫)
- `maxBytesMb` (選用的檔案大小上限)

備註：

- 僅在設定了 `agents.defaults.imageModel`（主模型或備援）時可用，或當可以從您的預設模型 + 設定的憑證推斷出隱含的影像模型時可用（最佳實務配對）。
- 直接使用影像模型（獨立於主聊天模型）。

### `message`

在 Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 之間發送訊息與執行頻道動作。

核心動作：

- `send`（文字 + 選用媒體；MS Teams 也支援用於彈性卡片的 `card`）
- `poll` (WhatsApp/Discord/MS Teams 投票)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

備註：

- `send` 透過 Gateway 路由 WhatsApp；其他頻道則直接發送。
- `poll` 對於 WhatsApp 和 MS Teams 使用 Gateway；Discord 投票則直接發送。
- 當訊息工具呼叫被綁定到一個活動中的聊天工作階段時，發送會被限制在該工作階段的目標內，以避免跨上下文外洩。

### `cron`

管理 Gateway cron 工作與喚醒。

核心動作：

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (加入系統事件佇列 + 選用的立即活動訊號)

備註：

- `add` 需要完整的 cron 工作物件（結構與 `cron.add` RPC 相同）。
- `update` 使用 `{ jobId, patch }`（為了相容性也接受 `id`）。

### `gateway`

重啟或對執行中的 Gateway 程序套用更新（原地更新）。

核心動作：

- `restart`（授權 + 發送 `SIGUSR1` 進行程序內重啟；原地重啟 `openclaw gateway`）
- `config.get` / `config.schema`
- `config.apply` (驗證 + 寫入設定 + 重啟 + 喚醒)
- `config.patch` (合併部分更新 + 重啟 + 喚醒)
- `update.run` (執行更新 + 重啟 + 喚醒)

備註：

- 使用 `delayMs`（預設為 2000）以避免中斷正在進行的回覆。
- `restart` 預設為停用；請透過 `commands.restart: true` 啟用。

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

列出工作階段、檢查對話歷史紀錄，或發送到另一個工作階段。

核心參數：

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = 無)
- `sessions_history`: `sessionKey` (或 `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (或 `sessionId`), `message`, `timeoutSeconds?` (0 = 發送後不理)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (預設為目前；接受 `sessionId`), `model?` (`default` 會清除覆寫)

備註：

- `main` 是標準的直接聊天鍵名；全域/未知會被隱藏。
- `messageLimit > 0` 會獲取每個工作階段最後 N 條訊息（已過濾工具訊息）。
- 當 `timeoutSeconds > 0` 時，`sessions_send` 會等待最終完成。
- 交付/通知發生在完成後且為盡力而為；`status: "ok"` 確認智慧代理執行結束，而非通知已交付。
- `sessions_spawn` 啟動一個子智慧代理執行，並在請求者聊天中回傳一個通知回覆。
- `sessions_spawn` 是非阻塞的，且會立即回傳 `status: "accepted"`。
- `sessions_send` 執行一個回覆式乒乓 (reply-back ping-pong)（回覆 `REPLY_SKIP` 以停止；最大次數透過 `session.agentToAgent.maxPingPongTurns` 設定，0–5）。
- 在乒乓結束後，目標智慧代理會執行一個**通知步驟**；回覆 `ANNOUNCE_SKIP` 以隱藏通知。

### `agents_list`

列出目前工作階段可能透過 `sessions_spawn` 定位到的智慧代理 ID。

備註：

- 結果受限於每個智慧代理的允許清單 (`agents.list[].subagents.allowAgents`)。
- 當設定為 `["*"]` 時，工具會包含所有已設定的智慧代理並標記 `allowAny: true`。

## 參數 (通用)

由 Gateway 支援的工具 (`canvas`, `nodes`, `cron`)：

- `gatewayUrl` (預設為 `ws://127.0.0.1:18789`)
- `gatewayToken` (如果已啟用驗證)
- `timeoutMs`

備註：設定 `gatewayUrl` 時，請明確包含 `gatewayToken`。工具不會繼承設定或環境變數中的憑證來進行覆寫，遺漏明確憑證將會報錯。

瀏覽器工具：

- `profile` (選用；預設為 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (選用；固定特定的節點 ID/名稱)

## 推薦的智慧代理流程

瀏覽器自動化：

1. `browser` → `status` / `start`
2. `snapshot` (ai 或 aria)
3. `act` (點擊/輸入/按壓)
4. 若需要視覺確認，請執行 `screenshot`

Canvas 渲染：

1. `canvas` → `present`
2. `a2ui_push` (選用)
3. `snapshot`

節點定位：

1. `nodes` → `status`
2. 對選定的節點執行 `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## 安全性

- 避免直接執行 `system.run`；僅在使用者明確同意的情況下使用 `nodes` → `run`。
- 尊重使用者對攝影機/螢幕擷取的同意。
- 在叫用媒體指令之前，使用 `status/describe` 確保權限。

## 工具如何呈現給智慧代理

工具透過兩個平行頻道呈現：

1. **系統提示文字**：人類可讀的清單與指引。
2. **工具結構定義**：發送到模型 API 的結構化函式定義。

這表示智慧代理既能看到「存在哪些工具」，也能看到「如何呼叫它們」。如果工具沒有出現在系統提示詞或結構定義中，模型就無法呼叫它。
