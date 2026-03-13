---
summary: Remote access using SSH tunnels (Gateway WS) and tailnets
read_when:
  - Running or troubleshooting remote gateway setups
title: Remote Access
---

# 遠端存取 (SSH、隧道與尾網)

此倉庫透過在專用主機（桌面/伺服器）上執行單一的閘道（主控端）來支援「透過 SSH 的遠端連接」，並將用戶端連接到它。

- 對於 **操作員（你 / macOS 應用程式）**：SSH 隧道是通用的備用方案。
- 對於 **節點（iOS/Android 及未來設備）**：根據需要連接到 Gateway **WebSocket**（LAN/tailnet 或 SSH 隧道）。

## 核心理念

- Gateway WebSocket 綁定到您設定的端口上的 **loopback**（預設為 18789）。
- 若要進行遠端使用，您需要透過 SSH 轉發該 loopback 端口（或使用 tailnet/VPN 並減少隧道的使用）。

## 常見的 VPN/tailnet 設定（代理程式所在的位置）

將 **Gateway host** 想像成「代理程式所在的地方」。它擁有會話、身份驗證設定檔、通道和狀態。你的筆記型電腦/桌面電腦（以及節點）連接到該主機。

### 1) 在您的 tailnet 中的常駐網關 (VPS 或家庭伺服器)

在持久主機上執行 Gateway，並通過 **Tailscale** 或 SSH 進行訪問。

- **最佳使用者體驗：** 保留 `gateway.bind: "loopback"` 並使用 **Tailscale Serve** 作為控制介面。
- **備援方案：** 保留迴圈回路 + 從任何需要訪問的機器進行 SSH 隧道。
- **範例：** [exe.dev](/install/exe-dev)（簡易虛擬機）或 [Hetzner](/install/hetzner)（生產 VPS）。

這在你的筆記型電腦經常進入睡眠狀態，但你希望代理程式始終保持啟用時是理想的。

### 2) 家用桌面電腦執行 Gateway，筆記型電腦作為遙控器

筆記型電腦**不**執行代理程式。它是遠端連接的：

- 使用 macOS 應用程式的 **透過 SSH 遠端** 模式（設定 → 一般 → “OpenClaw 執行”）。
- 應用程式會開啟並管理隧道，因此 WebChat + 健康檢查“運作正常”。

Runbook: [macOS 遠端存取](/platforms/mac/remote).

### 3) 筆記型電腦執行 Gateway，並可從其他機器進行遠端存取

保持閘道器在本地，但安全地公開它：

- 從其他機器透過 SSH 隧道連接到筆記型電腦，或
- 使用 Tailscale 提供控制 UI，並保持 Gateway 僅限回環。

指南: [Tailscale](/gateway/tailscale) 和 [網頁概覽](/web)。

## Command flow (what runs where)

一個閘道服務擁有狀態 + 通道。節點是周邊設備。

[[BLOCK_1]]  
Flow example (Telegram → node):  
[[BLOCK_1]]

- Telegram 訊息到達 **Gateway**。
- Gateway 執行 **agent** 並決定是否呼叫節點工具。
- Gateway 通過 Gateway WebSocket (`node.*` RPC) 呼叫 **node**。
- Node 返回結果；Gateway 將回覆發送回 Telegram。

Notes:

- **節點不執行閘道服務。** 每個主機上應該只執行一個閘道，除非您故意執行隔離的設定檔（請參見 [多個閘道](/gateway/multiple-gateways)）。
- macOS 應用程式的「節點模式」只是透過閘道 WebSocket 的一個節點用戶端。

## SSH 隧道 (CLI + 工具)

建立一個本地隧道到遠端 Gateway WS：

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

[[BLOCK_1]]  
With the tunnel up:  
[[BLOCK_1]]

- `openclaw health` 和 `openclaw status --deep` 現在透過 `ws://127.0.0.1:18789` 連接到遠端閘道。
- `openclaw gateway {status,health,send,agent,call}` 也可以在需要時透過 `--url` 針對轉發的 URL。

注意：將 `18789` 替換為您設定的 `gateway.port`（或 `--port`/`OPENCLAW_GATEWAY_PORT`）。  
注意：當您傳遞 `--url` 時，CLI 不會回退到設定或環境憑證。  
明確包含 `--token` 或 `--password`。缺少明確的憑證將會導致錯誤。

## CLI 遠端預設值

您可以持久化遠端目標，以便 CLI 命令預設使用它：

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

當閘道器僅限回環時，請保持 URL 在 `ws://127.0.0.1:18789` 並先開啟 SSH 隧道。

## Credential precedence

Gateway 憑證解析遵循一個共享的合約，適用於呼叫/探測/狀態路徑以及 Discord 執行批准監控。Node-host 使用相同的基本合約，但有一個本地模式的例外（它故意忽略 `gateway.remote.*`）：

- 明確的憑證 (`--token`, `--password`, 或工具 `gatewayToken`) 在接受明確身份驗證的呼叫路徑中始終優先。
- URL 覆蓋安全性：
  - CLI URL 覆蓋 (`--url`) 永遠不會重用隱式設定/環境憑證。
  - 環境 URL 覆蓋 (`OPENCLAW_GATEWAY_URL`) 只能使用環境憑證 (`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`)。
- 本地模式預設：
  - token: `OPENCLAW_GATEWAY_TOKEN` -> `gateway.auth.token` -> `gateway.remote.token` （當本地身份驗證 token 輸入未設置時，適用遠端回退）
  - password: `OPENCLAW_GATEWAY_PASSWORD` -> `gateway.auth.password` -> `gateway.remote.password` （當本地身份驗證密碼輸入未設置時，適用遠端回退）
- 遠端模式預設：
  - token: `gateway.remote.token` -> `OPENCLAW_GATEWAY_TOKEN` -> `gateway.auth.token`
  - password: `OPENCLAW_GATEWAY_PASSWORD` -> `gateway.remote.password` -> `gateway.auth.password`
- Node-host 本地模式例外：`gateway.remote.token` / `gateway.remote.password` 被忽略。
- 遠端探測/狀態 token 檢查預設為嚴格：當針對遠端模式時，它們僅使用 `gateway.remote.token` （不進行本地 token 回退）。
- 過時的 `CLAWDBOT_GATEWAY_*` 環境變數僅由相容性呼叫路徑使用；探測/狀態/身份驗證解析僅使用 `OPENCLAW_GATEWAY_*`。

## Chat UI over SSH

WebChat 不再使用單獨的 HTTP 埠。SwiftUI 聊天介面直接連接到 Gateway WebSocket。

- 通過 SSH 轉發 `18789`（見上文），然後將用戶端連接到 `ws://127.0.0.1:18789`。
- 在 macOS 上，建議使用應用程式的「透過 SSH 遠端」模式，該模式會自動管理隧道。

## macOS 應用程式 “Remote over SSH”

macOS 選單列應用程式可以實現相同的端到端設置（遠端狀態檢查、WebChat 和語音喚醒轉發）。

Runbook: [macOS 遠端存取](/platforms/mac/remote).

## 安全規則 (遠端/VPN)

簡短版本：**保持 Gateway 僅限回環**，除非你確定需要綁定。

- **Loopback + SSH/Tailscale Serve** 是最安全的預設選項（不公開暴露）。
- 明文 `ws://` 預設僅限於回環使用。對於受信任的私人網路，請在用戶端過程中設置 `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` 作為緊急措施。
- **非回環綁定** (`lan`/`tailnet`/`custom`，或在回環不可用時使用 `auto`) 必須使用身份驗證token/密碼。
- `gateway.remote.token` / `.password` 是用戶端憑證來源。它們本身並不設定伺服器身份驗證。
- 本地呼叫路徑僅在 `gateway.auth.*` 未設置時可以使用 `gateway.remote.*` 作為後備。
- 如果 `gateway.auth.token` / `gateway.auth.password` 透過 SecretRef 明確設定且未解析，則解析將失敗並關閉（不會有遠端後備遮罩）。
- `gateway.remote.tlsFingerprint` 在使用 `wss://` 時固定遠端 TLS 憑證。
- **Tailscale Serve** 可以通過身份標頭對控制 UI/WebSocket 流量進行身份驗證，當 `gateway.auth.allowTailscale: true`；HTTP API 端點仍然需要token/密碼身份驗證。這種無token流程假設閘道主機是受信任的。如果希望在所有地方使用token/密碼，請將其設置為 `false`。
- 將瀏覽器控制視為操作員訪問：僅限 tailnet + 故意的節點配對。

深入探討：[安全性](/gateway/security)。
