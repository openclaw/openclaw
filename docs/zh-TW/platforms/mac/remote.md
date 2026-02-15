---
summary: "macOS 應用程式透過 SSH 控制遠端 OpenClaw Gateway 的流程"
read_when:
  - 設定或偵錯遠端 Mac 控制
title: "遠端控制"
---

# 遠端 OpenClaw (macOS ⇄ 遠端主機)

此流程讓 macOS 應用程式作為運行在另一個主機 (桌面/伺服器) 上 OpenClaw Gateway 的完整遠端控制。這是應用程式的 **Remote over SSH** (遠端執行) 功能。所有功能—健康檢查、語音喚醒轉發和網路聊天—都重複使用 _設定 → 一般_ 中的相同遠端 SSH 設定。

## 模式

- **Local (this Mac)**：所有東西都在筆記型電腦上執行。不涉及 SSH。
- **Remote over SSH (預設)**：OpenClaw 指令在遠端主機上執行。Mac 應用程式使用 `-o BatchMode` 以及您選擇的身份/金鑰和一個本地連接埠轉發開啟 SSH 連線。
- **Remote direct (ws/wss)**：沒有 SSH 通道。Mac 應用程式直接連接到 Gateway URL (例如，透過 Tailscale Serve 或公共 HTTPS 反向代理)。

## 遠端傳輸

遠端模式支援兩種傳輸：

- **SSH 通道** (預設)：使用 `ssh -N -L ...` 將 Gateway 連接埠轉發到 localhost。Gateway 會將節點的 IP 視為 `127.0.0.1`，因為通道是 local loopback。
- **Direct (ws/wss)**：直接連接到 Gateway URL。Gateway 會看到真實的用戶端 IP。

## 遠端主機上的必要條件

1.  安裝 Node + pnpm，並建置/安裝 OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`)。
2.  確保 `openclaw` 對於非互動式 shell 位於 PATH 中 (如果需要，可符號連結到 `/usr/local/bin` 或 `/opt/homebrew/bin`)。
3.  開啟帶有金鑰驗證的 SSH。我們建議使用 **Tailscale** IP 以實現 LAN 外部的穩定可達性。

## macOS 應用程式設定

1.  開啟 _設定 → 一般_。
2.  在 **OpenClaw 執行** 下，選擇 **Remote over SSH** 並設定：
    -   **Transport**：**SSH tunnel** 或 **Direct (ws/wss)**。
    -   **SSH target**：`user @host` (可選 `:port`)。
        -   如果 Gateway 位於同一個 LAN 並宣告 Bonjour，從已探索的清單中選擇它以自動填入此欄位。
    -   **Gateway URL** (僅限 Direct)：`wss://gateway.example.ts.net` (或本地/LAN 的 `ws://...`)。
    -   **Identity file** (進階)：您的金鑰路徑。
    -   **Project root** (進階)：用於指令的遠端結帳路徑。
    -   **CLI path** (進階)：可執行 `openclaw` 入口點/二進位檔案的可選路徑 (宣告時會自動填入)。
3.  點擊 **Test remote**。成功表示遠端 `openclaw status --json` 執行正確。失敗通常意味著 PATH/CLI 問題；exit 127 表示遠端找不到 CLI。
4.  健康檢查和網路聊天現在將透過此 SSH 通道自動執行。

## 網路聊天

-   **SSH 通道**：網路聊天透過轉發的 WebSocket 控制埠 (預設 18789) 連接到 Gateway。
-   **Direct (ws/wss)**：網路聊天直接連接到已設定的 Gateway URL。
-   現在沒有單獨的 WebChat HTTP 伺服器。

## 權限

-   遠端主機需要與本地相同的 TCC 批准 (自動化、輔助使用、螢幕錄影、麥克風、語音辨識、通知)。在該機器上執行新手導覽一次以授予它們。
-   節點透過 `node.list` / `node.describe` 宣告其權限狀態，以便智慧代理知道有哪些可用功能。

## 安全注意事項

-   優先在遠端主機上綁定 local loopback 並透過 SSH 或 Tailscale 連接。
-   如果您將 Gateway 綁定到非 local loopback 介面，則需要 token/密碼驗證。
-   請參閱 [安全性](/gateway/security) 和 [Tailscale](/gateway/tailscale)。

## WhatsApp 登入流程 (遠端)

-   在 **遠端主機上** 執行 `openclaw channels login --verbose`。使用手機上的 WhatsApp 掃描 QR 碼。
-   如果憑證過期，請在該主機上重新執行登入。健康檢查將會顯示連結問題。

## 疑難排解

-   **exit 127 / not found**：對於非登入 shell，`openclaw` 不在 PATH 中。將其新增到 `/etc/paths`、您的 shell rc，或符號連結到 `/usr/local/bin`/`/opt/homebrew/bin`。
-   **Health probe failed**：檢查 SSH 可達性、PATH 以及 Baileys 是否已登入 (`openclaw status --json`)。
-   **Web Chat stuck**：確認 Gateway 在遠端主機上運行，並且轉發的連接埠與 Gateway WS 連接埠匹配；UI 需要健康的 WS 連線。
-   **Node IP shows 127.0.0.1**：SSH 通道預期的行為。如果您希望 Gateway 看到真實的用戶端 IP，請將 **Transport** 切換為 **Direct (ws/wss)**。
-   **Voice Wake**：觸發詞會自動在遠端模式下轉發；不需要單獨的轉發器。

## 通知音效

從帶有 `openclaw` 和 `node.invoke` 的腳本中為每個通知選擇音效，例如：

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

應用程式中不再有全域「預設音效」切換；呼叫者根據每個請求選擇音效 (或不選擇)。
