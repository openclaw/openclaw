---
summary: "Heartbeat 輪詢訊息和通知規則"
read_when:
  - 調整 heartbeat 頻率或訊息時
  - 在 heartbeat 和 cron 之間決定排程任務時
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat vs Cron？** 請參閱 [Cron vs Heartbeat](/automation/cron-vs-heartbeat) 以取得何時使用兩者的指南。

Heartbeat 在主要工作階段中執行**週期性智慧代理輪次**，以便模型可以在不發送垃圾訊息給您的情況下，呈現任何需要注意的事項。

疑難排解: [/automation/troubleshooting](/automation/troubleshooting)

## 快速開始 (新手)

1.  保持 heartbeats 啟用 (預設為 `30m`，Anthropic OAuth/setup-token 為 `1h`) 或設定您自己的頻率。
2.  在智慧代理工作區建立一個小巧的 `HEARTBEAT.md` 檢查清單 (可選但建議)。
3.  決定 heartbeat 訊息應發送至何處 (`target: "last"` 為預設值)。
4.  可選：啟用 heartbeat 推理內容傳送以增加透明度。
5.  可選：將 heartbeats 限制在活躍時數 (當地時間)。

範例設定:

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

## 預設值

-   間隔: `30m` (或當偵測到的驗證模式為 Anthropic OAuth/setup-token 時為 `1h`)。設定 `agents.defaults.heartbeat.every` 或個別智慧代理的 `agents.list[].heartbeat.every`；使用 `0m` 停用。
-   提示內容 (可透過 `agents.defaults.heartbeat.prompt` 設定):
    `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
-   heartbeat 提示**逐字**作為使用者訊息發送。系統提示包含「Heartbeat」部分，且執行在內部被標記。
-   活躍時數 (`heartbeat.activeHours`) 在設定的時區中檢查。在此視窗之外，heartbeats 將被跳過，直到下一個在視窗內的計時器。

## Heartbeat 提示的用途

預設提示刻意設計得很廣泛：

-   **背景任務**: 「Consider outstanding tasks」提示智慧代理檢閱待辦事項 (收件匣、日曆、提醒、排隊工作) 並呈現任何緊急事項。
-   **人工報到**: 「Checkup sometimes on your human during day time」提示偶爾發送輕量級的「需要什麼嗎？」訊息，但透過使用您設定的當地時區避免夜間打擾 (請參閱 [/concepts/timezone](/concepts/timezone))。

如果您希望 heartbeat 執行非常特定的任務 (例如「檢查 Gmail PubSub 統計」或「驗證 Gateway健康狀態」)，請將 `agents.defaults.heartbeat.prompt` (或 `agents.list[].heartbeat.prompt`) 設定為自訂內容 (逐字發送)。

## 回應約定

-   如果沒有需要注意的事項，請回覆 **`HEARTBEAT_OK`**。
-   在 heartbeat 執行期間，當 `HEARTBEAT_OK` 出現在回覆的**開頭或結尾**時，OpenClaw 會將其視為確認。此標記將被移除，如果剩餘內容 **≤ `ackMaxChars`** (預設: 300)，則回覆將被捨棄。
-   如果 `HEARTBEAT_OK` 出現在回覆的**中間**，則不會被特殊處理。
-   對於警示，**不要**包含 `HEARTBEAT_OK`；只回傳警示文字。

在 heartbeats 之外，訊息開頭/結尾意外出現的 `HEARTBEAT_OK` 會被移除並記錄；僅包含 `HEARTBEAT_OK` 的訊息會被捨棄。

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

### 範圍和優先順序

-   `agents.defaults.heartbeat` 設定全域 heartbeat 行為。
-   `agents.list[].heartbeat` 在其之上合併；如果任何智慧代理具有 `heartbeat` 區塊，則**只有這些智慧代理**執行 heartbeats。
-   `channels.defaults.heartbeat` 為所有頻道設定可見性預設值。
-   `channels.<channel>.heartbeat` 覆寫頻道預設值。
-   `channels.<channel>.accounts.<id>.heartbeat` (多帳戶頻道) 覆寫每個頻道的設定。

### 個別智慧代理心跳

如果任何 `agents.list[]` 項目包含 `heartbeat` 區塊，則**只有這些智慧代理**執行 heartbeats。每個智慧代理的區塊會合併在 `agents.defaults.heartbeat` 之上 (因此您可以一次設定共用預設值，然後針對每個智慧代理進行覆寫)。

範例: 兩個智慧代理，只有第二個智慧代理執行 heartbeats。

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

### 活躍時數範例

將 heartbeats 限制在特定時區的工作時間內:

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

在此視窗之外 (東部時間上午 9 點之前或晚上 10 點之後)，heartbeats 將被跳過。下一個排定的視窗內計時器將正常執行。

### 多帳戶範例

使用 `accountId` 來指定 Telegram 等多帳戶頻道上的特定帳戶:

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

### 欄位說明

-   `every`: heartbeat 間隔 (持續時間字串；預設單位 = 分鐘)。
-   `model`: heartbeat 執行的可選模型覆寫 (`provider/model`)。
-   `includeReasoning`: 啟用時，也會傳送獨立的 `Reasoning:` 訊息 (如果可用) (與 `/reasoning on` 的格式相同)。
-   `session`: heartbeat 執行的可選工作階段鍵。
    -   `main` (預設): 智慧代理主要工作階段。
    -   明確的工作階段鍵 (從 `openclaw sessions --json` 或 [sessions CLI](/cli/sessions) 複製)。
    -   工作階段鍵格式: 請參閱 [工作階段](/concepts/session) 和 [群組](/channels/groups)。
-   `target`:
    -   `last` (預設): 傳送至上次使用的外部頻道。
    -   明確頻道: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`。
    -   `none`: 執行 heartbeat 但**不傳送**至外部。
-   `to`: 可選的收件人覆寫 (頻道特定 ID，例如 WhatsApp 的 E.164 或 Telegram 聊天 ID)。
-   `accountId`: 多帳戶頻道的選用帳戶 ID。當 `target: "last"` 時，如果解析後的最後一個頻道支援帳戶，則帳戶 ID 適用於該頻道；否則將被忽略。如果帳戶 ID 與解析後的頻道的已設定帳戶不符，則會跳過傳送。
-   `prompt`: 覆寫預設提示內容 (不合併)。
-   `ackMaxChars`: `HEARTBEAT_OK` 之後允許的最大字元數，然後才進行傳送。
-   `activeHours`: 將 heartbeat 執行限制在時間視窗內。包含 `start` (HH:MM，包含)、`end` (HH:MM，不包含；`24:00` 允許表示一天結束) 和可選 `timezone` 的物件。
    -   省略或 `"user"`: 如果設定了 `agents.defaults.userTimezone`，則使用該設定，否則回溯至主機系統時區。
    -   `"local"`: 始終使用主機系統時區。
    -   任何 IANA 識別碼 (例如 `America/New_York`): 直接使用；如果無效，則回溯至上述的 `"user"` 行為。
    -   在活動視窗之外，heartbeats 會被跳過，直到下一個在視窗內的計時器。

## 傳送行為

-   heartbeats 預設在智慧代理的主工作階段中執行 (`agent:<id>:<mainKey>`)，或者當 `session.scope = "global"` 時在 `global` 中執行。設定 `session` 可覆寫為特定的頻道工作階段 (Discord/WhatsApp/等)。
-   `session` 只影響執行上下文；傳送由 `target` 和 `to` 控制。
-   要傳送至特定的頻道/收件人，請設定 `target` + `to`。使用 `target: "last"` 時，傳送會使用該工作階段的最後一個外部頻道。
-   如果主要佇列忙碌，heartbeat 將被跳過並稍後重試。
-   如果 `target` 解析為沒有外部目標，執行仍然會發生，但不會發送出站訊息。
-   僅限 heartbeat 的回覆**不會**使工作階段保持活躍；`updatedAt` 將被還原，因此閒置過期行為正常。

## 可見性控制

預設情況下，`HEARTBEAT_OK` 確認會被抑制，而警示內容則會傳送。您可以針對每個頻道或每個帳戶調整此設定：

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # 隱藏 HEARTBEAT_OK (預設)
      showAlerts: true # 顯示警示訊息 (預設)
      useIndicator: true # 發出指示器事件 (預設)
  telegram:
    heartbeat:
      showOk: true # 在 Telegram 上顯示 OK 確認
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # 抑制此帳戶的警示傳送
```

優先順序：每個帳戶 → 每個頻道 → 頻道預設值 → 內建預設值。

### 各標誌的用途

-   `showOk`: 當模型回傳僅限 OK 的回覆時，傳送 `HEARTBEAT_OK` 確認。
-   `showAlerts`: 當模型回傳非 OK 的回覆時，傳送警示內容。
-   `useIndicator`: 為 UI 狀態介面發出指示器事件。

如果**所有三個**都為 false，OpenClaw 會完全跳過 heartbeat 執行 (不呼叫模型)。

### 每個頻道與每個帳戶的範例

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # 所有 Slack 帳戶
    accounts:
      ops:
        heartbeat:
          showAlerts: false # 僅抑制 ops 帳戶的警示
  telegram:
    heartbeat:
      showOk: true
```

### 常見模式

| 目標 | 設定 |
| :--------------------------------------- | :--------------------------------------------------------------------------------------- |
| 預設行為 (靜默 OK，警示開啟) | _(無需設定)_ |
| 完全靜默 (無訊息，無指示器) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| 僅指示器 (無訊息) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }` |
| 僅在一個頻道顯示 OK | `channels.telegram.heartbeat: { showOk: true }` |

## HEARTBEAT.md (可選)

如果工作區中存在 `HEARTBEAT.md` 檔案，預設提示會告知智慧代理讀取該檔案。將其視為您的「heartbeat 檢查清單」：小巧、穩定，且每 30 分鐘包含一次是安全的。

如果 `HEARTBEAT.md` 存在但實際上是空的 (只有空白行和 Markdown 標題，例如 `# Heading`)，OpenClaw 會跳過 heartbeat 執行以節省 API 呼叫。如果檔案遺失，heartbeat 仍會執行，並由模型決定要怎麼做。

保持其小巧 (簡短的檢查清單或提醒) 以避免提示內容過多。

`HEARTBEAT.md` 範例:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### 智慧代理可以更新 HEARTBEAT.md 嗎？

可以 — 如果您要求它這麼做。

`HEARTBEAT.md` 只是智慧代理工作區中的一個普通檔案，因此您可以在一般聊天中告訴智慧代理：

-   「更新 `HEARTBEAT.md` 以新增每日日曆檢查。」
-   「重寫 `HEARTBEAT.md`，使其更簡短並專注於收件匣後續工作。」

如果您希望這種情況主動發生，您也可以在您的 heartbeat 提示中包含明確的一行，例如：「If the checklist becomes stale, update HEARTBEAT.md with a better one.」

安全注意事項：請勿將機密 (API 鍵、電話號碼、私人令牌) 放入 `HEARTBEAT.md` 中 — 它將成為提示上下文的一部分。

## 手動喚醒 (按需)

您可以將系統事件排入佇列並觸發即時 heartbeat：

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

如果多個智慧代理設定了 `heartbeat`，手動喚醒會立即執行每個智慧代理的 heartbeats。

使用 `--mode next-heartbeat` 等待下一個排定的計時器。

## 推理內容傳送 (可選)

預設情況下，heartbeats 只傳送最終的「答案」負載。

如果您需要透明度，請啟用：

-   `agents.defaults.heartbeat.includeReasoning: true`

啟用後，heartbeats 也會傳送一則以 `Reasoning:` 為前綴的獨立訊息 (與 `/reasoning on` 的格式相同)。當智慧代理管理多個工作階段/程式碼庫，且您想了解它為何決定聯繫您時，這會很有用 — 但它也可能洩漏比您期望的更多內部細節。建議在群組聊天中保持關閉。

## 成本意識

Heartbeats 執行完整的智慧代理輪次。更短的間隔會消耗更多 tokens。請保持 `HEARTBEAT.md` 小巧，並考慮使用更便宜的 `model` 或 `target: "none"`，如果您只想要內部狀態更新。
