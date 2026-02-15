---
summary: "Skills: 受管理與工作區、閘控規則，以及設定/環境接線"
read_when:
  - 新增或修改技能
  - 更改技能閘控或載入規則
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw 使用 **[AgentSkills](https://agentskills.io) 相容**的技能檔案夾來教導智慧代理如何使用工具。每個技能都是一個目錄，其中包含一個帶有 YAML 前置資料和說明的 `SKILL.md`。OpenClaw 會載入**綁定技能**以及選用的本地覆寫，並在載入時根據環境、設定和二進位檔案是否存在來篩選它們。

## 位置與優先順序

Skills 會從**三個**地方載入：

1. **綁定技能**：隨安裝（npm 套件或 OpenClaw.app）一起發貨
2. **受管理/本地技能**：`~/.openclaw/skills`
3. **工作區技能**：`<workspace>/skills`

如果技能名稱衝突，優先順序為：

`<workspace>/skills`（最高）→ `~/.openclaw/skills` → 綁定技能（最低）

此外，您可以透過 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 設定額外的技能檔案夾（最低優先順序）。

## 每位智慧代理專用與共用技能

在**多智慧代理**設定中，每個智慧代理都有自己的工作區。這意味著：

- **每位智慧代理專用技能**僅存在於該智慧代理的 `<workspace>/skills` 中。
- **共用技能**存在於 `~/.openclaw/skills`（受管理/本地），並且對同一機器上的**所有智慧代理**可見。
- 如果您希望多個智慧代理使用共同的技能包，也可以透過 `skills.load.extraDirs` 新增**共用檔案夾**（最低優先順序）。

如果同一個技能名稱存在於多個位置，則適用於通常的優先順序：工作區優先，然後是受管理/本地，最後是綁定。

## 外掛程式 + 技能

外掛程式可以透過在 `openclaw.plugin.json` 中列出 `skills` 目錄（路徑相對於外掛程式根目錄）來提供自己的技能。外掛程式技能在外掛程式啟用時載入，並參與正常的技能優先順序規則。您可以透過外掛程式設定條目上的 `metadata.openclaw.requires.config` 來閘控它們。請參閱 [Plugins](/tools/plugin) 了解裝置探索/設定，並參閱 [Tools](/tools) 了解這些技能所教導的工具介面。

## ClawHub (安裝 + 同步)

ClawHub 是 OpenClaw 的公共技能註冊中心。請瀏覽 [https://clawhub.com](https://clawhub.com)。使用它來探索、安裝、更新和備份技能。完整指南：[ClawHub](/tools/clawhub)。

常用流程：

- 將技能安裝到您的工作區：
  - `clawhub install <skill-slug>`
- 更新所有已安裝的技能：
  - `clawhub update --all`
- 同步（掃描 + 發佈更新）：
  - `clawhub sync --all`

依預設，`clawhub` 會將技能安裝到您目前工作目錄下的 `./skills`（或退回到已設定的 OpenClaw 工作區）。OpenClaw 會在下一個工作階段將其作為 `<workspace>/skills` 載入。

## 安全注意事項

- 將第三方技能視為**不受信任的程式碼**。在啟用前閱讀它們。
- 對於不受信任的輸入和有風險的工具，請優先使用沙箱隔離執行。請參閱 [Sandboxing](/gateway/sandboxing)。
- `skills.entries.*.env` 和 `skills.entries.*.apiKey` 會將密鑰注入到該智慧代理執行回合的 **host** 程式中（而非沙箱）。請勿將密鑰洩漏到提示和日誌中。
- 有關更廣泛的威脅模型和檢查清單，請參閱 [Security](/gateway/security)。

## 格式 (AgentSkills + Pi 相容)

`SKILL.md` 必須至少包含：

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

注意事項：

- 我們遵循 AgentSkills 規範的佈局/意圖。
- 嵌入式智慧代理使用的解析器僅支援**單行**前置資料鍵名。
- `metadata` 應該是**單行 JSON 物件**。
- 在說明中使用 `{baseDir}` 來引用技能檔案夾路徑。
- 選用的前置資料鍵名：
  - `homepage` — 在 macOS Skills UI 中顯示為「網站」的 URL（也透過 `metadata.openclaw.homepage` 支援）。
  - `user-invocable` — `true|false` (預設值: `true`)。當為 `true` 時，技能會作為使用者斜線命令公開。
  - `disable-model-invocation` — `true|false` (預設值: `false`)。當為 `true` 時，技能會從模型提示中排除（仍可透過使用者調用使用）。
  - `command-dispatch` — `tool` (選用)。當設定為 `tool` 時，斜線命令會繞過模型並直接分派給工具。
  - `command-tool` — 當設定 `command-dispatch: tool` 時要調用的工具名稱。
  - `command-arg-mode` — `raw` (預設)。對於工具分派，將原始參數字串轉發給工具（不進行核心解析）。

    工具會透過以下參數調用：
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`。

## 閘控 (載入時篩選器)

OpenClaw 會使用 `metadata`（單行 JSON）在**載入時篩選技能**：

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

`metadata.openclaw` 下的欄位：

- `always: true` — 始終包含技能（跳過其他閘門）。
- `emoji` — macOS Skills UI 使用的選用表情符號。
- `homepage` — macOS Skills UI 中顯示為「網站」的選用 URL。
- `os` — 選用的平台清單 (`darwin`, `linux`, `win32`)。如果設定，技能僅適用於這些作業系統。
- `requires.bins` — 清單；每個都必須存在於 `PATH` 中。
- `requires.anyBins` — 清單；至少一個必須存在於 `PATH` 中。
- `requires.env` — 清單；環境變數必須存在**或**在設定中提供。
- `requires.config` — 必須為真值的 `openclaw.json` 路徑清單。
- `primaryEnv` — 與 `skills.entries.<name>.apiKey` 相關聯的環境變數名稱。
- `install` — macOS Skills UI 使用的選用安裝程式規範陣列 (brew/node/go/uv/download)。

關於沙箱隔離的注意事項：

- `requires.bins` 會在技能載入時在 **host** 上檢查。
- 如果智慧代理是沙箱隔離的，二進位檔案也必須存在於**容器內部**。
  透過 `agents.defaults.sandbox.docker.setupCommand` 安裝它（或自訂映像檔）。
  `setupCommand` 在容器建立後執行一次。
  套件安裝還需要網路出口、可寫入的根檔案系統，以及沙箱中的 root 使用者。
  範例：`summarize` 技能 (`skills/summarize/SKILL.md`) 需要沙箱容器中的 `summarize` CLI 才能在那裡執行。

安裝程式範例：

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "安裝 Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

注意事項：

- 如果列出多個安裝程式，Gateway 會選擇**單一**首選選項（如果可用則為 brew，否則為 node）。
- 如果所有安裝程式都是 `download`，OpenClaw 會列出每個條目，以便您可以看到可用的構件。
- 安裝程式規範可以包含 `os: ["darwin"|"linux"|"win32"]` 以按平台篩選選項。
- Node 安裝會遵守 `openclaw.json` 中的 `skills.install.nodeManager`（預設值：npm；選項：npm/pnpm/yarn/bun）。
  這只會影響**技能安裝**；Gateway 執行時間仍應為 Node
  （不建議將 Bun 用於 WhatsApp/Telegram）。
- Go 安裝：如果缺少 `go` 且 `brew` 可用，Gateway 會先透過 Homebrew 安裝 Go，並在可能的情況下將 `GOBIN` 設定為 Homebrew 的 `bin`。
- 下載安裝：`url`（必填）、`archive` (`tar.gz` | `tar.bz2` | `zip`)、`extract`（預設：偵測到壓縮檔時自動）、`stripComponents`、`targetDir`（預設：`~/.openclaw/tools/<skillKey>`)。

如果沒有 `metadata.openclaw`，則技能始終符合資格（除非在設定中停用或被用於綁定技能的 `skills.allowBundled` 阻擋）。

## 設定覆寫 (`~/.openclaw/openclaw.json`)

綁定/受管理的技能可以切換並提供環境值：

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

注意：如果技能名稱包含連字號，請引用鍵名 (JSON5 允許帶引號的鍵名)。

預設情況下，設定鍵名與**技能名稱**匹配。如果技能定義了
`metadata.openclaw.skillKey`，請在 `skills.entries` 下使用該鍵名。

規則：

- `enabled: false` 會停用技能，即使它是綁定/已安裝的。
- `env`：**僅在**變數尚未在進程中設定時注入。
- `apiKey`：聲明 `metadata.openclaw.primaryEnv` 的技能的便捷方式。
- `config`：用於自訂每個技能欄位的選用包；自訂鍵名必須存在於此處。
- `allowBundled`：僅限於**綁定**技能的選用允許清單。如果設定，則清單中只有綁定技能符合資格（受管理/工作區技能不受影響）。

## 環境注入 (每次智慧代理執行)

當智慧代理執行開始時，OpenClaw 會：

1. 讀取技能中繼資料。
2. 將任何 `skills.entries.<key>.env` 或 `skills.entries.<key>.apiKey` 應用到
   `process.env`。
3. 使用**符合資格的**技能建立系統提示。
4. 執行結束後還原原始環境。

這**僅限於智慧代理執行**，而不是全域 shell 環境。

## 工作階段快照 (效能)

OpenClaw 會在**工作階段開始時**快照符合資格的技能，並在同一工作階段的後續回合中重複使用該清單。技能或設定的更改會在下一個新工作階段生效。

當技能監控器啟用或出現新的符合資格的遠端節點時，技能也可以在工作階段中途重新整理（見下文）。這可以視為**熱重載**：重新整理的清單會在下一個智慧代理回合中載入。

## 遠端 macOS 節點 (Linux Gateway)

如果 Gateway 在 Linux 上運行，但連接了一個 **macOS 節點**，並且**允許 `system.run`**（執行批准安全性未設定為 `deny`），則當該節點上存在所需的二進位檔案時，OpenClaw 可以將僅限 macOS 的技能視為符合資格。智慧代理應該透過 `nodes` 工具（通常是 `nodes.run`）執行這些技能。

這依賴於節點報告其命令支援以及透過 `system.run` 進行二進位探測。如果 macOS 節點稍後離線，技能仍將可見；調用可能會失敗，直到節點重新連接。

## 技能監控器 (自動重新整理)

依預設，OpenClaw 會監控技能檔案夾，並在 `SKILL.md` 檔案更改時更新技能快照。在 `skills.load` 下進行設定：

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## 權杖影響 (技能清單)

當技能符合資格時，OpenClaw 會將可用技能的緊湊 XML 清單注入到系統提示中（透過 `pi-coding-agent` 中的 `formatSkillsForPrompt`）。成本是確定性的：

- **基本開銷（僅當 ≥1 技能時）**：195 個字元。
- **每個技能**：97 個字元 + XML 轉義的 `<name>`、`<description>` 和 `<location>` 值的長度。

公式（字元）：

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

注意事項：

- XML 轉義會將 `& < > " '` 展開為實體 (`&amp;`、`&lt;` 等)，從而增加長度。
- 權杖計數因模型權杖器而異。粗略的 OpenAI 風格估計是約 4 個字元/權杖，因此每個技能**97 個字元 ≈ 24 個權杖**，加上您實際的欄位長度。

## 受管理技能生命週期

OpenClaw 隨安裝（npm 套件或 OpenClaw.app）提供一組基準技能作為**綁定技能**。`~/.openclaw/skills` 存在用於本地覆寫（例如，固定/修補技能而不更改綁定副本）。工作區技能歸使用者所有，並在名稱衝突時覆寫兩者。

## 設定參考

請參閱 [Skills 設定](/tools/skills-config) 了解完整的設定結構。

## 正在尋找更多技能？

瀏覽 [https://clawhub.com](https://clawhub.com)。

---
