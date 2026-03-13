---
summary: "Slash commands: text vs native, config, and supported commands"
read_when:
  - Using or configuring chat commands
  - Debugging command routing or permissions
title: Slash Commands
---

# 斜線指令

指令由 Gateway 處理。大多數指令必須以 `/` 開頭，並作為**獨立**訊息發送。
僅限主機使用的 bash 聊天指令使用 `! <cmd>`（`/bash <cmd>` 為別名）。

有兩個相關系統：

- **指令**：獨立的 `/...` 訊息。
- **指示**：`/think`、`/fast`、`/verbose`、`/reasoning`、`/elevated`、`/exec`、`/model`、`/queue`。
  - 指示會在模型看到訊息前被剝除。
  - 在一般聊天訊息（非僅指示）中，指示被視為「內嵌提示」，**不會**持續保存會話設定。
  - 在僅含指示的訊息中（訊息只包含指示），指示會持續保存至會話並回覆確認訊息。
  - 指示僅對**授權發送者**生效。如果設定了 `commands.allowFrom`，則僅使用該白名單；否則授權來自頻道白名單/配對加上 `commands.useAccessGroups`。
  - 未授權發送者看到的指示會被當作純文字處理。

還有一些**內嵌捷徑**（僅限白名單/授權發送者）：`/help`、`/commands`、`/status`、`/whoami`（`/id`）。
它們會立即執行，並在模型看到訊息前被剝除，剩餘文字則繼續正常流程。

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

- `commands.text`（預設 `true`）啟用在聊天訊息中解析 `/...`。
  - 在無原生指令介面（WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams）上，即使設定為 `false`，文字指令仍可使用。
- `commands.native`（預設 `"auto"`）註冊原生指令。
  - 自動：Discord/Telegram 預設開啟；Slack 預設關閉（直到你新增斜線指令）；不支援原生的服務提供者則忽略。
  - 可設定 `channels.discord.commands.native`、`channels.telegram.commands.native` 或 `channels.slack.commands.native` 針對特定服務提供者覆寫（布林值或 `"auto"`）。
  - `false` 會在啟動時清除 Discord/Telegram 先前註冊的指令。Slack 指令由 Slack 應用管理，不會自動移除。
- `commands.nativeSkills`（預設 `"auto"`）在支援時原生註冊**技能**指令。
  - 自動：Discord/Telegram 預設開啟；Slack 預設關閉（Slack 需為每個技能建立斜線指令）。
  - 可設定 `channels.discord.commands.nativeSkills`、`channels.telegram.commands.nativeSkills` 或 `channels.slack.commands.nativeSkills` 針對特定服務提供者覆寫（布林值或 `"auto"`）。
- `commands.bash`（預設 `false`）允許 `! <cmd>` 執行主機 shell 指令（`/bash <cmd>` 為別名；需 `tools.elevated` 白名單）。
- `commands.bashForegroundMs`（預設 `2000`）控制 bash 等待多久後切換至背景模式（`0` 會立即背景執行）。
- `commands.config`（預設 `false`）啟用 `/config`（讀寫 `openclaw.json`）。
- `commands.debug`（預設 `false`）啟用 `/debug`（僅限執行時覆寫）。
- `commands.allowFrom`（可選）設定每個服務提供者的指令授權白名單。設定後，這是指令與指示唯一授權來源（頻道白名單/配對及 `commands.useAccessGroups` 將被忽略）。使用 `"*"` 作為全域預設；服務提供者特定設定會覆寫它。
- `commands.useAccessGroups`（預設 `true`）在未設定 `commands.allowFrom` 時強制執行指令白名單/政策。

## 指令列表

文字 + 原生（啟用時）：

- `/help`
- `/commands`
- `/skill <name> [input]`（依名稱執行技能）
- `/status`（顯示目前狀態；包含目前模型提供者的使用量/配額，若可用）
- `/allowlist`（列出/新增/移除白名單條目）
- `/approve <id> allow-once|allow-always|deny`（解決執行批准提示）
- `/context [list|detail|json]`（解釋「上下文」；`detail` 顯示每檔案 + 每工具 + 每技能 + 系統提示大小）
- `/export-session [path]`（別名：`/export`）（匯出目前會話為含完整系統提示的 HTML）
- `/whoami`（顯示你的發送者 ID；別名：`/id`）
- `/session idle <duration|off>`（管理聚焦執行緒綁定的非活動自動失焦）
- `/session max-age <duration|off>`（管理聚焦執行緒綁定的硬性最大存活時間自動失焦）
- `/subagents list|kill|log|info|send|steer|spawn`（檢查、控制或啟動目前會話的子代理執行）
- `/acp spawn|cancel|steer|close|status|set-mode|set|cwd|permissions|timeout|model|reset-options|doctor|install|sessions`（檢查並控制 ACP 執行時會話）
- `/agents`（列出此會話的執行緒綁定代理）
- `/focus <target>`（Discord：綁定此執行緒或新執行緒至會話/子代理目標）
- `/unfocus`（Discord：移除目前執行緒綁定）
- `/kill <id|#|all>`（立即中止此會話一個或全部正在執行的子代理；無確認訊息）
- `/steer <id|#> <message>`（立即引導正在執行的子代理：若可能則在執行中引導，否則中止目前工作並在引導訊息上重新啟動）
- `/tell <id|#> <message>`（`/steer` 的別名）
- `/config show|get|set|unset`（將設定持久化至磁碟，僅限擁有者；需 `commands.config: true`）
- `/debug show|set|unset|reset`（執行時覆寫，僅限擁有者；需 `commands.debug: true`）
- `/usage off|tokens|full|cost`（每回應使用量頁尾或本地成本摘要）
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio`（控制 TTS；參見 [/tts](/tts)）
  - Discord：原生指令為 `/voice`（Discord 保留 `/tts`）；文字指令 `/tts` 仍可使用。
- `/stop`
- `/restart`
- `/dock-telegram`（別名：`/dock_telegram`）（切換回覆至 Telegram）
- `/dock-discord`（別名：`/dock_discord`）（切換回覆至 Discord）
- `/dock-slack`（別名：`/dock_slack`）（切換回覆至 Slack）
- `/activation mention|always`（僅限群組）
- `/send on|off|inherit`（僅限擁有者）
- `/reset` 或 `/new [model]`（可選模型提示；剩餘文字照常傳遞）
- `/think <off|minimal|low|medium|high|xhigh>`（依模型/服務提供者動態選項；別名：`/thinking`、`/t`）
- `/fast status|on|off`（省略參數顯示目前有效的快速模式狀態）
- `/verbose on|full|off`（別名：`/v`）
- `/reasoning on|off|stream`（別名：`/reason`；開啟時會發送一則以 `Reasoning:` 為前綴的獨立訊息；`stream` 僅 Telegram 草稿）
- `/elevated on|off|ask|full`（別名：`/elev`；`full` 跳過執行批准）
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`（發送 `/exec` 以顯示目前狀態）
- `/model <name>`（別名：`/models`；或來自 `agents.defaults.models.*.alias` 的 `/<alias>`）
- `/queue <mode>`（含類似 `debounce:2s cap:25 drop:summarize` 的選項；發送 `/queue` 查看目前設定）
- `/bash <command>`（僅限主機；`! <command>` 的別名；需 `commands.bash: true` + `tools.elevated` 白名單）

僅文字：

- `/compact [instructions]`（參見 [/concepts/compaction](/concepts/compaction)）
- `! <command>`（僅限主機；一次一個；長時間工作請使用 `!poll` + `!stop`）
- `!poll`（檢查輸出/狀態；可選 `sessionId`；`/bash poll` 也可用）
- `!stop`（停止正在執行的 bash 工作；可選 `sessionId`；`/bash stop` 也可用）

注意事項：

- 指令可接受命令與參數間的可選 `:`（例如 `/think: high`、`/send: on`、`/help:`）。
- `/new <model>` 可接受模型別名、`provider/model` 或服務提供者名稱（模糊匹配）；若無匹配，文字視為訊息主體。
- 若需完整服務提供者使用量細節，請使用 `openclaw status --usage`。
- `/allowlist add|remove` 需 `commands.config=true` 且遵守頻道 `configWrites`。
- 多帳號頻道中，針對設定目標的 `/allowlist --account <id>` 和 `/config set channels.<provider>.accounts.<id>...` 也會遵守目標帳號的 `configWrites`。
- `/usage` 控制每回應使用量頁尾；`/usage cost` 從 OpenClaw 會話日誌列印本地成本摘要。
- `/restart` 預設啟用；設定 `commands.restart: false` 可停用。
- 僅限 Discord 原生指令：`/vc join|leave|status` 控制語音頻道（需 `channels.discord.voice` 和原生指令；文字指令不可用）。
- Discord 執行緒綁定指令（`/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age`）需啟用有效執行緒綁定（`session.threadBindings.enabled` 和/或 `channels.discord.threadBindings.enabled`）。
- ACP 指令參考與執行時行為： [ACP Agents](/tools/acp-agents)。
- `/verbose` 用於除錯與額外可見性；正常使用請保持**關閉**。
- `/fast on|off` 持續保存會話覆寫。使用會話 UI 的 `inherit` 選項可清除並回復預設設定。
- 工具失敗摘要仍會顯示，但詳細失敗文字僅在 `/verbose` 為 `on` 或 `full` 時包含。
- `/reasoning`（及 `/verbose`）在群組環境中風險較高：可能洩漏內部推理或工具輸出，建議關閉，尤其在群組聊天中。
- **快速路徑：** 來自白名單發送者的純指令訊息會立即處理（跳過佇列與模型）。
- **群組提及門檻：** 來自白名單發送者的純指令訊息可繞過提及要求。
- **內嵌捷徑（僅限白名單發送者）：** 某些指令可嵌入一般訊息中，並在模型看到剩餘文字前被剝除。
  - 例如：`hey /status` 會觸發狀態回覆，剩餘文字繼續正常流程。
- 目前支援：`/help`、`/commands`、`/status`、`/whoami`（`/id`）。
- 未授權的純指令訊息會被靜默忽略，內嵌 `/...` 代幣會被當作純文字。
- **技能指令：** `user-invocable` 技能會以斜線指令形式暴露。名稱會被淨化為 `a-z0-9_`（最多 32 字元）；若有衝突會加數字後綴（例如 `_2`）。
  - `/skill <name> [input]` 可依名稱執行技能（當原生指令限制無法為每技能建立指令時很有用）。
  - 預設技能指令會轉發給模型作為一般請求。
  - 技能可選擇宣告 `command-dispatch: tool`，將指令直接路由至工具（確定性，無需模型）。
  - 例如：`/prose`（OpenProse 外掛）— 參見 [OpenProse](/prose)。
- **原生指令參數：** Discord 使用自動完成提供動態選項（省略必填參數時顯示按鈕選單）。Telegram 和 Slack 在指令支援選項且省略參數時會顯示按鈕選單。

## 使用介面（顯示位置）

- **提供者使用量/配額**（例如：「Claude 剩餘 80%」）會在啟用使用量追蹤時，顯示於當前模型提供者的 `/status`。
- **每次回應的 token/費用** 由 `/usage off|tokens|full` 控制（附加於一般回覆後）。
- `/model status` 是關於 **模型/認證/端點**，與使用量無關。

## 模型選擇 (`/model`)

`/model` 是以指令方式實作。

範例：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

說明：

- `/model` 和 `/model list` 顯示簡潔的編號選擇器（模型家族 + 可用提供者）。
- 在 Discord 上，`/model` 和 `/models` 會開啟互動式選擇器，包含提供者與模型下拉選單及提交步驟。
- `/model <#>` 從該選擇器中選擇（並盡可能偏好當前提供者）。
- `/model status` 顯示詳細視圖，包括已設定的提供者端點 (`baseUrl`) 及 API 模式 (`api`)（若有）。

## 除錯覆寫

`/debug` 允許設定 **僅執行時** 的設定覆寫（記憶體中，不寫入磁碟）。僅限擁有者使用。預設關閉；可用 `commands.debug: true` 啟用。

範例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

說明：

- 覆寫會立即套用於新的設定讀取，但**不會**寫入 `openclaw.json`。
- 使用 `/debug reset` 可清除所有覆寫並回復至磁碟上的設定。

## 設定更新

`/config` 會寫入您的磁碟上設定檔 (`openclaw.json`)。僅限擁有者使用。預設為停用；可透過 `commands.config: true` 啟用。

範例：

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

注意事項：

- 設定在寫入前會進行驗證；無效的變更將被拒絕。
- `/config` 的更新會在重啟後持續生效。

## 表面說明

- **文字指令** 在一般聊天會話中執行（私訊共用 `main`，群組則有自己的會話）。
- **原生指令** 使用獨立會話：
  - Discord：`agent:<agentId>:discord:slash:<userId>`
  - Slack：`agent:<agentId>:slack:slash:<userId>`（前綴可透過 `channels.slack.slashCommand.sessionPrefix` 設定）
  - Telegram：`telegram:slash:<userId>`（透過 `CommandTargetSessionKey` 指向聊天會話）
- **`/stop`** 針對目前的聊天會話，可用來中止當前執行。
- **Slack：** `channels.slack.slashCommand` 仍支援單一 `/openclaw` 風格的指令。若啟用 `commands.native`，必須為每個內建指令建立一個 Slack 斜線指令（名稱與 `/help` 相同）。Slack 的指令參數選單以短暫顯示的 Block Kit 按鈕形式呈現。
  - Slack 原生例外：註冊 `/agentstatus`（非 `/status`），因為 Slack 保留了 `/status`。文字 `/status` 仍可在 Slack 訊息中使用。
