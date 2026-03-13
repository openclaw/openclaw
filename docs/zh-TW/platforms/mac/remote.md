---
summary: macOS app flow for controlling a remote OpenClaw gateway over SSH
read_when:
  - Setting up or debugging remote mac control
title: Remote Control
---

# 遠端 OpenClaw (macOS ⇄ 遠端主機)

此流程讓 macOS 應用程式能作為另一台主機（桌機/伺服器）上執行的 OpenClaw 閘道的完整遠端控制。這是應用程式的 **Remote over SSH**（遠端執行）功能。所有功能—健康檢查、語音喚醒轉發和網頁聊天—皆重複使用 _設定 → 一般_ 中相同的遠端 SSH 設定。

## 模式

- **本機（此 Mac）**：所有功能皆在筆電上執行。不涉及 SSH。
- **Remote over SSH（預設）**：OpenClaw 指令在遠端主機執行。mac 應用程式會使用 `-o BatchMode` 加上您選擇的身份/金鑰及本地端埠轉發開啟 SSH 連線。
- **Remote direct (ws/wss)**：無 SSH 隧道。mac 應用程式直接連接到閘道 URL（例如透過 Tailscale Serve 或公開 HTTPS 反向代理）。

## 遠端傳輸方式

遠端模式支援兩種傳輸方式：

- **SSH 隧道**（預設）：使用 `ssh -N -L ...` 將閘道埠轉發到本機。閘道會看到節點 IP 為 `127.0.0.1`，因為隧道是迴圈回送。
- **直接 (ws/wss)**：直接連接到閘道 URL。閘道會看到真實的用戶端 IP。

## 遠端主機先決條件

1. 安裝 Node + pnpm 並建置/安裝 OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`)。
2. 確保 `openclaw` 在非互動式 shell 的 PATH 中（必要時可在 `/usr/local/bin` 或 `/opt/homebrew/bin` 建立符號連結）。
3. 開啟 SSH 並使用金鑰認證。我們建議使用 **Tailscale** IP 以確保 LAN 外的穩定可達性。

## macOS 應用程式設定

1. 開啟 _設定 → 一般_。
2. 在 **OpenClaw 執行方式** 選擇 **Remote over SSH** 並設定：
   - **傳輸方式**：**SSH 隧道** 或 **直接 (ws/wss)**。
   - **SSH 目標**：`user@host`（可選 `:port`）。
     - 若閘道在同一 LAN 且有 Bonjour 廣播，可從發現清單中選擇自動填入此欄位。
   - **閘道 URL**（僅限直接連線）：`wss://gateway.example.ts.net`（或本地/LAN 用 `ws://...`）。
   - **身份檔案**（進階）：您的金鑰路徑。
   - **專案根目錄**（進階）：遠端檢出路徑，用於指令執行。
   - **CLI 路徑**（進階）：可選的可執行 `openclaw` 入口點/二進位檔路徑（若有廣播會自動填入）。
3. 點擊 **測試遠端**。成功表示遠端 `openclaw status --json` 正常執行。失敗通常是 PATH/CLI 問題；退出碼 127 表示遠端找不到 CLI。
4. 健康檢查和網頁聊天將自動透過此 SSH 隧道執行。

## 網頁聊天

- **SSH 隧道**：網頁聊天透過轉發的 WebSocket 控制埠（預設 18789）連接閘道。
- **直接 (ws/wss)**：網頁聊天直接連接到設定的閘道 URL。
- 現在已無獨立的 WebChat HTTP 伺服器。

## 權限

- 遠端主機需要與本機相同的 TCC 授權（自動化、輔助使用、螢幕錄製、麥克風、語音辨識、通知）。請在該機器上執行初始設定以授權一次。
- 節點會透過 `node.list` / `node.describe` 廣播其權限狀態，讓代理程式知道可用權限。

## 安全注意事項

- 優先在遠端主機上綁定回環介面，並透過 SSH 或 Tailscale 連線。
- SSH 隧道使用嚴格的主機金鑰檢查；請先信任主機金鑰，使其存在於 `~/.ssh/known_hosts`。
- 如果將 Gateway 綁定到非回環介面，則必須要求 token/密碼驗證。
- 詳見 [Security](/gateway/security) 與 [Tailscale](/gateway/tailscale)。

## WhatsApp 登入流程（遠端）

- 在遠端主機上執行 `openclaw channels login --verbose`。用手機上的 WhatsApp 掃描 QR 碼。
- 若驗證過期，請在該主機重新執行登入。健康檢查會顯示連線問題。

## 疑難排解

- **exit 127 / 找不到指令**：`openclaw` 未加入非登入 shell 的 PATH。請將其加入 `/etc/paths`、你的 shell rc 檔，或建立符號連結到 `/usr/local/bin`/`/opt/homebrew/bin`。
- **健康檢查失敗**：檢查 SSH 可達性、PATH，以及 Baileys 是否已登入 (`openclaw status --json`)。
- **Web Chat 卡住**：確認 Gateway 正在遠端主機上執行，且轉發的埠號與 Gateway WS 埠號相符；UI 需要健康的 WS 連線。
- **節點 IP 顯示 127.0.0.1**：SSH 隧道下為預期行為。若想讓 Gateway 看到真實用戶端 IP，請將 **Transport** 切換為 **Direct (ws/wss)**。
- **語音喚醒**：觸發語句在遠端模式下會自動轉發，無需額外的轉發器。

## 通知音效

可從腳本中使用 `openclaw` 和 `node.invoke` 選擇每則通知的音效，例如：

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

應用程式中已無全域「預設音效」切換；呼叫方可針對每次請求選擇音效（或不選擇）。
