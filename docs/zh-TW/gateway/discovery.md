---
summary: "用於尋找 Gateway 閘道器的節點探索與傳輸（Bonjour、Tailscale、SSH）"
read_when:
  - 實作或變更 Bonjour 探索／廣播
  - 調整遠端連線模式（直接 vs SSH）
  - 為遠端節點設計節點探索與配對
title: "探索與傳輸"
---

# Discovery & transports

OpenClaw 有兩個在表面上看起來相似、但實際上不同的問題：

1. **操作人員遠端控制**：macOS 選單列應用程式控制在其他地方執行的 Gateway 閘道器。
2. **節點配對**：iOS／Android（以及未來的節點）尋找 Gateway 閘道器並安全地進行配對。

設計目標是將所有網路探索／廣播集中在 **Node Gateway**（`openclaw gateway`）中，並讓用戶端（mac 應用程式、iOS）作為消費者。

## Terms

- **Gateway**：單一、長時間執行的 Gateway 閘道器程序，負責擁有狀態（工作階段、配對、節點登錄）並執行頻道。多數設定在每台主機上使用一個；也可以建立隔離的多 Gateway 架構。 Most setups use one per host; isolated multi-gateway setups are possible.
- **Gateway WS（控制平面）**：預設在 `127.0.0.1:18789` 的 WebSocket 端點；可透過 `gateway.bind` 綁定至 LAN／tailnet。
- **Direct WS 傳輸**：面向 LAN／tailnet 的 Gateway WS 端點（不使用 SSH）。
- **SSH 傳輸（後備）**：透過 SSH 轉送 `127.0.0.1:18789` 以進行遠端控制。
- **舊版 TCP 橋接（已棄用／移除）**：較早的節點傳輸方式（參見 [Bridge protocol](/gateway/bridge-protocol)）；已不再用於探索廣播。

通訊協定細節：

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol（舊版）](/gateway/bridge-protocol)

## 為何同時保留「直接」與 SSH

- **Direct WS** 在同一個網路或 tailnet 內提供最佳使用體驗：
  - 透過 Bonjour 在 LAN 上自動探索
  - 由 Gateway 閘道器管理配對權杖與 ACL
  - 不需要 shell 存取；通訊協定介面可保持精簡且可稽核
- **SSH** 仍是通用的後備方案：
  - 只要有 SSH 存取權即可在任何地方運作（即使跨越無關的網路）
  - 可避開多播／mDNS 的問題
  - 除了 SSH 之外，不需要開放新的入站連接埠

## 探索輸入（用戶端如何得知 Gateway 閘道器的位置）

### 1. Bonjour／mDNS（僅限 LAN）

Bonjour 為盡力而為，且不會跨網路。 僅用於「同一個 LAN」的便利性。

目標方向：

- **Gateway** 會透過 Bonjour 廣播其 WS 端點。
- 用戶端會瀏覽並顯示「選擇一個 Gateway」清單，然後儲存所選端點。

疑難排解與信標細節：[Bonjour](/gateway/bonjour)。

#### 服務信標細節

- 服務類型：
  - `_openclaw-gw._tcp`（Gateway 傳輸信標）
- TXT 金鑰（非機密）：
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22`（或任何被廣播的值）
  - `gatewayPort=18789`（Gateway WS + HTTP）
  - `gatewayTls=1`（僅在啟用 TLS 時）
  - `gatewayTlsSha256=<sha256>`（僅在啟用 TLS 且指紋可用時）
  - `canvasPort=18793`（預設畫布主機連接埠；提供 `/__openclaw__/canvas/`）
  - `cliPath=<path>`（選用；可執行的 `openclaw` 進入點或二進位檔的絕對路徑）
  - `tailnetDns=<magicdns>`（選用提示；當 Tailscale 可用時自動偵測）

Disable/override:

- `OPENCLAW_DISABLE_BONJOUR=1` 會停用廣播。
- `gateway.bind` 於 `~/.openclaw/openclaw.json` 中控制 Gateway 的綁定模式。
- `OPENCLAW_SSH_PORT` 會覆寫在 TXT 中廣播的 SSH 連接埠（預設為 22）。
- `OPENCLAW_TAILNET_DNS` 會發布 `tailnetDns` 提示（MagicDNS）。
- `OPENCLAW_CLI_PATH` overrides the advertised CLI path.

### 2. Tailnet（跨網路）

對於倫敦/維也納這類設定，Bonjour 無法提供協助。 The recommended “direct” target is:

- Tailscale MagicDNS 名稱（優先）或穩定的 tailnet IP。

如果 Gateway 閘道器能偵測到其在 Tailscale 環境下執行，會將 `tailnetDns` 作為選用提示發布給用戶端（包含廣域信標）。

### 3. 手動／SSH 目標

當沒有直接路由（或已停用直接連線）時，用戶端仍可透過 SSH 轉送 local loopback 的 Gateway 連接埠來連線。

請參見 [Remote access](/gateway/remote)。

## Transport selection (client policy)

建議的用戶端行為：

1. 若已設定且可連線的已配對直接端點存在，則使用它。
2. 否則，若 Bonjour 在 LAN 上找到 Gateway 閘道器，提供一鍵「使用此 Gateway」的選項，並將其儲存為直接端點。
3. 1. 否則，若已設定 tailnet DNS/IP，則嘗試直接連線。
4. 否則，退回使用 SSH。

## 配對與驗證（直接傳輸）

Gateway 是節點/用戶端准入的唯一真實來源。

- 配對請求會在 Gateway 中建立/核准/拒絕（請參閱 [Gateway pairing](/gateway/pairing)）。
- Gateway 閘道器會強制：
  - 驗證（權杖 / 金鑰對）
  - 範圍／ACL（Gateway 閘道器不是對所有方法的原始代理）
  - 速率限制

## 各元件的責任

- **Gateway 閘道器**：廣播探索信標、負責配對決策，並主控 WS 端點。
- **macOS 應用程式**：協助選擇 Gateway 閘道器、顯示配對提示，且僅在必要時使用 SSH 作為後備。
- **iOS／Android 節點**：將 Bonjour 作為便利方式進行瀏覽，並連線至已配對的 Gateway WS。
