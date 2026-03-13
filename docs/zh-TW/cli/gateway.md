---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — run, query, and discover gateways"
read_when:
  - Running the Gateway from the CLI (dev or servers)
  - "Debugging Gateway auth, bind modes, and connectivity"
  - Discovering gateways via Bonjour (LAN + tailnet)
title: gateway
---

# Gateway CLI

Gateway 是 OpenClaw 的 WebSocket 伺服器（通道、節點、會話、鉤子）。

此頁面的子命令位於 `openclaw gateway …`。

相關文件：

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## 啟動網關

執行本地 Gateway 程序：

```bash
openclaw gateway
```

[[INLINE_1]]

```bash
openclaw gateway run
```

[[BLOCK_1]]

- 預設情況下，Gateway 會拒絕啟動，除非在 `~/.openclaw/openclaw.json` 中設置 `gateway.mode=local`。使用 `--allow-unconfigured` 進行臨時/開發執行。
- 除了回環以外的綁定在未經授權的情況下被阻止（安全防護措施）。
- 當授權時，`SIGUSR1` 會觸發進程內重啟（`commands.restart` 預設啟用；設置 `commands.restart: false` 以阻止手動重啟，同時允許 gateway 工具/設定應用/更新）。
- `SIGINT`/`SIGTERM` 處理程序會停止 gateway 進程，但不會恢復任何自定義終端狀態。如果您將 CLI 包裝在 TUI 或原始模式輸入中，請在退出前恢復終端。

### 選項

- `--port <port>`: WebSocket 端口（預設來自設定/環境；通常是 `18789`）。
- `--bind <loopback|lan|tailnet|auto|custom>`: 監聽器綁定模式。
- `--auth <token|password>`: 認證模式覆蓋。
- `--token <token>`: token覆蓋（同時為進程設置 `OPENCLAW_GATEWAY_TOKEN`）。
- `--password <password>`: 密碼覆蓋。警告：內聯密碼可能會在本地進程列表中暴露。
- `--password-file <path>`: 從文件中讀取網關密碼。
- `--tailscale <off|serve|funnel>`: 通過 Tailscale 暴露網關。
- `--tailscale-reset-on-exit`: 在關閉時重置 Tailscale 服務/隧道設定。
- `--allow-unconfigured`: 允許在設定中沒有 `gateway.mode=local` 的情況下啟動網關。
- `--dev`: 如果缺少，創建開發設定 + 工作區（跳過 BOOTSTRAP.md）。
- `--reset`: 重置開發設定 + 憑證 + 會話 + 工作區（需要 `--dev`）。
- `--force`: 在啟動之前終止選定端口上的任何現有監聽器。
- `--verbose`: 詳細日誌。
- `--claude-cli-logs`: 只在控制台顯示 claude-cli 日誌（並啟用其 stdout/stderr）。
- `--ws-log <auto|full|compact>`: websocket 日誌樣式（預設 `auto`）。
- `--compact`: `--ws-log compact` 的別名。
- `--raw-stream`: 將原始模型流事件日誌記錄為 jsonl。
- `--raw-stream-path <path>`: 原始流 jsonl 路徑。

## 查詢正在執行的 Gateway

所有查詢命令都使用 WebSocket RPC。

[[BLOCK_1]]  
輸出模式：  
[[BLOCK_1]]

- 預設：可讀性高的人類格式（在 TTY 中顯示顏色）。
- `--json`：機器可讀的 JSON 格式（無樣式/旋轉器）。
- `--no-color`（或 `NO_COLOR=1`）：禁用 ANSI，同時保留人類可讀的佈局。

共享選項（在支援的情況下）：

- `--url <url>`: 閘道器 WebSocket URL。
- `--token <token>`: 閘道器 token。
- `--password <password>`: 閘道器密碼。
- `--timeout <ms>`: 超時/預算（根據指令而異）。
- `--expect-final`: 等待“最終”回應（代理呼叫）。

注意：當你設置 `--url` 時，CLI 不會回退到設定或環境憑證。請明確傳遞 `--token` 或 `--password`。缺少明確的憑證將會導致錯誤。

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` 顯示了 Gateway 服務（launchd/systemd/schtasks）以及一個可選的 RPC 探測。

```bash
openclaw gateway status
openclaw gateway status --json
```

Options:

- `--url <url>`: 覆寫探測器的 URL。
- `--token <token>`: 探測器的 token 認證。
- `--password <password>`: 探測器的密碼認證。
- `--timeout <ms>`: 探測器超時設定（預設 `10000`）。
- `--no-probe`: 跳過 RPC 探測（僅服務視圖）。
- `--deep`: 也掃描系統級服務。

Notes:

- `gateway status` 會在可能的情況下解析設定的認證 SecretRefs 以進行探針認證。
- 如果在此命令路徑中所需的認證 SecretRef 無法解析，則探針認證可能會失敗；請明確傳遞 `--token`/`--password` 或先解析秘密來源。
- 在 Linux systemd 安裝中，服務認證漂移檢查會從單元中讀取 `Environment=` 和 `EnvironmentFile=` 的值（包括 `%h`、引用的路徑、多個檔案以及可選的 `-` 檔案）。

### `gateway probe`

`gateway probe` 是「調試所有內容」的指令。它總是進行探測：

- 您設定的遠端閘道（如果已設定），以及
- 本地主機（回送），**即使已設定遠端**。

如果有多個閘道可達，它會列印出所有閘道。在使用隔離的設定檔/埠（例如，救援機器人）時，支援多個閘道，但大多數安裝仍然執行單一閘道。

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Remote over SSH (Mac 應用程式相容性)

macOS 應用程式「透過 SSH 遠端」模式使用本地端口轉發，因此遠端閘道（可能僅綁定到回環）可以在 `ws://127.0.0.1:<port>` 上訪問。

CLI 等價：

```bash
openclaw gateway probe --ssh user@gateway-host
```

Options:

- `--ssh <target>`: `user@host` 或 `user@host:port`（預設埠為 `22`）。
- `--ssh-identity <path>`: 身分識別檔案。
- `--ssh-auto`: 選擇第一個發現的閘道主機作為 SSH 目標（僅限 LAN/WAB）。

Config (可選，作為預設值)：

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

低階 RPC 幫助程式。

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

[[BLOCK_1]]

- `gateway install` 支援 `--port`、`--runtime`、`--token`、`--force`、`--json`。
- 當 token 認證需要一個 token 且 `gateway.auth.token` 由 SecretRef 管理時，`gateway install` 驗證 SecretRef 是否可解析，但不會將解析後的 token 持久化到服務環境的元數據中。
- 如果 token 認證需要一個 token 且設定的 token SecretRef 無法解析，安裝將會失敗並關閉，而不是持久化回退的明文。
- 對於 `gateway run` 的密碼認證，建議使用 `OPENCLAW_GATEWAY_PASSWORD`、`--password-file` 或由 SecretRef 支援的 `gateway.auth.password`，而不是內嵌的 `--password`。
- 在推斷認證模式下，僅限於 shell 的 `OPENCLAW_GATEWAY_PASSWORD`/`CLAWDBOT_GATEWAY_PASSWORD` 不會放寬安裝 token 的要求；安裝受管理的服務時，請使用持久設定 (`gateway.auth.password` 或設定 `env`)。
- 如果同時設定了 `gateway.auth.token` 和 `gateway.auth.password`，且 `gateway.auth.mode` 未設置，安裝將被阻止，直到模式被明確設置。
- 生命週期命令接受 `--json` 用於腳本編寫。

## 發現網關 (Bonjour)

`gateway discover` 掃描 Gateway 信標 (`_openclaw-gw._tcp`)。

- 多播 DNS-SD: `local.`
- 單播 DNS-SD（廣域 Bonjour）: 選擇一個網域（範例: `openclaw.internal.`）並設置分割 DNS + DNS 伺服器；詳情請參見 [/gateway/bonjour](/gateway/bonjour)

只有啟用 Bonjour 探索的閘道（預設設定）會廣播信標。

[[BLOCK_1]]  
Wide-Area discovery records 包含 (TXT):  
[[BLOCK_1]]

- `role` (閘道角色提示)
- `transport` (傳輸提示，例如 `gateway`)
- `gatewayPort` (WebSocket 端口，通常是 `18789`)
- `sshPort` (SSH 端口；如果不存在則預設為 `22`)
- `tailnetDns` (MagicDNS 主機名稱，當可用時)
- `gatewayTls` / `gatewayTlsSha256` (啟用 TLS + 憑證指紋)
- `cliPath` (遠端安裝的可選提示)

### `gateway discover`

```bash
openclaw gateway discover
```

Options:

- `--timeout <ms>`: 每個指令的超時設定（瀏覽/解析）；預設值 `2000`。
- `--json`: 機器可讀的輸出（同時禁用樣式/旋轉器）。

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
