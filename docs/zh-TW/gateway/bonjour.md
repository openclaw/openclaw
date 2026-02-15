---
summary: "Bonjour/mDNS 裝置探索 + 除錯 (Gateway 信標、用戶端以及常見失敗模式)"
read_when:
  - 在 macOS/iOS 上除錯 Bonjour 裝置探索問題
  - 變更 mDNS 服務類型、TXT 紀錄或裝置探索使用者體驗 (UX)
title: "Bonjour 裝置探索"
---

# Bonjour / mDNS 裝置探索

OpenClaw 使用 Bonjour (mDNS / DNS‑SD) 作為**僅限區域網路 (LAN) 的便利功能**，用來探索啟動中的 Gateway (WebSocket 端點)。這是一項盡力而為的功能，並**不能**取代 SSH 或基於 Tailnet 的連線。

## 透過 Tailscale 實作廣域 Bonjour (單播 DNS-SD)

如果節點和 Gateway 位於不同的網路，多播 mDNS 將無法跨越網路邊界。您可以透過 Tailscale 切換到**單播 DNS-SD** (「廣域 Bonjour」)，以保持相同的裝置探索使用者體驗 (UX)。

高階步驟：

1. 在 Gateway 主機上執行 DNS 伺服器 (可透過 Tailnet 存取)。
2. 在專用區域 (例如：`openclaw.internal.`) 下發布 `_openclaw-gw._tcp` 的 DNS-SD 紀錄。
3. 設定 Tailscale **分離 DNS (split DNS)**，讓您的所選網域能透過該 DNS 伺服器為用戶端 (包括 iOS) 進行解析。

OpenClaw 支援任何裝置探索網域；`openclaw.internal.` 僅為範例。iOS/Android 節點會同時瀏覽 `local.` 以及您設定的廣域網域。

### Gateway 設定 (建議)

```json5
{
  gateway: { bind: "tailnet" }, // 僅限 tailnet (建議)
  discovery: { wideArea: { enabled: true } }, // 啟用廣域 DNS-SD 發布
}
```

### 一次性 DNS 伺服器設定 (Gateway 主機)

```bash
openclaw dns setup --apply
```

這會安裝 CoreDNS 並將其設定為：

- 僅在 Gateway 的 Tailscale 介面上監聽連接埠 53
- 從 `~/.openclaw/dns/<domain>.db` 提供您選擇的網域 (例如：`openclaw.internal.`)

從連線至 tailnet 的機器進行驗證：

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS 設定

在 Tailscale 管理控制台中：

- 新增一個指向 Gateway tailnet IP (UDP/TCP 53) 的名稱伺服器。
- 新增分離 DNS，讓您的裝置探索網域使用該名稱伺服器。

一旦用戶端接受 tailnet DNS，iOS 節點就可以在您的裝置探索網域中瀏覽 `_openclaw-gw._tcp`，而無需使用多播。

### Gateway 監聽器安全性 (建議)

Gateway WS 連接埠 (預設為 `18789`) 預設綁定到 local loopback。為了進行區域網路 / tailnet 存取，請明確進行綁定並保持身分驗證功能開啟。

對於僅限 tailnet 的設定：

- 在 `~/.openclaw/openclaw.json` 中設定 `gateway.bind: "tailnet"`。
- 重新啟動 Gateway (或重新啟動 macOS 選單列應用程式)。

## 廣播內容

只有 Gateway 會廣播 `_openclaw-gw._tcp`。

## 服務類型

- `_openclaw-gw._tcp` — Gateway 傳輸信標 (由 macOS/iOS/Android 節點使用)。

## TXT 鍵名 (非機密提示)

Gateway 會廣播微小的非機密提示，讓 UI 流程更便利：

- `role=gateway`
- `displayName=<易記名稱>`
- `lanHost=<主機名稱>.local`
- `gatewayPort=<連接埠>` (Gateway WS + HTTP)
- `gatewayTls=1` (僅在啟用 TLS 時)
- `gatewayTlsSha256=<sha256>` (僅在啟用 TLS 且指紋可用時)
- `canvasPort=<連接埠>` (僅在啟用 canvas 主機時；預設為 `18793`)
- `sshPort=<連接埠>` (未覆寫時預設為 22)
- `transport=gateway`
- `cliPath=<路徑>` (選填；可執行的 `openclaw` 入口點絕對路徑)
- `tailnetDns=<magicdns>` (選填；當 Tailnet 可用時的提示)

## 在 macOS 上除錯

實用的內建工具：

- 瀏覽實例：

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- 解析單一實例 (請替換 `<instance>`)：

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

如果搜尋成功但解析失敗，通常是遇到區域網路政策或 mDNS 解析器問題。

## 在 Gateway 記錄中除錯

Gateway 會寫入一個循環記錄檔 (啟動時會印出 `gateway log file: ...`)。請尋找 `bonjour:` 開頭的內容，特別是：

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## 在 iOS 節點上除錯

iOS 節點使用 `NWBrowser` 來探索 `_openclaw-gw._tcp`。

要擷取記錄：

- 設定 → Gateway → 進階 → **Discovery Debug Logs**
- 設定 → Gateway → 進階 → **Discovery Logs** → 重現問題 → **複製**

記錄包含瀏覽器狀態切換和結果集變動。

## 常見失敗模式

- **Bonjour 無法跨網路**：請使用 Tailnet 或 SSH。
- **多播 (Multicast) 被阻擋**：某些 Wi-Fi 網路會停用 mDNS。
- **睡眠 / 介面變動**：macOS 可能會暫時遺失 mDNS 結果；請重試。
- **搜尋成功但解析失敗**：保持主機名稱簡單 (避免使用表情符號或標點符號)，然後重新啟動 Gateway。服務實例名稱源自主機名稱，過於複雜的名稱可能會困擾某些解析器。

## 轉義的實例名稱 (`\032`)

Bonjour/DNS‑SD 經常將服務實例名稱中的位元組轉義為十進位 `\DDD` 序列 (例如：空格變成 `\032`)。

- 這在協定層級是正常的。
- UI 應解碼後再顯示 (iOS 使用 `BonjourEscapes.decode`)。

## 停用 / 設定

- `OPENCLAW_DISABLE_BONJOUR=1` 停用廣播 (舊版：`OPENCLAW_DISABLE_BONJOUR`)。
- `~/.openclaw/openclaw.json` 中的 `gateway.bind` 控制 Gateway 綁定模式。
- `OPENCLAW_SSH_PORT` 覆寫在 TXT 中廣播的 SSH 連接埠 (舊版：`OPENCLAW_SSH_PORT`)。
- `OPENCLAW_TAILNET_DNS` 在 TXT 中發布 MagicDNS 提示 (舊版：`OPENCLAW_TAILNET_DNS`)。
- `OPENCLAW_CLI_PATH` 覆寫廣播的 CLI 路徑 (舊版：`OPENCLAW_CLI_PATH`)。

## 相關文件

- 裝置探索政策與傳輸選擇：[裝置探索](/gateway/discovery)
- 節點配對 + 核准：[Gateway 配對](/gateway/pairing)
