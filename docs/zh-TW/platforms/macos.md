---
summary: "OpenClaw macOS 配套應用 (選單列 + Gateway 代理)"
read_when:
  - 實作 macOS 應用功能時
  - 變更 macOS 上的 Gateway 生命週期或節點橋接時
title: "macOS 應用程式"
---

# OpenClaw macOS 配套應用 (選單列 + Gateway 代理)

macOS 應用程式是 OpenClaw 的**選單列配套應用**。它擁有權限、本機管理/連接到 Gateway (launchd 或手動)，並將 macOS 功能以節點形式公開給智慧代理。

## 功能

- 在選單列中顯示原生通知和狀態。
- 擁有 TCC 提示 (通知、輔助使用、螢幕錄影、麥克風、語音辨識、自動化/AppleScript)。
- 執行或連接到 Gateway (本機或遠端)。
- 公開 macOS 專用工具 (Canvas、相機、螢幕錄影、`system.run`)。
- 以**遠端**模式 (launchd) 啟動本機節點主機服務，並以**本機**模式停止服務。
- 可選地託管 **PeekabooBridge** 以進行 UI 自動化。
- 依要求透過 npm/pnpm 安裝全域 CLI (`openclaw`) (不建議將 bun 用於 Gateway 執行階段)。

## 本機模式與遠端模式

- **本機** (預設)：應用程式會連接到正在執行的本機 Gateway (如果存在)；否則，它會透過 `openclaw gateway install` 啟用 launchd 服務。
- **遠端**：應用程式透過 SSH/Tailscale 連接到 Gateway，並且從不啟動本機程序。
  應用程式啟動本機**節點主機服務**，以便遠端 Gateway 可以連接到這台 Mac。
  應用程式不會將 Gateway 作為子程序生成。

## Launchd 控制

應用程式管理標記為 `bot.molt.gateway` 的每位使用者 LaunchAgent
(或在使用 `--profile`/`OPENCLAW_PROFILE` 時標記為 `bot.molt.<profile>`；舊版 `com.openclaw.*` 仍會卸載)。

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

執行命名設定檔時，將標籤替換為 `bot.molt.<profile>`。

如果未安裝 LaunchAgent，請從應用程式啟用或執行
`openclaw gateway install`。

## 節點功能 (mac)

macOS 應用程式會將自己呈現為一個節點。常用命令：

- Canvas: `canvas.present`、`canvas.navigate`、`canvas.eval`、`canvas.snapshot`、`canvas.a2ui.*`
- 相機: `camera.snap`、`camera.clip`
- 螢幕: `screen.record`
- 系統: `system.run`、`system.notify`

節點報告 `permissions` 映射，以便智慧代理可以決定允許什麼。

節點服務 + 應用程式 IPC：

- 當無頭節點主機服務正在執行 (遠端模式) 時，它會作為節點連接到 Gateway WS。
- `system.run` 在 macOS 應用程式 (UI/TCC 上下文) 中透過本機 Unix socket 執行；提示和輸出保留在應用程式中。

圖表 (SCI)：

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 執行核准 (system.run)

`system.run` 由 macOS 應用程式中的**執行核准** (設定 → 執行核准) 控制。
安全 + 詢問 + 允許清單本機儲存在 Mac 上的：

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

- `allowlist` 項目是解析後的二進位檔案路徑的 glob 模式。
- 在提示中選擇「永遠允許」會將該命令新增到允許清單。
- `system.run` 環境變數覆蓋會經過篩選 (刪除 `PATH`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`)，然後與應用程式的環境合併。

## 深度連結

應用程式會註冊 `openclaw://` URL scheme 以進行本機操作。

### `openclaw://agent`

觸發 Gateway `agent` 請求。

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

查詢參數：

- `message` (必填)
- `sessionKey` (選填)
- `thinking` (選填)
- `deliver` / `to` / `channel` (選填)
- `timeoutSeconds` (選填)
- `key` (選填，用於無人值守模式的鍵)

安全：

- 沒有 `key` 時，應用程式會提示確認。
- 有效 `key` 時，執行將無人值守 ( intended for personal automations)。

## 新手導覽流程 (典型)

1. 安裝並啟動 **OpenClaw.app**。
2. 完成權限檢查清單 (TCC 提示)。
3. 確保**本機**模式已啟用且 Gateway 正在執行。
4. 如果您想要終端機存取權限，請安裝 CLI。

## 建置與開發工作流程 (原生)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (或 Xcode)
- 封裝應用程式: `scripts/package-mac-app.sh`

## 偵錯 Gateway 連線 (macOS CLI)

使用偵錯 CLI 執行與 macOS 應用程式相同的 Gateway WebSocket 握手和裝置探索邏輯，而無需啟動應用程式。

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

連接選項：

- `--url <ws://host:port>`：覆蓋設定
- `--mode <local|remote>`：從設定解析 (預設：設定或本機)
- `--probe`：強制進行新的健康探測
- `--timeout <ms>`：請求逾時 (預設：`15000`)
- `--json`：用於差異比較的結構化輸出

裝置探索選項：

- `--include-local`：包含會被篩選為「本機」的 Gateway
- `--timeout <ms>`：整體裝置探索時間窗 (預設：`2000`)
- `--json`：用於差異比較的結構化輸出

提示：與 `openclaw gateway discover --json` 進行比較，以查看 macOS 應用程式的裝置探索流程 (NWBrowser + tailnet DNS-SD 備援) 是否與 Node CLI 的 `dns-sd` 裝置探索有所不同。

## 遠端連線管道 (SSH 通道)

當 macOS 應用程式在**遠端**模式下執行時，它會開啟 SSH 通道，以便本機 UI 元件可以像在 localhost 上一樣與遠端 Gateway 通訊。

### 控制通道 (Gateway WebSocket 埠)

- **目的**：健康檢查、狀態、Web Chat、設定及其他控制層呼叫。
- **本機埠**：Gateway 埠 (預設 `18789`)，始終穩定。
- **遠端埠**：遠端主機上的相同 Gateway 埠。
- **行為**：沒有隨機本機埠；應用程式會重複使用現有的正常運作通道，或在需要時重新啟動。
- **SSH 形式**：`ssh -N -L <local>:127.0.0.1:<remote>`，並帶有 BatchMode + ExitOnForwardFailure + keepalive 選項。
- **IP 報告**：SSH 通道使用 local loopback，因此 Gateway 會將節點 IP 視為 `127.0.0.1`。如果您希望顯示真實的用戶端 IP，請使用 **直接 (ws/wss)** 傳輸 (請參閱 [macOS 遠端存取](/platforms/mac/remote))。

有關設定步驟，請參閱 [macOS 遠端存取](/platforms/mac/remote)。有關通訊協定詳情，請參閱 [Gateway 通訊協定](/gateway/protocol)。

## 相關文件

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS 權限](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
