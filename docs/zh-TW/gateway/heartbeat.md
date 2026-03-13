---
summary: Heartbeat polling messages and notification rules
read_when:
  - Adjusting heartbeat cadence or messaging
  - Deciding between heartbeat and cron for scheduled tasks
title: Heartbeat
---

# Heartbeat (Gateway)

> **Heartbeat 與 Cron？** 請參考 [Cron vs Heartbeat](/automation/cron-vs-heartbeat) 以獲取何時使用各自的指導。

Heartbeat 在主要會話中執行 **定期代理轉換**，以便模型可以提出任何需要注意的事項，而不會對你造成干擾。

[[BLOCK_1]]  
故障排除: [/automation/troubleshooting](/automation/troubleshooting)  
[[BLOCK_2]]

## 快速入門（初學者）

1. 保持心跳啟用（預設為 `30m`，或 `1h` 用於 Anthropic OAuth/setup-token），或設定您自己的節奏。
2. 在代理工作區創建一個小型 `HEARTBEAT.md` 清單（可選但建議）。
3. 決定心跳消息應該發送到哪裡（`target: "none"` 是預設；設定 `target: "last"` 以路由到最後的聯絡人）。
4. 可選：啟用心跳推理交付以提高透明度。
5. 可選：如果心跳執行僅需要 `HEARTBEAT.md`，則使用輕量級啟動上下文。
6. 可選：將心跳限制在活躍時間內（當地時間）。

範例設定：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // explicit delivery to last contact (default is "none")
        directPolicy: "allow", // default: allow direct/DM targets; set "block" to suppress
        lightContext: true, // optional: only inject HEARTBEAT.md from bootstrap files
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Defaults

- 間隔: `30m`（或當檢測到 Anthropic OAuth/setup-token 為認證模式時使用 `1h`）。設置 `agents.defaults.heartbeat.every` 或每個代理的 `agents.list[].heartbeat.every`；使用 `0m` 來禁用。
- 提示內容（可透過 `agents.defaults.heartbeat.prompt` 設定）:
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- 心跳提示將**逐字**發送為用戶消息。系統提示包含一個“心跳”部分，並且執行會在內部標記。
- 活躍時間 (`heartbeat.activeHours`) 會在設定的時區內檢查。超出時間範圍，心跳將被跳過，直到下一次在時間範圍內的計時。

## heartbeat 提示的用途是什麼

預設提示故意設計得很廣泛：

- **背景任務**： “考慮未完成的任務” 促使代理檢查後續事項（收件箱、日曆、提醒事項、排隊工作）並提出任何緊急事項。
- **人類檢查**： “白天偶爾檢查一下你的使用者” 促使發送一條輕量的 “有什麼需要的嗎？” 訊息，但透過使用你設定的當地時區來避免夜間的垃圾訊息（參見 [/concepts/timezone](/concepts/timezone)）。

如果你想要一個心跳執行某個特定的任務（例如「檢查 Gmail PubSub 狀態」或「驗證網關健康」），請將 `agents.defaults.heartbeat.prompt`（或 `agents.list[].heartbeat.prompt`）設置為自定義主體（逐字發送）。

## Response contract

**`HEARTBEAT_OK`**

- 在心跳執行期間，OpenClaw 將 `HEARTBEAT_OK` 當作確認（ack），當它出現在回覆的 **開始或結尾** 時。若剩餘內容 **≤ `ackMaxChars`**（預設：300），則會移除 token 並丟棄回覆。
- 如果 `HEARTBEAT_OK` 出現在回覆的 **中間**，則不會特別處理。
- 對於警報，**不**要包含 `HEARTBEAT_OK`；僅返回警報文本。

在心跳之外，訊息開始/結束時的多餘 `HEARTBEAT_OK` 會被剝除並記錄；如果訊息僅包含 `HEARTBEAT_OK`，則會被丟棄。

## Config

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        lightContext: false, // default: false; true keeps only HEARTBEAT.md from workspace bootstrap files
        target: "last", // default: none | options: last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### 範圍與優先權

- `agents.defaults.heartbeat` 設定全域心跳行為。
- `agents.list[].heartbeat` 在上方合併；如果任何代理有 `heartbeat` 區塊，**只有那些代理** 會執行心跳。
- `channels.defaults.heartbeat` 設定所有頻道的可見性預設值。
- `channels.<channel>.heartbeat` 會覆蓋頻道的預設值。
- `channels.<channel>.accounts.<id>.heartbeat` （多帳戶頻道）會覆蓋每個頻道的設定。

### 每個代理的心跳信號

如果任何 `agents.list[]` 條目包含 `heartbeat` 區塊，**只有那些代理** 會執行心跳。每個代理的區塊會在 `agents.defaults.heartbeat` 之上合併（這樣你可以一次設置共享的預設值並針對每個代理進行覆蓋）。

範例：兩個代理，只有第二個代理執行心跳。

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // explicit delivery to last contact (default is "none")
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

### Active hours example

限制心跳在特定時區的營業時間內：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // explicit delivery to last contact (default is "none")
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

在這個窗口外（東部時間早上 9 點之前或晚上 10 點之後），心跳會被跳過。下一個在窗口內的預定滴答將正常執行。

### 24/7 設定

如果您希望心跳持續執行整天，請使用以下其中一種模式：

- 完全省略 `activeHours`（無時間窗口限制；這是預設行為）。
- 設定全天窗口：`activeHours: { start: "00:00", end: "24:00" }`。

請勿將相同的 `start` 和 `end` 時間設置為相同（例如 `08:00` 到 `08:00`）。這會被視為零寬度窗口，因此心跳將始終被跳過。

### 多帳號範例

使用 `accountId` 來針對像 Telegram 這樣的多帳戶頻道中的特定帳戶：

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678:topic:42", // optional: route to a specific topic/thread
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

### Field notes

- `every`: 心跳間隔（持續時間字串；預設單位 = 分鐘）。
- `model`: 心跳執行的可選模型覆蓋 (`provider/model`)。
- `includeReasoning`: 當啟用時，當可用時也傳送單獨的 `Reasoning:` 訊息（形狀與 `/reasoning on` 相同）。
- `lightContext`: 當為真時，心跳執行使用輕量級的啟動上下文，並僅保留工作區啟動檔案中的 `HEARTBEAT.md`。
- `session`: 心跳執行的可選會話金鑰。
  - `main`（預設）：代理主會話。
  - 明確的會話金鑰（從 `openclaw sessions --json` 或 [sessions CLI](/cli/sessions) 複製）。
  - 會話金鑰格式：請參見 [Sessions](/concepts/session) 和 [Groups](/channels/groups)。
- `target`:
  - `last`: 傳送到最後使用的外部頻道。
  - 明確頻道：`whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`。
  - `none`（預設）：執行心跳但**不外部傳送**。
- `directPolicy`: 控制直接/DM 傳送行為：
  - `allow`（預設）：允許直接/DM 心跳傳送。
  - `block`: 抑制直接/DM 傳送 (`reason=dm-blocked`)。
- `to`: 可選的接收者覆蓋（頻道特定 ID，例如 WhatsApp 的 E.164 或 Telegram 聊天 ID）。對於 Telegram 主題/線程，使用 `<chatId>:topic:<messageThreadId>`。
- `accountId`: 多帳戶頻道的可選帳戶 ID。當 `target: "last"` 時，帳戶 ID 適用於解析的最後頻道（如果它支援帳戶）；否則將被忽略。如果帳戶 ID 與解析頻道的設定帳戶不匹配，則跳過傳送。
- `prompt`: 覆蓋預設提示主體（不合併）。
- `ackMaxChars`: 傳送前在 `HEARTBEAT_OK` 之後允許的最大字元數。
- `suppressToolErrorWarnings`: 當為真時，在心跳執行期間抑制工具錯誤警告有效負載。
- `activeHours`: 限制心跳執行的時間窗口。物件包含 `start`（HH:MM，包含；使用 `00:00` 作為一天的開始），`end`（HH:MM 不包含；`24:00` 允許作為一天的結束），以及可選的 `timezone`。
  - 遺漏或 `"user"`: 如果設置了，使用您的 `agents.defaults.userTimezone`，否則回退到主機系統時區。
  - `"local"`: 始終使用主機系統時區。
  - 任何 IANA 標識符（例如 `America/New_York`）：直接使用；如果無效，回退到上述 `"user"` 行為。
  - `start` 和 `end` 在活動窗口中不得相等；相等的值被視為零寬度（始終在窗口外）。
  - 在活動窗口外，心跳將被跳過，直到下一個在窗口內的時刻。

## Delivery behavior

- Heartbeats 預設在代理的主要會話中執行 (`agent:<id>:<mainKey>`)，或在 `global` 時執行 `session.scope = "global"`。設定 `session` 以覆蓋為特定的頻道會話（Discord/WhatsApp 等）。
- `session` 只影響執行上下文；傳遞由 `target` 和 `to` 控制。
- 要傳遞到特定的頻道/接收者，設定 `target` + `to`。使用 `target: "last"` 時，傳遞會使用該會話的最後一個外部頻道。
- Heartbeat 傳遞預設允許直接/私訊目標。設定 `directPolicy: "block"` 以抑制直接目標的發送，同時仍然執行 heartbeat 回合。
- 如果主要佇列忙碌，heartbeat 將被跳過並稍後重試。
- 如果 `target` 解決為沒有外部目的地，執行仍然會發生，但不會發送外發消息。
- 只有 heartbeat 的回覆 **不** 會保持會話存活；最後的 `updatedAt` 將被恢復，因此閒置過期行為正常。

## 可見性控制

預設情況下，`HEARTBEAT_OK` 確認在警報內容傳送時會被抑制。您可以根據每個通道或每個帳戶進行調整：

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

優先順序：每個帳戶 → 每個頻道 → 頻道預設值 → 內建預設值。

### 每個標誌的功能

- `showOk`: 當模型返回僅有 OK 的回覆時，發送 `HEARTBEAT_OK` 確認。
- `showAlerts`: 當模型返回非 OK 的回覆時，發送警報內容。
- `useIndicator`: 發出指示器事件以顯示 UI 狀態。

如果 **三者皆為假**，OpenClaw 將完全跳過心跳執行（不進行模型呼叫）。

### 每通道與每帳戶的範例

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

| 目標                          | 設定                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| 預設行為（靜默 OK，警報開啟） | _(不需要設定)_                                                                           |
| 完全靜默（無訊息，無指示器）  | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| 僅顯示指示器（無訊息）        | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| 僅在一個頻道中顯示 OK         | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (optional)

如果工作區中存在 `HEARTBEAT.md` 檔案，預設提示會告訴代理程式讀取它。可以把它想像成你的「心跳檢查清單」：小型、穩定，並且每 30 分鐘安全地包含一次。

如果 `HEARTBEAT.md` 存在但實際上是空的（只有空白行和像 `# Heading` 的 markdown 標題），OpenClaw 會跳過心跳執行以節省 API 呼叫。如果該檔案缺失，心跳仍然會執行，模型會決定該怎麼做。

保持簡短（短檢查清單或提醒），以避免提示膨脹。

Example `HEARTBEAT.md`:

# Heartbeat 檢查清單

- 快速掃描：收件箱裡有什麼緊急的事情嗎？
- 如果是白天，若沒有其他待處理的事項，進行輕量級的檢查。
- 如果某個任務被阻塞，記下 _缺少什麼_，下次詢問 Peter。

### 代理可以更新 HEARTBEAT.md 嗎？

是的——如果你要求它的話。

`HEARTBEAT.md` 只是代理工作區中的一個普通檔案，因此你可以在正常的聊天中告訴代理類似以下內容：

- “更新 `HEARTBEAT.md` 以新增每日行事曆檢查。”
- “重寫 `HEARTBEAT.md` 使其更簡短並專注於收件箱的後續跟進。”

如果您希望這個過程能夠主動進行，您也可以在您的心跳提示中包含一行明確的內容，例如：「如果檢查清單變得過時，請用更好的版本更新 HEARTBEAT.md。」

安全提示：請勿將秘密（API 金鑰、電話號碼、私人 token）放入 `HEARTBEAT.md` — 它會成為提示上下文的一部分。

## 手動喚醒（按需）

您可以排入系統事件並立即觸發心跳，方法如下：

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

如果多個代理已設定 `heartbeat`，則手動喚醒會立即執行這些代理的心跳。

使用 `--mode next-heartbeat` 來等待下一個預定的滴答。

## Reasoning delivery (optional)

根據預設，心跳僅傳遞最終的「答案」有效載荷。

如果您想要透明度，請啟用：

`agents.defaults.heartbeat.includeReasoning: true`

當啟用時，心跳也會傳送一個以 `Reasoning:` 為前綴的獨立訊息（形狀與 `/reasoning on` 相同）。這在代理管理多個會話/程式碼庫時可能會很有用，因為你可以了解它為什麼決定聯絡你——但這也可能洩漏出你不想要的更多內部細節。在群組聊天中建議將其關閉。

## 成本意識

心跳執行完整的代理轉換。較短的間隔會消耗更多的 tokens。如果您只想要內部狀態更新，請保持 `HEARTBEAT.md` 小並考慮使用更便宜的 `model` 或 `target: "none"`。
