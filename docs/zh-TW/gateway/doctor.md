---
summary: "Doctor command: health checks, config migrations, and repair steps"
read_when:
  - Adding or modifying doctor migrations
  - Introducing breaking config changes
title: Doctor
---

# Doctor

`openclaw doctor` 是 OpenClaw 的修復 + 遷移工具。它修復過時的設定/狀態，檢查健康狀況，並提供可行的修復步驟。

## 快速開始

```bash
openclaw doctor
```

### Headless / automation

```bash
openclaw doctor --yes
```

接受預設值而不提示（包括在適用時的重啟/服務/沙盒修復步驟）。

```bash
openclaw doctor --repair
```

自動應用建議的修復（在安全的情況下進行修復 + 重新啟動）。

```bash
openclaw doctor --repair --force
```

也應該進行積極的修復（會覆蓋自訂的監控器設定）。

```bash
openclaw doctor --non-interactive
```

在沒有提示的情況下執行，僅應用安全的遷移（設定標準化 + 磁碟狀態移動）。跳過需要人員確認的重啟/服務/沙盒操作。當檢測到舊版狀態遷移時，將自動執行。

```bash
openclaw doctor --deep
```

掃描系統服務以尋找額外的網關安裝（launchd/systemd/schtasks）。

如果您想在寫入之前檢查變更，請先打開設定檔案：

```bash
cat ~/.openclaw/openclaw.json
```

## 它的功能（摘要）

- 可選的 git 安裝前更新（僅限互動模式）。
- UI 協議新鮮度檢查（當協議架構更新時重建控制 UI）。
- 健康檢查 + 重啟提示。
- 技能狀態摘要（合格/缺失/阻塞）。
- 過去值的設定正規化。
- OpenCode 提供者覆蓋警告 (`models.providers.opencode` / `models.providers.opencode-go`)。
- 過去的磁碟狀態遷移（會話/代理目錄/WhatsApp 認證）。
- 過去的 cron 存儲遷移 (`jobId`, `schedule.cron`, 頂層交付/有效負載欄位，有效負載 `provider`, 簡單 `notify: true` webhook 回退任務）。
- 狀態完整性和權限檢查（會話、逐字稿、狀態目錄）。
- 在本地執行時的設定檔權限檢查（chmod 600）。
- 模型認證健康：檢查 OAuth 到期，能夠刷新即將到期的 token，並報告認證設定的冷卻/禁用狀態。
- 額外工作區目錄檢測 (`~/openclaw`)。
- 當啟用沙盒時修復沙盒映像。
- 過去服務遷移和額外網關檢測。
- 網關執行時檢查（服務已安裝但未執行；快取的 launchd 標籤）。
- 通道狀態警告（從執行中的網關探測）。
- 監督者設定審核（launchd/systemd/schtasks）並提供可選修復。
- 網關執行時最佳實踐檢查（Node vs Bun，版本管理器路徑）。
- 網關端口衝突診斷（預設 `18789`）。
- 開放 DM 政策的安全警告。
- 本地 token 模式的網關認證檢查（當沒有 token 來源時提供 token 生成；不會覆蓋 token SecretRef 設定）。
- Linux 上的 systemd linger 檢查。
- 源安裝檢查（pnpm 工作區不匹配、缺少 UI 資產、缺少 tsx 二進位檔）。
- 寫入更新的設定 + 向導元數據。

## 詳細行為與原則

### 0) 可選更新 (git 安裝)

如果這是一次 git checkout，並且 doctor 正在互動式執行，它會在執行 doctor 之前提供更新（抓取/重疊/建構）的選項。

### 1) 設定正規化

如果設定包含舊版值形狀（例如 `messages.ackReaction` 而沒有特定於通道的覆蓋），doctor 會將它們標準化為當前的架構。

### 2) 過時設定鍵遷移

當設定包含已過時的鍵時，其他命令會拒絕執行並要求您執行 `openclaw doctor`。

[[BLOCK_1]]

- 解釋發現了哪些舊版金鑰。
- 顯示應用的遷移。
- 重新編寫 `~/.openclaw/openclaw.json` 以符合更新的架構。

Gateway 在啟動時會自動執行 doctor 遷移，當它檢測到舊版設定格式時，這樣可以在不需要手動介入的情況下修復過時的設定。

目前的遷移：

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → top-level `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- 對於有命名的 `accounts` 但缺少 `accounts.default` 的頻道，當存在時，將帳戶範圍的頂層單帳戶頻道值移入 `channels.<channel>.accounts.default`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`
- `browser.ssrfPolicy.allowPrivateNetwork` → `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`

[[BLOCK_1]] 醫生警告還包括多帳戶頻道的帳戶預設指導： [[BLOCK_1]]

- 如果設定了兩個或更多 `channels.<channel>.accounts` 條目而沒有 `channels.<channel>.defaultAccount` 或 `accounts.default`，醫生會警告說回退路由可能會選擇到意外的帳戶。
- 如果 `channels.<channel>.defaultAccount` 設定為未知的帳戶 ID，醫生會發出警告並列出已設定的帳戶 ID。

### 2b) OpenCode 提供者覆寫

如果您手動添加了 `models.providers.opencode`、`opencode-zen` 或 `opencode-go`，這將覆蓋來自 `@mariozechner/pi-ai` 的內建 OpenCode 目錄。這可能會導致模型使用錯誤的 API 或將成本歸零。醫生會發出警告，以便您可以移除覆蓋並恢復每個模型的 API 路由和成本。

### 3) 過去狀態遷移（磁碟佈局）

Doctor 可以將舊的磁碟佈局遷移到當前結構：

- 會話儲存 + 逐字稿：
  - 從 `~/.openclaw/sessions/` 到 `~/.openclaw/agents/<agentId>/sessions/`
- 代理人目錄：
  - 從 `~/.openclaw/agent/` 到 `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp 認證狀態 (Baileys)：
  - 從舊版 `~/.openclaw/credentials/*.json` (不包括 `oauth.json`)
  - 到 `~/.openclaw/credentials/whatsapp/<accountId>/...` (預設帳戶 ID: `default`)

這些遷移是最佳努力且具冪等性；當 doctor 留下任何舊版資料夾作為備份時，會發出警告。Gateway/CLI 在啟動時也會自動遷移舊版的會話和代理目錄，因此歷史/授權/模型會自動放置在每個代理的路徑中，而無需手動執行 doctor。WhatsApp 授權故意僅透過 `openclaw doctor` 進行遷移。

### 3b) 過去的 cron 存儲遷移

醫生還會檢查 cron 工作存儲 (`~/.openclaw/cron/jobs.json` 預設情況下，或 `cron.store` 在被覆蓋時) 以尋找調度器仍然接受的舊工作形狀，以保持相容性。

目前的 cron 清理專案包括：

- `jobId` → `id`
- `schedule.cron` → `schedule.expr`
- 頂層有效載荷欄位 (`message`, `model`, `thinking`, ...) → `payload`
- 頂層交付欄位 (`deliver`, `channel`, `to`, `provider`, ...) → `delivery`
- 有效載荷 `provider` 交付別名 → 明確的 `delivery.channel`
- 簡單的舊版 `notify: true` webhook 備援任務 → 明確的 `delivery.mode="webhook"` 連同 `delivery.to=cron.webhook`

Doctor 只有在不改變行為的情況下，自動遷移 `notify: true` 工作。如果一個工作結合了舊版通知回退和現有的非網路釘送模式，Doctor 會發出警告並將該工作留給手動審查。

### 4) 狀態完整性檢查（會話持久性、路由和安全性）

狀態目錄是操作的核心。如果它消失，您將失去會話、憑證、日誌和設定（除非您在其他地方有備份）。

[[BLOCK_1]]

- **狀態目錄缺失**：警告可能會導致災難性的狀態損失，提示重新創建目錄，並提醒您無法恢復缺失的數據。
- **狀態目錄權限**：驗證可寫性；提供修復權限的選項（並在檢測到擁有者/群組不匹配時發出 `chown` 提示）。
- **macOS 雲端同步狀態目錄**：當狀態在 iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/...`) 或 `~/Library/CloudStorage/...` 下解析時發出警告，因為同步支援的路徑可能會導致較慢的 I/O 和鎖定/同步競爭。
- **Linux SD 或 eMMC 狀態目錄**：當狀態解析到 `mmcblk*` 掛載來源時發出警告，因為 SD 或 eMMC 支援的隨機 I/O 可能較慢，並且在會話和憑證寫入下磨損更快。
- **會話目錄缺失**：`sessions/` 和會話存儲目錄是持久化歷史記錄和避免 `ENOENT` 崩潰所必需的。
- **轉錄不匹配**：當最近的會話條目缺少轉錄文件時發出警告。
- **主要會話 “1 行 JSONL”**：當主要轉錄只有一行時標記（歷史記錄未累積）。
- **多個狀態目錄**：當在主目錄中存在多個 `~/.openclaw` 資料夾或當 `OPENCLAW_STATE_DIR` 指向其他地方時發出警告（歷史記錄可能在安裝之間分裂）。
- **遠端模式提醒**：如果 `gateway.mode=remote`，醫生提醒您在遠端主機上執行它（狀態存在於那裡）。
- **設定檔權限**：如果 `~/.openclaw/openclaw.json` 是群組/全域可讀的，則發出警告並提供收緊到 `600` 的選項。

### 5) 模型認證健康狀態 (OAuth 到期)

Doctor 檢查授權存儲中的 OAuth 設定檔，當 token 即將過期或已過期時會發出警告，並在安全的情況下可以刷新它們。如果 Anthropic Claude Code 設定檔已過時，它會建議執行 `claude setup-token`（或貼上 setup-token）。刷新提示僅在互動式執行（TTY）時出現；`--non-interactive` 會跳過刷新嘗試。

醫生還報告了因以下原因而暫時無法使用的授權設定檔：

- 短暫的冷卻時間（速率限制/超時/認證失敗）
- 較長的禁用（計費/信用失敗）

### 6) Hooks 模型驗證

如果 `hooks.gmail.model` 被設定，醫生會驗證模型參考是否符合目錄和允許清單，並在無法解析或被禁止時發出警告。

### 7) 沙盒映像修復

當啟用沙盒模式時，doctor 會檢查 Docker 映像，並在當前映像缺失時提供構建或切換到舊版名稱的選項。

### 8) 閘道服務遷移與清理提示

Doctor 偵測到舊版閘道服務（launchd/systemd/schtasks），並提供移除這些服務的選項，並使用當前的閘道埠安裝 OpenClaw 服務。它還可以掃描額外的類似閘道的服務並列印清理提示。以設定檔命名的 OpenClaw 閘道服務被視為一級服務，並不會被標記為「額外」。

### 9) 安全警告

當提供者在沒有允許清單的情況下開放私訊時，或當政策以危險的方式設定時，Doctor 會發出警告。

### 10) systemd linger (Linux)

如果以 systemd 使用者服務執行，doctor 確保啟用持續執行，以便在登出後網關仍然保持執行。

### 11) 技能狀態

醫生會列印出當前工作區域中符合資格的/缺失的/被阻擋的技能的快速摘要。

### 12) 閘道身份驗證檢查（本地 token）

醫生檢查本地閘道的 token 認證準備情況。

- 如果 token 模式需要一個 token 而沒有 token 來源，doctor 會提供生成一個的選項。
- 如果 `gateway.auth.token` 是由 SecretRef 管理但無法使用，doctor 會發出警告並且不會用明文覆蓋它。
- `openclaw doctor --generate-gateway-token` 只有在未設定 token SecretRef 時才強制生成。

### 12b) 只讀 SecretRef 感知的修復

某些修復流程需要檢查已設定的憑證，而不會削弱執行時的快速失敗行為。

- `openclaw doctor --fix` 現在使用與狀態家族命令相同的只讀 SecretRef 摘要模型，以進行針對性的設定修復。
- 例如：Telegram `allowFrom` / `groupAllowFrom` `@username` 修復會在可用時嘗試使用設定的機器人憑證。
- 如果 Telegram 機器人 token 是通過 SecretRef 設定的，但在當前命令路徑中不可用，doctor 會報告該憑證已設定但不可用，並跳過自動解析，而不是崩潰或錯誤報告 token 為缺失。

### 13) 閘道健康檢查 + 重啟

醫生執行健康檢查，並在閘道器看起來不健康時提供重新啟動的選項。

### 14) 頻道狀態警告

如果網關運作正常，醫生會執行通道狀態探測並報告警告及建議的修正措施。

### 15) 監督者設定審核 + 修復

醫生檢查已安裝的監控器設定（launchd/systemd/schtasks）是否有缺失或過時的預設值（例如，systemd 網路在線依賴和重啟延遲）。當發現不匹配時，它會建議進行更新並可以將服務檔案/任務重寫為當前的預設值。

[[BLOCK_1]]

- `openclaw doctor` 在重寫監控器設定之前提示。
- `openclaw doctor --yes` 接受預設的修復提示。
- `openclaw doctor --repair` 在不提示的情況下應用建議的修復。
- `openclaw doctor --repair --force` 會覆蓋自訂的監控器設定。
- 如果 token 認證需要一個 token 且 `gateway.auth.token` 是由 SecretRef 管理，doctor 服務安裝/修復會驗證 SecretRef，但不會將解析後的明文 token 值持久化到監控器服務環境元數據中。
- 如果 token 認證需要一個 token 且設定的 token SecretRef 尚未解析，doctor 會阻止安裝/修復路徑並提供可行的指導。
- 如果同時設定了 `gateway.auth.token` 和 `gateway.auth.password` 且 `gateway.auth.mode` 未設置，doctor 會阻止安裝/修復，直到模式被明確設置。
- 對於 Linux 使用者-systemd 單元，doctor token 漂移檢查現在在比較服務認證元數據時包括 `Environment=` 和 `EnvironmentFile=` 來源。
- 您可以隨時通過 `openclaw gateway install --force` 強制進行完整重寫。

### 16) Gateway 執行時 + 端口診斷

醫生檢查服務的執行時間 (PID、最後退出狀態)，並在服務已安裝但實際上未執行時發出警告。它還檢查網關端口 (預設 `18789`) 的端口衝突並報告可能的原因 (網關已在執行中、SSH 隧道)。

### 17) Gateway 執行時最佳實踐

醫生警告當網關服務在 Bun 或版本管理的 Node 路徑上執行時 (`nvm`, `fnm`, `volta`, `asdf` 等)。WhatsApp 和 Telegram 頻道需要 Node，而版本管理的路徑在升級後可能會中斷，因為服務不會加載您的 shell 初始化。醫生建議在可用時遷移到系統的 Node 安裝（Homebrew/apt/choco）。

### 18) 設定寫入 + 向導元數據

Doctor 會持續保存任何設定變更，並標記精靈的元數據以記錄 Doctor 的執行。

### 19) 工作區提示（備份 + 記憶系統）

醫生建議在缺少工作區記憶系統時使用，並在工作區尚未在 git 下時打印備份提示。

請參閱 [/concepts/agent-workspace](/concepts/agent-workspace) 以獲取有關工作區結構和 git 備份的完整指南（建議使用私人 GitHub 或 GitLab）。
