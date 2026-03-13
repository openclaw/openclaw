---
summary: >-
  Bonjour/mDNS discovery + debugging (Gateway beacons, clients, and common
  failure modes)
read_when:
  - Debugging Bonjour discovery issues on macOS/iOS
  - "Changing mDNS service types, TXT records, or discovery UX"
title: Bonjour Discovery
---

# Bonjour / mDNS 探索

OpenClaw 使用 Bonjour (mDNS / DNS‑SD) 作為 **僅限 LAN 的便利功能** 來發現活躍的 Gateway (WebSocket 端點)。這是最佳努力的方式，並且 **不** 取代 SSH 或基於 Tailnet 的連接。

## Wide‑area Bonjour (Unicast DNS‑SD) over Tailscale

如果節點和閘道位於不同的網路，則多播 mDNS 將無法跨越邊界。您可以透過在 Tailscale 上切換到 **單播 DNS‑SD**（"Wide‑Area Bonjour"）來保持相同的發現使用者體驗。

高階步驟：

1. 在閘道主機上執行 DNS 伺服器（可透過 Tailnet 訪問）。
2. 在專用區域下為 `_openclaw-gw._tcp` 發佈 DNS‑SD 記錄（範例：`openclaw.internal.`）。
3. 設定 Tailscale **分割 DNS**，使您選擇的網域透過該 DNS 伺服器解析給用戶端（包括 iOS）。

OpenClaw 支援任何發現域；`openclaw.internal.` 只是個範例。  
iOS/Android 節點同時瀏覽 `local.` 和您設定的廣域域。

### Gateway 設定（推薦）

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### 一次性 DNS 伺服器設定（閘道主機）

```bash
openclaw dns setup --apply
```

這會安裝 CoreDNS 並將其設定為：

- 僅在閘道的 Tailscale 介面上監聽 53 號埠
- 從 `~/.openclaw/dns/<domain>.db` 提供您選擇的域名 (例如: `openclaw.internal.`)

從連接到 tailnet 的機器進行驗證：

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS 設定

在 Tailscale 管理控制台：

- 添加一個指向閘道的 tailnet IP 的名稱伺服器 (UDP/TCP 53)。
- 添加分割 DNS，使您的發現域使用該名稱伺服器。

一旦客戶接受 tailnet DNS，iOS 節點可以在您的發現域中瀏覽 `_openclaw-gw._tcp` 而無需使用多播。

### Gateway listener 安全性（建議）

Gateway WS 端口（預設 `18789`）預設綁定到回環介面。若要進行 LAN/tailnet 存取，請明確綁定並保持身份驗證啟用。

[[BLOCK_1]]  
對於僅限 tailnet 的設置：  
[[BLOCK_1]]

- 在 `~/.openclaw/openclaw.json` 中設置 `gateway.bind: "tailnet"`。
- 重新啟動 Gateway（或重新啟動 macOS 選單欄應用程式）。

## 什麼是廣告

只有網關廣告 `_openclaw-gw._tcp`。

## 服務類型

- `_openclaw-gw._tcp` — 閘道傳輸信標（用於 macOS/iOS/Android 節點）。

## TXT 鍵（非秘密提示）

Gateway 會廣告一些小的非秘密提示，以便讓 UI 流程更加便利：

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (閘道 WS + HTTP)
- `gatewayTls=1` (僅在啟用 TLS 時)
- `gatewayTlsSha256=<sha256>` (僅在啟用 TLS 且可用指紋時)
- `canvasPort=<port>` (僅在啟用畫布主機時；目前與 `gatewayPort` 相同)
- `sshPort=<port>` (當未被覆蓋時預設為 22)
- `transport=gateway`
- `cliPath=<path>` (可選；可執行的 `openclaw` 入口點的絕對路徑)
- `tailnetDns=<magicdns>` (當 Tailnet 可用時的可選提示)

安全注意事項：

- Bonjour/mDNS TXT 記錄是 **未經驗證** 的。用戶端不應將 TXT 視為權威路由。
- 用戶端應使用解析出的服務端點 (SRV + A/AAAA) 進行路由。將 `lanHost`、`tailnetDns`、`gatewayPort` 和 `gatewayTlsSha256` 僅視為提示。
- TLS 鎖定絕不應允許廣告的 `gatewayTlsSha256` 覆蓋先前儲存的鎖定。
- iOS/Android 節點應將基於發現的直接連接視為 **僅限 TLS**，並在信任首次指紋之前要求明確的用戶確認。

## 在 macOS 上進行除錯

有用的內建工具：

- 瀏覽實例：

```bash
  dns-sd -B _openclaw-gw._tcp local.
```

- 解決一個實例（替換 `<instance>`）：

```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
```

如果瀏覽正常但解析失敗，通常是遇到 LAN 政策或 mDNS 解析器問題。

## 在 Gateway 日誌中進行除錯

Gateway 會寫入一個滾動日誌檔案（在啟動時列印為 `gateway log file: ...`）。請尋找 `bonjour:` 行，特別是：

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## 在 iOS 節點上進行除錯

iOS 節點使用 `NWBrowser` 來發現 `_openclaw-gw._tcp`。

要捕捉日誌：

- 設定 → 閘道 → 進階 → **發現除錯日誌**
- 設定 → 閘道 → 進階 → **發現日誌** → 重現 → **複製**

日誌包含瀏覽器狀態轉換和結果集變更。

## 常見故障模式

- **Bonjour 不跨網路**：使用 Tailnet 或 SSH。
- **多播被阻擋**：某些 Wi‑Fi 網路會禁用 mDNS。
- **睡眠 / 介面變更**：macOS 可能會暫時丟失 mDNS 結果；請重試。
- **瀏覽正常但解析失敗**：保持機器名稱簡單（避免使用表情符號或標點符號），然後重新啟動 Gateway。服務實例名稱源自主機名稱，因此過於複雜的名稱可能會使某些解析器感到困惑。

## Escaped instance names (`\032`)

Bonjour/DNS‑SD 通常會將服務實例名稱中的位元組以十進位 `\DDD` 序列進行轉義（例如，空格變成 `\032`）。

- 這在協議層面是正常的。
- 使用者介面應該進行解碼以便顯示（iOS 使用 `BonjourEscapes.decode`）。

## 禁用 / 設定

- `OPENCLAW_DISABLE_BONJOUR=1` 禁用廣告 (舊版: `OPENCLAW_DISABLE_BONJOUR`)。
- `gateway.bind` 在 `~/.openclaw/openclaw.json` 中控制 Gateway 綁定模式。
- `OPENCLAW_SSH_PORT` 覆蓋在 TXT 中廣告的 SSH 埠 (舊版: `OPENCLAW_SSH_PORT`)。
- `OPENCLAW_TAILNET_DNS` 在 TXT 中發布 MagicDNS 提示 (舊版: `OPENCLAW_TAILNET_DNS`)。
- `OPENCLAW_CLI_PATH` 覆蓋廣告的 CLI 路徑 (舊版: `OPENCLAW_CLI_PATH`)。

## 相關文件

- 發現政策與傳輸選擇: [Discovery](/gateway/discovery)
- 節點配對 + 批准: [Gateway pairing](/gateway/pairing)
