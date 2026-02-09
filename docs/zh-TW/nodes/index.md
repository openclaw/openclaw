---
summary: "節點：配對、能力、權限，以及適用於畫布／相機／螢幕／系統的 CLI 輔助工具"
read_when:
  - 將 iOS／Android 節點與 Gateway 閘道器配對
  - 使用節點畫布／相機作為代理程式脈絡
  - 新增節點指令或 CLI 輔助工具
title: "Nodes"
---

# Nodes

**節點** 是一種配套裝置（macOS／iOS／Android／無介面），會連線至 Gateway **WebSocket**（與操作員相同的連接埠），透過 `role: "node"`，並經由 `node.invoke` 暴露指令介面（例如 `canvas.*`、`camera.*`、`system.*`）。通訊協定細節：[Gateway protocol](/gateway/protocol)。 協定細節：[Gateway protocol](/gateway/protocol)。

舊版傳輸方式：[Bridge protocol](/gateway/bridge-protocol)（TCP JSONL；已淘汰／自目前節點移除）。

macOS 也可以在 **節點模式** 下執行：選單列應用程式會連線到 Gateway 的 WS 伺服器，並將其本機的畫布／相機指令作為節點暴露（因此 `openclaw nodes …` 可針對這台 Mac 運作）。

注意事項：

- 節點是**周邊裝置**，不是閘道。 They don’t run the gateway service.
- Telegram／WhatsApp 等訊息會進入 **gateway**，而不是節點。
- 疑難排解手冊：[/nodes/troubleshooting](/nodes/troubleshooting)

## 配對與狀態

**WS 節點使用裝置配對。** 節點在 `connect` 期間提供裝置身分；Gateway 會為 `role: node` 建立裝置配對請求。請透過裝置的 CLI（或 UI）核准。 Approve via the devices CLI (or UI).

快速 CLI：

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

注意事項：

- 當裝置配對角色包含 `node` 時，`nodes status` 會將節點標記為 **已配對**。
- `node.pair.*`（CLI：`openclaw nodes pending/approve/reject`）是獨立、由 gateway 擁有的
  節點配對儲存區；它 **不會** 管控 WS 的 `connect` 握手。

## 遠端節點主機（system.run）

當你的 Gateway 執行在一台機器上，而你希望在另一台機器上執行指令時，請使用 **節點主機**。模型仍然與 **gateway** 對話；當選擇 `host=node` 時，gateway 會將 `exec` 呼叫轉送至 **節點主機**。 模型仍與 **gateway** 溝通；當選擇 `host=node` 時，gateway 會將 `exec` 呼叫轉送至 **node host**。

### What runs where

- **Gateway 主機**：接收訊息、執行模型、路由工具呼叫。
- **節點主機**：在節點機器上執行 `system.run`／`system.which`。
- **核准**：透過 `~/.openclaw/exec-approvals.json` 在節點主機上強制執行。

### Start a node host (foreground)

在節點機器上：

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### 透過 SSH 通道的遠端 Gateway（loopback 綁定）

If the Gateway binds to loopback (`gateway.bind=loopback`, default in local mode),
remote node hosts cannot connect directly. Create an SSH tunnel and point the
node host at the local end of the tunnel.

範例（節點主機 -> gateway 主機）：

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

注意事項：

- 權杖是來自 gateway 設定中的 `gateway.auth.token`（位於 gateway 主機上的 `~/.openclaw/openclaw.json`）。
- `openclaw node run` 會讀取 `OPENCLAW_GATEWAY_TOKEN` 進行驗證。

### Start a node host (service)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### 配對與命名

在 gateway 主機上：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

命名選項：

- 在 `openclaw node run`／`openclaw node install` 上設定 `--display-name`（會持久化於節點上的 `~/.openclaw/node.json`）。
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"`（gateway 覆寫）。

### 將指令加入允許清單

Exec approvals are **per node host**. Add allowlist entries from the gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

核准內容會儲存在節點主機的 `~/.openclaw/exec-approvals.json`。

### Point exec at the node

設定預設值（gateway 設定）：

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Or per session:

```
/exec host=node security=allowlist node=<id-or-name>
```

設定完成後，任何帶有 `host=node` 的 `exec` 呼叫都會在節點主機上執行（需符合節點允許清單／核准）。

相關：

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## 呼叫指令

低階（原始 RPC）：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

對於常見的「為代理程式提供 MEDIA 附件」工作流程，已有更高階的輔助工具。

## 螢幕截圖（畫布快照）

如果節點正在顯示 Canvas（WebView），`canvas.snapshot` 會回傳 `{ format, base64 }`。

CLI 輔助工具（寫入暫存檔並輸出 `MEDIA:<path>`）：

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### 畫布控制

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

注意事項：

- `canvas present` 接受 URL 或本機檔案路徑（`--target`），以及用於定位的選用 `--x/--y/--width/--height`。
- `canvas eval` 接受內嵌 JS（`--js`）或位置參數。

### A2UI（畫布）

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

注意事項：

- 僅支援 A2UI v0.8 JSONL（v0.9／createSurface 會被拒絕）。

## Photos + videos (node camera)

照片（`jpg`）：

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

影片片段（`mp4`）：

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

注意事項：

- `canvas.*` 與 `camera.*` 需要節點處於 **前景**（背景呼叫會回傳 `NODE_BACKGROUND_UNAVAILABLE`）。
- 片段長度會被限制（目前為 `<= 60s`），以避免過大的 base64 負載。
- Android 會在可行時提示 `CAMERA`／`RECORD_AUDIO` 權限；被拒絕的權限會以 `*_PERMISSION_REQUIRED` 失敗。

## 螢幕錄製（節點）

節點會暴露 `screen.record`（mp4）。範例： Example:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

注意事項：

- `screen.record` 需要節點應用程式處於前景。
- Android 會在錄製前顯示系統螢幕擷取提示。
- 螢幕錄製會被限制為 `<= 60s`。
- `--no-audio` 會停用麥克風錄音（iOS／Android 支援；macOS 使用系統擷取音訊）。
- 當有多個螢幕可用時，使用 `--screen <index>` 選擇顯示器。

## 位置（節點）

當設定中啟用位置時，節點會暴露 `location.get`。

CLI 輔助工具：

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

注意事項：

- 位置 **預設為關閉**。
- 「Always」需要系統權限；背景擷取屬於最佳努力。
- 回應包含緯度/經度、精準度（公尺）以及時間戳記。

## 簡訊（Android 節點）

當使用者授予 **SMS** 權限且裝置支援電信功能時，Android 節點可以暴露 `sms.send`。

低階呼叫：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

注意事項：

- 在能力被宣告之前，必須在 Android 裝置上接受權限提示。
- 不具備電信功能、僅 Wi‑Fi 的裝置不會宣告 `sms.send`。

## 系統指令（節點主機／Mac 節點）

macOS 節點會暴露 `system.run`、`system.notify` 與 `system.execApprovals.get/set`。
無介面節點主機會暴露 `system.run`、`system.which` 與 `system.execApprovals.get/set`。
無頭 node host 提供 `system.run`、`system.which` 與 `system.execApprovals.get/set`。

範例：

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

注意事項：

- `system.run` 會在負載中回傳 stdout／stderr／結束碼。
- `system.notify` 會遵循 macOS 應用程式的通知權限狀態。
- `system.run` 支援 `--cwd`、`--env KEY=VAL`、`--command-timeout` 與 `--needs-screen-recording`。
- `system.notify` 支援 `--priority <passive|active|timeSensitive>` 與 `--delivery <system|overlay|auto>`。
- macOS 節點會捨棄 `PATH` 覆寫；無頭 node host 僅在其作為前置加入 node host PATH 時才接受 `PATH`。
- On macOS node mode, `system.run` is gated by exec approvals in the macOS app (Settings → Exec approvals).
  Ask/allowlist/full 的行為與無頭 node host 相同；被拒絕的提示會回傳 `SYSTEM_RUN_DENIED`。
- 在無介面節點主機上，`system.run` 受執行核准（`~/.openclaw/exec-approvals.json`）所管控。

## Exec 節點繫結

When multiple nodes are available, you can bind exec to a specific node.
這會設定 `exec host=node` 的預設節點（且可在每個 agent 中覆寫）。

全域預設：

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

每個 agent 的覆寫：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

取消設定以允許任何節點：

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## 權限對照表

節點可能在 `node.list`／`node.describe` 中包含一個 `permissions` 對照表，
以權限名稱作為鍵（例如 `screenRecording`、`accessibility`），值為布林值（`true` = 已授予）。

## 無介面節點主機（跨平台）

OpenClaw 可執行 **無介面節點主機**（無 UI），連線至 Gateway
WebSocket，並暴露 `system.run`／`system.which`。這對於 Linux／Windows
或在伺服器旁執行最小化節點非常實用。 這在 Linux/Windows 上很有用，或用於在伺服器旁執行最小化節點。

啟動它：

```bash
openclaw node run --host <gateway-host> --port 18789
```

注意事項：

- 仍然需要配對（Gateway 會顯示節點核准提示）。
- 節點主機會將其節點 id、權杖、顯示名稱與 gateway 連線資訊儲存在 `~/.openclaw/node.json`。
- 執行核准會透過 `~/.openclaw/exec-approvals.json` 在本機強制執行
  （請參閱 [Exec approvals](/tools/exec-approvals)）。
- 在 macOS 上，無頭 node host 在可連線時會優先使用伴隨應用程式的 exec host，若應用程式不可用則回退為本地執行。 設定 `OPENCLAW_NODE_EXEC_HOST=app` 以要求使用應用程式，或設定 `OPENCLAW_NODE_EXEC_FALLBACK=0` 以停用回退。
- 當 Gateway WS 使用 TLS 時，請加入 `--tls`／`--tls-fingerprint`。

## Mac 節點模式

- macOS 選單列應用程式會以節點身分連線至 Gateway WS 伺服器（因此 `openclaw nodes …` 可針對這台 Mac 運作）。
- 在遠端模式下，應用程式會為 Gateway 連接埠開啟 SSH 通道，並連線至 `localhost`。
