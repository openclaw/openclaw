---
summary: "Signal 支援 via signal-cli (JSON-RPC + SSE)、設定路徑與號碼模型"
read_when:
  - 設定 Signal 支援時
  - 偵錯 Signal 傳送/接收時
title: "Signal"
---

# Signal (signal-cli)

狀態：外部 CLI 整合。Gateway 透過 HTTP JSON-RPC + SSE 與 `signal-cli` 通訊。

## 先決條件

- 您的伺服器上已安裝 OpenClaw (以下 Linux 流程已在 Ubuntu 24 上測試)。
- `signal-cli` 存在於 Gateway 運行的主機上。
- 一個可以接收一次驗證簡訊的電話號碼 (用於簡訊註冊路徑)。
- 註冊期間可透過瀏覽器存取 Signal 驗證碼 (`signalcaptchas.org`)。

## 快速設定 (初學者)

1. 為機器人使用 **獨立的 Signal 號碼** (建議)。
2. 安裝 `signal-cli` (如果您使用 JVM 版本，則需要 Java)。
3. 選擇一種設定路徑：
   - **路徑 A (QR 連結)：** `signal-cli link -n "OpenClaw"` 並使用 Signal 掃描。
   - **路徑 B (簡訊註冊)：** 註冊一個專用號碼，並進行驗證碼 + 簡訊驗證。
4. 設定 OpenClaw 並重新啟動 Gateway。
5. 傳送第一個私訊並批准配對 (`openclaw pairing approve signal <CODE>`)。

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

欄位參考：

| 欄位        | 描述                                           |
| ----------- | ---------------------------------------------- |
| `account`   | 機器人電話號碼，採用 E.164 格式 (`+15551234567`) |
| `cliPath`   | `signal-cli` 的路徑 (如果位於 `PATH` 中則為 `signal-cli`) |
| `dmPolicy`  | 私訊存取策略 (建議使用 `pairing`)                |
| `allowFrom` | 允許私訊的電話號碼或 `uuid:<id>` 值              |

## 這是什麼

- 透過 `signal-cli` 的 Signal 頻道 (非內嵌 libsignal)。
- 確定性路由：回覆總是回到 Signal。
- 私訊共享智慧代理的主要工作階段；群組是隔離的 (`agent:<agentId>:signal:group:<groupId>`)。

## 設定寫入

預設情況下，Signal 允許寫入由 `/config set|unset` 觸發的設定更新 (需要 `commands.config: true`)。

透過以下方式停用：

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## 號碼模型 (重要)

- Gateway 連接到 **Signal 裝置** (`signal-cli` 帳號)。
- 如果您在 **您的個人 Signal 帳號** 上運行機器人，它將忽略您自己的訊息 (迴路保護)。
- 對於「我傳訊息給機器人，它會回覆」，請使用 **獨立的機器人號碼**。

## 設定路徑 A：連結現有 Signal 帳號 (QR)

1. 安裝 `signal-cli` (JVM 或原生版本)。
2. 連結機器人帳號：
   - `signal-cli link -n "OpenClaw"` 然後在 Signal 中掃描 QR 碼。
3. 設定 Signal 並啟動 Gateway。

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

多帳號支援：使用 `channels.signal.accounts`，並帶有每個帳號的設定和可選的 `name`。請參閱 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--imessageaccounts) 以了解共用模式。

## 設定路徑 B：註冊專用機器人號碼 (簡訊，Linux)

當您想要一個專用的機器人號碼，而不是連結現有的 Signal 應用程式帳號時，請使用此方式。

1. 取得一個可以接收簡訊的號碼 (或市話的語音驗證)。
   - 使用專用機器人號碼以避免帳號/工作階段衝突。
2. 在 Gateway 主機上安裝 `signal-cli`：

```bash
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
sudo tar xf "signal-cli-${VERSION}-Linux-native.tar.gz" -C /opt
sudo ln -sf /opt/signal-cli /usr/local/bin/
signal-cli --version
```

如果您使用 JVM 版本 (`signal-cli-${VERSION}.tar.gz`)，請先安裝 JRE 25+。
保持 `signal-cli` 更新；上游指出舊版本可能會因 Signal 伺服器 API 變更而損壞。

3. 註冊並驗證號碼：

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register
```

如果需要驗證碼：

1. 開啟 `https://signalcaptchas.org/registration/generate.html`。
2. 完成驗證碼，從「開啟 Signal」複製 `signalcaptcha://...` 連結目標。
3. 盡可能在與瀏覽器工作階段相同的外部 IP 執行。
4. 立即再次執行註冊 (驗證碼令牌會快速過期)：

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register --captcha '<SIGNALCAPTCHA_URL>'
signal-cli -a +<BOT_PHONE_NUMBER> verify <VERIFICATION_CODE>
```

4. 設定 OpenClaw，重新啟動 Gateway，驗證頻道：

```bash
# 如果您將 Gateway 作為使用者 systemd 服務運行：
systemctl --user restart openclaw-gateway

# 然後驗證：
openclaw doctor
openclaw channels status --probe
```

5. 配對您的私訊傳送者：
   - 傳送任何訊息給機器人號碼。
   - 在伺服器上批准代碼：`openclaw pairing approve signal <PAIRING_CODE>`。
   - 將機器人號碼儲存為手機上的聯絡人，以避免「不明聯絡人」。

重要：使用 `signal-cli` 註冊電話號碼帳號可能會使該號碼的主要 Signal 應用程式工作階段解除驗證。建議使用專用機器人號碼，或者如果需要保留現有的手機應用程式設定，請使用 QR 連結模式。

上游參考資料：

- `signal-cli` README：`https://github.com/AsamK/signal-cli`
- 驗證碼流程：`https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha`
- 連結流程：`https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)`

## 外部守護程式模式 (httpUrl)

如果您想自行管理 `signal-cli` (緩慢的 JVM 冷啟動、容器初始化或共享 CPU)，請單獨運行守護程式並將 OpenClaw 指向它：

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

這會跳過 OpenClaw 內部的自動生成和啟動等待。對於自動生成時的緩慢啟動，請設定 `channels.signal.startupTimeoutMs`。

## 存取控制 (私訊 + 群組)

私訊：

- 預設：`channels.signal.dmPolicy = "pairing"`。
- 未知發送者會收到配對代碼；訊息在批准之前將被忽略 (代碼在 1 小時後過期)。
- 透過以下方式批准：
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- 配對是 Signal 私訊的預設令牌交換。詳情：[配對](/channels/pairing)
- 僅限 UUID 的發送者 (來自 `sourceUuid`) 會以 `uuid:<id>` 的形式儲存在 `channels.signal.allowFrom` 中。

群組：

- `channels.signal.groupPolicy = open | allowlist | disabled`。
- 當設定 `allowlist` 時，`channels.signal.groupAllowFrom` 控制誰可以在群組中觸發。

## 運作方式 (行為)

- `signal-cli` 作為守護程式運行；Gateway 透過 SSE 讀取事件。
- 入站訊息被規範化為共享頻道信封。
- 回覆總是路由回相同的號碼或群組。

## 媒體 + 限制

- 出站文字會被分塊為 `channels.signal.textChunkLimit` (預設 4000)。
- 可選換行符分塊：設定 `channels.signal.chunkMode="newline"` 以在長度分塊之前，按空白行 (段落邊界) 分割。
- 支援附件 (從 `signal-cli` 擷取 base64)。
- 預設媒體上限：`channels.signal.mediaMaxMb` (預設 8)。
- 使用 `channels.signal.ignoreAttachments` 跳過媒體下載。
- 群組歷史記錄上下文使用 `channels.signal.historyLimit` (或 `channels.signal.accounts.*.historyLimit`)，回退到 `messages.groupChat.historyLimit`。設定 `0` 以停用 (預設 50)。

## 輸入狀態 + 已讀回條

- **輸入指示器**：OpenClaw 透過 `signal-cli sendTyping` 傳送輸入訊號，並在回覆運行時刷新它們。
- **已讀回條**：當 `channels.signal.sendReadReceipts` 為 true 時，OpenClaw 會轉發允許的私訊的已讀回條。
- Signal-cli 不會公開群組的已讀回條。

## 反應 (訊息工具)

- 使用 `message action=react` 和 `channel=signal`。
- 目標：發送者 E.164 或 UUID (使用配對輸出中的 `uuid:<id>`；單獨的 UUID 也適用)。
- `messageId` 是您要反應的訊息的 Signal 時間戳記。
- 群組反應需要 `targetAuthor` 或 `targetAuthorUuid`。

範例：

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

設定：

- `channels.signal.actions.reactions`：啟用/停用反應動作 (預設 true)。
- `channels.signal.reactionLevel`：`off | ack | minimal | extensive`。
  - `off`/`ack` 停用智慧代理反應 (訊息工具 `react` 將會出錯)。
  - `minimal`/`extensive` 啟用智慧代理反應並設定指導級別。
- 每個帳號的覆寫：`channels.signal.accounts.<id>.actions.reactions`、`channels.signal.accounts.<id>.reactionLevel`。

## 傳遞目標 (CLI/cron)

- 私訊：`signal:+15551234567` (或純 E.164)。
- UUID 私訊：`uuid:<id>` (或純 UUID)。
- 群組：`signal:group:<groupId>`。
- 使用者名稱：`username:<name>` (如果您的 Signal 帳號支援)。

## 疑難排解

請先執行以下步驟：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

然後，如果需要，確認私訊配對狀態：

```bash
openclaw pairing list signal
```

常見故障：

- 守護程式可達但沒有回覆：驗證帳號/守護程式設定 (`httpUrl`、`account`) 和接收模式。
- 私訊被忽略：發送者正在等待配對批准。
- 群組訊息被忽略：群組發送者/提及門控阻止傳遞。
- 編輯後設定驗證錯誤：運行 `openclaw doctor --fix`。
- 診斷中缺少 Signal：確認 `channels.signal.enabled: true`。

額外檢查：

```bash
openclaw pairing list signal
pgrep -af signal-cli
grep -i "signal" "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | tail -20
```

有關分類流程：[/channels/troubleshooting](/channels/troubleshooting)。

## 安全性注意事項

- `signal-cli` 在本地儲存帳號金鑰 (通常位於 `~/.local/share/signal-cli/data/`)。
- 在伺服器遷移或重建之前，備份 Signal 帳號狀態。
- 保持 `channels.signal.dmPolicy: "pairing"`，除非您明確需要更廣泛的私訊存取。
- 簡訊驗證僅用於註冊或恢復流程，但失去對號碼/帳號的控制可能會使重新註冊變得複雜。

## 設定參考 (Signal)

完整設定：[Configuration](/gateway/configuration)

供應商選項：

- `channels.signal.enabled`：啟用/停用頻道啟動。
- `channels.signal.account`：機器人帳號的 E.164 號碼。
- `channels.signal.cliPath`：`signal-cli` 的路徑。
- `channels.signal.httpUrl`：完整的守護程式 URL (覆寫主機/埠)。
- `channels.signal.httpHost`、`channels.signal.httpPort`：守護程式綁定 (預設 127.0.0.1:8080)。
- `channels.signal.autoStart`：自動生成守護程式 (如果 `httpUrl` 未設定，則預設為 true)。
- `channels.signal.startupTimeoutMs`：啟動等待逾時 (毫秒) (上限 120000)。
- `channels.signal.receiveMode`：`on-start | manual`。
- `channels.signal.ignoreAttachments`：跳過附件下載。
- `channels.signal.ignoreStories`：忽略來自守護程式的動態。
- `channels.signal.sendReadReceipts`：轉發已讀回條。
- `channels.signal.dmPolicy`：`pairing | allowlist | open | disabled` (預設：pairing)。
- `channels.signal.allowFrom`：私訊允許清單 (E.164 或 `uuid:<id>`)。`open` 需要 `"*"。Signal 沒有使用者名稱；使用電話/UUID ID。
- `channels.signal.groupPolicy`：`open | allowlist | disabled` (預設：allowlist)。
- `channels.signal.groupAllowFrom`：群組發送者允許清單。
- `channels.signal.historyLimit`：作為上下文包含的最大群組訊息數 (0 表示停用)。
- `channels.signal.dmHistoryLimit`：使用者輪次中的私訊歷史記錄限制。每個使用者的覆寫：`channels.signal.dms["<phone_or_uuid>"].historyLimit`。
- `channels.signal.textChunkLimit`：出站分塊大小 (字元)。
- `channels.signal.chunkMode`：`length` (預設) 或 `newline`，用於在長度分塊之前，按空白行 (段落邊界) 分割。
- `channels.signal.mediaMaxMb`：入站/出站媒體上限 (MB)。

相關全域選項：

- `agents.list[].groupChat.mentionPatterns` (Signal 不支援原生提及)。
- `messages.groupChat.mentionPatterns` (全域回退)。
- `messages.responsePrefix`。
