---
summary: "透過 SSH 控制遠端 OpenClaw Gateway 閘道器的 macOS 應用程式流程"
read_when:
  - 設定或除錯遠端 mac 控制
title: "遠端控制"
---

# 遠端 OpenClaw（macOS ⇄ 遠端主機）

此流程可讓 macOS 應用程式作為在另一台主機（桌機／伺服器）上執行之 OpenClaw Gateway 閘道器的完整遠端控制器。這是應用程式的 **Remote over SSH**（遠端執行）功能。所有功能——健康檢查、Voice Wake 轉送與 Web Chat——都會重複使用來自 _Settings → General_ 的相同遠端 SSH 設定。 It’s the app’s **Remote over SSH** (remote run) feature. All features—health checks, Voice Wake forwarding, and Web Chat—reuse the same remote SSH configuration from _Settings → General_.

## 模式

- **Local（此 Mac）**：所有內容都在筆電上執行。不涉及 SSH。 No SSH involved.
- **Remote over SSH（預設）**：OpenClaw 指令在遠端主機上執行。mac 應用程式會使用 `-o BatchMode` 加上你選擇的身分／金鑰與本機連接埠轉送來開啟 SSH 連線。 The mac app opens an SSH connection with `-o BatchMode` plus your chosen identity/key and a local port-forward.
- **Remote direct (ws/wss)**: No SSH tunnel. The mac app connects to the gateway URL directly (for example, via Tailscale Serve or a public HTTPS reverse proxy).

## Remote transports

遠端模式支援兩種傳輸方式：

- **SSH 通道**（預設）：使用 `ssh -N -L ...` 將 Gateway 閘道器連接埠轉送到 localhost。由於通道是 loopback，Gateway 閘道器會將節點的 IP 視為 `127.0.0.1`。 The gateway will see the node’s IP as `127.0.0.1` because the tunnel is loopback.
- **Direct (ws/wss)**: Connects straight to the gateway URL. The gateway sees the real client IP.

## Prereqs on the remote host

1. 安裝 Node + pnpm，並建置／安裝 OpenClaw CLI（`pnpm install && pnpm build && pnpm link --global`）。
2. 確保 `openclaw` 對非互動式 shell 位於 PATH 上（必要時可建立符號連結到 `/usr/local/bin` 或 `/opt/homebrew/bin`）。
3. 使用金鑰驗證開啟 SSH。我們建議使用 **Tailscale** IP，以在非 LAN 環境下獲得穩定可達性。 We recommend **Tailscale** IPs for stable reachability off-LAN.

## macOS 應用程式設定

1. 開啟 _Settings → General_。
2. 在 **OpenClaw runs** 下，選擇 **Remote over SSH** 並設定：
   - **Transport**：**SSH tunnel** 或 **Direct（ws/wss）**。
   - **SSH target**：`user@host`（可選 `:port`）。
     - 若 Gateway 閘道器位於同一個 LAN 並公告 Bonjour，可從探索清單中選取以自動填入此欄位。
   - **Gateway URL**（僅 Direct）：`wss://gateway.example.ts.net`（或本機／LAN 使用 `ws://...`）。
   - **Identity file**（進階）：你的金鑰路徑。
   - **Project root**（進階）：用於執行指令的遠端檢出路徑。
   - **CLI path**（進階）：可選的可執行 `openclaw` 進入點／二進位檔路徑（公告時會自動填入）。
3. Hit **Test remote**. 點擊 **Test remote**。成功代表遠端 `openclaw status --json` 能正常執行。失敗通常表示 PATH／CLI 問題；結束碼 127 代表遠端找不到 CLI。 Failures usually mean PATH/CLI issues; exit 127 means the CLI isn’t found remotely.
4. 健康檢查與 Web Chat 現在會自動透過此 SSH 通道執行。

## Web Chat

- **SSH 通道**：Web Chat 會透過轉送的 WebSocket 控制連接埠（預設 18789）連線至 Gateway 閘道器。
- **Direct（ws/wss）**：Web Chat 會直接連線至設定的 Gateway 閘道器 URL。
- 不再有獨立的 WebChat HTTP 伺服器。

## 權限

- 遠端主機需要與本機相同的 TCC 核准（Automation、Accessibility、Screen Recording、Microphone、Speech Recognition、Notifications）。在該機器上執行入門引導一次即可授權。 Run onboarding on that machine to grant them once.
- 節點會透過 `node.list`／`node.describe` 公告其權限狀態，讓代理程式知道可用項目。

## 安全性注意事項

- 建議在遠端主機上偏好 loopback 綁定，並透過 SSH 或 Tailscale 連線。
- If you bind the Gateway to a non-loopback interface, require token/password auth.
- 請參閱 [Security](/gateway/security) 與 [Tailscale](/gateway/tailscale)。

## WhatsApp 登入流程（遠端）

- Run `openclaw channels login --verbose` **on the remote host**. Scan the QR with WhatsApp on your phone.
- Re-run login on that host if auth expires. Health check will surface link problems.

## Troubleshooting

- **exit 127／not found**：`openclaw` 未在非登入 shell 的 PATH 上。請將其加入 `/etc/paths`、你的 shell rc，或建立符號連結到 `/usr/local/bin`／`/opt/homebrew/bin`。 Add it to `/etc/paths`, your shell rc, or symlink into `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**：檢查 SSH 可達性、PATH，以及 Baileys 是否已登入（`openclaw status --json`）。
- **Web Chat 卡住**：確認 Gateway 閘道器正在遠端主機上執行，且轉送的連接埠與 Gateway WS 連接埠一致；UI 需要健康的 WS 連線。
- **Node IP 顯示 127.0.0.1**：在 SSH 通道下屬於預期行為。若希望 Gateway 閘道器看到真實的用戶端 IP，請將 **Transport** 切換為 **Direct（ws/wss）**。 Switch **Transport** to **Direct (ws/wss)** if you want the gateway to see the real client IP.
- **Voice Wake**：在遠端模式下會自動轉送觸發片語；不需要額外的轉送器。

## 通知音效

可使用 `openclaw` 與 `node.invoke` 的腳本，為每則通知選擇音效，例如：

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

應用程式已不再提供全域「預設音效」切換；呼叫端需為每個請求選擇音效（或不選）。
