---
summary: "代理程式工作區：位置、版面配置與備份策略"
read_when:
  - 你需要說明代理程式工作區或其檔案配置
  - 你想要備份或遷移代理程式工作區
title: "代理程式工作區"
---

# 代理程式工作區

The workspace is the agent's home. It is the only working directory used for
file tools and for workspace context. Keep it private and treat it as memory.

This is separate from `~/.openclaw/`, which stores config, credentials, and
sessions.

**Important:** the workspace is the **default cwd**, not a hard sandbox. 1. 工具
會相對於工作區解析相對路徑，但除非啟用沙箱，否則絕對路徑仍可存取主機上的其他位置。 2. 若需要隔離，請使用
[`agents.defaults.sandbox`](/gateway/sandboxing)（以及/或每個代理的沙箱設定）。
3. 啟用沙箱且 `workspaceAccess` 不是 `"rw"` 時，工具會在 `~/.openclaw/sandboxes` 下的沙箱工作區中運作，而不是你的主機工作區。

## 預設位置

- 預設：`~/.openclaw/workspace`
- 若設定了 `OPENCLAW_PROFILE` 且不是 `"default"`，預設位置會變為
  `~/.openclaw/workspace-<profile>`。
- 可在 `~/.openclaw/openclaw.json` 中覆寫：

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

4. `openclaw onboard`、`openclaw configure` 或 `openclaw setup` 會在缺少時建立工作區並植入啟動檔案。

如果你已自行管理工作區檔案，可以停用啟動檔案建立：

```json5
{ agent: { skipBootstrap: true } }
```

## 額外的工作區資料夾

5. 較舊的安裝可能建立了 `~/openclaw`。 6. 同時保留多個工作區目錄可能造成驗證或狀態漂移的混淆，因為一次只會有一個工作區處於啟用狀態。

7. **建議：** 保持單一啟用中的工作區。 8. 若不再使用多餘的資料夾，請將其封存或移到垃圾桶（例如 `trash ~/openclaw`）。
   **建議：** 保留單一作用中的工作區。若不再使用額外資料夾，請將其封存或移至垃圾桶（例如 `trash ~/openclaw`）。若你刻意保留多個工作區，請確保 `agents.defaults.workspace` 指向目前作用中的那一個。

`openclaw doctor` 會在偵測到額外工作區目錄時發出警告。

## 9. 工作區檔案對照表（各檔案的用途）

以下是 OpenClaw 在工作區內預期的標準檔案：

- `AGENTS.md`
  - 代理程式的操作指示，以及如何使用記憶。
  - 10. 在每個工作階段開始時載入。
  - 適合放置規則、優先順序與「行為方式」細節。

- `SOUL.md`
  - 11. 人設、語氣與界線。
  - 12. 每個工作階段都會載入。

- `USER.md`
  - 使用者是誰，以及該如何稱呼。
  - 13. 每個工作階段都會載入。

- `IDENTITY.md`
  - 14. 代理的名稱、氛圍與表情符號。
  - 15. 在啟動儀式期間建立/更新。

- `TOOLS.md`
  - 關於你本地工具與慣例的備註。
  - 不會控制工具可用性；僅作為指引。

- `HEARTBEAT.md`
  - 心跳執行的可選微型檢查清單。
  - 請保持精簡以避免消耗過多 token。

- `BOOT.md`
  - 16. 啟用內部掛鉤時，於閘道重新啟動時執行的選用啟動檢查清單。
  - 17. 保持精簡；對外傳送請使用訊息工具。

- `BOOTSTRAP.md`
  - 一次性的首次執行儀式。
  - 18. 僅在全新工作區時建立。
  - 儀式完成後請刪除。

- `memory/YYYY-MM-DD.md`
  - 每日記憶紀錄（每天一個檔案）。
  - 19. 建議在工作階段開始時閱讀今天 + 昨天的內容。

- `MEMORY.md`（可選）
  - 精選的長期記憶。
  - 20. 僅在主要的私人工作階段中載入（非共享/群組情境）。

21. 有關流程與自動記憶體清空，請參見 [Memory](/concepts/memory)。

- `skills/`（可選）
  - 工作區專屬 Skills。
  - 當名稱衝突時，會覆寫受管／隨附的 Skills。

- `canvas/`（可選）
  - 用於節點顯示的 Canvas UI 檔案（例如 `canvas/index.html`）。

22. 若任何啟動檔案缺失，OpenClaw 會將「缺少檔案」標記注入到工作階段中並繼續。 23. 大型啟動檔在注入時會被裁切；可透過 `agents.defaults.bootstrapMaxChars` 調整上限（預設：20000）。
23. `openclaw setup` 可在不覆寫現有檔案的情況下重建缺失的預設值。

## 25. 工作區中**不**包含的內容

26. 這些位於 `~/.openclaw/` 下，且**不應**提交到工作區儲存庫：

- `~/.openclaw/openclaw.json`（設定）
- `~/.openclaw/credentials/`（OAuth 權杖、API 金鑰）
- `~/.openclaw/agents/<agentId>/sessions/`（工作階段逐字稿與中繼資料）
- `~/.openclaw/skills/`（受管 Skills）

27. 若需要遷移工作階段或設定，請分別複製它們並將其排除在版本控制之外。

## Git 備份（建議，私有）

28. 將工作區視為私人記憶。 29. 將其放在**私人** git 儲存庫中，以便備份與復原。

30. 請在執行 Gateway 的機器上執行以下步驟（工作區位於該處）。

### 1）初始化儲存庫

若已安裝 git，全新的工作區會自動初始化。若此工作區尚未是儲存庫，請執行： 31. 若此工作區尚未成為儲存庫，請執行：

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2）新增私有遠端（適合新手的選項）

選項 A：GitHub 網頁 UI

1. 在 GitHub 建立新的 **私有** 儲存庫。
2. 不要以 README 初始化（避免合併衝突）。
3. 複製 HTTPS 遠端 URL。
4. 32. 新增遠端並推送：

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

選項 B：GitHub CLI（`gh`）

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

選項 C：GitLab 網頁 UI

1. 在 GitLab 建立新的 **私有** 儲存庫。
2. 不要以 README 初始化（避免合併衝突）。
3. 複製 HTTPS 遠端 URL。
4. 33. 新增遠端並推送：

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3）持續更新

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## 34. 請勿提交機密資料

即使在私有儲存庫中，也請避免在工作區儲存機密：

- API 金鑰、OAuth 權杖、密碼或私有憑證。
- `~/.openclaw/` 之下的任何內容。
- 原始聊天轉存或敏感附件。

若必須儲存敏感參考，請使用佔位符，並將真正的機密保存在其他地方（密碼管理器、環境變數或 `~/.openclaw/`）。

建議的 `.gitignore` 起始範本：

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## 將工作區移至新機器

1. 將儲存庫複製到目標路徑（預設為 `~/.openclaw/workspace`）。
2. 在 `~/.openclaw/openclaw.json` 中將 `agents.defaults.workspace` 設為該路徑。
3. 執行 `openclaw setup --workspace <path>` 以植入任何缺失的檔案。
4. 若需要工作階段，請另行從舊機器複製 `~/.openclaw/agents/<agentId>/sessions/`。

## 35) 進階說明

- 36. 多代理路由可為每個代理使用不同的工作區。 37. 路由設定請參見
      [Channel routing](/channels/channel-routing)。
- 若啟用 `agents.defaults.sandbox`，非主要工作階段可在 `agents.defaults.sandbox.workspaceRoot` 之下使用每個工作階段的沙箱工作區。
