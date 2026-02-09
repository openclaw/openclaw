---
summary: "Skills：受管與工作區的差異、閘控規則，以及設定／環境變數的連接方式"
read_when:
  - 新增或修改 Skills
  - 變更 Skill 的閘控或載入規則
title: "Skills"
---

# Skills（OpenClaw）

OpenClaw 使用 **[AgentSkills](https://agentskills.io) 相容**的 Skill 資料夾來教導代理程式如何使用工具。每個 Skill 都是一個目錄，內含一個具有 YAML frontmatter 與說明指示的 `SKILL.md`。OpenClaw 會載入**內建 Skills**以及可選的本機覆寫，並在載入時依據環境、設定與二進位檔是否存在來進行篩選。 每個技能都是一個目錄，包含一個具有 YAML frontmatter 與說明的 `SKILL.md`。 OpenClaw 會載入**隨附技能**以及可選的本地覆寫，並在載入時依據環境、設定與二進位檔是否存在進行篩選。

## 位置與優先順序

Skills 會從**三個**位置載入：

1. **內建 Skills**：隨安裝一起提供（npm 套件或 OpenClaw.app）
2. **受管／本機 Skills**：`~/.openclaw/skills`
3. **工作區 Skills**：`<workspace>/skills`

若 Skill 名稱發生衝突，優先順序為：

`<workspace>/skills`（最高）→ `~/.openclaw/skills` → 內建 Skills（最低）

此外，你也可以透過
`skills.load.extraDirs` 於 `~/.openclaw/openclaw.json` 中設定額外的 Skill 資料夾（最低優先順序）。

## 每代理程式與共用 Skills

在**多代理程式**設定中，每個代理程式都有自己的工作區。這表示： 這代表：

- **每代理程式 Skills** 僅存在於該代理程式的 `<workspace>/skills` 中。
- **共用 Skills** 存在於 `~/.openclaw/skills`（受管／本機），並且
  對同一台機器上的**所有代理程式**可見。
- 若你希望多個代理程式共用同一組 Skills，也可以透過 `skills.load.extraDirs`
  新增**共用資料夾**（最低優先順序）。

如果同一個技能名稱存在於多個位置，則套用一般的優先順序：
工作區優先，其次是受管/本地，最後是隨附。

## 外掛程式 + Skills

外掛程式可以在 `openclaw.plugin.json` 中列出 `skills` 目錄（路徑相對於外掛程式根目錄），以隨附自己的 Skills。當外掛程式啟用時，這些外掛 Skills 會載入，並參與一般的 Skill 優先順序規則。你可以在外掛程式的設定項目上透過 `metadata.openclaw.requires.config` 進行閘控。請參閱 [Plugins](/tools/plugin) 了解探索／設定，以及 [Tools](/tools) 了解這些 Skills 所教導的工具介面。 外掛技能會在外掛啟用時載入，並遵循一般的技能優先順序規則。
你可以在外掛設定項目上透過 `metadata.openclaw.requires.config` 來設門檻。 8. 請參閱 [Plugins](/tools/plugin) 了解探索/設定，以及 [Tools](/tools) 了解這些技能所教導的工具介面。

## ClawHub（安裝 + 同步）

ClawHub 是 OpenClaw 的公開 Skills 登錄中心。請造訪
[https://clawhub.com](https://clawhub.com)。你可以用它來探索、安裝、更新與備份 Skills。
完整指南：[ClawHub](/tools/clawhub)。 9. 瀏覽於
[https://clawhub.com](https://clawhub.com)。 使用它來探索、安裝、更新與備份技能。
11. 完整指南：[ClawHub](/tools/clawhub)。

常見流程：

- 將 Skill 安裝到你的工作區：
  - `clawhub install <skill-slug>`
- 更新所有已安裝的 Skills：
  - `clawhub update --all`
- 同步（掃描 + 發佈更新）：
  - `clawhub sync --all`

預設情況下，`clawhub` 會安裝到你目前工作目錄下的 `./skills`（或回退到已設定的 OpenClaw 工作區）。OpenClaw 會在下一個工作階段將其視為 `<workspace>/skills`。 OpenClaw 會在下一個工作階段將其識別為 `<workspace>/skills`。

## 安全性注意事項

- 將第三方 Skills 視為**不受信任的程式碼**。在啟用前請先閱讀。 13. 在啟用之前請先閱讀。
- 對於不受信任的輸入與高風險工具，優先使用沙箱化執行。 15. 請參閱 [Sandboxing](/gateway/sandboxing)。
- `skills.entries.*.env` 與 `skills.entries.*.apiKey` 會在該代理程式回合中，將祕密注入**主機**程序（而非沙箱）。請避免在提示詞與記錄中包含祕密。 16. 將祕密排除在提示與日誌之外。
- 更完整的威脅模型與檢查清單，請參閱 [Security](/gateway/security)。

## 格式（AgentSkills + Pi 相容）

`SKILL.md` 至少必須包含：

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

注意事項：

- 版面配置與意圖遵循 AgentSkills 規範。
- 內嵌代理程式所使用的解析器僅支援**單行** frontmatter 金鑰。
- `metadata` 應為**單行 JSON 物件**。
- 在說明指示中使用 `{baseDir}` 來參照 Skill 資料夾路徑。
- 可選的 frontmatter 金鑰：
  - `homepage` — 在 macOS Skills UI 中顯示為「Website」的 URL（亦支援透過 `metadata.openclaw.homepage`）。
  - `user-invocable` — `true|false`（預設：`true`）。當為 `true` 時，Skill 會以使用者斜線指令公開。 17. 當為 `true` 時，該技能會以使用者斜線指令公開。
  - `disable-model-invocation` — `true|false`（預設：`false`）。當為 `true` 時，該 Skill 會從模型提示詞中排除（仍可由使用者呼叫）。 當為 `true` 時，該技能會從模型提示中排除（仍可透過使用者呼叫）。
  - `command-dispatch` — `tool`（可選）。設為 `tool` 時，斜線指令會略過模型並直接派送至工具。 When set to `tool`, the slash command bypasses the model and dispatches directly to a tool.
  - `command-tool` — 當設定 `command-dispatch: tool` 時要呼叫的工具名稱。
  - `command-arg-mode` — `raw`（預設）。用於工具派送時，會將原始參數字串轉送給工具（不做核心解析）。 2. 對於工具派發，會將原始的 args 字串轉送給工具（不進行核心解析）。

    工具會以下列參數被呼叫：
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`。

## 3. 門控（載入時過濾器）

OpenClaw 會在**載入時**使用 `metadata`（單行 JSON）來**篩選 Skills**：

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

`metadata.openclaw` 底下的欄位：

- `always: true` — 永遠包含該 Skill（略過其他閘控）。
- `emoji` — macOS Skills UI 使用的可選表情符號。
- `homepage` — macOS Skills UI 中顯示為「Website」的可選 URL。
- `os` — 可選的平台清單（`darwin`、`linux`、`win32`）。若設定，Skill 僅在這些作業系統上符合資格。 22. 若設定，該技能僅在這些作業系統上符合資格。
- `requires.bins` — 清單；每一項都必須存在於 `PATH`。
- `requires.anyBins` — 清單；至少有一項必須存在於 `PATH`。
- `requires.env` — 清單；環境變數必須存在**或**在設定中提供。
- `requires.config` — `openclaw.json` 路徑清單，且其值必須為真。
- `primaryEnv` — 與 `skills.entries.<name>.apiKey` 關聯的環境變數名稱。
- `install` — macOS Skills UI 使用的可選安裝器規格陣列（brew/node/go/uv/download）。

關於沙箱化的注意事項：

- `requires.bins` 會在 Skill 載入時於**主機**上檢查。
- If an agent is sandboxed, the binary must also exist **inside the container**.
  6. 透過 `agents.defaults.sandbox.docker.setupCommand` 安裝（或使用自訂映像）。
  25. `setupCommand` 會在容器建立後執行一次。
  8. 套件安裝也需要網路對外連線、可寫入的根檔案系統，以及沙盒中的 root 使用者。
  Example: the `summarize` skill (`skills/summarize/SKILL.md`) needs the `summarize` CLI
  in the sandbox container to run there.

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

注意事項：

- If multiple installers are listed, the gateway picks a **single** preferred option (brew when available, otherwise node).
- 若所有安裝器皆為 `download`，OpenClaw 會列出每個項目，讓你查看可用的成品。
- 安裝器規格可包含 `os: ["darwin"|"linux"|"win32"]` 以依平台篩選選項。
- Node 安裝會遵循 `skills.install.nodeManager` 於 `openclaw.json` 中的設定（預設：npm；選項：npm/pnpm/yarn/bun）。
  這只影響 **Skill 安裝**；Gateway 閘道器的執行階段仍應使用 Node
  （不建議在 WhatsApp／Telegram 使用 Bun）。
  29. 這只影響**技能安裝**；Gateway 執行階段仍應為 Node（不建議 WhatsApp/Telegram 使用 Bun）。
- Go 安裝：若缺少 `go` 且有 `brew` 可用，Gateway 閘道器會先透過 Homebrew 安裝 Go，並在可行情況下將 `GOBIN` 設為 Homebrew 的 `bin`。
- Download 安裝：`url`（必填）、`archive`（`tar.gz` | `tar.bz2` | `zip`）、`extract`（預設：偵測到封存檔時自動）、`stripComponents`、`targetDir`（預設：`~/.openclaw/tools/<skillKey>`）。

若未提供 `metadata.openclaw`，該 Skill 會一律符合資格（除非在設定中被停用，或內建 Skills 受到 `skills.allowBundled` 阻擋）。

## 設定覆寫（`~/.openclaw/openclaw.json`）

內建／受管 Skills 可以被切換啟用狀態，並提供環境值：

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

注意：若 Skill 名稱包含連字號，請將金鑰加上引號（JSON5 允許加引號的金鑰）。

Config keys match the **skill name** by default. 設定金鑰預設與 **Skill 名稱** 相同。若某個 Skill 定義了
`metadata.openclaw.skillKey`，請在 `skills.entries` 底下使用該金鑰。

規則：

- `enabled: false` 會停用該 Skill，即使它是內建或已安裝。
- `env`：**僅在**該變數尚未於程序中設定時才注入。
- `apiKey`：為宣告 `metadata.openclaw.primaryEnv` 的 Skills 提供的便利方式。
- `config`：可選的自訂每 Skill 欄位容器；自訂金鑰必須放在此處。
- `allowBundled`：僅適用於**內建** Skills 的可選允許清單。若設定，只有清單中的內建 Skills 符合資格（不影響受管／工作區 Skills）。 31. 若設定，僅清單中的隨附技能符合資格（受管/工作區技能不受影響）。

## 環境注入（每次代理程式執行）

當代理程式執行開始時，OpenClaw 會：

1. Reads skill metadata.
2. 將任何 `skills.entries.<key>.env` 或 `skills.entries.<key>.apiKey` 套用到
   `process.env`。
3. 以**符合資格**的 Skills 建立系統提示詞。
4. 在執行結束後還原原始環境。

This is **scoped to the agent run**, not a global shell environment.

## 34. 工作階段快照（效能）

35. OpenClaw 會在**工作階段開始時**快照符合資格的技能，並在同一工作階段的後續回合中重用該清單。 36. 對技能或設定的變更會在下一個新工作階段生效。

37. 當啟用技能監看器或出現新的符合資格的遠端節點時，技能也可在工作階段中途重新整理（見下文）。 Think of this as a **hot reload**: the refreshed list is picked up on the next agent turn.

## 遠端 macOS 節點（Linux Gateway）

若 Gateway 閘道器在 Linux 上執行，但有一個**macOS 節點**已連線，且**允許 `system.run`**（Exec 核准安全性未設為 `deny`），當該節點上存在所需的二進位檔時，OpenClaw 可以將僅限 macOS 的 Skills 視為符合資格。代理程式應透過 `nodes` 工具（通常是 `nodes.run`）來執行這些 Skills。 The agent should execute those skills via the `nodes` tool (typically `nodes.run`).

40. 這依賴於節點回報其命令支援，以及透過 `system.run` 進行的二進位探測。 If the macOS node goes offline later, the skills remain visible; invocations may fail until the node reconnects.

## Skills watcher（自動重新整理）

預設情況下，OpenClaw 會監看 Skill 資料夾，當 `SKILL.md` 檔案變更時，會更新 Skills 快照。請在 `skills.load` 下進行設定： 42. 在 `skills.load` 下進行設定：

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

## Token 影響（Skills 清單）

當 Skills 符合資格時，OpenClaw 會透過 `formatSkillsForPrompt` 於 `pi-coding-agent` 中，將一份精簡的可用 Skills XML 清單注入系統提示詞。其成本是可預期的： 25. 成本是確定性的：

- \*\*基礎負擔（僅在 ≥1 個 Skill 時）：\*\*195 個字元。
- \*\*每個 Skill：\*\*97 個字元 + XML 轉義後的 `<name>`、`<description>` 與 `<location>` 值的長度。

公式（字元數）：

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

注意事項：

- XML 轉義會將 `& < > " '` 展開為實體（`&amp;`、`&lt;` 等），增加長度。
- Token counts vary by model tokenizer. Token 數量會依模型的 tokenizer 而異。以 OpenAI 風格的粗略估計約為 4 個字元／token，因此**97 個字元 ≈ 24 個 token**，再加上實際欄位長度。

## 受管 Skills 的生命週期

OpenClaw 會在安裝時（npm 套件或 OpenClaw.app）隨附一組基線 Skills 作為**內建 Skills**。`~/.openclaw/skills` 用於本機覆寫（例如在不變更內建副本的情況下，固定版本／修補某個 Skill）。工作區 Skills 由使用者擁有，且在名稱衝突時會覆寫前兩者。 45. `~/.openclaw/skills` 用於本地覆寫（例如，在不變更隨附副本的情況下釘選/修補某個技能）。 46. 工作區技能由使用者擁有，且在名稱衝突時會覆寫兩者。

## 設定參考

完整的設定結構請參閱 [Skills config](/tools/skills-config)。

## 想找更多 Skills？

瀏覽 [https://clawhub.com](https://clawhub.com)。

---
