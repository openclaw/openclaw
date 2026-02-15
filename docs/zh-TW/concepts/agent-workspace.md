---
summary: "智慧代理工作區：位置、佈局與備份策略"
read_when:
  - 您需要解釋智慧代理工作區或其檔案佈局時
  - 您想要備份或遷移智慧代理工作區時
title: "智慧代理工作區"
---

# 智慧代理工作區

工作區是智慧代理的家。它是唯一用於檔案工具和工作區內容的目前工作目錄。請保持其私密性並將其視為記憶體。

這與儲存設定、憑證和工作階段的 `~/.openclaw/` 是分開的。

**重要提示：** 工作區是 **預設的目前工作目錄 (cwd)**，而非強制的沙箱。工具會根據工作區解析相對路徑，但除非啟用了沙箱隔離，否則絕對路徑仍可存取主機上的其他位置。如果您需要隔離，請使用 [`agents.defaults.sandbox`](/gateway/sandboxing)（及/或個別智慧代理的沙箱設定）。當啟用沙箱隔離且 `workspaceAccess` 不是 `"rw"` 時，工具會在 `~/.openclaw/sandboxes` 下的沙箱工作區內運作，而不是您的主機工作區。

## 預設位置

- 預設值：`~/.openclaw/workspace`
- 如果設定了 `OPENCLAW_PROFILE` 且不是 `"default"`，預設值將變為 `~/.openclaw/workspace-<profile>`。
- 在 `~/.openclaw/openclaw.json` 中覆蓋：

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`、`openclaw configure` 或 `openclaw setup` 會在工作區遺失時建立工作區並植入引導檔案 (bootstrap files)。

如果您已經自行管理工作區檔案，可以停用引導檔案建立：

```json5
{ agent: { skipBootstrap: true } }
```

## 額外的工作區資料夾

較舊的安裝版本可能會建立 `~/openclaw`。保留多個工作區目錄可能會導致混淆的驗證或狀態偏差，因為一次只能啟用一個工作區。

**建議：** 保持單一使用中的工作區。如果您不再使用額外的資料夾，請將其封存或移至垃圾桶（例如 `trash ~/openclaw`）。如果您刻意保留多個工作區，請確保 `agents.defaults.workspace` 指向目前使用中的工作區。

`openclaw doctor` 會在偵測到額外的工作區目錄時發出警告。

## 工作區檔案對照表（各檔案的意義）

以下是 OpenClaw 預期在工作區內包含的標準檔案：

- `AGENTS.md`
  - 智慧代理的作業指令以及其應如何使用記憶體。
  - 在每個工作階段開始時載入。
  - 適合放置規則、優先級和「行為方式」細節的地方。

- `SOUL.md`
  - 人格設定、語氣和界限。
  - 每個工作階段都會載入。

- `USER.md`
  - 使用者是誰以及如何稱呼他們。
  - 每個工作階段都會載入。

- `IDENTITY.md`
  - 智慧代理的名稱、氛圍和表情符號。
  - 在引導儀式 (bootstrap ritual) 期間建立/更新。

- `TOOLS.md`
  - 關於您的本地工具和慣例的筆記。
  - 不控制工具的可用性；僅作為指引。

- `HEARTBEAT.md`
  - 選用的心跳執行 (heartbeat runs) 微型清單。
  - 請保持簡短以避免消耗過多 Token。

- `BOOT.md`
  - 選用的啟動清單，在啟用內部 hook 時於 Gateway 重啟時執行。
  - 請保持簡短；使用訊息工具進行對外傳送。

- `BOOTSTRAP.md`
  - 一次性的初次執行儀式。
  - 僅為全新的工作區建立。
  - 在儀式完成後將其刪除。

- `memory/YYYY-MM-DD.md`
  - 每日記憶日誌（每天一個檔案）。
  - 建議在工作階段開始時讀取今天 + 昨天。

- `MEMORY.md`（選用）
  - 精選的長期記憶。
  - 僅在主要的私人工作階段中載入（不適用於共享/群組情境）。

請參閱 [記憶體](/concepts/memory) 了解工作流程和自動記憶體清除。

- `skills/`（選用）
  - 工作區專屬的 Skills。
  - 當名稱衝突時會覆蓋受管理/內建的 Skills。

- `canvas/`（選用）
  - 用於節點顯示的 Canvas UI 檔案（例如 `canvas/index.html`）。

如果遺失任何引導檔案，OpenClaw 會在工作階段中插入「檔案遺失」標記並繼續。大型引導檔案在插入時會被截斷；請使用 `agents.defaults.bootstrapMaxChars` 調整限制（預設值：20000）。`openclaw setup` 可以重新建立遺失的預設值，而不會覆蓋現有檔案。

## 哪些內容不在工作區中

這些內容位於 `~/.openclaw/` 下，**不應**提交到工作區儲存庫：

- `~/.openclaw/openclaw.json` (設定)
- `~/.openclaw/credentials/` (OAuth 權杖、API 金鑰)
- `~/.openclaw/agents/<agentId>/sessions/` (工作階段逐字稿 + 中繼資料)
- `~/.openclaw/skills/` (受管理的 Skills)

如果您需要遷移工作階段或設定，請分別複製它們，並將其排除在版本控制之外。

## Git 備份（建議使用，私人）

將工作區視為私密記憶體。將其放在 **私人 (private)** git 儲存庫中，以便備份和恢復。

在執行 Gateway 的機器上執行這些步驟（那是工作區所在的位置）。

### 1) 初始化儲存庫

如果已安裝 git，全新的工作區會自動初始化。如果此工作區尚未成為儲存庫，請執行：

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) 新增私人遠端 (建議初學者的選項)

選項 A：GitHub 網頁介面

1. 在 GitHub 上建立一個新的 **私人 (private)** 儲存庫。
2. 不要使用 README 初始化（避免合併衝突）。
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

1. 在 GitLab 上建立一個新的 **私人 (private)** 儲存庫。
2. 不要使用 README 初始化（避免合併衝突）。
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

## 不要提交機密資訊

即使在私人儲存庫中，也要避免在工作區中儲存機密：

- API 金鑰、OAuth 權杖、密碼或私密憑證。
- `~/.openclaw/` 下的任何內容。
- 聊天內容的原始傾印 (Raw dumps) 或敏感附件。

如果您必須儲存敏感參考，請使用佔位符並將真正的機密儲存在其他地方（密碼管理員、環境變數或 `~/.openclaw/`）。

建議的 `.gitignore` 起始設定：

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 將工作區移至新機器

1. 將儲存庫複製 (Clone) 到所需路徑（預設為 `~/.openclaw/workspace`）。
2. 在 `~/.openclaw/openclaw.json` 中將 `agents.defaults.workspace` 設定為該路徑。
3. 執行 `openclaw setup --workspace <path>` 以植入任何遺失的檔案。
4. 如果您需要工作階段，請分別從舊機器複製 `~/.openclaw/agents/<agentId>/sessions/`。

## 進階說明

- 多智慧代理路由可以為每個智慧代理使用不同的工作區。請參閱 [頻道路由](/channels/channel-routing) 了解路由設定。
- 如果啟用了 `agents.defaults.sandbox`，非主要工作階段可以使用 `agents.defaults.sandbox.workspaceRoot` 下的個別工作階段沙箱工作區。
