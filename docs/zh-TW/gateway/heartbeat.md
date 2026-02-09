---
summary: "Heartbeat 輪詢訊息與通知規則"
read_when:
  - 調整 Heartbeat 節奏或訊息方式
  - 在排程任務中決定使用 Heartbeat 或 Cron
title: "Heartbeat"
---

# Heartbeat（Gateway 閘道器）

> **Heartbeat vs Cron？** 請參考 [Cron vs Heartbeat](/automation/cron-vs-heartbeat)，了解各自的適用時機。

Heartbeat 會在主工作階段中執行 **週期性的代理程式回合**，讓模型能在不造成訊息轟炸的情況下，主動浮現需要注意的事項。

疑難排解：[/automation/troubleshooting](/automation/troubleshooting)

## 快速開始（初學者）

1. 保持 Heartbeat 啟用（預設為 `30m`，或在 Anthropic OAuth/setup-token 情況下為 `1h`），或設定你自己的節奏。
2. 6. 在代理的工作區建立一個精簡的 `HEARTBEAT.md` 檢查清單（選用但建議）。
3. 決定 Heartbeat 訊息要送到哪裡（預設為 `target: "last"`）。
4. 選用：啟用 Heartbeat 推理內容傳遞，以提高透明度。
5. 選用：限制 Heartbeat 僅在活躍時段執行（本地時間）。

設定範例：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## 7. 預設值

- 48. 間隔：`30m`（或當偵測到 Anthropic OAuth/setup-token 為驗證模式時為 `1h`）。 間隔：`30m`（若偵測到 Anthropic OAuth/setup-token 驗證模式，則為 `1h`）。設定 `agents.defaults.heartbeat.every` 或每個代理程式的 `agents.list[].heartbeat.every`；使用 `0m` 可停用。
- 提示詞主體（可透過 `agents.defaults.heartbeat.prompt` 設定）：
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- 9. 心跳提示會**逐字**作為使用者訊息送出。 10. 系統提示包含「Heartbeat」章節，且此次執行會在內部被標記。
- Active hours (`heartbeat.activeHours`) are checked in the configured timezone.
  12. 在視窗之外，心跳會被略過，直到下一次進入視窗內的 tick。

## Heartbeat 提示詞的用途

13. 預設提示刻意設計為寬泛：

- **背景任務**：「Consider outstanding tasks」會促使代理程式檢視後續事項（收件匣、行事曆、提醒、佇列中的工作），並浮現任何緊急項目。
- **人類狀態檢查**：「Checkup sometimes on your human during day time」會促使偶爾發送輕量的「需要幫忙嗎？」訊息，並透過你設定的本地時區避免夜間干擾（見 [/concepts/timezone](/concepts/timezone)）。

如果你希望 Heartbeat 執行非常具體的工作（例如「check Gmail PubSub stats」或「verify gateway health」），請將 `agents.defaults.heartbeat.prompt`（或 `agents.list[].heartbeat.prompt`）設為自訂內容（逐字送出）。

## 回應合約

- 若沒有需要注意的事項，請回覆 **`HEARTBEAT_OK`**。
- 在 Heartbeat 執行期間，OpenClaw 會在回覆 **開頭或結尾** 出現 `HEARTBEAT_OK` 時，將其視為 ack。該權杖會被移除，且若剩餘內容 **≤ `ackMaxChars`**（預設：300），則整則回覆會被丟棄。 14. 會移除權杖，且若剩餘內容 **≤ `ackMaxChars`**（預設：300），回覆將被丟棄。
- 若 `HEARTBEAT_OK` 出現在回覆 **中間**，則不會被特殊處理。
- 若為警示訊息，**請勿** 包含 `HEARTBEAT_OK`；僅回傳警示文字。

在非 Heartbeat 情境下，若訊息開頭或結尾出現零星的 `HEARTBEAT_OK`，會被移除並記錄；僅包含 `HEARTBEAT_OK` 的訊息會被丟棄。

## 設定

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Scope and precedence

- `agents.defaults.heartbeat` 設定全域 Heartbeat 行為。
- `agents.list[].heartbeat` 會疊加在其上；若任何代理程式具有 `heartbeat` 區塊，則 **只有那些代理程式** 會執行 Heartbeat。
- `channels.defaults.heartbeat` 設定所有頻道的可見度預設值。
- `channels.<channel>.heartbeat` 覆寫頻道預設值。
- `channels.<channel>.accounts.<id>.heartbeat`（多帳號頻道）覆寫每個頻道的設定。

### 每代理程式 Heartbeat

若任何 `agents.list[]` 項目包含 `heartbeat` 區塊，則 **只有那些代理程式**
會執行 Heartbeat。每代理程式的區塊會疊加在 `agents.defaults.heartbeat` 之上
（因此你可以先設定共用預設，再針對個別代理程式覆寫）。 16. 每個代理的區塊會疊加在 `agents.defaults.heartbeat` 之上（因此可一次設定共用預設，並為各代理覆寫）。

範例：兩個代理程式，只有第二個代理程式執行 Heartbeat。

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### 活躍時段範例

將 Heartbeat 限制在特定時區的上班時段：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

17. 在此視窗之外（東部時間上午 9 點前或晚上 10 點後），心跳會被略過。 18. 下一個排程在視窗內的 tick 會正常執行。

### 多帳號範例

在 Telegram 等多帳號頻道上，使用 `accountId` 指定特定帳號：

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### 19. 欄位說明

- `every`：Heartbeat 間隔（時間長度字串；預設單位 = 分鐘）。
- `model`：Heartbeat 執行時的選用模型覆寫（`provider/model`）。
- `includeReasoning`：啟用時，若可用，會同時傳遞獨立的 `Reasoning:` 訊息（格式與 `/reasoning on` 相同）。
- `session`：Heartbeat 執行的選用工作階段金鑰。
  - `main`（預設）：代理程式主工作階段。
  - 明確的工作階段金鑰（從 `openclaw sessions --json` 或 [sessions CLI](/cli/sessions) 複製）。
  - 20. 工作階段金鑰格式：請參閱 [Sessions](/concepts/session) 與 [Groups](/channels/groups)。
- `target`：
  - `last`（預設）：傳遞到最後使用的外部頻道。
  - 明確指定頻道：`whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`。
  - `none`：執行 Heartbeat，但 **不進行** 外部傳遞。
- `to`：選用的收件者覆寫（頻道專屬 ID，例如 WhatsApp 的 E.164 或 Telegram 聊天 ID）。
- 21. `accountId`：多帳號通道的選用帳號 ID。 `accountId`：多帳號頻道的選用帳號 ID。當 `target: "last"` 時，帳號 ID 會套用到解析後的最後一個頻道（若該頻道支援帳號）；否則會被忽略。若帳號 ID 與解析後頻道中已設定的帳號不符，則會略過傳遞。 If the account id does not match a configured account for the resolved channel, delivery is skipped.
- 23. `prompt`：覆寫預設提示內容（不合併）。
- `ackMaxChars`：在 `HEARTBEAT_OK` 之後允許傳遞的最大字元數。
- `activeHours`：將 Heartbeat 執行限制在時間視窗內。物件包含 `start`（HH:MM，含）、`end`（HH:MM，不含；允許使用 `24:00` 作為一天結束），以及選用的 `timezone`。 24. 物件包含 `start`（HH:MM，含）、`end`（HH:MM，不含；允許 `24:00` 作為一天結束），以及選用的 `timezone`。
  - 省略或 `"user"`：若有設定，使用你的 `agents.defaults.userTimezone`，否則回退至主機系統時區。
  - `"local"`：永遠使用主機系統時區。
  - 任何 IANA 識別碼（例如 `America/New_York`）：直接使用；若無效，則回退至上述 `"user"` 行為。
  - 在活躍視窗之外，Heartbeat 會被略過，直到下一次落在視窗內的 tick。

## 傳遞行為

- Heartbeat 預設在代理程式的主工作階段中執行（`agent:<id>:<mainKey>`），
  或在 `session.scope = "global"` 時使用 `global`。設定 `session` 可覆寫為
  特定頻道的工作階段（Discord/WhatsApp 等）。 25. 設定 `session` 以覆寫為特定通道的工作階段（Discord/WhatsApp 等）。
- `session` 只影響執行脈絡；實際傳遞由 `target` 與 `to` 控制。
- To deliver to a specific channel/recipient, set `target` + `to`. 若要傳遞到特定頻道／收件者，請設定 `target` + `to`。搭配
  `target: "last"` 時，會使用該工作階段最後的外部頻道進行傳遞。
- 若主佇列繁忙，Heartbeat 會被略過並稍後重試。
- 若 `target` 解析後沒有外部目的地，執行仍會發生，但不會送出對外訊息。
- 僅限 Heartbeat 的回覆 **不會** 保持工作階段存活；最後的 `updatedAt`
  會被還原，因此閒置到期行為維持正常。

## 可見度控制

By default, `HEARTBEAT_OK` acknowledgments are suppressed while alert content is
delivered. 28. 你可以依通道或依帳號調整此行為：

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

29. 優先順序：每帳號 → 每通道 → 通道預設 → 內建預設。

### 各旗標的作用

- `showOk`：當模型僅回傳 OK 回覆時，送出 `HEARTBEAT_OK` 確認訊息。
- `showAlerts`：當模型回傳非 OK 回覆時，送出警示內容。
- `useIndicator`：發出指示事件，用於 UI 狀態呈現。

若 **三者皆為 false**，OpenClaw 會完全略過 Heartbeat 執行（不呼叫模型）。

### 30. 每通道 vs 每帳號的範例

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### 常見模式

| 目標               | 設定                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------- |
| 預設行為（靜默 OK，警示開啟） | _(無需設定)_                                                              |
| 完全靜默（無訊息、無指示）    | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| 僅指示（無訊息）         | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| 僅在單一頻道顯示 OK      | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md（選用）

31. 若工作區存在 `HEARTBEAT.md` 檔案，預設提示會指示代理讀取它。 32. 把它視為你的「心跳檢查清單」：小巧、穩定，且可每 30 分鐘安全地包含。

若 `HEARTBEAT.md` 存在但實質上是空的（僅包含空白行與像 `# Heading` 這樣的 Markdown 標題），OpenClaw 會略過 Heartbeat 執行以節省 API 呼叫。
若檔案不存在，Heartbeat 仍會執行，由模型自行決定要做什麼。
若檔案不存在，心跳仍會執行，並由模型決定要做什麼。

33. 保持精簡（短清單或提醒）以避免提示膨脹。

`HEARTBEAT.md` 範例：

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### 代理程式可以更新 HEARTBEAT.md 嗎？

可以 — 只要你要求它。

`HEARTBEAT.md` 只是代理程式工作區中的一般檔案，因此你可以在一般對話中告訴代理程式，例如：

- 「更新 `HEARTBEAT.md`，加入每日行事曆檢查。」
- 「重寫 `HEARTBEAT.md`，讓它更精簡並專注於收件匣後續。」

如果你希望它主動進行，也可以在 Heartbeat 提示詞中加入明確的一行，例如：「如果檢查清單變得過時，請更新 HEARTBEAT.md，提供更好的版本。」

安全性注意事項：請勿將祕密（API 金鑰、電話號碼、私人權杖）放入
`HEARTBEAT.md` — 它會成為提示詞脈絡的一部分。

## 手動喚醒（即時）

你可以佇列一個系統事件，並立即觸發 Heartbeat：

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

若多個代理程式設定了 `heartbeat`，手動喚醒會立即執行每一個代理程式的 Heartbeat。

使用 `--mode next-heartbeat` 可等待下一個排程 tick。

## 推理內容傳遞（選用）

34. 預設情況下，心跳僅投遞最終的「答案」負載。

若你希望提高透明度，請啟用：

- `agents.defaults.heartbeat.includeReasoning: true`

35. 啟用後，心跳也會投遞一則以 `Reasoning:` 為前綴的獨立訊息（外觀與 `/reasoning on` 相同）。 36. 當代理管理多個工作階段/法典且你想知道它為何決定 ping 你時，這會很有用——但也可能洩漏比你期望更多的內部細節。 7. 在群組聊天中，建議保持關閉。

## 成本考量

38. 心跳會執行完整的代理回合。 39. 較短的間隔會消耗更多權杖。 40. 保持 `HEARTBEAT.md` 精簡，並在只需要內部狀態更新時，考慮使用較便宜的 `model` 或 `target: "none"`。
