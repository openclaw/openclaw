---
summary: "Agent workspace: location, layout, and backup strategy"
read_when:
  - You need to explain the agent workspace or its file layout
  - You want to back up or migrate an agent workspace
title: Agent Workspace
---

# 代理工作區

工作區是代理的家。它是唯一用於檔案工具和工作區上下文的工作目錄。請保持私密並視為記憶體。

這與 `~/.openclaw/` 分開，後者用於儲存設定、憑證和會話。

**重要：** 工作區是 **預設的當前工作目錄（cwd）**，而非嚴格的沙盒。工具會以工作區為基準解析相對路徑，但絕對路徑仍可存取主機上的其他位置，除非啟用了沙盒。如果需要隔離，請使用 [`agents.defaults.sandbox`](/gateway/sandboxing)（和／或每個代理的沙盒設定）。當啟用沙盒且 `workspaceAccess` 不等於 `"rw"` 時，工具會在 `~/.openclaw/sandboxes` 底下的沙盒工作區內運作，而非您的主機工作區。

## 預設位置

- 預設：`~/.openclaw/workspace`
- 如果設定了 `OPENCLAW_PROFILE` 且不等於 `"default"`，預設位置會變成 `~/.openclaw/workspace-<profile>`。
- 可在 `~/.openclaw/openclaw.json` 中覆寫：

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`、`openclaw configure` 或 `openclaw setup` 會在缺少時建立工作區並初始化啟動檔案。沙盒初始化複製只接受工作區內的普通檔案；解析到工作區外的符號連結／硬連結別名會被忽略。

如果您已自行管理工作區檔案，可以停用啟動檔案的建立：

```json5
{ agent: { skipBootstrap: true } }
```

## 額外的工作區資料夾

舊版安裝可能建立了 `~/openclaw`。保留多個工作區目錄可能導致認證混淆或狀態漂移，因為同一時間只會有一個工作區是啟用狀態。

**建議：** 保持單一啟用的工作區。如果不再使用額外資料夾，請將它們封存或移至垃圾桶（例如 `trash ~/openclaw`）。如果您有意保留多個工作區，請確保 `agents.defaults.workspace` 指向啟用中的工作區。

`openclaw doctor` 會在偵測到額外工作區目錄時發出警告。

## 工作區檔案對照表（各檔案的意義）

以下是 OpenClaw 預期在工作區內的標準檔案：

- `AGENTS.md`
  - 代理程式的操作說明及其如何使用記憶體。
  - 每次會話開始時載入。
  - 適合放置規則、優先順序及「行為準則」細節。

- `SOUL.md`
  - 角色設定、語氣及界限。
  - 每次會話載入。

- `USER.md`
  - 使用者身份及如何稱呼使用者。
  - 每次會話載入。

- `IDENTITY.md`
  - 代理程式的名稱、氛圍及表情符號。
  - 在啟動儀式期間建立/更新。

- `TOOLS.md`
  - 關於本地工具及慣例的備註。
  - 不控制工具可用性，僅作為指引。

- `HEARTBEAT.md`
  - 選用的心跳執行小清單。
  - 保持簡短以避免消耗過多 token。

- `BOOT.md`
  - 選用的啟動清單，於啟用內部掛勾時在閘道重啟時執行。
  - 保持簡短；對外發送請使用訊息工具。

- `BOOTSTRAP.md`
  - 一次性首次執行儀式。
  - 僅為全新工作區建立。
  - 儀式完成後請刪除。

- `memory/YYYY-MM-DD.md`
  - 每日記憶日誌（每日一檔）。
  - 建議會話開始時讀取今天及昨天的檔案。

- `MEMORY.md`（選用）
  - 精選長期記憶。
  - 僅在主要私人會話中載入（非共享/群組環境）。

請參考 [Memory](/concepts/memory) 了解工作流程及自動記憶刷新。

- `skills/`（選用）
  - 工作區專屬技能。
  - 當名稱衝突時，會覆蓋管理/捆綁技能。

- `canvas/`（選用）
  - 用於節點顯示的 Canvas UI 檔案（例如 `canvas/index.html`）。

若任何啟動檔案遺失，OpenClaw 會在會話中注入「遺失檔案」標記並繼續執行。大型啟動檔案注入時會被截斷；可透過 `agents.defaults.bootstrapMaxChars`（預設：20000）及 `agents.defaults.bootstrapTotalMaxChars`（預設：150000）調整限制。`openclaw setup` 可在不覆寫現有檔案的情況下重建遺失的預設檔案。

## 工作區中不包含的專案

這些專案位於 `~/.openclaw/`，且**不應提交**至工作區的版本庫：

- `~/.openclaw/openclaw.json`（設定檔）
- `~/.openclaw/credentials/`（OAuth token、API 金鑰）
- `~/.openclaw/agents/<agentId>/sessions/`（會話記錄與相關元資料）
- `~/.openclaw/skills/`（管理的技能）

如果需要遷移會話或設定檔，請分別複製並保持不納入版本控制。

## Git 備份（建議，私有）

將工作區視為私有記憶體。將它放在**私有**的 git 倉庫中，以便備份與還原。

請在 Gateway 執行的機器上執行以下步驟（工作區即存放於該處）。

### 1) 初始化倉庫

如果已安裝 git，新的工作區會自動初始化。如果此工作區尚未成為倉庫，請執行：

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) 新增私有遠端倉庫（適合初學者的選項）

選項 A：GitHub 網頁介面

1. 在 GitHub 上建立一個新的**私有**倉庫。
2. 不要初始化 README（避免合併衝突）。
3. 複製 HTTPS 遠端 URL。
4. 新增遠端並推送：

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

選項 B：GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

選項 C：GitLab 網頁介面

1. 在 GitLab 上建立一個新的 **私人** 倉庫。
2. 不要初始化 README（避免合併衝突）。
3. 複製 HTTPS 遠端 URL。
4. 新增遠端並推送：

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

## 請勿提交機密資訊

即使是在私人倉庫，也避免在工作區存放機密資訊：

- API 金鑰、OAuth token、密碼或私人憑證。
- 任何位於 `~/.openclaw/` 下的內容。
- 聊天記錄原始匯出或敏感附件。

如果必須存放敏感參考資料，請使用佔位符，並將真正的機密資訊保存在其他地方（密碼管理器、環境變數，或 `~/.openclaw/`）。

建議的 `.gitignore` 起始範本：

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 將工作區移至新機器

1. 將倉庫克隆到目標路徑（預設為 `~/.openclaw/workspace`）。
2. 在 `~/.openclaw/openclaw.json` 中將 `agents.defaults.workspace` 設定為該路徑。
3. 執行 `openclaw setup --workspace <path>` 以產生任何缺少的檔案。
4. 若需要會話資料，請另外從舊機器複製 `~/.openclaw/agents/<agentId>/sessions/`。

## 進階說明

- 多代理路由可以為每個代理使用不同的工作區。請參考[頻道路由](/channels/channel-routing)以了解路由設定。
- 如果啟用`agents.defaults.sandbox`，非主要會話可以在`agents.defaults.sandbox.workspaceRoot`下使用每個會話的沙盒工作區。
