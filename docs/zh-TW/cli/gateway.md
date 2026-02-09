---
summary: "OpenClaw Gateway CLI（`openclaw gateway`）— 執行、查詢與探索 Gateway 閘道器"
read_when:
  - 從 CLI 執行 Gateway 閘道器（開發或伺服器）
  - Debugging Gateway auth, bind modes, and connectivity
  - 透過 Bonjour 探索 Gateway 閘道器（LAN + tailnet）
title: "Gateway"
---

# Gateway CLI

Gateway 閘道器是 OpenClaw 的 WebSocket 伺服器（頻道、節點、工作階段、hooks）。

本頁面的子命令位於 `openclaw gateway …` 之下。

Related docs:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## 執行 Gateway 閘道器

執行本機的 Gateway 閘道器程序：

```bash
openclaw gateway
```

前景模式別名：

```bash
openclaw gateway run
```

注意事項：

- 預設情況下，除非在 `~/.openclaw/openclaw.json` 中設定 `gateway.mode=local`，否則 Gateway 閘道器會拒絕啟動。臨時／開發用途請使用 `--allow-unconfigured`。 Use `--allow-unconfigured` for ad-hoc/dev runs.
- Binding beyond loopback without auth is blocked (safety guardrail).
- 當獲得授權時，`SIGUSR1` 會觸發程序內重新啟動（啟用 `commands.restart`，或使用 gateway tool/config apply/update）。
- `SIGINT`/`SIGTERM` 處理器會停止 gateway 程序，但不會還原任何自訂的終端機狀態。若你以 TUI 或 raw-mode 輸入包裝 CLI，請在結束前還原終端機。 If you wrap the CLI with a TUI or raw-mode input, restore the terminal before exit.

### 選項

- `--port <port>`：WebSocket 連接埠（預設來自設定／環境；通常為 `18789`）。
- `--bind <loopback|lan|tailnet|auto|custom>`：監聽器綁定模式。
- `--auth <token|password>`：身分驗證模式覆寫。
- `--token <token>`：權杖覆寫（同時為程序設定 `OPENCLAW_GATEWAY_TOKEN`）。
- `--password <password>`：密碼覆寫（同時為程序設定 `OPENCLAW_GATEWAY_PASSWORD`）。
- `--tailscale <off|serve|funnel>`：透過 Tailscale 公開 Gateway 閘道器。
- `--tailscale-reset-on-exit`：在關閉時重設 Tailscale serve/funnel 設定。
- `--allow-unconfigured`：允許在設定中沒有 `gateway.mode=local` 的情況下啟動 gateway。
- `--dev`：若缺少則建立開發用設定與工作區（略過 BOOTSTRAP.md）。
- `--reset`：重設開發用設定＋憑證＋工作階段＋工作區（需要 `--dev`）。
- `--force`：啟動前終止選定連接埠上任何既有的監聽器。
- `--verbose`：詳細記錄。
- `--claude-cli-logs`：只在主控台顯示 claude-cli 記錄（並啟用其 stdout/stderr）。
- `--ws-log <auto|full|compact>`：WebSocket 記錄樣式（預設 `auto`）。
- `--compact`：`--ws-log compact` 的別名。
- `--raw-stream`：將原始模型串流事件記錄為 jsonl。
- `--raw-stream-path <path>`：原始串流 jsonl 路徑。

## 查詢正在執行的 Gateway 閘道器

所有查詢命令皆使用 WebSocket RPC。

輸出模式：

- 預設：人類可讀（在 TTY 中著色）。
- `--json`：機器可讀的 JSON（無樣式／轉圈）。
- `--no-color`（或 `NO_COLOR=1`）：停用 ANSI，同時保留人類版面配置。

共用選項（視支援情況）：

- `--url <url>`：Gateway WebSocket URL。
- `--token <token>`：Gateway 權杖。
- `--password <password>`：Gateway 密碼。
- `--timeout <ms>`：逾時／配額（依命令而異）。
- `--expect-final`：等待「最終」回應（代理程式呼叫）。

注意：當你設定 `--url` 時，CLI 不會回退到設定或環境中的憑證。
請明確傳入 `--token` 或 `--password`。缺少明確憑證會視為錯誤。
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` 會顯示 Gateway 服務（launchd/systemd/schtasks），以及可選的 RPC 探測。

```bash
openclaw gateway status
openclaw gateway status --json
```

選項：

- `--url <url>`：覆寫探測 URL。
- `--token <token>`：探測用權杖身分驗證。
- `--password <password>`：探測用密碼身分驗證。
- `--timeout <ms>`：探測逾時（預設 `10000`）。
- `--no-probe`：略過 RPC 探測（僅服務檢視）。
- `--deep`：同時掃描系統層級服務。

### `gateway probe`

`gateway probe` 是「全面偵錯」命令。它一定會探測： It always probes:

- 你設定的遠端 gateway（若有設定），以及
- localhost（loopback），**即使已設定遠端**。

If multiple gateways are reachable, it prints all of them. Multiple gateways are supported when you use isolated profiles/ports (e.g., a rescue bot), but most installs still run a single gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### 透過 SSH 遠端連線（macOS App 對等）

macOS App 的「Remote over SSH」模式會使用本機連接埠轉送，讓可能只綁定至 loopback 的遠端 gateway 能在 `ws://127.0.0.1:<port>` 存取。

CLI 等效：

```bash
openclaw gateway probe --ssh user@gateway-host
```

選項：

- `--ssh <target>`：`user@host` 或 `user@host:port`（連接埠預設為 `22`）。
- `--ssh-identity <path>`：身分識別檔案。
- `--ssh-auto`：選擇第一個探索到的閘道器主機作為 SSH 目標（僅 LAN/WAB）。

設定（可選，作為預設值）：

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
- 生命週期命令接受 `--json` 以利腳本化。

## 探索 Gateway 閘道器（Bonjour）

`gateway discover` 會掃描 Gateway 信標（`_openclaw-gw._tcp`）。

- 多播 DNS-SD：`local.`
- 單播 DNS-SD（Wide-Area Bonjour）：選擇網域（範例：`openclaw.internal.`），並設定 split DNS＋DNS 伺服器；請參閱 [/gateway/bonjour](/gateway/bonjour)

只有啟用 Bonjour 探索（預設）的 Gateway 閘道器才會廣播信標。

Wide-Area 探索記錄包含（TXT）：

- `role`（gateway 角色提示）
- `transport`（傳輸提示，例如 `gateway`）
- `gatewayPort`（WebSocket 連接埠，通常為 `18789`）
- `sshPort`（SSH 連接埠；若未提供，預設為 `22`）
- `tailnetDns`（MagicDNS 主機名稱（若可用））
- `gatewayTls` / `gatewayTlsSha256`（已啟用 TLS ＋ 憑證指紋）
- `cliPath`（遠端安裝的選用提示）

### `gateway discover`

```bash
openclaw gateway discover
```

選項：

- `--timeout <ms>`：每個命令的逾時（瀏覽／解析）；預設 `2000`。
- `--json`：機器可讀輸出（同時停用樣式／轉圈）。

範例：

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
