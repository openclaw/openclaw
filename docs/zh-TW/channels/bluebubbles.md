---
summary: "透過 BlueBubbles macOS 伺服器的 iMessage（REST 傳送/接收、輸入中、回應、配對、進階動作）。"
read_when:
  - 設定 BlueBubbles 頻道
  - 疑難排解 webhook 配對
  - 在 macOS 上設定 iMessage
title: "BlueBubbles"
---

# BlueBubbles（macOS REST）

Status: bundled plugin that talks to the BlueBubbles macOS server over HTTP. **Recommended for iMessage integration** due to its richer API and easier setup compared to the legacy imsg channel.

## 概覽

- 透過 BlueBubbles 輔助應用程式在 macOS 上執行（[bluebubbles.app](https://bluebubbles.app)）。
- Recommended/tested: macOS Sequoia (15). 建議/測試環境：macOS Sequoia（15）。macOS Tahoe（26）可運作；但目前在 Tahoe 上編輯功能損壞，且群組圖示更新可能回報成功但不會同步。
- OpenClaw 透過其 REST API 與之通訊（`GET /api/v1/ping`、`POST /message/text`、`POST /chat/:id/*`）。
- Incoming messages arrive via webhooks; outgoing replies, typing indicators, read receipts, and tapbacks are REST calls.
- Attachments and stickers are ingested as inbound media (and surfaced to the agent when possible).
- 配對/允許清單與其他頻道運作方式相同（`/channels/pairing` 等），使用 `channels.bluebubbles.allowFrom` 與配對碼。
- 回應（reactions）會像 Slack/Telegram 一樣以系統事件呈現，讓代理程式在回覆前可以「提及」它們。
- Advanced features: edit, unsend, reply threading, message effects, group management.

## 快速開始

1. 在你的 Mac 上安裝 BlueBubbles 伺服器（依照 [bluebubbles.app/install](https://bluebubbles.app/install) 的指示）。

2. 在 BlueBubbles 設定中啟用 Web API 並設定密碼。

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

4. 將 BlueBubbles webhook 指向你的 Gateway 閘道器（例如：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）。

5. Start the gateway; it will register the webhook handler and start pairing.

## 保持 Messages.app 存活（VM / 無頭設定）

某些 macOS VM／常駐設定可能會讓 Messages.app 進入「閒置」狀態（直到開啟/前景化前，來訊事件會停止）。一個簡單的因應方式是使用 AppleScript + LaunchAgent **每 5 分鐘戳一下 Messages**。 A simple workaround is to **poke Messages every 5 minutes** using an AppleScript + LaunchAgent.

### 1）儲存 AppleScript

Save this as:

- `~/Scripts/poke-messages.scpt`

Example script (non-interactive; does not steal focus):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2）安裝 LaunchAgent

Save this as:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
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
```

注意事項：

- 此設定會**每 300 秒**執行一次，並在**登入時**執行。
- 第一次執行可能會觸發 macOS 的**自動化**提示（`osascript` → Messages）。請在執行該 LaunchAgent 的同一使用者工作階段中核准。 Approve them in the same user session that runs the LaunchAgent.

載入它：

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

BlueBubbles 可在互動式設定精靈中使用：

```
openclaw onboard
```

The wizard prompts for:

- **Server URL**（必填）：BlueBubbles 伺服器位址（例如：`http://192.168.1.100:1234`）
- **Password**（必填）：BlueBubbles Server 設定中的 API 密碼
- **Webhook path**（選填）：預設為 `/bluebubbles-webhook`
- **DM policy**：配對、允許清單、開放或停用
- **Allow list**：電話號碼、電子郵件或聊天目標

你也可以透過 CLI 新增 BlueBubbles：

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## 存取控制（私訊 + 群組）

私訊（DMs）：

- 預設：`channels.bluebubbles.dmPolicy = "pairing"`。
- 未知寄件者會收到配對碼；在核准前訊息會被忽略（配對碼 1 小時後過期）。
- 1. 透過以下方式核准：
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- 2. 配對是預設的權杖交換方式。 3. 詳細資訊：[配對](/channels/pairing)

群組：

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled`（預設：`allowlist`）。
- 當設定 `allowlist` 時，`channels.bluebubbles.groupAllowFrom` 會控制誰能在群組中觸發。

### 提及門檻（群組）

BlueBubbles 支援群組聊天的提及門檻，行為與 iMessage/WhatsApp 相符：

- 使用 `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）來偵測提及。
- 當群組啟用 `requireMention` 時，代理程式只會在被提及時回應。
- 來自已授權寄件者的控制指令會略過提及門檻。

每個群組的設定：

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

### 指令門檻

- 控制指令（例如：`/config`、`/model`）需要授權。
- 使用 `allowFrom` 與 `groupAllowFrom` 判定指令授權。
- 已授權寄件者即使在群組中未被提及，也可執行控制指令。

## 4. 輸入中 + 已讀回條

- **輸入中指示**：在回應產生前與期間自動傳送。
- **已讀回條**：由 `channels.bluebubbles.sendReadReceipts` 控制（預設：`true`）。
- **輸入中指示**：OpenClaw 會送出輸入開始事件；BlueBubbles 會在送出或逾時時自動清除（透過 DELETE 手動停止不可靠）。

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## 進階動作

在設定中啟用後，BlueBubbles 支援進階訊息動作：

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

可用動作：

- **react**：新增/移除點回應（`messageId`、`emoji`、`remove`）
- **edit**：編輯已送出的訊息（`messageId`、`text`）
- **unsend**：收回訊息（`messageId`）
- **reply**：回覆特定訊息（`messageId`、`text`、`to`）
- **sendWithEffect**：使用 iMessage 效果傳送（`text`、`to`、`effectId`）
- **renameGroup**：重新命名群組聊天（`chatGuid`、`displayName`）
- **setGroupIcon**：設定群組聊天的圖示/照片（`chatGuid`、`media`）— 在 macOS 26 Tahoe 上不穩定（API 可能回傳成功但圖示不會同步）。
- **addParticipant**：將成員加入群組（`chatGuid`、`address`）
- **removeParticipant**：從群組移除成員（`chatGuid`、`address`）
- **leaveGroup**：離開群組聊天（`chatGuid`）
- **sendAttachment**：傳送媒體/檔案（`to`、`buffer`、`filename`、`asVoice`）
  - 語音備忘錄：設定 `asVoice: true` 並使用 **MP3** 或 **CAF** 音訊即可作為 iMessage 語音訊息傳送。BlueBubbles 在傳送語音備忘錄時會將 MP3 轉換為 CAF。 5. BlueBubbles 在傳送語音備忘錄時會將 MP3 轉換為 CAF。

### 訊息 ID（短版 vs 完整）

OpenClaw 可能會提供「短版」訊息 ID（例如：`1`、`2`）以節省權杖。

- `MessageSid` / `ReplyToId` 可能是短 ID。
- `MessageSidFull` / `ReplyToIdFull` 包含提供者的完整 ID。
- 短 ID 僅存在於記憶體中；在重新啟動或快取淘汰時可能失效。
- 動作可接受短或完整的 `messageId`，但若短 ID 不再可用將會出錯。

對於需要長期自動化與儲存，請使用完整 ID：

- 範本：`{{MessageSidFull}}`、`{{ReplyToIdFull}}`
- 內容：入站負載中的 `MessageSidFull` / `ReplyToIdFull`

6. 範本變數請參閱 [組態](/gateway/configuration)。

## 7. 封鎖串流

控制回應是以單一訊息傳送，或以區塊方式串流：

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## 媒體 + 限制

- 8. 進站附件會下載並儲存在媒體快取中。
- 媒體上限由 `channels.bluebubbles.mediaMaxMb` 設定（預設：8 MB）。
- 出站文字會分段至 `channels.bluebubbles.textChunkLimit`（預設：4000 字元）。

## 設定參考

完整設定請見：[Configuration](/gateway/configuration)

提供者選項：

- `channels.bluebubbles.enabled`：啟用/停用頻道。
- `channels.bluebubbles.serverUrl`：BlueBubbles REST API 基底 URL。
- `channels.bluebubbles.password`：API 密碼。
- `channels.bluebubbles.webhookPath`：Webhook 端點路徑（預設：`/bluebubbles-webhook`）。
- `channels.bluebubbles.dmPolicy`：`pairing | allowlist | open | disabled`（預設：`pairing`）。
- `channels.bluebubbles.allowFrom`：私訊允許清單（識別碼、電子郵件、E.164 號碼、`chat_id:*`、`chat_guid:*`）。
- `channels.bluebubbles.groupPolicy`：`open | allowlist | disabled`（預設：`allowlist`）。
- `channels.bluebubbles.groupAllowFrom`：群組寄件者允許清單。
- `channels.bluebubbles.groups`：每個群組的設定（`requireMention` 等）。
- `channels.bluebubbles.sendReadReceipts`：傳送已讀回條（預設：`true`）。
- `channels.bluebubbles.blockStreaming`：啟用區塊串流（預設：`false`；串流回覆必須）。
- `channels.bluebubbles.textChunkLimit`：出站分段大小（字元數，預設：4000）。
- `channels.bluebubbles.chunkMode`：`length`（預設）僅在超過 `textChunkLimit` 時才分割；`newline` 會在長度分段前先依空白行（段落邊界）分割。
- `channels.bluebubbles.mediaMaxMb`：入站媒體上限（MB，預設：8）。
- `channels.bluebubbles.historyLimit`：群組訊息作為內容的最大數量（0 代表停用）。
- `channels.bluebubbles.dmHistoryLimit`：私訊歷史上限。
- `channels.bluebubbles.actions`：啟用/停用特定動作。
- `channels.bluebubbles.accounts`：多帳號設定。

9. 相關的全域選項：

- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）。
- `messages.responsePrefix`。

## 定址 / 傳送目標

為了穩定路由，建議使用 `chat_guid`：

- `chat_guid:iMessage;-;+15555550123`（群組優先）
- `chat_id:123`
- `chat_identifier:...`
- 直接識別碼：`+15555550123`、`user@example.com`
  - 10. 如果直接 handle 沒有既有的 DM 聊天，OpenClaw 會透過 `POST /api/v1/chat/new` 建立一個。 11. 這需要啟用 BlueBubbles Private API。

## 安全性

- Webhook 請求會透過比對 `guid`/`password` 查詢參數或標頭與 `channels.bluebubbles.password` 來進行驗證。來自 `localhost` 的請求也會被接受。 12. 也接受來自 `localhost` 的請求。
- 請妥善保管 API 密碼與 webhook 端點（視同憑證）。
- 13. 信任 localhost 表示同一主機上的反向代理可能會在無意間繞過密碼。 14. 若您為 gateway 設定代理，請在代理端要求驗證，並設定 `gateway.trustedProxies`。 15. 請參閱 [Gateway 安全性](/gateway/security#reverse-proxy-configuration)。
- 若將 BlueBubbles 伺服器對外暴露，請啟用 HTTPS 並設定防火牆規則。

## 16. 疑難排解

- 若輸入中/已讀事件停止運作，請檢查 BlueBubbles webhook 記錄，並確認 Gateway 閘道器路徑與 `channels.bluebubbles.webhookPath` 相符。
- 配對碼一小時後過期；請使用 `openclaw pairing list bluebubbles` 與 `openclaw pairing approve bluebubbles <code>`。
- 回應（reactions）需要 BlueBubbles 私有 API（`POST /api/v1/message/react`）；請確認伺服器版本有提供。
- 編輯/收回需要 macOS 13+ 與相容的 BlueBubbles 伺服器版本。在 macOS 26（Tahoe）上，因私有 API 變更，目前編輯功能損壞。 17. 在 macOS 26（Tahoe）上，由於 Private API 變更，編輯功能目前已損壞。
- 在 macOS 26（Tahoe）上，群組圖示更新可能不穩定：API 可能回傳成功但新圖示不會同步。
- OpenClaw 會根據 BlueBubbles 伺服器的 macOS 版本自動隱藏已知損壞的動作。若在 macOS 26（Tahoe）上仍顯示編輯功能，請使用 `channels.bluebubbles.actions.edit=false` 手動停用。 18. 如果在 macOS 26（Tahoe）上仍出現編輯功能，請以 `channels.bluebubbles.actions.edit=false` 手動停用。
- 狀態/健康資訊請見：`openclaw status --all` 或 `openclaw status --deep`。

一般頻道工作流程請參閱 [Channels](/channels) 與 [Plugins](/tools/plugin) 指南。
