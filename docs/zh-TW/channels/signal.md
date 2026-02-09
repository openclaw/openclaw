---
summary: "透過 signal-cli（JSON-RPC + SSE）的 Signal 支援、設定與號碼模型"
read_when:
  - 設定 Signal 支援
  - 偵錯 Signal 傳送／接收
title: "Signal"
---

# Signal（signal-cli）

3. 狀態：外部 CLI 整合。 狀態：外部 CLI 整合。Gateway 透過 HTTP JSON-RPC + SSE 與 `signal-cli` 溝通。

## 快速設定（初學者）

1. 4. 為機器人使用**獨立的 Signal 號碼**（建議）。
2. 安裝 `signal-cli`（需要 Java）。
3. 5. 連結機器人裝置並啟動守護程式：
   - `signal-cli link -n "OpenClaw"`
4. 設定 OpenClaw 並啟動 Gateway 閘道器。

最小設定：

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

## 這是什麼

- 透過 `signal-cli` 的 Signal 頻道（非內嵌 libsignal）。
- 確定性路由：回覆一律回到 Signal。
- 私訊（DMs）共用代理程式的主要工作階段；群組彼此隔離（`agent:<agentId>:signal:group:<groupId>`）。

## 設定寫入

預設允許 Signal 寫入由 `/config set|unset` 觸發的設定更新（需要 `commands.config: true`）。

停用方式：

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## 號碼模型（重要）

- Gateway 連線到 **Signal 裝置**（`signal-cli` 帳戶）。
- 若你在 **個人 Signal 帳戶** 上執行機器人，會忽略你自己的訊息（迴圈保護）。
- 6. 若是「我傳訊給機器人，它就回覆」，請使用**獨立的機器人號碼**。

## 設定（快速路徑）

1. 安裝 `signal-cli`（需要 Java）。
2. 7. 連結機器人帳號：
   - `signal-cli link -n "OpenClaw"`，然後在 Signal 掃描 QR。
3. 設定 Signal 並啟動 Gateway 閘道器。

範例：

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

多帳戶支援：使用 `channels.signal.accounts`，搭配每帳戶設定與可選的 `name`。共享模式請見 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)。 8. 共享模式請參閱 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)。

## 外部常駐模式（httpUrl）

若你希望自行管理 `signal-cli`（JVM 冷啟動較慢、容器初始化，或共用 CPU），可將常駐程式獨立執行，並讓 OpenClaw 指向它：

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

9. 這會略過自動產生（auto-spawn）以及 OpenClaw 內的啟動等待。 這會略過 OpenClaw 內的自動啟動與啟動等待。若自動啟動時很慢，請設定 `channels.signal.startupTimeoutMs`。

## 存取控制（私訊 + 群組）

私訊（DMs）：

- 預設：`channels.signal.dmPolicy = "pairing"`。
- 未知寄件者會收到配對碼；在核准前會忽略訊息（配對碼 1 小時後到期）。
- 10. 透過以下方式核准：
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- 11. 配對是 Signal 私訊的預設權杖交換方式。 12. 詳細說明：[Pairing](/channels/pairing)
- 僅 UUID 的寄件者（來自 `sourceUuid`）會以 `uuid:<id>` 儲存在 `channels.signal.allowFrom` 中。

群組：

- `channels.signal.groupPolicy = open | allowlist | disabled`。
- 當設定 `allowlist` 時，`channels.signal.groupAllowFrom` 會控制群組中哪些人可以觸發。

## 運作方式（行為）

- `signal-cli` 以常駐程式執行；Gateway 透過 SSE 讀取事件。
- 13. 傳入訊息會被正規化為共用的頻道封裝格式。
- 回覆一律回到相同的號碼或群組。

## 媒體 + 限制

- 出站文字會分段為 `channels.signal.textChunkLimit`（預設 4000）。
- 可選的換行分段：設定 `channels.signal.chunkMode="newline"`，在長度分段前先依空白行（段落邊界）分割。
- 支援附件（從 `signal-cli` 取得的 base64）。
- 預設媒體上限：`channels.signal.mediaMaxMb`（預設 8）。
- 使用 `channels.signal.ignoreAttachments` 以略過下載媒體。
- 群組歷史脈絡使用 `channels.signal.historyLimit`（或 `channels.signal.accounts.*.historyLimit`），並回退到 `messages.groupChat.historyLimit`。設定 `0` 可停用（預設 50）。 14. 設為 `0` 以停用（預設為 50）。

## 15. 輸入中 + 已讀回條

- **輸入中指示**：OpenClaw 透過 `signal-cli sendTyping` 傳送輸入中訊號，並在回覆執行期間持續刷新。
- **已讀回條**：當 `channels.signal.sendReadReceipts` 為 true 時，OpenClaw 會轉送允許之私訊的已讀回條。
- signal-cli 不提供群組的已讀回條。

## 反應（訊息工具）

- 使用 `message action=react` 搭配 `channel=signal`。
- 目標：寄件者的 E.164 或 UUID（使用配對輸出中的 `uuid:<id>`；僅 UUID 也可）。
- `messageId` 是你要回應之訊息的 Signal 時間戳。
- 群組反應需要 `targetAuthor` 或 `targetAuthorUuid`。

範例：

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

設定：

- `channels.signal.actions.reactions`：啟用／停用反應動作（預設 true）。
- `channels.signal.reactionLevel`：`off | ack | minimal | extensive`。
  - `off`/`ack` 會停用代理程式反應（訊息工具 `react` 會回傳錯誤）。
  - 16. `minimal`/`extensive` 會啟用代理反應並設定指引層級。
- 每帳戶覆寫：`channels.signal.accounts.<id>.actions.reactions`、`channels.signal.accounts.<id>.reactionLevel`。

## 投遞目標（CLI／cron）

- 私訊（DMs）：`signal:+15551234567`（或純 E.164）。
- UUID 私訊：`uuid:<id>`（或僅 UUID）。
- 群組：`signal:group:<groupId>`。
- 使用者名稱：`username:<name>`（若你的 Signal 帳戶支援）。

## 17. 疑難排解

先依序執行此檢查階梯：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

18. 然後在需要時確認私訊配對狀態：

```bash
openclaw pairing list signal
```

常見失敗：

- 19. 守護程式可連線但沒有回覆：請驗證帳號/守護程式設定（`httpUrl`、`account`）以及接收模式。
- 20. 私訊被忽略：寄件者仍在等待配對核准。
- 群組訊息被忽略：群組寄件者／提及的閘控阻擋了投遞。

分流流程請見：[/channels/troubleshooting](/channels/troubleshooting)。

## 設定參考（Signal）

完整設定：[設定](/gateway/configuration)

提供者選項：

- `channels.signal.enabled`：啟用／停用頻道啟動。
- `channels.signal.account`：機器人帳戶的 E.164。
- `channels.signal.cliPath`：`signal-cli` 的路徑。
- `channels.signal.httpUrl`：完整的常駐程式 URL（覆寫主機／連接埠）。
- `channels.signal.httpHost`、`channels.signal.httpPort`：常駐程式綁定（預設 127.0.0.1:8080）。
- `channels.signal.autoStart`：自動啟動常駐程式（若 `httpUrl` 未設定，預設 true）。
- `channels.signal.startupTimeoutMs`：啟動等待逾時（毫秒，上限 120000）。
- `channels.signal.receiveMode`：`on-start | manual`。
- `channels.signal.ignoreAttachments`：略過附件下載。
- 21. `channels.signal.ignoreStories`：忽略來自守護程式的限時動態。
- `channels.signal.sendReadReceipts`：轉送已讀回條。
- `channels.signal.dmPolicy`：`pairing | allowlist | open | disabled`（預設：配對）。
- `channels.signal.allowFrom`：私訊允許清單（E.164 或 `uuid:<id>`）。`open` 需要 `"*"`。Signal 沒有使用者名稱；請使用電話／UUID 識別。 22. `open` 需要使用 `"*"`。 23. Signal 沒有使用者名稱；請使用電話/UUID 識別碼。
- `channels.signal.groupPolicy`：`open | allowlist | disabled`（預設：允許清單）。
- `channels.signal.groupAllowFrom`：群組寄件者允許清單。
- `channels.signal.historyLimit`：作為脈絡包含的群組訊息上限（0 代表停用）。
- 24. `channels.signal.dmHistoryLimit`：以使用者回合計算的私訊歷史上限。 `channels.signal.dmHistoryLimit`：私訊歷史上限（以使用者回合計）。每使用者覆寫：`channels.signal.dms["<phone_or_uuid>"].historyLimit`。
- `channels.signal.textChunkLimit`：出站分段大小（字元）。
- `channels.signal.chunkMode`：`length`（預設）或 `newline`，在長度分段前先依空白行（段落邊界）分割。
- `channels.signal.mediaMaxMb`：進站／出站媒體上限（MB）。

25. 相關的全域選項：

- `agents.list[].groupChat.mentionPatterns`（Signal 不支援原生提及）。
- `messages.groupChat.mentionPatterns`（全域回退）。
- `messages.responsePrefix`。
