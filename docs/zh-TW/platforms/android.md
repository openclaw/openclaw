---
summary: "Android 應用程式 (節點): 連線操作手冊 + Canvas/聊天/相機"
read_when:
  - 配對或重新連線 Android 節點
  - 偵錯 Android Gateway 裝置探索或驗證
  - 驗證用戶端之間的聊天記錄一致性
title: "Android 應用程式"
---

# Android 應用程式 (節點)

## 支援快照

- 角色：配套節點應用程式 (Android 不託管 Gateway)。
- 需要 Gateway：是 (在 macOS、Linux 或透過 WSL2 的 Windows 上執行)。
- 安裝：[入門指南](/start/getting-started) + [配對](/gateway/pairing)。
- Gateway：[操作手冊](/gateway) + [設定](/gateway/configuration)。
  - 協定：[Gateway 協定](/gateway/protocol) (節點 + 控制平面)。

## 系統控制

系統控制 (launchd/systemd) 位於 Gateway 主機上。請參閱 [Gateway](/gateway)。

## 連線操作手冊

Android 節點應用程式 ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android 直接連線到 Gateway WebSocket (預設 `ws://<host>:18789) 並使用 Gateway 擁有的配對。

### 先決條件

- 您可以在「主」機器上執行 Gateway。
- Android 裝置/模擬器可以連線到 Gateway WebSocket：
  - 與 mDNS/NSD 位於相同的 LAN，**或**
  - 使用 Wide-Area Bonjour / 單點傳播 DNS-SD 位於相同的 Tailscale tailnet (請參閱下方)，**或**
  - 手動 Gateway 主機/埠 (備用)
- 您可以在 Gateway 機器上執行 CLI (`openclaw`) (或透過 SSH)。

### 1) 啟動 Gateway

```bash
openclaw gateway --port 18789 --verbose
```

在日誌中確認您看到類似以下的訊息：

- `listening on ws://0.0.0.0:18789`

對於僅限 tailnet 的設定 (推薦用於 Vienna ⇄ London)，將 Gateway 綁定到 tailnet IP：

- 在 Gateway 主機上的 `~/.openclaw/openclaw.json` 中設定 `gateway.bind: "tailnet"`。
- 重新啟動 Gateway / macOS 選單列應用程式。

### 2) 驗證裝置探索 (可選)

從 Gateway 機器：

```bash
dns-sd -B _openclaw-gw._tcp local.
```

更多偵錯筆記：[Bonjour](/gateway/bonjour)。

#### 透過單點傳播 DNS-SD 的 Tailnet (Vienna ⇄ London) 裝置探索

Android NSD/mDNS 裝置探索不會跨網路。如果您的 Android 節點和 Gateway 位於不同的網路，但透過 Tailscale 連線，請改用 Wide-Area Bonjour / 單點傳播 DNS-SD：

1. 在 Gateway 主機上設定 DNS-SD 區域 (範例 `openclaw.internal.`)，並發佈 `_openclaw-gw._tcp` 記錄。
2. 為您選擇的網域設定 Tailscale 分割 DNS，指向該 DNS 伺服器。

詳細資訊和 CoreDNS 設定範例：[Bonjour](/gateway/bonjour)。

### 3) 從 Android 連線

在 Android 應用程式中：

- 應用程式透過 **前景服務** (持續性通知) 維持 Gateway 連線。
- 開啟 **設定**。
- 在 **已探索的 Gateways** 下，選擇您的 Gateway 並點擊 **連線**。
- 如果 mDNS 被阻擋，請使用 **進階 → 手動 Gateway** (主機 + 埠) 和 **連線 (手動)**。

首次成功配對後，Android 會在啟動時自動重新連線：

- 手動端點 (如果啟用)，否則
- 最後探索到的 Gateway (盡力而為)。

### 4) 批准配對 (CLI)

在 Gateway 機器上：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

配對詳細資訊：[Gateway pairing](/gateway/pairing)。

### 5) 驗證節點已連線

- 透過節點狀態：

  ```bash
  openclaw nodes status
  ```

- 透過 Gateway：

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) 聊天 + 記錄

Android 節點的聊天頁面使用 Gateway 的 **主要工作階段金鑰** (`main`)，因此記錄和回覆與 WebChat 及其他用戶端共用：

- 記錄：`chat.history`
- 傳送：`chat.send`
- 推送更新 (盡力而為)：`chat.subscribe` → `event:"chat"`

### 7) Canvas + 相機

#### Gateway Canvas 主機 (推薦用於網頁內容)

如果您希望節點顯示智慧代理可以在磁碟上編輯的真實 HTML/CSS/JS，請將節點指向 Gateway Canvas 主機。

注意：節點使用 `canvasHost.port` (預設 `18793`) 上的獨立 Canvas 主機。

1. 在 Gateway 主機上建立 `~/.openclaw/workspace/canvas/index.html`。

2. 將節點導航至該處 (LAN)：

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (可選)：如果兩台裝置都在 Tailscale 上，請使用 MagicDNS 名稱或 tailnet IP 而不是 `.local`，例如 `http://<gateway-magicdns>:18793/__openclaw__/canvas/`。

此伺服器將實時重新載入用戶端注入 HTML，並在檔案變更時重新載入。
A2UI 主機位於 `http://<gateway-host>:18793/__openclaw__/a2ui/`。

Canvas 指令 (僅限前景)：

- `canvas.eval`、`canvas.snapshot`、`canvas.navigate` (使用 `{"url":""}` 或 `{"url":"/"}` 返回預設腳手架)。`canvas.snapshot` 返回 `{ format, base64 }` (預設 `format="jpeg"`)。
- A2UI：`canvas.a2ui.push`、`canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` 傳統別名)

相機指令 (僅限前景；權限門控)：

- `camera.snap` (jpg)
- `camera.clip` (mp4)

請參閱 [相機節點](/nodes/camera) 以了解參數和 CLI 輔助工具。
