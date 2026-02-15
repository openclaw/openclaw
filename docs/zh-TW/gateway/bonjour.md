---
summary: "Bonjour/mDNS 裝置探索 + 偵錯（Gateway信標、用戶端和常見故障模式）"
read_when:
  - 在 macOS/iOS 上偵錯 Bonjour 裝置探索問題時
  - 變更 mDNS 服務類型、TXT 記錄或裝置探索使用者體驗時
title: "Bonjour 裝置探索"
---

# Bonjour / mDNS 裝置探索

OpenClaw 使用 Bonjour (mDNS / DNS‑SD) 作為一種**僅限區域網路的便利方式**來探索
活躍的 Gateway (WebSocket 端點)。這是一種盡力而為的機制，**不會**取代 SSH 或
基於 Tailnet 的連線。

## 透過 Tailscale 的廣域 Bonjour (單點傳播 DNS‑SD)

如果節點和 Gateway位於不同的網路，多點傳播 mDNS 將無法跨越
邊界。您可以透過切換到透過 Tailscale 的**單點傳播 DNS‑SD**
（「廣域 Bonjour」）來保持相同的裝置探索使用者體驗。

高階步驟：

1. 在 Gateway主機上執行 DNS 伺服器（可透過 Tailnet 存取）。
2. 在專用區域下發佈 `_openclaw-gw._tcp` 的 DNS‑SD 記錄
   （範例：`openclaw.internal.`）。
3. 設定 Tailscale **分割 DNS**，使您選擇的網域名稱透過該
   DNS 伺服器為用戶端（包括 iOS）解析。

OpenClaw 支援任何裝置探索網域；`openclaw.internal.` 僅為範例。
iOS/Android 節點會瀏覽 `local.` 和您已設定的廣域網域。

### Gateway設定（建議）

```json5
{
  gateway: { bind: "tailnet" }, // 僅限 Tailnet（建議）
  discovery: { wideArea: { enabled: true } }, // 啟用廣域 DNS-SD 發佈
}
```

### 一次性 DNS 伺服器設定（Gateway主機）

```bash
openclaw dns setup --apply
```

這會安裝 CoreDNS 並將其設定為：

- 僅在 Gateway的 Tailscale 介面上監聽連接埠 53
- 從 `~/.openclaw/dns/<domain>.db` 提供您選擇的網域名稱服務（範例：`openclaw.internal.`）

從已連接 Tailnet 的機器驗證：

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS 設定

在 Tailscale 管理主控台中：

- 新增指向 Gateway Tailnet IP 的名稱伺服器（UDP/TCP 53）。
- 新增分割 DNS，使您的裝置探索網域使用該名稱伺服器。

一旦用戶端接受 Tailnet DNS，iOS 節點即可在
您的裝置探索網域中瀏覽 `_openclaw-gw._tcp`，無需多點傳播。

### Gateway監聽器安全性（建議）

Gateway WS 連接埠（預設 `18789`）預設繫結到 local loopback。對於區域網路/Tailnet
存取，請明確繫結並保持認證啟用。

對於僅限 Tailnet 的設定：

- 在 `~/.openclaw/openclaw.json` 中設定 `gateway.bind: "tailnet"`。
- 重新啟動 Gateway（或重新啟動 macOS 選單列應用程式）。

## 什麼會發佈廣告

只有 Gateway會發佈 `_openclaw-gw._tcp` 的廣告。

## 服務類型

- `_openclaw-gw._tcp` — Gateway傳輸信標（由 macOS/iOS/Android 節點使用）。

## TXT 鍵（非機密提示）

Gateway會發佈小型非機密提示，以方便使用者介面流程：

- `role=gateway`
- `displayName=<友善名稱>`
- `lanHost=<hostname>.local`
- `gatewayPort=<連接埠>` (Gateway WS + HTTP)
- `gatewayTls=1` (僅當 TLS 啟用時)
- `gatewayTlsSha256=<sha256>` (僅當 TLS 啟用且指紋可用時)
- `canvasPort=<連接埠>` (僅當畫布主機啟用時；預設 `18793`)
- `sshPort=<連接埠>` (未覆寫時預設為 22)
- `transport=gateway`
- `cliPath=<路徑>` (選用；可執行 `openclaw` 進入點的絕對路徑)
- `tailnetDns=<magicdns>` (Tailnet 可用時的選用提示)

## 在 macOS 上偵錯

實用的內建工具：

- 瀏覽實例：

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- 解析單一實例（取代 `<instance>`）：

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

如果瀏覽成功但解析失敗，通常表示您遇到區域網路策略或
mDNS 解析器問題。

## 在 Gateway日誌中偵錯

Gateway會寫入滾動日誌檔案（啟動時會列印為
`gateway log file: ...`）。請尋找 `bonjour:` 行，特別是：

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## 在 iOS 節點上偵錯

iOS 節點使用 `NWBrowser` 來探索 `_openclaw-gw._tcp`。

要擷取日誌：

- 設定 → Gateway → 進階 → **裝置探索偵錯日誌**
- 設定 → Gateway → 進階 → **裝置探索日誌** → 重現 → **複製**

日誌包含瀏覽器狀態轉換和結果集變更。

## 常見故障模式

- **Bonjour 無法跨網路**：使用 Tailnet 或 SSH。
- **多點傳播受阻**：某些 Wi‑Fi 網路會停用 mDNS。
- **休眠 / 介面變動**：macOS 可能會暫時丟失 mDNS 結果；請重試。
- **瀏覽成功但解析失敗**：保持機器名稱簡潔（避免使用表情符號或
  標點符號），然後重新啟動 Gateway。服務實例名稱源自
  主機名稱，因此過於複雜的名稱可能會混淆某些解析器。

## 跳脫的實例名稱（`\032`）

Bonjour/DNS‑SD 通常會將服務實例名稱中的位元組跳脫為十進制 `\DDD`
序列（例如空格會變成 `\032`）。

- 這在協定層面是正常的。
- 使用者介面應解碼以供顯示（iOS 使用 `BonjourEscapes.decode`）。

## 停用 / 設定

- `OPENCLAW_DISABLE_BONJOUR=1` 會停用廣告發佈（舊版：`OPENCLAW_DISABLE_BONJOUR`）。
- `~/.openclaw/openclaw.json` 中的 `gateway.bind` 控制 Gateway繫結模式。
- `OPENCLAW_SSH_PORT` 會覆寫在 TXT 中發佈的 SSH 連接埠（舊版：`OPENCLAW_SSH_PORT`）。
- `OPENCLAW_TAILNET_DNS` 會在 TXT 中發佈 MagicDNS 提示（舊版：`OPENCLAW_TAILNET_DNS`）。
- `OPENCLAW_CLI_PATH` 會覆寫已發佈的 CLI 路徑（舊版：`OPENCLAW_CLI_PATH`）。

## 相關文件

- 裝置探索策略和傳輸選擇：[裝置探索](/gateway/discovery)
- 節點配對 + 批准：[Gateway配對](/gateway/pairing)
