---
summary: 「透過 imsg 的舊版 iMessage 支援（以 stdio 進行 JSON-RPC）。新的設定應使用 BlueBubbles。」
read_when:
  - 「設定 iMessage 支援」
  - 「除錯 iMessage 傳送／接收」
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:15Z
---

# iMessage（舊版：imsg）

> **建議：** 新的 iMessage 設定請使用 [BlueBubbles](/channels/bluebubbles)。
>
> `imsg` 頻道是舊版的外部 CLI 整合，未來版本可能會移除。

狀態：舊版外部 CLI 整合。Gateway 會啟動 `imsg rpc`（以 stdio 進行 JSON-RPC）。

## 快速設定（初學者）

1. 確認此 Mac 上的「訊息」已登入。
2. 安裝 `imsg`：
   - `brew install steipete/tap/imsg`
3. 使用 `channels.imessage.cliPath` 與 `channels.imessage.dbPath` 設定 OpenClaw。
4. 啟動 Gateway，並核准任何 macOS 提示（自動化 + 完整磁碟存取）。

最小設定：

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## 它是什麼

- 由 macOS 上的 `imsg` 支援的 iMessage 頻道。
- 確定性路由：回覆一律回到 iMessage。
- 私訊共用代理程式的主要工作階段；群組則是隔離的（`agent:<agentId>:imessage:group:<chat_id>`）。
- 若多參與者執行緒以 `is_group=false` 抵達，你仍可透過 `channels.imessage.groups` 使用 `chat_id` 進行隔離（見下方「類群組執行緒」）。

## 設定寫入

預設允許 iMessage 寫入由 `/config set|unset` 觸發的設定更新（需要 `commands.config: true`）。

停用方式：

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## 需求

- 已登入「訊息」的 macOS。
- 為 OpenClaw + `imsg` 提供完整磁碟存取（存取「訊息」資料庫）。
- 傳送時需要自動化權限。
- `channels.imessage.cliPath` 可指向任何可代理 stdin/stdout 的指令（例如：透過 SSH 連線到另一台 Mac 並執行 `imsg rpc` 的包裝腳本）。

## 疑難排解 macOS 隱私權與安全性 TCC

若傳送／接收失敗（例如 `imsg rpc` 非零結束、逾時，或 Gateway 看似卡住），常見原因是未核准的 macOS 權限提示。

macOS 會依應用程式／行程情境授予 TCC 權限。請在執行 `imsg` 的相同情境中核准提示（例如 Terminal/iTerm、LaunchAgent 工作階段，或由 SSH 啟動的行程）。

檢查清單：

- **完整磁碟存取**：允許執行 OpenClaw 的行程（以及任何執行 `imsg` 的 shell／SSH 包裝器）存取。這是讀取「訊息」資料庫（`chat.db`）所必需。
- **自動化 → 訊息**：允許執行 OpenClaw 的行程（及／或你的終端機）控制 **Messages.app** 以進行外送。
- **`imsg` CLI 健康狀態**：確認已安裝 `imsg` 並支援 RPC（`imsg rpc --help`）。

提示：若 OpenClaw 以無頭模式執行（LaunchAgent/systemd/SSH），macOS 的提示很容易錯過。請在 GUI 終端機中執行一次互動式指令以強制顯示提示，然後重試：

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

相關的 macOS 資料夾權限（桌面／文件／下載）：[/platforms/mac/permissions](/platforms/mac/permissions)。

## 設定（快速路徑）

1. 確認此 Mac 上的「訊息」已登入。
2. 設定 iMessage 並啟動 Gateway。

### 專用機器人 macOS 使用者（用於隔離身分）

若你希望機器人以**獨立的 iMessage 身分**傳送（並保持你的個人「訊息」乾淨），請使用專用的 Apple ID + 專用的 macOS 使用者。

1. 建立專用 Apple ID（例如：`my-cool-bot@icloud.com`）。
   - Apple 可能需要電話號碼進行驗證／2FA。
2. 建立 macOS 使用者（例如：`openclawhome`）並登入。
3. 在該 macOS 使用者中開啟「訊息」，並使用機器人的 Apple ID 登入 iMessage。
4. 啟用「遠端登入」（系統設定 → 一般 → 共享 → 遠端登入）。
5. 安裝 `imsg`：
   - `brew install steipete/tap/imsg`
6. 設定 SSH，讓 `ssh <bot-macos-user>@localhost true` 無需密碼即可運作。
7. 將 `channels.imessage.accounts.bot.cliPath` 指向一個 SSH 包裝器，以機器人使用者身分執行 `imsg`。

首次執行注意事項：傳送／接收可能需要在 _機器人 macOS 使用者_ 中核准 GUI 權限（自動化 + 完整磁碟存取）。若 `imsg rpc` 看起來卡住或結束，請登入該使用者（可使用螢幕共享），執行一次 `imsg chats --limit 1`／`imsg send ...`，核准提示後再重試。請參考［疑難排解 macOS 隱私權與安全性 TCC］(#troubleshooting-macos-privacy-and-security-tcc)。

範例包裝器（`chmod +x`）。請將 `<bot-macos-user>` 替換為你實際的 macOS 使用者名稱：

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

範例設定：

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

單一帳號設定請使用扁平選項（`channels.imessage.cliPath`、`channels.imessage.dbPath`），而非 `accounts` 對應表。

### 遠端／SSH 變體（選用）

若你希望在另一台 Mac 上使用 iMessage，請將 `channels.imessage.cliPath` 設為一個包裝器，透過 SSH 在遠端 macOS 主機上執行 `imsg`。OpenClaw 只需要 stdio。

範例包裝器：

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**遠端附件：** 當 `cliPath` 透過 SSH 指向遠端主機時，「訊息」資料庫中的附件路徑會參考遠端機器上的檔案。可設定 `channels.imessage.remoteHost`，讓 OpenClaw 透過 SCP 自動擷取這些檔案：

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

若未設定 `remoteHost`，OpenClaw 會嘗試解析你的包裝腳本中的 SSH 指令來自動偵測。為了可靠性，建議明確設定。

#### 透過 Tailscale 的遠端 Mac（範例）

若 Gateway 在 Linux 主機／VM 上執行，但 iMessage 必須在 Mac 上運作，Tailscale 是最簡單的橋接方式：Gateway 透過 tailnet 與 Mac 通訊，經由 SSH 執行 `imsg`，並將附件以 SCP 傳回。

架構：

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

具體設定範例（Tailscale 主機名稱）：

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

範例包裝器（`~/.openclaw/scripts/imsg-ssh`）：

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

注意事項：

- 確保 Mac 已登入「訊息」，且已啟用遠端登入。
- 使用 SSH 金鑰，讓 `ssh bot@mac-mini.tailnet-1234.ts.net` 無需提示即可運作。
- `remoteHost` 應與 SSH 目標相符，以便 SCP 擷取附件。

多帳號支援：使用 `channels.imessage.accounts` 搭配每個帳號的設定，以及選用的 `name`。共享模式請見［`gateway/configuration`］(/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)。請勿提交 `~/.openclaw/openclaw.json`（通常包含權杖）。

## 存取控制（私訊 + 群組）

私訊：

- 預設：`channels.imessage.dmPolicy = "pairing"`。
- 未知寄件者會收到配對碼；在核准前會忽略訊息（配對碼 1 小時後過期）。
- 核准方式：
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- 配對是 iMessage 私訊的預設權杖交換機制。詳情請見：[Pairing](/channels/pairing)

群組：

- `channels.imessage.groupPolicy = open | allowlist | disabled`。
- 當設定 `allowlist` 時，`channels.imessage.groupAllowFrom` 會控制誰可以在群組中觸發。
- 由於 iMessage 沒有原生提及中繼資料，提及閘控使用 `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）。
- 多代理程式覆寫：在 `agents.list[].groupChat.mentionPatterns` 上設定每個代理程式的模式。

## 運作方式（行為）

- `imsg` 會串流訊息事件；Gateway 會將其正規化為共用的頻道封裝。
- 回覆一律路由回相同的聊天 ID 或 handle。

## 類群組執行緒（`is_group=false`）

某些 iMessage 執行緒可能有多位參與者，但依「訊息」儲存聊天識別碼的方式不同，仍可能以 `is_group=false` 抵達。

若你在 `channels.imessage.groups` 下明確設定 `chat_id`，OpenClaw 會將該執行緒視為「群組」，以便：

- 工作階段隔離（獨立的 `agent:<agentId>:imessage:group:<chat_id>` 工作階段金鑰）
- 群組允許清單／提及閘控行為

範例：

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

當你希望為特定執行緒使用隔離的人格／模型時，這非常實用（請見［多代理程式路由］(/concepts/multi-agent)）。檔案系統隔離請見［沙箱隔離］(/gateway/sandboxing)。

## 媒體 + 限制

- 透過 `channels.imessage.includeAttachments` 的選用附件匯入。
- 透過 `channels.imessage.mediaMaxMb` 的媒體上限。

## 限制

- 外送文字會分段為 `channels.imessage.textChunkLimit`（預設 4000）。
- 選用的換行分段：設定 `channels.imessage.chunkMode="newline"`，在依長度分段前先依空白行（段落邊界）分割。
- 媒體上傳上限由 `channels.imessage.mediaMaxMb` 控制（預設 16）。

## 定址／投遞目標

建議使用 `chat_id` 以獲得穩定路由：

- `chat_id:123`（建議）
- `chat_guid:...`
- `chat_identifier:...`
- 直接 handle：`imessage:+1555`／`sms:+1555`／`user@example.com`

列出聊天：

```
imsg chats --limit 20
```

## 設定參考（iMessage）

完整設定：[設定](/gateway/configuration)

提供者選項：

- `channels.imessage.enabled`：啟用／停用頻道啟動。
- `channels.imessage.cliPath`：`imsg` 的路徑。
- `channels.imessage.dbPath`：「訊息」資料庫路徑。
- `channels.imessage.remoteHost`：當 `cliPath` 指向遠端 Mac（例如 `user@gateway-host`）時，用於 SCP 附件傳輸的 SSH 主機。若未設定，將從 SSH 包裝器自動偵測。
- `channels.imessage.service`：`imessage | sms | auto`。
- `channels.imessage.region`：SMS 區域。
- `channels.imessage.dmPolicy`：`pairing | allowlist | open | disabled`（預設：配對）。
- `channels.imessage.allowFrom`：私訊允許清單（handle、電子郵件、E.164 號碼，或 `chat_id:*`）。`open` 需要 `"*"`。iMessage 沒有使用者名稱；請使用 handle 或聊天目標。
- `channels.imessage.groupPolicy`：`open | allowlist | disabled`（預設：允許清單）。
- `channels.imessage.groupAllowFrom`：群組寄件者允許清單。
- `channels.imessage.historyLimit`／`channels.imessage.accounts.*.historyLimit`：納入為上下文的群組訊息最大數量（0 代表停用）。
- `channels.imessage.dmHistoryLimit`：以使用者回合計的私訊歷史上限。每位使用者的覆寫：`channels.imessage.dms["<handle>"].historyLimit`。
- `channels.imessage.groups`：每個群組的預設值 + 允許清單（全域預設請使用 `"*"`）。
- `channels.imessage.includeAttachments`：將附件匯入至上下文。
- `channels.imessage.mediaMaxMb`：入站／出站媒體上限（MB）。
- `channels.imessage.textChunkLimit`：外送分段大小（字元）。
- `channels.imessage.chunkMode`：`length`（預設）或 `newline`，在依長度分段前先依空白行（段落邊界）分割。

相關的全域選項：

- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）。
- `messages.responsePrefix`。
