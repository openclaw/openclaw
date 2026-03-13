---
summary: >-
  iMessage via BlueBubbles macOS server (REST send/receive, typing, reactions,
  pairing, advanced actions).
read_when:
  - Setting up BlueBubbles channel
  - Troubleshooting webhook pairing
  - Configuring iMessage on macOS
title: BlueBubbles
---

# BlueBubbles (macOS REST)

狀態：打包的插件，通過 HTTP 與 BlueBubbles macOS 伺服器進行通訊。**建議用於 iMessage 整合**，因為它相比於舊版的 imsg 通道擁有更豐富的 API 和更簡單的設置。

## 概述

- 透過 BlueBubbles 助手應用程式在 macOS 上執行 ([bluebubbles.app](https://bluebubbles.app))。
- 推薦/測試版本：macOS Sequoia (15)。macOS Tahoe (26) 可執行；目前在 Tahoe 上編輯功能已損壞，群組圖示更新可能顯示成功但不會同步。
- OpenClaw 透過其 REST API 與之通信 (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`)。
- 進來的訊息透過 webhook 接收；發出的回覆、輸入指示、已讀回執和點擊回應則是 REST 呼叫。
- 附件和貼圖作為進來的媒體被接收（並在可能的情況下顯示給代理）。
- 配對/白名單的運作方式與其他通道相同 (`/channels/pairing` 等) ，使用 `channels.bluebubbles.allowFrom` + 配對碼。
- 回應作為系統事件顯示，就像 Slack/Telegram 一樣，代理可以在回覆之前「提及」它們。
- 進階功能：編輯、撤回、回覆串、訊息效果、群組管理。

## 快速入門

1. 在你的 Mac 上安裝 BlueBubbles 伺服器（請按照 [bluebubbles.app/install](https://bluebubbles.app/install) 的指示進行）。
2. 在 BlueBubbles 設定中，啟用網頁 API 並設置密碼。
3. 執行 `openclaw onboard` 並選擇 BlueBubbles，或手動設定：

```json5
{
  channels: {
    bluebubbles: {
      enabled: true,
      serverUrl: "http://192.168.1.100:1234",
      password: "example-password",
      webhookPath: "/bluebubbles-webhook",
    },
  },
}
```

4. 將 BlueBubbles 的 webhook 指向您的網關（例如：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）。
5. 啟動網關；它將註冊 webhook 處理程序並開始配對。

安全注意事項：

- 始終設定 webhook 密碼。
- Webhook 認證始終是必需的。OpenClaw 會拒絕 BlueBubbles 的 webhook 請求，除非它們包含與 `channels.bluebubbles.password` 相符的密碼/guid（例如 `?password=<password>` 或 `x-password`），無論是回環/代理拓撲。
- 密碼認證在讀取/解析完整的 webhook 主體之前會進行檢查。

## 讓 Messages.app 持續執行（虛擬機 / 無頭設置）

某些 macOS 虛擬機 / 永久開啟的設置可能會導致 Messages.app 進入「閒置」狀態（直到應用程式被打開/置於前景，進來的事件會停止）。一個簡單的解決方法是使用 AppleScript 和 LaunchAgent 每 5 分鐘 **喚醒 Messages**。

### 1) 儲存 AppleScript

[[BLOCK_1]]  
保存為：  
[[INLINE_1]]

`~/Scripts/poke-messages.scpt`

範例腳本（非互動式；不搶奪焦點）：

applescript
try
tell application "Messages"
if not running then
launch
end if

-- 觸碰腳本介面以保持過程的響應性。
set \_chatCount to (count of chats)
end tell
on error
-- 忽略暫時性錯誤（首次執行提示、鎖定的會話等）。
end try

### 2) 安裝 LaunchAgent

請將此儲存為：

`~/Library/LaunchAgents/com.user.poke-messages.plist`

xml

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

<key>ProgramArguments</key>
<array>
<string>/bin/bash</string>
<string>-lc</string>
<string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
</array>

<key>RunAtLoad</key>
<true/>

<key>StartInterval</key>  
 <integer>300</integer>

<key>StandardOutPath</key>
<string>/tmp/poke-messages.log</string>
<key>StandardErrorPath</key>
<string>/tmp/poke-messages.err</string>
</dict>
</plist>

[[BLOCK_1]]

- 這會在 **每 300 秒** 和 **登入時** 執行。
- 第一次執行可能會觸發 macOS 的 **自動化** 提示 (`osascript` → 訊息)。請在執行 LaunchAgent 的同一使用者會話中批准這些提示。

[[BLOCK_1]]

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

BlueBubbles 可在互動式設置精靈中使用：

```
openclaw onboard
```

巫師提示要求：

- **伺服器 URL**（必填）：BlueBubbles 伺服器地址（例如，`http://192.168.1.100:1234`）
- **密碼**（必填）：來自 BlueBubbles 伺服器設定的 API 密碼
- **Webhook 路徑**（選填）：預設為 `/bluebubbles-webhook`
- **DM 政策**：配對、允許清單、開放或禁用
- **允許清單**：電話號碼、電子郵件或聊天目標

您也可以透過 CLI 添加 BlueBubbles：

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## 存取控制 (私訊 + 群組)

DMs:

- 預設: `channels.bluebubbles.dmPolicy = "pairing"`。
- 不明發件人會收到配對碼；在獲得批准之前，訊息將被忽略（碼在 1 小時後過期）。
- 透過以下方式批准：
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- 配對是預設的 token 交換。詳細資訊: [配對](/channels/pairing)

Groups:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (預設值: `allowlist`)。
- `channels.bluebubbles.groupAllowFrom` 控制當 `allowlist` 被設定時，誰可以在群組中觸發。

### 提及限制（群組）

BlueBubbles 支援群組聊天的提及限制，與 iMessage/WhatsApp 的行為相符：

- 使用 `agents.list[].groupChat.mentionPatterns` (或 `messages.groupChat.mentionPatterns`) 來檢測提及。
- 當 `requireMention` 為一個群組啟用時，代理僅在被提及時回應。
- 來自授權發送者的控制命令會繞過提及限制。

每組設定：

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Command gating

- 控制命令（例如 `/config`、`/model`）需要授權。
- 使用 `allowFrom` 和 `groupAllowFrom` 來確定命令授權。
- 授權的發送者即使在群組中未提及也可以執行控制命令。

## 輸入中 + 已讀回執

- **輸入指示器**：在回應生成之前和期間自動發送。
- **已讀回執**：由 `channels.bluebubbles.sendReadReceipts` 控制（預設值：`true`）。
- **輸入指示器**：OpenClaw 發送輸入開始事件；BlueBubbles 在發送或超時時自動清除輸入（透過 DELETE 手動停止不可靠）。

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## 進階操作

BlueBubbles 支援在設定中啟用的進階訊息操作：

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

可用的動作：

- **react**: 添加/移除點擊回應 (`messageId`, `emoji`, `remove`)
- **edit**: 編輯已發送的訊息 (`messageId`, `text`)
- **unsend**: 撤回訊息 (`messageId`)
- **reply**: 回覆特定訊息 (`messageId`, `text`, `to`)
- **sendWithEffect**: 以 iMessage 效果發送 (`text`, `to`, `effectId`)
- **renameGroup**: 重新命名群組聊天 (`chatGuid`, `displayName`)
- **setGroupIcon**: 設定群組聊天的圖示/照片 (`chatGuid`, `media`) — 在 macOS 26 Tahoe 上不穩定 (API 可能返回成功但圖示不會同步)。
- **addParticipant**: 將某人加入群組 (`chatGuid`, `address`)
- **removeParticipant**: 將某人移出群組 (`chatGuid`, `address`)
- **leaveGroup**: 退出群組聊天 (`chatGuid`)
- **sendAttachment**: 發送媒體/檔案 (`to`, `buffer`, `filename`, `asVoice`)
  - 語音備忘錄：設定 `asVoice: true` 為 **MP3** 或 **CAF** 音訊以作為 iMessage 語音訊息發送。BlueBubbles 在發送語音備忘錄時會將 MP3 轉換為 CAF。

### 訊息 ID（簡短 vs 完整）

OpenClaw 可能會顯示 _短_ 訊息 ID（例如，`1`，`2`）以節省 token。

- `MessageSid` / `ReplyToId` 可以是短 ID。
- `MessageSidFull` / `ReplyToIdFull` 包含提供者的完整 ID。
- 短 ID 是存在記憶體中的；它們可能在重啟或快取驅逐時過期。
- 操作接受短或完整的 `messageId`，但如果短 ID 不再可用，則會出現錯誤。

使用完整的 ID 來進行耐用自動化和儲存：

- 模板: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- 上下文: `MessageSidFull` / `ReplyToIdFull` 在入站有效負載中

請參閱 [Configuration](/gateway/configuration) 以了解模板變數。

## Block streaming

控制回應是以單一訊息發送還是以區塊串流發送：

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Media + limits

- 進來的附件會被下載並儲存在媒體快取中。
- 媒體上限透過 `channels.bluebubbles.mediaMaxMb` 設定，適用於進來和出去的媒體（預設：8 MB）。
- 外發的文字會被分塊至 `channels.bluebubbles.textChunkLimit`（預設：4000 字元）。

## 設定參考

完整設定: [Configuration](/gateway/configuration)

Provider options:

- `channels.bluebubbles.enabled`: 啟用/禁用通道。
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API 基本 URL。
- `channels.bluebubbles.password`: API 密碼。
- `channels.bluebubbles.webhookPath`: Webhook 端點路徑（預設: `/bluebubbles-webhook`）。
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled`（預設: `pairing`）。
- `channels.bluebubbles.allowFrom`: DM 允許清單（處理器、電子郵件、E.164 號碼、`chat_id:*`、`chat_guid:*`）。
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled`（預設: `allowlist`）。
- `channels.bluebubbles.groupAllowFrom`: 群組發送者允許清單。
- `channels.bluebubbles.groups`: 每群組設定 (`requireMention` 等)。
- `channels.bluebubbles.sendReadReceipts`: 發送已讀回執（預設: `true`）。
- `channels.bluebubbles.blockStreaming`: 啟用區塊串流（預設: `false`；串流回覆所需）。
- `channels.bluebubbles.textChunkLimit`: 出站字元塊大小（預設: 4000）。
- `channels.bluebubbles.chunkMode`: `length`（預設）僅在超過 `textChunkLimit` 時進行分割；`newline` 在長度分塊之前在空白行（段落邊界）進行分割。
- `channels.bluebubbles.mediaMaxMb`: 入站/出站媒體容量（MB）（預設: 8）。
- `channels.bluebubbles.mediaLocalRoots`: 允許的絕對本地目錄的明確允許清單，用於出站本地媒體路徑。除非設定此項，否則本地路徑發送預設為拒絕。每帳戶覆蓋: `channels.bluebubbles.accounts.<accountId>.mediaLocalRoots`。
- `channels.bluebubbles.historyLimit`: 上下文的最大群組消息數（0 禁用）。
- `channels.bluebubbles.dmHistoryLimit`: DM 歷史限制。
- `channels.bluebubbles.actions`: 啟用/禁用特定操作。
- `channels.bluebubbles.accounts`: 多帳戶設定。

相關的全域選項：

- `agents.list[].groupChat.mentionPatterns` (或 `messages.groupChat.mentionPatterns`)。
- `messages.responsePrefix`。

## 地址 / 交付目標

Prefer `chat_guid` 以獲得穩定的路由：

- `chat_guid:iMessage;-;+15555550123`（適用於群組）
- `chat_id:123`
- `chat_identifier:...`
- 直接處理：`+15555550123`、`user@example.com`
  - 如果直接處理沒有現有的 DM 聊天，OpenClaw 將透過 `POST /api/v1/chat/new` 創建一個。這需要啟用 BlueBubbles 私有 API。

## Security

- Webhook 請求透過比較 `guid`/`password` 查詢參數或標頭與 `channels.bluebubbles.password` 來進行身份驗證。來自 `localhost` 的請求也會被接受。
- 請將 API 密碼和 webhook 端點保密（視為憑證）。
- 本地主機信任意味著同主機的反向代理可能會無意中繞過密碼。如果您代理網關，請在代理上要求身份驗證並設定 `gateway.trustedProxies`。請參閱 [網關安全性](/gateway/security#reverse-proxy-configuration)。
- 如果將 BlueBubbles 伺服器暴露在您的局域網外，請啟用 HTTPS + 防火牆規則。

## 故障排除

- 如果輸入/讀取事件停止運作，請檢查 BlueBubbles webhook 日誌並確認網關路徑與 `channels.bluebubbles.webhookPath` 相符。
- 配對碼在一小時後過期；使用 `openclaw pairing list bluebubbles` 和 `openclaw pairing approve bluebubbles <code>`。
- 反應需要 BlueBubbles 私有 API (`POST /api/v1/message/react`)；確保伺服器版本已公開此 API。
- 編輯/撤回需要 macOS 13 以上版本及相容的 BlueBubbles 伺服器版本。在 macOS 26 (Tahoe) 上，由於私有 API 的變更，編輯功能目前無法使用。
- 在 macOS 26 (Tahoe) 上，群組圖示更新可能不穩定：API 可能返回成功，但新圖示不會同步。
- OpenClaw 會根據 BlueBubbles 伺服器的 macOS 版本自動隱藏已知的故障操作。如果在 macOS 26 (Tahoe) 上仍然顯示編輯功能，請手動使用 `channels.bluebubbles.actions.edit=false` 禁用它。
- 有關狀態/健康資訊：`openclaw status --all` 或 `openclaw status --deep`。

有關一般頻道工作流程的參考，請參閱 [Channels](/channels) 和 [Plugins](/tools/plugin) 指南。
