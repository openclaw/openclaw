---
summary: "透過 SSH 遠端控制 OpenClaw Gateway 的 macOS 應用程式流程"
read_when:
  - 設定或偵錯遠端 Mac 控制時
title: "遠端控制"
---

# 遠端 OpenClaw (macOS ⇄ 遠端主機)

此流程讓 macOS 應用程式能完全遠端控制運行在另一台主機（桌上型電腦/伺服器）上的 OpenClaw Gateway。這是應用程式的 **Remote over SSH**（遠端執行）功能。所有功能——包含狀態檢查、語音喚醒轉發以及 Web Chat——都重複使用 _Settings → General_ 中相同的遠端 SSH 設定。

## 模式

- **Local (此 Mac)**：所有功能都在筆記型電腦上執行，不涉及 SSH。
- **Remote over SSH (預設)**：OpenClaw 指令會在遠端主機上執行。macOS 應用程式會透過 `-o BatchMode`、您選定的識別金鑰以及本機連接埠轉發（port-forward）來開啟 SSH 連線。
- **Remote direct (ws/wss)**：不使用 SSH 通道。macOS 應用程式直接連線至 Gateway URL（例如透過 Tailscale Serve 或公開的 HTTPS 反向代理）。

## 遠端傳輸協定

遠端模式支援兩種傳輸協定：

- **SSH 通道** (預設)：使用 `ssh -N -L ...` 將 Gateway 連接埠轉發至 localhost。由於通道是 loopback，Gateway 會將節點的 IP 視為 `127.0.0.1`。
- **Direct (ws/wss)**：直接連線至 Gateway URL，Gateway 可看到真實的用戶端 IP。

## 遠端主機的前置作業

1. 安裝 Node + pnpm 並編譯/安裝 OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`)。
2. 確保 `openclaw` 位於非互動式 Shell 的 PATH 中（如有需要，請建立符號連結至 `/usr/local/bin` 或 `/opt/homebrew/bin`）。
3. 開啟支援金鑰驗證的 SSH。我們建議使用 **Tailscale** IP，以便在區域網路外獲得穩定的連通性。

## macOS 應用程式設定

1. 開啟 _Settings → General_。
2. 在 **OpenClaw runs** 下方，選擇 **Remote over SSH** 並設定：
   - **Transport**：**SSH 通道** 或 **Direct (ws/wss)**。
   - **SSH target**：`user @host`（選填 `:port`）。
     - 如果 Gateway 位於同一個區域網路並透過 Bonjour 廣播，請從偵測到的清單中選擇它，系統會自動填寫此欄位。
   - **Gateway URL** (僅限 Direct)：`wss://gateway.example.ts.net`（區域網路/本機請使用 `ws://...`）。
   - **Identity file** (進階)：金鑰的檔案路徑。
   - **Project root** (進階)：用於執行指令的遠端專案路徑。
   - **CLI path** (進階)：選填的 `openclaw` 執行檔/二進位檔路徑（廣播時會自動填入）。
3. 點擊 **Test remote**。成功代表遠端 `openclaw status --json` 運作正常。失敗通常表示 PATH/CLI 問題；exit 127 代表遠端找不到 CLI。
4. 狀態檢查和 Web Chat 現在會自動透過此 SSH 通道執行。

## Web Chat

- **SSH 通道**：Web Chat 透過轉發的 WebSocket 控制連接埠（預設 18789）連線至 Gateway。
- **Direct (ws/wss)**：Web Chat 直接連線至設定好的 Gateway URL。
- 現在已不再有獨立的 WebChat HTTP 伺服器。

## 權限

- 遠端主機需要與本機相同的 TCC 授權（自動化、輔助使用、螢幕錄製、麥克風、語音辨識、通知）。在該機器上執行新手導覽以進行一次性授權。
- 節點會透過 `node.list` / `node.describe` 廣播其權限狀態，讓智慧代理知道哪些功能可用。

## 安全性說明

- 建議在遠端主機上綁定 loopback，並透過 SSH 或 Tailscale 連線。
- 如果您將 Gateway 綁定至非 loopback 介面，請務必要求權杖（token）/密碼驗證。
- 請參閱 [安全性](/gateway/security) 與 [Tailscale](/gateway/tailscale)。

## WhatsApp 登入流程 (遠端)

- **在遠端主機上**執行 `openclaw channels login --verbose`。使用手機上的 WhatsApp 掃描 QR code。
- 如果驗證過期，請在該主機上重新執行登入。狀態檢查會顯示連線問題。

## 疑難排解

- **exit 127 / 找不到指令**：`openclaw` 不在非登入 Shell 的 PATH 中。請將其加入 `/etc/paths`、您的 Shell 設定檔（rc），或建立符號連結至 `/usr/local/bin` / `/opt/homebrew/bin`。
- **狀態探測失敗**：檢查 SSH 連通性、PATH 設定，以及 Baileys 是否已登入 (`openclaw status --json`)。
- **Web Chat 卡住**：確認 Gateway 已在遠端主機執行，且轉發的連接埠與 Gateway WS 連接埠相符；UI 需要正常的 WS 連線。
- **節點 IP 顯示 127.0.0.1**：在使用 SSH 通道時為正常現象。如果您希望 Gateway 看到真實的用戶端 IP，請將 **Transport** 切換為 **Direct (ws/wss)**。
- **語音喚醒**：在遠端模式下，觸發詞會自動轉發，不需要額外的轉發器。

## 通知音效

可透過腳本搭配 `openclaw` 與 `node.invoke` 為各別通知選擇音效，例如：

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

應用程式中不再有全域的「預設音效」切換開關；呼叫者需在每次請求時選擇音效（或不使用音效）。
