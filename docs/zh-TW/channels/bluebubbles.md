---
summary: "透過 BlueBubbles macOS 伺服器進行 iMessage (REST 傳送/接收、打字、反應、配對、進階動作)。"
read_when:
  - 設定 BlueBubbles 頻道
  - 疑難排解 webhook 配對
  - 在 macOS 上設定 iMessage
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

狀態：內建外掛程式，透過 HTTP 與 BlueBubbles macOS 伺服器通訊。由於其更豐富的 API 和比舊版 imsg 頻道更容易設定，**建議用於 iMessage 整合**。

## 總覽

- 透過 BlueBubbles 輔助應用程式 ([bluebubbles.app](https://bluebubbles.app)) 在 macOS 上執行。
- 建議/已測試：macOS Sequoia (15)。macOS Tahoe (26) 可運作；編輯功能目前在 Tahoe 上已損壞，群組圖示更新可能會回報成功但不同步。
- OpenClaw 透過其 REST API 與其通訊 (`GET /api/v1/ping`、`POST /message/text`、`POST /chat/:id/*`)。
- 傳入訊息透過 webhooks 到達；傳出回覆、打字指標、已讀回執和 Tapback 都是 REST 呼叫。
- 附件和貼圖會作為傳入媒體被擷取（並在可能的情況下顯示給智慧代理）。
- 配對/允許清單的工作方式與其他頻道相同 (`/channels/pairing` 等) 搭配 `channels.bluebubbles.allowFrom` + 配對碼。
- 反應會像 Slack/Telegram 一樣顯示為系統事件，因此智慧代理可以在回覆前「提及」它們。
- 進階功能：編輯、取消傳送、回覆串、訊息效果、群組管理。

## 快速開始

1. 在您的 Mac 上安裝 BlueBubbles 伺服器（請參閱 [bluebubbles.app/install](https://bluebubbles.app/install) 上的說明）。
2. 在 BlueBubbles 設定中，啟用 web API 並設定一個密碼。
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

4. 將 BlueBubbles webhooks 指向您的 Gateway（範例：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）。
5. 啟動 Gateway；它將註冊 webhook 處理常式並開始配對。

## 保持 Messages.app 活躍（VM / 無頭設定）

某些 macOS VM / 始終啟動的設定可能會導致 Messages.app 進入「閒置」狀態（在應用程式開啟/前置之前，傳入事件停止）。一個簡單的解決方法是使用 AppleScript + LaunchAgent **每 5 分鐘觸發一次 Messages**。

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

- 這會**每 300 秒**和**登入時**執行。
- 首次執行可能會觸發 macOS **自動化**提示 (`osascript` → Messages)。請在執行 LaunchAgent 的相同使用者工作階段中核准它們。

載入它：

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## 新手導覽

BlueBubbles 可在互動式設定精靈中使用：

```
openclaw onboard
```

精靈會提示：

- **伺服器 URL**（必填）：BlueBubbles 伺服器位址（例如，`http://192.168.1.100:1234`）
- **密碼**（必填）：BlueBubbles 伺服器設定中的 API 密碼
- **Webhook 路徑**（選填）：預設為 `/bluebubbles-webhook`
- **私訊政策**：配對、允許清單、開放或停用
- **允許清單**：電話號碼、電子郵件或聊天目標

您也可以透過 CLI 新增 BlueBubbles：

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## 存取控制（私訊 + 群組）

私訊：

- 預設：`channels.bluebubbles.dmPolicy = "pairing"`。
- 未知寄件者會收到配對碼；在核准之前，訊息會被忽略（配對碼會在 1 小時後過期）。
- 透過以下方式核准：
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- 配對是預設的權杖交換。詳情：[配對](/channels/pairing)

群組：

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled`（預設：`allowlist`）。
- `channels.bluebubbles.groupAllowFrom` 控制當設定為 `allowlist` 時，誰可以在群組中觸發。

### 提及控管（群組）

BlueBubbles 支援群組聊天的提及控管，與 iMessage/WhatsApp 的行為相符：

- 使用 `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）來偵測提及。
- 當群組啟用 `requireMention` 時，智慧代理只會在被提及時回應。
- 來自授權寄件者的控制命令會繞過提及控管。

每群組設定：

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // 所有群組的預設值
        "iMessage;-;chat123": { requireMention: false }, // 特定群組的覆寫值
      },
    },
  },
}
```

### 命令控管

- 控制命令（例如，`/config`、`/model`）需要授權。
- 使用 `allowFrom` 和 `groupAllowFrom` 來判斷命令授權。
- 即使在群組中沒有提及，授權寄件者也可以執行控制命令。

## 打字 + 已讀回執

- **打字指標**：在回應產生之前和期間自動傳送。
- **已讀回執**：由 `channels.bluebubbles.sendReadReceipts` 控制（預設：`true`）。
- **打字指標**：OpenClaw 傳送打字開始事件；BlueBubbles 在傳送或逾時時自動清除打字（透過 DELETE 手動停止是不可靠的）。

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // 停用已讀回執
    },
  },
}
```

## 進階動作

BlueBubbles 在設定中啟用時支援進階訊息動作：

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (預設：true)
        edit: true, // 編輯已傳送訊息 (macOS 13+, 在 macOS 26 Tahoe 上損壞)
        unsend: true, // 取消傳送訊息 (macOS 13+)
        reply: true, // 依據訊息 GUID 回覆串
        sendWithEffect: true, // 訊息效果 (slam, loud 等)
        renameGroup: true, // 重新命名群組聊天
        setGroupIcon: true, // 設定群組聊天圖示/照片 (在 macOS 26 Tahoe 上不穩定)
        addParticipant: true, // 將參與者新增至群組
        removeParticipant: true, // 將參與者從群組中移除
        leaveGroup: true, // 離開群組聊天
        sendAttachment: true, // 傳送附件/媒體
      },
    },
  },
}
```

可用動作：

- **react**：新增/移除 Tapback 反應（`messageId`、`emoji`、`remove`）
- **edit**：編輯已傳送訊息（`messageId`、`text`）
- **unsend**：取消傳送訊息（`messageId`）
- **reply**：回覆特定訊息（`messageId`、`text`、`to`）
- **sendWithEffect**：傳送 iMessage 效果（`text`、`to`、`effectId`）
- **renameGroup**：重新命名群組聊天（`chatGuid`、`displayName`）
- **setGroupIcon**：設定群組聊天的圖示/照片（`chatGuid`、`media`）— 在 macOS 26 Tahoe 上不穩定（API 可能回傳成功但圖示不同步）。
- **addParticipant**：將某人新增至群組（`chatGuid`、`address`）
- **removeParticipant**：將某人從群組中移除（`chatGuid`、`address`）
- **leaveGroup**：離開群組聊天（`chatGuid`）
- **sendAttachment**：傳送媒體/檔案（`to`、`buffer`、`filename`、`asVoice`）
  - 語音備忘錄：設定 `asVoice: true` 與 **MP3** 或 **CAF** 音訊，以 iMessage 語音訊息傳送。BlueBubbles 會在傳送語音備忘錄時將 MP3 轉換為 CAF。

### 訊息 ID（短版 vs 完整版）

OpenClaw 可能會顯示_短版_訊息 ID（例如，`1`、`2`）以節省權杖。

- `MessageSid` / `ReplyToId` 可以是短版 ID。
- `MessageSidFull` / `ReplyToIdFull` 包含供應商的完整 ID。
- 短版 ID 是記憶體內的；它們可能會在重新啟動或快取清除時過期。
- 動作接受短版或完整版 `messageId`，但如果短版 ID 不再可用，則會出錯。

使用完整版 ID 進行持久性自動化和儲存：

- 範本：`{{MessageSidFull}}`、`{{ReplyToIdFull}}`
- 背景資訊：傳入酬載中的 `MessageSidFull` / `ReplyToIdFull`

請參閱 [設定](/gateway/configuration) 了解範本變數。

## 區塊串流傳輸

控制回應是作為單一訊息傳送還是以區塊串流傳輸：

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // 啟用區塊串流傳輸（預設關閉）
    },
  },
}
```

## 媒體 + 限制

- 傳入附件會被下載並儲存在媒體快取中。
- 媒體上限透過 `channels.bluebubbles.mediaMaxMb` 設定（預設：8 MB）。
- 傳出文字會分割成 `channels.bluebubbles.textChunkLimit`（預設：4000 字元）。

## 設定參考

完整設定：[設定](/gateway/configuration)

供應商選項：

- `channels.bluebubbles.enabled`：啟用/停用頻道。
- `channels.bluebubbles.serverUrl`：BlueBubbles REST API 基礎 URL。
- `channels.bluebubbles.password`：API 密碼。
- `channels.bluebubbles.webhookPath`：Webhook 端點路徑（預設：`/bluebubbles-webhook`）。
- `channels.bluebubbles.dmPolicy`：`pairing | allowlist | open | disabled`（預設：`pairing`）。
- `channels.bluebubbles.allowFrom`：私訊允許清單（處理常式、電子郵件、E.164 號碼、`chat_id:*`、`chat_guid:*`）。
- `channels.bluebubbles.groupPolicy`：`open | allowlist | disabled`（預設：`allowlist`）。
- `channels.bluebubbles.groupAllowFrom`：群組寄件者允許清單。
- `channels.bluebubbles.groups`：每群組設定（`requireMention` 等）。
- `channels.bluebubbles.sendReadReceipts`：傳送已讀回執（預設：`true`）。
- `channels.bluebubbles.blockStreaming`：啟用區塊串流傳輸（預設：`false`；回覆串流的必要條件）。
- `channels.bluebubbles.textChunkLimit`：傳出區塊大小（字元）（預設：4000）。
- `channels.bluebubbles.chunkMode`：`length`（預設）僅在超過 `textChunkLimit` 時分割；`newline` 在長度區塊分割之前，於空白行（段落邊界）分割。
- `channels.bluebubbles.mediaMaxMb`：傳入媒體上限（MB）（預設：8）。
- `channels.bluebubbles.historyLimit`：內容的最大群組訊息數量（0 停用）。
- `channels.bluebubbles.dmHistoryLimit`：私訊歷史記錄上限。
- `channels.bluebubbles.actions`：啟用/停用特定動作。
- `channels.bluebubbles.accounts`：多帳戶設定。

相關全域選項：

- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）。
- `messages.responsePrefix`。

## 定址 / 傳遞目標

建議使用 `chat_guid` 進行穩定路由：

- `chat_guid:iMessage;-;+15555550123`（群組首選）
- `chat_id:123`
- `chat_identifier:...`
- 直接處理常式：`+15555550123`、`user@example.com`
  - 如果直接處理常式沒有現有的私訊聊天，OpenClaw 將透過 `POST /api/v1/chat/new` 建立一個。這需要啟用 BlueBubbles Private API。

## 安全性

- Webhook 請求透過比較 `guid`/`password` 查詢參數或標頭與 `channels.bluebubbles.password` 進行驗證。也接受來自 `localhost` 的請求。
- 保持 API 密碼和 webhook 端點秘密（像處理憑證一樣對待它們）。
- Localhost 信任意味著同主機反向代理可能會無意中繞過密碼。如果您代理 Gateway，則要求代理進行身份驗證並設定 `gateway.trustedProxies`。請參閱 [Gateway 安全性](/gateway/security#reverse-proxy-configuration)。
- 如果將 BlueBubbles 伺服器暴露在 LAN 外部，請啟用 HTTPS + 防火牆規則。

## 疑難排解

- 如果打字/已讀事件停止運作，請檢查 BlueBubbles webhook 日誌並驗證 Gateway 路徑是否與 `channels.bluebubbles.webhookPath` 相符。
- 配對碼會在一個小時後過期；請使用 `openclaw pairing list bluebubbles` 和 `openclaw pairing approve bluebubbles <code>`。
- 反應需要 BlueBubbles Private API (`POST /api/v1/message/react`)；請確保伺服器版本公開此 API。
- 編輯/取消傳送需要 macOS 13+ 和相容的 BlueBubbles 伺服器版本。在 macOS 26 (Tahoe) 上，由於 Private API 變更，編輯功能目前已損壞。
- 群組圖示更新在 macOS 26 (Tahoe) 上可能不穩定：API 可能回傳成功但新圖示不同步。
- OpenClaw 會根據 BlueBubbles 伺服器的 macOS 版本自動隱藏已知損壞的動作。如果編輯功能仍然出現在 macOS 26 (Tahoe) 上，請手動停用 `channels.bluebubbles.actions.edit=false`。
- 如需狀態/健康資訊：`openclaw status --all` 或 `openclaw status --deep`。

如需一般頻道工作流程參考，請參閱 [頻道](/channels) 和 [外掛程式](/tools/plugin) 指南。
