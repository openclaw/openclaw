---
summary: "用於尋找 Gateway 的節點裝置探索與傳輸協定 (Bonjour, Tailscale, SSH)"
read_when:
  - 實作或變更 Bonjour 裝置探索/廣告 (Advertising) 時
  - 調整遠端連線模式（直接連線與 SSH）時
  - 為遠端節點設計節點裝置探索 + 配對功能時
title: "裝置探索與傳輸協定"
---

# 裝置探索與傳輸協定

OpenClaw 面臨兩個表面上相似但性質不同的問題：

1. **操作員遠端控制**：macOS 選單列應用程式控制在其他地方執行的 Gateway。
2. **節點配對**：iOS/Android（以及未來的節點）尋找 Gateway 並進行安全配對。

設計目標是將所有網路裝置探索/廣告 (Advertising) 集中在 **Node Gateway** (`openclaw gateway`)，並讓用戶端（mac 應用程式、iOS）扮演取用者的角色。

## 術語

- **Gateway**：單個長期執行的 Gateway 程序，擁有狀態（工作階段、配對、節點註冊表）並執行頻道。大多數設定中每個主機使用一個；也可以實現隔離的多 Gateway 設定。
- **Gateway WS (控制平面)**：預設在 `127.0.0.1:18789` 的 WebSocket 端點；可以透過 `gateway.bind` 繫結到區域網路 (LAN) 或 tailnet。
- **直接 WS 傳輸 (Direct WS transport)**：面向區域網路/tailnet 的 Gateway WS 端點（不經過 SSH）。
- **SSH 傳輸 (後備方案)**：透過 SSH 轉發 `127.0.0.1:18789` 來進行遠端控制。
- **舊版 TCP 橋接 (已棄用/移除)**：較舊的節點傳輸方式（請參閱 [Bridge 協定](/gateway/bridge-protocol)）；不再透過裝置探索進行廣告。

協定詳情：

- [Gateway 協定](/gateway/protocol)
- [Bridge 協定 (舊版)](/gateway/bridge-protocol)

## 為何我們同時保留「直接連線」與 SSH

- **直接 WS (Direct WS)** 是在相同網路或 tailnet 內最佳的使用者體驗：
  - 透過 Bonjour 在區域網路上自動探索
  - 由 Gateway 擁有的配對權杖與 ACL
  - 不需要 Shell 存取權限；協定介面可以保持嚴謹且可稽核
- **SSH** 仍是萬用的後備方案：
  - 只要有 SSH 存取權限，在任何地方都能運作（即使是無關的網路）
  - 在多點傳送 (Multicast)/mDNS 出現問題時仍可運作
  - 除了 SSH 之外，不需要開啟新的入站連接埠

## 裝置探索輸入（用戶端如何得知 Gateway 位置）

### 1) Bonjour / mDNS (僅限區域網路)

Bonjour 是「盡力而為」的服務，且無法跨網路運作。它僅用於「同區域網路」的便利性。

目標方向：

- **Gateway** 透過 Bonjour 廣告其 WS 端點。
- 用戶端瀏覽並顯示「選擇一個 Gateway」列表，然後儲存所選的端點。

疑難排解與指標 (Beacon) 詳情：[Bonjour](/gateway/bonjour)。

#### 服務指標 (Service beacon) 詳情

- 服務類型：
  - `_openclaw-gw._tcp` (Gateway 傳輸指標)
- TXT 鍵名（非機密）：
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22`（或任何廣告的連接埠）
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1`（僅在啟用 TLS 時）
  - `gatewayTlsSha256=<sha256>`（僅在啟用 TLS 且指紋可用時）
  - `canvasPort=18793`（預設的 canvas 主機連接埠；提供 `/__openclaw__/canvas/`）
  - `cliPath=<path>`（選填；可執行 `openclaw` 入口點或二進位檔案的絕對路徑）
  - `tailnetDns=<magicdns>`（選填提示；在 Tailscale 可用時自動偵測）

停用/覆寫：

- `OPENCLAW_DISABLE_BONJOUR=1` 停用廣告功能。
- `~/.openclaw/openclaw.json` 中的 `gateway.bind` 控制 Gateway 的繫結模式。
- `OPENCLAW_SSH_PORT` 覆寫 TXT 中廣告的 SSH 連接埠（預設為 22）。
- `OPENCLAW_TAILNET_DNS` 發佈 `tailnetDns` 提示 (MagicDNS)。
- `OPENCLAW_CLI_PATH` 覆寫廣告的 CLI 路徑。

### 2) Tailnet (跨網路)

對於倫敦/維也納風格的設定，Bonjour 無法提供幫助。建議的「直接連線」目標為：

- Tailscale MagicDNS 名稱（偏好）或穩定的 tailnet IP。

如果 Gateway 偵測到其在 Tailscale 下執行，它會發佈 `tailnetDns` 作為用戶端的選填提示（包括廣域指標）。

### 3) 手動 / SSH 目標

當沒有直接路徑（或停用直接連線）時，用戶端始終可以透過轉發 loopback 的 Gateway 連接埠，經由 SSH 進行連線。

請參閱 [遠端存取](/gateway/remote)。

## 傳輸選擇（用戶端原則）

建議的用戶端行為：

1. 如果已設定且可連線到已配對的直接端點，則使用該端點。
2. 否則，如果 Bonjour 在區域網路上找到 Gateway，則提供一鍵式「使用此 Gateway」的選擇，並將其儲存為直接端點。
3. 否則，如果已設定 tailnet DNS/IP，則嘗試直接連線。
4. 否則，後備使用 SSH。

## 配對 + 認證（直接傳輸）

Gateway 是節點/用戶端存取許可的單一事實來源。

- 配對請求在 Gateway 中建立/核准/拒絕（請參閱 [Gateway 配對](/gateway/pairing)）。
- Gateway 強制執行：
  - 認證（權杖 / 金鑰對）
  - 範圍/ACL（Gateway 並非對每個方法的原始代理）
  - 速率限制

## 各組件職責

- **Gateway**：發佈裝置探索指標、擁有配對決策權，並託管 WS 端點。
- **macOS 應用程式**：幫助您選擇 Gateway、顯示配對提示，並僅將 SSH 作為後備方案。
- **iOS/Android 節點**：瀏覽 Bonjour 作為便利功能，並連線到已配對的 Gateway WS。
