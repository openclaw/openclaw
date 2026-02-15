---
summary: "適用於 Gateway、頻道、自動化、節點和瀏覽器的深度疑難排解執行手冊"
read_when:
  - 疑難排解中心指引您來到此處以進行更深入的診斷
  - 您需要基於症狀的穩定執行手冊章節及精確指令
title: "疑難排解"
---

# Gateway 疑難排解

本頁面為深度執行手冊。
如果您想先進行快速診斷分流流程，請從 [/help/troubleshooting](/help/troubleshooting) 開始。

## 指令階梯

請按以下順序優先執行這些指令：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

預期的健康訊號：

- `openclaw gateway status` 顯示 `Runtime: running` 且 `RPC probe: ok`。
- `openclaw doctor` 回報沒有阻斷性的設定/服務問題。
- `openclaw channels status --probe` 顯示已連線/就緒的頻道。

## 無回應

如果頻道已啟動但沒有任何回應，在重新連接任何內容之前，請先檢查路由和政策。

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

檢查重點：

- 私訊傳送者的配對狀態為待處理 (Pending)。
- 群組提及過濾 (`requireMention`, `mentionPatterns`)。
- 頻道/群組允許列表 (allowlist) 不匹配。

常見特徵：

- `drop guild message (mention required` → 群組訊息在被提及前會被忽略。
- `pairing request` → 傳送者需要核准。
- `blocked` / `allowlist` → 傳送者/頻道被政策過濾。

相關內容：

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## 儀表板控制介面連線能力

當儀表板/控制介面無法連線時，請驗證 URL、驗證模式以及安全上下文 (secure context) 的假設。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

檢查重點：

- 正確的探針 URL 與儀表板 URL。
- 用戶端與 Gateway 之間的驗證模式 (Auth mode)/權杖 (token) 不匹配。
- 在需要裝置識別碼的地方使用了 HTTP。

常見特徵：

- `device identity required` → 非安全上下文或遺失裝置驗證。
- `unauthorized` / 重新連線迴圈 → 權杖/密碼不匹配。
- `gateway connect failed:` → 錯誤的主機/連接埠/URL 目標。

相關內容：

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway 服務未執行

當服務已安裝但程序無法持續執行時，請使用此部分。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

檢查重點：

- `Runtime: stopped` 並帶有退出提示。
- 服務設定不匹配 (`Config (cli)` vs `Config (service)`)。
- 連接埠/接聽器 (listener) 衝突。

常見特徵：

- `Gateway start blocked: set gateway.mode=local` → 本地 Gateway 模式未啟用。
- `refusing to bind gateway ... without auth` → 在沒有權杖/密碼的情況下進行非 local loopback 綁定。
- `another gateway instance is already listening` / `EADDRINUSE` → 連接埠衝突。

相關內容：

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## 頻道已連接但訊息未流通

如果頻道狀態顯示已連接但訊息流中斷，請專注於政策、權限以及頻道特定的傳遞規則。

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

檢查重點：

- 私訊政策 (`pairing`, `allowlist`, `open`, `disabled`)。
- 群組允許列表與提及要求。
- 遺失頻道 API 權限/範圍 (scopes)。

常見特徵：

- `mention required` → 訊息因群組提及政策而被忽略。
- `pairing` / 待核准追蹤 → 傳送者未獲核准。
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → 頻道驗證/權限問題。

相關內容：

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron 與 heartbeat 傳遞

如果 cron 或 heartbeat 未執行或未傳遞，請先驗證排程器狀態，然後驗證傳遞目標。

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

檢查重點：

- Cron 已啟用且有下一次喚醒時間。
- 工作執行歷史狀態 (`ok`, `skipped`, `error`)。
- Heartbeat 跳過原因 (`quiet-hours`, `requests-in-flight`, `alerts-disabled`)。

常見特徵：

- `cron: scheduler disabled; jobs will not run automatically` → cron 已停用。
- `cron: timer tick failed` → 排程器計時觸發失敗；檢查檔案/日誌/執行階段錯誤。
- `heartbeat skipped` 帶有 `reason=quiet-hours` → 在作用時間範圍之外。
- `heartbeat: unknown accountId` → heartbeat 傳遞目標的帳戶 ID 無效。

相關內容：

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## 已配對節點工具失敗

如果節點已配對但工具失敗，請隔離前景、權限和核准狀態。

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

檢查重點：

- 節點在線且具有預期功能。
- 作業系統權限授予（相機/麥克風/位置/螢幕）。
- 執行核准 (Exec approvals) 與允許列表狀態。

常見特徵：

- `NODE_BACKGROUND_UNAVAILABLE` → 節點應用程式必須在前景執行。
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → 遺失作業系統權限。
- `SYSTEM_RUN_DENIED: approval required` → 執行核准待處理中。
- `SYSTEM_RUN_DENIED: allowlist miss` → 指令被允許列表阻斷。

相關內容：

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## 瀏覽器工具失敗

當 Gateway 本身健康但瀏覽器工具操作失敗時，請使用此部分。

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

檢查重點：

- 有效的瀏覽器執行檔路徑。
- CDP 設定檔的可達性。
- `profile="chrome"` 的擴充功能轉發 (Extension relay) 分頁連接。

常見特徵：

- `Failed to start Chrome CDP on port` → 瀏覽器程序啟動失敗。
- `browser.executablePath not found` → 設定的路徑無效。
- `Chrome extension relay is running, but no tab is connected` → 擴充功能轉發未連接。
- `Browser attachOnly is enabled ... not reachable` → 僅附加 (attach-only) 設定檔沒有可達的目標。

相關內容：

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## 如果您升級後突然發生故障

升級後的大多數故障是由於設定偏移或現在強制執行更嚴格的預設值所致。

### 1) 驗證與 URL 覆蓋行為已變更

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

檢查事項：

- 如果 `gateway.mode=remote`，CLI 呼叫可能會指向遠端，而您的本地服務可能運作正常。
- 明確的 `--url` 呼叫不會退而使用儲存的憑證。

常見特徵：

- `gateway connect failed:` → 錯誤的 URL 目標。
- `unauthorized` → 端點可達但驗證錯誤。

### 2) 綁定與驗證防護欄更嚴格

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

檢查事項：

- 非 local loopback 綁定 (`lan`, `tailnet`, `custom`) 需要設定驗證。
- 舊的金鑰如 `gateway.token` 不會取代 `gateway.auth.token`。

常見特徵：

- `refusing to bind gateway ... without auth` → 綁定與驗證不匹配。
- `RPC probe: failed` 且執行階段正在執行 → Gateway 存活但以目前的驗證/URL 無法存取。

### 3) 配對與裝置識別狀態已變更

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

檢查事項：

- 儀表板/節點的待處理裝置核准。
- 政策或身份變更後待處理的私訊配對核准。

常見特徵：

- `device identity required` → 裝置驗證未滿足。
- `pairing required` → 傳送者/裝置必須經過核准。

如果在檢查後服務設定與執行階段仍不一致，請從相同的設定檔/狀態目錄重新安裝服務中繼資料：

```bash
openclaw gateway install --force
openclaw gateway restart
```

相關內容：

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
