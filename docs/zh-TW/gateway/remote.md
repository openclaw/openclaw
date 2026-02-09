---
summary: "使用 SSH 通道（Gateway WS）與 tailnet 的遠端存取"
read_when:
  - 執行或疑難排解遠端 Gateway 設定時
title: "13. 遠端存取"
---

# 遠端存取（SSH、通道與 tailnet）

此 repo 透過在專用主機（桌機／伺服器）上維持單一 Gateway（主節點）運行，並讓用戶端連線至它，來支援「透過 SSH 遠端連線」。

- 對 **操作人員（你／macOS App）**：SSH 通道是通用的備援方案。
- 對 **節點（iOS／Android 與未來裝置）**：連線至 Gateway **WebSocket**（依需求使用 LAN／tailnet 或 SSH 通道）。

## 核心概念

- Gateway WebSocket 綁定在你設定的連接埠之 **loopback**（預設為 18789）。
- 若需遠端使用，透過 SSH 轉送該 loopback 連接埠（或使用 tailnet／VPN 以減少通道需求）。

## 常見的 VPN／tailnet 設定（代理程式所在位置）

Think of the **Gateway host** as “where the agent lives.” It owns sessions, auth profiles, channels, and state.
Your laptop/desktop (and nodes) connect to that host.

### 1. tailnet 中的常駐 Gateway（VPS 或家用伺服器）

在持久運作的主機上執行 Gateway，並透過 **Tailscale** 或 SSH 存取。

- **最佳體驗：** 保留 `gateway.bind: "loopback"`，並使用 **Tailscale Serve** 提供 Control UI。
- **備援：** 維持 loopback + 從任何需要存取的機器建立 SSH 通道。
- **範例：** [exe.dev](/install/exe-dev)（簡易 VM）或 [Hetzner](/install/hetzner)（正式環境 VPS）。

當你的筆電經常休眠，但你希望代理程式全年無休時，這是理想方案。

### 2. 家用桌機執行 Gateway，筆電作為遠端控制

筆電 **不** 執行代理程式，而是遠端連線： It connects remotely:

- 使用 macOS App 的 **Remote over SSH** 模式（設定 → 一般 →「OpenClaw runs」）。
- App 會開啟並管理通道，因此 WebChat 與健康檢查可「即刻可用」。

操作手冊：[macOS 遠端存取](/platforms/mac/remote)。

### 3. 筆電執行 Gateway，其他機器進行遠端存取

保留 Gateway 在本機，同時安全地對外提供：

- 從其他機器以 SSH 通道連至筆電，或
- 使用 Tailscale Serve 提供 Control UI，並讓 Gateway 僅綁定 loopback。

指南：[Tailscale](/gateway/tailscale) 與 [Web 概覽](/web)。

## 指令流程（各元件執行位置）

One gateway service owns state + channels. Nodes are peripherals.

流程範例（Telegram → 節點）：

- Telegram 訊息抵達 **Gateway**。
- Gateway 執行 **代理程式**，並決定是否呼叫節點工具。
- Gateway 透過 Gateway WebSocket（`node.*` RPC）呼叫 **節點**。
- 節點回傳結果；Gateway 再回覆至 Telegram。

注意事項：

- **節點不會執行 gateway 服務。** 每台主機僅應執行一個 gateway，除非你刻意執行隔離的設定檔（請見 [多個 gateways](/gateway/multiple-gateways)）。
- macOS App 的「node mode」只是透過 Gateway WebSocket 連線的節點用戶端。

## SSH 通道（CLI 與工具）

建立到遠端 Gateway WS 的本機通道：

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

通道建立後：

- `openclaw health` 與 `openclaw status --deep` 現在會透過 `ws://127.0.0.1:18789` 存取遠端 gateway。
- 需要時，`openclaw gateway {status,health,send,agent,call}` 也可透過 `--url` 指向轉送後的 URL。

注意：請將 `18789` 替換為你設定的 `gateway.port`（或 `--port`/`OPENCLAW_GATEWAY_PORT`）。
注意：當你傳入 `--url` 時，CLI 不會回退使用設定或環境變數中的憑證。
請明確包含 `--token` 或 `--password`。缺少明確憑證會視為錯誤。
Note: when you pass `--url`, the CLI does not fall back to config or environment credentials.
21. 請明確包含 `--token` 或 `--password`。 22. 缺少明確憑證會被視為錯誤。

## CLI 遠端預設值

你可以將遠端目標保存為預設，讓 CLI 指令自動使用：

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

當 gateway 僅綁定 loopback 時，請將 URL 維持在 `ws://127.0.0.1:18789`，並先開啟 SSH 通道。

## 透過 SSH 的聊天 UI

WebChat no longer uses a separate HTTP port. WebChat 不再使用獨立的 HTTP 連接埠。SwiftUI 聊天 UI 會直接連線至 Gateway WebSocket。

- 透過 SSH 轉送 `18789`（見上文），然後讓用戶端連線至 `ws://127.0.0.1:18789`。
- 在 macOS 上，優先使用 App 的「Remote over SSH」模式，它會自動管理通道。

## macOS App 的「Remote over SSH」

macOS 選單列 App 可端到端地驅動相同設定（遠端狀態檢查、WebChat 與 Voice Wake 轉送）。

操作手冊：[macOS 遠端存取](/platforms/mac/remote)。

## 安全性規則（遠端／VPN）

簡要版：**除非你確定需要對外綁定，否則請讓 Gateway 僅綁定 loopback。**

- **Loopback + SSH／Tailscale Serve** 是最安全的預設（不對外公開）。
- **非 loopback 綁定**（`lan`/`tailnet`/`custom`，或在 loopback 不可用時使用 `auto`）必須使用身分驗證權杖／密碼。
- `gateway.remote.token` **僅** 用於遠端 CLI 呼叫 — **不會** 啟用本機身分驗證。
- 使用 `wss://` 時，`gateway.remote.tlsFingerprint` 會固定遠端 TLS 憑證。
- 當 `gateway.auth.allowTailscale: true` 時，**Tailscale Serve** 可透過身分識別標頭進行驗證。
  若你改用權杖／密碼，請將其設為 `false`。
  Set it to `false` if you want tokens/passwords instead.
- 25. 將瀏覽器控制視為操作員存取：僅限 tailnet + 審慎的節點配對。

深入說明：[安全性](/gateway/security)。
