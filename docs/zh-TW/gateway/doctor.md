---
summary: "Doctor 命令：健康檢查、設定遷移及修復步驟"
read_when:
  - 新增或修改 doctor 遷移
  - 引入破壞性設定變更
title: "Doctor"
---

# Doctor

`openclaw doctor` 是 OpenClaw 的修復 + 遷移工具。它能修正過時的設定/狀態、檢查健康狀況，並提供可行的修復步驟。

## 快速開始

```bash
openclaw doctor
```

### 無頭模式 / 自動化

```bash
openclaw doctor --yes
```

接受預設值而無需提示（包括適用時的重新啟動/服務/沙箱修復步驟）。

```bash
openclaw doctor --repair
```

無需提示應用建議的修復（在安全時進行修復 + 重新啟動）。

```bash
openclaw doctor --repair --force
```

也應用激進的修復（覆寫自訂 supervisor 設定）。

```bash
openclaw doctor --non-interactive
```

在無提示下執行，並且只應用安全的遷移（設定正規化 + 磁碟上的狀態移動）。跳過需要人工確認的重新啟動/服務/沙箱動作。
偵測到時，遺留狀態遷移會自動執行。

```bash
openclaw doctor --deep
```

掃描系統服務以查找額外的 Gateway安裝（launchd/systemd/schtasks）。

如果您想在寫入前檢閱變更，請先開啟設定檔案：

```bash
cat ~/.openclaw/openclaw.json
```

## 功能概述

- git 安裝的選擇性預檢更新（僅限互動模式）。
- UI 協定新鮮度檢查（當協定 schema 較新時重建 Control UI）。
- 健康檢查 + 重新啟動提示。
- Skills 狀態摘要（符合資格/遺失/被封鎖）。
- 遺留值的設定正規化。
- OpenCode Zen 供應商覆寫警告（`models.providers.opencode`）。
- 遺留磁碟狀態遷移（工作階段/智慧代理 目錄/WhatsApp 憑證）。
- 狀態完整性和權限檢查（工作階段、文字記錄、狀態目錄）。
- 在本機執行時的設定檔案權限檢查（chmod 600）。
- 模型憑證健康狀況：檢查 OAuth 到期、可重新整理即將到期的 token，並回報憑證設定檔冷卻/停用狀態。
- 額外工作區目錄偵測（`~/openclaw`）。
- 啟用沙箱隔離 時的沙箱 映像檔修復。
- 遺留服務遷移和額外 Gateway偵測。
- Gateway執行階段檢查（服務已安裝但未執行；快取的 launchd 標籤）。
- 頻道狀態警告（從正在執行的 Gateway偵測）。
- Supervisor 設定稽核（launchd/systemd/schtasks）及選擇性修復。
- Gateway執行階段最佳實務檢查（Node 與 Bun、版本管理員路徑）。
- Gateway連接埠衝突診斷（預設 `18789`）。
- 開放 私訊 策略的安全警告。
- 當未設定 `gateway.auth.token` 時的 Gateway憑證警告（本機模式；提供 token 生成）。
- Linux 上的 systemd linger 檢查。
- 原始碼安裝檢查（pnpm workspace 不匹配、遺失 UI 資產、遺失 tsx 二進位檔案）。
- 寫入更新後的設定 + 精靈 元資料。

## 詳細行為和原理

### 0) 選擇性更新 (git 安裝)

如果這是 git 檢出，且 doctor 以互動模式執行，它會在執行 doctor 之前提供更新（fetch/rebase/build）。

### 1) 設定正規化

如果設定包含遺留值形式（例如 `messages.ackReaction` 沒有特定頻道覆寫），doctor 會將其正規化為目前的 schema。

### 2) 遺留設定鍵遷移

當設定包含已棄用的鍵時，其他命令會拒絕執行並要求您執行 `openclaw doctor`。

Doctor 將會：

- 解釋找到哪些遺留鍵。
- 顯示其應用的遷移。
- 使用更新後的 schema 重新寫入 `~/.openclaw/openclaw.json`。

當偵測到遺留設定格式時，Gateway也會在啟動時自動執行 doctor 遷移，因此過時的設定無需手動干預即可修復。

目前遷移：

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → 頂層 `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen 供應商覆寫

如果您手動新增了 `models.providers.opencode`（或 `opencode-zen`），它會覆寫 ` @mariozechner/pi-ai` 中內建的 OpenCode Zen 目錄。這可能會強制每個模型使用單一 API 或將成本歸零。Doctor 會發出警告，以便您可以移除覆寫並恢復每個模型的 API 路由 + 成本。

### 3) 遺留狀態遷移 (磁碟配置)

Doctor 可以將舊的磁碟配置遷移到目前的結構：

- 工作階段儲存 + 文字記錄：
  - 從 `~/.openclaw/sessions/` 到 `~/.openclaw/agents/<agentId>/sessions/`
- 智慧代理 目錄：
  - 從 `~/.openclaw/agent/` 到 `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp 憑證 狀態 (Baileys)：
  - 從遺留的 `~/.openclaw/credentials/*.json` (除了 `oauth.json`)
  - 到 `~/.openclaw/credentials/whatsapp/<accountId>/...` (預設 帳戶 id: `default`)

這些遷移是盡力而為且冪等的；當 doctor 將任何遺留資料夾保留為備份時會發出警告。Gateway/CLI 也會在啟動時自動遷移遺留 工作階段 + 智慧代理 目錄，因此歷史/憑證/模型會進入每個智慧代理 的路徑，而無需手動執行 doctor。WhatsApp 憑證 有意只透過 `openclaw doctor` 遷移。

### 4) 狀態完整性檢查 (工作階段持續性、路由和安全)

狀態目錄是操作的核心。如果它消失，您將會遺失 工作階段、憑證、日誌和設定（除非您在其他地方有備份）。

Doctor 檢查：

- **狀態目錄遺失**：警告災難性的狀態遺失，提示重新建立目錄，並提醒您它無法復原遺失的資料。
- **狀態目錄權限**：驗證可寫入性；提供修復權限（並在偵測到擁有者/群組不匹配時發出 `chown` 提示）。
- **工作階段目錄遺失**：`sessions/` 和 工作階段 儲存目錄是持久化歷史記錄並避免 `ENOENT` 崩潰所必需的。
- **文字記錄不匹配**：當近期 工作階段 條目遺失 文字記錄 檔案時發出警告。
- **主要 工作階段 「1 行 JSONL」**：當主要 文字記錄 只有一行時標記（歷史記錄沒有累積）。
- **多個狀態目錄**：當多個 `~/.openclaw` 資料夾存在於不同的 home 目錄中，或當 `OPENCLAW_STATE_DIR` 指向其他位置時發出警告（歷史記錄可能在不同的安裝之間分裂）。
- **遠端模式提醒**：如果 `gateway.mode=remote`，doctor 會提醒您在遠端主機上執行它（狀態存在於該處）。
- **設定檔案權限**：如果 `~/.openclaw/openclaw.json` 對群組/其他使用者可讀取，則發出警告並提供收緊為 `600` 的選項。

### 5) 模型憑證健康 (OAuth 到期)

Doctor 會檢查憑證儲存中的 OAuth 設定檔，當 token 即將到期/已到期時發出警告，並在安全時重新整理它們。如果 Anthropic Claude Code 設定檔過時，它會建議執行 `claude setup-token`（或貼上 setup-token）。
重新整理提示僅在互動式執行 (TTY) 時出現；`--non-interactive` 會跳過重新整理嘗試。

Doctor 也會報告由於以下原因而暫時無法使用的憑證設定檔：

- 短暫冷卻（速率限制/逾時/憑證失敗）
- 較長時間停用（帳單/信用失敗）

### 6) 鉤子模型驗證

如果設定了 `hooks.gmail.model`，doctor 會根據目錄和允許清單驗證模型參考，並在無法解析或不允許時發出警告。

### 7) 沙箱 映像檔修復

啟用 沙箱隔離 時，doctor 會檢查 Docker 映像檔，並在目前映像檔遺失時提供建置或切換到舊版名稱的選項。

### 8) Gateway服務遷移和清理提示

Doctor 會偵測遺留的 Gateway服務（launchd/systemd/schtasks），並提供移除它們並使用目前的 Gateway連接埠安裝 OpenClaw 服務的選項。它還可以掃描額外的類似 Gateway服務並列印清理提示。
以設定檔命名的 OpenClaw Gateway服務被視為第一級服務，不會被標記為「額外」。

### 9) 安全警告

當供應商開放 私訊 且沒有允許清單，或者策略設定危險時，Doctor 會發出警告。

### 10) systemd linger (Linux)

如果作為 systemd 使用者服務執行，doctor 會確保啟用 linger，以便 Gateway在登出後保持活動。

### 11) Skills 狀態

Doctor 會列印目前工作區符合資格/遺失/被封鎖 Skills 的快速摘要。

### 12) Gateway憑證檢查 (local token)

當本機 Gateway遺失 `gateway.auth` 時，Doctor 會發出警告並提供產生 token 的選項。使用 `openclaw doctor --generate-gateway-token` 在自動化中強制建立 token。

### 13) Gateway健康檢查 + 重新啟動

Doctor 會執行健康檢查，並在 Gateway看起來不健康時提供重新啟動的選項。

### 14) 頻道狀態警告

如果 Gateway健康，doctor 會執行頻道狀態探測並回報警告以及建議的修正。

### 15) Supervisor 設定稽核 + 修復

Doctor 會檢查已安裝的 supervisor 設定（launchd/systemd/schtasks），以查找遺失或過時的預設值（例如 systemd network-online 相依性與重新啟動延遲）。當它發現不匹配時，會建議更新並可將服務檔案/任務重寫為目前的預設值。

注意事項：

- `openclaw doctor` 在重寫 supervisor 設定前會提示。
- `openclaw doctor --yes` 接受預設修復提示。
- `openclaw doctor --repair` 無需提示應用建議的修復。
- `openclaw doctor --repair --force` 覆寫自訂 supervisor 設定。
- 您始終可以透過 `openclaw gateway install --force` 強制完全重寫。

### 16) Gateway執行階段 + 連接埠診斷

Doctor 會檢查服務執行階段（PID、上次結束狀態），並在服務已安裝但實際未執行時發出警告。它還會檢查 Gateway連接埠（預設 `18789`）上的連接埠衝突，並報告可能的原因（Gateway已在執行、SSH 通道）。

### 17) Gateway執行階段最佳實務

當 Gateway服務在 Bun 或版本管理員管理的 Node 路徑（`nvm`、`fnm`、`volta`、`asdf` 等）上執行時，Doctor 會發出警告。WhatsApp + Telegram 頻道需要 Node，版本管理員路徑在升級後可能會中斷，因為服務不會載入您的 shell 初始化。Doctor 會在可用時提供遷移到系統 Node 安裝的選項（Homebrew/apt/choco）。

### 18) 設定寫入 + 精靈 元資料

Doctor 會保留任何設定變更，並標記 精靈 元資料以記錄 doctor 執行。

### 19) 工作區提示 (備份 + 記憶系統)

Doctor 會在遺失時建議工作區記憶系統，並在工作區尚未受 git 管理時列印備份提示。

請參閱 [/concepts/agent-workspace](/concepts/agent-workspace)，以取得工作區結構和 git 備份的完整指南（建議使用私有 GitHub 或 GitLab）。
