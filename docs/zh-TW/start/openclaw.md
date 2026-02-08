---
summary: 「將 OpenClaw 作為個人助理執行的端到端指南，並附帶安全注意事項」
read_when:
  - 為新的助理實例進行入門引導
  - 檢視安全性／權限影響
title: 「個人助理設定」
x-i18n:
  source_path: start/openclaw.md
  source_hash: 8ebb0f602c074f77
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:29Z
---

# 使用 OpenClaw 建立個人助理

OpenClaw 是一個用於 **Pi** 代理程式的 WhatsApp + Telegram + Discord + iMessage Gateway 閘道器。外掛可加入 Mattermost。本指南說明「個人助理」設定：一個專用的 WhatsApp 號碼，其行為就像你隨時在線的代理程式。

## ⚠️ 安全優先

你正在讓一個代理程式處於可以：

- 在你的機器上執行指令（取決於你的 Pi 工具設定）
- 讀取／寫入你工作區中的檔案
- 透過 WhatsApp／Telegram／Discord／Mattermost（外掛）向外傳送訊息

從保守開始：

- 一律設定 `channels.whatsapp.allowFrom`（切勿在你的個人 Mac 上對全世界開放）。
- 為助理使用專用的 WhatsApp 號碼。
- 心跳目前預設為每 30 分鐘一次。在你信任此設定之前，請透過設定 `agents.defaults.heartbeat.every: "0m"` 停用。

## 先決條件

- 已安裝並完成 OpenClaw 入門引導 — 若尚未完成，請參閱 [Getting Started](/start/getting-started)
- 第二個電話號碼（SIM／eSIM／預付卡）供助理使用

## 兩支手機的設定（建議）

你想要的是這樣：

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

如果你將個人的 WhatsApp 連結到 OpenClaw，所有傳給你的訊息都會變成「代理程式輸入」。這通常不是你想要的。

## 5 分鐘快速開始

1. 配對 WhatsApp Web（顯示 QR；用助理手機掃描）：

```bash
openclaw channels login
```

2. 啟動 Gateway 閘道器（保持執行）：

```bash
openclaw gateway --port 18789
```

3. 在 `~/.openclaw/openclaw.json` 放入最小設定：

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

現在，從你的允許清單手機向助理號碼傳送訊息。

當入門完成時，我們會自動開啟儀表板並列印一個乾淨（非權杖化）的連結。若提示需要驗證，請將 `gateway.auth.token` 中的權杖貼到 Control UI 設定中。之後要重新開啟：`openclaw dashboard`。

## 為代理程式提供工作區（AGENTS）

OpenClaw 會從其工作區目錄讀取操作指示與「記憶」。

預設情況下，OpenClaw 使用 `~/.openclaw/workspace` 作為代理程式工作區，並會在設定／首次代理程式執行時自動建立（以及起始的 `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`）。`BOOTSTRAP.md` 僅在工作區全新時建立（刪除後不應再出現）。`MEMORY.md` 為選用（不會自動建立）；存在時，會在一般工作階段載入。子代理程式工作階段只會注入 `AGENTS.md` 與 `TOOLS.md`。

提示：將此資料夾視為 OpenClaw 的「記憶」，並將其設為 git repo（理想情況下為私有），以便備份你的 `AGENTS.md` 與記憶檔案。若已安裝 git，全新的工作區會自動初始化。

```bash
openclaw setup
```

完整的工作區配置與備份指南：[Agent workspace](/concepts/agent-workspace)
記憶工作流程：[Memory](/concepts/memory)

選用：使用 `agents.defaults.workspace` 選擇不同的工作區（支援 `~`）。

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

如果你已從 repo 發佈自有的工作區檔案，可以完全停用啟動時建立檔案：

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## 將其變成「助理」的設定

OpenClaw 預設即是良好的助理設定，但你通常會想調整：

- `SOUL.md` 中的 persona／指示
- 思考預設（如有需要）
- 心跳（在你信任之後）

範例：

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## 工作階段與記憶

- 工作階段檔案：`~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- 工作階段中繼資料（權杖用量、最後路由等）：`~/.openclaw/agents/<agentId>/sessions/sessions.json`（舊版：`~/.openclaw/sessions/sessions.json`）
- `/new` 或 `/reset` 會為該聊天啟動新的工作階段（可透過 `resetTriggers` 設定）。若單獨傳送，代理程式會以簡短問候回覆以確認重置。
- `/compact [instructions]` 會壓縮工作階段內容並回報剩餘的內容預算。

## 心跳（主動模式）

預設情況下，OpenClaw 每 30 分鐘執行一次心跳，提示為：
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
設定 `agents.defaults.heartbeat.every: "0m"` 以停用。

- 若 `HEARTBEAT.md` 存在但實質為空（只有空白行與像 `# Heading` 這樣的 Markdown 標題），OpenClaw 會略過心跳執行以節省 API 呼叫。
- 若檔案不存在，心跳仍會執行，並由模型決定要做什麼。
- 若代理程式回覆 `HEARTBEAT_OK`（可選擇性加上簡短填充；見 `agents.defaults.heartbeat.ackMaxChars`），OpenClaw 會抑制該次心跳的對外傳送。
- 心跳會執行完整的代理程式回合 — 較短的間隔會消耗更多權杖。

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## 媒體輸入與輸出

傳入的附件（圖片／音訊／文件）可透過樣板呈現在你的指令中：

- `{{MediaPath}}`（本機暫存檔路徑）
- `{{MediaUrl}}`（偽 URL）
- `{{Transcript}}`（若已啟用音訊轉錄）

代理程式的傳出附件：在單獨一行中包含 `MEDIA:<path-or-url>`（不可有空格）。範例：

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw 會擷取這些內容，並將其作為媒體與文字一併傳送。

## 營運檢查清單

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

日誌位於 `/tmp/openclaw/`（預設：`openclaw-YYYY-MM-DD.log`）。

## 後續步驟

- WebChat：[WebChat](/web/webchat)
- Gateway 營運：[Gateway runbook](/gateway)
- Cron + 喚醒：[Cron jobs](/automation/cron-jobs)
- macOS 選單列配套應用程式：[OpenClaw macOS app](/platforms/macos)
- iOS 節點應用程式：[iOS app](/platforms/ios)
- Android 節點應用程式：[Android app](/platforms/android)
- Windows 狀態：[Windows (WSL2)](/platforms/windows)
- Linux 狀態：[Linux app](/platforms/linux)
- 安全性：[Security](/gateway/security)
