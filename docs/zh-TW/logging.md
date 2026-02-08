---
summary: 「記錄概覽：檔案記錄、主控台輸出、CLI 即時追蹤，以及控制介面」
read_when:
  - 你需要適合初學者的記錄概覽
  - 你想設定記錄層級或格式
  - 你正在進行疑難排解並需要快速找到記錄
title: 「Logging」
x-i18n:
  source_path: logging.md
  source_hash: 884fcf4a906adff3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:50Z
---

# Logging

OpenClaw 會在兩個地方產生記錄：

- **檔案記錄**（JSON 行），由 Gateway 閘道器 寫入。
- **主控台輸出**，顯示於終端機與控制介面中。

本頁說明記錄的位置、如何閱讀，以及如何設定記錄層級與格式。

## 記錄存放位置

預設情況下，Gateway 閘道器 會將循環式記錄檔寫入以下位置：

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

日期會使用閘道器主機的本地時區。

你可以在 `~/.openclaw/openclaw.json` 中覆寫此設定：

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## 如何閱讀記錄

### CLI：即時追蹤（建議）

使用 CLI 透過 RPC 即時追蹤 Gateway 閘道器 的記錄檔：

```bash
openclaw logs --follow
```

輸出模式：

- **TTY 工作階段**：美化、著色、結構化的記錄行。
- **非 TTY 工作階段**：純文字。
- `--json`：以行分隔的 JSON（每行一個記錄事件）。
- `--plain`：在 TTY 工作階段中強制使用純文字。
- `--no-color`：停用 ANSI 顏色。

在 JSON 模式下，CLI 會輸出帶有 `type` 標記的物件：

- `meta`：串流中繼資料（檔案、游標、大小）
- `log`：已解析的記錄項目
- `notice`：截斷／輪替提示
- `raw`：未解析的記錄行

若 Gateway 閘道器 無法連線，CLI 會顯示簡短提示，建議執行：

```bash
openclaw doctor
```

### 控制介面（Web）

控制介面的 **Logs** 分頁會使用 `logs.tail` 即時追蹤同一個檔案。
如何開啟請參閱 [/web/control-ui](/web/control-ui)。

### 僅頻道記錄

若要篩選頻道活動（WhatsApp／Telegram／等），請使用：

```bash
openclaw channels logs --channel whatsapp
```

## 記錄格式

### 檔案記錄（JSONL）

記錄檔中的每一行都是一個 JSON 物件。CLI 與控制介面會解析這些
項目，以呈現結構化輸出（時間、層級、子系統、訊息）。

### 主控台輸出

主控台記錄 **可感知 TTY**，並針對可讀性進行格式化：

- 子系統前綴（例如 `gateway/channels/whatsapp`）
- 層級著色（info／warn／error）
- 可選的精簡或 JSON 模式

主控台格式由 `logging.consoleStyle` 控制。

## 設定記錄

所有記錄相關設定都位於 `~/.openclaw/openclaw.json` 中的 `logging` 底下。

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### 記錄層級

- `logging.level`：**檔案記錄**（JSONL）的層級。
- `logging.consoleLevel`：**主控台**的詳細程度層級。

`--verbose` 只影響主控台輸出，不會改變檔案記錄層級。

### 主控台樣式

`logging.consoleStyle`：

- `pretty`：以人類友善為主，含顏色與時間戳記。
- `compact`：更緊湊的輸出（適合長時間工作階段）。
- `json`：每行一個 JSON（供記錄處理器使用）。

### 遮蔽（Redaction）

工具摘要可以在輸出到主控台前遮蔽敏感權杖：

- `logging.redactSensitive`：`off` | `tools`（預設：`tools`）
- `logging.redactPatterns`：用來覆寫預設集合的正規表示式字串清單

遮蔽 **只影響主控台輸出**，不會修改檔案記錄。

## 診斷 + OpenTelemetry

診斷是結構化、可供機器讀取的事件，用於模型執行 **以及**
訊息流遙測（Webhook、佇列、工作階段狀態）。它們 **不會**
取代記錄；其存在目的是提供度量、追蹤與其他匯出器使用。

診斷事件會在程序內產生，但只有在啟用診斷 **以及**
匯出器外掛時，匯出器才會附加。

### OpenTelemetry 與 OTLP 的差異

- **OpenTelemetry（OTel）**：追蹤、度量與記錄的資料模型與 SDK。
- **OTLP**：用於將 OTel 資料匯出至收集器／後端的線路協定。
- OpenClaw 目前透過 **OTLP/HTTP（protobuf）** 匯出。

### 匯出的訊號

- **度量（Metrics）**：計數器與直方圖（權杖使用量、訊息流、佇列）。
- **追蹤（Traces）**：模型使用以及 webhook／訊息處理的 span。
- **記錄（Logs）**：當啟用 `diagnostics.otel.logs` 時，會透過 OTLP 匯出。記錄量
  可能很高；請留意 `logging.level` 與匯出器篩選條件。

### 診斷事件目錄

模型使用：

- `model.usage`：權杖、成本、持續時間、內容、提供者／模型／頻道、工作階段 ID。

訊息流：

- `webhook.received`：各頻道的 webhook 進入。
- `webhook.processed`：webhook 處理完成 + 持續時間。
- `webhook.error`：webhook 處理錯誤。
- `message.queued`：訊息加入處理佇列。
- `message.processed`：結果 + 持續時間 + 可選錯誤。

佇列 + 工作階段：

- `queue.lane.enqueue`：命令佇列通道加入 + 深度。
- `queue.lane.dequeue`：命令佇列通道取出 + 等待時間。
- `session.state`：工作階段狀態轉換 + 原因。
- `session.stuck`：工作階段卡住警告 + 存在時間。
- `run.attempt`：執行重試／嘗試的中繼資料。
- `diagnostic.heartbeat`：彙總計數器（webhook／佇列／工作階段）。

### 啟用診斷（不含匯出器）

若你希望診斷事件可供外掛或自訂接收器使用，請使用：

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 診斷旗標（目標式記錄）

使用旗標即可在不提高 `logging.level` 的情況下，開啟額外且具針對性的除錯記錄。
旗標不分大小寫，並支援萬用字元（例如 `telegram.*` 或 `*`）。

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

環境變數覆寫（一次性）：

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

注意事項：

- 旗標記錄會寫入標準記錄檔（與 `logging.file` 相同）。
- 輸出仍會依照 `logging.redactSensitive` 進行遮蔽。
- 完整指南：[/diagnostics/flags](/diagnostics/flags)。

### 匯出至 OpenTelemetry

診斷可透過 `diagnostics-otel` 外掛（OTLP/HTTP）匯出。這
適用於任何接受 OTLP/HTTP 的 OpenTelemetry 收集器／後端。

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

注意事項：

- 你也可以使用 `openclaw plugins enable diagnostics-otel` 啟用此外掛。
- `protocol` 目前僅支援 `http/protobuf`。`grpc` 會被忽略。
- 度量包含權杖使用量、成本、內容大小、執行時間，以及訊息流
  的計數器／直方圖（webhook、佇列、工作階段狀態、佇列深度／等待）。
- 可透過 `traces` / `metrics` 切換追蹤／度量（預設：開啟）。追蹤
  在啟用時包含模型使用 span 以及 webhook／訊息處理 span。
- 當你的收集器需要驗證時，請設定 `headers`。
- 支援的環境變數：`OTEL_EXPORTER_OTLP_ENDPOINT`、
  `OTEL_SERVICE_NAME`、`OTEL_EXPORTER_OTLP_PROTOCOL`。

### 匯出的度量（名稱 + 類型）

模型使用：

- `openclaw.tokens`（計數器，屬性：`openclaw.token`、`openclaw.channel`、
  `openclaw.provider`、`openclaw.model`）
- `openclaw.cost.usd`（計數器，屬性：`openclaw.channel`、`openclaw.provider`、
  `openclaw.model`）
- `openclaw.run.duration_ms`（直方圖，屬性：`openclaw.channel`、
  `openclaw.provider`、`openclaw.model`）
- `openclaw.context.tokens`（直方圖，屬性：`openclaw.context`、
  `openclaw.channel`、`openclaw.provider`、`openclaw.model`）

訊息流：

- `openclaw.webhook.received`（計數器，屬性：`openclaw.channel`、
  `openclaw.webhook`）
- `openclaw.webhook.error`（計數器，屬性：`openclaw.channel`、
  `openclaw.webhook`）
- `openclaw.webhook.duration_ms`（直方圖，屬性：`openclaw.channel`、
  `openclaw.webhook`）
- `openclaw.message.queued`（計數器，屬性：`openclaw.channel`、
  `openclaw.source`）
- `openclaw.message.processed`（計數器，屬性：`openclaw.channel`、
  `openclaw.outcome`）
- `openclaw.message.duration_ms`（直方圖，屬性：`openclaw.channel`、
  `openclaw.outcome`）

佇列 + 工作階段：

- `openclaw.queue.lane.enqueue`（計數器，屬性：`openclaw.lane`）
- `openclaw.queue.lane.dequeue`（計數器，屬性：`openclaw.lane`）
- `openclaw.queue.depth`（直方圖，屬性：`openclaw.lane` 或
  `openclaw.channel=heartbeat`）
- `openclaw.queue.wait_ms`（直方圖，屬性：`openclaw.lane`）
- `openclaw.session.state`（計數器，屬性：`openclaw.state`、`openclaw.reason`）
- `openclaw.session.stuck`（計數器，屬性：`openclaw.state`）
- `openclaw.session.stuck_age_ms`（直方圖，屬性：`openclaw.state`）
- `openclaw.run.attempt`（計數器，屬性：`openclaw.attempt`）

### 匯出的 span（名稱 + 關鍵屬性）

- `openclaw.model.usage`
  - `openclaw.channel`、`openclaw.provider`、`openclaw.model`
  - `openclaw.sessionKey`、`openclaw.sessionId`
  - `openclaw.tokens.*`（input／output／cache_read／cache_write／total）
- `openclaw.webhook.processed`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`、
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`、`openclaw.outcome`、`openclaw.chatId`、
    `openclaw.messageId`、`openclaw.sessionKey`、`openclaw.sessionId`、
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`、`openclaw.ageMs`、`openclaw.queueDepth`、
    `openclaw.sessionKey`、`openclaw.sessionId`

### 取樣 + 清送

- 追蹤取樣：`diagnostics.otel.sampleRate`（0.0–1.0，僅根 span）。
- 度量匯出間隔：`diagnostics.otel.flushIntervalMs`（最小 1000ms）。

### 協定注意事項

- OTLP/HTTP 端點可透過 `diagnostics.otel.endpoint` 或
  `OTEL_EXPORTER_OTLP_ENDPOINT` 設定。
- 若端點已包含 `/v1/traces` 或 `/v1/metrics`，將直接使用。
- 若端點已包含 `/v1/logs`，將直接用於記錄。
- `diagnostics.otel.logs` 會為主要記錄器輸出啟用 OTLP 記錄匯出。

### 記錄匯出行為

- OTLP 記錄會使用寫入 `logging.file` 的相同結構化紀錄。
- 會遵循 `logging.level`（檔案記錄層級）。主控台遮蔽 **不會**
  套用至 OTLP 記錄。
- 高流量安裝建議優先使用 OTLP 收集器的取樣／篩選功能。

## 疑難排解提示

- **Gateway 閘道器 無法連線？** 請先執行 `openclaw doctor`。
- **記錄是空的？** 請確認 Gateway 閘道器 正在執行，並且正在寫入
  `logging.file` 中指定的檔案路徑。
- **需要更多細節？** 將 `logging.level` 設為 `debug` 或 `trace` 後再試一次。
