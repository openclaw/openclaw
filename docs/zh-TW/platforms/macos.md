---
summary: OpenClaw macOS companion app (menu bar + gateway broker)
read_when:
  - Implementing macOS app features
  - Changing gateway lifecycle or node bridging on macOS
title: macOS App
---

# OpenClaw macOS 伴侶程式（選單列 + Gateway 代理）

macOS 應用程式是 OpenClaw 的**選單列伴侶**。它擁有權限管理，負責本地 Gateway 的管理與連接（透過 launchd 或手動），並將 macOS 功能以節點形式暴露給代理程式。

## 功能說明

- 顯示原生通知與選單列狀態。
- 管理 TCC 提示（通知、輔助使用、螢幕錄製、麥克風、語音辨識、自動化/AppleScript）。
- 啟動或連接 Gateway（本地或遠端）。
- 暴露 macOS 專屬工具（Canvas、相機、螢幕錄製、`system.run`）。
- 以**遠端**模式（launchd）啟動本地節點主機服務，並在**本地**模式停止該服務。
- 選擇性地承載用於 UI 自動化的 **PeekabooBridge**。
- 依需求透過 npm/pnpm 安裝全域 CLI (`openclaw`)（不建議使用 bun 作為 Gateway 執行環境）。

## 本地模式與遠端模式

- **本地**（預設）：若有執行中的本地 Gateway，應用程式會連接該 Gateway；否則會透過 `openclaw gateway install` 啟用 launchd 服務。
- **遠端**：應用程式透過 SSH/Tailscale 連接遠端 Gateway，且不會啟動本地 Gateway 程序。
  應用程式會啟動本地的**節點主機服務**，讓遠端 Gateway 能存取此 Mac。
  應用程式不會以子程序方式啟動 Gateway。

## Launchd 控制

應用程式管理每用戶的 LaunchAgent，標籤為 `ai.openclaw.gateway`  
（使用 `--profile`/`OPENCLAW_PROFILE` 時為 `ai.openclaw.<profile>`；舊版 `com.openclaw.*` 仍可卸載）。

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

執行命名設定檔時，請將標籤替換為 `ai.openclaw.<profile>`。

若尚未安裝 LaunchAgent，可從應用程式啟用或執行 `openclaw gateway install`。

## 節點功能（mac）

macOS 應用程式以節點身份呈現。常用指令：

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- 相機: `camera.snap`, `camera.clip`
- 螢幕: `screen.record`
- 系統: `system.run`, `system.notify`

節點會回報 `permissions` 映射，讓代理程式判斷允許的操作。

Node 服務 + 應用程式 IPC：

- 當無頭節點主機服務執行中（遠端模式），它會以節點身份連接到 Gateway WS。
- `system.run` 在 macOS 應用程式（UI/TCC 環境）中透過本地 Unix socket 執行；提示與輸出皆保留在應用程式內。

圖示（SCI）：

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 執行授權（system.run）

`system.run` 由 macOS 應用程式中的 **執行授權** 控制（設定 → 執行授權）。
安全性、詢問與允許清單皆儲存在 Mac 本地：

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

說明：

- `allowlist` 條目為解析後二進位路徑的通配符模式。
- 含有 shell 控制或展開語法的原始 shell 命令文字（`&&`、`||`、`;`、`|`、` ` `, `$`, `<`, `>`, `(`, `)）會被視為允許清單未命中，需明確授權（或將 shell 二進位加入允許清單）。
- 在提示中選擇「永遠允許」會將該命令加入允許清單。
- `system.run` 環境變數覆寫會被過濾（移除 `PATH`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`、`SHELLOPTS`、`PS4`），然後與應用程式環境合併。
- 對於 shell 包裝器（`bash|sh|zsh ... -c/-lc`），請求範圍的環境覆寫會縮減為一個小型明確允許清單（`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`）。
- 在允許清單模式下的「永遠允許」決策中，已知的調度包裝器（`env`、`nice`、`nohup`、`stdbuf`、`timeout`）會持久化內部可執行檔路徑，而非包裝器路徑。若解包不安全，則不會自動持久化允許清單條目。

## 深層連結

應用程式註冊了 `openclaw://` URL 協議用於本地操作。

### `openclaw://agent`

觸發 Gateway `agent` 請求。

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

查詢參數：

- `message`（必填）
- `sessionKey`（選填）
- `thinking`（選填）
- `deliver` / `to` / `channel`（選填）
- `timeoutSeconds`（選填）
- `key`（選填，無人值守模式金鑰）

安全性：

- 若未提供 `key`，應用程式會提示確認。
- 若未提供 `key`，應用程式會對確認提示強制短訊息限制，並忽略 `deliver` / `to` / `channel`。
- 若提供有效的 `key`，執行將為無人值守模式（適用於個人自動化）。

## 新手引導流程（典型）

1. 安裝並啟動 **OpenClaw.app**。
2. 完成權限清單（TCC 提示）。
3. 確認已啟用 **Local** 模式且 Gateway 正在執行。
4. 若需終端機存取，請安裝 CLI。

## 狀態目錄位置（macOS）

避免將 OpenClaw 狀態目錄放在 iCloud 或其他雲端同步資料夾中。
同步備份路徑可能會增加延遲，且偶爾會導致檔案鎖定或同步競爭問題，影響會話和憑證。

建議使用本機非同步狀態路徑，例如：

```bash
OPENCLAW_STATE_DIR=~/.openclaw
```

若 `openclaw doctor` 偵測到狀態位於：

- `~/Library/Mobile Documents/com~apple~CloudDocs/...`
- `~/Library/CloudStorage/...`

將會發出警告並建議移回本機路徑。

## 建置與開發工作流程（原生）

- `cd apps/macos && swift build`
- `swift run OpenClaw`（或 Xcode）
- 打包應用程式：`scripts/package-mac-app.sh`

## 除錯 Gateway 連線（macOS CLI）

使用除錯 CLI 來執行與 macOS 應用程式相同的 Gateway WebSocket 握手與發現邏輯，無需啟動應用程式。

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

連線選項：

- `--url <ws://host:port>`：覆寫設定
- `--mode <local|remote>`：從設定解析（預設：config 或 local）
- `--probe`：強制執行全新健康檢查
- `--timeout <ms>`：請求逾時（預設：`15000`）
- `--json`：結構化輸出以便差異比對

發現選項：

- `--include-local`：包含會被過濾為「本地」的 gateways
- `--timeout <ms>`：整體發現時間視窗（預設：`2000`）
- `--json`：結構化輸出以便差異比對

提示：可與 `openclaw gateway discover --json` 比較，查看 macOS 應用程式的發現流程（NWBrowser + tailnet DNS‑SD 備援）是否與 Node CLI 的 `dns-sd` 基礎發現有所不同。

## 遠端連線管線（SSH 隧道）

當 macOS 應用程式以 **遠端** 模式執行時，會開啟 SSH 隧道，讓本地 UI 元件能像連接本機一樣與遠端 Gateway 通訊。

### 控制隧道（Gateway WebSocket 埠）

- **用途：** 健康檢查、狀態、Web 聊天、設定及其他控制平面呼叫。
- **本地埠：** Gateway 埠（預設 `18789`），始終穩定。
- **遠端埠：** 遠端主機上的相同 Gateway 埠。
- **行為：** 無隨機本地埠；應用程式會重複使用現有健康隧道，或在需要時重新啟動。
- **SSH 形式：** `ssh -N -L <local>:127.0.0.1:<remote>` 搭配 BatchMode + ExitOnForwardFailure + keepalive 選項。
- **IP 報告：** SSH 隧道使用迴路位址，因此 gateway 會看到節點 IP 為 `127.0.0.1`。若想讓真實用戶端 IP 顯示，請使用 **Direct (ws/wss)** 傳輸（詳見 [macOS 遠端存取](/platforms/mac/remote)）。

設定步驟請參考 [macOS 遠端存取](/platforms/mac/remote)。協定細節請參考 [Gateway 協定](/gateway/protocol)。

## 相關文件

- [Gateway 執行手冊](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS 權限](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
