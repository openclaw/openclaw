---
summary: "斜線指令：文字對比原生、設定以及支援的指令"
read_when:
  - 使用或設定聊天指令時
  - 偵錯指令路由或權限時
title: "斜線指令"
---

# 斜線指令

指令由 Gateway 處理。大多數指令必須作為以 `/` 開頭的**獨立**訊息發送。
僅限主機使用的 bash 聊天指令使用 `! <cmd>`（並以 `/bash <cmd>` 作為別名）。

系統包含兩個相關部分：

- **指令 (Commands)**：獨立的 `/...` 訊息。
- **指令語 (Directives)**：`/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`。
  - 指令語會在模型看到訊息之前被移除。
  - 在一般聊天訊息中（非僅含指令語），它們被視為「內嵌提示」，且**不會**持久化工作階段設定。
  - 在僅含指令語的訊息中（訊息僅包含指令語），它們會持久化到工作階段中，並回覆確認資訊。
  - 指令語僅適用於**授權發送者**。如果設定了 `commands.allowFrom`，它將是唯一使用的允許清單；否則授權將來自頻道允許清單/配對以及 `commands.useAccessGroups`。未經授權的發送者看到的指令語會被視為純文字。

還有一些**內嵌捷徑**（僅限允許清單/授權發送者）：`/help`, `/commands`, `/status`, `/whoami` (`/id`)。
它們會立即執行，在模型看到訊息之前被移除，剩餘的文字則繼續進入正常流程。

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

- `commands.text`（預設為 `true`）啟用在聊天訊息中解析 `/...`。
  - 在沒有原生指令的介面（WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams）上，即使將此項設為 `false`，文字指令仍然有效。
- `commands.native`（預設為 `"auto"`）註冊原生指令。
  - Auto：在 Discord/Telegram 上開啟；在 Slack 上關閉（直到您新增斜線指令為止）；對於不支援原生指令的供應商則忽略。
  - 設定 `channels.discord.commands.native`、`channels.telegram.commands.native` 或 `channels.slack.commands.native` 來覆蓋每個供應商的設定（布林值或 `"auto"`）。
  - `false` 會在啟動時清除先前在 Discord/Telegram 上註冊的指令。Slack 指令在 Slack 應用程式中管理，不會自動移除。
- `commands.nativeSkills`（預設為 `"auto"`）在支援時註冊 **Skills** 原生指令。
  - Auto：在 Discord/Telegram 上開啟；在 Slack 上關閉（Slack 需要為每個 Skill 建立一個斜線指令）。
  - 設定 `channels.discord.commands.nativeSkills`、`channels.telegram.commands.nativeSkills` 或 `channels.slack.commands.nativeSkills` 來覆蓋每個供應商的設定（布林值或 `"auto"`）。
- `commands.bash`（預設為 `false`）啟用 `! <cmd>` 以執行主機 shell 指令（`/bash <cmd>` 是別名；需要 `tools.elevated` 允許清單）。
- `commands.bashForegroundMs`（預設為 `2000`）控制 bash 在切換到背景模式前等待的時間（`0` 表示立即進入背景）。
- `commands.config`（預設為 `false`）啟用 `/config`（讀取/寫入 `openclaw.json`）。
- `commands.debug`（預設為 `false`）啟用 `/debug`（僅限執行階段覆蓋）。
- `commands.allowFrom`（選填）為指令授權設定各供應商的允許清單。設定後，它是指令和指令語的唯一授權來源（頻道允許清單/配對和 `commands.useAccessGroups` 將被忽略）。使用 `"*"` 作為全域預設值；供應商特定鍵名會覆蓋它。
- `commands.useAccessGroups`（預設為 `true`）當未設定 `commands.allowFrom` 時，對指令強制執行允許清單/策略。

## 指令列表

文字 + 原生（啟用時）：

- `/help`
- `/commands`
- `/skill <name> [input]`（依名稱執行一個 Skill）
- `/status`（顯示目前狀態；包含目前模型供應商可用的用量/配額）
- `/allowlist`（列出/新增/移除允許清單項目）
- `/approve <id> allow-once|allow-always|deny`（處理執行審核提示）
- `/context [list|detail|json]`（說明「內容」；`detail` 顯示各檔案 + 各工具 + 各 Skill + 系統提示詞的大小）
- `/whoami`（顯示您的發送者 ID；別名：`/id`）
- `/subagents list|stop|log|info|send`（檢查、停止、記錄或傳送訊息給目前工作階段的子智慧代理執行任務）
- `/config show|get|set|unset`（將設定持久化到磁碟，僅限擁有者；需要 `commands.config: true`）
- `/debug show|set|unset|reset`（執行階段覆蓋，僅限擁有者；需要 `commands.debug: true`）
- `/usage off|tokens|full|cost`（每則回覆的用量頁尾或在地成本摘要）
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio`（控制 TTS；請參閱 [/tts](/tts)）
  - Discord：原生指令為 `/voice`（Discord 保留了 `/tts`）；文字指令 `/tts` 仍可運作。
- `/stop`
- `/restart`
- `/dock-telegram`（別名：`/dock_telegram`）（將回覆切換到 Telegram）
- `/dock-discord`（別名：`/dock_discord`）（將回覆切換到 Discord）
- `/dock-slack`（別名：`/dock_slack`）（將回覆切換到 Slack）
- `/activation mention|always`（僅限群組）
- `/send on|off|inherit`（僅限擁有者）
- `/reset` 或 `/new [model]`（選填的模型提示；其餘部分將被透傳）
- `/think <off|minimal|low|medium|high|xhigh>`（由模型/供應商提供的動態選項；別名：`/thinking`, `/t`）
- `/verbose on|full|off`（別名：`/v`）
- `/reasoning on|off|stream`（別名：`/reason`；開啟時，會發送一則帶有 `Reasoning:` 前綴的獨立訊息；`stream` 僅適用於 Telegram 草稿）
- `/elevated on|off|ask|full`（別名：`/elev`；`full` 會跳過執行審核）
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`（發送 `/exec` 以顯示目前設定）
- `/model <name>`（別名：`/models`；或來自 `agents.defaults.models.*.alias` 的 `/<alias>`）
- `/queue <mode>`（加上選項如 `debounce:2s cap:25 drop:summarize`；發送 `/queue` 以查看目前設定）
- `/bash <command>`（僅限主機；`! <command>` 的別名；需要 `commands.bash: true` + `tools.elevated` 允許清單）

僅限文字：

- `/compact [instructions]`（請參閱 [/concepts/compaction](/concepts/compaction)）
- `! <command>`（僅限主機；一次一個；使用 `!poll` + `!stop` 處理長時間執行的任務）
- `!poll`（檢查輸出 / 狀態；接受選填的 `sessionId`；`/bash poll` 同樣有效）
- `!stop`（停止正在執行的 bash 任務；接受選填的 `sessionId`；`/bash stop` 同樣有效）

注意事項：

- 指令接受在指令和參數之間使用選填的 `:`（例如：`/think: high`, `/send: on`, `/help:`）。
- `/new <model>` 接受模型別名、`provider/model` 或供應商名稱（模糊比對）；如果沒有匹配項，文字將被視為訊息本文。
- 若要查看完整的供應商用量細目，請使用 `openclaw status --usage`。
- `/allowlist add|remove` 需要 `commands.config=true` 並遵循頻道的 `configWrites` 設定。
- `/usage` 控制每則回覆的用量頁尾；`/usage cost` 從 OpenClaw 工作階段記錄中列印在地成本摘要。
- `/restart` 預設為停用；將 `commands.restart: true` 設為啟用。
- `/verbose` 用於偵錯和額外的可見度；在正常使用時請保持 **off**。
- `/reasoning`（以及 `/verbose`）在群組環境中具有風險：它們可能會揭露您不打算公開的內部推理或工具輸出。建議保持關閉，特別是在群組聊天中。
- **快速路徑 (Fast path)**：來自允許清單發送者的僅指令訊息會立即處理（跳過佇列 + 模型）。
- **群組提及限制**：來自允許清單發送者的僅指令訊息會跳過提及要求。
- **內嵌捷徑（僅限允許清單發送者）**：某些指令在嵌入一般訊息時也有效，並在模型看到剩餘文字之前被移除。
  - 範例：`hey /status` 會觸發狀態回覆，剩餘的文字則繼續進入正常流程。
- 目前支援：`/help`, `/commands`, `/status`, `/whoami` (`/id`)。
- 未經授權的僅指令訊息會被靜默忽略，內嵌的 `/...` 標記則被視為純文字。
- **Skill 指令**：`user-invocable` 的 Skills 會以斜線指令的形式呈現。名稱會清理為 `a-z0-9_`（最長 32 字元）；衝突時會加上數字後綴（例如：`_2`）。
  - `/skill <name> [input]` 依名稱執行一個 Skill（當原生指令限制阻止了單獨的 Skill 指令時非常有用）。
  - 預設情況下，Skill 指令會作為正常請求轉發給模型。
  - Skills 可以選擇宣告 `command-dispatch: tool` 以將指令直接路由到工具（確定性的，不經過模型）。
  - 範例：`/prose` (OpenProse 插件) —— 請參閱 [OpenProse](/prose)。
- **原生指令參數**：Discord 使用自動完成來提供動態選項（並在您省略必要參數時顯示按鈕選單）。Telegram 和 Slack 在指令支援選項且您省略參數時顯示按鈕選單。

## 使用介面（何處顯示何內容）

- **供應商用量/配額**（範例：「Claude 剩餘 80%」）在啟用用量追蹤時，會顯示在目前模型供應商的 `/status` 中。
- **每則回覆的標記/成本** 由 `/usage off|tokens|full` 控制（附加在正常回覆後）。
- `/model status` 關於**模型/驗證/端點**，而非用量。

## 模型選取 (`/model`)

`/model` 是作為指令語實現的。

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

- `/model` 和 `/model list` 顯示一個精簡的編號選擇器（模型系列 + 可用供應商）。
- `/model <#>` 從該選擇器中選取（並在可能時優先使用目前供應商）。
- `/model status` 顯示詳細檢視，包括已設定的供應商端點 (`baseUrl`) 和可用的 API 模式 (`api`)。

## 偵錯覆蓋

`/debug` 讓您設定**僅限執行階段**的設定覆蓋（存在記憶體中，而非磁碟）。僅限擁有者。預設停用；透過 `commands.debug: true` 啟用。

範例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

注意事項：

- 覆蓋會立即套用於新的設定讀取，但**不會**寫入 `openclaw.json`。
- 使用 `/debug reset` 清除所有覆蓋並返回磁碟上的設定。

## 設定更新

`/config` 寫入您的磁碟設定 (`openclaw.json`)。僅限擁有者。預設停用；透過 `commands.config: true` 啟用。

範例：

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

注意事項：

- 設定在寫入前會經過驗證；無效的更改會被拒絕。
- `/config` 的更新在重新啟動後依然有效。

## 介面說明

- **文字指令**在正常聊天工作階段中執行（私訊共用 `main`，群組有自己的工作階段）。
- **原生指令**使用隔離的工作階段：
  - Discord：`agent:<agentId>:discord:slash:<userId>`
  - Slack：`agent:<agentId>:slack:slash:<userId>`（前綴可透過 `channels.slack.slashCommand.sessionPrefix` 設定）
  - Telegram：`telegram:slash:<userId>`（透過 `CommandTargetSessionKey` 目標指向聊天工作階段）
- **`/stop`** 以活動的聊天工作階段為目標，以便它可以中止目前的執行。
- **Slack**：`channels.slack.slashCommand` 仍支援單個 `/openclaw` 風格的指令。如果您啟用 `commands.native`，您必須為每個內建指令建立一個 Slack 斜線指令（名稱與 `/help` 相同）。Slack 的指令參數選單以暫時性的 Block Kit 按鈕形式傳送。
