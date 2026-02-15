---
summary: "透過 BlueBubbles macOS 伺服器傳送 iMessage（REST 傳送/接收、輸入狀態、心情回覆、配對、進階動作）。"
read_when:
  - 設定 BlueBubbles 頻道
  - 排除 Webhook 配對問題
  - 在 macOS 上設定 iMessage
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

狀態：內建外掛程式，透過 HTTP 與 BlueBubbles macOS 伺服器溝通。**推薦用於 iMessage 整合**，因為與舊版的 imsg 頻道相比，它提供更豐富的 API 且設定更容易。

## 總覽

- 透過 BlueBubbles 輔助應用程式 ([bluebubbles.app](https://bluebubbles.app)) 在 macOS 上執行。
- 推薦/測試環境：macOS Sequoia (15)。macOS Tahoe (26) 可運作；目前 Tahoe 上的編輯功能已損壞，群組圖示更新可能回報成功但未同步。
- OpenClaw 透過其 REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`) 與之溝通。
- 傳入訊息透過 Webhooks 抵達；傳出回覆、輸入狀態指示器、已讀標記和心情回覆（tapbacks）皆為 REST 呼叫。
- 附件與貼圖會作為傳入媒體處理（並盡可能呈現給智慧代理）。
- 配對/允許列表（allowlist）的工作方式與其他頻道相同（`/channels/pairing` 等），使用 `channels.bluebubbles.allowFrom` + 配對碼。
- 心情回覆會像 Slack/Telegram 一樣呈現為系統事件，以便智慧代理在回覆前能「提到」它們。
- 進階功能：編輯、收回、回覆串、訊息效果、群組管理。

## 快速開始

1. 在您的 Mac 上安裝 BlueBubbles 伺服器（請遵循 [bluebubbles.app/install](https://bluebubbles.app/install) 的說明）。
2. 在 BlueBubbles 設定中，啟用 Web API 並設定密碼。
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

4. 將 BlueBubbles Webhooks 指向您的 Gateway（例如：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）。
5. 啟動 Gateway；它將註冊 Webhook 處理常式並開始配對。

## 保持 Messages.app 運作 (虛擬機器 / 無頭設定)

某些 macOS 虛擬機器 / 恆亮設定可能會導致 Messages.app 進入「閒置」狀態（傳入事件停止，直到應用程式被開啟/置於前景）。一個簡單的解決方法是使用 AppleScript + LaunchAgent **每 5 分鐘撥動一下 Messages**。

### 1) 儲存 AppleScript

將其儲存為：

- `~/Scripts/poke-messages.scpt`

範例指令碼（非互動式；不會搶奪焦點）：

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

### 2) 安裝 LaunchAgent

將其儲存為：

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

- 這會**每 300 秒**以及**登入時**執行。
- 首次執行可能會觸發 macOS **自動化**提示（`osascript` → Messages）。請在執行 LaunchAgent 的相同使用者工作階段中核准。

載入它：

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## 新手導覽

BlueBubbles 可以在互動式設定精靈中使用：

```
openclaw onboard
```

精靈會提示：

- **伺服器 URL** (必要)：BlueBubbles 伺服器位址 (例如 `http://192.168.1.100:1234`)
- **密碼** (必要)：BlueBubbles 伺服器設定中的 API 密碼
- **Webhook 路徑** (選填)：預設為 `/bluebubbles-webhook`
- **私訊政策**：配對 (pairing)、允許列表 (allowlist)、開放 (open) 或停用 (disabled)
- **允許列表**：電話號碼、電子郵件或聊天目標

您也可以透過 CLI 新增 BlueBubbles：

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## 存取控制 (私訊 + 群組)

私訊：

- 預設：`channels.bluebubbles.dmPolicy = "pairing"`。
- 未知傳送者會收到配對碼；訊息將被忽略直到通過核准（配對碼 1 小時後過期）。
- 透過以下方式核准：
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- 配對是預設的權杖交換方式。詳情請參閱：[配對](/channels/pairing)

群組：

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (預設：`allowlist`)。
- 當設定為 `allowlist` 時，`channels.bluebubbles.groupAllowFrom` 可控制誰能在群組中觸發。

### 標註門檻 (群組)

BlueBubbles 支援群組聊天的標註門檻，符合 iMessage/WhatsApp 的行為：

- 使用 `agents.list[].groupChat.mentionPatterns` (或 `messages.groupChat.mentionPatterns`) 來偵測標註。
- 當群組啟用 `requireMention` 時，智慧代理僅在被標註時才會回覆。
- 來自授權傳送者的控制指令會繞過標註門檻。

個別群組設定：

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // 所有群組的預設值
        "iMessage;-;chat123": { requireMention: false }, // 特定群組的覆寫設定
      },
    },
  },
}
```

### 指令門檻

- 控制指令 (例如 `/config`, `/model`) 需要授權。
- 使用 `allowFrom` 與 `groupAllowFrom` 來判斷指令授權。
- 授權傳送者即使在群組中沒有標註也能執行控制指令。

## 輸入狀態 + 已讀標記

- **輸入狀態指示器**：在產生回覆之前及期間自動傳送。
- **已讀標記**：由 `channels.bluebubbles.sendReadReceipts` 控制 (預設：`true`)。
- **輸入狀態指示器**：OpenClaw 傳送開始輸入事件；BlueBubbles 在傳送或逾時後自動清除輸入狀態 (透過 DELETE 手動停止並不穩定)。

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // 停用已讀標記
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
        reactions: true, // 心情回覆 (預設: true)
        edit: true, // 編輯已傳送訊息 (macOS 13+, 在 macOS 26 Tahoe 已損壞)
        unsend: true, // 收回訊息 (macOS 13+)
        reply: true, // 透過訊息 GUID 建立回覆串
        sendWithEffect: true, // 訊息效果 (震撼、大聲等)
        renameGroup: true, // 重新命名群組聊天
        setGroupIcon: true, // 設定群組聊天圖示/照片 (在 macOS 26 Tahoe 上不穩定)
        addParticipant: true, // 將成員加入群組
        removeParticipant: true, // 將成員從群組移除
        leaveGroup: true, // 退出群組聊天
        sendAttachment: true, // 傳送附件/媒體
      },
    },
  },
}
```

可用動作：

- **react**：新增/移除心情回覆 (`messageId`, `emoji`, `remove`)
- **edit**：編輯已傳送的訊息 (`messageId`, `text`)
- **unsend**：收回訊息 (`messageId`)
- **reply**：回覆特定訊息 (`messageId`, `text`, `to`)
- **sendWithEffect**：傳送 iMessage 效果 (`text`, `to`, `effectId`)
- **renameGroup**：重新命名群組聊天 (`chatGuid`, `displayName`)
- **setGroupIcon**：設定群組聊天的圖示/照片 (`chatGuid`, `media`) — 在 macOS 26 Tahoe 上不穩定 (API 可能傳回成功但圖示未同步)。
- **addParticipant**：將成員加入群組 (`chatGuid`, `address`)
- **removeParticipant**：將成員從群組移除 (`chatGuid`, `address`)
- **leaveGroup**：退出群組聊天 (`chatGuid`)
- **sendAttachment**：傳送媒體/檔案 (`to`, `buffer`, `filename`, `asVoice`)
  - 語音訊息：設定 `asVoice: true` 並使用 **MP3** 或 **CAF** 音訊來以 iMessage 語音訊息格式傳送。BlueBubbles 會在傳送語音訊息時將 MP3 轉換為 CAF。

### 訊息 ID (短 ID 與完整 ID)

OpenClaw 可能會呈現「短」訊息 ID (例如 `1`, `2`) 以節省權杖。

- `MessageSid` / `ReplyToId` 可以是短 ID。
- `MessageSidFull` / `ReplyToIdFull` 包含供應商的完整 ID。
- 短 ID 儲存在記憶體中；在重新啟動或快取清除時可能會過期。
- 動作接受短 ID 或完整 ID 的 `messageId`，但如果短 ID 不再可用，則會出錯。

對於持久的自動化與儲存，請使用完整 ID：

- 範本：`{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- 上下文：傳入酬載中的 `MessageSidFull` / `ReplyToIdFull`

範本變數請參閱 [設定](/gateway/configuration)。

## 區塊串流傳輸

控制回覆是以單一訊息傳送，還是以區塊方式進行串流傳輸：

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // 啟用區塊串流傳輸 (預設關閉)
    },
  },
}
```

## 媒體 + 限制

- 傳入附件會被下載並儲存在媒體快取中。
- 媒體上限透過 `channels.bluebubbles.mediaMaxMb` 設定 (預設：8 MB)。
- 傳出文字會根據 `channels.bluebubbles.textChunkLimit` 進行分段 (預設：4000 字元)。

## 設定參考

完整設定：[設定](/gateway/configuration)

供應商選項：

- `channels.bluebubbles.enabled`：啟用/停用頻道。
- `channels.bluebubbles.serverUrl`：BlueBubbles REST API 基礎 URL。
- `channels.bluebubbles.password`：API 密碼。
- `channels.bluebubbles.webhookPath`：Webhook 端點路徑 (預設：`/bluebubbles-webhook`)。
- `channels.bluebubbles.dmPolicy`：`pairing | allowlist | open | disabled` (預設：`pairing`)。
- `channels.bluebubbles.allowFrom`：私訊允許列表 (帳號、電子郵件、E.164 號碼、`chat_id:*`、`chat_guid:*`)。
- `channels.bluebubbles.groupPolicy`：`open | allowlist | disabled` (預設：`allowlist`)。
- `channels.bluebubbles.groupAllowFrom`：群組傳送者允許列表。
- `channels.bluebubbles.groups`：個別群組設定 (`requireMention` 等)。
- `channels.bluebubbles.sendReadReceipts`：傳送已讀標記 (預設：`true`)。
- `channels.bluebubbles.blockStreaming`：啟用區塊串流傳輸 (預設：`false`；回覆串流傳輸所需)。
- `channels.bluebubbles.textChunkLimit`：傳出分段大小 (字元，預設：4000)。
- `channels.bluebubbles.chunkMode`：`length` (預設) 僅在超過 `textChunkLimit` 時分割；`newline` 在長度分段前先在空白行 (段落邊界) 處分割。
- `channels.bluebubbles.mediaMaxMb`：傳入媒體上限 (MB，預設：8)。
- `channels.bluebubbles.historyLimit`：用於上下文的群組訊息數量上限 (0 表示停用)。
- `channels.bluebubbles.dmHistoryLimit`：私訊歷史限制。
- `channels.bluebubbles.actions`：啟用/停用特定動作。
- `channels.bluebubbles.accounts`：多帳號設定。

相關全域選項：

- `agents.list[].groupChat.mentionPatterns` (或 `messages.groupChat.mentionPatterns`)。
- `messages.responsePrefix`。

## 定址 / 遞送目標

偏好使用 `chat_guid` 以獲得穩定的路由：

- `chat_guid:iMessage;-;+15555550123` (群組首選)
- `chat_id:123`
- `chat_identifier:...`
- 直接帳號：`+15555550123`, `user @example.com`
  - 如果直接帳號尚無既存的私訊聊天，OpenClaw 會透過 `POST /api/v1/chat/new` 建立一個。這需要啟用 BlueBubbles Private API。

## 安全性

- Webhook 請求透過比較 `guid`/`password` 查詢參數或標頭與 `channels.bluebubbles.password` 來進行身分驗證。來自 `localhost` 的請求也會被接受。
- 請妥善保管 API 密碼與 Webhook 端點金鑰 (將其視為憑證)。
- Localhost 信任意味著同主機的反向代理可能會無意中繞過密碼。如果您代理 Gateway，請在代理伺服器要求驗證並設定 `gateway.trustedProxies`。參閱 [Gateway 安全性](/gateway/security#reverse-proxy-configuration)。
- 如果在區域網路 (LAN) 之外公開 BlueBubbles 伺服器，請啟用 HTTPS + 防火牆規則。

## 疑難排解

- If typing/read events stop working, check the BlueBubbles webhook logs and verify the gateway path matches `channels.bluebubbles.webhookPath`.
- 配對碼在一小時後過期；使用 `openclaw pairing list bluebubbles` 和 `openclaw pairing approve bluebubbles <code>`。
- 心情回覆需要 BlueBubbles Private API (`POST /api/v1/message/react`)；請確保伺服器版本支援。
- 編輯/收回功能需要 macOS 13+ 與相容的 BlueBubbles 伺服器版本。在 macOS 26 (Tahoe) 上，由於 Private API 的變更，編輯功能目前已損壞。
- 群組圖示更新在 macOS 26 (Tahoe) 上可能不穩定：API 可能傳回成功但新圖示未同步。
- OpenClaw 會根據 BlueBubbles 伺服器的 macOS 版本自動隱藏已知的損壞動作。如果編輯功能仍出現在 macOS 26 (Tahoe) 上，請手動透過 `channels.bluebubbles.actions.edit=false` 停用。
- 查看狀態/健康資訊：`openclaw status --all` 或 `openclaw status --deep`。

關於一般頻道工作流程參考，請參閱 [頻道](/channels) 與 [外掛程式](/tools/plugin) 指南。
