---
summary: "OpenClaw macOS 配套應用 (選單列 + Gateway 代理)"
read_when:
  - 開發 macOS 應用功能時
  - 更改 macOS 上的 Gateway 生命週期或節點橋接時
title: "macOS 應用程式"
---

# OpenClaw macOS 配套應用 (選單列 + Gateway 代理)

macOS 應用程式是 OpenClaw 的**選單列 (menu bar) 配套應用**。它負責管理權限、在本機管理或連接 Gateway (透過 launchd 或手動方式)，並將 macOS 的功能作為節點提供給智慧代理。

## 功能

- 在選單列中顯示原生通知與狀態。
- 管理 TCC 權限請求 (通知、輔助使用、螢幕錄製、麥克風、語音辨識、自動化/AppleScript)。
- 執行或連線至 Gateway (本機或遠端)。
- 提供 macOS 專屬工具 (Canvas, Camera, Screen Recording, `system.run`)。
- 在**遠端 (remote)** 模式下啟動本機節點主機服務 (launchd)，並在**本地 (local)** 模式下停止該服務。
- 可選擇託管用於 UI 自動化的 **PeekabooBridge**。
- 根據需求透過 npm/pnpm 安裝全域 CLI (`openclaw`) (不建議將 bun 用於 Gateway 執行階段)。

## 本地 vs 遠端模式

- **本地 (Local)** (預設)：如果存在正在執行的本機 Gateway，應用程式會直接連線；否則，它會透過 `openclaw gateway install` 啟用 launchd 服務。
- **遠端 (Remote)**：應用程式透過 SSH/Tailscale 連線到 Gateway，且不會啟動本機程序。
  應用程式會啟動本機**節點主機服務**，以便遠端 Gateway 可以存取這台 Mac。
  應用程式不會將 Gateway 作為子程序啟動。

## Launchd 控制

應用程式管理一個標籤為 `bot.molt.gateway` 的使用者級別 LaunchAgent (使用 `--profile`/`OPENCLAW_PROFILE` 時則為 `bot.molt.<profile>`；舊版的 `com.openclaw.*` 仍會被卸載)。

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

執行具名設定檔時，請將標籤替換為 `bot.molt.<profile>`。

如果尚未安裝 LaunchAgent，請從應用程式中啟用，或執行 `openclaw gateway install`。

## 節點功能 (mac)

macOS 應用程式會以節點形式呈現。常用指令：

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

該節點會回報 `permissions` 對照表，以便智慧代理決定允許執行哪些操作。

節點服務 + 應用程式 IPC：

- 當無介面 (headless) 節點主機服務執行時 (遠端模式)，它會作為節點連線到 Gateway WS。
- `system.run` 透過本機 Unix socket 在 macOS 應用程式 (UI/TCC 上下文) 中執行；提示與輸出會保留在應用程式內。

圖表 (SCI)：

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 執行授權 (system.run)

`system.run` 由 macOS 應用程式中的**執行授權 (Exec approvals)** 控制 (設定 → 執行授權)。安全性 + 詢問 + 允許清單 (allowlist) 儲存在 Mac 本地的下列路徑：

```
~/.openclaw/exec-approvals.json
```

範例：

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

注意事項：

- `allowlist` 項目是已解析二進位檔路徑的 glob 模式。
- 在提示中選擇「永遠允許」會將該指令新增到允許清單。
- `system.run` 的環境變數覆蓋會經過過濾 (捨棄 `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`)，然後與應用程式的環境變數合併。

## Deep links

應用程式為本地操作註冊了 `openclaw://` URL 結構。

### `openclaw://agent`

觸發 Gateway `agent` 智慧代理請求。

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

查詢參數：

- `message` (必填)
- `sessionKey` (選填)
- `thinking` (選填)
- `deliver` / `to` / `channel` (選填)
- `timeoutSeconds` (選填)
- `key` (選填的自動化模式金鑰)

安全性：

- 若無 `key`，應用程式會彈出確認提示。
- 若有有效的 `key`，執行將為自動化模式 (適用於個人自動化)。

## 新手導覽流程 (典型)

1. 安裝並啟動 **OpenClaw.app**。
2. 完成權限檢查清單 (TCC 提示)。
3. 確保**本地 (Local)** 模式已啟用且 Gateway 正在執行。
4. 如果需要終端機存取權限，請安裝 CLI。

## 建置與開發工作流 (原生)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (或使用 Xcode)
- 打包應用程式：`scripts/package-mac-app.sh`

## 偵錯 Gateway 連線 (macOS CLI)

使用偵錯 CLI 來測試與 macOS 應用程式相同的 Gateway WebSocket 握手和裝置探索邏輯，而無需啟動應用程式。

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

連線選項：

- `--url <ws://host:port>`：覆蓋設定
- `--mode <local|remote>`：從設定解析 (預設：設定或 local)
- `--probe`：強制進行全新的健康狀態探測
- `--timeout <ms>`：請求逾時 (預設：`15000`)
- `--json`：用於比對的結構化輸出

裝置探索選項：

- `--include-local`：包含會被過濾為「本地」的 Gateway
- `--timeout <ms>`：整體裝置探索視窗 (預設：`2000`)
- `--json`：用於比對的結構化輸出

提示：將其與 `openclaw gateway discover --json` 進行比較，以查看 macOS 應用程式的裝置探索管道 (NWBrowser + tailnet DNS‑SD 備援) 是否與 Node CLI 基於 `dns-sd` 的裝置探索有所不同。

## 遠端連線配置 (SSH 通道)

當 macOS 應用程式在**遠端 (Remote)** 模式下執行時，它會開啟一個 SSH 通道，讓本地 UI 元件可以像在 localhost 一樣與遠端 Gateway 通訊。

### 控制通道 (Gateway WebSocket 連接埠)

- **用途：** 健康檢查、狀態、Web Chat、設定以及其他控制平面 (control-plane) 呼叫。
- **本地連接埠：** Gateway 連接埠 (預設為 `18789`)，始終保持穩定。
- **遠端連接埠：** 遠端主機上的相同 Gateway 連接埠。
- **行為：** 不使用隨機本地連接埠；應用程式會重複使用現有的健康通道，或在需要時重啟。
- **SSH 形式：** `ssh -N -L <local>:127.0.0.1:<remote>`，並帶有 BatchMode + ExitOnForwardFailure + keepalive 選項。
- **IP 回報：** SSH 通道使用 local loopback，因此 Gateway 會將節點 IP 視為 `127.0.0.1`。如果您希望顯示真實的客戶端 IP，請使用 **Direct (ws/wss)** 傳輸 (參閱 [macOS 遠端存取](/platforms/mac/remote))。

有關設定步驟，請參閱 [macOS 遠端存取](/platforms/mac/remote)。有關協定詳情，請參閱 [Gateway 協定](/gateway/protocol)。

## 相關文件

- [Gateway 運行手冊](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS 權限](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
