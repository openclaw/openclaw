---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — 執行、查詢與探索 Gateway"
read_when:
  - 從 CLI 執行 Gateway (開發或伺服器環境)
  - 除錯 Gateway 驗證、綁定模式及連線能力
  - 透過 Bonjour (區域網路 + tailnet) 探索 Gateway
title: "gateway"
---

# Gateway CLI

Gateway 是 OpenClaw 的 WebSocket 伺服器 (頻道、節點、工作階段、掛鉤)。

本頁面中的子指令位於 `openclaw gateway …` 之下。

相關文件：

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## 執行 Gateway

執行本地 Gateway 程序：

```bash
openclaw gateway
```

前台別名：

```bash
openclaw gateway run
```

注意：

- 預設情況下，除非在 `~/.openclaw/openclaw.json` 中設定了 `gateway.mode=local`，否則 Gateway 將拒絕啟動。對於臨時或開發執行，請使用 `--allow-unconfigured`。
- 在沒有驗證的情況下綁定到 local loopback 以外的位址會被封鎖（安全防護措施）。
- 獲得授權時，`SIGUSR1` 會觸發程序內重啟（啟用 `commands.restart` 或使用 gateway 工具/設定套用/更新）。
- `SIGINT`/`SIGTERM` 處理程式會停止 Gateway 程序，但不會還原任何自定義的終端機狀態。如果您使用 TUI 或原始模式輸入封裝 CLI，請在結束前還原終端機。

### 選項

- `--port <port>`: WebSocket 連接埠 (預設來自設定/環境變數；通常為 `18789`)。
- `--bind <loopback|lan|tailnet|auto|custom>`: 接聽程式綁定模式。
- `--auth <token|password>`: 覆蓋驗證模式。
- `--token <token>`: 覆蓋 token (也會為程序設定 `OPENCLAW_GATEWAY_TOKEN`)。
- `--password <password>`: 覆蓋密碼 (也會為程序設定 `OPENCLAW_GATEWAY_PASSWORD`)。
- `--tailscale <off|serve|funnel>`: 透過 Tailscale 公開 Gateway。
- `--tailscale-reset-on-exit`: 關機時重設 Tailscale serve/funnel 設定。
- `--allow-unconfigured`: 允許在設定中沒有 `gateway.mode=local` 的情況下啟動 Gateway。
- `--dev`: 如果遺失，則建立開發設定 + 工作空間 (跳過 BOOTSTRAP.md)。
- `--reset`: 重設開發設定 + 認證憑證 + 工作階段 + 工作空間 (需要 `--dev`)。
- `--force`: 在啟動前強制關閉所選連接埠上的任何現有接聽程式。
- `--verbose`: 詳細記錄。
- `--claude-cli-logs`: 僅在主控台中顯示 claude-cli 記錄 (並啟用其標準輸出/標準錯誤)。
- `--ws-log <auto|full|compact>`: websocket 記錄樣式 (預設為 `auto`)。
- `--compact`: `--ws-log compact` 的別名。
- `--raw-stream`: 將原始模型串流事件記錄到 jsonl。
- `--raw-stream-path <path>`: 原始串流 jsonl 路徑。

## 查詢執行中的 Gateway

所有查詢指令皆使用 WebSocket RPC。

輸出模式：

- 預設：人類可讀 (在 TTY 中有顏色)。
- `--json`: 機器可讀的 JSON (無樣式/載入圖示)。
- `--no-color` (或 `NO_COLOR=1`)：停用 ANSI 但保留人類可讀版面。

共用選項 (若支援)：

- `--url <url>`: Gateway WebSocket URL。
- `--token <token>`: Gateway token。
- `--password <password>`: Gateway 密碼。
- `--timeout <ms>`: 逾時/預算 (視指令而定)。
- `--expect-final`: 等待「最終」回應 (智慧代理呼叫)。

注意：當您設定 `--url` 時，CLI 不會回退到設定或環境憑證。請明確傳遞 `--token` 或 `--password`。缺少明確憑證將導致錯誤。

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` 顯示 Gateway 服務 (launchd/systemd/schtasks) 以及選用的 RPC 探測。

```bash
openclaw gateway status
openclaw gateway status --json
```

選項：

- `--url <url>`: 覆蓋探測 URL。
- `--token <token>`: 用於探測的 token 驗證。
- `--password <password>`: 用於探測的密碼驗證。
- `--timeout <ms>`: 探測逾時 (預設為 `10000`)。
- `--no-probe`: 跳過 RPC 探測 (僅檢視服務)。
- `--deep`: 同時掃描系統層級服務。

### `gateway probe`

`gateway probe` 是「偵錯一切」的指令。它一律探測：

- 您設定的遠端 Gateway (若有設定)，以及
- localhost (loopback) **即使已設定遠端**。

如果有多個 Gateway 可連及，它會列出所有 Gateway。當您使用隔離的設定檔/連接埠 (例如：救援機器人) 時，支援多個 Gateway，但大多數安裝仍僅執行單個 Gateway。

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### 透過 SSH 進行遠端連線 (與 Mac app 功能一致)

macOS app 的「透過 SSH 進行遠端連線」模式使用本地連接埠轉發，因此遠端 Gateway (可能僅綁定到 loopback) 變得可以透過 `ws://127.0.0.1:<port>` 存取。

CLI 等效指令：

```bash
openclaw gateway probe --ssh user @gateway-host
```

選項：

- `--ssh <target>`: `user @host` 或 `user @host:port` (連接埠預設為 `22`)。
- `--ssh-identity <path>`: 身分識別檔案。
- `--ssh-auto`: 選取第一個探索到的 Gateway 主機作為 SSH 目標 (僅限 LAN/WAB)。

設定 (選用，作為預設值使用)：

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

底層 RPC 輔助工具。

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

注意：

- `gateway install` 支援 `--port`, `--runtime`, `--token`, `--force`, `--json`。
- 生命週期指令接受用於指令碼編寫的 `--json`。

## 探索 Gateway (Bonjour)

`gateway discover` 掃描 Gateway 信標 (`_openclaw-gw._tcp`)。

- 多點傳送 DNS-SD：`local.`
- 單點傳送 DNS-SD (廣域 Bonjour)：選擇一個網域 (例如：`openclaw.internal.`) 並設定分割 DNS + DNS 伺服器；請參閱 [/gateway/bonjour](/gateway/bonjour)

僅啟用了 Bonjour 探索 (預設) 的 Gateway 會發送信標。

廣域探索紀錄包括 (TXT)：

- `role` (Gateway 角色提示)
- `transport` (傳輸提示，例如：`gateway`)
- `gatewayPort` (WebSocket 連接埠，通常為 `18789`)
- `sshPort` (SSH 連接埠；若不存在則預設為 `22`)
- `tailnetDns` (MagicDNS 主機名稱，若可用)
- `gatewayTls` / `gatewayTlsSha256` (已啟用 TLS + 憑證指紋)
- `cliPath` (遠端安裝的選用提示)

### `gateway discover`

```bash
openclaw gateway discover
```

選項：

- `--timeout <ms>`: 每個指令的逾時 (瀏覽/解析)；預設為 `2000`。
- `--json`: 機器可讀輸出 (同時停用樣式/載入圖示)。

範例：

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
