---
summary: "Skills：受控 vs 工作區、守門規則（gating rules）以及設定/環境變數連動"
read_when:
  - 新增或修改 Skills
  - 變更 Skill 守門或載入規則
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw 使用 **相容於 [AgentSkills](https://agentskills.io)** 的 Skill 資料夾來教導智慧代理如何使用工具。每個 Skill 都是一個目錄，包含一個帶有 YAML frontmatter 和指令的 `SKILL.md`。OpenClaw 會載入**內建 Skills (bundled skills)** 以及選用的本地覆寫，並在載入時根據環境、設定和執行檔是否存在進行過濾。

## 位置與優先權

Skills 會從以下**三個**位置載入：

1. **內建 Skills (Bundled skills)**：隨安裝程式（npm 套件或 OpenClaw.app）一起提供
2. **受控/本地 Skills (Managed/local skills)**：`~/.openclaw/skills`
3. **工作區 Skills (Workspace skills)**：`<workspace>/skills`

如果 Skill 名稱發生衝突，優先權順序如下：

`<workspace>/skills` (最高) → `~/.openclaw/skills` → 內建 Skills (最低)

此外，您也可以透過 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 設定額外的 Skill 資料夾（優先權最低）。

## 個別智慧代理 vs 共用 Skills

在**多智慧代理 (multi-agent)** 設定中，每個智慧代理都有自己的工作區。這意味著：

- **個別代理專屬 Skills** 僅存在於該智慧代理專屬的 `<workspace>/skills` 中。
- **共用 Skills** 存在於 `~/.openclaw/skills`（受控/本地），且對同一台機器上的**所有智慧代理**可見。
- 如果您希望多個智慧代理使用通用的 Skills 套件，也可以透過 `skills.load.extraDirs` 新增**共用資料夾**（優先權最低）。

如果同一個 Skill 名稱存在於多個地方，則套用一般的優先權：工作區優先，接著是受控/本地，最後是內建。

## 插件 (Plugins) + Skills

插件可以透過在 `openclaw.plugin.json` 中列出 `skills` 目錄來提供自己的 Skills（路徑相對於插件根目錄）。插件 Skills 在插件啟用時載入，並參與一般的 Skill 優先權規則。您可以透過插件設定項目中的 `metadata.openclaw.requires.config` 來對其進行守門過濾。關於探索/設定請參閱 [Plugins](/tools/plugin)，關於這些 Skills 教導的工具介面請參閱 [Tools](/tools)。

## ClawHub (安裝 + 同步)

ClawHub 是 OpenClaw 的公開 Skills 註冊表。請至 [https://clawhub.com](https://clawhub.com) 瀏覽。使用它來發現、安裝、更新和備份 Skills。完整指南：[ClawHub](/tools/clawhub)。

常見流程：

- 安裝 Skill 到您的工作區：
  - `clawhub install <skill-slug>`
- 更新所有已安裝的 Skills：
  - `clawhub update --all`
- 同步（掃描 + 發佈更新）：
  - `clawhub sync --all`

預設情況下，`clawhub` 會安裝到目前工作目錄下的 `./skills`（或退而求其次安裝到設定好的 OpenClaw 工作區）。OpenClaw 會在下一個工作階段中將其識別為 `<workspace>/skills`。

## 安全性注意事項

- 請將第三方 Skills 視為**不信任的程式碼**。在啟用前請先閱讀其內容。
- 對於不信任的輸入和具風險的工具，優先選擇沙箱隔離執行。參閱 [沙箱隔離 (Sandboxing)](/gateway/sandboxing)。
- `skills.entries.*.env` 和 `skills.entries.*.apiKey` 會將敏感資訊（secrets）注入該智慧代理輪次的**主機 (host)** 程序（而非沙箱）。請確保提示詞（prompts）和日誌（logs）中不含敏感資訊。
- 關於更廣泛的威脅模型和檢查清單，請參閱 [安全性 (Security)](/gateway/security)。

## 格式 (相容於 AgentSkills + Pi)

`SKILL.md` 至少必須包含：

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

注意事項：

- 我們遵循 AgentSkills 規範的版面佈局/意圖。
- 內嵌智慧代理使用的解析器僅支援**單行** frontmatter 鍵名 (keys)。
- `metadata` 應為**單行 JSON 物件**。
- 在指令中使用 `{baseDir}` 來引用 Skill 資料夾路徑。
- 選用的 frontmatter 鍵名：
  - `homepage` — 在 macOS Skills UI 中顯示為「網站」的 URL（也支援透過 `metadata.openclaw.homepage` 設定）。
  - `user-invocable` — `true|false`（預設：`true`）。設為 `true` 時，Skill 會作為使用者斜線指令（slash command）公開。
  - `disable-model-invocation` — `true|false`（預設：`false`）。設為 `true` 時，Skill 會從模型提示詞中排除（但仍可透過使用者調用）。
  - `command-dispatch` — `tool`（選用）。設為 `tool` 時，斜線指令會繞過模型並直接分派給工具。
  - `command-tool` — 當設定 `command-dispatch: tool` 時要調用的工具名稱。
  - `command-arg-mode` — `raw`（預設）。對於工具分派，會將原始參數（raw args）字串轉發給工具（不進行核心解析）。

    工具調用時會帶入以下參數：
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`。

## 守門過濾 (Gating，載入時過濾)

OpenClaw 使用 `metadata`（單行 JSON）在**載入時過濾 Skills**：

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

- `always: true` — 總是包含該 Skill（跳過其他守門過濾）。
- `emoji` — macOS Skills UI 使用的選用表情符號。
- `homepage` — macOS Skills UI 中顯示為「網站」的選用 URL。
- `os` — 選用的平台清單（`darwin`, `linux`, `win32`）。若有設定，該 Skill 僅在這些作業系統上符合資格。
- `requires.bins` — 清單；每個都必須存在於 `PATH` 中。
- `requires.anyBins` — 清單；至少要有一個存在於 `PATH` 中。
- `requires.env` — 清單；環境變數必須存在，**或**是在設定中提供。
- `requires.config` — `openclaw.json` 路徑清單，其值必須為真值（truthy）。
- `primaryEnv` — 與 `skills.entries.<name>.apiKey` 關聯的環境變數名稱。
- `install` — macOS Skills UI 使用的選用安裝程式規格陣列 (brew/node/go/uv/download)。

關於沙箱隔離 (Sandboxing) 的說明：

- `requires.bins` 會在 Skill 載入時於**主機 (host)** 上檢查。
- 如果智慧代理處於沙箱隔離狀態，執行檔也必須存在於**容器內部**。
  請透過 `agents.defaults.sandbox.docker.setupCommand`（或自訂映像檔）安裝它。
  `setupCommand` 在容器建立後執行一次。
  套件安裝還需要沙箱內的網路對外連線、可寫入的根檔案系統（root FS）以及沙箱內的 root 使用者。
  例如：`summarize` Skill (`skills/summarize/SKILL.md`) 需要在沙箱容器中具備 `summarize` CLI 才能在該處執行。

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
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

注意事項：

- 如果列出多個安裝程式，Gateway 會選擇**單一**優先選項（可用時優先選擇 brew，否則選擇 node）。
- 如果所有安裝程式均為 `download`，OpenClaw 會列出每個項目，以便您查看可用的成品 (artifacts)。
- 安裝程式規格可以包含 `os: ["darwin"|"linux"|"win32"]` 以根據平台過濾選項。
- Node 安裝遵循 `openclaw.json` 中的 `skills.install.nodeManager`（預設：npm；選項：npm/pnpm/yarn/bun）。
  這僅影響 **Skill 安裝**；Gateway 執行階段（runtime）仍應為 Node（不建議在 WhatsApp/Telegram 中使用 Bun）。
- Go 安裝：如果缺少 `go` 但 `brew` 可用，Gateway 會先透過 Homebrew 安裝 Go，並在可能的情況下將 `GOBIN` 設定為 Homebrew 的 `bin`。
- Download 安裝：`url`（必填）、`archive` (`tar.gz` | `tar.bz2` | `zip`)、`extract`（預設：偵測到壓縮檔時自動解壓縮）、`stripComponents`、`targetDir`（預設：`~/.openclaw/tools/<skillKey>`）。

如果沒有提供 `metadata.openclaw`，則該 Skill 始終符合資格（除非在設定中停用，或對於內建 Skills 而言被 `skills.allowBundled` 阻擋）。

## 設定覆寫 (`~/.openclaw/openclaw.json`)

內建/受控 Skills 可以進行切換並提供環境變數值：

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

注意：如果 Skill 名稱包含連字號（hyphens），請為鍵名加上引號（JSON5 支援引號鍵名）。

設定鍵名預設與 **Skill 名稱**相符。如果 Skill 定義了 `metadata.openclaw.skillKey`，請在 `skills.entries` 下使用該鍵名。

規則：

- `enabled: false` 會停用該 Skill，即使它是內建或已安裝的。
- `env`：**僅在**程序中尚未設定該變數時才會注入。
- `apiKey`：專為宣告了 `metadata.openclaw.primaryEnv` 的 Skills 提供的便利功能。
- `config`：選用的自訂個別 Skill 欄位集合；自訂鍵名必須放在這裡。
- `allowBundled`：僅針對**內建 (bundled)** Skills 的選用允許清單。如果已設定，則僅清單中的內建 Skills 符合資格（受控/工作區 Skills 不受影響）。

## 環境變數注入 (每次智慧代理執行)

當智慧代理開始執行時，OpenClaw 會：

1. 讀取 Skill 中繼資料 (metadata)。
2. 將任何 `skills.entries.<key>.env` 或 `skills.entries.<key>.apiKey` 套用到 `process.env`。
3. 使用**符合資格的** Skills 建立系統提示詞。
4. 在執行結束後還原原始環境。

此作用域**僅限於該智慧代理執行期間**，而非全域 shell 環境。

## 工作階段快照 (效能)

OpenClaw 會在**工作階段開始時**對符合資格的 Skills 進行快照，並在同一個工作階段的後續輪次中重複使用該清單。對 Skills 或設定的變更將在下一個新的工作階段生效。

當啟用 Skills 監控 (watcher) 或出現新的合格遠端節點時，Skills 也可以在工作階段中途重新整理。您可以將其視為**熱重載 (hot reload)**：重新整理後的清單將在智慧代理的下一個輪次中被採用。

## 遠端 macOS 節點 (Linux Gateway)

如果 Gateway 執行於 Linux，但連接了一個 **macOS 節點**且**允許 `system.run`**（執行審核安全性未設定為 `deny`），當該節點上存在所需的執行檔時，OpenClaw 可將僅限 macOS 的 Skills 視為符合資格。智慧代理應透過 `nodes` 工具（通常是 `nodes.run`）執行這些 Skills。

這取決於節點回報其指令支援情況，以及透過 `system.run` 進行執行檔探測。如果該 macOS 節點稍後離線，Skills 仍保持可見；在節點重新連接前，調用可能會失敗。

## Skills 監控 (自動重新整理)

預設情況下，OpenClaw 會監控 Skill 資料夾，並在 `SKILL.md` 檔案變更時更新 Skills 快照。請在 `skills.load` 下設定此項：

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

## Token 影響 (Skills 清單)

當 Skills 符合資格時，OpenClaw 會將精簡的可用 Skills XML 清單注入系統提示詞（透過 `pi-coding-agent` 中的 `formatSkillsForPrompt`）。成本是確定的：

- **基礎開銷（僅在具備 ≥1 個 Skill 時）：** 195 個字元。
- **每個 Skill：** 97 個字元 + 經過 XML 轉義後的 `<name>`、`<description>` 和 `<location>` 值的長度。

公式（字元）：

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

注意事項：

- XML 轉義會將 `& < > " '` 轉換為實體（如 `&amp;`, `&lt;` 等），進而增加長度。
- Token 數量因模型分詞器 (tokenizer) 而異。粗略的 OpenAI 式估計約為 ~4 字元/token，因此每個 Skill 約為 **97 字元 ≈ 24 tokens**，外加實際欄位的長度。

## 受控 Skills 生命週期

OpenClaw 提供一組基準 Skills 作為安裝的一部分（npm 套件或 OpenClaw.app），即**內建 Skills (bundled skills)**。`~/.openclaw/skills` 用於本地覆寫（例如：在不更改內建複本的情況下鎖定或修補某個 Skill）。工作區 Skills 由使用者擁有，並在名稱衝突時覆寫前兩者。

## 設定參考

完整設定結構請參閱 [Skills 設定](/tools/skills-config)。

## 正在尋找更多 Skills？

請瀏覽 [https://clawhub.com](https://clawhub.com)。
