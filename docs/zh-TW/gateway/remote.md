---
summary: "使用 SSH 通道（Gateway WS）和 tailnets 進行遠端存取"
read_when:
  - 執行或疑難排解遠端 Gateway設定
title: "遠端存取"
---

# 遠端存取 (SSH、通道和 tailnets)

此專案支援「透過 SSH 遠端連線」，透過在專用主機（桌面/伺服器）上執行單一 Gateway（主機），並讓用戶端連接到它。

- 對於**操作人員（您 / macOS 應用程式）**：SSH 通道是通用的備用方案。
- 對於**節點（iOS/Android 和未來裝置）**：連接到 Gateway **WebSocket**（依需求透過 LAN/tailnet 或 SSH 通道）。

## 核心概念

- Gateway WebSocket 繫結至您設定的連接埠上的 **loopback**（預設為 18789）。
- 用於遠端使用時，您可以透過 SSH 轉發該 loopback 連接埠（或使用 tailnet/VPN 以減少通道需求）。

## 常見的 VPN/tailnet 設定（智慧代理所在位置）

將 **Gateway主機**視為「智慧代理所在的位置」。它擁有工作階段、認證設定檔、頻道和狀態。
您的筆記型電腦/桌面（以及節點）會連接到該主機。

### 1) 在您的 tailnet 中永續運行的 Gateway（VPS 或家用伺服器）

在永續主機上執行 Gateway，並透過 **Tailscale** 或 SSH 存取它。

- **最佳使用者體驗：** 保持 `gateway.bind: "loopback"` 並使用 **Tailscale Serve** 作為控制使用者介面。
- **備用方案：** 保持 loopback + 從任何需要存取的機器建立 SSH 通道。
- **範例：** [exe.dev](/install/exe-dev)（簡易虛擬機器）或 [Hetzner](/install/hetzner)（生產級 VPS）。

當您的筆記型電腦經常休眠但您希望智慧代理持續運行時，這是一個理想選擇。

### 2) 家用桌面電腦執行 Gateway，筆記型電腦作為遠端控制端

筆記型電腦**不**執行智慧代理。它以遠端方式連接：

- 使用 macOS 應用程式的 **透過 SSH 遠端連線** 模式（「設定」→「一般」→「OpenClaw runs」）。
- 該應用程式會開啟並管理通道，因此 WebChat + 健康檢查「就能正常運作」。

操作手冊：[macOS 遠端存取](/platforms/mac/remote)。

### 3) 筆記型電腦執行 Gateway，從其他機器遠端存取

保持 Gateway在本地但安全地對外公開：

- 從其他機器建立 SSH 通道到筆記型電腦，或
- 透過 Tailscale Serve 控制使用者介面並保持 Gateway僅限 loopback。

指南：[Tailscale](/gateway/tailscale) 和 [Web 概觀](/web)。

## 命令流程（執行位置）

一個 Gateway 服務擁有狀態 + 頻道。節點是週邊裝置。

流程範例 (Telegram → node)：

- Telegram 訊息抵達 **Gateway**。
- Gateway執行**智慧代理**並決定是否呼叫節點工具。
- Gateway透過 Gateway WebSocket 呼叫**節點**（`node.*` RPC）。
- 節點傳回結果；Gateway回覆到 Telegram。

注意事項：

- **節點不執行 Gateway服務。** 除非您有意執行隔離的設定檔，否則每個主機只應執行一個 Gateway（請參閱[多個 Gateway](/gateway/multiple-gateways)）。
- macOS 應用程式的「節點模式」只是透過 Gateway WebSocket 的節點用戶端。

## SSH 通道 (CLI + 工具)

建立到遠端 Gateway WS 的本地通道：

```bash
ssh -N -L 18789:127.0.0.1:18789 user @host
```

通道建立後：

- `openclaw health` 和 `openclaw status --deep` 現在透過 `ws://127.0.0.1:18789` 存取遠端 Gateway。
- `openclaw gateway {status,health,send,agent,call}` 在需要時也可以透過 `--url` 指定轉發的 URL。

注意：將 `18789` 取代為您設定的 `gateway.port`（或 `--port`/`OPENCLAW_GATEWAY_PORT`）。
注意：當您傳遞 `--url` 時，CLI 不會回退到設定或環境憑證。
明確包含 `--token` 或 `--password`。缺少明確憑證將導致錯誤。

## CLI 遠端預設值

您可以將遠端目標持久化，以便 CLI 命令預設使用它：

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

當 Gateway僅限 loopback 時，保持 URL 為 `ws://127.0.0.1:18789` 並先開啟 SSH 通道。

## 透過 SSH 的聊天使用者介面

WebChat 不再使用獨立的 HTTP 連接埠。SwiftUI 聊天使用者介面會直接連接到 Gateway WebSocket。

- 透過 SSH 轉發 `18789`（見上文），然後讓用戶端連接到 `ws://127.0.0.1:18789`。
- 在 macOS 上，優先使用應用程式的「透過 SSH 遠端連線」模式，它會自動管理通道。

## macOS 應用程式的「透過 SSH 遠端連線」

macOS 選單列應用程式可以端對端地驅動相同的設定（遠端狀態檢查、WebChat 和語音喚醒轉發）。

操作手冊：[macOS 遠端存取](/platforms/mac/remote)。

## 安全規則 (遠端/VPN)

簡短版本：**保持 Gateway僅限 loopback**，除非您確定需要繫結。

- **Loopback + SSH/Tailscale Serve** 是最安全的預設值（無公開暴露）。
- **非 loopback 繫結**（`lan`/`tailnet`/`custom`，或當 loopback 不可用時的 `auto`）必須使用認證權杖/密碼。
- `gateway.remote.token` **僅**用於遠端 CLI 呼叫 — 它**不**啟用本地認證。
- `gateway.remote.tlsFingerprint` 在使用 `wss://` 時固定遠端 TLS 憑證。
- **Tailscale Serve** 可以透過身分標頭進行認證，當 `gateway.auth.allowTailscale: true` 時。
  如果您希望改用權杖/密碼，請將其設為 `false`。
- 將瀏覽器控制視為操作人員存取：僅限 tailnet + 刻意節點配對。

深入探討：[安全](/gateway/security)。
