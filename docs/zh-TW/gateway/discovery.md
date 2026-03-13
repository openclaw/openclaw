---
summary: >-
  Node discovery and transports (Bonjour, Tailscale, SSH) for finding the
  gateway
read_when:
  - Implementing or changing Bonjour discovery/advertising
  - Adjusting remote connection modes (direct vs SSH)
  - Designing node discovery + pairing for remote nodes
title: Discovery and Transports
---

# Discovery & transports

OpenClaw 有兩個表面上看起來相似的不同問題：

1. **操作員遠端控制**：控制在其他地方執行的閘道的 macOS 選單列應用程式。
2. **節點配對**：iOS/Android（以及未來的節點）尋找閘道並安全配對。

設計目標是將所有網路發現/廣告保持在 **Node Gateway** (`openclaw gateway`) 中，並將用戶端（mac 應用程式、iOS）作為消費者。

## Terms

- **Gateway**: 一個長期執行的網關過程，擁有狀態（會話、配對、節點註冊）並執行通道。大多數設置每個主機使用一個；也可以實現隔離的多網關設置。
- **Gateway WS (控制平面)**: 預設在 `127.0.0.1:18789` 的 WebSocket 端點；可以通過 `gateway.bind` 綁定到 LAN/tailnet。
- **直接 WS 傳輸**: 面向 LAN/tailnet 的 Gateway WS 端點（無 SSH）。
- **SSH 傳輸（後備）**: 通過 SSH 轉發 `127.0.0.1:18789` 進行遠程控制。
- **舊版 TCP 橋接（已棄用/移除）**: 舊的節點傳輸（參見 [Bridge protocol](/gateway/bridge-protocol)）；不再廣告以供發現。

[[BLOCK_1]]  
Protocol details:  
[[INLINE_1]]

- [Gateway 協議](/gateway/protocol)
- [橋接協議 (舊版)](/gateway/bridge-protocol)

## 為什麼我們同時保留「直接」和 SSH

- **Direct WS** 是在同一網路和 tailnet 上最佳的使用者體驗：
  - 透過 Bonjour 進行 LAN 自動發現
  - 配對 token + 由閘道擁有的 ACL
  - 不需要 shell 存取；協議介面可以保持緊湊且可審計
- **SSH** 仍然是通用的備用方案：
  - 在任何有 SSH 存取的地方都能運作（即使跨越不相關的網路）
  - 能夠克服多播/mDNS 問題
  - 除了 SSH 之外不需要新的入站端口

## Discovery inputs (how clients learn where the gateway is)

### 1) Bonjour / mDNS (僅限 LAN)

Bonjour 是一種最佳努力的服務，並不跨越網路。它僅用於「同一局域網」的便利性。

[[BLOCK_1]]

- **網關**透過 Bonjour 廣播其 WS 端點。
- 用戶端瀏覽並顯示“選擇一個網關”列表，然後儲存所選的端點。

故障排除和信標詳細資訊：[Bonjour](/gateway/bonjour)。

#### Service beacon details

- 服務類型：
  - `_openclaw-gw._tcp` (閘道傳輸信標)
- TXT 鍵（非秘密）：
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (或任何廣告的內容)
  - `gatewayPort=18789` (閘道 WS + HTTP)
  - `gatewayTls=1` (僅在啟用 TLS 時)
  - `gatewayTlsSha256=<sha256>` (僅在啟用 TLS 且指紋可用時)
  - `canvasPort=<port>` (畫布主機端口；當畫布主機啟用時，目前與 `gatewayPort` 相同)
  - `cliPath=<path>` (可選；可執行的 `openclaw` 入口點或二進位檔的絕對路徑)
  - `tailnetDns=<magicdns>` (可選提示；當 Tailscale 可用時自動檢測)

安全注意事項：

- Bonjour/mDNS TXT 記錄是 **未經驗證** 的。用戶端必須將 TXT 值視為使用者體驗提示。
- 路由（主機/端口）應優先考慮 **解析的服務端點**（SRV + A/AAAA），而不是 TXT 提供的 `lanHost`、`tailnetDns` 或 `gatewayPort`。
- TLS 鎖定絕不可允許廣告的 `gatewayTlsSha256` 覆蓋先前儲存的鎖定。
- iOS/Android 節點應將基於發現的直接連接視為 **僅限 TLS**，並在儲存第一次的鎖定之前要求明確的「信任此指紋」確認（帶外驗證）。

[[BLOCK_1]]

- `OPENCLAW_DISABLE_BONJOUR=1` 禁用廣告。
- `gateway.bind` 在 `~/.openclaw/openclaw.json` 中控制 Gateway 綁定模式。
- `OPENCLAW_SSH_PORT` 覆蓋在 TXT 中廣告的 SSH 端口（預設為 22）。
- `OPENCLAW_TAILNET_DNS` 發佈一個 `tailnetDns` 提示（MagicDNS）。
- `OPENCLAW_CLI_PATH` 覆蓋廣告的 CLI 路徑。

### 2) Tailnet (跨網路)

對於倫敦/維也納風格的設置，Bonjour 不會有幫助。建議的「直接」目標是：

- Tailscale MagicDNS 名稱（首選）或穩定的 tailnet IP。

如果網關能夠檢測到它在 Tailscale 下執行，它會將 `tailnetDns` 發佈為用戶端（包括廣域信標）的可選提示。

### 3) 手動 / SSH 目標

當沒有直接路由（或直接路由被禁用）時，用戶端始終可以透過轉發迴圈回路閘道埠來進行 SSH 連接。

請參閱 [Remote access](/gateway/remote)。

## 運輸選擇（用戶端政策）

推薦的用戶端行為：

1. 如果已設定且可達的配對直接端點，則使用它。
2. 否則，如果 Bonjour 在 LAN 上找到一個網關，則提供一個一鍵“使用此網關”的選項並將其儲存為直接端點。
3. 否則，如果已設定 tailnet DNS/IP，則嘗試直接連接。
4. 否則，回退到 SSH。

## 配對 + 認證（直接傳輸）

閘道是節點/用戶端入場的真實來源。

- 配對請求在網關中創建/批准/拒絕（請參見 [Gateway pairing](/gateway/pairing)）。
- 網關強制執行：
  - 認證 (token / keypair)
  - 範圍/ACL（網關並不是每個方法的原始代理）
  - 速率限制

## 責任依組件劃分

- **Gateway**: 廣播發現信標，擁有配對決策，並主機 WS 端點。
- **macOS 應用程式**: 幫助您選擇一個 Gateway，顯示配對提示，並僅在必要時使用 SSH 作為備援。
- **iOS/Android 節點**: 方便地瀏覽 Bonjour 並連接到已配對的 Gateway WS。
