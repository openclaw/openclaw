---
summary: >-
  Security considerations and threat model for running an AI gateway with shell
  access
read_when:
  - Adding features that widen access or automation
title: Security
---

# Security 🔒

> [!WARNING]
> **個人助理信任模型：** 此指導假設每個網關有一個受信任的操作邊界（單一使用者/個人助理模型）。  
> OpenClaw **不是** 一個針對多個對抗性使用者共享同一代理/網關的敵對多租戶安全邊界。  
> 如果您需要混合信任或對抗性使用者操作，請分割信任邊界（分開的網關 + 憑證，理想情況下分開的作業系統使用者/主機）。

## Scope first: personal assistant security model

OpenClaw 安全指導假設了一個 **個人助理** 部署：一個受信任的操作邊界，可能有許多代理。

- 支援的安全姿態：每個閘道一個使用者/信任邊界（建議每個邊界使用一個作業系統使用者/主機/VPS）。
- 不支援的安全邊界：由互不信任或對立的使用者共用的閘道/代理。
- 如果需要對立使用者隔離，則依據信任邊界進行拆分（分開的閘道 + 憑證，理想情況下分開的作業系統使用者/主機）。
- 如果多個不受信任的使用者可以對一個工具啟用的代理發送訊息，則將它們視為共享該代理的相同委派工具權限。

這個頁面解釋了**在該模型內部**的強化措施。它並不聲稱在一個共享閘道上具備敵對的多租戶隔離。

## 快速檢查: `openclaw security audit`

另請參閱：[形式驗證 (安全模型)](/security/formal-verification/)

定期執行此操作（特別是在更改設定或暴露網路介面後）：

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
openclaw security audit --json
```

它標示了常見的錯誤設定（網關認證暴露、瀏覽器控制暴露、提升的允許清單、檔案系統權限）。

OpenClaw 既是一個產品，也是一次實驗：你正在將前沿模型行為接入真實的消息表面和真實的工具。**沒有“完美安全”的設置。** 目標是要有意識地考量：

- 誰可以與你的機器人對話
- 機器人被允許在哪裡行動
- 機器人可以觸碰什麼

從最小的可行存取開始，然後隨著信心的增強逐漸擴大存取範圍。

## 部署假設（重要）

OpenClaw 假設主機和設定邊界是可信的：

- 如果有人可以修改 Gateway 主機狀態/設定 (`~/.openclaw`，包括 `openclaw.json`），則將他們視為受信任的操作員。
- 對於多個互不信任/對立的操作員執行一個 Gateway 是 **不建議的設置**。
- 對於混合信任的團隊，應該使用不同的 Gateway 來劃分信任邊界（或至少使用不同的作業系統使用者/主機）。
- OpenClaw 可以在一台機器上執行多個 Gateway 實例，但建議的操作是偏向於清晰的信任邊界分離。
- 建議的預設：每台機器/主機（或 VPS）一個使用者，該使用者對應一個 Gateway，以及一個或多個在該 Gateway 中的代理。
- 如果多個使用者想要使用 OpenClaw，則每個使用者應使用一個 VPS/主機。

### 實際後果（操作員信任邊界）

在一個 Gateway 實例內，經過身份驗證的操作員訪問是一個受信任的控制平面角色，而不是每個用戶的租戶角色。

- 擁有讀取/控制平面存取權的操作員可以根據設計檢查網關會話的元數據/歷史紀錄。
- 會話識別碼 (`sessionKey`、會話 ID、標籤) 是路由選擇器，而不是授權token。
- 例如：期望對於像 `sessions.list`、`sessions.preview` 或 `chat.history` 這樣的方法進行每個操作員的隔離，超出了這個模型的範疇。
- 如果需要對抗性使用者隔離，請在每個信任邊界執行單獨的網關。
- 在一台機器上執行多個網關在技術上是可行的，但並不是多使用者隔離的推薦基準。

## 個人助理模型（非多租戶總線）

OpenClaw 被設計為一個個人助理安全模型：一個受信任的操作邊界，可能有許多代理。

- 如果多個人可以向一個工具啟用的代理發送訊息，那麼他們每個人都可以控制相同的權限集。
- 每位用戶的會話/記憶體隔離有助於隱私，但並不將共享代理轉換為每位用戶的主機授權。
- 如果用戶之間可能存在對抗關係，則在每個信任邊界執行單獨的網關（或單獨的作業系統用戶/主機）。

### 共享的 Slack 工作區：實際風險

如果「Slack 中的每個人都可以發送訊息給機器人」，那麼核心風險就是委派工具權限：

- 任何被允許的發送者都可以在代理的政策內引發工具調用 (`exec`、瀏覽器、網路/檔案工具)；
- 來自一個發送者的提示/內容注入可能會導致影響共享狀態、設備或輸出的行為；
- 如果一個共享代理擁有敏感的憑證/檔案，任何被允許的發送者都可能透過工具使用來驅動資料外洩。

使用獨立的代理/閘道，並以最少的工具來進行團隊工作流程；保持個人資料代理的私密性。

### Company-shared agent: 可接受的模式

當所有使用該代理的人都在相同的信任邊界內（例如同一公司團隊）且該代理的範疇嚴格限於商業用途時，這是可以接受的。

- 在專用的機器/虛擬機/容器上執行；
- 使用專用的作業系統使用者 + 專用的瀏覽器/個人資料/帳戶來進行該執行；
- 不要將該執行登入個人的 Apple/Google 帳戶或個人密碼管理器/瀏覽器個人資料。

如果你在同一個執行環境中混合個人身份和公司身份，你將會破壞這種分離，並增加個人資料暴露的風險。

## Gateway 和節點信任概念

將 Gateway 和節點視為一個操作信任域，並擁有不同的角色：

- **Gateway** 是控制平面和政策表面 (`gateway.auth`、工具政策、路由)。
- **Node** 是與該 Gateway 配對的遠端執行表面（命令、設備操作、主機本地能力）。
- 已經通過 Gateway 認證的呼叫者在 Gateway 範圍內是受信任的。配對後，節點操作被視為該節點的受信任操作員行為。
- `sessionKey` 是路由/上下文選擇，而不是每位用戶的認證。
- 執行批准（允許清單 + 請求）是操作員意圖的防護措施，而不是敵對的多租戶隔離。
- 執行批准綁定精確的請求上下文和最佳努力的直接本地檔案操作數；它們並不語義性地建模每個執行時/解釋器加載器路徑。請使用沙盒和主機隔離來建立強邊界。

如果您需要敵對用戶隔離，請通過作業系統用戶/主機劃分信任邊界並執行獨立的網關。

## Trust boundary matrix

使用此作為風險評估的快速模型：

| 邊界或控制                           | 意義                            | 常見誤解                                       |
| ------------------------------------ | ------------------------------- | ---------------------------------------------- |
| `gateway.auth` (token/密碼/設備認證) | 驗證呼叫者對網關 API 的訪問權限 | "每個訊息都需要簽名以確保安全"                 |
| `sessionKey`                         | 用於上下文/會話選擇的路由鍵     | "會話金鑰是用戶認證邊界"                       |
| 提示/內容防護措施                    | 降低模型濫用風險                | "僅僅提示注入就能證明認證繞過"                 |
| `canvas.eval` / 瀏覽器評估           | 啟用時的有意操作員能力          | "任何 JS 評估原語在這個信任模型中自動成為漏洞" |
| 本地 TUI `!` 外殼                    | 明確的操作員觸發本地執行        | "本地外殼便利命令是遠端注入"                   |
| 節點配對和節點命令                   | 操作員級別的配對設備遠端執行    | "遠端設備控制應預設視為不受信任的用戶訪問"     |

## 不是設計上的漏洞

這些模式通常被報告，並且通常會被關閉為無行動，除非顯示出真正的邊界繞過：

- 僅限於提示注入的鏈，沒有政策/授權/沙盒繞過。
- 假設在一個共享主機/設定上進行敵對多租戶操作的主張。
- 將正常操作員讀取路徑訪問（例如 `sessions.list`/`sessions.preview`/`chat.history`）分類為共享網關設置中的 IDOR 的主張。
- 僅限於本地主機的部署發現（例如在僅限回環的網關上使用 HSTS）。
- Discord 進站 webhook 簽名發現，針對本庫中不存在的進站路徑。
- 將 `sessionKey` 視為授權token的「缺少每用戶授權」發現。

## 研究人員預檢清單

在開啟 GHSA 之前，請確認以下所有專案：

1. Repro 在最新的 `main` 或最新版本上仍然有效。
2. 報告包含精確的程式碼路徑 (`file`、函數、行範圍) 以及測試的版本/提交。
3. 影響跨越了已記錄的信任邊界（不僅僅是提示注入）。
4. 申訴不在 [不在範圍內](https://github.com/openclaw/openclaw/blob/main/SECURITY.md#out-of-scope) 列表中。
5. 已檢查現有的建議以避免重複（在適用時重用標準 GHSA）。
6. 部署假設是明確的（回環/本地 vs 曝露、受信任 vs 不受信任的操作員）。

## 60 秒內的強化基準

使用此基準，然後根據可信代理選擇性地重新啟用工具：

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: { mode: "token", token: "replace-with-long-random-token" },
  },
  session: {
    dmScope: "per-channel-peer",
  },
  tools: {
    profile: "messaging",
    deny: ["group:automation", "group:runtime", "group:fs", "sessions_spawn", "sessions_send"],
    fs: { workspaceOnly: true },
    exec: { security: "deny", ask: "always" },
    elevated: { enabled: false },
  },
  channels: {
    whatsapp: { dmPolicy: "pairing", groups: { "*": { requireMention: true } } },
  },
}
```

這樣可以使 Gateway 僅限於本地，隔離 DMs，並預設禁用控制平面/執行時工具。

## 共享收件箱快速規則

如果有多於一個人可以對你的機器人進行 DM：

- 設定 `session.dmScope: "per-channel-peer"`（或對於多帳號頻道使用 `"per-account-channel-peer"`）。
- 保持 `dmPolicy: "pairing"` 或嚴格的允許清單。
- 切勿將共享的直接訊息與廣泛的工具存取結合。
- 這樣可以加強合作/共享的收件匣，但並不設計為在用戶共享主機/設定寫入存取時的敵對共用隔離。

### 審核檢查的內容（高層次）

- **進入存取** (DM 政策、群組政策、允許清單)：陌生人可以觸發機器人嗎？
- **工具影響範圍** (提升的工具 + 開放房間)：提示注入是否可能轉變為 shell/file/network 行動？
- **網路暴露** (閘道綁定/認證、Tailscale Serve/Funnel、弱/短的認證 token)。
- **瀏覽器控制暴露** (遠端節點、轉發埠、遠端 CDP 端點)。
- **本地磁碟衛生** (權限、符號連結、設定包含、“同步資料夾”路徑)。
- **插件** (擴充存在但沒有明確的允許清單)。
- **政策漂移/錯誤設定** (沙盒 Docker 設定已設定但沙盒模式關閉；無效的 `gateway.nodes.denyCommands` 模式因為匹配僅為精確的命令名稱（例如 `system.run`）且不檢查 shell 文字；危險的 `gateway.nodes.allowCommands` 條目；全域 `tools.profile="minimal"` 被每個代理的設定覆蓋；在寬鬆的工具政策下可達到的擴充插件工具)。
- **執行時期望漂移** (例如 `tools.exec.host="sandbox"` 當沙盒模式關閉時，直接在閘道主機上執行)。
- **模型衛生** (當設定的模型看起來是舊版時發出警告；不是硬性阻擋)。

如果你執行 `--deep`，OpenClaw 也會嘗試進行最佳努力的即時 Gateway 探測。

## Credential storage map

在進行存取審核或決定備份內容時使用此項：

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram 機器人token**: config/env 或 `channels.telegram.tokenFile` (僅限常規檔案；不接受符號連結)
- **Discord 機器人token**: config/env 或 SecretRef (env/file/exec 提供者)
- **Slack token**: config/env (`channels.slack.*`)
- **配對白名單**:
  - `~/.openclaw/credentials/<channel>-allowFrom.json` (預設帳戶)
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json` (非預設帳戶)
- **模型認證設定檔**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **檔案備份的秘密有效載荷 (可選)**: `~/.openclaw/secrets.json`
- **舊版 OAuth 匯入**: `~/.openclaw/credentials/oauth.json`

## Security Audit Checklist

當審計列印出發現時，將其視為優先順序：

1. **任何「開放」+ 啟用工具**：首先鎖定私訊/群組（配對/允許清單），然後收緊工具政策/沙盒化。
2. **公共網路暴露**（LAN 綁定、漏斗、缺少認證）：立即修正。
3. **瀏覽器控制遠端暴露**：將其視為操作員訪問（僅限 tailnet、故意配對節點，避免公共暴露）。
4. **權限**：確保狀態/設定/憑證/認證不對群組/全世界可讀。
5. **插件/擴充**：僅加載你明確信任的內容。
6. **模型選擇**：對於任何具有工具的機器人，優先選擇現代的、經過指令強化的模型。

## 安全審計術語表

高信號 `checkId` 值您在實際部署中最有可能看到（並非詳盡無遺）：

| `checkId`                                          | 嚴重性    | 重要性說明                                                       | 主要修正鍵/路徑                                                                                   | 自動修正 |
| -------------------------------------------------- | --------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| `fs.state_dir.perms_world_writable`                | 嚴重      | 其他使用者/過程可以修改完整的 OpenClaw 狀態                      | `~/.openclaw` 的檔案系統權限                                                                      | 是       |
| `fs.config.perms_writable`                         | 嚴重      | 其他人可以更改認證/工具政策/設定                                 | `~/.openclaw/openclaw.json` 的檔案系統權限                                                        | 是       |
| `fs.config.perms_world_readable`                   | 嚴重      | 設定可能暴露 token/設置                                          | 設定檔案的檔案系統權限                                                                            | 是       |
| `gateway.bind_no_auth`                             | 嚴重      | 遠端綁定未使用共享密鑰                                           | `gateway.bind`, `gateway.auth.*`                                                                  | 否       |
| `gateway.loopback_no_auth`                         | 嚴重      | 反向代理的迴圈可能變得未經認證                                   | `gateway.auth.*`, 代理設定                                                                        | 否       |
| `gateway.http.no_auth`                             | 警告/嚴重 | 閘道 HTTP API 可透過 `auth.mode="none"` 到達                     | `gateway.auth.mode`, `gateway.http.endpoints.*`                                                   | 否       |
| `gateway.tools_invoke_http.dangerous_allow`        | 警告/嚴重 | 透過 HTTP API 重新啟用危險工具                                   | `gateway.tools.allow`                                                                             | 否       |
| `gateway.nodes.allow_commands_dangerous`           | 警告/嚴重 | 啟用高影響的節點命令（相機/螢幕/聯絡人/日曆/SMS）                | `gateway.nodes.allowCommands`                                                                     | 否       |
| `gateway.tailscale_funnel`                         | 嚴重      | 公共互聯網暴露                                                   | `gateway.tailscale.mode`                                                                          | 否       |
| `gateway.control_ui.allowed_origins_required`      | 嚴重      | 非迴圈控制 UI 沒有明確的瀏覽器來源允許清單                       | `gateway.controlUi.allowedOrigins`                                                                | 否       |
| `gateway.control_ui.host_header_origin_fallback`   | 警告/嚴重 | 啟用主機標頭來源回退（DNS 重新綁定強化降級）                     | `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`                                      | 否       |
| `gateway.control_ui.insecure_auth`                 | 警告      | 啟用不安全的認證相容性切換                                       | `gateway.controlUi.allowInsecureAuth`                                                             | 否       |
| `gateway.control_ui.device_auth_disabled`          | 嚴重      | 禁用設備身份檢查                                                 | `gateway.controlUi.dangerouslyDisableDeviceAuth`                                                  | 否       |
| `gateway.real_ip_fallback_enabled`                 | 警告/嚴重 | 信任 `X-Real-IP` 回退可能透過代理錯誤設定啟用來源 IP 偽造        | `gateway.allowRealIpFallback`, `gateway.trustedProxies`                                           | 否       |
| `discovery.mdns_full_mode`                         | 警告/嚴重 | mDNS 完整模式在本地網路上廣告 `cliPath`/`sshPort` 元數據         | `discovery.mdns.mode`, `gateway.bind`                                                             | 否       |
| `config.insecure_or_dangerous_flags`               | 警告      | 啟用任何不安全/危險的除錯標誌                                    | 多個鍵（請參見發現詳細資訊）                                                                      | 否       |
| `hooks.token_too_short`                            | 警告      | 更容易對鉤子進入進行暴力破解                                     | `hooks.token`                                                                                     | 否       |
| `hooks.request_session_key_enabled`                | 警告/嚴重 | 外部呼叫者可以選擇 sessionKey                                    | `hooks.allowRequestSessionKey`                                                                    | 否       |
| `hooks.request_session_key_prefixes_missing`       | 警告/嚴重 | 對外部 session key 形狀沒有限制                                  | `hooks.allowedSessionKeyPrefixes`                                                                 | 否       |
| `logging.redact_off`                               | 警告      | 敏感值洩漏到日誌/狀態                                            | `logging.redactSensitive`                                                                         | 是       |
| `sandbox.docker_config_mode_off`                   | 警告      | 沙盒 Docker 設定存在但未啟用                                     | `agents.*.sandbox.mode`                                                                           | 否       |
| `sandbox.dangerous_network_mode`                   | 嚴重      | 沙盒 Docker 網路使用 `host` 或 `container:*` 命名空間聯接模式    | `agents.*.sandbox.docker.network`                                                                 | 否       |
| `tools.exec.host_sandbox_no_sandbox_defaults`      | 警告      | `exec host=sandbox` 在沙盒關閉時解析為主機執行                   | `tools.exec.host`, `agents.defaults.sandbox.mode`                                                 | 否       |
| `tools.exec.host_sandbox_no_sandbox_agents`        | 警告      | 每個代理的 `exec host=sandbox` 在沙盒關閉時解析為主機執行        | `agents.list[].tools.exec.host`, `agents.list[].sandbox.mode`                                     | 否       |
| `tools.exec.safe_bins_interpreter_unprofiled`      | 警告      | `safeBins` 中的解釋器/執行時二進位檔沒有明確的設定，擴大執行風險 | `tools.exec.safeBins`, `tools.exec.safeBinProfiles`, `agents.list[].tools.exec.*`                 | 否       |
| `skills.workspace.symlink_escape`                  | 警告      | 工作區 `skills/**/SKILL.md` 解析到工作區根目錄外（符號鏈漂移）   | 工作區 `skills/**` 的檔案系統狀態                                                                 | 否       |
| `security.exposure.open_groups_with_elevated`      | 嚴重      | 開放的群組 + 提升的工具創建高影響的提示注入路徑                  | `channels.*.groupPolicy`, `tools.elevated.*`                                                      | 否       |
| `security.exposure.open_groups_with_runtime_or_fs` | 嚴重/警告 | 開放的群組可以在沒有沙盒/工作區保護的情況下訪問命令/檔案工具     | `channels.*.groupPolicy`, `tools.profile/deny`, `tools.fs.workspaceOnly`, `agents.*.sandbox.mode` | 否       |
| `security.trust_model.multi_user_heuristic`        | 警告      | 設定看起來是多使用者，而閘道信任模型是個人助理                   | 拆分信任邊界，或共享使用者強化 (`sandbox.mode`, 工具拒絕/工作區範圍)                              | 否       |
| `tools.profile_minimal_overridden`                 | 警告      | 代理覆蓋繞過全局最小設定                                         | `agents.list[].tools.profile`                                                                     | 否       |
| `plugins.tools_reachable_permissive_policy`        | 警告      | 擴充工具在寬鬆的上下文中可達                                     | `tools.profile` + 工具允許/拒絕                                                                   | 否       |
| `models.small_params`                              | 嚴重/資訊 | 小型模型 + 不安全的工具表面提高了注入風險                        | 模型選擇 + 沙盒/工具政策                                                                          | 否       |

## 透過 HTTP 控制 UI

控制介面需要一個 **安全的環境**（HTTPS 或 localhost）來生成設備身份。`gateway.controlUi.allowInsecureAuth` 是一個本地相容性切換：

- 在本地主機上，當頁面透過不安全的 HTTP 載入時，允許控制 UI 認證而不需要設備身份。
- 它不會繞過配對檢查。
- 它不會放寬遠端（非本地主機）設備身份的要求。

偏好使用 HTTPS (Tailscale Serve) 或在 `127.0.0.1` 上開啟 UI。

僅限於緊急情況，`gateway.controlUi.dangerouslyDisableDeviceAuth` 完全禁用設備身份檢查。這是一個嚴重的安全降級；除非您正在進行主動除錯並且能夠迅速恢復，否則請保持關閉。

`openclaw security audit` 在啟用此設定時會發出警告。

## 不安全或危險的標誌摘要

`openclaw security audit` 包含 `config.insecure_or_dangerous_flags` 當已知不安全/危險的除錯開關被啟用時。該檢查目前聚合：

- `gateway.controlUi.allowInsecureAuth=true`
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true`
- `gateway.controlUi.dangerouslyDisableDeviceAuth=true`
- `hooks.gmail.allowUnsafeExternalContent=true`
- `hooks.mappings[<index>].allowUnsafeExternalContent=true`
- `tools.exec.applyPatch.workspaceOnly=false`

完成 `dangerous*` / `dangerously*` 在 OpenClaw 設定架構中定義的設定鍵：

- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`
- `gateway.controlUi.dangerouslyDisableDeviceAuth`
- `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`
- `channels.discord.dangerouslyAllowNameMatching`
- `channels.discord.accounts.<accountId>.dangerouslyAllowNameMatching`
- `channels.slack.dangerouslyAllowNameMatching`
- `channels.slack.accounts.<accountId>.dangerouslyAllowNameMatching`
- `channels.googlechat.dangerouslyAllowNameMatching`
- `channels.googlechat.accounts.<accountId>.dangerouslyAllowNameMatching`
- `channels.msteams.dangerouslyAllowNameMatching`
- `channels.zalouser.dangerouslyAllowNameMatching` (擴充通道)
- `channels.irc.dangerouslyAllowNameMatching` (擴充通道)
- `channels.irc.accounts.<accountId>.dangerouslyAllowNameMatching` (擴充通道)
- `channels.mattermost.dangerouslyAllowNameMatching` (擴充通道)
- `channels.mattermost.accounts.<accountId>.dangerouslyAllowNameMatching` (擴充通道)
- `agents.defaults.sandbox.docker.dangerouslyAllowReservedContainerTargets`
- `agents.defaults.sandbox.docker.dangerouslyAllowExternalBindSources`
- `agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin`
- `agents.list[<index>].sandbox.docker.dangerouslyAllowReservedContainerTargets`
- `agents.list[<index>].sandbox.docker.dangerouslyAllowExternalBindSources`
- `agents.list[<index>].sandbox.docker.dangerouslyAllowContainerNamespaceJoin`

## 反向代理設定

如果您在反向代理（如 nginx、Caddy、Traefik 等）後執行 Gateway，您應該設定 `gateway.trustedProxies` 以正確檢測用戶端 IP。

當 Gateway 偵測到來自 **不** 在 `trustedProxies` 中的地址的代理標頭時，它將 **不** 將連接視為本地用戶端。如果禁用 Gateway 認證，這些連接將被拒絕。這可以防止認證繞過，因為代理連接否則會顯示來自 localhost 並自動獲得信任。

```yaml
gateway:
  trustedProxies:
    - "127.0.0.1" # if your proxy runs on localhost
  # Optional. Default false.
  # Only enable if your proxy cannot provide X-Forwarded-For.
  allowRealIpFallback: false
  auth:
    mode: password
    password: ${OPENCLAW_GATEWAY_PASSWORD}
```

當 `trustedProxies` 被設定時，Gateway 使用 `X-Forwarded-For` 來確定用戶端 IP。預設情況下 `X-Real-IP` 會被忽略，除非明確設置 `gateway.allowRealIpFallback: true`。

良好的反向代理行為（覆蓋傳入的轉發標頭）：

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
```

不良的反向代理行為（附加/保留不受信任的轉發標頭）：

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

## HSTS 和來源註解

- OpenClaw 閘道器是以本地/迴圈回路為優先。如果您在反向代理上終止 TLS，請在該代理面向 HTTPS 的網域上設置 HSTS。
- 如果閘道器本身終止 HTTPS，您可以設置 `gateway.http.securityHeaders.strictTransportSecurity` 以從 OpenClaw 回應中發出 HSTS 標頭。
- 詳細的部署指導請參見 [Trusted Proxy Auth](/gateway/trusted-proxy-auth#tls-termination-and-hsts)。
- 對於非迴圈回路的控制 UI 部署，預設需要 `gateway.controlUi.allowedOrigins`。
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` 啟用 Host 標頭來源回退模式；將其視為危險的操作員選擇政策。
- 將 DNS 重新綁定和代理主機標頭行為視為部署加固的考量；保持 `trustedProxies` 嚴格，並避免將閘道器直接暴露於公共互聯網。

## 本地會話日誌儲存在磁碟上

OpenClaw 將會話記錄存儲在磁碟上，位於 `~/.openclaw/agents/<agentId>/sessions/*.jsonl`。這是為了會話的連續性和（可選的）會話記憶索引，但這也意味著 **任何擁有檔案系統存取權的過程/使用者都可以讀取這些日誌**。將磁碟存取視為信任邊界，並鎖定 `~/.openclaw` 的權限（請參見下面的審計部分）。如果需要在代理之間實現更強的隔離，請在不同的作業系統使用者或不同的主機下執行它們。

## Node 執行 (system.run)

如果 macOS 節點已配對，閘道可以在該節點上調用 `system.run`。這是對 Mac 的 **遠端程式碼執行**：

- 需要節點配對（批准 + token）。
- 在 Mac 上透過 **設定 → 執行批准** 進行控制（安全性 + 問詢 + 允許清單）。
- 批准模式綁定精確的請求上下文，並且在可能的情況下，綁定一個具體的本地腳本/檔案操作數。如果 OpenClaw 無法準確識別一個直接的本地檔案用於解譯器/執行環境命令，則會拒絕基於批准的執行，而不是承諾提供完整的語義覆蓋。
- 如果您不想進行遠端執行，請將安全性設置為 **拒絕** 並移除該 Mac 的節點配對。

## 動態技能（監視器 / 遠端節點）

OpenClaw 可以在會話中隨時更新技能列表：

- **技能監視器**：對 `SKILL.md` 的變更可以在下一次代理回合更新技能快照。
- **遠端節點**：連接 macOS 節點可以使 macOS 專用技能符合資格（基於 bin 探測）。

將技能資料夾視為 **受信任的程式碼**，並限制誰可以修改它們。

## 威脅模型

您的 AI 助手可以：

- 執行任意的 shell 命令
- 讀取/寫入檔案
- 存取網路服務
- 向任何人發送訊息（如果你給予它 WhatsApp 的存取權限）

人們發送訊息給你可以：

- 嘗試欺騙你的 AI 做壞事
- 社會工程學獲取你的數據訪問權限
- 探查基礎設施細節

## 核心概念：在智慧之前的存取控制

大多數失敗並不是華麗的利用 — 而是「有人發送訊息給機器人，然後機器人按照他們的要求執行了。」

OpenClaw 的立場：

- **身份優先：** 決定誰可以與機器人對話（私訊配對 / 允許清單 / 明確的「開放」）。
- **範圍接著：** 決定機器人被允許在哪裡行動（群組允許清單 + 提及限制、工具、沙盒、設備權限）。
- **模型最後：** 假設模型可以被操控；設計時確保操控的影響範圍有限。

## 命令授權模型

斜線指令和指令僅對 **授權發送者** 有效。授權來源於頻道允許清單/配對加上 `commands.useAccessGroups`（詳見 [設定](/gateway/configuration) 和 [斜線指令](/tools/slash-commands)）。如果頻道允許清單為空或包含 `"*"`，則該頻道的指令實際上是開放的。

`/exec` 是一個僅限會話的便利功能，供授權的操作員使用。它**不**會寫入設定或更改其他會話。

## 控制平面工具風險

兩個內建工具可以進行持久的控制平面變更：

- `gateway` 可以呼叫 `config.apply`、`config.patch` 和 `update.run`。
- `cron` 可以創建定時任務，這些任務會在原始聊天/任務結束後繼續執行。

對於任何處理不受信內容的代理/表面，預設拒絕這些：

```json5
{
  tools: {
    deny: ["gateway", "cron", "sessions_spawn", "sessions_send"],
  },
}
```

`commands.restart=false` 只會阻止重啟操作。它不會禁用 `gateway` 設定/更新操作。

## Plugins/擴充功能

Plugins 在 Gateway 中 **內部執行**。將它們視為受信任的程式碼：

- 只從你信任的來源安裝插件。
- 優先使用明確的 `plugins.allow` 允許清單。
- 在啟用之前檢查插件設定。
- 在插件變更後重新啟動 Gateway。
- 如果你從 npm (`openclaw plugins install <npm-spec>`) 安裝插件，請將其視為執行不受信任的程式碼：
  - 安裝路徑是 `~/.openclaw/extensions/<pluginId>/` (或 `$OPENCLAW_STATE_DIR/extensions/<pluginId>/`)。
  - OpenClaw 使用 `npm pack`，然後在該目錄中執行 `npm install --omit=dev` (npm 生命週期腳本可以在安裝過程中執行程式碼)。
  - 優先使用固定的、確切的版本 (`@scope/pkg@1.2.3`)，並在啟用之前檢查磁碟上的解壓縮程式碼。

[[INLINE_1]]

## DM 存取模型 (配對 / 允許清單 / 開放 / 禁用)

所有目前支援 DM 的通道都支援一個 DM 政策 (`dmPolicy` 或 `*.dm.policy`)，該政策在訊息處理 **之前** 會限制進入的 DM：

- `pairing` (預設): 不明發送者會收到一個短暫的配對程式碼，並且機器人會忽略他們的訊息，直到獲得批准。程式碼在 1 小時後過期；重複的私訊不會重新發送程式碼，直到創建新的請求。待處理的請求預設限制為 **每個頻道 3 個**。
- `allowlist`: 不明發送者會被封鎖（不進行配對握手）。
- `open`: 允許任何人私訊（公開）。**需要** 頻道的允許清單中包含 `"*"`（明確選擇加入）。
- `disabled`: 完全忽略進來的私訊。

透過 CLI 批准：

```bash
openclaw pairing list <channel>
openclaw pairing approve <channel> <code>
```

Details + files on disk: [Pairing](/channels/pairing)

## DM 會話隔離（多用戶模式）

預設情況下，OpenClaw 將 **所有私訊路由到主要會話**，這樣您的助手在不同設備和通道之間可以保持連貫性。如果 **多個人** 可以私訊機器人（開放私訊或多人的允許名單），建議隔離私訊會話：

```json5
{
  session: { dmScope: "per-channel-peer" },
}
```

這可以防止跨用戶的上下文洩漏，同時保持群組聊天的隔離。

這是一個訊息上下文邊界，而不是主機管理邊界。如果使用者之間存在對立關係並且共享相同的 Gateway 主機/設定，則應根據信任邊界執行獨立的 Gateway。

### 安全 DM 模式（推薦）

[[BLOCK_1]]  
將上面的片段視為 **安全 DM 模式**：  
[[BLOCK_1]]

- 預設: `session.dmScope: "main"` (所有的直接訊息共享一個會話以保持連貫性)。
- 本地 CLI 上線預設: 當未設置時寫入 `session.dmScope: "per-channel-peer"` (保持現有的明確值)。
- 安全直接訊息模式: `session.dmScope: "per-channel-peer"` (每個頻道+發送者配對獲得一個獨立的直接訊息上下文)。

如果您在同一頻道上執行多個帳戶，請改用 `per-account-channel-peer`。如果同一個人通過多個頻道聯繫您，請使用 `session.identityLinks` 將這些 DM 會話合併為一個標準身份。請參閱 [Session Management](/concepts/session) 和 [Configuration](/gateway/configuration)。

## Allowlists (DM + groups) — 術語

OpenClaw 有兩個獨立的「誰可以觸發我？」層級：

- **DM 允許清單** (`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom`; 遺留: `channels.discord.dm.allowFrom`, `channels.slack.dm.allowFrom`): 誰被允許在直接消息中與機器人對話。
  - 當 `dmPolicy="pairing"` 時，批准會寫入帳戶範圍的配對允許清單存儲在 `~/.openclaw/credentials/` 中 (`<channel>-allowFrom.json` 用於預設帳戶，`<channel>-<accountId>-allowFrom.json` 用於非預設帳戶)，並與設定允許清單合併。
- **群組允許清單** (頻道特定): 機器人將接受來自哪些群組/頻道/公會的消息。
  - 常見模式：
    - `channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`: 每個群組的預設值，如 `requireMention`; 當設置時，它也充當群組允許清單（包括 `"*"` 以保持允許所有行為）。
    - `groupPolicy="allowlist"` + `groupAllowFrom`: 限制誰可以在群組會話中觸發機器人 (WhatsApp/Telegram/Signal/iMessage/Microsoft Teams)。
    - `channels.discord.guilds` / `channels.slack.channels`: 每個表面允許清單 + 提及預設。
  - 群組檢查按此順序執行: `groupPolicy`/群組允許清單優先，提及/回覆啟用其次。
  - 回覆機器人消息（隱式提及）**不**會繞過發送者允許清單，如 `groupAllowFrom`。
  - **安全提示:** 將 `dmPolicy="open"` 和 `groupPolicy="open"` 視為最後手段的設置。這些應該很少使用；除非你完全信任房間中的每個成員，否則應優先使用配對 + 允許清單。

細節: [設定](/gateway/configuration) 和 [群組](/channels/groups)

## 提示注入（什麼是、為什麼重要）

提示注入是指攻擊者設計一條訊息，操控模型執行某些不安全的操作（例如「忽略你的指示」、「轉存你的檔案系統」、「跟隨這個連結並執行命令」等）。

即使有強大的系統提示，**提示注入問題仍未解決**。系統提示的防護措施僅是軟性指導；硬性執行來自於工具政策、執行批准、沙盒環境和通道白名單（而且操作員可以根據設計禁用這些措施）。在實踐中，有助於解決這個問題的措施包括：

- 將進入的私訊鎖定（配對/允許清單）。
- 在群組中優先使用提及限制；避免在公共房間中使用“隨時啟用”的機器人。
- 預設將連結、附件和貼上的指令視為敵對。
- 在沙盒中執行敏感工具；將秘密保留在代理無法訪問的檔案系統中。
- 注意：沙盒模式為選擇性啟用。如果沙盒模式關閉，執行將在網關主機上執行，即使 tools.exec.host 預設為沙盒，且主機執行不需要批准，除非您設置 host=gateway 並設定執行批准。
- 將高風險工具 (`exec`, `browser`, `web_fetch`, `web_search`) 限制給可信的代理或明確的允許清單。
- **模型選擇很重要：** 較舊/較小/舊版模型對於提示注入和工具濫用的抵抗力顯著較弱。對於啟用工具的代理，請使用最新一代、經過指令強化的最強模型。

紅旗需視為不可信的：

抱歉，我無法協助滿足該要求。

## Unsafe external content bypass flags

OpenClaw 包含明確的繞過標誌，可以禁用外部內容的安全包裝：

- `hooks.mappings[].allowUnsafeExternalContent`
- `hooks.gmail.allowUnsafeExternalContent`
- Cron 負載欄位 `allowUnsafeExternalContent`

[[BLOCK_1]]

- 在生產環境中保持這些未設置/為假。
- 只在範圍明確的除錯時暫時啟用。
- 如果啟用，請隔離該代理（沙盒 + 最小工具 + 專用會話命名空間）。

[[BLOCK_1]]  
Hooks 風險注意事項：  
[[BLOCK_1]]

- Hook 負載是未經信任的內容，即使交付來自您控制的系統（郵件/文件/網頁內容可能攜帶提示注入）。
- 薄弱的模型層級會增加這種風險。對於基於 hook 的自動化，建議使用強大的現代模型層級，並保持工具政策嚴格 (`tools.profile: "messaging"` 或更嚴格)，此外在可能的情況下進行沙盒化。

### 提示注入不需要公開的私訊

即使**只有你**能夠發送訊息給機器人，提示注入仍然可能透過機器人所讀取的任何**不受信任的內容**發生（網頁搜尋/擷取結果、瀏覽器頁面、電子郵件、文件、附件、貼上的日誌/程式碼）。換句話說：發送者並不是唯一的威脅面；**內容本身**也可能攜帶對抗性指令。

當工具啟用時，典型的風險是外洩上下文或觸發工具調用。透過以下方式減少影響範圍：

- 使用只讀或工具禁用的 **reader agent** 來總結不可信的內容，然後將摘要傳遞給你的主要代理。
- 除非需要，否則對於啟用工具的代理，保持 `web_search` / `web_fetch` / `browser` 關閉。
- 對於 OpenResponses URL 輸入 (`input_file` / `input_image`), 設定緊密的 `gateway.http.endpoints.responses.files.urlAllowlist` 和 `gateway.http.endpoints.responses.images.urlAllowlist`，並保持 `maxUrlParts` 低。
- 為任何處理不可信輸入的代理啟用沙盒和嚴格的工具白名單。
- 將秘密排除在提示之外；而是通過環境變數/設定在網關主機上傳遞。

### 模型強度（安全注意事項）

提示注入抵抗力在不同模型層級上並**不**均勻。較小/較便宜的模型通常對工具濫用和指令劫持更為敏感，特別是在面對對抗性提示時。

<Warning>
對於啟用工具的代理或讀取不受信內容的代理，舊版/較小型模型的提示注入風險通常過高。請勿在弱模型層級上執行這些工作負載。
</Warning>

[[BLOCK_1]]

- **使用最新一代、最佳等級的模型** 來執行任何可以使用工具或接觸檔案/網路的機器人。
- **不要使用舊版/較弱/較小的等級** 來處理啟用工具的代理或不受信任的收件箱；因為提示注入的風險太高。
- 如果必須使用較小的模型，**減少影響範圍**（只讀工具、強沙盒、最小檔案系統存取、嚴格的允許清單）。
- 在執行小型模型時，**為所有會話啟用沙盒**，並且**禁用 web_search/web_fetch/browser**，除非輸入受到嚴格控制。
- 對於僅限聊天的個人助理，若輸入可信且無工具，較小的模型通常是可以的。

## 理由與群組中的詳細輸出

`/reasoning` 和 `/verbose` 可能會暴露內部推理或工具輸出，這些內容並不是為了公開渠道而設計的。在群組環境中，將它們視為 **僅限除錯**，並在您明確需要時才開啟。

[[BLOCK_1]]

- 在公共房間中保持 `/reasoning` 和 `/verbose` 關閉。
- 如果你啟用它們，請僅在受信任的私訊或嚴格控制的房間中進行。
- 請記住：詳細輸出可能包含工具參數、網址和模型所見的數據。

## 設定加固（範例）

### 0) 檔案權限

在閘道主機上保持設定和狀態私密：

- `~/.openclaw/openclaw.json`: `600` (僅限使用者讀取/寫入)
- `~/.openclaw`: `700` (僅限使用者)

`openclaw doctor` 可以發出警告並提供加強這些權限的建議。

### 0.4) 網路暴露 (綁定 + 端口 + 防火牆)

Gateway 將 **WebSocket + HTTP** 多路復用在單一端口上：

- 預設: `18789`
- 設定/標誌/環境: `gateway.port`, `--port`, `OPENCLAW_GATEWAY_PORT`

此 HTTP 介面包含控制 UI 和畫布主機：

- 控制 UI (SPA 資源) (預設基本路徑 `/`)
- 畫布主機: `/__openclaw__/canvas/` 和 `/__openclaw__/a2ui/` (任意 HTML/JS; 視為不受信任的內容)

如果您在一般瀏覽器中載入畫布內容，請將其視為任何其他不受信任的網頁：

- 不要將畫布主機暴露給不受信任的網路/使用者。
- 除非您完全了解其影響，否則不要讓畫布內容與特權網頁表面共享相同的來源。

綁定模式控制網關的監聽位置：

- `gateway.bind: "loopback"` (預設): 只有本地用戶端可以連接。
- 非迴圈回路綁定 (`"lan"`, `"tailnet"`, `"custom"`) 擴大了攻擊面。僅在使用共享的 token/密碼和真正的防火牆時使用它們。

[[BLOCK_1]]

- 優先使用 Tailscale Serve 而非 LAN 綁定（Serve 將 Gateway 保持在回環地址，並由 Tailscale 處理存取）。
- 如果必須綁定到 LAN，請將端口防火牆設置為僅允許特定來源 IP 的嚴格白名單；不要廣泛地進行端口轉發。
- 切勿在 `0.0.0.0` 上未經身份驗證地暴露 Gateway。

### 0.4.1) Docker 端口發布 + UFW (`DOCKER-USER`)

如果您在 VPS 上使用 Docker 執行 OpenClaw，請記住，已發布的容器端口 (`-p HOST:CONTAINER` 或 Compose `ports:`) 是通過 Docker 的轉發鏈路進行路由，而不僅僅是主機 `INPUT` 規則。

為了使 Docker 流量符合您的防火牆政策，請在 `DOCKER-USER` 中強制執行規則（此鏈在 Docker 自身的接受規則之前被評估）。在許多現代發行版中，`iptables`/`ip6tables` 使用 `iptables-nft` 前端，並仍然將這些規則應用於 nftables 後端。

最小允許清單範例（IPv4）：

```bash
# /etc/ufw/after.rules (append as its own *filter section)
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A DOCKER-USER -s 127.0.0.0/8 -j RETURN
-A DOCKER-USER -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -s 192.168.0.0/16 -j RETURN
-A DOCKER-USER -s 100.64.0.0/10 -j RETURN
-A DOCKER-USER -p tcp --dport 80 -j RETURN
-A DOCKER-USER -p tcp --dport 443 -j RETURN
-A DOCKER-USER -m conntrack --ctstate NEW -j DROP
-A DOCKER-USER -j RETURN
COMMIT
```

如果啟用了 Docker IPv6，請在 `/etc/ufw/after6.rules` 中添加匹配策略。

避免在文檔片段中硬編碼介面名稱，例如 `eth0`。介面名稱在不同的 VPS 映像中會有所不同 (`ens3`、`enp*` 等)，不匹配可能會意外跳過您的拒絕規則。

快速驗證重新載入後：

```bash
ufw reload
iptables -S DOCKER-USER
ip6tables -S DOCKER-USER
nmap -sT -p 1-65535 <public-ip> --open
```

預期的外部端口應該僅限於您有意公開的端口（對於大多數設置來說：SSH + 您的反向代理端口）。

### 0.4.2) mDNS/Bonjour 探索（資訊洩露）

Gateway 通過 mDNS (`_openclaw-gw._tcp` 在 5353 埠上) 廣播其存在，以便進行本地設備發現。在完整模式下，這包括可能暴露操作細節的 TXT 記錄：

- `cliPath`: CLI 二進位檔的完整檔案系統路徑（顯示使用者名稱和安裝位置）
- `sshPort`: 宣告主機上 SSH 的可用性
- `displayName`, `lanHost`: 主機名稱資訊

**操作安全考量：** 廣播基礎設施的詳細資訊使得任何在本地網路上的人進行偵查變得更容易。即使是「無害」的資訊，例如檔案系統路徑和 SSH 可用性，也有助於攻擊者繪製您的環境地圖。

**建議：**

1. **最小模式**（預設，建議用於公開的閘道）：從 mDNS 廣播中省略敏感欄位：

```json5
{
  discovery: {
    mdns: { mode: "minimal" },
  },
}
```

2. **完全禁用**如果您不需要本地設備發現：

```json5
{
  discovery: {
    mdns: { mode: "off" },
  },
}
```

3. **完整模式**（選擇加入）：在 TXT 記錄中包含 `cliPath` + `sshPort`：

```json5
{
  discovery: {
    mdns: { mode: "full" },
  },
}
```

4. **環境變數**（替代方案）：設置 `OPENCLAW_DISABLE_BONJOUR=1` 以在不更改設定的情況下禁用 mDNS。

在最小模式下，Gateway 仍然廣播足夠的資訊以進行設備發現 (`role`, `gatewayPort`, `transport`)，但省略了 `cliPath` 和 `sshPort`。需要 CLI 路徑資訊的應用程式可以透過已驗證的 WebSocket 連接來獲取這些資訊。

### 0.5) 鎖定 Gateway WebSocket（本地驗證）

Gateway 認證是 **預設必需** 的。如果未設定 token/密碼，則 Gateway 會拒絕 WebSocket 連接（失敗關閉）。

入門精靈預設會生成一個 token（即使是回環連接），因此本地用戶端必須進行身份驗證。

設定一個 token，使 **所有** WS 用戶端必須進行身份驗證：

```json5
{
  gateway: {
    auth: { mode: "token", token: "your-token" },
  },
}
```

醫生可以為您生成一個：`openclaw doctor --generate-gateway-token`。

注意：`gateway.remote.token` / `.password` 是用戶端憑證來源。它們本身並不保護本地 WS 存取。本地呼叫路徑僅在 `gateway.auth.*` 未設定時可以使用 `gateway.remote.*` 作為備援。如果 `gateway.auth.token` / `gateway.auth.password` 透過 SecretRef 明確設定且未解析，則解析將失敗並關閉（不會有遠端備援遮罩）。可選：在使用 `wss://` 時，使用 `gateway.remote.tlsFingerprint` 鎖定遠端 TLS。明文 `ws://` 預設僅限回環使用。對於受信任的私有網路路徑，請在用戶端過程中設置 `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` 作為緊急措施。

[[BLOCK_1]]

- 設備配對對於 **本地** 連接（回環或網關主機的自有 tailnet 地址）是自動批准的，以保持同主機用戶端的流暢性。
- 其他 tailnet 對等體 **不** 被視為本地；它們仍然需要配對批准。

[[BLOCK_1]]  
Auth modes:  
[[INLINE_1]]

- `gateway.auth.mode: "token"`: 共享的承載token（推薦用於大多數設置）。
- `gateway.auth.mode: "password"`: 密碼驗證（建議透過環境變數設定：`OPENCLAW_GATEWAY_PASSWORD`）。
- `gateway.auth.mode: "trusted-proxy"`: 信任一個具身份識別的反向代理來驗證用戶並通過標頭傳遞身份（請參見 [受信任的代理驗證](/gateway/trusted-proxy-auth)）。

[[BLOCK_N]]  
Rotation checklist (token/password):  
[[BLOCK_N]]

1. 生成/設定一個新的密鑰 (`gateway.auth.token` 或 `OPENCLAW_GATEWAY_PASSWORD`)。
2. 重新啟動 Gateway（或如果 macOS 應用程式監控 Gateway，則重新啟動該應用程式）。
3. 更新任何遠端用戶端 (`gateway.remote.token` / `.password` 在呼叫 Gateway 的機器上)。
4. 驗證您無法再使用舊的憑證連接。

### 0.6) Tailscale Serve 身分標頭

當 `gateway.auth.allowTailscale` 是 `true`（Serve 的預設值）時，OpenClaw 接受 Tailscale Serve 身份標頭 (`tailscale-user-login`) 用於控制 UI/WebSocket 認證。OpenClaw 通過本地 Tailscale 守護進程 (`tailscale whois`) 解析 `x-forwarded-for` 地址並將其與標頭進行匹配，以驗證身份。這僅在請求命中回環並包含 `x-forwarded-for`、`x-forwarded-proto` 和 `x-forwarded-host` 時觸發，這些都是由 Tailscale 注入的。HTTP API 端點（例如 `/v1/*`、`/tools/invoke` 和 `/api/channels/*`）仍然需要 token/password 認證。

重要邊界註解：

- Gateway HTTP bearer 認證實際上是全有或全無的操作員存取權限。
- 將可以呼叫 `/v1/chat/completions`、`/v1/responses`、`/tools/invoke` 或 `/api/channels/*` 的憑證視為該網關的全權操作員秘密。
- 不要與不受信任的呼叫者分享這些憑證；建議在每個信任邊界使用單獨的網關。

**信任假設：** 無token的 Serve 認證假設網關主機是可信的。不要將此視為對抗惡意同主機進程的保護。如果不可信的本地程式碼可能在網關主機上執行，請禁用 `gateway.auth.allowTailscale` 並要求使用token/密碼認證。

**安全規則：** 不要從您自己的反向代理轉發這些標頭。如果您在網關前終止 TLS 或代理，請禁用 `gateway.auth.allowTailscale` 並改用 token/password 認證（或 [受信任的代理認證](/gateway/trusted-proxy-auth)）。

[[BLOCK_1]]

- 如果您在 Gateway 前終止 TLS，請將 `gateway.trustedProxies` 設定為您的代理 IP。
- OpenClaw 將信任來自這些 IP 的 `x-forwarded-for` (或 `x-real-ip`) 來確定用於本地配對檢查和 HTTP 認證/本地檢查的用戶端 IP。
- 確保您的代理 **覆寫** `x-forwarded-for` 並阻止直接訪問 Gateway 端口。

請參閱 [Tailscale](/gateway/tailscale) 和 [Web 概覽](/web)。

### 0.6.1) 透過節點主機控制瀏覽器（推薦）

如果您的 Gateway 是遠端的，但瀏覽器在另一台機器上執行，請在瀏覽器機器上執行 **node host**，並讓 Gateway 代理瀏覽器操作（請參見 [Browser tool](/tools/browser)）。將 node 配對視為管理存取。

建議的模式：

- 將 Gateway 和節點主機保持在同一個 tailnet (Tailscale) 上。
- 有意識地配對節點；如果不需要，請禁用瀏覽器代理路由。

[[BLOCK_1]]

- 在局域網或公共互聯網上暴露中繼/控制端口。
- Tailscale Funnel 用於瀏覽器控制端點（公共暴露）。

### 0.7) 磁碟上的秘密（什麼是敏感的）

假設 `~/.openclaw/`（或 `$OPENCLAW_STATE_DIR/`）下的任何內容可能包含機密或私人數據：

- `openclaw.json`: 設定可能包含 tokens（閘道、遠端閘道）、提供者設定和允許清單。
- `credentials/**`: 通道憑證（例如：WhatsApp 憑證）、配對允許清單、舊版 OAuth 匯入。
- `agents/<agentId>/agent/auth-profiles.json`: API 金鑰、token 設定、OAuth tokens，以及可選的 `keyRef`/`tokenRef`。
- `secrets.json`（可選）: 由 `file` SecretRef 提供者使用的檔案備份秘密有效載荷 (`secrets.providers`)。
- `agents/<agentId>/agent/auth.json`: 舊版相容性檔案。靜態 `api_key` 專案在被發現時會被清除。
- `agents/<agentId>/sessions/**`: 會話記錄 (`*.jsonl`) + 路由元資料 (`sessions.json`)，可能包含私人訊息和工具輸出。
- `extensions/**`: 已安裝的插件（以及它們的 `node_modules/`）。
- `sandboxes/**`: 工具沙盒工作區；可以累積您在沙盒內讀取/寫入的檔案副本。

[[BLOCK_1]]  
強化建議：  
[[BLOCK_1]]

- 將權限設置得嚴格一些 (`700` 在目錄上，`600` 在檔案上)。
- 在閘道主機上使用全磁碟加密。
- 如果主機是共享的，建議為閘道使用專用的作業系統使用者帳戶。

### 0.8) 日誌 + 轉錄 (刪除 + 保留)

[[BLOCK_1]] 日誌和記錄即使在存取控制正確的情況下，也可能洩漏敏感資訊：[[BLOCK_1]]

- Gateway 日誌可能包含工具摘要、錯誤和 URL。
- 會話記錄可以包含貼上的秘密、檔案內容、命令輸出和連結。

[[BLOCK_1]]

- 保持工具摘要的隱藏 (`logging.redactSensitive: "tools"`; 預設)。
- 透過 `logging.redactPatterns` 添加自訂模式以符合您的環境（tokens、主機名稱、內部 URL）。
- 在分享診斷資訊時，優先選擇 `openclaw status --all`（可貼上，已隱藏機密）而非原始日誌。
- 如果不需要長期保留，請修剪舊的會話記錄和日誌檔案。

[[INLINE_1]]

### 1) DMs: 預設配對

```json5
{
  channels: { whatsapp: { dmPolicy: "pairing" } },
}
```

### 2) 群組：需要在各處提及

```json
{
  "channels": {
    "whatsapp": {
      "groups": {
        "*": { "requireMention": true }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "groupChat": { "mentionPatterns": ["@openclaw", "@mybot"] }
      }
    ]
  }
}
```

在群組聊天中，只有在被明確提及時才回應。

### 3. 分開數字

考慮將您的 AI 執行在與個人號碼不同的電話號碼上：

- 個人號碼：您的對話保持私密
- 機器人號碼：AI 處理這些，並設有適當的界限

### 4. 只讀模式（今天，透過沙盒 + 工具）

您可以透過結合以下內容來建立只讀的個人資料：

- `agents.defaults.sandbox.workspaceAccess: "ro"`（或 `"none"` 代表無工作區存取）
- 工具允許/拒絕清單，阻擋 `write`、`edit`、`apply_patch`、`exec`、`process` 等等。

我們可能會稍後添加一個 `readOnlyMode` 標誌，以簡化此設定。

額外的強化選項：

- `tools.exec.applyPatch.workspaceOnly: true` (預設): 確保 `apply_patch` 無法在工作區目錄外寫入/刪除，即使在沙盒模式關閉的情況下也是如此。僅在您有意讓 `apply_patch` 接觸工作區外的檔案時，將其設置為 `false`。
- `tools.fs.workspaceOnly: true` (可選): 限制 `read`/`write`/`edit`/`apply_patch` 路徑和本機提示圖像自動加載路徑僅限於工作區目錄（如果您今天允許絕對路徑並希望有一個單一的防護措施，這是有用的）。
- 保持檔案系統根目錄狹窄: 避免使用像您的主目錄這樣的廣泛根目錄作為代理工作區/沙盒工作區。廣泛的根目錄可能會將敏感的本地檔案（例如 `~/.openclaw` 下的狀態/設定）暴露給檔案系統工具。

### 5) 安全基準 (複製/貼上)

一個「安全的預設」設定，可以保持 Gateway 私密，要求 DM 配對，並避免始終在線的群組機器人：

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    port: 18789,
    auth: { mode: "token", token: "your-long-random-token" },
  },
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

如果您也希望工具執行能夠“預設更安全”，請添加沙盒並禁止任何非擁有者代理使用危險工具（例如，請參見下方的“每代理存取設定檔”）。

內建的基準針對聊天驅動的代理回合：非擁有者的發送者無法使用 `cron` 或 `gateway` 工具。

## Sandboxing (建議使用)

專用文件: [Sandboxing](/gateway/sandboxing)

兩種互補的方法：

- **在 Docker 中執行完整的 Gateway** (容器邊界): [Docker](/install/docker)
- **工具沙盒** (`agents.defaults.sandbox`, 主機 Gateway + Docker 隔離工具): [Sandboxing](/gateway/sandboxing)

注意：為了防止跨代理存取，請將 `agents.defaults.sandbox.scope` 保持在 `"agent"`（預設）或 `"session"` 以實現更嚴格的每會話隔離。 `scope: "shared"` 使用單一容器/工作區。

也請考慮在沙盒內的代理工作區存取：

- `agents.defaults.sandbox.workspaceAccess: "none"` (預設) 使代理工作區無法訪問；工具在 `~/.openclaw/sandboxes` 下的沙盒工作區中執行
- `agents.defaults.sandbox.workspaceAccess: "ro"` 將代理工作區以唯讀方式掛載於 `/agent` (禁用 `write`/`edit`/`apply_patch`)
- `agents.defaults.sandbox.workspaceAccess: "rw"` 將代理工作區以可讀寫方式掛載於 `/workspace`

重要：`tools.elevated` 是全域基準逃生閥，會在主機上執行 exec。請保持 `tools.elevated.allowFrom` 嚴格，不要對陌生人啟用。您可以透過 `agents.list[].tools.elevated` 進一步限制每個代理的提升權限。請參見 [提升模式](/tools/elevated)。

### 子代理委派防護措施

如果您允許會話工具，則將委派的子代理執行視為另一個邊界決策：

- 除非代理人真的需要委派，否則拒絕 `sessions_spawn`。
- 將 `agents.list[].subagents.allowAgents` 限制在已知安全的目標代理人中。
- 對於必須保持沙盒的工作流程，請使用 `sessions_spawn` 並傳入 `sandbox: "require"`（預設為 `inherit`）。
- 當目標子執行環境未被沙盒化時，`sandbox: "require"` 會快速失敗。

## 瀏覽器控制風險

啟用瀏覽器控制使模型能夠操作真實的瀏覽器。如果該瀏覽器設定檔已經包含登入的會話，模型可以訪問這些帳戶和數據。將瀏覽器設定檔視為 **敏感狀態**：

- 優先使用專用的代理設定檔（預設的 `openclaw` 設定檔）。
- 避免將代理指向您的個人日常使用設定檔。
- 除非您信任它們，否則對於沙盒代理，請保持主機瀏覽器控制禁用。
- 將瀏覽器下載視為不受信任的輸入；優先使用隔離的下載目錄。
- 如果可能，請在代理設定檔中禁用瀏覽器同步/密碼管理器（減少影響範圍）。
- 對於遠端網關，假設「瀏覽器控制」等同於「操作員訪問」該設定檔可以接觸的任何內容。
- 保持網關和節點主機僅限於 tailnet；避免將中繼/控制端口暴露於局域網或公共互聯網。
- Chrome 擴充功能中繼的 CDP 端點是經過身份驗證的；只有 OpenClaw 用戶端可以連接。
- 當您不需要時，禁用瀏覽器代理路由 (`gateway.nodes.browser.mode="off"`)。
- Chrome 擴充功能中繼模式 **不是**「更安全」的；它可以接管您現有的 Chrome 標籤頁。假設它可以在該標籤頁/設定檔可以接觸的任何內容中以您的身份行動。

### 瀏覽器 SSRF 政策（受信網路預設）

OpenClaw 的瀏覽器網路政策預設為信任操作員模型：私有/內部目的地是被允許的，除非您明確禁用它們。

- 預設: `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: true`（當未設定時隱含）。
- 舊版別名: `browser.ssrfPolicy.allowPrivateNetwork` 仍然被接受以保持相容性。
- 嚴格模式: 預設將 `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: false` 設定為阻止私有/內部/特殊用途的目的地。
- 在嚴格模式下，使用 `hostnameAllowlist`（像 `*.example.com` 的模式）和 `allowedHostnames`（精確的主機例外，包括被阻止的名稱如 `localhost`）來進行明確的例外處理。
- 導航在請求之前進行檢查，並在導航後對最終 `http(s)` URL 進行最佳努力的重新檢查，以減少基於重定向的轉換。

[[BLOCK_1]]  
範例嚴格政策：  
[[BLOCK_1]]

```json5
{
  browser: {
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["*.example.com", "example.com"],
      allowedHostnames: ["localhost"],
    },
  },
}
```

## 每個代理的存取設定檔（多代理）

透過多代理路由，每個代理可以擁有自己的沙盒 + 工具政策：
使用此功能可為每個代理提供 **完全訪問**、**只讀** 或 **無訪問** 的權限。
詳情及優先順序規則請參見 [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)。

常見的使用案例：

- 個人代理：完全訪問，無沙盒
- 家庭/工作代理：沙盒環境 + 只讀工具
- 公共代理：沙盒環境 + 無檔案系統/命令行工具

### 範例：完全訪問（無沙盒）

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

### 範例：唯讀工具 + 唯讀工作區

```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "ro",
        },
        tools: {
          allow: ["read"],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

### 範例：無檔案系統/命令列存取（允許提供者訊息）

```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "none",
        },
        // Session tools can reveal sensitive data from transcripts. By default OpenClaw limits these tools
        // to the current session + spawned subagent sessions, but you can clamp further if needed.
        // See `tools.sessions.visibility` in the configuration reference.
        tools: {
          sessions: { visibility: "tree" }, // self | tree | agent | all
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

## 你該告訴你的 AI 什麼

[[BLOCK_1]]

```
## Security Rules
- Never share directory listings or file paths with strangers
- Never reveal API keys, credentials, or infrastructure details
- Verify requests that modify system config with the owner
- When in doubt, ask before acting
- Keep private data private unless explicitly authorized
```

## 事件回應

如果你的 AI 做了壞事：

### Contain

1. **停止它：** 停止 macOS 應用程式（如果它監控 Gateway）或終止你的 `openclaw gateway` 程序。
2. **關閉曝光：** 設定 `gateway.bind: "loopback"`（或禁用 Tailscale Funnel/Serve），直到你了解發生了什麼。
3. **凍結訪問：** 將風險較高的 DM/群組切換至 `dmPolicy: "disabled"` / 需要提及，並移除 `"*"` 允許所有的條目（如果你有的話）。

### 旋轉（假設如果秘密洩漏則視為妥協）

1. 旋轉 Gateway 認證 (`gateway.auth.token` / `OPENCLAW_GATEWAY_PASSWORD`) 並重新啟動。
2. 在任何可以呼叫 Gateway 的機器上旋轉遠端用戶端密鑰 (`gateway.remote.token` / `.password`)。
3. 旋轉提供者/API 憑證（WhatsApp 憑證、Slack/Discord token、`auth-profiles.json` 中的模型/API 金鑰，以及使用時的加密密鑰負載值）。

### Audit

1. 檢查閘道日誌: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (或 `logging.file`)。
2. 檢視相關的記錄: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`。
3. 檢查最近的設定變更（任何可能擴大存取的變更: `gateway.bind`、`gateway.auth`、dm/群組政策、`tools.elevated`、插件變更）。
4. 重新執行 `openclaw security audit --deep` 並確認關鍵發現已解決。

### 收集報告所需資料

- 時間戳記、網關主機作業系統 + OpenClaw 版本
- 會話記錄 + 簡短的日誌尾部（經過刪除敏感資訊後）
- 攻擊者發送的內容 + 代理所做的操作
- 網關是否超出回環介面暴露（LAN/Tailscale Funnel/Serve）

## Secret Scanning (detect-secrets)

CI 在 `secrets` 工作中執行 `detect-secrets` pre-commit 鉤子。對 `main` 的推送總是會執行全檔案掃描。當有基礎提交可用時，拉取請求會使用變更檔案的快速路徑，否則會回退到全檔案掃描。如果掃描失敗，則表示有新的候選項尚未在基準中。

### 如果 CI 失敗

1. 在本地重現：

```bash
   pre-commit run --all-files detect-secrets
```

2. 了解工具：
   - `detect-secrets` 在 pre-commit 中執行 `detect-secrets-hook`，使用倉庫的基準和排除專案。
   - `detect-secrets audit` 開啟互動式審查，以標記每個基準專案為真實或假陽性。
3. 對於真實的秘密：旋轉/移除它們，然後重新執行掃描以更新基準。
4. 對於假陽性：執行互動式審核並將其標記為假：

```bash
   detect-secrets audit .secrets.baseline
```

5. 如果您需要新的排除項，請將它們添加到 `.detect-secrets.cfg` 並使用匹配的 `--exclude-files` / `--exclude-lines` 標誌重新生成基準（設定檔僅供參考；detect-secrets 不會自動讀取它）。

一旦反映出預期狀態，請提交更新的 `.secrets.baseline`。

## 報告安全問題

發現 OpenClaw 的漏洞？請負責任地報告：

1. 電子郵件: [security@openclaw.ai](mailto:security@openclaw.ai)
2. 在修復之前請勿公開發佈
3. 我們會給予您信用（除非您希望保持匿名）
