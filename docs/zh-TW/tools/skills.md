---
summary: "Skills: managed vs workspace, gating rules, and config/env wiring"
read_when:
  - Adding or modifying skills
  - Changing skill gating or load rules
title: Skills
---

# 技能 (OpenClaw)

OpenClaw 使用 **[AgentSkills](https://agentskills.io) 相容** 的技能資料夾來教導代理程式如何使用工具。每個技能都是一個目錄，內含帶有 YAML 前置標記和指令的 `SKILL.md`。OpenClaw 會載入 **內建技能包** 以及可選的本地覆寫，並根據環境、設定和二進位檔存在與否，在載入時進行篩選。

## 位置與優先順序

技能會從 **三個** 位置載入：

1. **內建技能**：隨安裝包（npm 套件或 OpenClaw.app）一起提供
2. **管理/本地技能**：`~/.openclaw/skills`
3. **工作區技能**：`<workspace>/skills`

若技能名稱衝突，優先順序為：

`<workspace>/skills`（最高）→ `~/.openclaw/skills` → 內建技能（最低）

此外，你也可以透過 `skills.load.extraDirs` 在 `~/.openclaw/openclaw.json` 中設定額外的技能資料夾（優先順序最低）。

## 每代理程式專屬 vs 共享技能

在 **多代理程式** 設定中，每個代理程式都有自己的工作區。這表示：

- **每代理程式專屬技能** 存放於該代理程式的 `<workspace>/skills`。
- **共享技能** 存放於 `~/.openclaw/skills`（管理/本地），並對同一台機器上的 **所有代理程式** 可見。
- 你也可以透過 `skills.load.extraDirs` 新增 **共享資料夾**（優先順序最低），用於多個代理程式共用的技能包。

若同一技能名稱存在多個位置，則依照一般優先順序：工作區優先，其次是管理/本地，最後是內建。

## 外掛 + 技能

外掛可以透過在 `openclaw.plugin.json` 中列出 `skills` 目錄（路徑相對於外掛根目錄）來提供自己的技能。外掛技能會在外掛啟用時載入，並遵循一般的技能優先順序規則。你可以透過外掛設定項中的 `metadata.openclaw.requires.config` 來控制它們。詳見 [外掛](/tools/plugin) 了解發現與設定，以及 [工具](/tools) 了解這些技能所教導的工具介面。

## ClawHub（安裝 + 同步）

ClawHub 是 OpenClaw 的公開技能註冊中心。瀏覽網址：
[https://clawhub.com](https://clawhub.com)。可用來搜尋、安裝、更新及備份技能。
完整指南：[ClawHub](/tools/clawhub)。

常見流程：

- 將技能安裝到你的工作區：
  - `clawhub install <skill-slug>`
- 更新所有已安裝的技能：
  - `clawhub update --all`
- 同步（掃描 + 發布更新）：
  - `clawhub sync --all`

預設情況下，`clawhub` 會安裝到你目前工作目錄下的 `./skills`（或回退到已設定的 OpenClaw 工作區）。OpenClaw 會在下一次啟動時將其識別為 `<workspace>/skills`。

## 安全注意事項

- 將第三方技能視為 **不受信任的程式碼**。啟用前請先閱讀。
- 對於不受信任的輸入和高風險工具，建議使用沙盒環境執行。詳見 [Sandboxing](/gateway/sandboxing)。
- 工作區及額外目錄的技能發現只接受技能根目錄及解析後實際路徑仍在設定根目錄內的 `SKILL.md` 檔案。
- `skills.entries.*.env` 和 `skills.entries.*.apiKey` 會將機密注入該代理回合的 **主機** 程式（非沙盒）。請勿將機密放入提示詞和日誌中。
- 更多威脅模型與檢查清單，請參考 [Security](/gateway/security)。

## 格式（AgentSkills + Pi 相容）

`SKILL.md` 必須至少包含：

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

說明：

- 我們遵循 AgentSkills 規範的版面與意圖。
- 內嵌代理使用的解析器只支援 **單行** frontmatter 鍵。
- `metadata` 應為 **單行 JSON 物件**。
- 指令中使用 `{baseDir}` 來參考技能資料夾路徑。
- 選用 frontmatter 鍵：
  - `homepage` — URL，會在 macOS 技能介面顯示為「網站」（也支援 `metadata.openclaw.homepage`）。
  - `user-invocable` — `true|false`（預設：`true`）。當 `true` 時，該技能會以使用者斜線指令形式暴露。
  - `disable-model-invocation` — `true|false`（預設：`false`）。當 `true` 時，該技能會從模型提示中排除（仍可由使用者呼叫）。
  - `command-dispatch` — `tool`（選用）。設定為 `tool` 時，斜線指令會繞過模型，直接派發給工具。
  - `command-tool` — 設定 `command-dispatch: tool` 時要呼叫的工具名稱。
  - `command-arg-mode` — `raw`（預設）。工具派發時，會將原始參數字串轉給工具（不經核心解析）。

工具會以參數：
`{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }` 呼叫。

## 篩選（載入時過濾）

OpenClaw **在載入時過濾技能**，使用 `metadata`（單行 JSON）：

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

- `always: true` — 必須包含技能（跳過其他條件）。
- `emoji` — macOS Skills UI 使用的可選表情符號。
- `homepage` — macOS Skills UI 中顯示為「網站」的可選 URL。
- `os` — 可選平台清單（`darwin`、`linux`、`win32`）。設定後，技能僅在這些作業系統上有效。
- `requires.bins` — 清單；每項必須存在於 `PATH`。
- `requires.anyBins` — 清單；至少一項必須存在於 `PATH`。
- `requires.env` — 清單；環境變數必須存在 **或** 在設定中提供。
- `requires.config` — `openclaw.json` 路徑清單，必須為真值。
- `primaryEnv` — 與 `skills.entries.<name>.apiKey` 相關聯的環境變數名稱。
- `install` — macOS Skills UI 使用的可選安裝器規格陣列（brew/node/go/uv/download）。

沙箱限制說明：

- `requires.bins` 會在技能載入時於 **主機** 上檢查。
- 若代理程式被沙箱限制，二進位檔也必須存在於 **容器內**。
  透過 `agents.defaults.sandbox.docker.setupCommand`（或自訂映像）安裝。
  `setupCommand` 會在容器建立後執行一次。
  套件安裝還需要網路出口、可寫入的根檔案系統，以及沙箱中的 root 使用者。
  範例：`summarize` 技能（`skills/summarize/SKILL.md`）需要在沙箱容器中執行 `summarize` CLI。

安裝器範例：

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
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

備註：

- 若列出多個安裝器，閘道會選擇 **單一** 優先選項（有 brew 則用 brew，否則用 node）。
- 若所有安裝器都是 `download`，OpenClaw 會列出每個條目，讓你看到可用的工件。
- 安裝器規格可包含 `os: ["darwin"|"linux"|"win32"]` 以依平台過濾選項。
- Node 安裝會遵守 `skills.install.nodeManager` 中的 `openclaw.json`（預設：npm；選項：npm/pnpm/yarn/bun）。
  這只影響 **技能安裝**；閘道執行環境仍應為 Node
  （不建議 WhatsApp/Telegram 使用 Bun）。
- Go 安裝：若缺少 `go` 且有 `brew`，閘道會先透過 Homebrew 安裝 Go，並在可能時將 `GOBIN` 設為 Homebrew 的 `bin`。
- 下載安裝：`url`（必填）、`archive`（`tar.gz` | `tar.bz2` | `zip`）、`extract`（預設：偵測到壓縮檔時為 auto）、`stripComponents`、`targetDir`（預設：`~/.openclaw/tools/<skillKey>`）。

若沒有 `metadata.openclaw`，技能始終符合資格（除非
在設定中被停用或被 `skills.allowBundled` 阻擋，針對內建技能）。

## 設定覆寫 (`~/.openclaw/openclaw.json`)

內建/管理技能可切換並提供環境變數值：

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // or plaintext string
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

注意：若技能名稱包含連字號，請將鍵用引號括起（JSON5 允許鍵名加引號）。

設定鍵預設與 **技能名稱** 相符。若技能定義了
`metadata.openclaw.skillKey`，則在 `skills.entries` 下使用該鍵。

規則：

- `enabled: false` 即使技能已被打包/安裝，也會停用該技能。
- `env`：僅在該變數尚未在程序中設定時注入。
- `apiKey`：方便宣告 `metadata.openclaw.primaryEnv` 的技能使用。
  支援純文字字串或 SecretRef 物件 (`{ source, provider, id }`)。
- `config`：可選的自訂每個技能欄位容器；自訂鍵必須放在此處。
- `allowBundled`：僅針對**打包**技能的可選允許清單。若設定，只有清單中的打包技能有資格（管理/工作區技能不受影響）。

## 環境注入（每次代理執行）

當代理執行開始時，OpenClaw：

1. 讀取技能元資料。
2. 對 `process.env` 應用任何 `skills.entries.<key>.env` 或 `skills.entries.<key>.apiKey`。
3. 使用**符合資格的**技能建立系統提示。
4. 執行結束後還原原始環境。

此操作**限定於代理執行範圍**，非全域 shell 環境。

## 會話快照（效能）

OpenClaw 在**會話開始時**快照符合資格的技能，並在同一會話的後續回合重複使用該清單。技能或設定的變更會在下一個新會話生效。

當啟用技能監控器或出現新的符合資格的遠端節點時（見下文），技能也可以在會話中途刷新。可將此視為**熱重載**：刷新後的清單會在下一個代理回合被採用。

## 遠端 macOS 節點（Linux 閘道）

如果閘道執行於 Linux，但有一個**macOS 節點**連線，且**允許 `system.run`**（執行批准安全性未設定為 `deny`），OpenClaw 可將僅限 macOS 的技能視為符合資格，前提是該節點上存在所需的二進位檔。代理應透過 `nodes` 工具（通常是 `nodes.run`）執行這些技能。

此功能依賴節點回報其指令支援狀態及透過 `system.run` 進行的二進位探測。若 macOS 節點稍後離線，技能仍會顯示；但呼叫可能失敗，直到節點重新連線。

## 技能監控器（自動刷新）

預設情況下，OpenClaw 會監控技能資料夾，當 `SKILL.md` 檔案變更時更新技能快照。可在 `skills.load` 下設定：

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

## Token 影響（技能清單）

當技能符合資格時，OpenClaw 會將可用技能的精簡 XML 清單注入系統提示中（透過 `formatSkillsForPrompt` 在 `pi-coding-agent` 中）。成本是確定性的：

- **基本開銷（僅當技能數 ≥1 時）：** 195 字元。
- **每個技能：** 97 字元 + XML 轉義後的 `<name>`、`<description>` 和 `<location>` 值的長度。

公式（字元數）：

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

說明：

- XML 轉義會將 `& < > " '` 擴充成實體（`&amp;`、`&lt;` 等），導致長度增加。
- Token 數量依模型的分詞器而異。以 OpenAI 風格的粗略估計約為 4 字元/token，因此 **97 字元 ≈ 每個技能 24 個 token**，再加上實際欄位長度。

## 管理技能的生命週期

OpenClaw 隨安裝包（npm 套件或 OpenClaw.app）附帶一組基線技能作為 **內建技能**。`~/.openclaw/skills` 用於本地覆寫（例如，釘選或修補技能而不更改內建版本）。工作區技能由使用者擁有，且在名稱衝突時會覆蓋兩者。

## 設定參考

完整設定架構請參考 [技能設定](/tools/skills-config)。

## 想找更多技能嗎？

請瀏覽 [https://clawhub.com](https://clawhub.com)。

---
