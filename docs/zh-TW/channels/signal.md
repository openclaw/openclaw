---
summary: "透過 signal-cli (JSON-RPC + SSE) 支援 Signal、設定路徑與號碼模型"
read_when:
  - 設定 Signal 支援時
  - 偵錯 Signal 傳送/接收時
title: "Signal"
---

# Signal (signal-cli)

狀態：外部 CLI 整合。Gateway 透過 HTTP JSON-RPC + SSE 與 signal-cli 通訊。

## 前置作業

- OpenClaw 已安裝在您的伺服器上（下方的 Linux 流程已在 Ubuntu 24 測試）。
- signal-cli 可在執行 Gateway 的主機上使用。
- 一個可以接收驗證簡訊的電話號碼（用於簡訊註冊路徑）。
- 註冊期間可存取瀏覽器以進行 Signal 驗證碼 (signalcaptchas.org) 驗證。

## 快速開始（初學者）

1. 為智慧代理使用**獨立的 Signal 號碼**（建議）。
2. 安裝 `signal-cli`（如果使用 JVM 版本則需要 Java）。
3. 選擇一種設定路徑：
   - **路徑 A (QR 連結)：** 執行 `signal-cli link -n "OpenClaw"` 並使用 Signal 掃描。
   - **路徑 B (簡訊註冊)：** 使用驗證碼 + 簡訊驗證註冊專用號碼。
4. 設定 OpenClaw 並重新啟動 Gateway。
5. 傳送第一則私訊並核准配對 (`openclaw pairing approve signal <CODE>`)。

最簡設定：

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

欄位說明：

| 欄位        | 說明                                                       |
| ----------- | ---------------------------------------------------------- |
| `account`   | 智慧代理的電話號碼，採 E.164 格式 (`+15551234567`)         |
| `cliPath`   | `signal-cli` 的路徑（若已加入 `PATH` 則填寫 `signal-cli`） |
| `dmPolicy`  | 私訊存取策略（建議使用 `pairing`）                         |
| `allowFrom` | 允許傳送私訊的電話號碼或 `uuid:<id>` 值                    |

## 功能簡介

- 透過 `signal-cli`（非內嵌式 libsignal）提供的 Signal 頻道。
- 確定性路由：回覆一律傳回 Signal。
- 私訊共用智慧代理的主要工作階段；群組則是隔離的 (`agent:<agentId>:signal:group:<groupId>`)。

## 設定寫入

預設情況下，允許 Signal 寫入由 `/config set|unset` 觸發的設定更新（需要 `commands.config: true`）。

若要停用，請使用：

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## 號碼模型（重要）

- Gateway 連接到一個 **Signal 裝置**（即 `signal-cli` 帳號）。
- 如果您在**個人 Signal 帳號**上執行智慧代理，它會忽略您自己的訊息（迴圈保護）。
- 若要實現「我傳送訊息給智慧代理且它回覆」，請使用**獨立的智慧代理號碼**。

## 設定路徑 A：連結現有的 Signal 帳號 (QR)

1. 安裝 `signal-cli`（JVM 或原生版本）。
2. 連結智慧代理帳號：
   - 執行 `signal-cli link -n "OpenClaw"`，然後在 Signal 中掃描 QR code。
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

多帳號支援：使用 `channels.signal.accounts` 搭配個別帳號設定與選填的 `name`。請參閱 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 了解共用模式。

## 設定路徑 B：註冊專用智慧代理號碼（簡訊，Linux）

當您想要使用專用的智慧代理號碼而非連結現有的 Signal App 帳號時，請使用此方式。

1. 取得一個可以接收簡訊的號碼（或用於市話的語音驗證）。
   - 使用專用的智慧代理號碼，以避免帳號/工作階段衝突。
2. 在 Gateway 主機上安裝 `signal-cli`：

```bash
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
sudo tar xf "signal-cli-${VERSION}-Linux-native.tar.gz" -C /opt
sudo ln -sf /opt/signal-cli /usr/local/bin/
signal-cli --version
```

如果您使用 JVM 版本 (`signal-cli-${VERSION}.tar.gz`)，請先安裝 JRE 25+。
請保持 `signal-cli` 更新；上游指出，隨著 Signal 伺服器 API 的變更，舊版本可能會失效。

3. 註冊並驗證號碼：

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register
```

如果需要驗證碼：

1. 開啟 `https://signalcaptchas.org/registration/generate.html`。
2. 完成驗證碼，從「開啟 Signal (Open Signal)」中複製 `signalcaptcha://...` 連結目標。
3. 儘可能在與瀏覽器工作階段相同的外部 IP 下執行。
4. 立即再次執行註冊（驗證碼權杖會很快過期）：

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register --captcha '<SIGNALCAPTCHA_URL>'
signal-cli -a +<BOT_PHONE_NUMBER> verify <VERIFICATION_CODE>
```

4. 設定 OpenClaw，重新啟動 Gateway，並驗證頻道：

```bash
# 如果您將 Gateway 作為使用者 systemd 服務執行：
systemctl --user restart openclaw-gateway

# 然後驗證：
openclaw doctor
openclaw channels status --probe
```

5. 配對您的私訊傳送者：
   - 傳送任何訊息給智慧代理號碼。
   - 在伺服器上核准代碼：`openclaw pairing approve signal <PAIRING_CODE>`。
   - 將智慧代理號碼儲存為手機聯絡人，以避免出現「未知聯絡人 (Unknown contact)」。

重要事項：使用 `signal-cli` 註冊電話號碼帳號可能會使該號碼的主要 Signal App 工作階段失效。建議使用專用的智慧代理號碼，或者如果您需要保留現有的手機 App 設定，請使用 QR 連結模式。

上游參考資料：

- `signal-cli` README: `https://github.com/AsamK/signal-cli`
- 驗證碼流程: `https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha`
- 連結流程: `https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)`

## 外部守護行程模式 (httpUrl)

如果您想自行管理 `signal-cli`（解決 JVM 冷啟動緩慢、容器初始化或共用 CPU 等問題），請單獨執行守護行程 (Daemon) 並將 OpenClaw 指向它：

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

這會跳過 OpenClaw 內部的自動啟動和啟動等待。若自動啟動時啟動緩慢，請設定 `channels.signal.startupTimeoutMs`。

## 存取控制（私訊 + 群組）

私訊：

- 預設值：`channels.signal.dmPolicy = "pairing"`。
- 未知的傳送者會收到配對碼；訊息在核准前會被忽略（代碼在 1 小時後過期）。
- 透過以下方式核准：
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- 配對是 Signal 私訊的預設權杖交換方式。詳情請見：[配對](/channels/pairing)
- 僅限 UUID 的傳送者（來自 `sourceUuid`）會以 `uuid:<id>` 格式儲存在 `channels.signal.allowFrom` 中。

群組：

- `channels.signal.groupPolicy = open | allowlist | disabled`。
- 當設為 `allowlist` 時，`channels.signal.groupAllowFrom` 控制誰可以在群組中觸發智慧代理。

## 運作原理（行為）

- `signal-cli` 以守護行程方式執行；Gateway 透過 SSE 讀取事件。
- 傳入的訊息會被正規化為共用的頻道封包。
- 回覆一律路由回相同的號碼或群組。

## 媒體 + 限制

- 傳出文字會根據 `channels.signal.textChunkLimit`（預設 4000）進行分段。
- 選用的換行分段：設定 `channels.signal.chunkMode="newline"`，在長度分段前先根據空白行（段落邊界）進行切割。
- 支援附件（從 `signal-cli` 抓取 base64）。
- 預設媒體限制：`channels.signal.mediaMaxMb`（預設 8）。
- 使用 `channels.signal.ignoreAttachments` 來跳過下載媒體。
- 群組紀錄上下文使用 `channels.signal.historyLimit`（或 `channels.signal.accounts.*.historyLimit`），若未設定則退而使用 `messages.groupChat.historyLimit`。設為 `0` 以停用（預設 50）。

## 輸入狀態 + 已讀回執

- **輸入狀態指示**：OpenClaw 透過 `signal-cli sendTyping` 傳送輸入中訊號，並在回覆執行期間持續重新整理。
- **已讀回執**：當 `channels.signal.sendReadReceipts` 為 true 時，OpenClaw 會轉發已核准私訊的已讀回執。
- Signal-cli 不會顯示群組的已讀回執。

## 表情符號回應 (message 工具)

- 使用 `message action=react` 搭配 `channel=signal`。
- 目標：傳送者的 E.164 或 UUID（使用配對輸出中的 `uuid:<id>`；僅填 UUID 亦可）。
- `messageId` 是您要回應的訊息的 Signal 時間戳記。
- 群組表情符號回應需要 `targetAuthor` 或 `targetAuthorUuid`。

範例：

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

設定：

- `channels.signal.actions.reactions`：啟用/停用表情符號回應動作（預設 true）。
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`。
  - `off`/`ack` 會停用智慧代理反應（message 工具 `react` 會報錯）。
  - `minimal`/`extensive` 會啟用智慧代理反應並設定引導等級。
- 個別帳號覆蓋：`channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`。

## 傳遞目標 (CLI/cron)

- 私訊：`signal:+15551234567`（或純 E.164）。
- UUID 私訊：`uuid:<id>`（或純 UUID）。
- 群組：`signal:group:<groupId>`。
- 使用者名稱：`username:<name>`（若您的 Signal 帳號支援）。

## 疑難排解

請先依序執行以下步驟：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

如有需要，請確認私訊配對狀態：

```bash
openclaw pairing list signal
```

常見故障：

- 守護行程可連線但無回覆：驗證帳號/守護行程設定 (`httpUrl`, `account`) 與接收模式。
- 私訊被忽略：傳送者正等待配對核准。
- 群組訊息被忽略：群組傳送者/提及閘控阻擋了傳遞。
- 修改後出現設定驗證錯誤：執行 `openclaw doctor --fix`。
- 診斷資訊中缺少 Signal：確認 `channels.signal.enabled: true`。

額外檢查：

```bash
openclaw pairing list signal
pgrep -af signal-cli
grep -i "signal" "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | tail -20
```

故障排除流程：[/channels/troubleshooting](/channels/troubleshooting)。

## 安全性注意事項

- `signal-cli` 將帳號金鑰儲存在本地（通常在 `~/.local/share/signal-cli/data/`）。
- 在伺服器遷移或重新構建前，請備份 Signal 帳號狀態。
- 除非您明確想要更廣泛的私訊存取權限，否則請保持 `channels.signal.dmPolicy: "pairing"`。
- 簡訊驗證僅在註冊或復原流程中需要，但失去對號碼/帳號的控制可能會使重新註冊變得複雜。

## 設定參考 (Signal)

完整設定：[設定](/gateway/configuration)

供應商選項：

- `channels.signal.enabled`：啟用/停用頻道啟動。
- `channels.signal.account`：智慧代理帳號的 E.164 格式。
- `channels.signal.cliPath`：`signal-cli` 的路徑。
- `channels.signal.httpUrl`：守護行程完整 URL（覆蓋 host/port）。
- `channels.signal.httpHost`, `channels.signal.httpPort`：守護行程繫結（預設 127.0.0.1:8080）。
- `channels.signal.autoStart`：自動啟動守護行程（若未設定 `httpUrl` 則預設為 true）。
- `channels.signal.startupTimeoutMs`：啟動等待逾時（毫秒，上限 120000）。
- `channels.signal.receiveMode`: `on-start | manual`。
- `channels.signal.ignoreAttachments`：跳過附件下載。
- `channels.signal.ignoreStories`：忽略來自守護行程的動態 (Stories)。
- `channels.signal.sendReadReceipts`：轉發已讀回執。
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled`（預設：pairing）。
- `channels.signal.allowFrom`：私訊白名單（E.164 或 `uuid:<id>`）。`open` 需要 `"*"`。Signal 沒有使用者名稱；請使用電話/UUID ID。
- `channels.signal.groupPolicy`: `open | allowlist | disabled`（預設：allowlist）。
- `channels.signal.groupAllowFrom`：群組傳送者白名單。
- `channels.signal.historyLimit`：包含在上下文中的群組訊息數量上限（0 為停用）。
- `channels.signal.dmHistoryLimit`：以使用者輪次為單位的私訊紀錄限制。個別使用者覆蓋：`channels.signal.dms["<phone_or_uuid>"].historyLimit`。
- `channels.signal.textChunkLimit`：傳出分段大小（字元）。
- `channels.signal.chunkMode`：`length`（預設）或 `newline`（在長度分段前先根據空白行即段落邊界進行切割）。
- `channels.signal.mediaMaxMb`：傳入/傳出媒體大小限制 (MB)。

相關全域選項：

- `agents.list[].groupChat.mentionPatterns`（Signal 不支援原生提及）。
- `messages.groupChat.mentionPatterns`（全域後備）。
- `messages.responsePrefix`。
