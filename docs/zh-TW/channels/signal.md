---
summary: "Signal support via signal-cli (JSON-RPC + SSE), setup paths, and number model"
read_when:
  - Setting up Signal support
  - Debugging Signal send/receive
title: Signal
---

# Signal (signal-cli)

狀態：外部 CLI 整合。網關透過 HTTP JSON-RPC + SSE 與 `signal-cli` 進行通訊。

## 前置條件

- OpenClaw 已安裝在您的伺服器上（以下 Linux 流程已在 Ubuntu 24 上測試）。
- `signal-cli` 在執行閘道的主機上可用。
- 一個可以接收一條驗證 SMS 的電話號碼（用於 SMS 註冊路徑）。
- 註冊期間需要瀏覽器訪問 Signal 驗證碼 (`signalcaptchas.org`)。

## 快速設置（初學者）

1. 為機器人使用 **單獨的 Signal 號碼**（建議）。
2. 安裝 `signal-cli`（如果使用 JVM 版本，則需要 Java）。
3. 選擇一個設置路徑：
   - **路徑 A（QR 連結）：** `signal-cli link -n "OpenClaw"` 並使用 Signal 掃描。
   - **路徑 B（SMS 註冊）：** 註冊一個專用號碼並進行驗證碼 + SMS 驗證。
4. 設定 OpenClaw 並重新啟動網關。
5. 發送第一條 DM 並批准配對 (`openclaw pairing approve signal <CODE>`)。

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

[[BLOCK_1]]

| 欄位        | 描述                                             |
| ----------- | ------------------------------------------------ |
| `account`   | 機器人電話號碼，使用 E.164 格式 (`+15551234567`) |
| `cliPath`   | `signal-cli` 的路徑 (`signal-cli` 如果在 `PATH`) |
| `dmPolicy`  | DM 存取政策 (`pairing` 建議)                     |
| `allowFrom` | 允許 DM 的電話號碼或 `uuid:<id>` 值              |

## 它是什麼

- 透過 `signal-cli` 進行信號通道（不嵌入 libsignal）。
- 確定性路由：回覆始終返回到 Signal。
- 直接訊息共享代理的主要會話；群組是隔離的 (`agent:<agentId>:signal:group:<groupId>`).

## Config writes

預設情況下，Signal 允許寫入由 `/config set|unset` 觸發的設定更新（需要 `commands.config: true`）。

禁用方法：

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## 數字模型（重要）

- 閘道連接到一個 **Signal 裝置** (該 `signal-cli` 帳戶)。
- 如果你在 **你的個人 Signal 帳戶** 上執行機器人，它將忽略你自己的訊息（迴圈保護）。
- 對於「我發送訊息給機器人，它回覆我」，請使用 **單獨的機器人號碼**。

## 設定路徑 A：連結現有的 Signal 帳戶（QR）

1. 安裝 `signal-cli` (JVM 或原生版本)。
2. 連結機器人帳號：
   - `signal-cli link -n "OpenClaw"` 然後在 Signal 中掃描 QR 碼。
3. 設定 Signal 並啟動網關。

[[BLOCK_1]]  
範例：  
[[INLINE_1]]

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

多帳號支援：使用 `channels.signal.accounts` 進行每個帳號的設定，並可選擇性地使用 `name`。請參閱 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 以了解共享模式。

## 設定路徑 B：註冊專用機器人號碼 (SMS, Linux)

當您想要一個專用的機器人號碼，而不是連結現有的 Signal 應用帳戶時，請使用此選項。

1. 獲取一個可以接收 SMS（或固定電話的語音驗證）號碼。
   - 使用專用的機器人號碼以避免帳戶/會話衝突。
2. 在網關主機上安裝 `signal-cli`：

```bash
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
sudo tar xf "signal-cli-${VERSION}-Linux-native.tar.gz" -C /opt
sudo ln -sf /opt/signal-cli /usr/local/bin/
signal-cli --version
```

如果您使用 JVM 建置 (`signal-cli-${VERSION}.tar.gz`), 請先安裝 JRE 25 以上版本。  
保持 `signal-cli` 更新；上游指出舊版本可能會因為 Signal 伺服器 API 的變更而中斷。

3. 註冊並驗證號碼：

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register
```

如果需要驗證碼：

1. 開啟 `https://signalcaptchas.org/registration/generate.html`。
2. 完成驗證碼，從「開啟信號」中複製 `signalcaptcha://...` 連結目標。
3. 在可能的情況下，從與瀏覽器會話相同的外部 IP 執行。
4. 立即再次執行註冊（驗證碼 token 會迅速過期）：

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register --captcha '<SIGNALCAPTCHA_URL>'
signal-cli -a +<BOT_PHONE_NUMBER> verify <VERIFICATION_CODE>
```

4. 設定 OpenClaw，重啟閘道，驗證通道：

bash

# 如果您以使用者 systemd 服務的方式執行網關：

systemctl --user restart openclaw-gateway

# 然後驗證：

openclaw doctor  
openclaw channels status --probe

5. 配對你的 DM 發送者：
   - 向機器人號碼發送任何訊息。
   - 在伺服器上批准程式碼：`openclaw pairing approve signal <PAIRING_CODE>`。
   - 將機器人號碼儲存為聯絡人，以避免出現「未知聯絡人」。

重要：使用 `signal-cli` 註冊電話號碼帳戶可能會使該號碼的主要 Signal 應用程式會話失效。建議使用專用的機器人號碼，或如果需要保留現有的手機應用程式設置，則使用 QR 連結模式。

[[BLOCK_1]]

- `signal-cli` 讀我: `https://github.com/AsamK/signal-cli`
- 驗證碼流程: `https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha`
- 連結流程: `https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)`

## 外部守護進程模式 (httpUrl)

如果您想自行管理 `signal-cli`（慢速 JVM 冷啟動、容器初始化或共享 CPU），請單獨執行守護進程並將 OpenClaw 指向它：

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

這會跳過 OpenClaw 內的自動生成和啟動等待。對於自動生成時的慢啟動，請設置 `channels.signal.startupTimeoutMs`。

## 存取控制 (私訊 + 群組)

DMs:

- 預設: `channels.signal.dmPolicy = "pairing"`。
- 不明發件人會收到配對碼；在獲得批准之前，訊息將被忽略（碼在 1 小時後過期）。
- 批准方式：
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- 配對是 Signal DMs 的預設 token 交換方式。詳情: [配對](/channels/pairing)
- 只有 UUID 的發件人（來自 `sourceUuid`）將被儲存為 `uuid:<id>` 在 `channels.signal.allowFrom`。

Groups:

- `channels.signal.groupPolicy = open | allowlist | disabled`。
- `channels.signal.groupAllowFrom` 控制當 `allowlist` 被設定時，誰可以在群組中觸發。
- 執行時注意：如果 `channels.signal` 完全缺失，執行時將回退到 `groupPolicy="allowlist"` 進行群組檢查（即使 `channels.defaults.groupPolicy` 被設定）。

## 如何運作（行為）

- `signal-cli` 以守護進程的方式執行；網關透過 SSE 讀取事件。
- 進入的訊息會被標準化為共享通道的信封。
- 回覆總是會路由回相同的號碼或群組。

## Media + limits

- 外發文本被分塊為 `channels.signal.textChunkLimit`（預設 4000）。
- 可選的換行分塊：設置 `channels.signal.chunkMode="newline"` 以在空白行（段落邊界）之前進行長度分塊。
- 支援附件（從 `signal-cli` 獲取的 base64）。
- 預設媒體上限：`channels.signal.mediaMaxMb`（預設 8）。
- 使用 `channels.signal.ignoreAttachments` 跳過下載媒體。
- 群組歷史上下文使用 `channels.signal.historyLimit`（或 `channels.signal.accounts.*.historyLimit`），回退至 `messages.groupChat.historyLimit`。設置 `0` 以禁用（預設 50）。

## 輸入中 + 已讀回執

- **輸入指示器**：OpenClaw 透過 `signal-cli sendTyping` 發送輸入信號，並在回覆進行中時刷新這些信號。
- **已讀回執**：當 `channels.signal.sendReadReceipts` 為真時，OpenClaw 會轉發允許的私訊的已讀回執。
- Signal-cli 不會對群組公開已讀回執。

## Reactions (訊息工具)

- 使用 `message action=react` 搭配 `channel=signal`。
- 目標：發送者 E.164 或 UUID（使用 `uuid:<id>` 來自配對輸出；裸 UUID 也可以）。
- `messageId` 是您要回應的訊息的 Signal 時間戳記。
- 群組反應需要 `targetAuthor` 或 `targetAuthorUuid`。

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Config:

- `channels.signal.actions.reactions`: 啟用/禁用反應動作（預設為 true）。
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`。
  - `off`/`ack` 禁用代理反應（訊息工具 `react` 將會出錯）。
  - `minimal`/`extensive` 啟用代理反應並設置指導級別。
- 每個帳戶的覆蓋設定: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`。

## 交付目標 (CLI/cron)

- DMs: `signal:+15551234567`（或純 E.164）。
- UUID DMs: `uuid:<id>`（或裸 UUID）。
- 群組: `signal:group:<groupId>`。
- 使用者名稱: `username:<name>`（如果您的 Signal 帳戶支援）。

## 故障排除

[[BLOCK_1]]  
Run this ladder first:  
[[INLINE_1]]

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

然後確認 DM 配對狀態（如果需要）：

```bash
openclaw pairing list signal
```

[[BLOCK_1]]  
常見故障：  
[[BLOCK_1]]

- Daemon 可達但無回覆：請驗證帳戶/daemon 設定 (`httpUrl`, `account`) 及接收模式。
- 直接訊息被忽略：發送者待配對批准。
- 群組訊息被忽略：群組發送者/提及限制阻止傳送。
- 編輯後的設定驗證錯誤：執行 `openclaw doctor --fix`。
- 診斷中缺少 Signal：確認 `channels.signal.enabled: true`。

[[BLOCK_1]]

```bash
openclaw pairing list signal
pgrep -af signal-cli
grep -i "signal" "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | tail -20
```

[[BLOCK_1]]  
對於分流流程：[/channels/troubleshooting](/channels/troubleshooting)。  
[[BLOCK_2]]

## Security notes

- `signal-cli` 將帳戶金鑰儲存在本地（通常是 `~/.local/share/signal-cli/data/`）。
- 在伺服器遷移或重建之前備份 Signal 帳戶狀態。
- 除非您明確希望擴大 DM 存取權限，否則請保留 `channels.signal.dmPolicy: "pairing"`。
- 簡訊驗證僅在註冊或恢復流程中需要，但失去對號碼/帳戶的控制可能會使重新註冊變得複雜。

## 設定參考 (Signal)

完整設定: [Configuration](/gateway/configuration)

Provider options:

- `channels.signal.enabled`: 啟用/禁用頻道啟動。
- `channels.signal.account`: 用於機器人帳號的 E.164。
- `channels.signal.cliPath`: `signal-cli` 的路徑。
- `channels.signal.httpUrl`: 完整的守護進程 URL（覆蓋主機/端口）。
- `channels.signal.httpHost`, `channels.signal.httpPort`: 守護進程綁定（預設 127.0.0.1:8080）。
- `channels.signal.autoStart`: 自動啟動守護進程（預設為 true，如果 `httpUrl` 未設置）。
- `channels.signal.startupTimeoutMs`: 啟動等待超時（毫秒）（上限 120000）。
- `channels.signal.receiveMode`: `on-start | manual`。
- `channels.signal.ignoreAttachments`: 跳過附件下載。
- `channels.signal.ignoreStories`: 忽略來自守護進程的故事。
- `channels.signal.sendReadReceipts`: 轉發已讀回執。
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled`（預設：配對）。
- `channels.signal.allowFrom`: DM 允許清單（E.164 或 `uuid:<id>`）。`open` 需要 `"*"`。Signal 沒有用戶名；使用電話/UUID ID。
- `channels.signal.groupPolicy`: `open | allowlist | disabled`（預設：允許清單）。
- `channels.signal.groupAllowFrom`: 群組發送者允許清單。
- `channels.signal.historyLimit`: 包含作為上下文的最大群組消息數（0 禁用）。
- `channels.signal.dmHistoryLimit`: 用戶回合的 DM 歷史限制。每位用戶的覆蓋：`channels.signal.dms["<phone_or_uuid>"].historyLimit`。
- `channels.signal.textChunkLimit`: 出站塊大小（字元）。
- `channels.signal.chunkMode`: `length`（預設）或 `newline` 在長度分塊之前按空白行（段落邊界）進行拆分。
- `channels.signal.mediaMaxMb`: 入站/出站媒體上限（MB）。

相關的全域選項：

- `agents.list[].groupChat.mentionPatterns` (Signal 不支援原生提及)。
- `messages.groupChat.mentionPatterns` (全域回退)。
- `messages.responsePrefix`。
