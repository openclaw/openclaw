---
summary: "Doctor 指令：健康檢查、設定遷移及修復步驟"
read_when:
  - 新增或修改 doctor 遷移邏輯時
  - 引入破壞性設定變更時
title: "Doctor"
---

# Doctor

`openclaw doctor` 是 OpenClaw 的維修與遷移工具。它能修正過時的設定/狀態、檢查健康狀況，並提供可執行的修復步驟。

## 快速開始

```bash
openclaw doctor
```

### 無介面 / 自動化

```bash
openclaw doctor --yes
```

不經詢問直接接受預設值（包含適用的重新啟動/服務/沙箱修復步驟）。

```bash
openclaw doctor --repair
```

不經詢問直接執行建議的修復（在安全情況下進行修復與重新啟動）。

```bash
openclaw doctor --repair --force
```

同時執行具侵略性的修復（覆寫自定義的 supervisor 設定）。

```bash
openclaw doctor --non-interactive
```

在不經詢問的情況下執行，僅套用安全的遷移（設定標準化 + 磁碟狀態移動）。跳過需要人工確認的重新啟動/服務/沙箱操作。檢測到舊版狀態遷移時會自動執行。

```bash
openclaw doctor --deep
```

掃描系統服務以尋找額外的 Gateway 安裝（launchd/systemd/schtasks）。

如果您想在寫入前查看變更，請先開啟設定檔案：

```bash
cat ~/.openclaw/openclaw.json
```

## 功能摘要

- 針對 git 安裝提供選用的執行前更新（僅限互動模式）。
- UI 協定新鮮度檢查（當協定結構較新時，重新構建 Control UI）。
- 健康檢查 + 重新啟動提示。
- Skills 狀態摘要（合格/缺失/受阻）。
- 針對舊版數值的設定標準化。
- OpenCode Zen 供應商覆寫警告 (`models.providers.opencode`)。
- 舊版磁碟狀態遷移（工作階段/智慧代理目錄/WhatsApp 驗證）。
- 狀態完整性與權限檢查（工作階段、逐字稿、狀態目錄）。
- 本地執行時的設定檔案權限檢查 (chmod 600)。
- 模型驗證健康狀況：檢查 OAuth 到期、自動重新整理即將到期的權杖，並回報驗證設定檔的冷卻/停用狀態。
- 偵測額外的工作區目錄 (`~/openclaw`)。
- 啟用沙箱隔離時進行沙箱映像檔修復。
- 舊版服務遷移與額外 Gateway 偵測。
- Gateway 執行階段檢查（服務已安裝但未執行；快取的 launchd 標籤）。
- 頻道狀態警告（從執行中的 Gateway 探測）。
- Supervisor 設定稽核 (launchd/systemd/schtasks) 及選用修復。
- Gateway 執行階段最佳實踐檢查（Node 對比 Bun、版本管理工具路徑）。
- Gateway 連接埠衝突診斷（預設為 `18789`）。
- 針對開放私訊策略的安全警告。
- 未設定 `gateway.auth.token` 時的 Gateway 驗證警告（本地模式；提供權杖生成）。
- Linux 上的 systemd linger 檢查。
- 原始碼安裝檢查（pnpm 工作區不匹配、缺失 UI 資產、缺失 tsx 二進位檔案）。
- 寫入更新後的設定 + 精靈中繼資料。

## 詳細行為與原理

### 0) 選用更新 (git 安裝)

如果是透過 git 取得的程式碼且 doctor 以互動模式執行，它會提供在執行 doctor 之前進行更新（fetch/rebase/build）的選項。

### 1) 設定標準化

如果設定包含舊版數值格式（例如沒有頻道特定覆寫的 `messages.ackReaction`），doctor 會將其標準化為目前的結構。

### 2) 舊版設定鍵名遷移

當設定包含已棄用的鍵名時，其他指令會拒絕執行並要求您執行 `openclaw doctor`。

Doctor 將會：

- 說明偵測到了哪些舊版鍵名。
- 顯示所套用的遷移內容。
- 以更新後的結構重新寫入 `~/.openclaw/openclaw.json`。

Gateway 在啟動時若偵測到舊版設定格式，也會自動執行 doctor 遷移，因此過時的設定無需手動介入即可修復。

目前的遷移項目：

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

如果您手動新增了 `models.providers.opencode` (或 `opencode-zen`)，它會覆寫來自 `@mariozechner/pi-ai` 的內建 OpenCode Zen 目錄。這可能會強制所有模型使用單一 API 或將成本歸零。Doctor 會發出警告，以便您可以移除該覆寫並還原各別模型的 API 路由與成本計算。

### 3) 舊版狀態遷移 (磁碟佈局)

Doctor 可以將舊版的磁碟佈局遷移至目前的結構：

- 工作階段儲存與逐字稿：
  - 從 `~/.openclaw/sessions/` 遷移至 `~/.openclaw/agents/<agentId>/sessions/`
- 智慧代理目錄：
  - 從 `~/.openclaw/agent/` 遷移至 `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp 驗證狀態 (Baileys)：
  - 從舊版的 `~/.openclaw/credentials/*.json` (除 `oauth.json` 外)
  - 遷移至 `~/.openclaw/credentials/whatsapp/<accountId>/...` (預設帳號 ID：`default`)

這些遷移是盡力而為且具冪等性的；doctor 在留下任何舊資料夾作為備份時會發出警告。Gateway/CLI 在啟動時也會自動遷移舊版工作階段與智慧代理目錄，讓歷史記錄/驗證/模型能進入各智慧代理的路徑，而無需手動執行 doctor。WhatsApp 驗證則刻意僅能透過 `openclaw doctor` 進行遷移。

### 4) 狀態完整性檢查 (工作階段持久化、路由與安全)

狀態目錄是運作的中樞。如果它消失了，您將遺失工作階段、憑證、日誌與設定（除非您在別處有備份）。

Doctor 檢查項目：

- **狀態目錄缺失**：針對災難性的狀態遺失發出警告，提示重新建立目錄，並提醒無法復原遺失的資料。
- **狀態目錄權限**：驗證是否具備寫入權限；提供權限修復選項（並在偵測到擁有者/群組不匹配時發出 `chown` 提示）。
- **工作階段目錄缺失**：需要 `sessions/` 與工作階段儲存目錄來持久化歷史記錄並避免 `ENOENT` 崩潰。
- **逐字稿不匹配**：當最近的工作階段條目缺少逐字稿檔案時發出警告。
- **主工作階段「1 行 JSONL」**：當主逐字稿只有一行時發出標記（表示歷史記錄未累積）。
- **多個狀態目錄**：當家目錄下存在多個 `~/.openclaw` 資料夾，或 `OPENCLAW_STATE_DIR` 指向他處時發出警告（歷史記錄可能分散在不同安裝版中）。
- **遠端模式提醒**：如果 `gateway.mode=remote`，doctor 會提醒您在遠端主機上執行它（狀態儲存在該處）。
- **設定檔案權限**：如果 `~/.openclaw/openclaw.json` 可供群組/世界讀取，則發出警告並提供縮緊至 `600` 的選項。

### 5) 模型驗證健康狀況 (OAuth 到期)

Doctor 會檢查驗證儲存中的 OAuth 設定檔，在權杖即將到期/已到期時發出警告，並在安全的情況下自動重新整理。如果 Anthropic Claude Code 設定檔過時，它會建議執行 `claude setup-token` (或貼上 setup-token)。重新整理提示僅在以互動模式 (TTY) 執行時出現；`--non-interactive` 會跳過重新整理嘗試。

Doctor 也會回報因以下原因暫時無法使用的驗證設定檔：

- 短暫冷卻 (頻率限制/逾時/驗證失敗)
- 長期停用 (帳單/信用失敗)

### 6) Hooks 模型驗證

如果設定了 `hooks.gmail.model`，doctor 會根據目錄與允許清單驗證模型參考，並在無法解析或不被允許時發出警告。

### 7) 沙箱映像檔修復

啟用沙箱隔離時，doctor 會檢查 Docker 映像檔，並在目前的映像檔缺失時提供構建或切換至舊版名稱的選項。

### 8) Gateway 服務遷移與清理提示

Doctor 會偵測舊版的 Gateway 服務 (launchd/systemd/schtasks)，並提供移除它們並使用目前 Gateway 連接埠安裝 OpenClaw 服務的選項。它也能掃描類似 Gateway 的額外服務並列印清理提示。以設定檔命名的 OpenClaw Gateway 服務被視為正式成員，不會被標記為「額外」。

### 9) 安全性警告

當供應商在沒有允許清單的情況下對私訊開放，或原則設定方式具危險性時，doctor 會發出警告。

### 10) systemd linger (Linux)

若以 systemd 使用者服務執行，doctor 會確保啟用了 lingering，以便 Gateway 在登出後保持運作。

### 11) Skills 狀態

Doctor 會針對目前的工作區列印一份合格/缺失/受阻的 Skills 快速摘要。

### 12) Gateway 驗證檢查 (本地權杖)

當本地 Gateway 缺失 `gateway.auth` 時，doctor 會發出警告並提供生成權杖的選項。在自動化流程中，請使用 `openclaw doctor --generate-gateway-token` 來強制建立權杖。

### 13) Gateway 健康檢查 + 重新啟動

Doctor 會執行健康檢查，並在 Gateway 看起來不健康時提供重新啟動的選項。

### 14) 頻道狀態警告

如果 Gateway 健康，doctor 會執行頻道狀態探測，並回報警告與建議的修復方法。

### 15) Supervisor 設定稽核 + 修復

Doctor 會檢查已安裝的 supervisor 設定 (launchd/systemd/schtasks)，確認是否缺失或使用了過時的預設值（例如 systemd 的 network-online 依賴項與重新啟動延遲）。當發現不匹配時，它會建議更新，並可將服務檔案/工作重寫為目前的預設值。

備註：

- `openclaw doctor` 在重寫 supervisor 設定前會先詢問。
- `openclaw doctor --yes` 會接受預設的修復提示。
- `openclaw doctor --repair` 會在不經詢問的情況下套用建議的修復。
- `openclaw doctor --repair --force` 會覆寫自定義的 supervisor 設定。
- 您隨時可以透過 `openclaw gateway install --force` 強制執行完整重寫。

### 16) Gateway 執行階段 + 連接埠診斷

Doctor 會檢查服務執行階段（PID、上次結束狀態），並在服務已安裝但實際上未執行時發出警告。它也會檢查 Gateway 連接埠（預設為 `18789`）是否發生衝突，並回報可能的成因（Gateway 已在執行中、SSH 通道）。

### 17) Gateway 執行階段最佳實踐

當 Gateway 服務在 Bun 或受版本管理的 Node 路徑（`nvm`, `fnm`, `volta`, `asdf` 等）上執行時，doctor 會發出警告。WhatsApp + Telegram 頻道需要 Node，而版本管理工具的路徑在升級後可能會失效，因為服務不會載入您的 shell 初始化設定。Doctor 會在系統 Node 安裝（Homebrew/apt/choco）可用時，提供遷移至該安裝的選項。

### 18) 設定寫入 + 精靈中繼資料

Doctor 會持久化任何設定變更，並標記精靈中繼資料以記錄 doctor 的執行。

### 19) 工作區提示 (備份 + 記憶系統)

Doctor 會在缺失時建議工作區記憶系統，並在工作區尚未受 git 管理時列印備份提示。

請參閱 [/concepts/agent-workspace](/concepts/agent-workspace) 以取得工作區結構與 git 備份（建議使用私人的 GitHub 或 GitLab）的完整指南。
