---
summary: >-
  Nodes: pairing, capabilities, permissions, and CLI helpers for
  canvas/camera/screen/device/notifications/system
read_when:
  - Pairing iOS/Android nodes to a gateway
  - Using node canvas/camera for agent context
  - Adding new node commands or CLI helpers
title: Nodes
---

# 節點 (Nodes)

**節點** 是一種伴隨裝置（macOS/iOS/Android/無頭模式），透過 `role: "node"` 連接到 Gateway 的 **WebSocket**（與操作員相同的埠口），並透過 `node.invoke` 暴露指令介面（例如 `canvas.*`、`camera.*`、`device.*`、`notifications.*`、`system.*`）。協議細節請參考：[Gateway protocol](/gateway/protocol)。

舊版傳輸方式：使用 [Bridge protocol](/gateway/bridge-protocol)（TCP JSONL；已過時／目前節點已移除）。

macOS 也可以以 **節點模式** 執行：選單列應用程式連接到 Gateway 的 WS 伺服器，並將本地的畫布／相機指令作為節點暴露（因此 `openclaw nodes …` 可對此 Mac 運作）。

注意事項：

- 節點是 **周邊設備**，非 Gateway。它們不執行 Gateway 服務。
- Telegram／WhatsApp 等訊息會送達 **Gateway**，不會送到節點。
- 疑難排解手冊：[/nodes/troubleshooting](/nodes/troubleshooting)

## 配對與狀態

**WS 節點使用裝置配對。** 節點在 `connect` 過程中會呈現裝置身份；Gateway 會為 `role: node` 建立裝置配對請求。請透過裝置 CLI（或 UI）批准。

快速 CLI 指令：

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

注意事項：

- 當節點的裝置配對角色包含 `node` 時，`nodes status` 會將該節點標記為 **已配對**。
- `node.pair.*`（CLI 指令：`openclaw nodes pending/approve/reject`）是獨立的 Gateway 擁有的節點配對儲存庫；它 **不會** 阻擋 WS `connect` 握手。

## 遠端節點主機 (system.run)

當 Gateway 執行在一台機器上，而你希望指令在另一台機器執行時，請使用 **節點主機**。模型仍與 **Gateway** 通訊；當選擇 `host=node` 時，Gateway 會將 `exec` 呼叫轉發給 **節點主機**。

### 各項服務執行位置

- **Gateway 主機**：接收訊息、執行模型、路由工具呼叫。
- **Node 主機**：在節點機器上執行 `system.run`/`system.which`。
- **核准**：透過 `~/.openclaw/exec-approvals.json` 在節點主機上強制執行。

核准說明：

- 具核准支援的節點會綁定精確的請求上下文。
- 對於直接的 shell/執行時檔案執行，OpenClaw 也會盡力綁定一個具體的本地檔案操作數，若該檔案在執行前有變更則拒絕執行。
- 若 OpenClaw 無法精確識別執行器/執行時命令的唯一具體本地檔案，則會拒絕具核准支援的執行，而非假裝有完整的執行時覆蓋。請使用沙箱、分離主機，或明確的信任允許清單/完整工作流程以支援更廣泛的執行器語義。

### 啟動 node 主機（前景模式）

在節點機器上：

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### 透過 SSH 隧道遠端連接 gateway（loopback 綁定）

若 Gateway 綁定在 loopback (`gateway.bind=loopback`，本地模式預設)，遠端 node 主機無法直接連線。請建立 SSH 隧道，並將 node 主機指向隧道的本地端。

範例（node 主機 -> gateway 主機）：

bash

# 終端機 A（保持執行）：將本地 18790 轉發到 gateway 127.0.0.1:18789

ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# 終端機 B：匯出 gateway token 並透過隧道連線

export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"

注意事項：

- `openclaw node run` 支援 token 或密碼驗證。
- 環境變數為首選：`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`。
- 設定檔備援為 `gateway.auth.token` / `gateway.auth.password`。
- 本地模式下，node 主機會故意忽略 `gateway.remote.token` / `gateway.remote.password`。
- 遠端模式下，`gateway.remote.token` / `gateway.remote.password` 依遠端優先規則有效。
- 若設定了活動的本地 `gateway.auth.*` SecretRefs 但未解析，node 主機驗證將封閉失敗。
- 舊版 `CLAWDBOT_GATEWAY_*` 環境變數會被 node 主機驗證解析故意忽略。

### 啟動 node 主機（服務模式）

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### 配對 + 名稱

在閘道主機上：

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

命名選項：

- `--display-name` 在 `openclaw node run` / `openclaw node install`（會保存在節點上的 `~/.openclaw/node.json` 中）。
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"`（閘道覆寫）。

### 允許清單命令

執行批准是**每個節點主機**的。從閘道新增允許清單條目：

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

批准資料存放在節點主機的 `~/.openclaw/exec-approvals.json`。

### 指定執行目標節點

設定預設值（閘道設定）：

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

或每個工作階段：

```
/exec host=node security=allowlist node=<id-or-name>
```

設定完成後，任何帶有 `host=node` 的 `exec` 呼叫都會在節點主機上執行（受節點允許清單/批准限制）。

相關連結：

- [Node host CLI](/cli/node)
- [Exec 工具](/tools/exec)
- [Exec 批准](/tools/exec-approvals)

## 呼叫指令

低階（原始 RPC）：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

針對常見的「給代理一個 MEDIA 附件」工作流程，有更高階的輔助工具。

## 螢幕截圖（Canvas 快照）

如果節點正在顯示 Canvas（WebView），`canvas.snapshot` 會回傳 `{ format, base64 }`。

CLI 輔助工具（寫入暫存檔並列印 `MEDIA:<path>`）：

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas 控制項

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

備註：

- `canvas present` 可接受 URL 或本機檔案路徑 (`--target`)，並可選擇性帶入 `--x/--y/--width/--height` 來定位。
- `canvas eval` 可接受內嵌 JS (`--js`) 或位置參數。

### A2UI（Canvas）

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

注意事項：

- 僅支援 A2UI v0.8 JSONL（v0.9/createSurface 會被拒絕）。

## 照片 + 影片（節點相機）

照片 (`jpg`)：

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

影片剪輯 (`mp4`)：

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

注意事項：

- 節點必須為**前景**狀態才能使用 `canvas.*` 和 `camera.*`（背景呼叫會回傳 `NODE_BACKGROUND_UNAVAILABLE`）。
- 影片剪輯長度有限制（目前為 `<= 60s`），以避免過大的 base64 負載。
- Android 會在可能的情況下提示要求 `CAMERA`/`RECORD_AUDIO` 權限；若權限被拒，則會以 `*_PERMISSION_REQUIRED` 失敗。

## 螢幕錄影（節點）

支援的節點會提供 `screen.record`（mp4）。範例：

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

注意事項：

- `screen.record` 的可用性取決於節點平台。
- 螢幕錄影長度限制為 `<= 60s`。
- `--no-audio` 在支援的平台上會關閉麥克風錄音。
- 當有多個螢幕時，使用 `--screen <index>` 選擇顯示器。

## 位置（節點）

當設定中啟用位置功能時，節點會暴露 `location.get`。

CLI 輔助工具：

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

注意事項：

- 位置功能預設為**關閉**。
- 「始終」需要系統權限；背景抓取則為盡力而為。
- 回應包含緯度/經度、精確度（公尺）及時間戳記。

## 簡訊（Android 節點）

當使用者授予**簡訊**權限且裝置支援電話功能時，Android 節點可暴露 `sms.send`。

低階調用：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

注意事項：

- 權限提示必須在 Android 裝置上被接受，該功能才會被宣告。
- 不具電話功能的 Wi-Fi 專用裝置不會宣告 `sms.send`。

## Android 裝置 + 個人資料指令

當對應功能被啟用時，Android 節點可宣告額外的指令群組。

可用的指令群組：

- `device.status`, `device.info`, `device.permissions`, `device.health`
- `notifications.list`, `notifications.actions`
- `photos.latest`
- `contacts.search`, `contacts.add`
- `calendar.events`, `calendar.add`
- `motion.activity`, `motion.pedometer`

範例調用：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command device.status --params '{}'
openclaw nodes invoke --node <idOrNameOrIp> --command notifications.list --params '{}'
openclaw nodes invoke --node <idOrNameOrIp> --command photos.latest --params '{"limit":1}'
```

注意事項：

- 動作指令會依可用感測器的能力限制而有所不同。

## 系統指令（node host / mac node）

macOS 節點提供 `system.run`、`system.notify` 和 `system.execApprovals.get/set`。
無頭節點主機提供 `system.run`、`system.which` 和 `system.execApprovals.get/set`。

範例：

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

注意事項：

- `system.run` 會在回傳資料中包含 stdout/stderr/退出碼。
- `system.notify` 會遵守 macOS 應用程式的通知權限狀態。
- 未識別的節點 `platform` / `deviceFamily` 元資料會使用保守的預設允許清單，排除 `system.run` 和 `system.which`。如果您有意在未知平台使用這些指令，請透過 `gateway.nodes.allowCommands` 明確加入。
- `system.run` 支援 `--cwd`、`--env KEY=VAL`、`--command-timeout` 和 `--needs-screen-recording`。
- 對於 shell 包裝器（`bash|sh|zsh ... -c/-lc`），請求範圍的 `--env` 值會被縮減為明確的允許清單（`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`）。
- 在允許清單模式下的永久允許決策中，已知的調度包裝器（`env`、`nice`、`nohup`、`stdbuf`、`timeout`）會持久化內部可執行檔路徑，而非包裝器路徑。如果解包不安全，則不會自動持久化允許清單條目。
- 在 Windows 節點主機的允許清單模式中，透過 `cmd.exe /c` 執行的 shell 包裝器需要批准（僅有允許清單條目不會自動允許包裝器形式）。
- `system.notify` 支援 `--priority <passive|active|timeSensitive>` 和 `--delivery <system|overlay|auto>`。
- 節點主機會忽略 `PATH` 的覆寫，並剝除危險的啟動/shell 鍵（`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`、`SHELLOPTS`、`PS4`）。如果您需要額外的 PATH 專案，請設定節點主機服務環境（或將工具安裝在標準位置），而非透過 `--env` 傳遞 `PATH`。
- 在 macOS 節點模式中，`system.run` 受 macOS 應用程式中的執行批准限制（設定 → 執行批准）。
  詢問/允許清單/完全模式行為與無頭節點主機相同；拒絕提示會回傳 `SYSTEM_RUN_DENIED`。
- 在無頭節點主機中，`system.run` 受執行批准限制（`~/.openclaw/exec-approvals.json`）。

## Exec 節點綁定

當有多個節點可用時，您可以將 exec 綁定到特定節點。
這會設定 `exec host=node` 的預設節點（且可針對每個代理覆寫）。

全域預設：

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Per-agent 覆寫：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

未設定則允許任何節點：

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## 權限映射

節點可在 `node.list` / `node.describe` 中包含一個 `permissions` 映射，以權限名稱為鍵（例如 `screenRecording`、`accessibility`），值為布林值（`true` = 已授權）。

## 無頭節點主機（跨平台）

OpenClaw 可以執行一個**無頭節點主機**（無使用者介面），該主機連接到 Gateway WebSocket 並暴露 `system.run` / `system.which`。這在 Linux/Windows 上或與伺服器並行執行輕量節點時非常有用。

啟動方式：

```bash
openclaw node run --host <gateway-host> --port 18789
```

注意事項：

- 仍需配對（Gateway 會顯示裝置配對提示）。
- 節點主機會將其節點 ID、token、顯示名稱及 Gateway 連線資訊儲存在 `~/.openclaw/node.json`。
- Exec 批准會透過 `~/.openclaw/exec-approvals.json` 在本地強制執行
  （詳見 [Exec approvals](/tools/exec-approvals)）。
- 在 macOS 上，無頭節點主機預設會在本地執行 `system.run`。設定
  `OPENCLAW_NODE_EXEC_HOST=app` 可將 `system.run` 路由至 companion app exec 主機；加入
  `OPENCLAW_NODE_EXEC_FALLBACK=0` 則會要求 app 主機，若無法使用則強制失敗。
- 當 Gateway WS 使用 TLS 時，請加入 `--tls` / `--tls-fingerprint`。

## Mac 節點模式

- macOS 選單列應用程式會以節點身份連接到 Gateway WS 伺服器（因此 `openclaw nodes …` 可對此 Mac 生效）。
- 在遠端模式下，該應用程式會為 Gateway 埠開啟 SSH 隧道並連接到 `localhost`。
