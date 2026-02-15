---
summary: "節點：配對、功能、權限，以及用於畫布/相機/螢幕/系統的 CLI 輔助工具"
read_when:
  - 將 iOS/Android 節點與 Gateway 配對
  - 使用節點畫布/相機作為智慧代理上下文
  - 新增節點命令或 CLI 輔助工具
title: "節點"
---

# 節點

**節點**是連接到 Gateway **WebSocket**（與操作員使用相同連接埠）的配套裝置（macOS/iOS/Android/無頭），其 `role: "node"` 並透過 `node.invoke` 暴露命令介面（例如 `canvas.*`、`camera.*`、`system.*`）。協定詳情：[Gateway 協定](/gateway/protocol)。

舊版傳輸：[Bridge 協定](/gateway/bridge-protocol) (TCP JSONL；已棄用/從目前的節點中移除)。

macOS 也可以在**節點模式**下執行：選單列應用程式連接到 Gateway 的 WS 伺服器，並將其本地畫布/相機命令公開為節點（因此 `openclaw nodes …` 對於此 Mac 有效）。

注意事項：

- 節點是**週邊裝置**，而不是 Gateway。它們不執行 Gateway 服務。
- Telegram/WhatsApp/等訊息會傳送到 **Gateway**，而不是節點。
- 疑難排解執行手冊：[/nodes/troubleshooting](/nodes/troubleshooting)

## 配對 + 狀態

**WS 節點使用裝置配對。**節點在 `connect` 期間呈現裝置身分；Gateway
會為 `role: node` 建立裝置配對請求。透過裝置 CLI (或 UI) 核准。

快速 CLI：

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

注意事項：

- `nodes status` 會將節點標記為**已配對**，當其裝置配對角色包含 `node` 時。
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) 是一個單獨的、由 Gateway 擁有的
  節點配對儲存；它**不會**阻止 WS `connect` 握手。

## 遠端節點主機 (system.run)

當您的 Gateway 在一台機器上執行，而您希望命令在另一台機器上執行時，請使用**節點主機**。模型仍然與 **Gateway** 對話；當選擇 `host=node` 時，Gateway 會將 `exec` 呼叫轉發到**節點主機**。

### 執行位置

- **Gateway 主機**：接收訊息，執行模型，路由工具呼叫。
- **節點主機**：在節點機器上執行 `system.run`/`system.which`。
- **核准**：透過 `~/.openclaw/exec-approvals.json` 在節點主機上強制執行。

### 啟動節點主機 (前景)

在節點機器上：

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### 透過 SSH 通道 (loopback 綁定) 遠端 Gateway

如果 Gateway 綁定到 loopback (`gateway.bind=loopback`，本地模式中的預設)，
遠端節點主機無法直接連接。建立一個 SSH 通道並將節點主機指向
隧道的本地端。

範例 (節點主機 -> Gateway 主機)：

```bash
# 終端機 A (保持執行)：將本地 18790 轉發到 Gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user @gateway-host

# 終端機 B：匯出 Gateway 權杖並透過通道連接
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

注意事項：

- 權杖是來自 Gateway 設定 (`~/.openclaw/openclaw.json` 在 Gateway 主機上) 的 `gateway.auth.token`。
- `openclaw node run` 讀取 `OPENCLAW_GATEWAY_TOKEN` 進行驗證。

### 啟動節點主機 (服務)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### 配對 + 命名

在 Gateway 主機上：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

命名選項：

- `openclaw node run` / `openclaw node install` 上的 `--display-name` (在節點的 `~/.openclaw/node.json` 中持久儲存)。
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (Gateway 覆寫)。

### 將命令加入允許清單

執行核准是**每個節點主機**。從 Gateway 新增允許清單項目：

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

核准儲存在節點主機的 `~/.openclaw/exec-approvals.json`。

### 將執行指向節點

設定預設值 (Gateway 設定)：

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

或每個工作階段：

```
/exec host=node security=allowlist node=<id-or-name>
```

一旦設定，任何 `exec` 呼叫 (帶有 `host=node`) 都會在節點主機上執行 (受節點允許清單/核准的約束)。

相關：

- [節點主機 CLI](/cli/node)
- [執行工具](/tools/exec)
- [執行核准](/tools/exec-approvals)

## 呼叫命令

低階 (原始 RPC)：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

更高等級的輔助工具適用於常見的「給智慧代理 MEDIA 附件」工作流程。

## 螢幕截圖 (畫布快照)

如果節點顯示 Canvas (WebView)，`canvas.snapshot` 會回傳 `{ format, base64 }`。

CLI 輔助工具 (寫入暫存檔案並列印 `MEDIA:<path>`)：

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### 畫布控制項

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

注意事項：

- `canvas present` 接受 URL 或本地檔案路徑 (`--target`)，以及可選的 `--x/--y/--width/--height` 用於定位。
- `canvas eval` 接受內聯 JS (`--js`) 或位置參數。

### A2UI (畫布)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

注意事項：

- 僅支援 A2UI v0.8 JSONL (v0.9/createSurface 被拒絕)。

## 照片 + 影片 (節點相機)

照片 (`jpg`)：

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # 預設：兩個方向 (2 個 MEDIA 行)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

影片片段 (`mp4`)：

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

注意事項：

- 節點必須**處於前景**才能使用 `canvas.*` 和 `camera.*` (背景呼叫回傳 `NODE_BACKGROUND_UNAVAILABLE`)。
- 影片片段持續時間會被限制 (目前 `<= 60s`)，以避免過大的 base64 酬載。
- Android 會在可能的情況下提示 `CAMERA`/`RECORD_AUDIO` 權限；拒絕的權限會導致 `*_PERMISSION_REQUIRED` 失敗。

## 螢幕錄影 (節點)

節點暴露 `screen.record` (mp4)。範例：

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

注意事項：

- `screen.record` 需要節點應用程式處於前景。
- Android 會在錄影前顯示系統螢幕擷取提示。
- 螢幕錄影會被限制在 `<= 60s`。
- `--no-audio` 會停用麥克風擷取 (iOS/Android 支援；macOS 使用系統擷取音訊)。
- 當有多個螢幕可用時，使用 `--screen <index>` 選擇顯示器。

## 位置 (節點)

當設定中啟用位置時，節點會暴露 `location.get`。

CLI 輔助工具：

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

注意事項：

- 位置**預設為關閉**。
- 「永遠」需要系統權限；背景擷取是盡力而為的。
- 回傳包括緯度/經度、準確度 (公尺) 和時間戳記。

## 簡訊 (Android 節點)

當使用者授予 **SMS** 權限且裝置支援通話功能時，Android 節點可以暴露 `sms.send`。

低階呼叫：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

注意事項：

- 在 Android 裝置上必須接受權限提示後，才能宣告該功能。
- 沒有通話功能的純 Wi-Fi 裝置將不會宣告 `sms.send`。

## 系統命令 (節點主機 / Mac 節點)

macOS 節點暴露 `system.run`、`system.notify` 和 `system.execApprovals.get/set`。
無頭節點主機暴露 `system.run`、`system.which` 和 `system.execApprovals.get/set`。

範例：

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

注意事項：

- `system.run` 在酬載中回傳標準輸出/標準錯誤/結束碼。
- `system.notify` 遵守 macOS 應用程式上的通知權限狀態。
- `system.run` 支援 `--cwd`、`--env KEY=VAL`、`--command-timeout` 和 `--needs-screen-recording`。
- `system.notify` 支援 `--priority <passive|active|timeSensitive>` 和 `--delivery <system|overlay|auto>`。
- macOS 節點會捨棄 `PATH` 覆寫；無頭節點主機僅在 `PATH` 預先附加到節點主機 PATH 時才接受 `PATH`。
- 在 macOS 節點模式下，`system.run` 受 macOS 應用程式中執行核准的限制 (設定 → 執行核准)。
  詢問/允許清單/完全的行為與無頭節點主機相同；被拒絕的提示會回傳 `SYSTEM_RUN_DENIED`。
- 在無頭節點主機上，`system.run` 受執行核准的限制 (`~/.openclaw/exec-approvals.json`)。

## 執行節點綁定

當有多個節點可用時，您可以將執行綁定到特定節點。
這會為 `exec host=node` 設定預設節點 (並且可以針對每個智慧代理覆寫)。

全域預設：

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

每個智慧代理覆寫：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

取消設定以允許任何節點：

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## 權限對應

節點可能在 `node.list` / `node.describe` 中包含 `permissions` 對應，以權限名稱 (例如 `screenRecording`、`accessibility`) 為鍵，布林值 ( `true` = 已授予) 為值。

## 無頭節點主機 (跨平台)

OpenClaw 可以執行**無頭節點主機** (無 UI)，它連接到 Gateway
WebSocket 並暴露 `system.run` / `system.which`。這在 Linux/Windows
或與伺服器同時執行最小節點時非常有用。

啟動它：

```bash
openclaw node run --host <gateway-host> --port 18789
```

注意事項：

- 仍然需要配對 (Gateway 會顯示節點核准提示)。
- 節點主機將其節點 ID、權杖、顯示名稱和 Gateway 連接資訊儲存在 `~/.openclaw/node.json` 中。
- 執行核准會透過 `~/.openclaw/exec-approvals.json` 在本地強制執行
  (請參閱 [執行核准](/tools/exec-approvals))。
- 在 macOS 上，無頭節點主機偏好配套應用程式執行主機 (如果可達)，如果應用程式不可用，則回退到本地執行。設定 `OPENCLAW_NODE_EXEC_HOST=app` 以要求應用程式，或設定 `OPENCLAW_NODE_EXEC_FALLBACK=0` 以停用回退。
- 當 Gateway WS 使用 TLS 時，新增 `--tls` / `--tls-fingerprint`。

## Mac 節點模式

- macOS 選單列應用程式作為節點連接到 Gateway WS 伺服器 (因此 `openclaw nodes …` 對於此 Mac 有效)。
- 在遠端模式下，應用程式會為 Gateway 連接埠開啟 SSH 通道並連接到 `localhost`。
