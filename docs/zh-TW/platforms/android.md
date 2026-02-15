---
summary: "Android 應用程式 (node)：連線指南 + Canvas/Chat/Camera"
read_when:
  - 配對或重新連線 Android node
  - 偵鎖 Android Gateway 裝置探索或驗證
  - 驗證不同用戶端間聊天紀錄的一致性
title: "Android 應用程式"
---

# Android 應用程式 (Node)

## 支援概況

- 角色：配套 node 應用程式（Android 不會託管 Gateway）。
- 需要 Gateway：是（請在 macOS、Linux 或 Windows 的 WSL2 上執行）。
- 安裝：[入門指南](/start/getting-started) + [配對](/gateway/pairing)。
- Gateway：[指南](/gateway) + [設定](/gateway/configuration)。
  - 協定：[Gateway 協定](/gateway/protocol)（nodes + 控制平面）。

## 系統控制

系統控制 (launchd/systemd) 位於 Gateway 主機。請參閱 [Gateway](/gateway)。

## 連線指南

Android node 應用程式 ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android 直接連線至 Gateway WebSocket（預設為 `ws://<host>:18789`）並使用 Gateway 擁有的配對功能。

### 先決條件

- 您可以在「主要」機器上執行 Gateway。
- Android 裝置/模擬器可以存取 Gateway WebSocket：
  - 具有 mDNS/NSD 的同一區域網路，**或**
  - 使用 Wide-Area Bonjour / 單點傳送 DNS-SD 的同一 Tailscale tailnet（見下文），**或**
  - 手動輸入 Gateway 主機/連接埠（備援）
- 您可以在 Gateway 機器上執行 CLI (`openclaw`)（或透過 SSH）。

### 1) 啟動 Gateway

```bash
openclaw gateway --port 18789 --verbose
```

確認在日誌中看到類似以下內容：

- `listening on ws://0.0.0.0:18789`

對於僅限 tailnet 的設定（推薦用於維也納 ⇄ 倫敦），請將 Gateway 繫結至 tailnet IP：

- 在 Gateway 主機的 `~/.openclaw/openclaw.json` 中設定 `gateway.bind: "tailnet"`。
- 重啟 Gateway / macOS 選單列應用程式。

### 2) 驗證裝置探索（選用）

在 Gateway 機器上執行：

```bash
dns-sd -B _openclaw-gw._tcp local.
```

更多偵錯筆記：[Bonjour](/gateway/bonjour)。

#### 透過單點傳送 DNS-SD 進行 Tailnet（維也納 ⇄ 倫敦）裝置探索

Android NSD/mDNS 裝置探索無法跨越網路。如果您的 Android node 與 Gateway 位在不同網路，但已透過 Tailscale 連線，請改用 Wide-Area Bonjour / 單點傳送 DNS-SD：

1. 在 Gateway 主機上設定 DNS-SD 區域（例如 `openclaw.internal.`）並發布 `_openclaw-gw._tcp` 紀錄。
2. 為您選擇的網域設定 Tailscale 分離式 DNS (split DNS)，並指向該 DNS 伺服器。

詳細資訊與 CoreDNS 設定範例：[Bonjour](/gateway/bonjour)。

### 3) 從 Android 連線

在 Android 應用程式中：

- 應用程式透過 **前景服務**（持續性通知）保持其 Gateway 連線。
- 開啟 **Settings**。
- 在 **Discovered Gateways** 下，選擇您的 Gateway 並按下 **Connect**。
- 如果 mDNS 被封鎖，請使用 **Advanced → Manual Gateway**（主機 + 連接埠）並點擊 **Connect (Manual)**。

首次配對成功後，Android 會在啟動時自動重新連線：

- 手動端點（如果已啟用），否則
- 上次探索到的 Gateway（盡力而為）。

### 4) 核准配對 (CLI)

在 Gateway 機器上執行：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

配對詳細資訊：[Gateway 配對](/gateway/pairing)。

### 5) 驗證 node 已連線

- 透過 nodes 狀態：

  ```bash
  openclaw nodes status
  ```

- 透過 Gateway：

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) 聊天 + 紀錄

Android node 的聊天分頁使用 Gateway 的 **主要工作階段金鑰** (`main`)，因此紀錄與回覆會與 WebChat 及其他用戶端共享：

- 紀錄：`chat.history`
- 傳送：`chat.send`
- 推播更新（盡力而為）：`chat.subscribe` → `event:"chat"`

### 7) Canvas + 相機

#### Gateway Canvas 主機（推薦用於網頁內容）

如果您希望 node 顯示智慧代理可以在磁碟上編輯的真實 HTML/CSS/JS，請將 node 指向 Gateway canvas 主機。

注意：nodes 使用 `canvasHost.port`（預設為 `18793`）上的獨立 canvas 主機。

1. 在 Gateway 主機上建立 `~/.openclaw/workspace/canvas/index.html`。

2. 將 node 導向該路徑（區域網路）：

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet（選用）：如果兩台裝置都在 Tailscale 上，請使用 MagicDNS 名稱或 tailnet IP 取代 `.local`，例如 `http://<gateway-magicdns>:18793/__openclaw__/canvas/`。

此伺服器會將即時重載 (live-reload) 用戶端注入 HTML，並在檔案變更時重新載入。
A2UI 主機位於 `http://<gateway-host>:18793/__openclaw__/a2ui/`。

Canvas 指令（僅限前景）：

- `canvas.eval`、`canvas.snapshot`、`canvas.navigate`（使用 `{"url":""}` 或 `{"url":"/"}` 返回預設支架）。`canvas.snapshot` 會回傳 `{ format, base64 }`（預設為 `format="jpeg"`）。
- A2UI：`canvas.a2ui.push`、`canvas.a2ui.reset`（`canvas.a2ui.pushJSONL` 為舊版別名）

相機指令（僅限前景；受權限管控）：

- `camera.snap` (jpg)
- `camera.clip` (mp4)

請參閱 [Camera node](/nodes/camera) 了解參數與 CLI 小幫手。
