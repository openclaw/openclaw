---
summary: "Bonjour/mDNS 探索＋除錯（Gateway 信標、用戶端與常見失敗模式）"
read_when:
  - 在 macOS／iOS 上除錯 Bonjour 探索問題
  - 變更 mDNS 服務類型、TXT 記錄或探索 UX
title: "Bonjour 探索"
x-i18n:
  source_path: gateway/bonjour.md
  source_hash: 6f1d676ded5a500c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:04Z
---

# Bonjour／mDNS 探索

OpenClaw 使用 Bonjour（mDNS／DNS‑SD）作為**僅限 LAN 的便利方式**，用來探索
一個啟用中的 Gateway（WebSocket 端點）。此機制屬於盡力而為，**不會**取代 SSH 或
以 Tailnet 為基礎的連線能力。

## 透過 Tailscale 的廣域 Bonjour（單播 DNS‑SD）

如果節點與 Gateway 位於不同網路，多播 mDNS 將無法跨越
邊界。你可以透過在 Tailscale 上切換為**單播 DNS‑SD**
（「Wide‑Area Bonjour」）來維持相同的探索 UX。

高層級步驟：

1. 在閘道器主機上執行一個 DNS 伺服器（可透過 Tailnet 存取）。
2. 在專用網域下發布 `_openclaw-gw._tcp` 的 DNS‑SD 記錄
   （範例：`openclaw.internal.`）。
3. 設定 Tailscale 的**分割 DNS**，讓你選擇的網域透過該
   DNS 伺服器解析給用戶端（包含 iOS）。

OpenClaw 支援任何探索網域；`openclaw.internal.` 僅為範例。
iOS／Android 節點會同時瀏覽 `local.` 與你設定的廣域網域。

### Gateway 設定（建議）

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### 一次性的 DNS 伺服器設定（閘道器主機）

```bash
openclaw dns setup --apply
```

這會安裝 CoreDNS 並設定為：

- 僅在 Gateway 的 Tailscale 介面上於連接埠 53 監聽
- 從 `~/.openclaw/dns/<domain>.db` 服務你選擇的網域（範例：`openclaw.internal.`）

從連線到 tailnet 的機器驗證：

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS 設定

在 Tailscale 管理主控台中：

- 新增一個指向 Gateway tailnet IP 的名稱伺服器（UDP／TCP 53）。
- 新增分割 DNS，讓你的探索網域使用該名稱伺服器。

一旦用戶端接受 tailnet DNS，iOS 節點即可在你的探索網域中
瀏覽 `_openclaw-gw._tcp`，而不需要多播。

### Gateway 監聽器安全性（建議）

Gateway 的 WS 連接埠（預設為 `18789`）預設只綁定在 loopback。若需 LAN／tailnet
存取，請明確綁定並保持啟用驗證。

僅限 tailnet 的設定：

- 在 `~/.openclaw/openclaw.json` 中設定 `gateway.bind: "tailnet"`。
- 重新啟動 Gateway（或重新啟動 macOS 選單列應用程式）。

## 何者會進行廣播

只有 Gateway 會廣播 `_openclaw-gw._tcp`。

## 服務類型

- `_openclaw-gw._tcp` — Gateway 傳輸信標（供 macOS／iOS／Android 節點使用）。

## TXT 金鑰（非機密提示）

Gateway 會廣播小型、非機密的提示，以便利 UI 流程：

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>`（Gateway WS＋HTTP）
- `gatewayTls=1`（僅在啟用 TLS 時）
- `gatewayTlsSha256=<sha256>`（僅在啟用 TLS 且指紋可用時）
- `canvasPort=<port>`（僅在啟用畫布主機時；預設 `18793`）
- `sshPort=<port>`（未覆寫時預設為 22）
- `transport=gateway`
- `cliPath=<path>`（選用；可執行的 `openclaw` 進入點之絕對路徑）
- `tailnetDns=<magicdns>`（當 Tailnet 可用時的選用提示）

## 在 macOS 上除錯

實用的內建工具：

- 瀏覽實例：

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- 解析單一實例（取代 `<instance>`）：

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

如果瀏覽可行但解析失敗，通常是遇到 LAN 政策或
mDNS 解析器問題。

## 在 Gateway 記錄中除錯

Gateway 會寫入輪替的記錄檔（在啟動時列印為
`gateway log file: ...`）。請留意 `bonjour:` 行，特別是：

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved`／`hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## 在 iOS 節點上除錯

iOS 節點使用 `NWBrowser` 來探索 `_openclaw-gw._tcp`。

擷取記錄：

- 設定 → Gateway → 進階 → **探索除錯記錄**
- 設定 → Gateway → 進階 → **探索記錄** → 重現 → **複製**

記錄包含瀏覽器狀態轉換與結果集合變更。

## 常見失敗模式

- **Bonjour 無法跨網路**：請使用 Tailnet 或 SSH。
- **多播被封鎖**：某些 Wi‑Fi 網路會停用 mDNS。
- **睡眠／介面變動**：macOS 可能暫時遺失 mDNS 結果；請重試。
- **瀏覽可行但解析失敗**：請保持機器名稱簡單（避免表情符號或
  標點符號），然後重新啟動 Gateway。服務實例名稱源自主機名稱，
  過於複雜的名稱可能會讓某些解析器混淆。

## 轉義的實例名稱（`\032`）

Bonjour／DNS‑SD 常會在服務實例名稱中，以十進位 `\DDD`
序列來轉義位元組（例如空白會變成 `\032`）。

- 這在通訊協定層級屬於正常行為。
- UI 應該在顯示時解碼（iOS 使用 `BonjourEscapes.decode`）。

## 停用／設定

- `OPENCLAW_DISABLE_BONJOUR=1` 會停用廣播（舊版：`OPENCLAW_DISABLE_BONJOUR`）。
- `gateway.bind` 於 `~/.openclaw/openclaw.json` 中控制 Gateway 的綁定模式。
- `OPENCLAW_SSH_PORT` 會覆寫 TXT 中廣播的 SSH 連接埠（舊版：`OPENCLAW_SSH_PORT`）。
- `OPENCLAW_TAILNET_DNS` 會在 TXT 中發布 MagicDNS 提示（舊版：`OPENCLAW_TAILNET_DNS`）。
- `OPENCLAW_CLI_PATH` 會覆寫廣播的 CLI 路徑（舊版：`OPENCLAW_CLI_PATH`）。

## 相關文件

- 探索政策與傳輸選擇：[Discovery](/gateway/discovery)
- 節點配對與核准：[Gateway pairing](/gateway/pairing)
