---
summary: "斜線指令：文字 vs 原生、設定與支援的指令"
read_when:
  - 使用或設定聊天指令時
  - 偵錯指令路由或權限時
title: "斜線指令"
---

# 斜線指令

29. 指令由 Gateway 處理。 30. 大多數指令必須作為**獨立**訊息傳送，且以 `/` 開頭。
    The host-only bash chat command uses `! <cmd>`（`/bash <cmd>` 為別名）。

有兩個相關的系統：

- **Commands**：獨立的 `/...` 訊息。
- **Directives**：`/think`、`/verbose`、`/reasoning`、`/elevated`、`/exec`、`/model`、`/queue`。
  - Directives 會在模型看到訊息之前被移除。
  - 在一般聊天訊息（非僅含 directive）中，它們會被視為「內嵌提示」，且**不會**持久化工作階段設定。
  - 在僅含 directive 的訊息（訊息只包含 directives）中，它們會持久化到工作階段，並回覆確認。
  - Directives 僅會套用於**已授權的寄件者**（頻道允許清單／配對，加上 `commands.useAccessGroups`）。
    未授權的寄件者會看到 directives 被當作一般文字處理。
    32. 未授權的傳送者會看到指示被當作純文字處理。

另有一些**內嵌捷徑**（僅限允許清單／已授權寄件者）：`/help`、`/commands`、`/status`、`/whoami`（`/id`）。
它們會立即執行，並在模型看到訊息前被移除，其餘文字會依正常流程繼續處理。
They run immediately, are stripped before the model sees the message, and the remaining text continues through the normal flow.

## 設定

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text`（預設 `true`）啟用在聊天訊息中解析 `/...`。
  - 在沒有原生指令的介面（WhatsApp／WebChat／Signal／iMessage／Google Chat／MS Teams）上，即使你將此設為 `false`，文字指令仍可運作。
- `commands.native`（預設 `"auto"`）註冊原生指令。
  - Auto：Discord／Telegram 為開；Slack 為關（直到你加入斜線指令）；對不支援原生的提供者會被忽略。
  - 設定 `channels.discord.commands.native`、`channels.telegram.commands.native` 或 `channels.slack.commands.native` 以依提供者覆寫（bool 或 `"auto"`）。
  - `false` clears previously registered commands on Discord/Telegram at startup. `false` 會在啟動時清除 Discord／Telegram 先前註冊的指令。Slack 指令由 Slack 應用程式管理，且不會自動移除。
- `commands.nativeSkills`（預設 `"auto"`）在支援時以原生方式註冊 **skill** 指令。
  - Auto：Discord／Telegram 為開；Slack 為關（Slack 需要為每個 skill 建立一個斜線指令）。
  - 設定 `channels.discord.commands.nativeSkills`、`channels.telegram.commands.nativeSkills` 或 `channels.slack.commands.nativeSkills` 以依提供者覆寫（bool 或 `"auto"`）。
- `commands.bash`（預設 `false`）啟用 `! <cmd>` 以執行主機 shell 指令（`/bash <cmd>` 為別名；需要 `tools.elevated` 允許清單）。
- `commands.bashForegroundMs`（預設 `2000`）控制 bash 在切換到背景模式前等待的時間（`0` 會立即背景化）。
- `commands.config`（預設 `false`）啟用 `/config`（讀取／寫入 `openclaw.json`）。
- `commands.debug`（預設 `false`）啟用 `/debug`（僅執行期覆寫）。
- `commands.useAccessGroups`（預設 `true`）對指令強制套用允許清單／政策。

## 指令清單

文字 + 原生（啟用時）：

- `/help`
- `/commands`
- `/skill <name> [input]`（依名稱執行 skill）
- `/status`（顯示目前狀態；在可用時包含目前模型提供者的使用量／配額）
- `/allowlist`（列出／新增／移除允許清單項目）
- `/approve <id> allow-once|allow-always|deny`（解決 exec 核准提示）
- `/context [list|detail|json]`（解釋「context」；`detail` 會顯示每個檔案 + 每個工具 + 每個 skill + 系統提示的大小）
- `/whoami`（顯示你的寄件者 id；別名：`/id`）
- `/subagents list|stop|log|info|send`（檢視、停止、記錄或傳訊目前工作階段的子代理執行）
- `/config show|get|set|unset`（將設定持久化到磁碟，僅限擁有者；需要 `commands.config: true`）
- `/debug show|set|unset|reset`（執行期覆寫，僅限擁有者；需要 `commands.debug: true`）
- `/usage off|tokens|full|cost`（每次回應的使用量頁尾或本地成本摘要）
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio`（控制 TTS；請見 [/tts](/tts)）
  - Discord：原生指令為 `/voice`（Discord 保留 `/tts`）；文字 `/tts` 仍可使用。
- `/stop`
- `/restart`
- `/dock-telegram`（別名：`/dock_telegram`）（將回覆切換到 Telegram）
- `/dock-discord`（別名：`/dock_discord`）（將回覆切換到 Discord）
- `/dock-slack`（別名：`/dock_slack`）（將回覆切換到 Slack）
- `/activation mention|always`（僅限群組）
- `/send on|off|inherit`（僅限擁有者）
- `/reset` 或 `/new [model]`（可選模型提示；其餘內容會原樣傳遞）
- `/think <off|minimal|low|medium|high|xhigh>`（依模型／提供者提供動態選項；別名：`/thinking`、`/t`）
- `/verbose on|full|off`（別名：`/v`）
- `/reasoning on|off|stream`（別名：`/reason`；開啟時，會傳送一則以 `Reasoning:` 開頭的獨立訊息；`stream` = 僅 Telegram 草稿）
- `/elevated on|off|ask|full`（別名：`/elev`；`full` 會略過 exec 核准）
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`（傳送 `/exec` 以顯示目前狀態）
- `/model <name>`（別名：`/models`；或從 `agents.defaults.models.*.alias` 使用 `/<alias>`）
- `/queue <mode>`（以及如 `debounce:2s cap:25 drop:summarize` 等選項；傳送 `/queue` 以查看目前設定）
- `/bash <command>`（僅限主機；`! <command>` 的別名；需要 `commands.bash: true` + `tools.elevated` 允許清單）

僅文字：

- `/compact [instructions]`（請見 [/concepts/compaction](/concepts/compaction)）
- `! <command>`（僅限主機；一次一個；長時間工作請使用 `!poll` + `!stop`）
- `!poll`（檢查輸出／狀態；接受可選的 `sessionId`；`/bash poll` 亦可）
- `!stop`（停止正在執行的 bash 工作；接受可選的 `sessionId`；`/bash stop` 亦可）

注意事項：

- 指令可在指令與參數之間接受可選的 `:`（例如：`/think: high`、`/send: on`、`/help:`）。
- `/new <model>` 接受模型別名、`provider/model` 或提供者名稱（模糊比對）；若無相符，文字會被視為訊息內容。
- 若要取得完整的提供者使用量明細，請使用 `openclaw status --usage`。
- `/allowlist add|remove` 需要 `commands.config=true`，並遵循頻道 `configWrites`。
- `/usage` 控制每次回應的使用量頁尾；`/usage cost` 會從 OpenClaw 工作階段記錄列印本地成本摘要。
- `/restart` 預設停用；設定 `commands.restart: true` 以啟用。
- `/verbose` 用於偵錯與額外可見性；一般使用時請保持**關閉**。
- `/reasoning`（以及 `/verbose`）在群組情境中具風險：可能揭露你不打算公開的內部推理或工具輸出。建議保持關閉，尤其是在群聊中。 Prefer leaving them off, especially in group chats.
- **快速路徑：** 來自允許清單寄件者的僅指令訊息會立即處理（略過佇列 + 模型）。
- **群組提及閘控：** 來自允許清單寄件者的僅指令訊息會略過提及需求。
- **內嵌捷徑（僅限允許清單寄件者）：** 某些指令也可內嵌在一般訊息中，並在模型看到剩餘文字前被移除。
  - 範例：`hey /status` 會觸發狀態回覆，其餘文字會依正常流程繼續。
- 目前支援：`/help`、`/commands`、`/status`、`/whoami`（`/id`）。
- 未授權的僅指令訊息會被靜默忽略，而內嵌的 `/...` token 會被視為一般文字。
- **Skill 指令：** `user-invocable` skills 會以斜線指令形式公開。名稱會被清理為 `a-z0-9_`（最長 32 字元）；發生衝突時會加上數字尾碼（例如：`_2`）。 Names are sanitized to `a-z0-9_` (max 32 chars); collisions get numeric suffixes (e.g. `_2`).
  - `/skill <name> [input]` 依名稱執行 skill（當原生指令限制無法為每個 skill 建立指令時很有用）。
  - By default, skill commands are forwarded to the model as a normal request.
  - Skills 可選擇宣告 `command-dispatch: tool`，以將指令直接路由到工具（具決定性，不經模型）。
  - 範例：`/prose`（OpenProse 外掛）— 請見 [OpenProse](/prose)。
- **Native command arguments:** Discord uses autocomplete for dynamic options (and button menus when you omit required args). Telegram and Slack show a button menu when a command supports choices and you omit the arg.

## 使用介面（顯示位置）

- **提供者使用量／配額**（例如：「Claude 剩餘 80%」）在啟用使用量追蹤時，會顯示於目前模型提供者的 `/status`。
- **每次回應的 tokens／成本** 由 `/usage off|tokens|full` 控制（附加在一般回覆後）。
- `/model status` 與**模型／身分驗證／端點**相關，而非使用量。

## 模型選擇（`/model`）

`/model` 以 directive 的方式實作。

範例：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

注意事項：

- `/model` 與 `/model list` 會顯示精簡、編號的選擇器（模型家族 + 可用提供者）。
- `/model <#>` 從該選擇器中選擇（並在可能時偏好目前的提供者）。
- `/model status` 顯示詳細檢視，包括設定的提供者端點（`baseUrl`）與 API 模式（`api`）（若可用）。

## Debug overrides

`/debug` 讓你設定**僅執行期**的設定覆寫（僅記憶體，不寫入磁碟）。僅限擁有者。預設停用；使用 `commands.debug: true` 啟用。 Owner-only. 42. 預設停用；以 `commands.debug: true` 啟用。

範例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

注意事項：

- 覆寫會立即套用到新的設定讀取，但**不會**寫入 `openclaw.json`。
- 使用 `/debug reset` 清除所有覆寫並回到磁碟上的設定。

## 設定更新

`/config` 會寫入磁碟上的設定（`openclaw.json`）。僅限擁有者。預設停用；使用 `commands.config: true` 啟用。 Owner-only. Disabled by default; enable with `commands.config: true`.

範例：

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

注意事項：

- Config is validated before write; invalid changes are rejected.
- `/config` 的更新會在重新啟動後持續存在。

## 46. 介面備註

- **文字指令** 在一般聊天工作階段中執行（私訊共用 `main`，群組各自有其工作階段）。
- **原生指令** 使用隔離的工作階段：
  - Discord：`agent:<agentId>:discord:slash:<userId>`
  - Slack：`agent:<agentId>:slack:slash:<userId>`（前綴可透過 `channels.slack.slashCommand.sessionPrefix` 設定）
  - Telegram：`telegram:slash:<userId>`（透過 `CommandTargetSessionKey` 指向聊天工作階段）
- **`/stop`** 會指向目前的聊天工作階段，以便中止目前的執行。
- **Slack：** 仍支援單一 `/openclaw` 風格指令的 `channels.slack.slashCommand`。若啟用 `commands.native`，你必須為每個內建指令建立一個 Slack 斜線指令（名稱與 `/help` 相同）。Slack 的指令參數選單會以暫時性的 Block Kit 按鈕提供。 47. 若你啟用 `commands.native`，必須為每個內建指令建立一個 Slack 斜線指令（名稱與 `/help` 相同）。 Command argument menus for Slack are delivered as ephemeral Block Kit buttons.
