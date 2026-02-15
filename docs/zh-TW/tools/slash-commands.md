---
summary: "斜線指令：文字與原生、設定，以及支援的指令"
read_when:
  - 使用或設定聊天指令
  - 偵錯指令路由或權限
title: "斜線指令"
---

# 斜線指令

指令由 Gateway 處理。大多數指令必須以 `/` 開頭的**獨立**訊息傳送。
僅限主機的 bash 聊天指令使用 `! <cmd>`（以 `/bash <cmd>` 作為別名）。

有兩個相關的系統：

- **指令**：獨立的 `/...` 訊息。
- **指令語法**：`/think`、`/verbose`、`/reasoning`、`/elevated`、`/exec`、`/model`、`/queue`。
  - 指令語法會在模型看到訊息之前從訊息中移除。
  - 在正常聊天訊息（非僅限指令語法）中，它們被視為「內嵌提示」，並且**不會**保留工作階段設定。
  - 在僅限指令語法的訊息（訊息只包含指令語法）中，它們會保留到工作階段並回覆確認。
  - 指令語法僅適用於**已授權的傳送者**。如果設定了 `commands.allowFrom`，則這是唯一使用的允許清單；否則授權來自頻道允許清單/配對以及 `commands.useAccessGroups`。未經授權的傳送者會將指令語法視為純文字處理。

還有一些**內嵌捷徑**（僅限允許清單/已授權的傳送者）：`/help`、`/commands`、`/status`、`/whoami` (`/id`)。
它們會立即執行，在模型看到訊息之前被移除，其餘文字會繼續正常流程。

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
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

- `commands.text` (預設 `true`) 啟用聊天訊息中的 `/...` 解析。
  - 在沒有原生指令的平台上 (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams)，即使您將其設定為 `false`，文字指令仍然有效。
- `commands.native` (預設 `"auto"`) 註冊原生指令。
  - Auto：Discord/Telegram 啟用；Slack 關閉 (直到您加入斜線指令)；對於不支援原生功能的供應商則忽略。
  - 設定 `channels.discord.commands.native`、`channels.telegram.commands.native` 或 `channels.slack.commands.native` 以覆寫每個供應商的設定 (布林值或 `"auto"`)。
  - `false` 會在啟動時清除 Discord/Telegram 上先前註冊的指令。Slack 指令在 Slack 應用程式中管理，不會自動移除。
- `commands.nativeSkills` (預設 `"auto"`) 在支援時原生註冊 **skill** 指令。
  - Auto：Discord/Telegram 啟用；Slack 關閉 (Slack 需要為每個 skill 建立一個斜線指令)。
  - 設定 `channels.discord.commands.nativeSkills`、`channels.telegram.commands.nativeSkills` 或 `channels.slack.commands.nativeSkills` 以覆寫每個供應商的設定 (布林值或 `"auto"`)。
- `commands.bash` (預設 `false`) 啟用 `! <cmd>` 以執行主機 shell 指令 (`/bash <cmd>` 是一個別名；需要 `tools.elevated` 允許清單)。
- `commands.bashForegroundMs` (預設 `2000`) 控制 bash 在切換到背景模式之前等待的時間 (`0` 立即背景執行)。
- `commands.config` (預設 `false`) 啟用 `/config` (讀取/寫入 `openclaw.json`)。
- `commands.debug` (預設 `false`) 啟用 `/debug` (僅限執行時覆寫)。
- `commands.allowFrom` (選填) 設定每個供應商的允許清單，用於指令授權。配置後，它是指令和指令語法的唯一授權來源（頻道允許清單/配對和 `commands.useAccessGroups` 將被忽略）。使用 `"*"` 作為全域預設值；供應商特定的鍵名會覆寫它。
- `commands.useAccessGroups` (預設 `true`) 在未設定 `commands.allowFrom` 時，強制執行指令的允許清單/策略。

## 指令列表

文字 + 原生 (啟用時)：

- `/help`
- `/commands`
- `/skill <name> [input]` (依名稱執行 skill)
- `/status` (顯示目前狀態；包含目前模型供應商可用的供應商用量/配額)
- `/allowlist` (列出/新增/移除允許清單項目)
- `/approve <id> allow-once|allow-always|deny` (解決執行核准提示)
- `/context [list|detail|json]` (解釋「上下文」；`detail` 顯示每個檔案 + 每個工具 + 每個 skill + 系統提示大小)
- `/whoami` (顯示您的傳送者 ID；別名：`/id`)
- `/subagents list|stop|log|info|send` (檢查、停止、記錄或傳送訊息給目前工作階段的子智慧代理執行)
- `/config show|get|set|unset` (將設定儲存到磁碟，僅限擁有者；需要 `commands.config: true`)
- `/debug show|set|unset|reset` (執行時覆寫，僅限擁有者；需要 `commands.debug: true`)
- `/usage off|tokens|full|cost` (每次回應的用量頁腳或本地成本摘要)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (控制 TTS；請參閱 [/tts](/tts))
  - Discord：原生指令為 `/voice` (Discord 保留 `/tts`)；文字 `/tts` 仍然有效。
- `/stop`
- `/restart`
- `/dock-telegram` (別名：`/dock_telegram`) (切換回覆到 Telegram)
- `/dock-discord` (別名：`/dock_discord`) (切換回覆到 Discord)
- `/dock-slack` (別名：`/dock_slack`) (切換回覆到 Slack)
- `/activation mention|always` (僅限群組)
- `/send on|off|inherit` (僅限擁有者)
- `/reset` 或 `/new [model]` (選填模型提示；其餘部分會直接傳遞)
- `/think <off|minimal|low|medium|high|xhigh>` (依模型/供應商動態選擇；別名：`/thinking`、`/t`)
- `/verbose on|full|off` (別名：`/v`)
- `/reasoning on|off|stream` (別名：`/reason`；啟用時，傳送以 `Reasoning:` 為前綴的獨立訊息；`stream` = 僅限 Telegram 草稿)
- `/elevated on|off|ask|full` (別名：`/elev`；`full` 跳過執行核准)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (傳送 `/exec` 以顯示目前設定)
- `/model <name>` (別名：`/models`；或來自 `agents.defaults.models.*.alias` 的 `/<alias>`)
- `/queue <mode>` (加上 `debounce:2s cap:25 drop:summarize` 等選項；傳送 `/queue` 以查看目前設定)
- `/bash <command>` (僅限主機；`! <command>` 的別名；需要 `commands.bash: true` + `tools.elevated` 允許清單)

僅限文字：

- `/compact [instructions]` (請參閱 [/concepts/compaction](/concepts/compaction))
- `! <command>` (僅限主機；一次一個；對於長時間運行的作業使用 `!poll` + `!stop`)
- `!poll` (檢查輸出/狀態；接受選填的 `sessionId`；`/bash poll` 也有效)
- `!stop` (停止正在運行的 bash 作業；接受選填的 `sessionId`；`/bash stop` 也有效)

注意事項：

- 指令在指令和參數之間可以接受選填的 `:` (例如 `/think: high`、`/send: on`、`/help:`)。
- `/new <model>` 接受模型別名、`provider/model` 或供應商名稱 (模糊匹配)；如果沒有匹配，文字將被視為訊息主體。
- 如需完整的供應商用量細目，請使用 `openclaw status --usage`。
- `/allowlist add|remove` 需要 `commands.config=true` 並遵循頻道 `configWrites`。
- `/usage` 控制每次回應的用量頁腳；`/usage cost` 從 OpenClaw 工作階段記錄中列印本地成本摘要。
- `/restart` 預設為停用；設定 `commands.restart: true` 以啟用它。
- `/verbose` 用於偵錯和額外可見性；在正常使用中請將其保持**關閉**。
- `/reasoning` (和 `/verbose`) 在群組設定中存在風險：它們可能會洩露您不打算公開的內部推理或工具輸出。在群組聊天中，最好將它們保持關閉。
- **快速路徑**：來自允許清單傳送者的僅指令訊息會立即處理 (繞過佇列 + 模型)。
- **群組提及閘門**：來自允許清單傳送者的僅指令訊息繞過提及要求。
- **內嵌捷徑 (僅限允許清單傳送者)**：某些指令在內嵌於普通訊息中時也有效，並在模型看到其餘文字之前被移除。
  - 範例：`hey /status` 觸發狀態回覆，其餘文字繼續正常流程。
- 目前：`/help`、`/commands`、`/status`、`/whoami` (`/id`)。
- 未經授權的僅指令訊息會被靜默忽略，內嵌的 `/...` 標記被視為純文字。
- **Skill 指令**：`user-invocable` skills 會公開為斜線指令。名稱會被淨化為 `a-z0-9_` (最多 32 個字元)；衝突會取得數字後綴 (例如 `_2`)。
  - `/skill <name> [input]` 依名稱執行 skill (在原生指令限制阻礙每個 skill 的指令時很有用)。
  - 預設情況下，skill 指令會作為正常請求轉發給模型。
  - Skills 可以選填聲明 `command-dispatch: tool` 以將指令直接路由到工具 (確定性，無模型)。
  - 範例：`/prose` (OpenProse 插件) — 請參閱 [OpenProse](/prose)。
- **原生指令參數**：Discord 使用自動完成來提供動態選項 (以及在您省略必要參數時的按鈕選單)。Telegram 和 Slack 在指令支援選項且您省略參數時顯示按鈕選單。

## 使用介面 (顯示位置)

- **供應商用量/配額** (範例：「Claude 剩餘 80%」) 顯示在 `/status` 中，用於啟用用量追蹤時的目前模型供應商。
- **每次回應的權杖/成本** 由 `/usage off|tokens|full` 控制 (附加到正常回覆)。
- `/model status` 是關於**模型/認證/端點**，而不是用量。

## 模型選擇 (`/model`)

`/model` 以指令語法實作。

範例：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus @anthropic:default
/model status
```

注意事項：

- `/model` 和 `/model list` 顯示簡潔的編號選擇器 (模型系列 + 可用供應商)。
- `/model <#>` 從該選擇器中選擇 (並盡可能偏好目前的供應商)。
- `/model status` 顯示詳細檢視，包括配置的供應商端點 (`baseUrl`) 和可用的 API 模式 (`api`)。

## 偵錯覆寫

`/debug` 允許您設定**僅限執行時**的設定覆寫 (記憶體中，非磁碟)。僅限擁有者。預設為停用；使用 `commands.debug: true` 啟用。

範例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

注意事項：

- 覆寫會立即應用於新的設定讀取，但**不會**寫入 `openclaw.json`。
- 使用 `/debug reset` 清除所有覆寫並返回磁碟上的設定。

## 設定更新

`/config` 會寫入您的磁碟上設定 (`openclaw.json`)。僅限擁有者。預設為停用；使用 `commands.config: true` 啟用。

範例：

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

注意事項：

- 設定會在寫入前進行驗證；無效的變更會被拒絕。
- `/config` 更新會在重新啟動後保留。

## 介面注意事項

- **文字指令**在正常的聊天工作階段中運行 (私訊共用 `main`，群組有自己的工作階段)。
- **原生指令**使用隔離的工作階段：
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (前綴可透過 `channels.slack.slashCommand.sessionPrefix` 配置)
  - Telegram: `telegram:slash:<userId>` (透過 `CommandTargetSessionKey` 定位聊天工作階段)
- **`/stop`** 定位活躍的聊天工作階段，以便它可以中止目前的運行。
- **Slack**：`channels.slack.slashCommand` 仍然支援單個 `/openclaw` 樣式指令。如果您啟用 `commands.native`，則必須為每個內建指令創建一個 Slack 斜線指令 (與 `/help` 同名)。Slack 的指令參數選單以臨時的 Block Kit 按鈕形式交付。
