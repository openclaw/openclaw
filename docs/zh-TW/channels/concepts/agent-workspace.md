---
summary: "Agent workspace: location, layout, and backup strategy"
read_when:
  - You need to explain the agent workspace or its file layout
  - You want to back up or migrate an agent workspace
title: Agent Workspace
---

# Agent workspace

工作區是代理的家。它是唯一用於檔案工具和工作區上下文的工作目錄。請保持其私密性，並將其視為記憶。

這與 `~/.openclaw/` 分開，該部分儲存設定、憑證和會話。

**重要：** 工作區是 **預設的當前工作目錄**，而不是一個硬性的沙盒。工具會根據工作區解析相對路徑，但絕對路徑仍然可以訪問主機上的其他位置，除非啟用沙盒。如果您需要隔離，請使用 `agents.defaults.sandbox`(/gateway/sandboxing)（和/或每個代理的沙盒設定）。當沙盒啟用且 `workspaceAccess` 不是 `"rw"` 時，工具會在 `~/.openclaw/sandboxes` 下的沙盒工作區內執行，而不是在您的主機工作區內。

## Default location

- 預設: `~/.openclaw/workspace`
- 如果 `OPENCLAW_PROFILE` 被設定且 `"default"` 沒有被設定，則預設變為 `~/.openclaw/workspace-<profile>`。
- 在 `~/.openclaw/openclaw.json` 中覆蓋:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`、`openclaw configure` 或 `openclaw setup` 將會創建工作區並在缺少的情況下生成啟動檔案。沙盒種子副本僅接受常規的工作區內檔案；解析到源工作區外的符號連結/硬連結別名將被忽略。

如果您已經自行管理工作區的檔案，您可以停用引導檔案的創建：

```json5
{ agent: { skipBootstrap: true } }
```

## Extra workspace folders

舊版安裝可能已經創建了 `~/openclaw`。保留多個工作區目錄可能會導致身份驗證或狀態漂移的混淆，因為同一時間只有一個工作區是活躍的。

**建議：** 保持一個單一的活躍工作區。如果您不再使用額外的資料夾，請將它們歸檔或移動到垃圾桶（例如 `trash ~/openclaw`）。如果您故意保留多個工作區，請確保 `agents.defaults.workspace` 指向活躍的那個。

`openclaw doctor` 會在檢測到額外的工作區目錄時發出警告。

## 工作區檔案地圖（每個檔案的意義）

這些是 OpenClaw 在工作區內預期的標準檔案：

- `AGENTS.md`
  - 代理的操作指令以及如何使用記憶體。
  - 在每個會話開始時載入。
  - 設定規則、優先順序和「如何行為」的詳細資訊的好地方。

- `SOUL.md`
  - 人物、語調和界限。
  - 每次會議都已加載。

- `USER.md`
  - 使用者是誰以及如何稱呼他們。
  - 每個會話都會加載。

- `IDENTITY.md`
  - 代理人的名稱、氛圍和表情符號。
  - 在啟動儀式期間創建/更新。

- `TOOLS.md`
  - 關於您本地工具和慣例的說明。
  - 不控制工具的可用性；這僅僅是指導。

- `HEARTBEAT.md`
  - 可選的小型檢查清單，用於心跳執行。
  - 保持簡短以避免消耗 token。

- `BOOT.md`
  - 當內部鉤子啟用時，在閘道重啟時執行可選的啟動檢查清單。
  - 保持簡短；使用訊息工具進行外發傳送。

- `BOOTSTRAP.md`
  - 一次性首次執行的儀式。
  - 只為全新的工作區創建。
  - 儀式完成後刪除它。

- `memory/YYYY-MM-DD.md`
  - 每日記憶日誌（每天一個檔案）。
  - 建議在會話開始時閱讀今天和昨天的內容。

- `MEMORY.md` (可選)
  - 精選的長期記憶。
  - 僅在主要的私人會話中加載（不在共享/群組上下文中）。

請參閱 [Memory](/concepts/memory) 以了解工作流程和自動記憶體清除。

- `skills/` (可選)
  - 工作區特定技能。
  - 當名稱衝突時，會覆蓋管理的/捆綁的技能。

- `canvas/` (可選)
  - 用於節點顯示的 Canvas UI 檔案（例如 `canvas/index.html`）。

如果任何啟動檔案遺失，OpenClaw 會在會話中注入一個「缺少檔案」標記並繼續。大型啟動檔案在注入時會被截斷；可以使用 `agents.defaults.bootstrapMaxChars` 調整限制（預設值：20000）和 `agents.defaults.bootstrapTotalMaxChars`（預設值：150000）。`openclaw setup` 可以在不覆蓋現有檔案的情況下重新創建缺失的預設值。

## 工作區中不包含什麼

這些位於 `~/.openclaw/` 下，且不應該被提交到工作區的版本庫：

- `~/.openclaw/openclaw.json` (設定)
- `~/.openclaw/credentials/` (OAuth token, API 金鑰)
- `~/.openclaw/agents/<agentId>/sessions/` (會話記錄 + 元數據)
- `~/.openclaw/skills/` (管理的技能)

如果您需要遷移會話或設定，請單獨複製它們並將其保留在版本控制之外。

## Git 備份（推薦，私有）

將工作區視為私有記憶體。將其放入 **私有** git 倉庫中，以便進行備份和恢復。

在執行 Gateway 的機器上執行這些步驟（也就是工作區所在的地方）。

### 1) 初始化倉庫

如果已安裝 git，則全新的工作區會自動初始化。如果這個工作區尚未是一個版本庫，請執行：

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) 添加私人遠端（適合初學者的選項）

選項 A：GitHub 網頁介面

1. 在 GitHub 上創建一個新的 **私有** 倉庫。
2. 不要初始化 README（以避免合併衝突）。
3. 複製 HTTPS 遠端 URL。
4. 添加遠端並推送：

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

選項 B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

選項 C：GitLab 網頁介面

1. 在 GitLab 上創建一個新的 **私有** 倉庫。
2. 不要初始化 README（以避免合併衝突）。
3. 複製 HTTPS 遠端 URL。
4. 添加遠端並推送：

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3) 持續更新

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Do not commit secrets

即使在私人儲存庫中，也應避免在工作區中儲存秘密：

- API 金鑰、OAuth token、密碼或私人憑證。
- 任何在 `~/.openclaw/` 之下的內容。
- 聊天的原始轉儲或敏感附件。

如果必須儲存敏感參考，請使用佔位符並將真正的秘密儲存在其他地方（密碼管理器、環境變數或 `~/.openclaw/`）。

建議的 `.gitignore` 開始器：

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 將工作區移至新機器

1. 將資料庫克隆到所需的路徑（預設為 `~/.openclaw/workspace`）。
2. 在 `~/.openclaw/openclaw.json` 中將 `agents.defaults.workspace` 設定為該路徑。
3. 執行 `openclaw setup --workspace <path>` 以填充任何缺失的檔案。
4. 如果需要會話，請單獨從舊機器複製 `~/.openclaw/agents/<agentId>/sessions/`。

## 進階備註

- 多代理路由可以為每個代理使用不同的工作區。請參閱 [Channel routing](/channels/channel-routing) 以獲取路由設定。
- 如果 `agents.defaults.sandbox` 已啟用，非主要會話可以在 `agents.defaults.sandbox.workspaceRoot` 下使用每會話的沙盒工作區。
