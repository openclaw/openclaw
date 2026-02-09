---
summary: "OpenClaw macOS 配套應用程式（選單列 + gateway broker）"
read_when:
  - 實作 macOS 應用程式功能時
  - 在 macOS 上變更 Gateway 生命週期或節點橋接時
title: "macOS 應用程式"
---

# OpenClaw macOS 配套應用程式（選單列 + gateway broker）

The macOS app is the **menu‑bar companion** for OpenClaw. 它擁有權限，
在本地管理／附加 Gateway（launchd 或手動），並將 macOS 能力以節點形式暴露給代理。

## What it does

- Shows native notifications and status in the menu bar.
- 管理 TCC 提示（通知、輔助使用、螢幕錄製、麥克風、
  語音辨識、自動化／AppleScript）。
- 執行或連線至 Gateway（本機或遠端）。
- 提供僅限 macOS 的工具（Canvas、Camera、螢幕錄製、`system.run`）。
- 在 **remote** 模式下啟動本機節點主機服務（launchd），並在 **local** 模式下停止。
- 可選擇性地主持 **PeekabooBridge** 以進行 UI 自動化。
- 依需求透過 npm／pnpm 安裝全域 CLI（`openclaw`）（不建議將 bun 作為 Gateway 執行階段）。

## Local 與 remote 模式

- **Local**（預設）：若存在正在執行的本機 Gateway，應用程式會附加；
  否則會透過 `openclaw gateway install` 啟用 launchd 服務。
- **Remote**：應用程式透過 SSH／Tailscale 連線至 Gateway，且永遠不會啟動
  本機處理程序。
  應用程式會啟動本機**節點主機服務**，讓遠端 Gateway 能夠連線到此 Mac。
  應用程式不會以子處理程序的方式啟動 Gateway。
  The app starts the local **node host service** so the remote Gateway can reach this Mac.
  應用程式不會以子行程方式啟動 Gateway。

## Launchd 控制

應用程式會管理一個每位使用者的 LaunchAgent，標籤為 `bot.molt.gateway`
（使用 `--profile`/`OPENCLAW_PROFILE` 時為 `bot.molt.<profile>`；舊版 `com.openclaw.*` 仍可卸載）。

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

在執行具名設定檔時，請將標籤替換為 `bot.molt.<profile> `。\` when running a named profile.

如果尚未安裝 LaunchAgent，可從應用程式中啟用，或執行
`openclaw gateway install`。

## 節點能力（mac）

macOS 應用程式以節點的形式呈現自己。 常用指令：

- Canvas：`canvas.present`、`canvas.navigate`、`canvas.eval`、`canvas.snapshot`、`canvas.a2ui.*`
- Camera：`camera.snap`、`camera.clip`
- Screen：`screen.record`
- System：`system.run`、`system.notify`

該節點回報一個 `permissions` 對應表，讓代理決定允許的項目。

節點服務 + 應用程式 IPC：

- 當無介面的節點主機服務正在執行（remote 模式）時，它會作為節點連線至 Gateway WS。
- `system.run` 會在 macOS 應用程式中（UI／TCC 環境）透過本機 Unix socket 執行；提示與輸出都會留在應用程式內。

圖示（SCI）：

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec 核准（system.run）

`system.run` 由 macOS 應用程式中的 **Exec 核准** 控制（設定 → Exec 核准）。
安全性 + 詢問 + 允許清單會本地儲存在 Mac 上：

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
- 在提示中選擇「Always Allow」會將該指令加入允許清單。
- `system.run` 環境覆寫會被過濾（移除 `PATH`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`），然後再與應用程式的環境合併。

## 深層連結

應用程式註冊 `openclaw://` URL 配置，用於本地動作。

### `openclaw://agent`

觸發一個 Gateway `agent` 請求。

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

查詢參數：

- `message`（必填）
- `sessionKey`（選填）
- `thinking`（選填）
- `deliver`／`to`／`channel`（選填）
- `timeoutSeconds`（選填）
- `key`（選填，無人值守模式金鑰）

安全性：

- 若未提供 `key`，應用程式會要求確認。
- 若提供有效的 `key`，執行將為無人值守（用於個人自動化）。

## 入門流程（典型）

1. 安裝並啟動 **OpenClaw.app**。
2. 完成權限檢查清單（TCC 提示）。
3. 確認 **Local** 模式已啟用且 Gateway 正在執行。
4. Install the CLI if you want terminal access.

## 建置與開發流程（原生）

- `cd apps/macos && swift build`
- `swift run OpenClaw`（或 Xcode）
- 封裝應用程式：`scripts/package-mac-app.sh`

## 偵錯 Gateway 連線（macOS CLI）

使用除錯 CLI，在不啟動應用程式的情況下，測試 macOS 應用程式所使用的
Gateway WebSocket 握手與探索邏輯。

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

連線選項：

- `--url <ws://host:port>`：覆寫設定
- `--mode <local|remote>`：從設定解析（預設：設定或本機）
- `--probe`：強制重新進行健康檢查
- `--timeout <ms>`：請求逾時（預設：`15000`）
- `--json`：用於比對差異的結構化輸出

探索選項：

- `--include-local`：包含原本會被過濾為「local」的 gateways
- `--timeout <ms>`：整體探索時間窗（預設：`2000`）
- `--json`：用於比對差異的結構化輸出

提示：可與 `openclaw gateway discover --json` 進行比較，以確認
macOS 應用程式的探索管線（NWBrowser + tailnet DNS‑SD 後備）
是否與 Node CLI 以 `dns-sd` 為基礎的探索不同。

## 遠端連線管線（SSH 通道）

當 macOS 應用程式在 **Remote** 模式下執行時，它會開啟一個 SSH 通道，
讓本機 UI 元件能像連線至 localhost 一樣，與遠端 Gateway 通訊。

### 控制通道（Gateway WebSocket 連接埠）

- **用途：** 健康檢查、狀態、Web Chat、設定，以及其他控制平面呼叫。
- **本機連接埠：** Gateway 連接埠（預設 `18789`），始終固定。
- **遠端連接埠：** 遠端主機上的相同 Gateway 連接埠。
- **Behavior:** no random local port; the app reuses an existing healthy tunnel
  or restarts it if needed.
- **SSH 形式：** `ssh -N -L <local>:127.0.0.1:<remote>`，搭配 BatchMode +
  ExitOnForwardFailure + keepalive 選項。
- **IP 回報：** SSH 通道使用 loopback，因此 gateway 看到的節點 IP
  會是 `127.0.0.1`。若希望顯示真實的用戶端 IP，
  請使用 **Direct（ws/wss）** 傳輸（請參閱 [macOS remote access](/platforms/mac/remote)）。 Use **Direct (ws/wss)** transport if you want the real client
  IP to appear (see [macOS remote access](/platforms/mac/remote)).

For setup steps, see [macOS remote access](/platforms/mac/remote). For protocol
details, see [Gateway protocol](/gateway/protocol).

## Related docs

- [Gateway runbook](/gateway)
- [Gateway（macOS）](/platforms/mac/bundled-gateway)
- [macOS 權限](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
