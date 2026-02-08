---
summary: "針對 Gateway 閘道器、頻道、自動化、節點與瀏覽器的深入疑難排解操作手冊"
read_when:
  - 疑難排解中樞將你指向此處以進行更深入的診斷
  - 你需要依症狀分類、且包含精確指令的穩定操作手冊章節
title: "疑難排解"
x-i18n:
  source_path: gateway/troubleshooting.md
  source_hash: 163c4af6be740e23
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:22Z
---

# Gateway 閘道器 疑難排解

本頁是深入的操作手冊。
若你想先進行快速分流，請從 [/help/troubleshooting](/help/troubleshooting) 開始。

## 指令階梯

請先依序執行以下指令：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

預期的健康訊號：

- `openclaw gateway status` 顯示 `Runtime: running` 與 `RPC probe: ok`。
- `openclaw doctor` 回報沒有阻擋的設定或服務問題。
- `openclaw channels status --probe` 顯示已連線／就緒的頻道。

## 沒有回覆

如果頻道已啟用但沒有任何回應，請在重新連線任何項目之前，先檢查路由與政策。

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

檢查項目：

- 私訊寄件者的配對仍在等待中。
- 群組提及限制（`requireMention`、`mentionPatterns`）。
- 頻道／群組允許清單不相符。

常見特徵：

- `drop guild message (mention required` → 群組訊息在被提及之前會被忽略。
- `pairing request` → 寄件者需要核准。
- `blocked` / `allowlist` → 寄件者／頻道被政策過濾。

相關：

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Dashboard 控制 UI 連線

當 dashboard／控制 UI 無法連線時，請驗證 URL、驗證模式，以及安全內容的假設。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

檢查項目：

- 正確的探測 URL 與 dashboard URL。
- 用戶端與 Gateway 閘道器 之間的驗證模式／權杖不一致。
- 在需要裝置身分識別時使用了 HTTP。

常見特徵：

- `device identity required` → 非安全內容或缺少裝置驗證。
- `unauthorized` ／ 重連循環 → 權杖／密碼不一致。
- `gateway connect failed:` → 主機／連接埠／URL 目標錯誤。

相關：

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway 服務未執行

當服務已安裝但程序無法持續執行時使用。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

檢查項目：

- `Runtime: stopped` 及其結束提示。
- 服務設定不一致（`Config (cli)` 與 `Config (service)`）。
- 連接埠／監聽衝突。

常見特徵：

- `Gateway start blocked: set gateway.mode=local` → 未啟用本機 Gateway 模式。
- `refusing to bind gateway ... without auth` → 非 local loopback 綁定且未設定權杖／密碼。
- `another gateway instance is already listening` ／ `EADDRINUSE` → 連接埠衝突。

相關：

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## 頻道已連線但訊息未流動

如果頻道狀態為已連線但訊息流中斷，請聚焦於政策、權限，以及頻道特定的投遞規則。

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

檢查項目：

- 私訊政策（`pairing`、`allowlist`、`open`、`disabled`）。
- 群組允許清單與提及需求。
- 缺少頻道 API 權限／範圍。

常見特徵：

- `mention required` → 訊息被群組提及政策忽略。
- `pairing` ／ 等待核准的痕跡 → 寄件者尚未核准。
- `missing_scope`、`not_in_channel`、`Forbidden`、`401/403` → 頻道驗證／權限問題。

相關：

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron 與心跳投遞

如果 cron 或心跳未執行或未投遞，請先驗證排程器狀態，再檢查投遞目標。

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

檢查項目：

- 已啟用 cron 且存在下一次喚醒時間。
- 工作執行歷史狀態（`ok`、`skipped`、`error`）。
- 心跳跳過原因（`quiet-hours`、`requests-in-flight`、`alerts-disabled`）。

常見特徵：

- `cron: scheduler disabled; jobs will not run automatically` → cron 已停用。
- `cron: timer tick failed` → 排程器 tick 失敗；請檢查檔案／日誌／執行階段錯誤。
- `heartbeat skipped` 搭配 `reason=quiet-hours` → 位於啟用時段視窗之外。
- `heartbeat: unknown accountId` → 心跳投遞目標的帳戶 ID 無效。

相關：

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## 已配對的節點工具失敗

如果節點已配對但工具失敗，請隔離前景狀態、權限與核准狀態。

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

檢查項目：

- 節點在線且具備預期能力。
- 作業系統對相機／麥克風／位置／螢幕的權限授與。
- Exec 核准與允許清單狀態。

常見特徵：

- `NODE_BACKGROUND_UNAVAILABLE` → 節點應用程式必須在前景。
- `*_PERMISSION_REQUIRED` ／ `LOCATION_PERMISSION_REQUIRED` → 缺少作業系統權限。
- `SYSTEM_RUN_DENIED: approval required` → Exec 核准仍在等待中。
- `SYSTEM_RUN_DENIED: allowlist miss` → 指令被允許清單阻擋。

相關：

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## 瀏覽器工具失敗

當 Gateway 本身健康，但瀏覽器工具動作仍然失敗時使用。

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

檢查項目：

- 有效的瀏覽器可執行檔路徑。
- CDP 設定檔可達性。
- 針對 `profile="chrome"` 的擴充功能轉接分頁附掛。

常見特徵：

- `Failed to start Chrome CDP on port` → 瀏覽器程序啟動失敗。
- `browser.executablePath not found` → 設定的路徑無效。
- `Chrome extension relay is running, but no tab is connected` → 擴充功能轉接未附掛。
- `Browser attachOnly is enabled ... not reachable` → 僅附掛的設定檔沒有可達的目標。

相關：

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## 若你升級後突然出現問題

多數升級後的問題源於設定漂移，或是更嚴格的預設值開始被強制套用。

### 1) 驗證與 URL 覆寫行為已變更

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

檢查項目：

- 若 `gateway.mode=remote`，CLI 呼叫可能指向遠端，而你的本機服務其實正常。
- 明確的 `--url` 呼叫不會回退到已儲存的認證。

常見特徵：

- `gateway connect failed:` → URL 目標錯誤。
- `unauthorized` → 端點可達但驗證錯誤。

### 2) 綁定與驗證防護更為嚴格

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

檢查項目：

- 非 local loopback 綁定（`lan`、`tailnet`、`custom`）需要設定驗證。
- 舊金鑰如 `gateway.token` 不會取代 `gateway.auth.token`。

常見特徵：

- `refusing to bind gateway ... without auth` → 綁定與驗證不相符。
- 在執行階段仍在運作時出現 `RPC probe: failed` → Gateway 存活，但以目前的驗證／URL 無法存取。

### 3) 配對與裝置身分識別狀態已變更

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

檢查項目：

- Dashboard／節點的裝置核准仍在等待中。
- 在政策或身分識別變更後，私訊配對核准仍在等待中。

常見特徵：

- `device identity required` → 裝置驗證未滿足。
- `pairing required` → 寄件者／裝置必須被核准。

如果在檢查後服務設定與執行階段仍不一致，請從相同的設定檔／狀態目錄重新安裝服務中繼資料：

```bash
openclaw gateway install --force
openclaw gateway restart
```

相關：

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
