---
summary: "節點裝置探索與傳輸協定 (Bonjour, Tailscale, SSH) 以尋找 Gateway"
read_when:
  - 實作或變更 Bonjour 裝置探索/廣告
  - 調整遠端連線模式（直接連線 vs SSH）
  - 為遠端節點設計裝置探索 + 配對
title: "裝置探索與傳輸協定"
---

# 裝置探索與傳輸協定

OpenClaw 有兩個表面上看起來相似但截然不同的問題：

1.  **操作員遠端控制**：macOS 選單列應用程式控制在其他地方運行的 Gateway。
2.  **節點配對**：iOS/Android（以及未來的節點）尋找 Gateway並安全配對。

設計目標是將所有網路裝置探索/廣告保留在 **Node Gateway** (`openclaw gateway`) 中，並讓客戶端（mac 應用程式、iOS）作為消費者。

## 術語

-   **Gateway**：一個單一的長期運行 Gateway處理程序，擁有狀態（工作階段、配對、節點註冊）並運行頻道。大多數設定每個主機使用一個；也可以進行隔離的多 Gateway設定。
-   **Gateway WS (控制平面)**：預設在 `127.0.0.1:18789` 上的 WebSocket 端點；可透過 `gateway.bind` 綁定到 LAN/tailnet。
-   **直接 WS 傳輸協定**：一個面向 LAN/tailnet 的 Gateway WS 端點（無 SSH）。
-   **SSH 傳輸協定 (備用)**：透過 SSH 轉發 `127.0.0.1:18789` 進行遠端控制。
-   **傳統 TCP 橋接 (已棄用/移除)**：較舊的節點傳輸協定（參見 [橋接協定](/gateway/bridge-protocol)）；不再用於裝置探索廣告。

協定詳情：

-   [Gateway協定](/gateway/protocol)
-   [橋接協定 (傳統)](/gateway/bridge-protocol)

## 我們為何同時保留「直接」和 SSH

-   **直接 WS** 在同一個網路和 tailnet 內提供最佳的使用者體驗：
    -   透過 Bonjour 在 LAN 上自動裝置探索
    -   配對權杖 + ACL 由 Gateway擁有
    -   無需 shell 存取；協定介面可以保持嚴謹且可稽核
-   **SSH** 仍然是通用的備用方案：
    -   只要您有 SSH 存取權限即可運作（即使跨越不相關的網路）
    -   能應對多點傳播/mDNS 問題
    -   除 SSH 外無需新的入埠連接埠

## 裝置探索輸入 (客戶端如何得知 Gateway的位置)

### 1) Bonjour / mDNS (僅限 LAN)

Bonjour 盡力而為，且不跨網路。它僅用於「同一個 LAN」的便利性。

目標方向：

-   **Gateway** 透過 Bonjour 廣告其 WS 端點。
-   客戶端瀏覽並顯示「選擇 Gateway」清單，然後儲存選定的端點。

疑難排解與信標詳情：[Bonjour](/gateway/bonjour)。

#### 服務信標詳情

-   服務類型：
    -   `_openclaw-gw._tcp` (Gateway傳輸信標)
-   TXT 鍵 (非機密)：
    -   `role=gateway`
    -   `lanHost=<hostname>.local`
    -   `sshPort=22` (或任何廣告的連接埠)
    -   `gatewayPort=18789` (Gateway WS + HTTP)
    -   `gatewayTls=1` (僅當啟用 TLS 時)
    -   `gatewayTlsSha256=<sha256>` (僅當啟用 TLS 且指紋可用時)
    -   `canvasPort=18793` (預設畫布主機連接埠；服務 `/__openclaw__/canvas/`)
    -   `cliPath=<path>` (選用；可執行 `openclaw` 進入點或二進位檔的絕對路徑)
    -   `tailnetDns=<magicdns>` (選用提示；當 Tailscale 可用時自動偵測)

停用/覆寫：

-   `OPENCLAW_DISABLE_BONJOUR=1` 停用廣告。
-   `~/.openclaw/openclaw.json` 中的 `gateway.bind` 控制 Gateway綁定模式。
-   `OPENCLAW_SSH_PORT` 覆寫在 TXT 中廣告的 SSH 連接埠（預設為 22）。
-   `OPENCLAW_TAILNET_DNS` 發佈 `tailnetDns` 提示 (MagicDNS)。
-   `OPENCLAW_CLI_PATH` 覆寫廣告的 CLI 路徑。

### 2) Tailnet (跨網路)

對於倫敦/維也納風格的設定，Bonjour 無法提供幫助。建議的「直接」目標是：

-   Tailscale MagicDNS 名稱 (首選) 或穩定的 tailnet IP。

如果 Gateway能夠偵測到它正在 Tailscale 下運行，它會發布 `tailnetDns` 作為客戶端的可選提示（包括廣域信標）。

### 3) 手動 / SSH 目標

當沒有直接路由（或直接連接被停用）時，客戶端始終可以透過 SSH 轉發 local loopback Gateway連接埠來連接。

請參閱 [遠端存取](/gateway/remote)。

## 傳輸協定選擇 (客戶端策略)

建議的客戶端行為：

1.  如果已配置且可存取的已配對直接端點，請使用它。
2.  否則，如果 Bonjour 在 LAN 上找到 Gateway，請提供一鍵「使用此 Gateway」選項，並將其儲存為直接端點。
3.  否則，如果已配置 tailnet DNS/IP，請嘗試直接連接。
4.  否則，回退到 SSH。

## 配對 + 憑證 (直接傳輸協定)

Gateway是節點/客戶端准入的真相來源。

-   配對請求在 Gateway中建立/批准/拒絕（參見 [Gateway配對](/gateway/pairing)）。
-   Gateway強制執行：
    -   憑證（權杖 / 金鑰對）
    -   範圍/ACL（Gateway不是每個方法的原始代理）
    -   速率限制

## 各元件職責

-   **Gateway**：廣告裝置探索信標，擁有配對決策權，並託管 WS 端點。
-   **macOS 應用程式**：協助您選擇 Gateway，顯示配對提示，並僅將 SSH 作為備用方案。
-   **iOS/Android 節點**：瀏覽 Bonjour 以提供便利，並連接到已配對的 Gateway WS。
