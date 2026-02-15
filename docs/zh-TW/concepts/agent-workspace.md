---
summary: "智慧代理工作區：位置、佈局和備份策略"
read_when:
  - 您需要解釋智慧代理工作區或其檔案佈局
  - 您想要備份或遷移智慧代理工作區
title: "智慧代理工作區"
---

# 智慧代理工作區

工作區是智慧代理的家。它是檔案工具和工作區上下文使用的唯一工作目錄。請保持其私密性並將其視為記憶體。

這與 `~/.openclaw/` 分開，後者儲存設定、憑證和工作階段。

**重要提示：** 工作區是 **預設的當前工作目錄 (cwd)**，而不是硬性沙箱。工具會根據工作區解析相對路徑，但絕對路徑仍可存取主機上的其他位置，除非啟用沙箱隔離。如果您需要隔離，請使用 [`agents.defaults.sandbox`](/gateway/sandboxing) (以及/或每個智慧代理的沙箱設定)。當啟用沙箱隔離且 `workspaceAccess` 不是 `"rw"` 時，工具會在 `~/.openclaw/sandboxes` 下的沙箱隔離工作區中操作，而不是在您的主機工作區中。

## 預設位置

- 預設：`~/.openclaw/workspace`
- 如果 `OPENCLAW_PROFILE` 已設定且不是 `"default"`，則預設會變成 `~/.openclaw/workspace-<profile>`。
- 在 `~/.openclaw/openclaw.json` 中覆寫：

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`、`openclaw configure` 或 `openclaw setup` 將會建立工作區並在缺少引導檔案時植入這些檔案。

如果您已經自行管理工作區檔案，您可以停用引導檔案建立：

```json5
{ agent: { skipBootstrap: true } }
```

## 額外的工作區檔案夾

較舊的安裝可能已建立 `~/openclaw`。保留多個工作區目錄可能會導致混淆的憑證或狀態漂移，因為一次只有一個工作區是啟用的。

**建議：** 僅保留一個啟用的工作區。如果您不再使用額外的檔案夾，請將它們封存或移至垃圾桶 (例如 `trash ~/openclaw`)。如果您有意保留多個工作區，請確保 `agents.defaults.workspace` 指向啟用的工作區。

`openclaw doctor` 會在偵測到額外工作區目錄時發出警告。

## 工作區檔案對應 (每個檔案的意義)

以下是 OpenClaw 預期在工作區內的標準檔案：

- `AGENTS.md`
  - 智慧代理的操作說明以及如何使用記憶體。
  - 在每個工作階段開始時載入。
  - 放置規則、優先順序和「如何行為」詳細資訊的好地方。

- `SOUL.md`
  - 人設、語氣和界限。
  - 每個工作階段都會載入。

- `USER.md`
  - 使用者是誰以及如何稱呼他們。
  - 每個工作階段都會載入。

- `IDENTITY.md`
  - 智慧代理的名稱、氛圍和表情符號。
  - 在引導儀式期間建立/更新。

- `TOOLS.md`
  - 關於您本機工具和慣例的筆記。
  - 不控制工具可用性；它僅提供指南。

- `HEARTBEAT.md`
  - 心跳執行的可選小型核對清單。
  - 保持簡短以避免 token 消耗。

- `BOOT.md`
  - 在啟用內部掛鉤時，Gateway 重新啟動時執行的可選啟動核對清單。
  - 保持簡短；使用訊息工具進行對外傳送。

- `BOOTSTRAP.md`
  - 一次性的首次執行儀式。
  - 僅為全新的工作區建立。
  - 儀式完成後將其刪除。

- `memory/YYYY-MM-DD.md`
  - 每日記憶體日誌 (每天一個檔案)。
  - 建議在工作階段開始時閱讀今天 + 昨天。

- `MEMORY.md` (可選)
  - 策劃的長期記憶體。
  - 僅在主要、私密工作階段載入 (不適用於共享/群組上下文)。

請參閱 [記憶體](/concepts/memory) 以了解工作流程和自動記憶體清除。

- `skills/` (可選)
  - 工作區特定的 Skills。
  - 當名稱衝突時，會覆寫受管理/捆綁的 Skills。

- `canvas/` (可選)
  - 用於節點顯示的 Canvas UI 檔案 (例如 `canvas/index.html`)。

如果任何引導檔案遺失，OpenClaw 會在工作階段中注入「遺失檔案」標記並繼續。大型引導檔案在注入時會被截斷；請使用 `agents.defaults.bootstrapMaxChars` (預設：20000) 調整限制。`openclaw setup` 可以重新建立遺失的預設值，而無需覆寫現有檔案。

## 工作區中「沒有」的內容

這些內容位於 `~/.openclaw/` 下，並且不應提交到工作區儲存庫：

- `~/.openclaw/openclaw.json` (設定)
- `~/.openclaw/credentials/` (OAuth 權杖、API 金鑰)
- `~/.openclaw/agents/<agentId>/sessions/` (工作階段轉錄本 + 中繼資料)
- `~/.openclaw/skills/` (受管理的 Skills)

如果您需要遷移工作階段或設定，請單獨複製它們並將它們保留在版本控制之外。

## Git 備份 (建議，私密)

將工作區視為私密記憶體。將其放入 **私密** Git 儲存庫，以便進行備份和恢復。

在執行 Gateway 的機器上執行這些步驟 (也就是工作區所在的位置)。

### 1) 初始化儲存庫

如果已安裝 Git，則會自動初始化全新的工作區。如果此工作區尚未是儲存庫，請執行：

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) 新增私密遠端 (對初學者友好的選項)

選項 A: GitHub 網頁使用者介面

1. 在 GitHub 上建立一個新的 **私密** 儲存庫。
2. 不要使用 README 初始化 (避免合併衝突)。
3. 複製 HTTPS 遠端 URL。
4. 新增遠端並推送：

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

選項 C: GitLab 網頁使用者介面

1. 在 GitLab 上建立一個新的 **私密** 儲存庫。
2. 不要使用 README 初始化 (避免合併衝突)。
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

## 不要提交密鑰

即使在私密儲存庫中，也要避免在工作區中儲存密鑰：

- API 金鑰、OAuth 權杖、密碼或私密憑證。
- `~/.openclaw/` 下的任何內容。
- 原始聊天轉儲或敏感附件。

如果您必須儲存敏感參考，請使用佔位符並將真正的密鑰儲存在其他地方 (密碼管理器、環境變數或 `~/.openclaw/`)。

建議的 `.gitignore` 啟動器：

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 將工作區移至新機器

1. 將儲存庫複製到所需的路徑 (預設 `~/.openclaw/workspace`)。
2. 在 `~/.openclaw/openclaw.json` 中將 `agents.defaults.workspace` 設定為該路徑。
3. 執行 `openclaw setup --workspace <path>` 以植入任何遺失的檔案。
4. 如果您需要工作階段，請單獨從舊機器複製 `~/.openclaw/agents/<agentId>/sessions/`。

## 進階注意事項

- 多智慧代理路由可以為每個智慧代理使用不同的工作區。請參閱 [頻道路由](/channels/channel-routing) 以了解路由設定。
- 如果啟用 `agents.defaults.sandbox`，非主要工作階段可以使用 `agents.defaults.sandbox.workspaceRoot` 下的每個工作階段沙箱隔離工作區。
