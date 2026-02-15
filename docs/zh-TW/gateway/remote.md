---
summary: "使用 SSH 通道 (Gateway WS) 與 tailnets 進行遠端存取"
read_when:
  - 執行或排除遠端 Gateway 設定故障時
title: "遠端存取"
---

# 遠端存取 (SSH、通道與 tailnets)

此存放庫支援「透過 SSH 進行遠端存取」，方法是在專用主機（桌上型電腦/伺服器）上執行單個 Gateway（主節點），並將用戶端連接至該主機。

- 針對 **操作人員（您 / macOS 應用程式）**：SSH 通道是通用的備用方案。
- 針對 **節點 (iOS/Android 及未來裝置)**：連接至 Gateway **WebSocket**（根據需求使用區域網路/tailnet 或 SSH 通道）。

## 核心概念

- Gateway WebSocket 會綁定到您設定埠號上的 **loopback**（預設為 18789）。
- 若要遠端使用，您需要透過 SSH 轉發該 loopback 埠號（或使用 tailnet/VPN 以減少通道需求）。

## 常見的 VPN/tailnet 設定（智慧代理所在地）

將 **Gateway 主機** 視為「智慧代理所在地」。它擁有工作階段、認證設定檔、頻道和狀態。
您的筆記型電腦/桌上型電腦（以及節點）會連接到該主機。

### 1) tailnet 中全天候運作的 Gateway (VPS 或家用伺服器)

在持續運作的主機上執行 Gateway，並透過 **Tailscale** 或 SSH 存取。

- **最佳使用者體驗：** 保留 `gateway.bind: "loopback"` 並使用 **Tailscale Serve** 處理控制介面 (Control UI)。
- **備用方案：** 保留 loopback 並從任何需要存取的機器建立 SSH 通道。
- **範例：** [exe.dev](/install/exe-dev) (簡易 VM) 或 [Hetzner](/install/hetzner) (生產環境 VPS)。

當您的筆記型電腦經常進入睡眠狀態，但您希望智慧代理全天候運作時，這是理想的選擇。

### 2) 家用桌機執行 Gateway，筆電作為遠端控制

筆記型電腦 **不** 執行智慧代理。它是透過遠端連接：

- 使用 macOS 應用程式的 **Remote over SSH** 模式（設定 → 一般 → 「OpenClaw 執行方式」）。
- 應用程式會開啟並管理通道，因此 WebChat 與健康檢查能直接運作。

操作手冊：[macOS 遠端存取](/platforms/mac/remote)。

### 3) 筆電執行 Gateway，從其他機器遠端存取

將 Gateway 保持在本地，但安全地暴露它：

- 從其他機器建立 SSH 通道至筆記型電腦，或
- 使用 Tailscale Serve 處理控制介面 (Control UI)，並保持 Gateway 僅限 loopback。

指南：[Tailscale](/gateway/tailscale) 與 [Web 概覽](/web)。

## 指令流程（各組件執行位置）

一個 Gateway 服務擁有狀態與頻道。節點則是周邊設備。

流程範例 (Telegram → node)：

- Telegram 訊息抵達 **Gateway**。
- Gateway 執行 **智慧代理** 並決定是否呼叫節點工具。
- Gateway 透過 Gateway WebSocket (`node.*` RPC) 呼叫 **節點**。
- 節點回傳結果；Gateway 將回覆傳送回 Telegram。

注意事項：

- **節點不執行 Gateway 服務。** 每台主機應僅執行一個 Gateway，除非您刻意執行隔離的設定檔（請參閱 [多個 Gateway](/gateway/multiple-gateways)）。
- macOS 應用程式的「節點模式」僅是透過 Gateway WebSocket 運作的節點用戶端。

## SSH 通道 (CLI 與工具)

建立至遠端 Gateway WS 的本地通道：

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

通道建立後：

- `openclaw health` 與 `openclaw status --deep` 現在會透過 `ws://127.0.0.1:18789` 存取遠端 Gateway。
- `openclaw gateway {status,health,send,agent,call}` 在需要時也可以透過 `--url` 指定轉發的 URL。

注意：請將 `18789` 替換為您設定的 `gateway.port`（或 `--port`/`OPENCLAW_GATEWAY_PORT`）。
注意：當您傳遞 `--url` 時，CLI 不會退而使用設定檔或環境變數中的憑證。
請明確包含 `--token` 或 `--password`。缺少明確憑證將會導致錯誤。

## CLI 遠端預設值

您可以持久化遠端目標，使 CLI 指令預設使用它：

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

當 Gateway 僅限 loopback 時，請將 URL 保持為 `ws://127.0.0.1:18789` bing 並先開啟 SSH 通道。

## 透過 SSH 使用聊天介面

WebChat 不再使用獨立的 HTTP 埠號。SwiftUI 聊天介面會直接連接至 Gateway WebSocket。

- 透過 SSH 轉發 `18789`（見上文），然後將用戶端連接至 `ws://127.0.0.1:18789`。
- 在 macOS 上，建議優先使用應用程式的「Remote over SSH」模式，它會自動管理通道。

## macOS 應用程式「Remote over SSH」

macOS 選單列應用程式可以執行相同的端對端設定（遠端狀態檢查、WebChat 以及語音喚醒轉發）。

操作手冊：[macOS 遠端存取](/platforms/mac/remote)。

## 安全規則 (遠端/VPN)

簡短版本：除非您確定需要綁定，否則請 **保持 Gateway 僅限 loopback**。

- **Loopback + SSH/Tailscale Serve** 是最安全的預設設定（無公網暴露風險）。
- 非 loopback 綁定（`lan`/`tailnet`/`custom`，或當 loopback 不可用時的 `auto`）必須使用認證權杖 (token)/密碼。
- `gateway.remote.token` **僅** 用於遠端 CLI 呼叫 —— 它 **不會** 啟用本地認證。
- 當使用 `wss://` 時，`gateway.remote.tlsFingerprint` 會釘選遠端 TLS 憑證。
- 當 `gateway.auth.allowTailscale: true` 時，Tailscale Serve 可以透過身分識別標頭進行認證。
  如果您想改用權杖/密碼，請將其設為 `false`。
- 將瀏覽器控制視為操作人員存取：僅限 tailnet + 謹慎的節點配對。

深度探討：[安全性](/gateway/security)。
