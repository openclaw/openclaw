---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — 執行、查詢和裝置探索 Gateway"
read_when:
  - 從 CLI (開發或伺服器) 執行 Gateway
  - 偵錯 Gateway 憑證、繫結模式和連線能力
  - 透過 Bonjour (LAN + tailnet) 裝置探索 Gateway
title: "gateway"
---

# Gateway CLI

Gateway 是 OpenClaw 的 WebSocket 伺服器（頻道、節點、工作階段、掛鉤）。

本頁的子命令位於 `openclaw gateway …` 之下。

相關文件：

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## 執行 Gateway

執行本機 Gateway 程式：

```bash
openclaw gateway
```

前景別名：

```bash
openclaw gateway run
```

注意事項：

- 預設情況下，除非在 `~/.openclaw/openclaw.json` 中設定了 `gateway.mode=local`，否則 Gateway 將拒絕啟動。對於臨時/開發執行，請使用 `--allow-unconfigured`。
- 未經憑證繫結超出 local loopback 的行為將被阻止（安全護欄）。
- 獲得授權後，`SIGUSR1` 會觸發程式內重新啟動（啟用 `commands.restart` 或使用 gateway 工具/設定應用/更新）。
- `SIGINT`/`SIGTERM` 處理常式會停止 gateway 程式，但它們不會還原任何自訂的終端機狀態。如果您使用 TUI 或原始模式輸入包裝 CLI，請在退出前還原終端機。

### 選項

- `--port <port>`: WebSocket 連接埠（預設來自設定/環境變數；通常為 `18789`）。
- `--bind <loopback|lan|tailnet|auto|custom>`: 監聽器繫結模式。
- `--auth <token|password>`: 憑證模式覆寫。
- `--token <token>`: 權杖覆寫（同時為程式設定 `OPENCLAW_GATEWAY_TOKEN`）。
- `--password <password>`: 密碼覆寫（同時為程式設定 `OPENCLAW_GATEWAY_PASSWORD`）。
- `--tailscale <off|serve|funnel>`: 透過 Tailscale 公開 Gateway。
- `--tailscale-reset-on-exit`: 在關機時重置 Tailscale 服務/通道設定。
- `--allow-unconfigured`: 允許在設定中沒有 `gateway.mode=local` 的情況下啟動 Gateway。
- `--dev`: 如果遺失，則建立開發設定 + 工作空間（跳過 BOOTSTRAP.md）。
- `--reset`: 重置開發設定 + 憑證 + 工作階段 + 工作空間（需要 `--dev`）。
- `--force`: 在啟動前終止選定連接埠上任何現有的監聽器。
- `--verbose`: 詳細記錄。
- `--claude-cli-logs`: 僅在控制台中顯示 claude-cli 記錄（並啟用其 stdout/stderr）。
- `--ws-log <auto|full|compact>`: websocket 記錄樣式（預設 `auto`）。
- `--compact`: `--ws-log compact` 的別名。
- `--raw-stream`: 將原始模型串流傳輸事件記錄到 jsonl。
- `--raw-stream-path <path>`: 原始串流傳輸 jsonl 路徑。

## 查詢正在執行的 Gateway

所有查詢命令都使用 WebSocket RPC。

輸出模式：

- 預設：人類可讀（在 TTY 中著色）。
- `--json`：機器可讀的 JSON（無樣式/旋轉指示器）。
- `--no-color` (或 `NO_COLOR=1`)：禁用 ANSI，同時保持人類可讀的佈局。

共享選項（如果支援）：

- `--url <url>`: Gateway WebSocket URL。
- `--token <token>`: Gateway 權杖。
- `--password <password>`: Gateway 密碼。
- `--timeout <ms>`: 逾時/預算（依命令而異）。
- `--expect-final`: 等待「最終」回應（智慧代理呼叫）。

注意：當您設定 `--url` 時，CLI 不會回退到設定或環境變數憑證。明確傳遞 `--token` 或 `--password`。缺少明確憑證會導致錯誤。

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` 顯示 Gateway 服務 (launchd/systemd/schtasks) 以及一個可選的 RPC 探測。

```bash
openclaw gateway status
openclaw gateway status --json
```

選項：

- `--url <url>`: 覆寫探測 URL。
- `--token <token>`: 用於探測的權杖憑證。
- `--password <password>`: 用於探測的密碼憑證。
- `--timeout <ms>`: 探測逾時（預設 `10000`）。
- `--no-probe`: 跳過 RPC 探測（僅服務檢視）。
- `--deep`: 也掃描系統級服務。

### `gateway probe`

`gateway probe` 是「偵錯所有事物」的命令。它總是探測：

- 您設定的遠端 gateway（如果已設定），以及
- 本機 (local loopback) **即使已設定遠端**。

如果有多個 gateway 可達，它會列印所有這些 gateway。當您使用隔離的設定檔/連接埠（例如，救援機器人）時，支援多個 gateway，但大多數安裝仍執行單個 gateway。

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### 透過 SSH 遠端 (Mac 應用程式同等功能)

macOS 應用程式的「透過 SSH 遠端」模式使用本機連接埠轉發，以便遠端 gateway（可能僅繫結到 local loopback）可在 `ws://127.0.0.1:<port>` 處到達。

CLI 等效命令：

```bash
openclaw gateway probe --ssh user @gateway-host
```

選項：

- `--ssh <target>`: `user @host` 或 `user @host:port`（連接埠預設為 `22`）。
- `--ssh-identity <path>`: 身分識別檔案。
- `--ssh-auto`: 將第一個裝置探索到的 gateway 主機選為 SSH 目標（僅限 LAN/WAB）。

設定（可選，用作預設值）：

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

低階 RPC 輔助工具。

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## 管理 Gateway 服務

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

注意事項：

- `gateway install` 支援 `--port`、`--runtime`、`--token`、`--force`、`--json`。
- 生命週期命令接受 `--json` 用於指令碼。

## 裝置探索 Gateway (Bonjour)

`gateway discover` 掃描 Gateway 信標 (`_openclaw-gw._tcp`)。

- 多播 DNS-SD: `local.`
- 單播 DNS-SD (廣域 Bonjour)：選擇一個網域（例如：`openclaw.internal.`），並設定分割 DNS + DNS 伺服器；請參閱 [/gateway/bonjour](/gateway/bonjour)

只有啟用 Bonjour 裝置探索（預設）的 gateway 才會廣播信標。

廣域裝置探索記錄包括 (TXT)：

- `role` （gateway 角色提示）
- `transport` （傳輸協定提示，例如 `gateway`）
- `gatewayPort` （WebSocket 連接埠，通常為 `18789`）
- `sshPort` （SSH 連接埠；如果不存在，預設為 `22`）
- `tailnetDns` （可用時的 MagicDNS 主機名稱）
- `gatewayTls` / `gatewayTlsSha256` （啟用 TLS + 憑證指紋）
- `cliPath` （遠端安裝的可選提示）

### `gateway discover`

```bash
openclaw gateway discover
```

選項：

- `--timeout <ms>`: 每個命令的逾時（瀏覽/解析）；預設 `2000`。
- `--json`: 機器可讀輸出（同時禁用樣式/旋轉指示器）。

範例：

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
