---
summary: "Nodes：canvas/camera/screen/system 的配對、功能、權限及 CLI 輔助工具"
read_when:
  - 將 iOS/Android nodes 配對至 Gateway 時
  - 使用 node canvas/camera 作為智慧代理上下文時
  - 新增 node 指令或 CLI 輔助工具時
title: "Nodes"
---

# Nodes

**node** 是一個配套裝置（macOS/iOS/Android/無介面），透過 `role: "node"` 連接到 Gateway 的 **WebSocket**（與操作員使用的連接埠相同），並透過 `node.invoke` 公開指令介面（例如 `canvas.*`、`camera.*`、`system.*`）。協定詳情：[Gateway 協定](/gateway/protocol)。

舊版傳輸方式：[Bridge 協定](/gateway/bridge-protocol)（TCP JSONL；目前的 nodes 已棄用/移除）。

macOS 也可以在 **node 模式**下執行：選單列應用程式會連接到 Gateway 的 WS 伺服器，並將其本地的 canvas/camera 指令公開為 node（因此 `openclaw nodes …` 可以對這台 Mac 運作）。

注意事項：

- Nodes 是**週邊裝置**，不是 Gateway。它們不會執行 Gateway 服務。
- Telegram/WhatsApp 等訊息會傳送到 **Gateway**，而不是 nodes。
- 疑難排解手冊：[/nodes/troubleshooting](/nodes/troubleshooting)

## 配對與狀態

**WS nodes 使用裝置配對。** Nodes 在 `connect` 期間會提供裝置識別；Gateway 會針對 `role: node` 建立裝置配對請求。請透過 devices CLI（或 UI）進行核准。

快速 CLI：

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

注意事項：

- 當裝置配對角色包含 `node` 時，`nodes status` 會將該 node 標記為**已配對**。
- `node.pair.*`（CLI：`openclaw nodes pending/approve/reject`）是一個獨立的由 Gateway 管理的 node 配對儲存庫；它**不會**阻擋 WS 的 `connect` 交握。

## 遠端 node 主機 (system.run)

當您的 Gateway 在一台機器上執行，而您希望在另一台機器上執行指令時，請使用 **node host**。模型仍然與 **Gateway** 通訊；當選擇 `host=node` 時，Gateway 會將 `exec` 呼叫轉發給 **node host**。

### 各元件執行位置

- **Gateway 主機**：接收訊息、執行模型、路由工具呼叫。
- **Node 主機**：在 node 機器上執行 `system.run`/`system.which`。
- **核准**：透過 node 主機上的 `~/.openclaw/exec-approvals.json` 強制執行。

### 啟動 node host（前台執行）

在 node 機器上：

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### 透過 SSH 通道連接遠端 Gateway (local loopback 綁定)

如果 Gateway 綁定到 local loopback（`gateway.bind=loopback`，本地模式下的預設值），則遠端 node host 無法直接連接。請建立 SSH 通道，並將 node host 指向通道的本地端。

範例（node host -> Gateway 主機）：

```bash
# 終端機 A（保持執行）：轉發本地 18790 -> Gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user @gateway-host

# 終端機 B：匯出 Gateway token 並透過通道連接
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

注意事項：

- Token 是來自 Gateway 設定（Gateway 主機上的 `~/.openclaw/openclaw.json`）中的 `gateway.auth.token`。
- `openclaw node run` 會讀取 `OPENCLAW_GATEWAY_TOKEN` 進行驗證。

### 啟動 node host（服務模式）

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### 配對與命名

在 Gateway 主機上：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

命名選項：

- `openclaw node run` / `openclaw node install` 上的 `--display-name`（持久化儲存在 node 的 `~/.openclaw/node.json` 中）。
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"`（由 Gateway 覆寫）。

### 將指令加入白名單

Exec 核准是**基於每個 node host** 的。從 Gateway 新增白名單條目：

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

核准資訊儲存在 node 主機的 `~/.openclaw/exec-approvals.json`。

### 將 exec 指向 node

設定預設值（Gateway 設定）：

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

或針對每個工作階段：

```
/exec host=node security=allowlist node=<id-or-name>
```

設定完成後，任何帶有 `host=node` 的 `exec` 呼叫都會在 node host 上執行（受 node 白名單/核准限制）。

相關連結：

- [Node host CLI](/cli/node)
- [Exec 工具](/tools/exec)
- [Exec 核准](/tools/exec-approvals)

## 叫用指令

底層（原始 RPC）：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

針對常見的「為智慧代理提供 MEDIA 附件」工作流程，已提供高階輔助工具。

## 螢幕截圖（canvas 快照）

如果 node 正在顯示 Canvas (WebView)，`canvas.snapshot` 會回傳 `{ format, base64 }`。

CLI 輔助工具（寫入暫存檔並列印 `MEDIA:<路徑>`）：

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas 控制

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

注意事項：

- `canvas present` 接受 URL 或本地檔案路徑 (`--target`)，以及用於定位的可選參數 `--x/--y/--width/--height`。
- `canvas eval` 接受行內 JS (`--js`) 或位置參數。

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

注意事項：

- 僅支援 A2UI v0.8 JSONL（v0.9/createSurface 會被拒絕）。

## 照片與影片（node 相機）

照片 (`jpg`)：

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # 預設：雙面鏡頭（2 行 MEDIA）
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

影片剪輯 (`mp4`)：

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

注意事項：

- 執行 `canvas.*` 和 `camera.*` 時，node 必須處於**前台**（後台呼叫會回傳 `NODE_BACKGROUND_UNAVAILABLE`）。
- 影片剪輯時長受限（目前為 `<= 60s`），以避免 base64 有效負載過大。
- Android 會在可能的情況下提示 `CAMERA`/`RECORD_AUDIO` 權限；拒絕權限將導致 `*_PERMISSION_REQUIRED` 錯誤。

## 螢幕錄影 (nodes)

Nodes 公開 `screen.record` (mp4)。範例：

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

注意事項：

- `screen.record` 要求 node 應用程式必須處於前台。
- Android 在錄製前會顯示系統螢幕擷取提示。
- 螢幕錄影受限於 `<= 60s`。
- `--no-audio` 會停用麥克風收音（支援 iOS/Android；macOS 使用系統擷取音訊）。
- 當有多個螢幕可用時，使用 `--screen <索引>` 來選擇顯示器。

## 位置 (nodes)

當設定中啟用了「位置」時，nodes 會公開 `location.get`。

CLI 輔助工具：

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

注意事項：

- 位置功能**預設為關閉**。
- 「始終允許」需要系統權限；後台獲取是盡力而為的。
- 回應包含經緯度、精準度（公尺）和時間戳記。

## 簡訊 (Android nodes)

當使用者授予 **SMS** 權限且裝置支援電話功能時，Android nodes 可以公開 `sms.send`。

底層叫用：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

注意事項：

- 在宣佈該功能之前，必須在 Android 裝置上接受權限提示。
- 不具備電話功能的僅限 Wi-Fi 裝置不會宣佈 `sms.send`。

## 系統指令 (node host / mac node)

macOS node 公開 `system.run`、`system.notify` 以及 `system.execApprovals.get/set`。
無介面 (headless) node host 公開 `system.run`、`system.which` 以及 `system.execApprovals.get/set`。

範例：

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

注意事項：

- `system.run` 會在有效負載中回傳 stdout/stderr/結束代碼。
- `system.notify` 遵循 macOS 應用程式上的通知權限狀態。
- `system.run` 支援 `--cwd`、`--env KEY=VAL`、`--command-timeout` 和 `--needs-screen-recording`。
- `system.notify` 支援 `--priority <passive|active|timeSensitive>` 和 `--delivery <system|overlay|auto>`。
- macOS nodes 會捨棄 `PATH` 覆寫；無介面 node host 僅在 `PATH` 前置於 node host PATH 時才接受它。
- 在 macOS node 模式下，`system.run` 受 macOS 應用程式中的 exec 核准限制（設定 → Exec 核准）。詢問/白名單/完整模式的行為與無介面 node host 相同；被拒絕的提示會回傳 `SYSTEM_RUN_DENIED`。
- 在無介面 node host 上，`system.run` 受 exec 核准限制（`~/.openclaw/exec-approvals.json`）。

## Exec node 綁定

當有多個 nodes 可用時，您可以將 exec 綁定到特定的 node。
這會設定 `exec host=node` 的預設 node（且可以針對每個智慧代理進行覆寫）。

全域預設值：

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

每個智慧代理的覆寫：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

取消設定以允許任何 node：

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## 權限對照表

Nodes 可能在 `node.list` / `node.describe` 中包含一個 `permissions` 對照表，以權限名稱為鍵（例如 `screenRecording`、`accessibility`），其值為布林值（`true` = 已授予）。

## 無介面 node host（跨平台）

OpenClaw 可以執行**無介面 node host**（無 UI），它會連接到 Gateway WebSocket 並公開 `system.run` / `system.which`。這在 Linux/Windows 上或在伺服器旁執行最小化的 node 時非常有用。

啟動：

```bash
openclaw node run --host <gateway-host> --port 18789
```

注意事項：

- 仍需要配對（Gateway 將顯示 node 核准提示）。
- node host 會將其 node ID、token、顯示名稱和 Gateway 連線資訊儲存在 `~/.openclaw/node.json` 中。
- Exec 核准是在本地透過 `~/.openclaw/exec-approvals.json` 強制執行的（請參閱 [Exec 核准](/tools/exec-approvals)）。
- 在 macOS 上，無介面 node host 在可連及時優先使用配套應用程式 (companion app) 的 exec host，若應用程式不可用則回退到本地執行。設定 `OPENCLAW_NODE_EXEC_HOST=app` 以要求使用應用程式，或設定 `OPENCLAW_NODE_EXEC_FALLBACK=0` 以停用回退。
- 當 Gateway WS 使用 TLS 時，請新增 `--tls` / `--tls-fingerprint`。

## Mac node 模式

- macOS 選單列應用程式作為 node 連接到 Gateway WS 伺服器（因此 `openclaw nodes …` 可以對這台 Mac 運作）。
- 在遠端模式下，應用程式會為 Gateway 連接埠開啟 SSH 通道並連接到 `localhost`。
