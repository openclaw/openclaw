---
summary: "Heartbeat 輪詢訊息與通知規則"
read_when:
  - 調整 Heartbeat 頻率或訊息內容時
  - 在 Heartbeat 與 Cron 之間選擇排程任務時
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat 還是 Cron？** 請參閱 [Cron vs Heartbeat](/automation/cron-vs-heartbeat) 以了解何時使用各項功能。

Heartbeat 在主工作階段中執行**週期性的智慧代理輪詢**，讓模型可以主動提出需要注意的事項，而不會對您造成騷擾。

疑難排解：[/automation/troubleshooting](/automation/troubleshooting)

## 快速開始 (初學者)

1. 保持 Heartbeat 啟用（預設為 `30m`，若使用 Anthropic OAuth/setup-token 則為 `1h`）或設定您自己的頻率。
2. 在智慧代理工作空間中建立一個小型的 `HEARTBEAT.md` 檢查清單（選填，但強烈建議）。
3. 決定 Heartbeat 訊息應傳送到何處（預設為 `target: "last"`）。
4. 選填：啟用 Heartbeat 推理傳遞以增加透明度。
5. 選填：將 Heartbeat 限制在活躍時間內（當地時間）。

範例設定：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // 選填：同時發送獨立的 `Reasoning:` 訊息
      },
    },
  },
}
```

## 預設值

- 間隔：`30m`（或當偵測到驗證模式為 Anthropic OAuth/setup-token 時為 `1h`）。設定 `agents.defaults.heartbeat.every` 或個別智慧代理的 `agents.list[].heartbeat.every`；使用 `0m` 即可停用。
- 提示詞主體（可透過 `agents.defaults.heartbeat.prompt` 設定）：
  `如果 HEARTBEAT.md 存在，請閱讀它（工作空間上下文）。嚴格遵守其中的內容。不要推斷或重複先前對話中的舊任務。如果沒有任何事項需要注意，請回覆 HEARTBEAT_OK。`
- Heartbeat 提示詞會**原樣**作為使用者訊息傳送。系統提示詞包含一個「Heartbeat」區段，且該次執行會在內部加上標記。
- 活躍時間 (`heartbeat.activeHours`) 會根據設定的時區進行檢查。在時間範圍外，Heartbeat 會跳過，直到下一個處於時間範圍內的週期。

## Heartbeat 提示詞的用途

預設提示詞的設計刻意保持廣泛：

- **背景任務**：「考慮未完成的任務」會促使智慧代理檢查後續行動（收件匣、行事曆、提醒、佇列中的工作）並提出任何緊急事項。
- **人類關懷**：「在白天偶爾關心您的人類」會促使智慧代理偶爾發送輕量級的「有什麼需要幫忙的嗎？」訊息，但透過使用您設定的在地時區（參閱 [/concepts/timezone](/concepts/timezone)）來避免在夜間騷擾。

如果您希望 Heartbeat 執行非常具體的任務（例如「檢查 Gmail PubSub 統計數據」或「驗證 Gateway 健康狀態」），請將 `agents.defaults.heartbeat.prompt`（或 `agents.list[].heartbeat.prompt`）設定為自定義主體（將原樣傳送）。

## 回覆規範

- 如果沒有事項需要注意，請回覆 **`HEARTBEAT_OK`**。
- 在 Heartbeat 執行期間，當 `HEARTBEAT_OK` 出現在回覆的**開頭或結尾**時，OpenClaw 會將其視為確認 (ack)。該標記會被移除，且如果剩餘內容 **≤ `ackMaxChars`**（預設：300），則該回覆將被捨棄。
- 如果 `HEARTBEAT_OK` 出現在回覆的**中間**，則不會被特殊處理。
- 對於警示訊息，**請勿**包含 `HEARTBEAT_OK`；僅傳回警示文字。

在 Heartbeat 之外，出現在訊息開頭/結尾的零星 `HEARTBEAT_OK` 會被移除並記錄；僅包含 `HEARTBEAT_OK` 的訊息會被捨棄。

## 設定 (Config)

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 預設：30m (0m 停用)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // 預設：false (若可用，則傳送獨立的 Reasoning: 訊息)
        target: "last", // last | none | <channel id> (核心或外掛程式，例如 "bluebubbles")
        to: "+15551234567", // 選填：特定頻道的覆蓋目標
        accountId: "ops-bot", // 選填：多帳號頻道的 ID
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // 在 HEARTBEAT_OK 之後允許的最大字元數
      },
    },
  },
}
```

### 範圍與優先順序

- `agents.defaults.heartbeat` 設定全域 Heartbeat 行為。
- `agents.list[].heartbeat` 會覆蓋並合併；如果任何智慧代理擁有 `heartbeat` 區塊，則**只有這些智慧代理**會執行 Heartbeat。
- `channels.defaults.heartbeat` 設定所有頻道的預設可見度。
- `channels.<channel>.heartbeat` 覆蓋頻道預設設定。
- `channels.<channel>.accounts.<id>.heartbeat`（多帳號頻道）覆蓋個別頻道的設定。

### 個別智慧代理的 Heartbeat

如果任何 `agents.list[]` 項目包含 `heartbeat` 區塊，則**只有這些智慧代理**會執行 Heartbeat。個別智慧代理的區塊會合併在 `agents.defaults.heartbeat` 之上（因此您可以先設定共用的預設值，再針對個別智慧代理進行覆蓋）。

範例：兩個智慧代理，僅第二個智慧代理執行 Heartbeat。

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

### 活躍時間範例

將 Heartbeat 限制在特定時區的工作時間內：

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
          timezone: "America/New_York", // 選填；若已設定則使用您的 userTimezone，否則使用主機時區
        },
      },
    },
  },
}
```

在該時間範圍外（美東時間上午 9 點之前或晚上 10 點之後），Heartbeat 會被跳過。下一個處於時間範圍內的排定週期將正常執行。

### 多帳號範例

使用 `accountId` 在 Telegram 等多帳號頻道上指定特定帳號：

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

- `every`: Heartbeat 間隔（時間長度字串；預設單位為分鐘）。
- `model`: 選填：Heartbeat 執行的覆蓋模型 (`provider/model`)。
- `includeReasoning`: 啟用後，若可用，也會傳遞獨立的 `Reasoning:` 訊息（形式與 `/reasoning on` 相同）。
- `session`: 選填：Heartbeat 執行的工作階段鍵名。
  - `main` (預設)：智慧代理主工作階段。
  - 明確的工作階段鍵名（從 `openclaw sessions --json` 或 [sessions CLI](/cli/sessions) 複製）。
  - 工作階段鍵名格式：請參閱 [工作階段](/concepts/session) 與 [群組](/channels/groups)。
- `target`:
  - `last` (預設)：傳遞到最後使用的外部頻道。
  - 明確頻道：`whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`。
  - `none`: 執行 Heartbeat 但**不進行外部傳遞**。
- `to`: 選填：覆蓋接收者（特定頻道的 ID，例如 WhatsApp 的 E.164 格式或 Telegram 的聊天 ID）。
- `accountId`: 選填：多帳號頻道的帳號 ID。當 `target: "last"` 時，如果解析出的最後一個頻道支援帳號，則該帳號 ID 會生效；否則將被忽略。如果帳號 ID 與解析頻道所設定的帳號不符，則會跳過傳遞。
- `prompt`: 覆蓋預設提示詞主體（不會合併）。
- `ackMaxChars`: 在傳遞前，`HEARTBEAT_OK` 之後允許的最大字元數。
- `activeHours`: 將 Heartbeat 執行限制在某個時間範圍內。包含 `start` (HH:MM, 包含)、`end` (HH:MM, 不包含；`24:00` 表示當天結束) 以及選填的 `timezone` 物件。
  - 若省略或設定為 `"user"`：使用您的 `agents.defaults.userTimezone`（若已設定），否則退而使用主機系統時區。
  - `"local"`：一律使用主機系統時區。
  - 任何 IANA 識別碼（例如 `America/New_York`）：直接使用；若無效，則退而使用上述的 `"user"` 行為。
  - 在活躍時間外，Heartbeat 會跳過，直到下一個處於範圍內的週期。

## 傳遞行為

- 預設情況下，Heartbeat 在智慧代理的主工作階段中執行（`agent:<id>:<mainKey>`），或者當 `session.scope = "global"` 時在 `global` 中執行。設定 `session` 可覆蓋為特定的頻道工作階段（Discord/WhatsApp 等）。
- `session` 僅影響執行上下文；傳遞則由 `target` 和 `to` 控制。
- 若要傳遞到特定頻道/接收者，請設定 `target` + `to`。使用 `target: "last"` 時，傳遞會使用該工作階段最後使用的外部頻道。
- 如果主佇列忙碌中，Heartbeat 會被跳過並在稍後重試。
- 如果 `target` 解析後沒有外部目的地，執行仍會發生，但不會傳送外送訊息。
- 僅包含 Heartbeat 的回覆**不會**維持工作階段的活躍狀態；最後一次的 `updatedAt` 會被還原，因此閒置過期行為將保持正常。

## 可見度控制

預設情況下，`HEARTBEAT_OK` 確認會被抑制，而警示內容則會傳遞。您可以按頻道或按帳號調整此設定：

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # 隱藏 HEARTBEAT_OK (預設)
      showAlerts: true # 顯示警示訊息 (預設)
      useIndicator: true # 發送指示器事件 (預設)
  telegram:
    heartbeat:
      showOk: true # 在 Telegram 上顯示 OK 確認
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # 抑制此帳號的警示傳遞
```

優先順序：個別帳號 → 個別頻道 → 頻道預設值 → 內建預設值。

### 各個標記的作用

- `showOk`: 當模型傳回僅包含 OK 的回覆時，傳送 `HEARTBEAT_OK` 確認。
- `showAlerts`: 當模型傳回非 OK 的回覆時，傳送警示內容。
- `useIndicator`: 為 UI 狀態顯示發送指示器事件。

如果**這三個標記**皆為 false，OpenClaw 將完全跳過 Heartbeat 執行（不會呼叫模型）。

### 個別頻道與個別帳號範例

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # 所有 Slack 帳號
    accounts:
      ops:
        heartbeat:
          showAlerts: false # 僅抑制 ops 帳號的警示
  telegram:
    heartbeat:
      showOk: true
```

### 常見模式

| 目標                         | 設定                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| 預設行為 (OK 靜音, 警示開啟) | _(無需設定)_                                                                             |
| 完全靜音 (無訊息, 無指示器)  | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| 僅顯示指示器 (無訊息)        | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| 僅在一個頻道顯示 OK          | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (選填)

如果工作空間中存在 `HEARTBEAT.md` 檔案，預設提示詞會告知智慧代理閱讀它。您可以將其視為您的「Heartbeat 檢查清單」：小巧、穩定，且適合每 30 分鐘包含在提示詞中一次。

如果 `HEARTBEAT.md` 存在但實質上是空的（僅有空行或像 `# Heading` 之類的 Markdown 標題），OpenClaw 會跳過 Heartbeat 執行以節省 API 呼叫次數。如果檔案不存在，Heartbeat 仍會執行，並由模型決定如何操作。

請保持內容精簡（簡短的檢查清單或提醒），以避免提示詞膨脹。

範例 `HEARTBEAT.md`：

```md
# Heartbeat 檢查清單

- 快速掃描：收件匣中有任何緊急事項嗎？
- 如果是白天，且沒有其他待處理事項，請進行輕量級的關懷。
- 如果某個任務被阻礙，請記錄下「缺少的內容」，並在下次詢問 Peter。
```

### 智慧代理可以更新 HEARTBEAT.md 嗎？

可以——只要您要求它這麼做。

`HEARTBEAT.md` 只是智慧代理工作空間中的一個普通檔案，因此您可以在普通對話中告訴智慧代理：

- 「更新 `HEARTBEAT.md` 以加入每日行事曆檢查。」
- 「重寫 `HEARTBEAT.md`，使其更簡短並專注於收件匣後續行動。」

如果您希望這能主動發生，您也可以在 Heartbeat 提示詞中加入明確的一行，例如：「如果檢查清單變得過時，請用更好的內容更新 HEARTBEAT.md。」

安全注意事項：請勿將機密資訊（API 金鑰、電話號碼、私人權杖）放入 `HEARTBEAT.md`——它會成為提示詞上下文的一部分。

## 手動喚醒 (隨選)

您可以透過以下指令將系統事件加入佇列並立即觸發 Heartbeat：

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

如果多個智慧代理都設定了 `heartbeat`，手動喚醒會立即執行每個智慧代理的 Heartbeat。

使用 `--mode next-heartbeat` 則會等待下一個排定的週期。

## 推理傳遞 (選填)

預設情況下，Heartbeat 僅傳遞最終的「答案」負載。

如果您希望增加透明度，請啟用：

- `agents.defaults.heartbeat.includeReasoning: true`

啟用後，Heartbeat 還會傳遞一條以 `Reasoning:` 開頭的獨立訊息（形式與 `/reasoning on` 相同）。當智慧代理正在管理多個工作階段/代碼庫，且您想了解它為何決定聯繫您時，這非常有用——但也可能會洩露比您預期更多的內部細節。建議在群組對話中保持關閉。

## 成本意識

Heartbeat 執行完整的智慧代理輪詢。較短的間隔會消耗更多權杖。請保持 `HEARTBEAT.md` 精簡，如果您只需要內部狀態更新，請考慮使用較便宜的 `model` 或將 `target` 設定為 `"none"`。
