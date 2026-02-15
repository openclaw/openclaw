---
summary: "Gateway、頻道、自動化、節點和瀏覽器的深度疑難排解操作手冊"
read_when:
  - 當疑難排解中心指引您到這裡進行更深入的診斷時
  - 您需要基於穩定症狀的操作手冊區段和確切的指令
title: "疑難排解"
---

# Gateway 疑難排解

本頁為深度操作手冊。
如果您想先執行快速分類流程，請從 [/help/troubleshooting](/help/troubleshooting) 開始。

## 指令階梯

請依照此順序，先執行這些指令：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

預期健康訊號：

- `openclaw gateway status` 顯示 `Runtime: running` 和 `RPC probe: ok`。
- `openclaw doctor` 回報沒有阻擋性的設定/服務問題。
- `openclaw channels status --probe` 顯示已連線/準備就緒的頻道。

## 無回應

如果頻道已啟用但沒有任何回應，請在重新連線任何東西之前檢查路由和策略。

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

尋找：

- DM 智慧代理的配對待定。
- 群組提及限制 (`requireMention`、`mentionPatterns`)。
- 頻道/群組允許清單不符。

常見特徵：

- `drop guild message (mention required` → 群組訊息在提及前被忽略。
- `pairing request` → 傳送者需要批准。
- `blocked` / `allowlist` → 傳送者/頻道被策略過濾。

相關內容：

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## 儀表板控制介面連線

當儀表板/控制介面無法連線時，請驗證 URL、驗證模式和安全上下文假設。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

尋找：

- 正確的探測 URL 和儀表板 URL。
- 用戶端和 Gateway 之間的驗證模式/權杖不符。
- 需要裝置身份的 HTTP 使用。

常見特徵：

- `device identity required` → 非安全上下文或缺少裝置驗證。
- `unauthorized` / 重新連線迴圈 → 權杖/密碼不符。
- `gateway connect failed:` → 錯誤的主機/埠/URL 目標。

相關內容：

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway 服務未執行

當服務已安裝但程序未保持執行時使用此功能。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

尋找：

- `Runtime: stopped` 並帶有結束提示。
- 服務設定不符 (`Config (cli)` 與 `Config (service)`)。
- 埠/監聽器衝突。

常見特徵：

- `Gateway start blocked: set gateway.mode=local` → local gateway mode 未啟用。
- `refusing to bind gateway ... without auth` → 無權杖/密碼的非 local loopback 綁定。
- `another gateway instance is already listening` / `EADDRINUSE` → 埠衝突。

相關內容：

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## 頻道已連線但訊息未流動

如果頻道狀態已連線但訊息流已停滯，請專注於策略、權限和頻道特定的傳遞規則。

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

尋找：

- DM 策略 (`pairing`、`allowlist`、`open`、`disabled`)。
- 群組允許清單和提及要求。
- 缺少頻道 API 權限/範圍。

常見特徵：

- `mention required` → 訊息被群組提及策略忽略。
- `pairing` / 待批准追蹤 → 傳送者未被批准。
- `missing_scope`、`not_in_channel`、`Forbidden`、`401/403` → 頻道驗證/權限問題。

相關內容：

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## 定時任務與心跳傳遞

如果定時任務或心跳未執行或未傳遞，請先驗證排程器狀態，然後再驗證傳遞目標。

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

尋找：

- 定時任務已啟用且下次喚醒時間存在。
- 作業執行歷史狀態 (`ok`、`skipped`、`error`)。
- 心跳跳過原因 (`quiet-hours`、`requests-in-flight`、`alerts-disabled`)。

常見特徵：

- `cron: scheduler disabled; jobs will not run automatically` → 定時任務已停用。
- `cron: timer tick failed` → 排程器計時失敗；檢查檔案/日誌/執行時錯誤。
- `heartbeat skipped` 帶有 `reason=quiet-hours` → 在活動時間視窗之外。
- `heartbeat: unknown accountId` → 心跳傳遞目標的帳戶 ID 無效。

相關內容：

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## 節點配對 工具 失敗

如果節點已配對但 工具 失敗，請隔離前景、權限和批准狀態。

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

尋找：

- 節點線上且具有預期功能。
- 作業系統對相機/麥克風/位置/螢幕的權限授予。
- 執行批准和允許清單狀態。

常見特徵：

- `NODE_BACKGROUND_UNAVAILABLE` → 節點應用程式必須在前台。
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → 缺少作業系統權限。
- `SYSTEM_RUN_DENIED: approval required` → 執行批准待定。
- `SYSTEM_RUN_DENIED: allowlist miss` → 指令被允許清單阻擋。

相關內容：

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## 瀏覽器 工具 失敗

當瀏覽器 工具 動作失敗，即使 Gateway 本身是健康的，也使用此功能。

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

尋找：

- 有效的瀏覽器執行檔路徑。
- CDP 設定檔可達性。
- 擴充功能中繼分頁附加，用於 `profile="chrome"`。

常見特徵：

- `Failed to start Chrome CDP on port` → 瀏覽器程序啟動失敗。
- `browser.executablePath not found` → 設定的路徑無效。
- `Chrome extension relay is running, but no tab is connected` → 擴充功能中繼未附加。
- `Browser attachOnly is enabled ... not reachable` → 僅附加設定檔沒有可達目標。

相關內容：

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## 如果您升級後突然出現問題

大多數升級後的問題是設定漂移或現在強制執行更嚴格的 預設 值。

### 1) 驗證和 URL 覆蓋行為已變更

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

要檢查的項目：

- 如果 `gateway.mode=remote`，CLI 呼叫可能指向遠端，而您的本地服務正常。
- 明確的 `--url` 呼叫不會回溯到儲存的憑證。

常見特徵：

- `gateway connect failed:` → 錯誤的 URL 目標。
- `unauthorized` → 端點可達但驗證錯誤。

### 2) 綁定和驗證防護措施更嚴格

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

要檢查的項目：

- 非 local loopback 綁定 (`lan`、`tailnet`、`custom`) 需要設定驗證。
- 舊鍵如 `gateway.token` 不會取代 `gateway.auth.token`。

常見特徵：

- `refusing to bind gateway ... without auth` → 綁定+驗證不符。
- `RPC probe: failed` 當執行時正在執行時 → Gateway 仍活著但使用目前的驗證/URL 無法存取。

### 3) 配對和裝置身份狀態已變更

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

要檢查的項目：

- 儀表板/節點的待定裝置批准。
- 策略或身份變更後的待定 DM 配對批准。

常見特徵：

- `device identity required` → 裝置驗證未滿足。
- `pairing required` → 傳送者/裝置必須被批准。

如果檢查後服務設定和執行時仍然不符，請從相同的設定檔/狀態目錄重新安裝服務中繼資料：

```bash
openclaw gateway install --force
openclaw gateway restart
```

相關內容：

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)

## 常見 疑難排解

### 「Gateway 無法啟動 — 設定無效」

當 設定 包含未知鍵名、格式錯誤的值或無效的類型時，OpenClaw 現在拒絕啟動。
這是出於安全考量和設計。

使用 Doctor 修正：

```bash
openclaw doctor
openclaw doctor --fix
```

注意事項：

- `openclaw doctor` 回報每個無效的項目。
- `openclaw doctor --fix` 應用遷移/修正並重寫 設定。
- 診斷 指令 例如 `openclaw logs`、`openclaw health`、`openclaw status`、`openclaw gateway status` 和 `openclaw gateway probe` 即使 設定 無效也能執行。

### 「所有 模型 失敗」— 我應該先檢查什麼？

- **憑證**存在於正在嘗試的 供應商 （驗證設定檔 + 環境變數）。
- **模型路由**：確認 `agents.defaults.model.primary` 和回退是您可以存取的 模型。
- `/tmp/openclaw/…` 中的 **Gateway 日誌**以獲取確切的 供應商 錯誤。
- **模型狀態**：使用 `/model status`（聊天）或 `openclaw models status`（CLI）。

### 我在我的個人 WhatsApp 號碼上執行 — 為什麼自聊天很奇怪？

啟用自聊天模式並將您自己的號碼加入允許清單：

```json5
{
  channels: {
    whatsapp: {
      selfChatMode: true,
      dmPolicy: "allowlist",
      allowFrom: ["+15555550123"],
    },
  },
}
```

請參閱 [WhatsApp 設定](/channels/whatsapp)。

### WhatsApp 將我斷開連線。如何重新驗證？

再次執行登入 指令 並掃描 QR 碼：

```bash
openclaw channels login
```

### `main` 上的建置錯誤 — 標準修正路徑是什麼？

1. `git pull origin main && pnpm install`
2. `openclaw doctor`
3. 檢查 GitHub issues 或 Discord
4. 臨時變通方法：檢出較舊的提交

### npm install 失敗（allow-build-scripts / 缺少 tar 或 yargs）。現在怎麼辦？

如果您從原始碼執行，使用倉庫的套件管理器：**pnpm**（首選）。
倉庫宣告了 `packageManager: "pnpm @…"`。

典型恢復：

```bash
git status   # 確保您在倉庫根目錄
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

原因：pnpm 是此倉庫 設定 的套件管理器。

### 如何在 git 安裝和 npm 安裝之間切換？

使用**網站安裝程式**並透過 旗標 選擇安裝方法。它
原地升級並重寫 Gateway 服務以指向新安裝。

切換**到 git 安裝**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
```

切換**到 npm 全局**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

注意事項：

- git 流程僅在倉庫乾淨時才 rebase。先提交或暫存更改。
- 切換後，執行：
  ```bash
  openclaw doctor
  openclaw gateway restart
  ```

### Telegram 區塊串流傳輸沒有在 工具 呼叫之間分割文字。為什麼？

區塊串流傳輸 只傳送**已完成的 文字塊**。您看到單條 訊息 的常見原因：

- `agents.defaults.blockStreamingDefault` 仍然是 `"off"`。
- `channels.telegram.blockStreaming` 設定為 `false`。
- `channels.telegram.streamMode` 是 `partial` 或 `block` **且草稿串流傳輸處於活動狀態**
  （私聊 + 議題）。在這種情況下，草稿串流傳輸會停用 區塊串流傳輸。
- 您的 `minChars` / coalesce 設定太高，所以 區塊 被合併了。
- 模型 發出一個大的 文字塊（沒有中間回復刷新點）。

修正清單：

1. 將 區塊串流傳輸 設定放在 `agents.defaults` 下，而不是根目錄。
2. 如果您想要真正的多 訊息 區塊回復，設定 `channels.telegram.streamMode: "off"`。
3. 偵錯時使用較小的 chunk/coalesce 閾值。

請參閱 [串流傳輸](/concepts/streaming)。

### 即使 設定 了 `requireMention: false`，Discord 也不在我的 伺服器 中回復。為什麼？

`requireMention` 只控制 頻道 透過允許清單**之後**的提及門控。
預設 情況下 `channels.discord.groupPolicy` 是 **allowlist**，所以必須顯式啟用 guild。
如果您 設定 了 `channels.discord.guilds.<guildId>.channels`，只允許列出的 頻道；省略它以允許 guild 中的所有 頻道。

修正清單：

1. 設定 `channels.discord.groupPolicy: "open"` **或**添加 guild 允許清單項目（並可選添加 頻道 允許清單）。
2. 在 `channels.discord.guilds.<guildId>.channels` 中使用**數字 頻道 ID**。
3. 將 `requireMention: false` 放在 `channels.discord.guilds` **下面**（全域或每個 頻道）。
   頂級 `channels.discord.requireMention` 不是支援的鍵。
4. 確保機器人有 **Message Content Intent** 和 頻道 權限。
5. 執行 `openclaw channels status --probe` 獲取審核提示。

文件：[Discord](/channels/discord)、[頻道 疑難排解](/channels/troubleshooting)。

### Cloud Code Assist API 錯誤：invalid tool schema（400）。現在怎麼辦？

這幾乎總是**工具 模式相容性**問題。Cloud Code Assist
端點接受 JSON Schema 的嚴格子集。OpenClaw 在當前 `main` 中清理/規範化 工具
模式，但修正尚未包含在最後一個版本中（截至
2026 年 1 月 13 日）。

修正清單：

1. **更新 OpenClaw**：
   - 如果您可以從原始碼執行，拉取 `main` 並重啟 Gateway。
   - 否則，等待包含模式清理器的下一個版本。
2. 避免不支援的關鍵字，如 `anyOf/oneOf/allOf`、`patternProperties`、
   `additionalProperties`、`minLength`、`maxLength`、`format` 等。
3. 如果您定義自訂 工具，保持頂級模式為 `type: "object"` 並使用
   `properties` 和簡單枚舉。

請參閱 [工具](/tools) 和 [TypeBox 模式](/concepts/typebox)。

## macOS 特定問題

### 授予權限（語音/麥克風）時應用程式崩潰

如果在您點擊隱私提示的「允許」時應用程式消失或顯示「Abort trap 6」：

**修正 1：重置 TCC 快取**

```bash
tccutil reset All bot.molt.mac.debug
```

**修正 2：強制使用新的 Bundle ID**
如果重置不起作用，在 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 中更改 `BUNDLE_ID`（例如，添加 `.test` 後綴）並重新建置。這會強制 macOS 將其視為新應用程式。

### Gateway 卡在「Starting...」

應用程式連線到 埠 `18789` 上的本地 Gateway。如果一直卡住：

**修正 1：停止監管程式（首選）**
如果 Gateway 由 launchd 監管，殺死 PID 只會重新生成它。先停止監管程式：

```bash
openclaw gateway status
openclaw gateway stop
# 或：launchctl bootout gui/$UID/bot.molt.gateway（用 bot.molt.<profile> 替換；舊版 com.openclaw.* 仍然有效）
```

**修正 2：埠 被佔用（尋找監聽器）**

```bash
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

如果是未被監管的程序，先嘗試優雅停止，然後升級：

```bash
kill -TERM <PID>
sleep 1
kill -9 <PID> # 最後手段
```

**修正 3：檢查 CLI 安裝**
確保全域 `openclaw` CLI 已安裝且與應用程式版本匹配：

```bash
openclaw --version
npm install -g openclaw @<version>
```

## 偵錯模式

獲取詳細 日誌：

```bash
# 在設定中打開追蹤日誌：
#   ${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json} -> { logging: { level: "trace" } }
#
# 然後執行詳細指令將偵錯輸出鏡像到標準輸出：
openclaw gateway --verbose
openclaw channels login --verbose
```

## 日誌位置

| 日誌 | 位置 |
|---|---|
| Gateway 檔案 日誌（結構化） | `/tmp/openclaw/openclaw-YYYY-MM-DD.log`（或 `logging.file`） |
| Gateway 服務 日誌（監管程式） | macOS：`$OPENCLAW_STATE_DIR/logs/gateway.log` + `gateway.err.log`（預設：`~/.openclaw/logs/...`；設定檔 使用 `~/.openclaw-<profile>/logs/...`）<br />Linux：`journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`<br />Windows：`schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST` |
| 工作階段 檔案 | `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/` |
| 媒體快取 | `$OPENCLAW_STATE_DIR/media/` |
| 憑證 | `$OPENCLAW_STATE_DIR/credentials/` |

## 健康檢查

```bash
# 監管程式 + 探測目標 + 設定路徑
openclaw gateway status
# 包括系統級掃描（舊版/額外服務、埠監聽器）
openclaw gateway status --deep

# Gateway 是否可達？
openclaw health --json
# 如果失敗，使用連線詳情重新執行：
openclaw health --verbose

# 預設 埠上是否有東西在監聽？
lsof -nP -iTCP:18789 -sTCP:LISTEN

# 最近活動（RPC 日誌尾部）
openclaw logs --follow
# 如果 RPC 宕機的備用方案
tail -20 /tmp/openclaw/openclaw-*.log
```

## 重置所有內容

核選項：

```bash
openclaw gateway stop
# 如果您安裝了服務並想要乾淨安裝：
# openclaw gateway uninstall

trash "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
openclaw channels login         # 重新配對 WhatsApp
openclaw gateway restart           # 或：openclaw gateway
```

⚠️ 這會遺失所有 工作階段 並需要重新配對 WhatsApp。

## 獲取幫助

1. 首先檢查 日誌：`/tmp/openclaw/`（預設：`openclaw-YYYY-MM-DD.log`，或您 設定 的 `logging.file`）
2. 在 GitHub 上搜尋現有問題
3. 提交新問題時包含：
   - OpenClaw 版本
   - 相關 日誌 片段
   - 重現步驟
   - 您的 設定 （隱藏 金鑰！）

---

_"您試過關掉再開嗎？"_" — 每個 IT 人員都這麼說

🦞🔧

### 瀏覽器無法啟動（Linux）

如果您看到 「Failed to start Chrome CDP on port 18800」：

**最可能的原因：** Ubuntu 上的 Snap 打包的 Chromium。

**快速修正：** 改為安裝 Google Chrome：

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
```

然後在 設定 中 設定：

```json
{
  "browser": {
    "executablePath": "/usr/bin/google-chrome-stable"
  }
}
```

**完整指南：** 請參閱 [browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
