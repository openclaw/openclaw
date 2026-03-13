---
summary: >-
  Android app (node): connection runbook + Connect/Chat/Voice/Canvas command
  surface
read_when:
  - Pairing or reconnecting the Android node
  - Debugging Android gateway discovery or auth
  - Verifying chat history parity across clients
title: Android App
---

# Android 應用程式 (Node)

## 支援快照

- 角色：伴隨節點應用程式（Android 不承載 Gateway）。
- 需要 Gateway：是（可在 macOS、Linux 或 Windows 的 WSL2 上執行）。
- 安裝：請參考 [快速開始](/start/getting-started) + [配對](/channels/pairing)。
- Gateway：請參考 [操作手冊](/gateway) + [設定](/gateway/configuration)。
  - 協定：請參考 [Gateway 協定](/gateway/protocol)（節點 + 控制平面）。

## 系統控制

系統控制（launchd/systemd）執行於 Gateway 主機。詳見 [Gateway](/gateway)。

## 連線操作手冊

Android 節點應用程式 ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android 直接連接 Gateway WebSocket（預設 `ws://<host>:18789`），並使用裝置配對 (`role: node`)。

### 前置條件

- 你可以在「主控」機器上執行 Gateway。
- Android 裝置或模擬器能連接到 Gateway WebSocket：
  - 同一區域網路並使用 mDNS/NSD，**或**
  - 同一 Tailscale tailnet，使用 Wide-Area Bonjour / 單播 DNS-SD（見下文），**或**
  - 手動指定 Gateway 主機/埠號（備援方案）
- 你可以在 Gateway 機器上（或透過 SSH）執行 CLI (`openclaw`)。

### 1) 啟動 Gateway

```bash
openclaw gateway --port 18789 --verbose
```

請在日誌中確認看到類似以下訊息：

- `listening on ws://0.0.0.0:18789`

針對僅限 tailnet 的設定（建議用於 Vienna ⇄ London），請將 Gateway 綁定至 tailnet IP：

- 在閘道主機上設定 `gateway.bind: "tailnet"` 至 `~/.openclaw/openclaw.json`。
- 重新啟動閘道 / macOS 功能表列應用程式。

### 2) 驗證發現（可選）

從閘道機器：

```bash
dns-sd -B _openclaw-gw._tcp local.
```

更多除錯說明：[Bonjour](/gateway/bonjour)。

#### 透過單播 DNS-SD 進行 Tailnet（維也納 ⇄ 倫敦）發現

Android 的 NSD/mDNS 發現無法跨網路。如果您的 Android 節點與閘道位於不同網路，但透過 Tailscale 連線，請改用 Wide-Area Bonjour / 單播 DNS-SD：

1. 在閘道主機上設定 DNS-SD 區域（範例 `openclaw.internal.`）並發佈 `_openclaw-gw._tcp` 紀錄。
2. 為您選擇的網域設定 Tailscale 分割 DNS，指向該 DNS 伺服器。

詳細資訊與 CoreDNS 範例設定：[Bonjour](/gateway/bonjour)。

### 3) 從 Android 連線

在 Android 應用程式中：

- 應用程式透過 **前景服務**（持續通知）保持閘道連線。
- 開啟 **連線** 分頁。
- 使用 **設定碼** 或 **手動** 模式。
- 若發現功能被阻擋，請在 **進階控制** 中使用手動主機/連接埠（必要時搭配 TLS/token/密碼）。

首次配對成功後，Android 會在啟動時自動重新連線：

- 手動端點（若啟用），否則
- 最後發現的閘道（盡力而為）。

### 4) 批准配對（CLI）

在閘道器機器上：

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

配對詳情：[配對](/channels/pairing)。

### 5) 驗證節點是否已連線

- 透過節點狀態：

```bash
  openclaw nodes status
```

- 透過閘道器：

```bash
  openclaw gateway call node.list --params "{}"
```

### 6) 聊天 + 歷史紀錄

Android 聊天分頁支援會話選擇（預設 `main`，以及其他現有會話）：

- 歷史紀錄：`chat.history`
- 傳送：`chat.send`
- 推送更新（盡力而為）：`chat.subscribe` → `event:"chat"`

### 7) 畫布 + 相機

#### 閘道器畫布主機（建議用於網頁內容）

如果你希望節點顯示代理程式可在磁碟上編輯的真實 HTML/CSS/JS，請將節點指向閘道器畫布主機。

注意：節點從閘道器 HTTP 伺服器載入畫布（與 `gateway.port` 相同的埠，預設為 `18789`）。

1. 在閘道主機上建立 `~/.openclaw/workspace/canvas/index.html`。

2. 將節點導向該位置（區域網路）：

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

Tailnet（可選）：如果兩台裝置都在 Tailscale 上，請使用 MagicDNS 名稱或 tailnet IP 取代 `.local`，例如 `http://<gateway-magicdns>:18789/__openclaw__/canvas/`。

此伺服器會將 live-reload 用戶端注入 HTML，並在檔案變更時重新載入。  
A2UI 主機位於 `http://<gateway-host>:18789/__openclaw__/a2ui/`。

Canvas 指令（僅前景）：

- `canvas.eval`、`canvas.snapshot`、`canvas.navigate`（使用 `{"url":""}` 或 `{"url":"/"}` 回復預設骨架）。`canvas.snapshot` 回傳 `{ format, base64 }`（預設為 `format="jpeg"`）。
- A2UI：`canvas.a2ui.push`、`canvas.a2ui.reset`（`canvas.a2ui.pushJSONL` 舊版別名）

相機指令（僅前景；需權限）：

- `camera.snap`（jpg）
- `camera.clip`（mp4）

參見 [Camera node](/nodes/camera) 了解參數與 CLI 輔助工具。

### 8) 語音 + 擴充的 Android 指令範圍

- 語音：Android 在語音分頁使用單一麥克風開關流程，包含文字轉錄與 TTS 播放（設定時使用 ElevenLabs，系統 TTS 為備援）。當應用程式離開前景時，語音會停止。
- 語音喚醒／對話模式切換目前已從 Android UX／執行時移除。
- 額外的 Android 指令群組（可用性依裝置與權限而定）：
  - `device.status`、`device.info`、`device.permissions`、`device.health`
  - `notifications.list`、`notifications.actions`
  - `photos.latest`
  - `contacts.search`、`contacts.add`
  - `calendar.events`、`calendar.add`
  - `motion.activity`、`motion.pedometer`
