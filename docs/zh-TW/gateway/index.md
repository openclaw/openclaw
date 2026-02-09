---
summary: "Gateway 服務的操作手冊，涵蓋生命週期與營運"
read_when:
  - 正在執行或除錯 Gateway 程序時
title: "Gateway 操作手冊"
---

# Gateway 服務操作手冊

最後更新：2025-12-09

## 這是什麼

- 一個常駐程序，負責唯一的 Baileys/Telegram 連線以及控制／事件平面。
- 41. 取代舊版的 `gateway` 指令。 取代舊版 `gateway` 指令。CLI 入口點：`openclaw gateway`。
- 12. 會持續執行直到停止；在致命錯誤時以非零值退出，讓監督程式重新啟動它。

## 43. 如何執行（本機）

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- 設定熱重載會監看 `~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）。
  - 預設模式：`gateway.reload.mode="hybrid"`（安全變更即時套用，關鍵變更則重啟）。
  - 需要時，熱重載會透過 **SIGUSR1** 進行行程內重啟。
  - 使用 `gateway.reload.mode="off"` 停用。
- 將 WebSocket 控制平面綁定至 `127.0.0.1:<port>`（預設 18789）。
- 同一個連接埠也提供 HTTP（控制 UI、hooks、A2UI）。單一連接埠多工。 44. 單一連接埠多工。
  - OpenAI Chat Completions（HTTP）：[`/v1/chat/completions`](/gateway/openai-http-api)。
  - OpenResponses（HTTP）：[`/v1/responses`](/gateway/openresponses-http-api)。
  - Tools Invoke（HTTP）：[`/tools/invoke`](/gateway/tools-invoke-http-api)。
- 預設會在 `canvasHost.port`（預設 `18793`）啟動 Canvas 檔案伺服器，從 `~/.openclaw/workspace/canvas` 提供 `http://<gateway-host>:18793/__openclaw__/canvas/`。使用 `canvasHost.enabled=false` 或 `OPENCLAW_SKIP_CANVAS_HOST=1` 停用。 45. 使用 `canvasHost.enabled=false` 或 `OPENCLAW_SKIP_CANVAS_HOST=1` 停用。
- 記錄輸出至 stdout；使用 launchd/systemd 以保持常駐並進行日誌輪替。
- 16. 疑難排解時，傳入 `--verbose` 可將日誌檔中的除錯記錄（交握、請求/回應、事件）鏡像到 stdio。
- `--force` 會使用 `lsof` 在選定的連接埠上尋找監聽者，送出 SIGTERM，記錄終止的程序，然後啟動 Gateway（若缺少 `lsof` 則快速失敗）。
- 若在監督程式下執行（launchd/systemd/mac app 子程序模式），停止／重啟通常會送出 **SIGTERM**；較舊版本可能顯示為 `pnpm` `ELIFECYCLE` 的結束碼 **143**（SIGTERM），這是正常關閉而非當機。
- **SIGUSR1** 在授權情況下會觸發行程內重啟（Gateway 工具／設定套用／更新，或啟用 `commands.restart` 以手動重啟）。
- 預設需要 Gateway 驗證：設定 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）或 `gateway.auth.password`。除非使用 Tailscale Serve 身分，否則客戶端必須送出 `connect.params.auth.token/password`。 17. 除非使用 Tailscale Serve 身分識別，否則客戶端必須送出 `connect.params.auth.token/password`。
- 48. 精靈現在預設會產生權杖，即使在回送位址上也是如此。
- 連接埠優先順序：`--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > 預設 `18789`。

## 49. 遠端存取

- 建議使用 Tailscale/VPN；否則使用 SSH 通道：

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- 客戶端接著透過通道連線至 `ws://127.0.0.1:18789`。

- 若已設定權杖，即使走通道，客戶端仍須在 `connect.params.auth.token` 中包含它。

## 多個 Gateway（同一主機）

通常不需要：單一 Gateway 可服務多個訊息頻道與代理程式。僅在需要備援或嚴格隔離（例如救援機器人）時才使用多個 Gateway。 在隔離狀態與設定並使用唯一連接埠時可支援。完整指南：[Multiple gateways](/gateway/multiple-gateways)。

50. 若你隔離狀態與設定並使用唯一的連接埠，即可支援。 21. 完整指南：[Multiple gateways](/gateway/multiple-gateways)。

22. 服務名稱具備設定檔感知能力：

- macOS：`bot.molt.<profile>`（舊版 `com.openclaw.*` 可能仍存在）
- Linux：`openclaw-gateway-<profile>.service`
- Windows：`OpenClaw Gateway (<profile>)`

安裝中繼資料內嵌於服務設定中：

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot Pattern: keep a second Gateway isolated with its own profile, state dir, workspace, and base port spacing. Full guide: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### 開發設定檔（`--dev`）

快速路徑：在不影響主要設定的情況下，執行完全隔離的開發實例（設定／狀態／工作區）。

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

預設值（可透過 env／旗標／設定覆寫）：

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001`（Gateway WS + HTTP）
- 瀏覽器控制服務連接埠 = `19003`（推導：`gateway.port+2`，僅 loopback）
- `canvasHost.port=19005`（推導：`gateway.port+4`）
- 當你在 `--dev` 下執行 `setup`/`onboard` 時，`agents.defaults.workspace` 的預設值會變為 `~/.openclaw/workspace-dev`。

25. 衍生連接埠（經驗法則）：

- 基準連接埠 = `gateway.port`（或 `OPENCLAW_GATEWAY_PORT`／`--port`）
- 瀏覽器控制服務連接埠 = 基準 + 2（僅 loopback）
- `canvasHost.port = base + 4`（或 `OPENCLAW_CANVAS_HOST_PORT`／設定覆寫）
- 瀏覽器設定檔 CDP 連接埠會從 `browser.controlPort + 9 .. + 108` 自動配置（每個設定檔持久化）。

26. 每個實例的檢查清單：

- 唯一的 `gateway.port`
- 唯一的 `OPENCLAW_CONFIG_PATH`
- 唯一的 `OPENCLAW_STATE_DIR`
- 唯一的 `agents.defaults.workspace`
- 獨立的 WhatsApp 號碼（若使用 WA）

27. 每個設定檔的服務安裝：

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

範例：

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## 協定（操作人員視角）

- 完整文件：[Gateway protocol](/gateway/protocol) 與 [Bridge protocol（舊版）](/gateway/bridge-protocol)。
- 客戶端的必要第一個訊框：`req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`。
- Gateway 回覆 `res {type:"res", id, ok:true, payload:hello-ok }`（或帶錯誤的 `ok:false`，然後關閉）。
- 交握後：
  - 請求：`{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - 事件：`{type:"event", event, payload, seq?, stateVersion?}`
- 結構化 presence 項目：`{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }`（對於 WS 客戶端，`instanceId` 來自 `connect.client.instanceId`）。
- `agent` 回應為兩階段：先 `res` ack `{runId,status:"accepted"}`，完成後再送出最終的 `res` `{runId,status:"ok"|"error",summary}`；串流輸出以 `event:"agent"` 抵達。

## 方法（初始集合）

- `health` — 完整健康快照（與 `openclaw health --json` 形狀相同）。
- `status` — 簡短摘要。
- `system-presence` — 目前 presence 清單。
- 28. `system-event` — 發佈一則存在/系統備註（結構化）。
- `send` — 透過作用中的頻道送出訊息。
- `agent` — 執行代理程式回合（在同一連線上串流事件）。
- `node.list` — 列出已配對與目前已連線的節點（包含 `caps`、`deviceFamily`、`modelIdentifier`、`paired`、`connected`，以及宣告的 `commands`）。
- `node.describe` — 描述節點（能力 + 支援的 `node.invoke` 指令；適用於已配對節點與目前已連線但未配對的節點）。
- `node.invoke` — 在節點上呼叫指令（例如 `canvas.*`、`camera.*`）。
- `node.pair.*` — 配對生命週期（`request`、`list`、`approve`、`reject`、`verify`）。

另請參閱：[Presence](/concepts/presence) 以了解 presence 如何產生／去重，以及為何穩定的 `client.instanceId` 很重要。

## 事件

- `agent` — 代理程式執行的工具／輸出事件串流（帶序號標記）。
- `presence` — presence 更新（含 stateVersion 的差異）推送至所有已連線的客戶端。
- `tick` — 週期性 keepalive／no-op 以確認存活。
- `shutdown` — Gateway 正在結束；酬載包含 `reason` 與可選的 `restartExpectedMs`。客戶端應重新連線。 29. 客戶端應重新連線。

## WebChat 整合

- WebChat 是原生 SwiftUI UI，直接與 Gateway WebSocket 溝通以取得歷史、送出、終止與事件。
- 遠端使用會走同一個 SSH/Tailscale 通道；若設定了 Gateway 權杖，客戶端會在 `connect` 期間包含它。
- macOS app 透過單一 WS（共享連線）連線；它從初始快照補齊 presence，並監聽 `presence` 事件以更新 UI。

## 30. 輸入與驗證

- 伺服器使用 AJV，依協定定義所產生的 JSON Schema 驗證每個入站訊框。
- 客戶端（TS/Swift）使用產生的型別（TS 直接使用；Swift 透過儲存庫的產生器）。
- 協定定義是唯一真實來源；以以下指令重新產生 schema／models：
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## 連線快照

- `hello-ok` 包含一個 `snapshot`，內含 `presence`、`health`、`stateVersion`、`uptimeMs`，以及 `policy {maxPayload,maxBufferedBytes,tickIntervalMs}`，讓客戶端無需額外請求即可立即呈現。
- `health`/`system-presence` 仍可用於手動重新整理，但在連線時並非必需。

## 錯誤碼（res.error 形狀）

- 錯誤使用 `{ code, message, details?, retryable?, retryAfterMs? }`。
- 標準碼：
  - `NOT_LINKED` — WhatsApp 尚未驗證。
  - `AGENT_TIMEOUT` — 代理程式未在設定的期限內回應。
  - `INVALID_REQUEST` — schema／參數驗證失敗。
  - `UNAVAILABLE` — Gateway 正在關閉或相依服務不可用。

## Keepalive 行為

- 會定期發出 `tick` 事件（或 WS ping/pong），即使沒有流量也能讓客戶端知道 Gateway 存活。
- 送出／代理程式的確認仍是獨立回應；不要用 tick 來承載送出。

## 重播／缺口

- 31. 事件不會被重播。 32. 客戶端會偵測序列缺口，並在繼續之前應重新整理（`health` + `system-presence`）。 33. WebChat 與 macOS 客戶端現在會在出現缺口時自動重新整理。

## 監督（macOS 範例）

- 使用 launchd 以保持服務存活：
  - Program：`openclaw` 的路徑
  - Arguments：`gateway`
  - KeepAlive：true
  - StandardOut/Err：檔案路徑或 `syslog`
- On failure, launchd restarts; fatal misconfig should keep exiting so the operator notices.
- LaunchAgents 為每使用者且需要登入的工作階段；無頭環境請使用自訂的 LaunchDaemon（未隨附）。
  - `openclaw gateway install` 會寫入 `~/Library/LaunchAgents/bot.molt.gateway.plist`
    （或 `bot.molt.<profile>.plist`；舊版 `com.openclaw.*` 會被清理）。
  - `openclaw doctor` 會稽核 LaunchAgent 設定，並可更新為目前的預設值。

## Gateway 服務管理（CLI）

使用 Gateway CLI 進行安裝／啟動／停止／重啟／狀態：

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

注意事項：

- `gateway status` 預設使用服務解析後的連接埠／設定來探測 Gateway RPC（可用 `--url` 覆寫）。
- `gateway status --deep` 會加入系統層級的掃描（LaunchDaemons／system units）。
- `gateway status --no-probe` 會略過 RPC 探測（在網路中斷時有用）。
- `gateway status --json` 對腳本穩定。
- `gateway status` 會分別回報 **監督程式執行狀態**（launchd/systemd 是否在跑）與 **RPC 可達性**（WS 連線 + status RPC）。
- `gateway status` 會列印設定路徑與探測目標，以避免「localhost vs LAN 綁定」混淆與設定檔不匹配。
- `gateway status` 會在服務看似運行但連接埠關閉時，包含最後一行 Gateway 錯誤。
- `logs` 會透過 RPC 尾隨 Gateway 檔案日誌（不需手動 `tail`/`grep`）。
- If other gateway-like services are detected, the CLI warns unless they are OpenClaw profile services.
  We still recommend **one gateway per machine** for most setups; use isolated profiles/ports for redundancy or a rescue bot. 37. 參見 [Multiple gateways](/gateway/multiple-gateways)。
  - 清理：`openclaw gateway uninstall`（目前服務）與 `openclaw doctor`（舊版遷移）。
- `gateway install` 在已安裝時為 no-op；使用 `openclaw gateway install --force` 以重新安裝（設定檔／env／路徑變更）。

隨附的 mac app：

- OpenClaw.app 可內含以 Node 為基礎的 Gateway 中繼，並安裝一個每使用者的 LaunchAgent，標籤為
  `bot.molt.gateway`（或 `bot.molt.<profile>`；舊版 `com.openclaw.*` 標籤仍可乾淨卸載）。
- 要乾淨停止，使用 `openclaw gateway stop`（或 `launchctl bootout gui/$UID/bot.molt.gateway`）。
- 要重啟，使用 `openclaw gateway restart`（或 `launchctl kickstart -k gui/$UID/bot.molt.gateway`）。
  - `launchctl` 僅在已安裝 LaunchAgent 時可用；否則請先使用 `openclaw gateway install`。
  - 執行具名設定檔時，請以 `bot.molt.<profile> ` 取代標籤。38. \` 在執行具名設定檔時。

## 監督（systemd 使用者單元）

OpenClaw 在 Linux/WSL2 預設安裝 **systemd 使用者服務**。我們
建議單一使用者機器使用使用者服務（環境較簡單、每使用者設定）。
多使用者或常駐伺服器則使用 **系統服務**（不需 lingering，共用監督）。 39. 我們建議在單使用者機器上使用使用者服務（環境較簡單、每位使用者各自的設定）。
40. 對於多使用者或永遠在線的伺服器，請使用 **系統服務**（不需要 lingering，共享監督）。

`openclaw gateway install` writes the user unit. `openclaw doctor` audits the
unit and can update it to match the current recommended defaults.

建立 `~/.config/systemd/user/openclaw-gateway[-<profile>].service`：

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

啟用 lingering（必要，讓使用者服務在登出／閒置後仍存活）：

```
sudo loginctl enable-linger youruser
```

入門引導會在 Linux/WSL2 上執行此步驟（可能要求 sudo；寫入 `/var/lib/systemd/linger`）。
接著啟用服務：
Then enable the service:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternative (system service)** - for always-on or multi-user servers, you can
install a systemd **system** unit instead of a user unit (no lingering needed).
**替代方案（系統服務）** — 對於常駐或多使用者伺服器，你可以安裝 systemd **系統** 單元而非使用者單元（不需 lingering）。
建立 `/etc/systemd/system/openclaw-gateway[-<profile>].service`（複製上述單元，
切換 `WantedBy=multi-user.target`，設定 `User=` + `WorkingDirectory=`），然後：

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows（WSL2）

Windows 安裝應使用 **WSL2**，並依照上述 Linux systemd 章節。

## Operational checks

- 存活度：開啟 WS 並送出 `req:connect` → 期望收到 `res`，且包含 `payload.type="hello-ok"`（含快照）。
- 就緒度：呼叫 `health` → 期望收到 `ok: true`，且在 `linkChannel` 中有已連結的頻道（適用時）。
- 除錯：訂閱 `tick` 與 `presence` 事件；確認 `status` 顯示連結／驗證年齡；presence 項目顯示 Gateway 主機與已連線的客戶端。

## 安全保證

- Assume one Gateway per host by default; if you run multiple profiles, isolate ports/state and target the right instance.
- 不回退至直接 Baileys 連線；若 Gateway 停止，送出會快速失敗。
- 非 connect 的第一訊框或格式錯誤的 JSON 會被拒絕並關閉 socket。
- 優雅關閉：在關閉前送出 `shutdown` 事件；客戶端必須處理關閉並重新連線。

## CLI 輔助工具

- `openclaw gateway health|status` — 透過 Gateway WS 請求健康／狀態。
- `openclaw message send --target <num> --message "hi" [--media ...]` — 透過 Gateway 送出（對 WhatsApp 具冪等性）。
- `openclaw agent --message "hi" --to <num>` — 執行代理程式回合（預設等待最終結果）。
- `openclaw gateway call <method> --params '{"k":"v"}'` — 原始方法呼叫器，用於除錯。
- `openclaw gateway stop|restart` — 停止／重啟受監督的 Gateway 服務（launchd/systemd）。
- Gateway 輔助子指令假設 `--url` 上已有執行中的 Gateway；它們不再自動啟動一個。

## 遷移指引

- 淘汰 `openclaw gateway` 與舊版 TCP 控制連接埠的使用。
- 更新客戶端以使用 WS 協定，並採用必要的 connect 與結構化 presence。
