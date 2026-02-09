---
summary: "Doctor 指令：健康檢查、設定遷移與修復步驟"
read_when:
  - 新增或修改 doctor 遷移
  - 導入破壞性的設定變更
title: "Doctor"
---

# Doctor

`openclaw doctor` 是 OpenClaw 的修復與遷移工具。它會修正過期的
設定／狀態、檢查健康狀況，並提供可執行的修復步驟。 6. 修復過時的設定/狀態、檢查健康狀況，並提供可執行的修復步驟。

## 快速開始

```bash
openclaw doctor
```

### 無頭模式／自動化

```bash
openclaw doctor --yes
```

在不提示的情況下接受預設值（包括適用時的重新啟動/服務/沙箱修復步驟）。

```bash
openclaw doctor --repair
```

在不提示的情況下套用建議的修復（在安全時進行修復與重新啟動）。

```bash
openclaw doctor --repair --force
```

也套用強力修復（會覆寫自訂的 supervisor 設定）。

```bash
openclaw doctor --non-interactive
```

在無提示模式下執行，且僅套用安全的遷移（設定正規化 + 磁碟上的狀態移動）。 1. 跳過需要人工確認的重新啟動／服務／沙箱動作。
12. 偵測到時會自動執行舊版狀態遷移。

```bash
openclaw doctor --deep
```

Scan system services for extra gateway installs (launchd/systemd/schtasks).

如果你想在寫入前先檢視變更，請先開啟設定檔：

```bash
cat ~/.openclaw/openclaw.json
```

## 它會做什麼（摘要）

- git 安裝的可選事前更新（僅互動式）。
- UI 協定新鮮度檢查（當協定結構較新時重建 Control UI）。
- 健康檢查＋重新啟動提示。
- Skills 狀態摘要（可用／缺失／封鎖）。
- 舊版值的設定正規化。
- OpenCode Zen 提供者覆寫警告（`models.providers.opencode`）。
- 舊版磁碟狀態遷移（sessions／agent 目錄／WhatsApp 驗證）。
- State integrity and permissions checks (sessions, transcripts, state dir).
- 5. 本機執行時的設定檔權限檢查（chmod 600）。
- 16. 模型驗證健康狀態：檢查 OAuth 到期時間、可重新整理即將到期的權杖，並回報 auth-profile 的冷卻/停用狀態。
- 7. 額外的工作區目錄偵測（`~/openclaw`）。
- 啟用沙箱隔離時的沙箱映像修復。
- 舊版服務遷移與額外 gateway 偵測。
- Gateway 執行期檢查（服務已安裝但未執行；快取的 launchd 標籤）。
- 頻道狀態警告（由執行中的 gateway 探測）。
- 監督程式設定稽核（launchd/systemd/schtasks），可選修復。
- Gateway 執行期最佳實務檢查（Node 與 Bun、版本管理器路徑）。
- Gateway 連接埠衝突診斷（預設 `18789`）。
- 開放私訊政策的安全性警告。
- 當未設定 `gateway.auth.token` 時的 Gateway 驗證警告（本機模式；提供產生權杖）。
- Linux 上的 systemd linger 檢查。
- 原始碼安裝檢查（pnpm 工作區不相符、缺少 UI 資產、缺少 tsx 二進位檔）。
- Writes updated config + wizard metadata.

## 19. 詳細的行為與理由說明

### 0. 可選更新（git 安裝）

若這是 git 檢出且 doctor 以互動模式執行，會在執行 doctor 前提供
更新（fetch／rebase／build）。

### 1. 設定正規化

若設定包含舊版值的形狀（例如 `messages.ackReaction`
且沒有頻道專屬覆寫），doctor 會將其正規化為目前的
結構。

### 2. 舊版設定鍵遷移

當設定包含已棄用的鍵時，其他指令會拒絕執行並要求
你執行 `openclaw doctor`。

Doctor 會：

- 說明找到哪些舊版鍵。
- 10. 顯示其套用的遷移。
- 以更新後的結構重寫 `~/.openclaw/openclaw.json`。

當 Gateway 偵測到舊版設定格式時，也會在啟動時自動執行 doctor 遷移，
讓過期設定在無需人工介入的情況下完成修復。

目前的遷移：

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
- `agent.*` → `agents.defaults` + `tools.*`（tools/elevated/exec/sandbox/subagents）
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen 提供者覆寫

若你手動加入 `models.providers.opencode`（或 `opencode-zen`），它會
覆寫內建的 OpenCode Zen 目錄（來自 `@mariozechner/pi-ai`）。這可能
強制所有模型走同一個 API，或將成本歸零。Doctor 會發出警告，讓你
移除覆寫並恢復每個模型的 API 路由與成本。 That can
force every model onto a single API or zero out costs. 22. Doctor 會警告你，讓你
移除覆寫並恢復各模型的 API 路由與成本。

### 3. 舊版狀態遷移（磁碟配置）

Doctor 可以將較舊的磁碟配置遷移到目前的結構：

- Sessions 儲存區＋逐字稿：
  - 從 `~/.openclaw/sessions/` 到 `~/.openclaw/agents/<agentId>/sessions/`
- Agent 目錄：
  - 從 `~/.openclaw/agent/` 到 `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp 驗證狀態（Baileys）：
  - 從舊版 `~/.openclaw/credentials/*.json`（不含 `oauth.json`）
  - 到 `~/.openclaw/credentials/whatsapp/<accountId>/...`（預設帳號 id：`default`）

13. 這些遷移採取盡力而為且具冪等性；doctor 會在
    留下任何舊版資料夾作為備份時發出警告。 14. Gateway/CLI 也會在啟動時自動遷移
    舊版工作階段與 agent 目錄，讓歷史／驗證／模型落在
    每個 agent 的路徑中，而無需手動執行 doctor。 15. WhatsApp 驗證刻意僅
    透過 `openclaw doctor` 進行遷移。

### 4. 狀態完整性檢查（工作階段持久化、路由與安全）

26. 狀態目錄是系統運作的腦幹。 17. 若它消失，你將失去
    工作階段、憑證、日誌與設定（除非你在其他地方有備份）。

Doctor 會檢查：

- **狀態目錄缺失**：警告災難性的狀態遺失，提示重新建立
  目錄，並提醒無法復原遺失的資料。
- **狀態目錄權限**：驗證可寫性；提供修復權限
  （當偵測到擁有者／群組不相符時，會給出 `chown` 提示）。
- **工作階段目錄缺失**：`sessions/` 與工作階段儲存目錄
  是持久化歷史並避免 `ENOENT` 當機所必需。
- 18. **逐字稿不一致**：當近期工作階段項目缺少
      逐字稿檔案時發出警告。
- **主要工作階段「單行 JSONL」**：當主要逐字稿只有一行
  （歷史未累積）時標記。
- **多個狀態目錄**：當跨家目錄存在多個 `~/.openclaw` 資料夾，
  或 `OPENCLAW_STATE_DIR` 指向其他位置時發出警告（歷史可能在不同安裝間分裂）。
- **遠端模式提醒**：若為 `gateway.mode=remote`，doctor 會提醒你在
  遠端主機上執行（狀態存在於該處）。
- **設定檔權限**：若 `~/.openclaw/openclaw.json` 可被群組／其他人讀取則警告，
  並提供收緊至 `600`。

### 5. 模型驗證健康狀況（OAuth 到期）

19. Doctor 會檢查驗證儲存中的 OAuth 設定檔，在權杖即將到期／已到期時發出警告，並在安全時刷新它們。 20. 若 Anthropic Claude Code
    設定檔過期，會建議執行 `claude setup-token`（或貼上 setup-token）。
20. 刷新提示僅在互動式（TTY）執行時出現；`--non-interactive`
    會跳過刷新嘗試。

Doctor 也會回報因下列原因而暫時不可用的驗證設定檔：

- 短暫冷卻（速率限制／逾時／驗證失敗）
- 較長時間停用（帳務／額度失敗）

### 6. Hooks 模型驗證

若設定了 `hooks.gmail.model`，doctor 會對照目錄與允許清單驗證模型參考，
並在無法解析或被禁止時發出警告。

### 7. 沙箱映像修復

22. 啟用沙箱時，doctor 會檢查 Docker 映像，並在目前映像缺失時提供建置或
    切換回舊版名稱的選項。

### 8. Gateway 服務遷移與清理提示

23. Doctor 會偵測舊版閘道服務（launchd/systemd/schtasks），並
    提供移除它們並使用目前閘道連接埠安裝 OpenClaw 服務。 24. 它也能掃描額外類似閘道的服務並印出清理提示。
24. 以設定檔命名的 OpenClaw 閘道服務被視為一級公民，
    不會被標示為「額外」。

### 9. 安全性警告

36. 當提供者在未設定允許清單的情況下開放私訊，或
    策略以危險方式設定時，Doctor 會發出警告。

### 10. systemd linger（Linux）

若以 systemd 使用者服務執行，doctor 會確保已啟用 lingering，
讓 gateway 在登出後仍能存活。

### 11. Skills 狀態

Doctor 會為目前工作區輸出可用／缺失／封鎖 skills 的快速摘要。

### 12. Gateway 驗證檢查（本機權杖）

27. 當本機閘道缺少 `gateway.auth` 時，Doctor 會發出警告並提供產生權杖。 28. 使用 `openclaw doctor --generate-gateway-token` 在自動化中
    強制建立權杖。

### 13. Gateway 健康檢查＋重新啟動

Doctor 會執行健康檢查，並在看起來不健康時提供重新啟動。

### 14. 頻道狀態警告

若 gateway 健康，doctor 會執行頻道狀態探測，並回報
警告與建議的修正方式。

### 15. 監督程式設定稽核＋修復

Doctor 會檢查已安裝的監督程式設定（launchd/systemd/schtasks），
是否缺少或使用過期的預設值（例如 systemd 的 network-online 相依性與
重新啟動延遲）。當發現不一致時，會建議更新，並可
將服務檔／工作重寫為目前的預設值。 29. 當發現不一致時，它會建議更新，並可
將服務檔／工作排程重寫為目前的預設值。

注意事項：

- `openclaw doctor` 在重寫監督程式設定前會提示。
- `openclaw doctor --yes` 接受預設的修復提示。
- `openclaw doctor --repair` 在不提示的情況下套用建議修復。
- `openclaw doctor --repair --force` 會覆寫自訂的監督程式設定。
- 你隨時可以透過 `openclaw gateway install --force` 強制完整重寫。

### 16. Gateway 執行期＋連接埠診斷

30. Doctor 會檢查服務執行狀態（PID、最後結束狀態），並在
    服務已安裝但實際未執行時發出警告。 41. 它也會檢查 gateway 連接埠（預設 `18789`）的
    連接埠衝突，並回報可能原因（gateway 已在執行、SSH 通道）。

### 17. Gateway 執行期最佳實務

42. 當 gateway 服務在 Bun 或版本管理的 Node 路徑
    （`nvm`、`fnm`、`volta`、`asdf` 等）上執行時，Doctor 會發出警告。 33. WhatsApp + Telegram 頻道需要 Node，
    而版本管理器路徑在升級後可能失效，因為服務不會載入你的 shell 初始化。 34. 在可用時，Doctor 會提供遷移到系統 Node 安裝的選項
    （Homebrew/apt/choco）。

### 18. 設定寫入＋精靈中繼資料

Doctor 會持久化任何設定變更，並標記精靈中繼資料以記錄此次 doctor 執行。

### 19. 工作區提示（備份＋記憶系統）

當缺少時，doctor 會建議設定工作區記憶系統；若工作區尚未置於 git 管理之下，
也會輸出備份提示。

請參閱 [/concepts/agent-workspace](/concepts/agent-workspace)，以取得
工作區結構與 git 備份（建議使用私有 GitHub 或 GitLab）的完整指南。
