---
summary: >-
  Deep troubleshooting runbook for gateway, channels, automation, nodes, and
  browser
read_when:
  - The troubleshooting hub pointed you here for deeper diagnosis
  - You need stable symptom based runbook sections with exact commands
title: Troubleshooting
---

# Gateway 故障排除

這個頁面是深度執行手冊。  
如果您想先進行快速的問題處理流程，請從 [/help/troubleshooting](/help/troubleshooting) 開始。

## Command ladder

請依照以下順序執行這些：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

預期的健康信號：

- `openclaw gateway status` 顯示 `Runtime: running` 和 `RPC probe: ok`。
- `openclaw doctor` 報告沒有阻塞的設定/服務問題。
- `openclaw channels status --probe` 顯示已連接/準備好的通道。

## Anthropic 429 需要額外的使用量以支援長上下文

使用此方法當日誌/錯誤包含： `HTTP 429: rate_limit_error: Extra usage is required for long context requests`。

```bash
openclaw logs --follow
openclaw models status
openclaw config get agents.defaults.models
```

[[BLOCK_1]]

- 選擇的 Anthropic Opus/Sonnet 模型具有 `params.context1m: true`。
- 當前的 Anthropic 憑證不符合長上下文使用的資格。
- 請求僅在需要 1M beta 路徑的長會話/模型執行中失敗。

[[BLOCK_1]]  
修正選項：  
[[BLOCK_1]]

1. 禁用 `context1m` 以使該模型回退到正常的上下文窗口。
2. 使用具有計費功能的 Anthropic API 金鑰，或在訂閱帳戶上啟用 Anthropic 額外使用量。
3. 設定回退模型，以便在 Anthropic 長上下文請求被拒絕時，執行能夠繼續進行。

[[BLOCK_1]]

- [/providers/anthropic](/providers/anthropic)
- [/reference/token-use](/reference/token-use)
- [/help/faq#why-am-i-seeing-http-429-ratelimiterror-from-anthropic](/help/faq#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)

## No replies

如果通道已啟動但沒有任何回應，請在重新連接任何設備之前檢查路由和政策。

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw config get channels
openclaw logs --follow
```

[[BLOCK_1]]

- DM 發送者的配對待處理。
- 群組提及限制 (`requireMention`, `mentionPatterns`)。
- 頻道/群組允許清單不匹配。

[[BLOCK_1]]  
常見簽名：  
[[BLOCK_1]]

- `drop guild message (mention required` → 群組訊息在被提及之前將被忽略。
- `pairing request` → 發送者需要批准。
- `blocked` / `allowlist` → 發送者/頻道已被政策過濾。

[[BLOCK_1]]

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Dashboard 控制 UI 連接性

當儀表板/控制介面無法連接時，請驗證 URL、身份驗證模式和安全上下文的假設。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

[[BLOCK_1]]

- 修正探針 URL 和儀表板 URL。
- 用戶端與網關之間的身份驗證模式/token 不匹配。
- 在需要設備身份的情況下使用 HTTP。

[[BLOCK_1]]  
常見簽名：  
[[BLOCK_1]]

- `device identity required` → 非安全環境或缺少設備認證。
- `device nonce required` / `device nonce mismatch` → 用戶端未完成基於挑戰的設備認證流程 (`connect.challenge` + `device.nonce`)。
- `device signature invalid` / `device signature expired` → 用戶端為當前握手簽署了錯誤的有效負載（或過期的時間戳）。
- `AUTH_TOKEN_MISMATCH` 與 `canRetryWithDeviceToken=true` → 用戶端可以使用快取的設備token進行一次受信任的重試。
- 重複 `unauthorized` 在該重試之後 → 共享token/設備token漂移；如果需要，刷新token設定並重新批准/輪換設備token。
- `gateway connect failed:` → 錯誤的主機/端口/網址目標。

### Auth detail codes 快速對照表

使用 `error.details.code` 從失敗的 `connect` 回應中選擇下一步行動：

| 詳細程式碼                   | 意義                                  | 建議行動                                                                                                                                                |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_TOKEN_MISSING`         | 用戶端未發送所需的共享 token。        | 在用戶端中粘貼/設置 token 並重試。對於儀表板路徑：`openclaw config get gateway.auth.token` 然後粘貼到控制 UI 設定中。                                   |
| `AUTH_TOKEN_MISMATCH`        | 共享 token 與閘道認證 token 不匹配。  | 如果 `canRetryWithDeviceToken=true`，允許一次受信任的重試。如果仍然失敗，請執行 [token 漂移恢復檢查清單](/cli/devices#token-drift-recovery-checklist)。 |
| `AUTH_DEVICE_TOKEN_MISMATCH` | 每個設備的快取 token 已過期或被撤銷。 | 使用 [devices CLI](/cli/devices) 旋轉/重新批准設備 token，然後重新連接。                                                                                |
| `PAIRING_REQUIRED`           | 設備身份已知但未獲得此角色的批准。    | 批准待處理請求：`openclaw devices list` 然後 `openclaw devices approve <requestId>`。                                                                   |

Device auth v2 遷移檢查：

```bash
openclaw --version
openclaw doctor
openclaw gateway status
```

如果日誌顯示 nonce/簽名錯誤，請更新連接的用戶端並進行驗證：

1. 等待 `connect.challenge`
2. 簽署挑戰綁定的有效載荷
3. 使用相同的挑戰隨機數發送 `connect.params.device.nonce`

[[BLOCK_1]]

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)
- [/cli/devices](/cli/devices)

## Gateway 服務未啟動

當服務已安裝但進程未保持執行時，請使用此方法。

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

[[BLOCK_1]]

- `Runtime: stopped` 具有退出提示。
- 服務設定不匹配 (`Config (cli)` 與 `Config (service)`)。
- 端口/監聽器衝突。

[[BLOCK_1]]  
常見簽名：  
[[BLOCK_1]]

- `Gateway start blocked: set gateway.mode=local` → 本地閘道模式未啟用。修正方法：在您的設定中設置 `gateway.mode="local"`（或執行 `openclaw configure`）。如果您是通過 Podman 使用專用 `openclaw` 用戶執行 OpenClaw，設定檔位於 `~openclaw/.openclaw/openclaw.json`。
- `refusing to bind gateway ... without auth` → 非迴圈綁定，未提供 token/密碼。
- `another gateway instance is already listening` / `EADDRINUSE` → 端口衝突。

[[BLOCK_1]]

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Channel connected messages not flowing

如果通道狀態為已連接但訊息流無法運作，請專注於政策、權限和通道特定的傳遞規則。

```bash
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

[[BLOCK_1]]

- DM 政策 (`pairing`, `allowlist`, `open`, `disabled`)。
- 群組允許清單和提及要求。
- 缺少的頻道 API 權限/範圍。

常見簽名：

- `mention required` → 訊息被群組提及政策忽略。
- `pairing` / 待批准的追蹤 → 發送者未獲批准。
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → 頻道授權/權限問題。

[[BLOCK_1]]

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron 和心跳傳送

如果 cron 或 heartbeat 沒有執行或未能交付，請先檢查排程器狀態，然後檢查交付目標。

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

[[BLOCK_1]]

- 啟用 Cron 並且有下一次喚醒時間。
- 工作執行歷史狀態 (`ok`, `skipped`, `error`)。
- 心跳跳過原因 (`quiet-hours`, `requests-in-flight`, `alerts-disabled`)。

[[BLOCK_1]]  
常見簽名：  
[[BLOCK_1]]

- `cron: scheduler disabled; jobs will not run automatically` → cron 已禁用。
- `cron: timer tick failed` → 調度器滴答失敗；請檢查檔案/日誌/執行時錯誤。
- `heartbeat skipped` with `reason=quiet-hours` → 超出活躍時間窗口。
- `heartbeat: unknown accountId` → 心跳傳遞目標的帳戶 ID 無效。
- `heartbeat skipped` with `reason=dm-blocked` → 心跳目標解析為 DM 風格的目的地，而 `agents.defaults.heartbeat.directPolicy`（或每個代理的覆蓋）設置為 `block`。

[[BLOCK_1]]

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Node 配對工具失敗

如果節點已配對但工具失敗，請隔離前景、權限和批准狀態。

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

[[BLOCK_1]]

- Node 在線並具備預期的功能。
- 作業系統對相機/麥克風/位置/螢幕的權限授予。
- 執行批准和允許清單狀態。

[[BLOCK_1]]  
常見簽名：  
[[BLOCK_1]]

- `NODE_BACKGROUND_UNAVAILABLE` → node 應用程式必須在前景中執行。
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → 缺少作業系統權限。
- `SYSTEM_RUN_DENIED: approval required` → 執行批准待處理。
- `SYSTEM_RUN_DENIED: allowlist miss` → 命令被允許清單阻擋。

[[BLOCK_1]]

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## 瀏覽器工具失敗

當瀏覽器工具操作失敗時，即使網關本身執行正常，也請使用此方法。

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

[[BLOCK_1]]

- 有效的瀏覽器可執行檔路徑。
- CDP 設定檔可達性。
- 擴充功能中繼標籤附加至 `profile="chrome"`。

[[BLOCK_1]]  
常見簽名：  
[[BLOCK_1]]

- `Failed to start Chrome CDP on port` → 瀏覽器進程啟動失敗。
- `browser.executablePath not found` → 設定的路徑無效。
- `Chrome extension relay is running, but no tab is connected` → 擴充中繼未附加。
- `Browser attachOnly is enabled ... not reachable` → 僅附加的設定檔沒有可達的目標。

[[BLOCK_1]]

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## 如果您升級後突然出現問題

大多數升級後的故障是由於設定漂移或現在強制執行的更嚴格預設值所造成的。

### 1) 認證和 URL 覆蓋行為已更改

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

[[BLOCK_1]]  
要檢查的專案：  
[[BLOCK_1]]

- 如果 `gateway.mode=remote`，CLI 呼叫可能針對遠端，而您的本地服務正常。
- 明確的 `--url` 呼叫不會回退到儲存的憑證。

[[BLOCK_1]]  
常見簽名：  
[[BLOCK_1]]

- `gateway connect failed:` → 錯誤的 URL 目標。
- `unauthorized` → 端點可達但認證錯誤。

### 2) 綁定和身份驗證的防護措施更為嚴格

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

[[BLOCK_1]]  
要檢查的專案：  
[[BLOCK_1]]

- 非迴圈綁定 (`lan`, `tailnet`, `custom`) 需要設定身份驗證。
- 舊金鑰如 `gateway.token` 不會取代 `gateway.auth.token`。

[[BLOCK_1]]  
常見簽名：  
[[BLOCK_1]]

- `refusing to bind gateway ... without auth` → 綁定+驗證不匹配。
- `RPC probe: failed` 當執行時正在執行 → 網關存活但使用當前的驗證/網址無法訪問。

### 3) 配對和裝置身份狀態變更

```bash
openclaw devices list
openclaw pairing list --channel <channel> [--account <id>]
openclaw logs --follow
openclaw doctor
```

[[BLOCK_1]]  
要檢查的專案：  
[[BLOCK_1]]

- 待批准的儀表板/節點設備。
- 在政策或身份變更後，待批准的 DM 配對。

[[BLOCK_1]]  
常見簽名：  
[[BLOCK_1]]

- `device identity required` → 裝置認證未滿足。
- `pairing required` → 發送者/裝置必須獲得批准。

如果服務設定和執行時在檢查後仍然不一致，請從相同的設定檔/狀態目錄重新安裝服務元數據：

```bash
openclaw gateway install --force
openclaw gateway restart
```

[[BLOCK_1]]

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
