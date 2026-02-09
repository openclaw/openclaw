---
summary: "Android 應用程式（節點）：連線操作手冊 + Canvas／聊天／相機"
read_when:
  - 配對或重新連線 Android 節點
  - 偵錯 Android Gateway 閘道器 探索或身分驗證
  - 驗證跨用戶端的聊天歷史一致性
title: "Android 應用程式"
---

# Android App（Node）

## 支援快照

- 角色：配套節點應用程式（Android 不主控 Gateway 閘道器）。
- 需要 Gateway：是（在 macOS、Linux 或 Windows（透過 WSL2）上執行）。
- 安裝：[入門指南](/start/getting-started) + [配對](/gateway/pairing)。
- Gateway：[操作手冊](/gateway) + [設定](/gateway/configuration)。
  - Protocols: [Gateway protocol](/gateway/protocol) (nodes + control plane).

## 系統控制

系統控制（launchd/systemd）位於 Gateway 閘道器 主機上。請參閱 [Gateway](/gateway)。 See [Gateway](/gateway).

## 連線操作手冊

Android 節點應用程式 ⇄（mDNS/NSD + WebSocket）⇄ **Gateway**

Android 會直接連線至 Gateway WebSocket（預設 `ws://<host>:18789`），並使用由 Gateway 擁有的配對機制。

### 先決條件

- 你可以在「主控」機器上執行 Gateway。
- Android 裝置／模擬器可以連線到 Gateway WebSocket：
  - 同一個 LAN 並使用 mDNS/NSD，**或**
  - 同一個 Tailscale tailnet，使用 Wide-Area Bonjour／單播 DNS-SD（見下文），**或**
  - 手動指定 Gateway 閘道器 主機／連接埠（後備）
- 你可以在 Gateway 機器上執行 CLI（`openclaw`）（或透過 SSH）。

### 1. 啟動 Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Confirm in logs you see something like:

- `listening on ws://0.0.0.0:18789`

僅限 tailnet 的設定（建議用於 Vienna ⇄ London），請將 Gateway 綁定至 tailnet IP：

- 在 Gateway 主機的 `~/.openclaw/openclaw.json` 中設定 `gateway.bind: "tailnet"`。
- 重新啟動 Gateway／macOS 選單列應用程式。

### 2. 驗證探索（選用）

在 Gateway 機器上：

```bash
dns-sd -B _openclaw-gw._tcp local.
```

更多偵錯說明：[Bonjour](/gateway/bonjour)。

#### 透過單播 DNS-SD 的 Tailnet（Vienna ⇄ London）探索

Android 的 NSD/mDNS 探索無法跨網路。如果你的 Android 節點與 Gateway 位於不同網路，但透過 Tailscale 連線，請改用 Wide-Area Bonjour／單播 DNS-SD： If your Android node and the gateway are on different networks but connected via Tailscale, use Wide-Area Bonjour / unicast DNS-SD instead:

1. 在 Gateway 主機上設定一個 DNS-SD 區域（例如 `openclaw.internal.`），並發布 `_openclaw-gw._tcp` 記錄。
2. 為你選擇的網域設定 Tailscale 分割 DNS，指向該 DNS 伺服器。

詳細說明與 CoreDNS 設定範例：[Bonjour](/gateway/bonjour)。

### 3. 從 Android 連線

在 Android 應用程式中：

- 應用程式會透過 **前景服務**（常駐通知）維持 Gateway 連線。
- 開啟 **Settings**。
- 在 **Discovered Gateways** 下，選取你的 Gateway 並點擊 **Connect**。
- 若 mDNS 被封鎖，請使用 **Advanced → Manual Gateway**（主機 + 連接埠）並選擇 **Connect (Manual)**。

首次成功配對後，Android 會在啟動時自動重新連線：

- 手動端點（若已啟用），否則
- 最後一次探索到的 Gateway（盡力而為）。

### 4. 核准配對（CLI）

在 Gateway 機器上：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

配對詳細資訊：[Gateway 配對](/gateway/pairing)。

### 5. 驗證節點已連線

- Via nodes status:

  ```bash
  openclaw nodes status
  ```

- 透過 Gateway：

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. 聊天 + 歷史

Android 節點的聊天頁面使用 Gateway 的 **主要工作階段金鑰**（`main`），因此歷史與回覆會與 WebChat 及其他用戶端共用：

- 歷史：`chat.history`
- 傳送：`chat.send`
- 推播更新（盡力而為）：`chat.subscribe` → `event:"chat"`

### 7. Canvas + 相機

#### Gateway Canvas 主機（建議用於 Web 內容）

若你希望節點顯示可由代理在磁碟上編輯的真實 HTML/CSS/JS，請將節點指向 Gateway 的畫布主機。

注意：節點使用位於 `canvasHost.port` 的獨立 canvas 主機（預設 `18793`）。

1. 在 Gateway 主機上建立 `~/.openclaw/workspace/canvas/index.html`。

2. 將節點導向該位置（LAN）：

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet（選用）：如果兩個裝置都在 Tailscale 上，請使用 MagicDNS 名稱或 tailnet IP 取代 `.local`，例如 `http://<gateway-magicdns>:18793/__openclaw__/canvas/`。

This server injects a live-reload client into HTML and reloads on file changes.
此伺服器會將即時重新載入用戶端注入 HTML，並在檔案變更時重新載入。
A2UI 主機位於 `http://<gateway-host>:18793/__openclaw__/a2ui/`。

Canvas 指令（僅前景）：

- `canvas.eval`、`canvas.snapshot`、`canvas.navigate`（使用 `{"url":""}` 或 `{"url":"/"}` 返回預設骨架）。 `canvas.eval`、`canvas.snapshot`、`canvas.navigate`（使用 `{"url":""}` 或 `{"url":"/"}` 回到預設骨架）。`canvas.snapshot` 會回傳 `{ format, base64 }`（預設 `format="jpeg"`）。
- A2UI：`canvas.a2ui.push`、`canvas.a2ui.reset`（`canvas.a2ui.pushJSONL` 為舊版別名）

相機指令（僅前景；需權限）：

- `camera.snap`（jpg）
- `camera.clip`（mp4）

參閱 [Camera 節點](/nodes/camera) 以了解參數與 CLI 輔助工具。
